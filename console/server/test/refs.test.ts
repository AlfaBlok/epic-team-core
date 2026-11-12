import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client, T3Project } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import type { ReadConfig } from "../src/routes/read.js";
import { scanTree, unblockRefs, WAITS_ON, WAITS_ON_LINE } from "../src/inbox/refs.js";
import { waitingAndDefects, waitingOnJordi } from "../src/inbox/waiting.js";
import { createStore } from "../src/store.js";
import { buildTree } from "../src/adapters/tree.js";
import { parkDecision } from "../src/cycle/park.js";

// one ask, many references. The canonical ask lives in the infra repo; poly-maker's E4 spine waits on it.
const INFRA = `# EPIC-910: VPS control

## Current State

Status: active
Waiting on: Sam (EPIC-910-A7)

## Waiting on

- [ask EPIC-910-A7: approve @Sam since 2026-10-20 row S4] Rebuild the relay on host1? — recommend: approve — unblocks: poly-maker/E904-S3 and S4 here — context: notes.md

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| S4 | Rebuild the relay | Sam go | blocked |
`;

const POLY = `# E4: poly-maker

## Current State

Status: active
Waiting on: ops/EPIC-910-A7

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| E904-S1 | Ship the logger, waits on ops/EPIC-910-A7 | Sam | blocked |
| E904-S2 | Switch the feed, waits on \`ops/EPIC-910-A9\` | Sam | blocked |
| E904-S3 | Restart the bot | Sam go | blocked |
| E904-S4 | Old step, waits on ops/EPIC-910-A1 | — | done |
`;

const PROJECTS: T3Project[] = [
  { id: "mcp:infra", title: "ops", workspaceRoot: "/nowhere/ops", repositoryIdentity: { displayName: "acme/ops" } },
  { id: "mcp:poly", title: "poly-maker", workspaceRoot: "/nowhere/poly-maker", repositoryIdentity: { displayName: "acme/poly-maker" } },
];

