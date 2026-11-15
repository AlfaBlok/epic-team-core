import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { CycleOptions } from "../src/cycle/service.js";
import type { T3Client, T3Project } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import type { ReadConfig } from "../src/routes/read.js";
import { buildTree, colorFor } from "../src/adapters/tree.js";
import { advisories, asksFor, fromSpinesEntry, missingFields, parseAsks, rowMatches } from "../src/inbox/asks.js";
import { futureGate, threadOwner, waitingForMilestone } from "../src/inbox/waiting.js";
import { createStore } from "../src/store.js";
import { wakeProtocol } from "../src/cycle/prompts.js";
import type { SpinesJson } from "../src/adapters/spines.js";
import { openAsksOf } from "../src/routes/spines.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "EPIC-904-human-ask.md"), "utf8");
// Real `spines.py --json` of the epicspine-skill repo at f2fc041 (skill 2026.10.21.1), with `waiting_on` per node.
const SPINES_EPIC4 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "spines-epic4-waiting-on.json"), "utf8")) as SpinesJson;

// A spine in the skill's human-ask format plus every heuristic signal.
const SPINE = `# EPIC-909: Inbox spine

Spine ID: inbox-root

## Current State

Status: active
Waiting on: Sam (1 ask, see Waiting on)

## Waiting on

- [ask: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: [why](notes.md#loggers)
- [answered 2026-10-21 @Sam] Use pg1 for the new tables? — answer: yes
- [ask: provide @Ana since 2026-10-21] Vendor quote — context: notes.md

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T4 | Pick the logger layout | Sam | blocked |
| T5 | XL-3: deploy in place of xz7bqe | Sam go | pending |
| T6 | Drop the old tables | — | blocked — waiting on Sam approval |
| T7 | Write the reader | worker; Sam pulls on dub_1 | ready |
| T8 | Already shipped | Sam go | done |
`;

const OTHER = `# EPIC-910: Free text

## Current State

Status: blocked
Waiting on: Sam's go on P2 (since 10-13)
`;

const PROJECTS: T3Project[] = [
  { id: "mcp:inbox", title: "inbox", workspaceRoot: "/nowhere/inbox", repositoryIdentity: { displayName: "acme/inbox" } },
  { id: "mcp:poly", title: "poly-maker", workspaceRoot: "/nowhere/poly-maker", repositoryIdentity: { displayName: "acme/poly-maker" } },
];

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, string[]>();
  private n = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
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
  async launchThread(input: { projectId: string; title: string; message?: string }) {
    this.calls.push({ op: "launchThread", args: input });
    const threadId = `thread_${++this.n}`;
    this.threads.set(threadId, input.message ? [input.message] : []);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId } });
    this.threads.set(threadId, [...(this.threads.get(threadId) ?? []), message]);
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

class FakeDispatcher implements Dispatcher {
  async pick() {
    return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" };
  }
  async done() {}
}

let reposRoot: string;
let db: DB;
let t3: FakeT3;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-inbox-"));
  write("inbox/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/inbox.git\n`);
  write("inbox/docs/spines/root.md", SPINE);
  write("inbox/docs/spines/notes.md", "# notes\n\n## loggers\n");
  write("inbox/docs/spines/other.md", OTHER);
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

function setup(over: Partial<CycleOptions> = {}) {
  db = openDb(path.join(reposRoot, "console.db"));
  t3 = new FakeT3();
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, cycle: { enabled: true, t3, dispatcher: new FakeDispatcher(), publicUrl: "http://console.test", ...over } });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { call, app };
}

async function seed(call: ReturnType<typeof setup>["call"], withPersona = true) {
  const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
  const m2 = (await call("POST", "/api/milestones", { title: "Other", repo: "Acme/inbox", path: "docs/spines/other.md" })).json;
  let a: any;
  if (withPersona) {
    const dm = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs the milestone", model: "opus" })).json;
    a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
  }
  return { m, m2, a };
}

