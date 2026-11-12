import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore, type Assignment, type Run } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import type { WaitingItem } from "../src/inbox/waiting.js";
import { FLOW_ORDER, milestoneStatus, outcomeOf, paintTree, type FlowWord, type OutcomeWord, type StatusInput } from "../src/status/compute.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/** one server-computed status per milestone (outcome, flow, items). */

const NOW = Date.parse("2026-10-24T22:00:00Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const M = { id: "m1", paused: false };

const node = (key: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "ready", color: "grey", children, flags: [], ...over,
});
const tree = (root: TreeNode, extra: Partial<Tree> = {}): Tree => ({
  milestoneId: "m1", root, counts: { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 0, closed: 0, flagged: 0, source: "spines", warnings: [], ...extra,
});
const READY = tree(node("m1", { kind: "spine", status: "active", color: "blue" }, [node("m1/S1", { ready: true })]));
const ALL_GREEN = tree(node("m1", { kind: "spine", status: "done", color: "green" }, [node("m1/S1", { status: "done", color: "green" })]));

const ask = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1", source: "ask", state: "open", code: "M1-A1", repo: "r", milestoneId: "m1", milestoneTitle: "M1", nodeKey: "m1/S1", title: "S1", ask: "decide",
  question: "Q?", contextLinks: [], owner: { kind: "none", label: "" }, decidable: false, ...over,
});
const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  id: "a1", milestoneId: "m1", personaId: "p1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true, writeEnabled: false, writeScope: "", createdAt: iso(-600),
  nextRunAt: iso(30), nextWakeAt: iso(30), ...over,
});
const run = (over: Partial<Run> = {}): Run =>
  ({ id: "r1", assignmentId: "a1", milestoneId: "m1", startedAt: iso(-10), outcome: "running", summary: "", kind: "wake", ...over }) as Run;

const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  milestone: M, status: "active", tree: READY, waiting: [], runs: [], assignments: [], personaName: () => "Delivery Manager", now: NOW, ...over,
});

/** One fixture per flow word. */
const FLOW_FIXTURES: Record<FlowWord, StatusInput> = {
  settled: input({ milestone: { ...M, settledAt: iso(-60) }, waiting: [ask()], runs: [run()], assignments: [assignment()] }),
  paused: input({ milestone: { ...M, paused: true }, waiting: [ask()] }),
  needs_you: input({ waiting: [ask()], runs: [run()], assignments: [assignment()] }),
  planning: input({ status: "draft", tree: tree(node("m1", { kind: "spine", status: "draft", runState: "planning" }, [node("m1/S1", { ready: true })])), assignments: [assignment()] }),
  parked: input({ status: "deferred", tree: tree(node("m1", { kind: "spine", status: "deferred", runState: "parked" })), assignments: [assignment()] }),
  working: input({ runs: [run()], assignments: [assignment()] }),
  monitoring: input({ monitoring: [{ what: "7-day hold", nextCheckAt: iso(120), until: iso(7 * 1440) }], assignments: [assignment()] }),
  queued: input({ assignments: [assignment()] }),
  stalled: input({ assignments: [assignment({ enabled: false, nextWakeAt: undefined })] }),
  nothing_to_do: input({ tree: ALL_GREEN, assignments: [assignment()] }),
};