class FakeT3 implements T3Client {
  async listProjects() {
    return PROJECTS;
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() {
    return { threadId: "thread_1" };
  }
  async sendToThread() {}
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

let reposRoot: string;
let db: DB;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-refs-"));
  write("ops/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/ops.git\n`);
  write("ops/docs/spines/epic10.md", INFRA);
  write("ops/docs/spines/notes.md", "# notes\n");
  write("poly-maker/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/poly-maker.git\n`);
  write("poly-maker/docs/spines/e4.md", POLY);
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

function setup() {
  db = openDb(path.join(reposRoot, "console.db"));
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, {
    read,
    cycle: { enabled: true, t3: new FakeT3(), dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { call };
}

async function seed(call: ReturnType<typeof setup>["call"]) {
  const infra = (await call("POST", "/api/milestones", { title: "EPIC-910 VPS", repo: "Acme/ops", path: "docs/spines/epic10.md" })).json;
  const poly = (await call("POST", "/api/milestones", { title: "E4 poly-maker", repo: "Acme/poly-maker", path: "docs/spines/e4.md" })).json;
  const dm = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
  const asg = (await call("POST", "/api/assignments", { milestoneId: poly.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
  return { infra, poly, asg };
}

const items = async (call: ReturnType<typeof setup>["call"], q = "") => (await call("GET", `/api/waiting-on-owner${q}`)).json as any[];

describe("reference syntax", () => {
  it("`waits on <repo>/<CODE>` is read from prose, with or without backticks; unblocks tokens need a known other repo", () => {
    const hits = [..."a, waits on ops/EPIC-910-A7 and Waits on `poly-maker/E904-A12`.".matchAll(WAITS_ON)].map((m) => [m[1], m[2]]);
    expect(hits).toEqual([["ops", "EPIC-910-A7"], ["poly-maker", "E904-A12"]]);
    expect([..."waits on docs/x.md".matchAll(WAITS_ON)]).toEqual([]);
    expect(unblockRefs("poly-maker/E904-S3, ops/S4 and docs/guide.md; other/Z9", ["ops", "poly-maker"], "ops")).toEqual([{ repo: "poly-maker", row: "E904-S3" }]);
  });

  it("scanTree finds the references with their row and skips rows already done", () => {
    const t = buildTree(reposRoot, { id: "ms", title: "E4", repo: "Acme/poly-maker", path: "docs/spines/e4.md", owner: "", paused: false, createdAt: "" } as any, undefined);
    const { waits, rows } = scanTree(t, reposRoot + "/poly-maker");
    expect(waits.map((w) => [w.code, w.row, w.closed])).toEqual([
      ["EPIC-910-A7", "E904-S1", false],
      ["EPIC-910-A9", "E904-S2", false],
      ["EPIC-910-A1", "E904-S4", true],
    ]);
    expect([...rows.keys()]).toContain("e904-s3");
  });
});

describe("M2-35b inbox: one card per canonical code", () => {
  it("lists the canonical ask once, with the referencing milestones; the referencing row's guessed item is dropped", async () => {
    const { call } = setup();
    const { infra, poly } = await seed(call);
    const all = await items(call);
    const cards = all.filter((i) => i.code === "EPIC-910-A7");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ source: "ask", milestoneId: infra.id, repo: "ops", state: "open" });
    const refs = cards[0].referencedBy as any[];
    const polyRefs = refs.filter((r) => r.milestoneId === poly.id);
    // waits on (Current State line + row) and the `unblocks:` naming.
    expect(polyRefs.map((r) => [r.via, r.row, r.path])).toEqual(
      expect.arrayContaining([["waits_on", "E904-S1", "docs/spines/e4.md"], ["unblocks", "E904-S3", "docs/spines/e4.md"]]),
    );
    expect(polyRefs.every((r) => r.milestoneTitle === "E4 poly-maker" && r.url?.includes("poly-maker"))).toBe(true);
    // are covered by the card: no guessed item for them.
    const guessed = all.filter((i) => i.source === "heuristic" && i.milestoneId === poly.id).map((i) => i.title);
    expect(guessed.some((t) => t.startsWith("E904-S1") || t.startsWith("E904-S3"))).toBe(false);
  });

  it("the referencing milestone's own view shows the canonical card (answered there, written once at the canonical line)", async () => {
    const { call } = setup();
    const { infra, poly } = await seed(call);
    const view = await items(call, `?milestoneId=${poly.id}`);
    const card = view.find((i) => i.code === "EPIC-910-A7");
    expect(card).toMatchObject({ milestoneId: infra.id, path: "docs/spines/epic10.md" });
    // Answering from poly's view targets the canonical milestone and file (the write itself is's, guarded: no git here).
    const r = await call("POST", `/api/waiting-on-owner/${card.id}/respond`, { kind: "approve", milestoneId: poly.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ milestoneId: infra.id, itemId: card.id, item: { path: "docs/spines/epic10.md", code: "EPIC-910-A7" } });
    // Scoped to infra the same single card shows up too.
    expect((await items(call, `?milestoneId=${infra.id}`)).filter((i) => i.code === "EPIC-910-A7")).toHaveLength(1);
  });

  it("E913-S13: a reference whose code is not found is no item for Sam but a defect reason for the owner; a closed row's stale reference is neither", async () => {
    const { call } = setup();
    const { poly } = await seed(call);
    const view = await items(call, `?milestoneId=${poly.id}`);
    // No "Waits on the infra repo/" item (the old guessed card); the owner row itself is untouched.
    expect(view.filter((i) => /^Waits on /i.test(i.question) || /^waits on /i.test(i.title)).map((i) => i.question)).toEqual([]);
    const st = (await call("GET", `/api/milestones/${poly.id}/status`)).json;
    expect(st.items.some((i: any) => /^(?:[\w-]+ )?waits on ops\/EPIC-910-A9/i.test(i.title))).toBe(false);
    expect(st.defects.filter((x: any) => x.kind !== "free_text")).toEqual([expect.objectContaining({ repo: "ops", code: "EPIC-910-A9", milestoneId: poly.id })]);
    expect(st.reasons.some((r: string) => r.startsWith("defect for the Delivery Manager:") && r.includes("ops/EPIC-910-A9"))).toBe(true);
  });
});

describe("M2-35b wake prompt: every referencing milestone gets the canonical answer", () => {
  it("lists the answered canonical ask under Answered by Sam with its file:line, and stops once it is marked done", async () => {
    const { call } = setup();
    const { asg } = await seed(call);
    const wake0 = (await call("POST", `/api/assignments/${asg.id}/wake?format=json`, {})).json;
    expect(wake0.prompt).not.toContain("Answered by Sam");
    const finish = (runId: string) => call("PATCH", `/api/runs/${runId}`, { outcome: "idle", endedAt: new Date().toISOString() });
    await finish(wake0.run.id);

    // the owner answered at the canonical line (what writes).
    const answered = INFRA.replace(/- \[ask EPIC-910-A7[^\n]*/, "- [answered EPIC-910-A7 2026-10-22 @Sam] Rebuild the relay on host1? — answer: APPROVED");
    write("ops/docs/spines/epic10.md", answered);
    const line = answered.split("\n").findIndex((l) => l.startsWith("- [answered")) + 1;
    const wake1 = (await call("POST", `/api/assignments/${asg.id}/wake?format=json`, {})).json;
    expect(wake1.prompt).toContain("## Answered by Sam, act on these:");
    expect(wake1.prompt).toContain(`- ops:docs/spines/epic10.md:${line} — Rebuild the relay on host1? — answer: APPROVED`);
    expect(wake1.prompt).toContain("[canonical ask ops/EPIC-910-A7, referenced at docs/spines/e4.md:");
    await finish(wake1.run.id);

    // The canonical owner marks it done: the referencing milestone's wake no longer lists it.
    write("ops/docs/spines/epic10.md", answered.replace("@Sam]", "@Sam · done 2026-10-23 abc1234]"));
    const wake2 = (await call("POST", `/api/assignments/${asg.id}/wake?format=json`, {})).json;
    expect(wake2.prompt).not.toContain("Answered by Sam");
  });
});

describe("M2-35b park gate", () => {
  it("a milestone waiting on another epic's canonical ask is woken once that ask is answered", () => {
    const built = buildTree(reposRoot, { id: "ms", title: "E4", repo: "Acme/poly-maker", path: "docs/spines/e4.md", owner: "", paused: false, createdAt: "" } as any, undefined);
    const t = { ...built, source: "spines" as const }; // a doc-parser-only tree never parks
    const base = parkDecision(t);
    const base_n = base.park ? 0 : (base.actionable ?? 0);
    expect(parkDecision(t, 1)).toMatchObject({ park: false, actionable: base_n + 1 });
    // A fully-green tree (nothing to do) parks, unless a referenced answer is waiting.
    const green = { ...t, counts: { ...t.counts, red: 0 }, root: { ...t.root, children: [], color: "green" as const, flags: [] } };
    expect(parkDecision(green).park).toBe(true);
    expect(parkDecision(green, 2)).toMatchObject({ park: false, actionable: 2 });
  });
});

// D19 reference lines `- [waits on <code> row <id>] gloss` (skill 2026.10.22.4).
const POLY_D19 = `# E4: poly-maker

## Current State

Status: active
Waiting on: ops/EPIC-910-A7

## Waiting on

- [waits on ops/EPIC-910-A7 row E904-S1] The relay rebuild Sam approved
- [waits on E904-A9 row E904-S2] A local ask that was never raised
- [waits on ops/EPIC-910-A1 row E904-S4] Old step, already finished
- [waits on ops/EPIC-910-A5 row E904-S5] Target consumed (done)

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| E904-S1 | Ship the logger | Sam | blocked |
| E904-S2 | Switch the feed | Sam | blocked |
| E904-S3 | Restart the bot | Sam go | blocked |
| E904-S4 | Old step | — | done |
| E904-S5 | Consumed step | Sam | blocked |
`;
const MS = { id: "ms", title: "E4", repo: "Acme/poly-maker", path: "docs/spines/e4.md", owner: "", paused: false, createdAt: "" } as any;

describe("D19 reference lines (M2-40)", () => {
  beforeEach(() => write("poly-maker/docs/spines/e4.md", POLY_D19));

  it("the reference line shape: bare or repo-qualified code, optional row, gloss; never an ask line", () => {
    const m = WAITS_ON_LINE.exec("- [waits on ops/EPIC-910-A7 row 3] The VPS key Sam is providing")!;
    expect([m[1], m[2], m[3], m[4]]).toEqual(["ops", "EPIC-910-A7", "3", "The VPS key Sam is providing"]);
    expect(WAITS_ON_LINE.exec("- [waits on E904-A3 row S2] x")!.slice(1, 4)).toEqual([undefined, "E904-A3", "S2"]);
    expect(WAITS_ON_LINE.exec("- [ask E904-A3: approve @Sam row S2] waits on ops/EPIC-910-A7")).toBeNull();
  });

  it("scanTree reads them (bare code = the spine's own repo), keeps the gloss, takes spines.py waits_on state, closes done rows", () => {
    const t = buildTree(reposRoot, MS, undefined);
    t.waits = { "docs/spines/e4.md": [{ ref: "ops/EPIC-910-A5", repo: "ops", code: "EPIC-910-A5", row: "E904-S5", state: "done" }, { ref: "ops/EPIC-910-A7", repo: "ops", code: "EPIC-910-A7", row: "E904-S1", state: "open" }] };
    const { waits } = scanTree(t, reposRoot + "/poly-maker", "poly-maker");
    expect(waits.map((w) => [w.repo, w.code, w.row, w.closed, w.state, w.gloss])).toEqual([
      ["ops", "EPIC-910-A7", "E904-S1", false, "open", "The relay rebuild Sam approved"],
      ["poly-maker", "E904-A9", "E904-S2", false, undefined, "A local ask that was never raised"],
      ["ops", "EPIC-910-A1", "E904-S4", true, undefined, "Old step, already finished"],
      ["ops", "EPIC-910-A5", "E904-S5", false, "done", "Target consumed (done)"],
    ]);
  });

  it("renders as a link on the one canonical card: never a second card, never counted", async () => {
    const { call } = setup();
    const { poly } = await seed(call);
    const all = await items(call);
    const cards = all.filter((i) => i.code === "EPIC-910-A7");
    expect(cards).toHaveLength(1);
    const ref = (cards[0].referencedBy as any[]).find((r) => r.milestoneId === poly.id && r.via === "waits_on");
    expect(ref).toMatchObject({ row: "E904-S1", gloss: "The relay rebuild Sam approved", path: "docs/spines/e4.md", line: 9 });
    expect(ref.url).toContain("poly-maker");
    // The reference line itself is no ask: no ask-sourced item of poly's spine, and's guessed item is covered.
    const mine = all.filter((i) => i.milestoneId === poly.id);
    expect(mine.some((i) => i.source === "ask")).toBe(false);
    expect(mine.some((i) => i.title.startsWith("E904-S1"))).toBe(false);
    expect(all.some((i) => i.question.includes("The relay rebuild"))).toBe(false);
  });

  it("E913-S13: an unresolved local code is a defect, not an item; a target spines.py reports done or a closed row's reference shows nothing", async () => {
    db = openDb(path.join(reposRoot, "d19.db"));
    const store = createStore(db);
    const poly = store.createMilestone({ title: "E4 poly-maker", repo: "Acme/poly-maker", path: "docs/spines/e4.md", owner: "Sam", paused: false });
    const treeFor = async (m: any) => {
      const t = buildTree(reposRoot, m, undefined);
      t.waits = { "docs/spines/e4.md": [{ ref: "ops/EPIC-910-A5", repo: "ops", code: "EPIC-910-A5", row: "E904-S5", state: "done" }] };
      return t;
    };
    const { items: view, defects } = await waitingAndDefects({ store, reposRoot, treeFor, blame: async () => undefined }, { milestoneId: poly.id });
    expect(view.some((i) => i.question.includes("E904-A9"))).toBe(false);
    expect(defects.map((x) => `${x.repo}/${x.code}`)).toEqual(["poly-maker/E904-A9"]);
    expect(view.some((i) => i.question.includes("EPIC-910-A5") || i.question.includes("EPIC-910-A1"))).toBe(false);
  });
});

// D19 "a Needs the owner item starting with a spine code is that ask": the inbox reads no Needs the owner rows since
// the rule is the carry-over's (legacyDuplicateOf, spinesPySupersededAsks.test.ts).