describe("human-ask parser (epicspine-skill docs/doctrine/human-asks.md)", () => {
  it("reads the live EPIC-904 approve ask", () => {
    const asks = parseAsks(FIXTURE, "docs/EPIC-904-DOCTRINE-2.md");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      who: "Sam",
      ask: "approve",
      question: "Approve the doctrine page and enforcement plan (steps 1+2) as one?",
      options: [],
      recommend: "approve, with both small answers yes",
      context: "http://main.tail.example:36879/index.html",
      contextLabel: "approval page",
      since: "2026-10-19",
      row: "1",
      state: "open",
      answer: null,
    });
    expect(FIXTURE.split("\n")[asks[0].line!]).toMatch(/^- \[ask: approve/);
    // A v1 line: no code, and contract v2 requires unblocks for every type.
    expect(asks[0].code).toBeNull();
    expect(missingFields(asks[0])).toEqual(["unblocks"]);
    // row "1" = first token of the ledger Title "1. Define the doctrine …" (Issue cells are all "draft").
    expect(rowMatches("1", { id: "draft", title: "1. Define the doctrine (coherence pass)" })).toBe(true);
    expect(rowMatches("1", { id: "draft", title: "10. Outcome before close" })).toBe(false);
  });

  it("parses options, answered lines, other humans, local context, and flags missing fields", () => {
    const asks = parseAsks(SPINE, "docs/spines/root.md", path.join(reposRoot, "inbox"));
    expect(asks.map((a) => [a.ask, a.who, a.state])).toEqual([
      ["decide", "Sam", "open"],
      ["unknown", "Sam", "answered"],
      ["provide", "Ana", "open"],
    ]);
    expect(asks[0]).toMatchObject({ options: ["one", "two"], recommend: "one", row: "T4", context: "docs/spines/notes.md#loggers" });
    expect(asks[1]).toMatchObject({ answer: "yes", since: "2026-10-21", question: "Use pg1 for the new tables?" });
    expect(missingFields({ ...asks[0], options: [], unblocks: "T5" })).toEqual(["options"]);
    expect(missingFields({ ...asks[0], recommend: null, context: null })).toEqual(["recommend", "unblocks", "context"]);
    // Lines outside a Waiting on section are not asks.
    expect(parseAsks("## Notes\n\n- [ask: decide @Sam since 2026-10-21] x? — options: a | b\n")).toEqual([]);
  });

  it("prefers spines.py waiting_on once it is contract v2 (has code); a v1 or empty list reads the markdown", () => {
    const v1 = { who: "Sam", ask: "approve", question: "Only this one?", options: [], recommend: "yes", context: "docs/x.md", since: "2026-10-21", row: null, state: "open", answer: null };
    const fromJson = asksFor(path.join(reposRoot, "inbox"), "docs/spines/root.md", [
      { ...v1, code: "EPIC-909-A2", ask: "do", steps: "ssh main (root)", unblocks: "T5", effort: "~5 min" },
    ]);
    expect(fromJson).toHaveLength(1);
    expect(fromJson[0]).toMatchObject({ code: "EPIC-909-A2", question: "Only this one?", ask: "do", steps: "ssh main (root)", unblocks: "T5", effort: "~5 min", line: undefined });
    expect(asksFor(path.join(reposRoot, "inbox"), "docs/spines/root.md")).toHaveLength(3);
    // v1 spines.py (no code key) misses v2 lines: the markdown parser stands in; an empty list agrees with the markdown.
    expect(asksFor(path.join(reposRoot, "inbox"), "docs/spines/root.md", [v1]).map((a) => a.question)[0]).toBe("Ship with one logger or two?");
    expect(asksFor(path.join(reposRoot, "inbox"), "docs/spines/root.md", [])).toHaveLength(3);
  });

  it("colors a not-started row red when its Needs cell names Sam, and a row with an open ask red", () => {
    expect(colorFor("pending", undefined, "Sam go").color).toBe("red");
    expect(colorFor("ready", undefined, "worker; Sam pulls on dub_1").color).toBe("grey");
    expect(colorFor("done", undefined, "Sam go").color).toBe("green");
    expect(colorFor("active", undefined, "Sam go").color).toBe("blue");
    const tree = buildTree(reposRoot, { id: "ms", repo: "Acme/inbox", path: "docs/spines/root.md", paused: false });
    const byId = Object.fromEntries(tree.root.children.map((c) => [c.id, c]));
    expect(byId.T4).toMatchObject({ color: "red", asks: [{ ask: "decide", who: "Sam", question: "Ship with one logger or two?" }] });
    expect(byId.T5).toMatchObject({ color: "red", needs: "Sam go" });
    expect(byId.T7.color).toBe("grey");
    expect(byId.T8.color).toBe("green");
    expect(tree.asks?.["docs/spines/root.md"]).toHaveLength(3);
  });
});