describe("E913-S1 flow words", () => {
  for (const word of FLOW_ORDER)
    it(`fixture → ${word}`, () => {
      expect(milestoneStatus(FLOW_FIXTURES[word]).flow.word).toBe(word);
    });

  it("settled beats everything (open asks, a live run, a schedule)", () => {
    const s = milestoneStatus(FLOW_FIXTURES.settled);
    expect(s.flow.word).toBe("settled");
    expect(s.needsYou).toBe(1); // the items are still listed
  });

  it("contract: flow is needs_you iff there is an open item (needsYou > 0), for every fixture", () => {
    for (const f of Object.values(FLOW_FIXTURES)) {
      const s = milestoneStatus(f);
      if (s.flow.word === "settled" || s.flow.word === "paused") continue;
      expect(s.flow.word === "needs_you").toBe(s.needsYou > 0);
      expect(s.needsYou).toBe(s.items.filter((i) => i.state === "open").length);
    }
  });

  it("monitoring without a date is not monitoring: falls through to queued / stalled / nothing_to_do", () => {
    const undated = [{ what: "watching the logs" }];
    expect(milestoneStatus(input({ monitoring: undated, assignments: [assignment()] })).flow.word).toBe("queued");
    expect(milestoneStatus(input({ monitoring: undated })).flow.word).toBe("stalled");
    const s = milestoneStatus(input({ monitoring: undated, tree: ALL_GREEN }));
    expect(s.flow.word).toBe("nothing_to_do");
    expect(s.reasons).toContain("Monitoring line has no date: not monitoring");
  });

  it("EPIC-915 case: 3 assignments enabled=0, 2 ready rows → stalled", () => {
    const t = tree(node("m1", { kind: "spine", status: "active", color: "blue" }, [node("m1/S1", { ready: true }), node("m1/S2", { ready: true })]));
    const off = [1, 2, 3].map((i) => assignment({ id: `a${i}`, personaId: `p${i}`, enabled: false, nextWakeAt: undefined }));
    const s = milestoneStatus(input({ tree: t, assignments: off }));
    expect(s.flow.word).toBe("stalled");
    expect(s.flow.reason).toMatch(/3 personas assigned, none enabled/);
  });

  it("EPIC-902 case, E962-S8: monitoring is the spine's `Monitoring:` line; a timed wake or a run's monitoring report alone is not", () => {
    const timed = { assignments: [assignment({ retryAt: iso(240), retryRunId: "r0", nextWakeAt: iso(240) })], runs: [run({ id: "r0", outcome: "monitoring", endedAt: iso(-5), summary: "monitoring: archiver delete proof", nextCheckAt: iso(240) })] };
    const s = milestoneStatus(input(timed));
    expect(s.flow).toMatchObject({ word: "queued", nextWakeAt: iso(240) });
    expect(s.flow).not.toHaveProperty("derived");
    // the report wrote the line (app.ts monitoringInSpine): the spine says monitoring
    const m = milestoneStatus(input({ ...timed, monitoring: [{ what: "archiver delete proof", nextCheckAt: iso(240) }] }));
    expect(m.flow).toMatchObject({ word: "monitoring", nextWakeAt: iso(240) });
    expect(m.flow.monitoring?.[0]).toMatchObject({ what: "archiver delete proof", nextCheckAt: iso(240) });
  });

  it("a timed wake of a switched-off persona is not monitoring (L-10: it never wakes)", () => {
    expect(milestoneStatus(input({ assignments: [assignment({ enabled: false, retryAt: iso(240), nextWakeAt: undefined })] })).flow.word).toBe("stalled");
  });

  it("queued carries the next wake and the personas; a parked persona does not count", () => {
    const s = milestoneStatus(input({ assignments: [assignment({ nextWakeAt: iso(45) }), assignment({ id: "a2", parkedAt: iso(-1), nextWakeAt: iso(5) })] }));
    expect(s.flow).toMatchObject({ word: "queued", nextWakeAt: iso(45), personas: ["Delivery Manager"] });
  });

  it("a running run older than 3 h with no T3 read is not working; a fresh T3 read decides", () => {
    expect(milestoneStatus(input({ runs: [run({ startedAt: iso(-200) })], assignments: [assignment()] })).flow.word).toBe("queued");
    const t3 = () => ({ status: "completed", checkedAt: iso(-1) });
    expect(milestoneStatus(input({ runs: [run()], assignments: [assignment()], t3State: t3 })).flow.word).toBe("queued");
  });
});

describe("E913-S1 items", () => {
  it("open asks and persona requests count; free-text asks (E913-S14) and persona FYIs do not; a console answer moves an ask to answered", () => {
    const waiting = [
      ask({ id: "a" }),
      ask({ id: "b", source: "needs_jordi", code: undefined }),
      ask({ id: "c", source: "heuristic" }),
      ask({ id: "d", state: "answered", decidedBy: "Unblocker" }),
      ask({ id: "e", code: "M1-A5" }),
      ask({ id: "f", state: "done", doneAt: "2026-10-24" }),
    ];
    const s = milestoneStatus(input({ waiting, responded: new Set(["e"]), assignments: [assignment()] }));
    expect(s.items.map((i) => [i.id, i.kind, i.state])).toEqual([
      ["a", "ask", "open"],
      ["b", "needs_jordi", "open"],
      ["e", "answered", "answered"],
    ]);
    expect(s.needsYou).toBe(2);
    expect(s.defects?.map((d) => d.kind)).toEqual(["free_text"]);
    expect(s.items[2].title).toBe("Answer received, waiting for Delivery Manager to act (M1-A5)");
  });

  it("answered with nobody scheduled → stalled (nobody will consume it); with a schedule → queued", () => {
    const answered = [ask({ state: "answered", answer: "yes" })];
    const s = milestoneStatus(input({ waiting: answered, tree: ALL_GREEN }));
    expect(s.items[0]).toMatchObject({ kind: "answered", persona: "nobody scheduled" });
    expect(s.flow.word).toBe("stalled");
    expect(milestoneStatus(input({ waiting: answered, tree: ALL_GREEN, assignments: [assignment()] })).flow.word).toBe("queued");
  });

  it("E913-S14: a free-text Waiting on naming Sam is no item for him but a defect for the Delivery Manager (never needs you)", () => {
    const freeText = ask({ source: "heuristic", signal: "waiting_on", code: undefined, question: "Sam to confirm the brand voice", path: "docs/spines/root.md", line: 7 });
    const s = milestoneStatus(input({ waiting: [freeText], assignments: [assignment()] }));
    expect(s.needsYou).toBe(0);
    expect(s.items).toEqual([]);
    expect(s.flow.word).not.toBe("needs_you");
    expect(s.defects).toEqual([expect.objectContaining({ kind: "free_text", path: "docs/spines/root.md", line: 7, text: "Sam named at docs/spines/root.md:8 with no ask: write a coded ask or drop the line" })]);
    expect(s.reasons).toContain("defect for the Delivery Manager: Sam named at docs/spines/root.md:8 with no ask: write a coded ask or drop the line");
  });
});

