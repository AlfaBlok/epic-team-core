import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client, T3Project } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import type { ReadConfig } from "../src/routes/read.js";
import { buildTree, type SpinesWait, type Tree } from "../src/adapters/tree.js";
import { fromSpinesEntry, type LocatedAsk } from "../src/inbox/asks.js";
import { legacyDuplicateOf, waitingOnJordi } from "../src/inbox/waiting.js";
import { createStore, type Milestone } from "../src/store.js";

// The console reads ask states and Waiting-on references from spines.py only
// (epicspine-skill ticket-34: state `superseded` + `superseded_by`, text after the done marker, `Waiting on:` codes as
// `waits_on[]`, nothing for none/nobody); these fixtures stand in for that release.
const INFRA = `# PLAN-10: Node CVE

## Current State

Status: active
Waiting on: Sam (PLAN-10-A9)

## Waiting on

- [ask PLAN-10-A9: approve @Sam since 2026-10-22] Merge the memo deploy fix? — recommend: yes — unblocks: memo deploys — context: notes.md
- [superseded PLAN-10-A8 2026-10-22 by PLAN-10-A9] The Deployer upgrade broke memo's CI deploy step; merge the fix?
- [answered PLAN-10-A3 2026-10-23 @delivery-manager · done 2026-10-23 8091316 superseded by PLAN-10-A9] Build on HOST3 — answer: yes
`;

const EPIC0 = `# PLAN-0: Operating system

## Current State

Status: active
Waiting on: Sam: PLAN-3-A1 (root spines for the six rootless repos; asked in PLAN-3)
`;

const EPIC3 = `# PLAN-3: Epic log

## Current State

Status: active
Waiting on: Sam (PLAN-3-A1)

## Waiting on

- [ask PLAN-3-A1: decide @Sam since 2026-10-22] Give a root spine to the six rootless repos? — options: yes | no — recommend: yes — unblocks: PLAN-0 — context: notes.md
`;

const E4 = `# E4: One logger

## Current State

Status: active
Waiting on: Sam: T4-A8 (podcek), T4-A9 (table export), T4-A7 (trace cleanup)
`;