describe("GET /api/waiting-on-owner", () => {
  it("aggregates asks and heuristics from the spines (E962-S4: no Needs Sam rows; a raise that cannot reach the spine records nothing)", async () => {
    const { call } = setup();
    const { m, m2, a } = await seed(call);
    const run = (await call("POST", "/api/runs", { assignmentId: a.id, outcome: "blocked", threadId: "thread_run" })).json;
    expect((await call("POST", "/api/needs-owner", { runId: run.id, milestoneId: m.id, question: "Approve the S5 limits table? — why Sam: it widens access", proposedAction: "Apply rows 8-14" })).status).toBe(409);

    const items = (await call("GET", "/api/waiting-on-owner")).json as any[];
    const by = (pred: (i: any) => boolean) => items.filter(pred);

    const ask = by((i) => i.source === "ask" && i.state === "open");
    expect(ask).toHaveLength(1); // Ana's ask is not the owner's
    expect(ask[0]).toMatchObject({
      milestoneId: m.id,
      ask: "decide",
      question: "Ship with one logger or two?",
      options: ["one", "two"],
      recommendation: "one",
      row: "T4",
      who: "Sam",
      since: "2026-10-20",
      path: "docs/spines/root.md",
      title: "T4 Pick the logger layout",
      owner: { kind: "delivery-manager", assignmentId: a.id, personaName: "Delivery Manager" },
    });
    expect(ask[0].nodeKey).toMatch(/\/T4$/);
    expect(ask[0].contextLinks[0]).toEqual({ label: "why", url: "https://github.com/Acme/inbox/blob/HEAD/docs/spines/notes.md#loggers" });
    expect(ask[0].contextLinks[1].url).toMatch(/blob\/HEAD\/docs\/spines\/root\.md\?plain=1#L\d+$/);

    expect(by((i) => i.state === "answered")).toMatchObject([{ source: "ask", answer: "yes" }]);

    const heur = by((i) => i.source === "heuristic");
    expect(heur.map((i) => [i.signal, i.title, i.ask])).toEqual(
      expect.arrayContaining([
        ["needs_column", "T5 XL-3: deploy in place of xz7bqe", "unknown"],
        ["red_node", "T6 Drop the old tables", "unknown"],
        ["waiting_on", "Other", "unknown"],
      ]),
    );
    expect(heur).toHaveLength(3); // no item for T7 (worker), T8 (done), T4 (covered by its ask), root Waiting on (covered by asks)
    expect(heur.every((i) => i.hint === "not in the human-ask format, ask the owner to restate")).toBe(true);
    expect(heur.find((i) => i.signal === "waiting_on")).toMatchObject({ milestoneId: m2.id, question: "go on P2 (since 10-13)", owner: { kind: "none" } });

    expect(by((i) => i.source === "needs_jordi")).toEqual([]);

    // Scoped: milestone, then the T4 subtree only.
    const scoped = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
    expect(scoped.every((i) => i.milestoneId === m.id)).toBe(true);
    const sub = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}&nodeKey=${encodeURIComponent(ask[0].nodeKey)}`)).json as any[];
    expect(sub.map((i) => i.id)).toEqual([ask[0].id]);
    expect((await call("GET", "/api/waiting-on-owner?milestoneId=ms_nope")).status).toBe(404);
  });
});

describe("the Inbox search box", () => {
  it("GET /api/inbox/search finds asks by title, card text and his answer; no match says so; a long query is refused", async () => {
    const { call } = setup();
    await seed(call);
    const logger = (await call("GET", "/api/inbox/search?q=LOGGER")).json as any;
    expect(logger.total).toBeGreaterThan(0);
    expect(logger.hits.every((h: any) => h.section === "blocked" || h.section === "done")).toBe(true);
    const list = (await call("GET", "/api/waiting-on-owner")).json as any[];
    const ask = list.find((i) => /logger/i.test(i.question));
    expect(logger.hits.map((h: any) => h.id)).toContain(ask.id);
    expect(logger.hits.find((h: any) => h.id === ask.id).where).toContain("card");
    const none = (await call("GET", "/api/inbox/search?q=Condesa")).json as any;
    expect(none).toMatchObject({ q: "Condesa", total: 0, hits: [], counts: { blocked: 0, review: 0, done: 0 } });
    expect(typeof none.tookMs).toBe("number");
    expect((await call("GET", `/api/inbox/search?q=${"x".repeat(101)}`)).status).toBe(400);
    // one letter is no search (the box needs two).
    expect(((await call("GET", "/api/inbox/search?q=l")).json as any).total).toBe(0);
  });
});

describe("the Inbox's list sends what the screen shows", () => {
  it("?view=list keeps open and answered cards whole; GET /:id gives one item whole; the list goes out gzipped", async () => {
    const { call, app } = setup();
    const { m } = await seed(call);
    const full = (await call("GET", "/api/waiting-on-owner")).json as any[];
    const list = (await call("GET", "/api/waiting-on-owner?view=list")).json as any[];
    // open and answered items are the same cards (nothing here is done yet).
    expect(list.map((i) => i.id)).toEqual(full.map((i) => i.id));
    const open = list.find((i) => i.source === "ask" && i.state === "open");
    expect(open).toEqual(full.find((i) => i.id === open.id));
    expect(open.slim).toBeUndefined();
    // the card behind one id, whole (a folded Answered row opens it).
    const one = await call("GET", `/api/waiting-on-owner/${open.id}?milestoneId=${m.id}`);
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ id: open.id, question: "Ship with one logger or two?", options: ["one", "two"] });
    expect((await call("GET", "/api/waiting-on-owner/wj_nope")).status).toBe(404);
    // the browser takes gzip: the list goes out packed (it was 1.78 MB of plain JSON on production).
    const res = await app.request("/api/waiting-on-owner?view=list", { headers: { "Accept-Encoding": "gzip" } });
    expect(res.status).toBe(200);
    if (JSON.stringify(list).length > 1024) expect(res.headers.get("content-encoding")).toBe("gzip");
  });
});

describe("responses", () => {
  it("answers an ask: stored, never messages the owner thread (M2-23); a checkout that is not git refuses the spine write with the reason, in Activity", async () => {
    const { call } = setup();
    const { m, a } = await seed(call);
    const ask = ((await call("GET", "/api/waiting-on-owner")).json as any[]).find((i) => i.source === "ask" && i.state === "open");
    expect(ask.line).toBeGreaterThan(0);
    const r = await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "one", milestoneId: m.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ itemId: ask.id, kind: "answer", text: "one", delivery: "queued", deliveryError: "not a git checkout", spine: { status: "skipped", reason: "not a git checkout", path: "docs/spines/root.md" } });
    expect(r.json.threadId).toBeUndefined();
    // no write-back message; the refused write still wakes the asker (Run now), told to write the answer in itself.
    expect(t3.calls.map((x) => x.op)).toEqual(["launchThread"]);
    expect(r.json.wake).toMatchObject({ notified: "woken" });
    expect(fs.readFileSync(path.join(reposRoot, "inbox/docs/spines/root.md"), "utf8")).toBe(SPINE); // nothing written

    const items = (await call("GET", "/api/waiting-on-owner")).json as any[];
    expect(items.find((i) => i.id === ask.id)).toMatchObject({ state: "open", response: { text: "one", delivery: "queued", spine: { status: "skipped" } } });
    const act = (await call("GET", `/api/owner-activity?milestoneId=${m.id}`)).json as any[];
    expect(act[0]).toMatchObject({ type: "response", itemTitle: "Decide: Ship with one logger or two?", spine: { status: "skipped" }, delivery: "queued" });
    expect(a).toBeDefined();
  });

  it("a refused spine write is retryable, whoever owns the milestone; refuses approve on non-approve asks", async () => {
    const { call } = setup();
    const { m2 } = await seed(call, false);
    const item = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m2.id}`)).json as any[])[0];
    expect(item.owner).toEqual({ kind: "none", label: "no one to deliver to, attach a persona or name an owner thread" });
    expect((await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "approve" })).status).toBe(400);
    expect((await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "answer", text: " " })).status).toBe(400);
    const r = await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "answer", text: "go" });
    expect(r.json).toMatchObject({ delivery: "queued", spine: { status: "skipped", reason: "not a git checkout" } });
    const retry = await call("POST", `/api/owner-responses/${r.json.id}/deliver`);
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ id: r.json.id, delivery: "queued", spine: { status: "skipped" } });
    expect(t3.calls).toEqual([]);
    expect((await call("POST", `/api/waiting-on-owner/wj_nope/respond`, { kind: "answer", text: "x" })).status).toBe(404);
  });
});