describe("E913-S1 outcome words", () => {
  const evidence = [{ doneMeans: "D1", links: ["x"] }];
  const o = (over: Partial<NonNullable<StatusInput["outcome"]>> = {}) => ({ verdict: null, sentence: null, evidence: [], risk: null, closedAt: null, closedBy: null, ...over });
  const cases: [OutcomeWord, Parameters<typeof outcomeOf>[0]][] = [
    ["not_yet", { status: "active", doneMeans: { done: 1, total: 2 } }],
    ["ready_to_mark", { status: "active", doneMeans: { done: 2, total: 2 }, outcome: o({ evidence }) }],
    ["accomplished", { status: "done", outcome: o({ verdict: "accomplished" }), tree: ALL_GREEN }],
    ["partially", { status: "done", outcome: o({ verdict: "partially accomplished" }), tree: ALL_GREEN }],
    ["superseded", { status: "superseded" }],
    ["reopened", { status: "done", outcome: o({ verdict: "accomplished" }), tree: tree(node("m1", { kind: "spine", status: "done", color: "green" }, [node("m1/E2", { kind: "spine", status: "active", color: "blue" })])) }],
  ];
  for (const [word, i] of cases) it(`fixture → ${word}`, () => expect(outcomeOf(i).word).toBe(word));

  it("ready_to_mark needs the evidence table too; reopened carries the open count", () => {
    expect(outcomeOf({ doneMeans: { done: 2, total: 2 }, outcome: o() }).word).toBe("not_yet");
    expect(outcomeOf(cases[5][1])).toMatchObject({ word: "reopened", open: 1 });
  });
});

// ---------- the code repo root fixture (3b, 3c), through the API ----------

let reposRoot: string;
let db: DB;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

const ROOT_OPEN = `# EPIC: home_repo

Spine ID: root

## Current State

Status: active
Waiting on: Sam: EPIC-907-A1, M5-A1

## Waiting on

- [ask M5-A1: decide @Sam since 2026-10-24 row M5] Import authed cookies? — options: yes | no — recommend: yes — unblocks: M5 — context: notes.md

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| EPIC-907 | team.example.com; [epic](epic-7.md) | active |
| M5 | Unblocked web | ready |
`;
const EPIC7_OPEN = `# EPIC-907: team

## Current State

Status: active

## Waiting on

- [ask EPIC-907-A1: approve @Sam since 2026-10-24] Does team.example.com load on your phone? — recommend: yes — unblocks: EPIC-907 — context: notes.md
`;
const ROOT_ANSWERED = `# EPIC: home_repo

Spine ID: root

## Current State

Status: active
Waiting on: none

## Waiting on

- [answered M5-A1 2026-10-24 @Sam] Import authed cookies? — answer: how would we import authed cookies?

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| EPIC-907 | team.example.com; [epic](epic-7.md) | active |
| M5 | Unblocked web; [epic](m5.md) | blocked (waits on M5-A1) |
`;
const EPIC7_ANSWERED = EPIC7_OPEN.replace("- [ask EPIC-907-A1: approve @Sam since 2026-10-24]", "- [answered EPIC-907-A1 2026-10-24 @Sam]") + " — answer: it does load\n";
const M5 = `# M5: Unblocked web

## Current State

Status: blocked (waits on M5-A1)
Waiting on: Sam: M5-A1
`;

function setup(root: string, epic7: string) {
  write("home_repo/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/home_repo.git\n`);
  write("home_repo/docs/spines/root.md", root);
  write("home_repo/docs/spines/epic-7.md", epic7);
  write("home_repo/docs/spines/m5.md", M5);
  write("home_repo/docs/spines/notes.md", "# notes\n");
  db = openDb(path.join(reposRoot, "c.db"));
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
  const m = createStore(db).createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "", paused: false });
  const get = async (url: string) => (await app.request(url)).json();
  return { m, get };
}
const walk = (n: TreeNode & { waiting?: number; rollup?: string }, f: (n: TreeNode & { waiting?: number; rollup?: string }) => void) => {
  f(n);
  n.children.forEach((c) => walk(c, f));
};
const tabCount = (items: WaitingItem[] & { response?: unknown }[]) => items.filter((i) => i.source !== "heuristic" && i.state === "open" && !(i as { response?: unknown }).response).length;

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s1-"));
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