const PROJECTS: T3Project[] = [
  { id: "mcp:infra", title: "ops", workspaceRoot: "/nowhere/ops", repositoryIdentity: { displayName: "acme/ops" } },
  { id: "mcp:skill", title: "epicspine-skill", workspaceRoot: "/nowhere/epicspine-skill", repositoryIdentity: { displayName: "acme/epicspine-skill" } },
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
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s9-"));
  write("ops/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/ops.git\n`);
  write("ops/docs/epic10.md", INFRA);
  write("ops/docs/notes.md", "# notes\n");
  write("epicspine-skill/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/epicspine-skill.git\n`);
  write("epicspine-skill/docs/epic0.md", EPIC0);
  write("epicspine-skill/docs/epic3.md", EPIC3);
  write("epicspine-skill/docs/e4.md", E4);
  write("epicspine-skill/docs/notes.md", "# notes\n");
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

const ask = (code: string, state: string, who = "Sam", extra: Record<string, unknown> = {}) => ({
  code, who, ask: state === "open" ? "approve" : null, question: `${code} question`, options: [], recommend: "yes", context: "docs/notes.md",
  since: null, row: null, state, answer: state === "open" ? null : "yes", steps: null, unblocks: "x", effort: null, ...extra,
});

/** The tree as buildTree makes it from the markdown, with spines.py's `waiting_on` / `waits_on` per file standing in. */
function treeWith(m: Milestone, asks: Record<string, ReturnType<typeof ask>[]> = {}, waits: Record<string, SpinesWait[]> = {}): Tree {
  const t = buildTree(reposRoot, m, undefined);
  const located: Record<string, LocatedAsk[]> = { ...(t.asks ?? {}) };
  for (const [rel, list] of Object.entries(asks)) located[rel] = list.map((e) => fromSpinesEntry(e)!);
  t.asks = located;
  t.waits = { ...(t.waits ?? {}), ...waits };
  return t;
}

describe("T6-S9 spines.py `superseded` asks", () => {
  it("reads like done: answered + doneAt, with the replacing code", () => {
    expect(fromSpinesEntry(ask("PLAN-10-A8", "superseded", "Sam", { superseded_by: "PLAN-10-A9" }))).toMatchObject({
      state: "answered", doneAt: "", supersededBy: "PLAN-10-A9",
    });
  });
});

describe("T6-S9 Needs Sam items about settled asks (T62-S4: the carry-over's rule; the inbox never reads the rows)", () => {
  it("a row naming an answered / done / superseded code is superseded by it at the carry; other rows are carried; the inbox lists none", async () => {
    db = openDb(path.join(reposRoot, "a.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "PLAN-10", repo: "Acme/ops", path: "docs/epic10.md", owner: "", paused: false });
    const spinesAsks = {
      "docs/epic10.md": [
        ask("PLAN-10-A9", "open"),
        ask("PLAN-10-A8", "superseded", "Sam", { superseded_by: "PLAN-10-A9" }),
        ask("PLAN-10-A3", "done", "delivery-manager"),
      ],
    };
    const nj = (question: string) => store.createNeedsJordi({ milestoneId: m.id, question, proposedAction: "", status: "open" });
    const rows = [
      nj("PLAN-10-A8 (approve): Deployer upgraded, merge the memo fix?"),
      nj("PLAN-10-A3: S5 row 9 rebuild runs npm ci on HOST1, build elsewhere?"),
      nj("Still waiting on the memo fix (PLAN-10-A8)"),
      nj("Since PLAN-10-A3 is done, may I also restart X (needs PLAN-10-A99)?"),
      nj("Which region should the bot use?"),
    ];
    const view = await waitingOnJordi({ store, reposRoot, treeFor: async (x) => treeWith(x, spinesAsks), blame: async () => undefined });
    expect(view.filter((i) => (i.source as string) === "needs_jordi")).toEqual([]);
    const tree = await treeWith(m, spinesAsks);
    expect(rows.map((r) => legacyDuplicateOf(r, view, undefined, { asks: tree.asks, repo: "ops" }))).toEqual(["ops/PLAN-10-A8", "ops/PLAN-10-A3", "ops/PLAN-10-A8", undefined, undefined]);
  });

  it("a row starting with an open ask's code is that ask (superseded by it at the carry)", async () => {
    db = openDb(path.join(reposRoot, "b.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "PLAN-10", repo: "Acme/ops", path: "docs/epic10.md", owner: "", paused: false });
    const row = store.createNeedsJordi({ milestoneId: m.id, question: "PLAN-10-A9: merge the memo deploy fix?", proposedAction: "", status: "open" });
    const view = await waitingOnJordi({ store, reposRoot, treeFor: async (x) => buildTree(reposRoot, x, undefined), blame: async () => undefined });
    expect(view.filter((i) => (i.source as string) === "needs_jordi")).toEqual([]);
    expect(view.filter((i) => i.code === "PLAN-10-A9")).toHaveLength(1);
    expect(legacyDuplicateOf(row, view)).toBe("ops/PLAN-10-A9");
  });
});

describe("T6-S9 free-text `Waiting on:` lines", () => {
  const setupStore = (name: string) => {
    db = openDb(path.join(reposRoot, name));
    const store = createStore(db);
    const m0 = store.createMilestone({ title: "PLAN-0", repo: "Acme/epicspine-skill", path: "docs/epic0.md", owner: "", paused: false });
    const m3 = store.createMilestone({ title: "PLAN-3", repo: "Acme/epicspine-skill", path: "docs/epic3.md", owner: "", paused: false });
    return { store, m0, m3 };
  };
  const ref = (code: string, state: SpinesWait["state"]): SpinesWait => ({ ref: code, repo: null, code, row: null, state });

  it("a line spines.py resolved into waits_on[] is a reference on the canonical ask (M2-40 link), never a guessed card", async () => {
    const { store, m0 } = setupStore("c.db");
    const treeFor = async (x: Milestone) => treeWith(x, {}, x.path === "docs/epic0.md" ? { "docs/epic0.md": [ref("PLAN-3-A1", "open")] } : {});
    const view = await waitingOnJordi({ store, reposRoot, treeFor, blame: async () => undefined });
    expect(view.filter((i) => i.source === "heuristic" && i.path === "docs/epic0.md")).toEqual([]);
    const card = view.filter((i) => i.code === "PLAN-3-A1");
    expect(card).toHaveLength(1);
    expect(card[0].referencedBy).toEqual([expect.objectContaining({ milestoneId: m0.id, path: "docs/epic0.md", line: 5, via: "waits_on" })]);
    //'s own view shows the canonical card, not a guess.
    const mine = await waitingOnJordi({ store, reposRoot, treeFor, blame: async () => undefined }, { milestoneId: m0.id });
    expect(mine.map((i) => [i.source, i.code])).toEqual([["ask", "PLAN-3-A1"]]);
  });

  it("all named asks answered / done / superseded (even ones no card shows): nothing at all", async () => {
    db = openDb(path.join(reposRoot, "d.db"));
    const store = createStore(db);
    store.createMilestone({ title: "E4", repo: "Acme/epicspine-skill", path: "docs/e4.md", owner: "", paused: false });
    const treeFor = async (x: Milestone) => treeWith(x, {}, { "docs/e4.md": [ref("T4-A8", "done"), ref("T4-A9", "superseded"), ref("T4-A7", "answered")] });
    expect(await waitingOnJordi({ store, reposRoot, treeFor, blame: async () => undefined })).toEqual([]);
  });

  it("T13-S13 (T6-S44): with no waits_on[] for the line, a line citing only an existing ask is a reference on that ask's card, never a second card", async () => {
    const { store, m0 } = setupStore("e.db");
    const view = await waitingOnJordi({ store, reposRoot, treeFor: async (x) => buildTree(reposRoot, x, undefined), blame: async () => undefined });
    expect(view.filter((i) => i.source === "heuristic" && i.path === "docs/epic0.md")).toEqual([]);
    const card = view.filter((i) => i.code === "PLAN-3-A1");
    expect(card).toHaveLength(1);
    expect(card[0].referencedBy).toEqual([expect.objectContaining({ milestoneId: m0.id, path: "docs/epic0.md", via: "waits_on" })]);
  });

  it("`Waiting on: nobody (Sam: none open). Workers: …` makes no card", async () => {
    write("epicspine-skill/docs/e4.md", E4.replace(/Waiting on: .*/, "Waiting on: nobody (Sam: none open). Workers: A9 table export + drop; T10 default flip; A7 trace cleanup."));
    write("epicspine-skill/docs/e5.md", E4.replace("# E4", "# E5").replace(/Waiting on: .*/, "Waiting on: workers; Sam: none"));
    db = openDb(path.join(reposRoot, "f.db"));
    const store = createStore(db);
    store.createMilestone({ title: "E4", repo: "Acme/epicspine-skill", path: "docs/e4.md", owner: "", paused: false });
    store.createMilestone({ title: "E5", repo: "Acme/epicspine-skill", path: "docs/e5.md", owner: "", paused: false });
    expect(await waitingOnJordi({ store, reposRoot, treeFor: async (x) => buildTree(reposRoot, x, undefined), blame: async () => undefined })).toEqual([]);
  });
});

// "answering a coded ask closes the Needs the owner rows naming it" is gone with the rows: there are no open
// rows to close; an ask raised through the API is a spine line answered like any other.