describe("POST /api/messages", () => {
  it("M2-32: Send to records an answer_run on the home thread", async () => {
    const { call } = setup();
    const { m, a } = await seed(call);
    const r = await call("POST", "/api/messages", { milestoneId: m.id, assignmentId: a.id, text: "Please   look at T5" });
    expect(r.status).toBe(201);
    const runs = (await call("GET", `/api/runs?assignmentId=${a.id}`)).json as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "answer_run", outcome: "running", threadId: "thread_1", assignmentId: a.id, summary: "Answer run: Please look at T5" });
    // never a wake: the assignment's lastRunAt stays unset, and a run-now is not blocked by it
    expect((await call("GET", `/api/assignments/${a.id}`)).json.lastRunAt).toBeUndefined();
  });

  it("sends to the assignment's home thread with a header, stores it, lists it in Activity", async () => {
    const { call } = setup();
    const { m, m2, a } = await seed(call);
    const ask = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.source === "ask" && i.state === "open");
    const r = await call("POST", "/api/messages", { milestoneId: m.id, assignmentId: a.id, text: "Restate T5 as an ask, please.", refItemId: ask.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ delivery: "sent", threadId: "thread_1", refItemId: ask.id });
    const sent = t3.ops("launchThread")[0].args.message as string;
    expect(sent).toMatch(/^Message from Sam via the agent-team console · milestone Inbox/);
    expect(sent).toContain("about: Decide: Ship with one logger or two? (docs/spines/root.md)");
    expect(sent).toContain("Restate T5 as an ask, please.");
    await call("POST", "/api/messages", { milestoneId: m.id, assignmentId: a.id, text: "second" });
    expect(t3.ops("sendToThread")[0].args.threadId).toBe("thread_1");
    expect((await call("GET", `/api/messages?milestoneId=${m.id}`)).json).toHaveLength(2);
    expect(((await call("GET", `/api/owner-activity?milestoneId=${m.id}`)).json as any[]).map((x) => x.type)).toEqual(["message", "message"]);
    expect((await call("POST", "/api/messages", { milestoneId: m2.id, assignmentId: a.id, text: "x" })).status).toBe(400);
    expect((await call("POST", "/api/messages", { milestoneId: m.id, assignmentId: a.id, text: "" })).status).toBe(400);
  });

  it("returns 502 with the stored failure when the cycle is off", async () => {
    const { call } = setup({ enabled: false });
    const { m, a } = await seed(call);
    const r = await call("POST", "/api/messages", { milestoneId: m.id, assignmentId: a.id, text: "hello" });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ delivery: "failed" });
    expect(r.json.deliveryError).toMatch(/cycle_disabled/);
    expect((await call("GET", "/api/messages")).json).toHaveLength(1);
  });
});