describe("E913-S1 home_repo root fixture", () => {
  it("3b: two open asks (EPIC-907-A1 on an active epic, M5-A1 on a ready row): tab = banner = Team badge = Tree red = 2", async () => {
    const { m, get } = setup(ROOT_OPEN, EPIC7_OPEN);
    const st = await get(`/api/milestones/${m.id}/status`);
    const all = await get(`/api/status`);
    const t = await get(`/api/milestones/${m.id}/tree`);
    const tab = tabCount(await get(`/api/waiting-on-owner?milestoneId=${m.id}`));
    expect(st.flow.word).toBe("needs_you");
    expect(st.needsYou).toBe(2);
    expect(st.items.map((i: { code: string }) => i.code).sort()).toEqual(["EPIC-907-A1", "M5-A1"]);
    expect(tab).toBe(2);
    expect(all.needsYou).toBe(2);
    expect(t.counts.red).toBe(2);
    const red: string[] = [];
    let rings = 0;
    walk(t.root, (n) => {
      if (n.color === "red") red.push(n.id);
      if (n.rollup === "red") rings++;
    });
    expect(red.sort()).toEqual(["EPIC-907", "M5"]);
    expect(t.root.color).not.toBe("red");
    expect(rings).toBe(1); // the root carries the ring, never counted
  });

  it("3c: both asks answered, no persona: 0 open everywhere, one 'answered, nobody scheduled' item per ask, flow stalled, M5 node flagged stale", async () => {
    const { m, get } = setup(ROOT_ANSWERED, EPIC7_ANSWERED);
    const st = await get(`/api/milestones/${m.id}/status`);
    const all = await get(`/api/status`);
    const t = await get(`/api/milestones/${m.id}/tree`);
    const tab = tabCount(await get(`/api/waiting-on-owner?milestoneId=${m.id}`));
    expect([tab, st.needsYou, all.needsYou, t.counts.red]).toEqual([0, 0, 0, 0]);
    expect(st.items.filter((i: { kind: string }) => i.kind !== "stalled").map((i: { kind: string; persona: string; code: string }) => [i.code, i.kind, i.persona]).sort()).toEqual([
      ["EPIC-907-A1", "answered", "nobody scheduled"],
      ["M5-A1", "answered", "nobody scheduled"],
    ]);
    expect(st.flow.word).toBe("stalled");
    expect(st.items.filter((i: { kind: string; state: string }) => i.kind === "stalled" && i.state === "alarm")).toHaveLength(1);
    let m5: (TreeNode & { waiting?: number }) | undefined;
    walk(t.root, (n) => {
      if (n.id === "M5") m5 = n;
      expect(n.color).not.toBe("red");
    });
    expect(m5?.flags).toContain("stale");
    expect(m5?.notes?.join(" ")).toMatch(/status stale: names M5-A1/);
  });

  it("GET /api/milestones/:id/status 404s for an unknown id", async () => {
    const { get } = setup(ROOT_OPEN, EPIC7_OPEN);
    expect((await get(`/api/milestones/nope/status`)).error.code).toBe("not_found");
  });
});

describe("E913-S1 paintTree", () => {
  it("one red per item: two items on one node show 2 there; an item off the tree attaches to the root", () => {
    const t = tree(node("m1", { kind: "spine", status: "active", color: "blue" }, [node("m1/S1"), node("m1/S2", { status: "blocked — waiting on Sam", color: "red" })]));
    const items = [
      { id: "1", kind: "ask" as const, state: "open" as const, milestoneId: "m1", title: "", nodeKey: "m1/S1" },
      { id: "2", kind: "ask" as const, state: "open" as const, milestoneId: "m1", title: "", nodeKey: "m1/S1" },
      { id: "3", kind: "needs_jordi" as const, state: "open" as const, milestoneId: "m1", title: "", nodeKey: "elsewhere" },
    ];
    const p = paintTree(t, items);
    expect(p.counts.red).toBe(3);
    const [s1, s2] = p.root.children as (TreeNode & { waiting?: number })[];
    expect([s1.color, s1.waiting]).toEqual(["red", 2]);
    expect(s2.color).toBe("yellow"); // red only by its words, no item → blocked on a dependency hue
    expect((p.root as TreeNode & { waiting?: number }).waiting).toBe(1);
    expect(t.root.children[0].color).toBe("grey"); // the input is not mutated
  });
});