describe("spines.py waiting_on: v1 JSON falls back to the markdown, v2 JSON is the source", () => {
  const EPIC4 = "docs/EPIC-904-DOCTRINE-2.md";
  const M4 = { id: "ms_e4", repo: "Acme/epicspine-skill", path: EPIC4, paused: false, title: "EPIC-904" };
  beforeEach(() => {
    write("epicspine-skill/.git/config", `[remote "origin"]\n\turl = git@github.com:Acme/epicspine-skill.git\n`);
    write(`epicspine-skill/${EPIC4}`, FIXTURE);
  });

  it("links EPIC-904's open approve ask to ledger row 1, colors it red, keeps the context URL", async () => {
    // The fixture ask is from 2026-10-19: read it before it turns stale (STALE_DAYS), or the advisory gains a stale line.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const node = SPINES_EPIC4.nodes.find((n) => n.path === EPIC4) as any;
    expect(node.waiting_on).toEqual([
      { who: "Sam", ask: "approve", question: "Approve the doctrine page and enforcement plan (steps 1+2) as one?", options: [], recommend: "approve, with both small answers yes", context: "http://main.tail.example:36879/index.html", since: "2026-10-19", row: "1", state: "open", answer: null },
    ]);
    const tree = buildTree(reposRoot, M4, SPINES_EPIC4);
    const row1 = tree.root.children.find((c) => c.title.startsWith("1. Define the doctrine"))!;
    expect(row1).toMatchObject({ color: "red", asks: [{ ask: "approve", who: "Sam", since: "2026-10-19" }] });

    db = openDb(path.join(reposRoot, "e4.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "EPIC-904", repo: M4.repo, path: EPIC4, owner: "Sam", paused: false });
    const items = await waitingForMilestone({ store, reposRoot, treeFor: async () => buildTree(reposRoot, { ...M4, id: m.id }, SPINES_EPIC4), blame: async () => undefined }, m);
    const asks = items.filter((i) => i.source === "ask");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ ask: "approve", state: "open", row: "1", since: "2026-10-19", recommendation: "approve, with both small answers yes", title: row1.title });
    expect(asks[0].nodeKey).toBe(row1.key.replace(/^ms_e4/, m.id));
    // v1 JSON → the markdown parser (same ask); v1 lacks unblocks and a code.
    expect(asks[0].missing).toEqual(["unblocks"]);
    expect(asks[0].advisory).toEqual(["ask has no code"]);
    expect(asks[0].contextLinks[0]).toEqual({ label: "approval page", url: "http://main.tail.example:36879/index.html" });
    expect(asks[0].contextLinks[1].url).toMatch(/^https:\/\/github\.com\/Acme\/epicspine-skill\/blob\/HEAD\/docs\/EPIC-904-DOCTRINE-2\.md\?plain=1#L\d+$/);
    // Current State "Waiting on: the owner (1 ask, see Waiting on)" is covered by the ask: no heuristic duplicate for the file.
    expect(items.filter((i) => i.source === "heuristic" && i.path === EPIC4 && i.signal === "waiting_on")).toEqual([]);
  });

  it("E996-S29: a key ask labelled needs Mac agent stays in the inbox list with its box (T9-A10 sat folded under Needs Mac agent)", async () => {
    const spines = structuredClone(SPINES_EPIC4) as any;
    const node = spines.nodes.find((n: any) => n.path === EPIC4);
    const v2 = { steps: null, effort: null, options: [], recommend: null, context: null, since: "2026-10-21", row: null, state: "open", answer: null, who: "Sam" };
    node.waiting_on = [
      { ...v2, code: "T9-A10", ask: "provide", question: "Create one Cloudflare key", unblocks: "the deploy — secret: acme CLOUDFLARE_WORKERS_TOKEN — label: needs Mac agent" },
      { ...v2, code: "T9-A11", ask: "do", question: "Open the Mac list", unblocks: "the laptop step — label: needs Mac agent" },
    ];
    db = openDb(path.join(reposRoot, "e96s29.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "EPIC-904", repo: M4.repo, path: EPIC4, owner: "Sam", paused: false });
    const items = (await waitingForMilestone({ store, reposRoot, treeFor: async () => buildTree(reposRoot, { ...M4, id: m.id }, spines), blame: async () => undefined }, m)).filter((i) => i.source === "ask");
    const key = items.find((i) => i.code === "T9-A10")!;
    expect(key.secret).toEqual({ app: "acme", name: "CLOUDFLARE_WORKERS_TOKEN" });
    expect(key.macAgent).toBeUndefined();
    expect(items.find((i) => i.code === "T9-A11")!.macAgent).toBe(true);
  });

  it("uses v2 waiting_on only (markdown asks ignored), answered entries with null ask/since/row, local context → blob URL", async () => {
    const spines = structuredClone(SPINES_EPIC4) as any;
    const node = spines.nodes.find((n: any) => n.path === EPIC4);
    const v2 = { code: null, steps: null, unblocks: null, effort: null };
    node.waiting_on = [
      { ...v2, code: "EPIC-904-A2", who: "Sam", ask: null, question: "Use one logger?", options: [], recommend: null, context: "docs/doctrine/human-asks.md#answering-it", since: null, row: null, state: "answered", answer: "one" },
      { ...v2, who: "Sam", ask: "decide", question: "Which host?", options: ["main", "host2"], recommend: "main", context: "docs/doctrine/console-contract.md", since: "2026-10-21", row: null, state: "open", answer: null },
    ];
    db = openDb(path.join(reposRoot, "e4b.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "EPIC-904", repo: M4.repo, path: EPIC4, owner: "Sam", paused: false });
    const items = (await waitingForMilestone({ store, reposRoot, treeFor: async () => buildTree(reposRoot, { ...M4, id: m.id }, spines), blame: async () => undefined }, m)).filter((i) => i.source === "ask");
    // The markdown still has the row-1 approve ask, but spines.py no longer lists it: not shown.
    expect(items.map((i) => [i.question, i.state])).toEqual([["Use one logger?", "answered"], ["Which host?", "open"]]);
    expect(items[0]).toMatchObject({ ask: "unknown", answer: "one", code: "EPIC-904-A2" });
    expect(items[0].row).toBeUndefined();
    expect(items[0].contextLinks[0].url).toBe("https://github.com/Acme/epicspine-skill/blob/HEAD/docs/doctrine/human-asks.md#answering-it");
    expect(items[1]).toMatchObject({ ask: "decide", options: ["main", "host2"], recommendation: "main" });
    const tree = buildTree(reposRoot, { ...M4, id: m.id }, spines);
    expect(tree.root.children.find((c) => c.title.startsWith("1. Define the doctrine"))!.asks).toBeUndefined();
  });

  it("E948-S11: an open ask's date-only since gets its hour from git when that falls on the same day", async () => {
    const spines = structuredClone(SPINES_EPIC4) as any;
    const node = spines.nodes.find((n: any) => n.path === EPIC4);
    const v2 = { steps: null, unblocks: null, effort: null, options: [], recommend: null, context: null, row: null, state: "open", answer: null, who: "Sam", ask: "decide" };
    node.waiting_on = [
      { ...v2, code: "EPIC-904-A7", question: "Added that day?", since: "2026-10-21" },
      { ...v2, code: "EPIC-904-A8", question: "Moved in later?", since: "2026-10-18" },
      { ...v2, code: null, question: "No code?", since: "2026-10-21" },
    ];
    db = openDb(path.join(reposRoot, "e48s11.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "EPIC-904", repo: M4.repo, path: EPIC4, owner: "Sam", paused: false });
    const asked: string[] = [];
    const firstAdded = async (_dir: string, rel: string, needle: string) => {
      asked.push(`${rel} ${needle}`);
      return needle === "[ask EPIC-904-A7:" ? "2026-10-21T14:05:00.000Z" : "2026-10-25T09:00:00.000Z";
    };
    const blame = async () => Array(400).fill("2026-10-21T16:30:00.000Z");
    const items = (await waitingForMilestone({ store, reposRoot, treeFor: async () => buildTree(reposRoot, { ...M4, id: m.id }, spines), blame, firstAdded }, m)).filter((i) => i.source === "ask");
    const since = Object.fromEntries(items.map((i) => [i.question, i.since]));
    expect(since).toEqual({ "Added that day?": "2026-10-21T14:05:00.000Z", "Moved in later?": "2026-10-18", "No code?": "2026-10-21" }); // no code and no line from spines.py: the day
    expect(asked).toEqual([`${EPIC4} [ask EPIC-904-A7:`, `${EPIC4} [ask EPIC-904-A8:`]);
  });

  it("reads spines.py state done (answered and consumed, ask null) as done: no missing fields, no open count (M2-39)", async () => {
    const entry = { code: "EPIC-904-A1", who: "Sam", ask: null, question: "Approve the doctrine page?", steps: null, options: [], recommend: "approve", unblocks: "step 3", effort: "~1 min", context: "docs/doctrine/human-asks.md", since: null, row: null, state: "done", answer: "APPROVED" };
    const a = fromSpinesEntry(entry)!;
    expect(a).toMatchObject({ state: "answered", ask: "unknown", doneAt: "" });
    expect(missingFields(a)).toEqual([]);
    expect(advisories(a, [a])).toEqual([]);
    expect(fromSpinesEntry({ ...entry, state: "open", ask: "approve" })!.doneAt).toBeUndefined();
    const spines = structuredClone(SPINES_EPIC4) as any;
    const node = spines.nodes.find((n: any) => n.path === EPIC4);
    node.waiting_on = [entry, { ...entry, code: "EPIC-904-A2", question: "Launch step 5 now?", state: "done", answer: "yes" }];
    db = openDb(path.join(reposRoot, "e4c.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "EPIC-904", repo: M4.repo, path: EPIC4, owner: "Sam", paused: false });
    const items = (await waitingForMilestone({ store, reposRoot, treeFor: async () => buildTree(reposRoot, { ...M4, id: m.id }, spines), blame: async () => undefined }, m)).filter((i) => i.source === "ask");
    expect(items.map((i) => [i.code, i.state])).toEqual([["EPIC-904-A1", "done"], ["EPIC-904-A2", "done"]]);
    expect(items.every((i) => !i.missing && !i.advisory)).toBe(true);
    expect(openAsksOf(node)).toBe(0);
  });
});

describe("D19 consumed answers (M2-40)", () => {
  const LIVE = fs.readFileSync(path.join(__dirname, "fixtures", "d19-live-asks.md"), "utf8");

  it("reads the end-of-line ` · done <date> <sha>` marker of the live EPIC-904-A1/A2 lines; the answer excludes it", () => {
    const [a2, a1, a3] = parseAsks(LIVE, "docs/EPIC-904-DOCTRINE-2.md");
    expect(a2).toMatchObject({ code: "EPIC-904-A2", state: "answered", answer: "APPROVED", doneAt: "2026-10-22", doneSha: "3a2254b" });
    expect(a1).toMatchObject({ code: "EPIC-904-A1", state: "answered", answer: "APPROVED", doneAt: "2026-10-22", doneSha: "9f3b093", effort: "~5 min" });
    // An answered line without the marker is the owner's action item.
    expect(a3).toMatchObject({ code: "EPIC-904-A3", answer: "yes" });
    expect(a3.doneAt).toBeUndefined();
  });

  it("a marker without date or sha is still done; the old inside-the-tag form still reads", () => {
    const md = "## Waiting on\n\n- [answered E904-A1 2026-10-21 @Sam] Q one? — answer: ok · done\n- [answered E904-A2 2026-10-21 @Sam · done 2026-10-23 abc1234] Q two? — answer: ok\n";
    const [x, y] = parseAsks(md);
    expect(x).toMatchObject({ answer: "ok", doneAt: "" });
    expect(y).toMatchObject({ answer: "ok", doneAt: "2026-10-23", doneSha: "abc1234" });
  });

  it("spines.py state done + the markdown twin: the card is done and carries the marker date (so it ages out)", async () => {
    const dir = path.join(reposRoot, "epicspine-skill", "docs");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(reposRoot, "epicspine-skill", ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, "EPIC-904-DOCTRINE-2.md"), LIVE);
    const mk = (code: string, state: string, q: string) => ({ code, who: "Sam", ask: null, question: q, steps: null, options: [], recommend: "yes", unblocks: "x", effort: null, context: null, since: null, row: null, state, answer: "APPROVED" });
    const waiting = [
      mk("EPIC-904-A2", "done", "Launch step 5 (the poly-maker E4 compliance test) now, although poly-maker E4's owner is actively working it (b0d6dd36)?"),
      mk("EPIC-904-A3", "answered", "Ship it?"),
    ];
    const asks = asksFor(path.join(reposRoot, "epicspine-skill"), "docs/EPIC-904-DOCTRINE-2.md", waiting);
    expect(asks.map((a) => [a.code, a.state, a.doneAt])).toEqual([["EPIC-904-A2", "answered", "2026-10-22"], ["EPIC-904-A3", "answered", undefined]]);
  });
});

describe("owner thread as delivery target (human-asks.md §Answering it)", () => {
  const OWNED = `# EPIC-911: Owned

## Current State

Status: blocked
Owner: EPIC-911 delivery manager (thread mcp:0a1b2c3d-1111-2222-3333-444455556666)
Waiting on: Sam (1 ask, see Waiting on)

## Waiting on

- [ask: decide @Sam since 2026-10-21] Which host? — options: main | host2 — recommend: main — context: notes.md
`;
  beforeEach(() => write("inbox/docs/spines/owned.md", OWNED));

  it("reads `thread <id>` from an Owner value; no thread named → none", () => {
    expect(threadOwner("EPIC-904 delivery manager (thread mcp:61d2777c-071a-4feb-93e3-4db440b5d6ac)")).toEqual({
      kind: "thread",
      threadId: "mcp:61d2777c-071a-4feb-93e3-4db440b5d6ac",
      label: "EPIC-904 delivery manager",
    });
    expect(threadOwner("ops manager, thread `mcp:abcdef12-3456`")).toEqual({ kind: "thread", threadId: "mcp:abcdef12-3456", label: "ops manager" });
    expect(threadOwner("Sam")).toBeUndefined();
    expect(threadOwner("whoever owns the thread")).toBeUndefined();
    expect(threadOwner(undefined)).toBeUndefined();
  });

  it("EPIC-904 without a persona: owner is the Owner: thread (spines.py current_state.owner first), row shown as a link", async () => {
    const EPIC4 = "docs/EPIC-904-DOCTRINE-2.md";
    const M4 = { id: "ms_e4", repo: "Acme/epicspine-skill", path: EPIC4, paused: false, title: "EPIC-904" };
    write("epicspine-skill/.git/config", `[remote "origin"]\n\turl = git@github.com:Acme/epicspine-skill.git\n`);
    write(`epicspine-skill/${EPIC4}`, FIXTURE);
    db = openDb(path.join(reposRoot, "e4o.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "EPIC-904", repo: M4.repo, path: EPIC4, owner: "Sam", paused: false });
    const run = (spines: SpinesJson) =>
      waitingForMilestone({ store, reposRoot, treeFor: async () => buildTree(reposRoot, { ...M4, id: m.id }, spines), blame: async () => undefined }, m);

    // spines.py without current_state.owner: the markdown `Owner:` line.
    const [ask] = (await run(SPINES_EPIC4)).filter((i) => i.source === "ask");
    expect(ask.owner).toEqual({ kind: "thread", threadId: "mcp:61d2777c-071a-4feb-93e3-4db440b5d6ac", label: "EPIC-904 delivery manager" });
    const rowIdx = FIXTURE.split("\n").findIndex((l) => l.includes("| 1. Define the doctrine"));
    expect(ask.rowLink).toEqual({ label: "row 1", url: `https://github.com/Acme/epicspine-skill/blob/HEAD/docs/EPIC-904-DOCTRINE-2.md?plain=1#L${rowIdx + 1}` });

    const spines = structuredClone(SPINES_EPIC4) as any;
    spines.nodes.find((n: any) => n.path === EPIC4).current_state = { status: "active", owner: "EPIC-904 manager (thread mcp:99999999-aaaa)" };
    const [ask2] = (await run(spines)).filter((i) => i.source === "ask");
    expect(ask2.owner).toMatchObject({ kind: "thread", threadId: "mcp:99999999-aaaa", label: "EPIC-904 manager" });
  });

  it("an answer never goes to the owner thread named in Owner: nor to an attached persona (the spine line is the hand-off)", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "Owned", repo: "Acme/inbox", path: "docs/spines/owned.md" })).json;
    const item = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.source === "ask");
    expect(item.owner).toEqual({ kind: "thread", threadId: "mcp:0a1b2c3d-1111-2222-3333-444455556666", label: "EPIC-911 delivery manager" });

    const r = await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "answer", text: "main", milestoneId: m.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ spine: { status: "skipped" } });
    expect(r.json.threadId).toBeUndefined();
    expect(t3.calls).toEqual([]);

    const p = (await call("POST", "/api/personas", { name: "steward", remit: "x", model: "haiku" })).json;
    await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } });
    const r2 = await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "answer", text: "host2", milestoneId: m.id });
    expect(r2.json).toMatchObject({ spine: { status: "skipped" } });
    // the attached persona is woken (a launch), but nothing is sent to the Owner: thread.
    expect(r2.json.wake).toMatchObject({ notified: "woken", persona: "steward" });
    expect(t3.calls.map((x) => x.op)).toEqual(["launchThread"]);
  });

});

// Needs the owner items (blocking a run, approve + grant write) are spine asks since: the grant on an
// approved ask is in pureCodeLineWaiting.test.ts.

describe("M2-18 actionable Waiting on you", () => {
  const E4 = fs.readFileSync(path.join(__dirname, "fixtures", "E4-one-logger-m2-18.md"), "utf8");
  const E5 = fs.readFileSync(path.join(__dirname, "fixtures", "E905-v2-ask.md"), "utf8");
  const EPIC4_V2 = fs.readFileSync(path.join(__dirname, "fixtures", "EPIC-904-A1-v2.md"), "utf8");
  beforeEach(() => {
    write("poly-maker/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/poly-maker.git\n`);
    write("poly-maker/docs/one-logger/E4.md", E4);
    write("poly-maker/docs/e5/E5.md", E5);
    write("poly-maker/docs/e5/notes.md", "# notes\n");
    write("poly-maker/docs/e5/runbooks/archiver-patch.md", "# run\n");
  });

  it("parses v2 tags: code, do + steps (runbook link), unblocks, effort; answered lines keep the code; v1 still parses", () => {
    const asks = parseAsks(E5, "docs/e5/E5.md", path.join(reposRoot, "poly-maker"));
    expect(asks.map((a) => [a.code, a.ask, a.state])).toEqual([
      ["E905-A3", "do", "open"],
      ["E905-A4", "decide", "open"],
      ["E905-A4", "approve", "open"],
      [null, "provide", "open"],
      ["E905-A1", "unknown", "answered"],
    ]);
    expect(asks[0]).toMatchObject({
      row: "S3",
      since: "2026-10-21",
      steps: "runbooks/archiver-patch.md#run (main, user root)",
      stepsLink: "docs/e5/runbooks/archiver-patch.md#run",
      unblocks: "S2, S3; each day waiting loses a day of archived ticks",
      recommend: "do it tonight",
      effort: "~10 min",
      context: "docs/e5/notes.md#archiver",
      question: "Patch the archiver for 1 h on main (S3: the 1 h book archive) so the Chainlink cutover can run",
    });
    expect(asks[4]).toMatchObject({ since: "2026-10-20", answer: "one", who: "Sam" });
    expect(missingFields(asks[0])).toEqual([]);
    expect(missingFields({ ...asks[0], steps: null, recommend: null })).toEqual(["steps", "recommend"]);
    expect(missingFields(asks[2])).toEqual(["unblocks"]);
    expect(missingFields(asks[3])).toEqual(["unblocks"]); // provide: no recommend needed

    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(advisories(asks[0], asks, now)).toEqual(["4 open asks in this epic (aim for ≤ 3)"]);
    expect(advisories(asks[1], asks, now)).toEqual(["duplicate code E905-A4", "4 open asks in this epic (aim for ≤ 3)", "stale ask (open 20 days)"]);
    expect(advisories(asks[3], asks, now)).toContain("ask has no code");
    expect(advisories(asks[4], asks, now)).toEqual([]);
  });

  it("reads the live EPIC-904-A1 approve ask (skill 2068ce7) with no missing fields", () => {
    const [a] = parseAsks(EPIC4_V2, "docs/EPIC-904-DOCTRINE-2.md");
    expect(a).toMatchObject({ code: "EPIC-904-A1", ask: "approve", row: "1", since: "2026-10-19", effort: "~5 min", contextLabel: "approval page" });
    expect(a.unblocks).toMatch(/^step 3 \(tools\)/);
    expect(missingFields(a)).toEqual([]);
    expect(advisories(a, [a], Date.parse("2026-10-21"))).toEqual([]);
  });

  it("futureGate: pending, or a sibling row named in Needs/Status that is not done; bare numbers never count", () => {
    const sib = (id: string, color: any = "grey", status = "ready") => ({ id, color, status, kind: "ticket" as const });
    const rows = [sib("T3"), sib("T6", "green", "done"), sib("T7"), sib("0")];
    expect(futureGate({ id: "T4", status: "pending", needs: "Sam go" }, rows)).toBe("pending");
    expect(futureGate({ id: "T10", status: "ready", needs: "Sam go; T6 + T7 green" }, rows)).toBe("after T7 (not done)");
    expect(futureGate({ id: "T9", status: "ready", needs: "Sam go; T6 green" }, rows)).toBeUndefined();
    expect(futureGate({ id: "T9", status: "waiting (Sam root, 0 days)", needs: "Sam root; T30" }, rows)).toBeUndefined();
  });

  it("E4 (Waiting on: none): only asks count; ready/blocked rows naming Sam are guessed, pending/unreachable ones are coming up", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "E4", repo: "Acme/poly-maker", path: "docs/one-logger/E4.md" })).json;
    const items = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
    expect(items.every((i) => i.source === "heuristic")).toBe(true);
    const row = (i: any) => i.title.split(" ")[0];
    const guessed = items.filter((i) => !i.gate);
    const coming = items.filter((i) => i.gate === "future");
    // 0: waiting on the owner root; T7: ready, the owner go in Needs. T1–T3/T6: workers (T6's first clause is "worker").
    expect(guessed.map(row).sort()).toEqual(["0", "T7"]);
    expect(coming.map((i) => [row(i), i.gateReason]).sort()).toEqual([
      ["T10", "pending"],
      ["T11", "pending"],
      ["T4", "pending"],
      ["T5", "pending"],
      ["T8", "pending"],
      ["T9", "after T3 (not done)"],
    ]);
    expect(items.every((i) => i.spine?.path === "docs/one-logger/E4.md" && i.spine.title === "E4" && i.repo === "poly-maker")).toBe(true);
  });

  it("v2 asks carry code, repo, steps link, unblocks, effort and advisories; answers lead with <repo>/<code>", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "E5", repo: "Acme/poly-maker", path: "docs/e5/E5.md" })).json;
    const p = (await call("POST", "/api/personas", { name: "archivist", remit: "x", model: "haiku" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
    const items = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
    const doAsk = items.find((i) => i.code === "E905-A3");
    expect(doAsk).toMatchObject({
      source: "ask",
      ask: "do",
      repo: "poly-maker",
      steps: "runbooks/archiver-patch.md#run (main, user root)",
      stepsLink: { label: "runbook", url: "https://github.com/Acme/poly-maker/blob/HEAD/docs/e5/runbooks/archiver-patch.md#run" },
      unblocks: "S2, S3; each day waiting loses a day of archived ticks",
      effort: "~10 min",
      recommendation: "do it tonight",
      // The route ages the ask against the real clock (since 2026-10-21): "stale ask" joins once it is 7 days old.
      advisory: expect.arrayContaining(["4 open asks in this epic (aim for ≤ 3)"]),
    });
    expect(doAsk.missing).toBeUndefined();
    // S3 is covered by its ask; S2 is blocked on nobody named: no guessed items here.
    expect(items.filter((i) => i.source === "heuristic")).toEqual([]);

    // the answer goes to the spine, not to the owner thread (this fixture checkout is not a git repo: refused, reason kept).
    const r = await call("POST", `/api/waiting-on-owner/${doAsk.id}/respond`, { kind: "answer", text: "done", milestoneId: m.id });
    expect(r.json).toMatchObject({ delivery: "queued", assignmentId: a.id, spine: { status: "skipped", reason: "not a git checkout", path: "docs/e5/E5.md" } });
    expect(t3.calls.map((x) => x.op)).toEqual(["launchThread"]); // woken to write it in, no thread message
    const act = (await call("GET", `/api/owner-activity?milestoneId=${m.id}`)).json as any[];
    expect(act[0].itemTitle).toBe("poly-maker/E905-A3 Action: Patch the archiver for 1 h on main (S3: the 1 h book archive) so the Chainlink cutover can run");
  });

  it("Ask owner to write asks: one fixed request per spine to the owner thread, logged in Activity; future gates left out", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "E4", repo: "Acme/poly-maker", path: "docs/one-logger/E4.md" })).json;
    const r = await call("POST", "/api/waiting-on-owner/request-asks", { milestoneId: m.id, path: "docs/one-logger/E4.md" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: "ask_for_asks", delivery: "sent", threadId: "mcp:e4e4e4e4-1111-2222-3333-444455556666" });
    expect(r.json.assignmentId).toBeUndefined();
    const sent = t3.ops("sendToThread");
    expect(sent).toHaveLength(1);
    const text = sent[0].args.message as string;
    expect(sent[0].args.clientRequestId).toBe(`console-asks-${r.json.id}`);
    expect(text).toMatch(/^From Sam via the agent-team console: please write human asks for E4 \(`docs\/one-logger\/E4\.md`, milestone E4\)/);
    expect(text).toContain("These 2 items mention Sam");
    expect(text).toContain("- 0 S3 (patch the archiver for 1h)");
    expect(text).toContain("- T7 XL-6");
    expect(text).not.toContain("- T4 ");
    expect(text).toContain("docs/doctrine/human-asks.md");
    expect(text).toContain("fewest human actions");
    expect(text).toContain("`<epic code>-A<n>`");
    expect(text).toContain("Never ask Sam to run commands");
    const act = (await call("GET", `/api/owner-activity?milestoneId=${m.id}`)).json as any[];
    expect(act[0]).toMatchObject({ type: "message", messageKind: "ask_for_asks", threadId: "mcp:e4e4e4e4-1111-2222-3333-444455556666", delivery: "sent" });
    expect(act[0].text).toMatch(/^Asked the owner to write human asks for E4 \(docs\/one-logger\/E4\.md\): 2 guessed items$/);

    expect((await call("POST", "/api/waiting-on-owner/request-asks", { milestoneId: m.id, path: "docs/nope.md" })).status).toBe(404);
    expect((await call("POST", "/api/waiting-on-owner/request-asks", { milestoneId: "ms_nope", path: "x" })).status).toBe(404);
    expect((await call("POST", "/api/waiting-on-owner/request-asks", { milestoneId: m.id })).status).toBe(400);
  });

  it("E913-S4 Rewrite as a coded ask: `to: delivery-manager` goes to the milestone's Delivery Manager, not the persona the owner rule picks", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "E4", repo: "Acme/poly-maker", path: "docs/one-logger/E4.md" })).json;
    const listener = (await call("POST", "/api/personas", { name: "Listener", remit: "listens", model: "opus" })).json;
    const dm = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs the milestone", model: "opus" })).json;
    const la = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: listener.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
    const da = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
    const plain = await call("POST", "/api/waiting-on-owner/request-asks", { milestoneId: m.id, path: "docs/one-logger/E4.md" });
    expect(plain.json.assignmentId).toBe(la.id);
    const toDm = await call("POST", "/api/waiting-on-owner/request-asks", { milestoneId: m.id, path: "docs/one-logger/E4.md", to: "delivery-manager" });
    expect(toDm.json.assignmentId).toBe(da.id);
  });
});

// superseded Needs the owner items: gone with the rows; the duplicate rule is the carry-over's (spinesPySupersededAsks.test.ts).

describe("ask type rules (no paste-steps for Sam)", () => {
  it("the wake protocol tells personas to run shell/root steps themselves and use approve for serious ones", () => {
    const text = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", mayWrite: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1" },
    } as any);
    expect(text).toContain("Never ask Sam to run commands: run shell and root steps yourself (on MAIN with `sudo`; from other hosts via `ssh main`).");
    expect(text).toContain("are an `approve` ask: say what it does, why, and the rollback");
    expect(text).toContain("after Sam approves, YOU run it and record the result");
    expect(text).toContain("Use `do` only for what only Sam can physically do");
    expect(text).toContain("[ask <CODE>: decide|approve|provide|do @Sam");
  });
});
