import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { createStore, type Assignment, type Run } from "../src/store.js";
import {
  blockerOf,
  dayStart,
  doneRows,
  epicsOf,
  limitGit,
  movingEpics,
  spineActivity,
  git,
  stallVerdict,
  stalledWake,
  STALL_WATCH_BY,
  type MovingEpic,
} from "../src/cycle/movement.js";
import { createMovement } from "../src/cycle/movementRoutes.js";
import { buildWakePrompt } from "../src/wakePrompt.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";

// stalled wakes, the stall watch, the Moving now strip.

const H = 3600_000;
const NOW = Date.parse("2026-10-26T12:00:00Z");

describe("(a) a Delivery manager wake that launches nothing names its blocker", () => {
  const base = { persona: "Delivery Manager", outcome: "progressed" as Run["outcome"], summary: "outcome: progressed: spine tidy", ready: ["E901-S1", "E901-S2"], launched: 0 };
  it("no worker, rows ready, no blocker line → stalled", () => {
    expect(stalledWake(base)).toMatch(/launched no worker and named no blocker while 2 rows read ready: E901-S1, E901-S2/);
    expect(stalledWake({ ...base, outcome: "idle" })).toBeTruthy();
    expect(stalledWake({ ...base, outcome: "monitoring" })).toBeTruthy();
  });
  it("a blocker line, a launched worker, no ready rows, another persona, failed or blocked → not stalled", () => {
    expect(stalledWake({ ...base, summary: "outcome: idle\nblocker: no seat (pick: all seats over 85%)" })).toBeUndefined();
    expect(stalledWake({ ...base, launched: 1 })).toBeUndefined();
    expect(stalledWake({ ...base, ready: [] })).toBeUndefined();
    expect(stalledWake({ ...base, persona: "Unblocker" })).toBeUndefined();
    expect(stalledWake({ ...base, outcome: "failed" })).toBeUndefined();
    expect(stalledWake({ ...base, outcome: "blocked" })).toBeUndefined();
  });
  it("blockerOf reads the first `blocker:` line", () => {
    expect(blockerOf("did x\n- blocker: dependency on E901-S1\nblocker: other")).toBe("dependency on E901-S1");
    expect(blockerOf("no blocker here")).toBeUndefined();
  });
  it("the wake prompt asks for the blocker line", () => {
    const p = buildWakePrompt({ name: "Delivery Manager", remit: "runs it", skills: [] }, { title: "T", repo: "o/r", path: "docs/x.md", owner: "" });
    expect(p).toContain("blocker: <the one blocker");
    expect(p).toContain("flagged stalled (root L-26)");
  });
});

// ---------- (b) stall verdicts ----------

const epic = (over: Partial<MovingEpic> = {}): MovingEpic => ({
  milestoneId: "m1",
  repo: "Acme/x",
  path: "docs/spines/epic-1.md",
  title: "EPIC-901",
  status: "active",
  workers: [],
  doneToday: [],
  ready: ["E901-S1"],
  rows: ["E901-S1", "E901-S2"],
  lastCommitAt: new Date(NOW - 3 * H).toISOString(),
  ...over,
});
const dm = (over: Partial<Assignment> = {}): Assignment =>
  ({ id: "as_dm", milestoneId: "m1", personaId: "p_dm", enabled: true, createdAt: "2026-10-01T00:00:00Z", ...over }) as Assignment;
const seats = [{ id: "seat1", name: "seat1", resetsAt: {}, limited: false, inFlight: 0, status: "ok" as const }];
const ms = { id: "m1", repo: "Acme/x", paused: false };
const verdict = (over: { epic?: Partial<MovingEpic>; manager?: Assignment | null; runs?: Run[]; seats?: typeof seats; now?: number } = {}) =>
  stallVerdict(
    { milestone: ms, epic: epic(over.epic), manager: over.manager === null ? undefined : over.manager ?? dm(), managerName: "Delivery Manager", runs: over.runs ?? [], seats: over.seats ?? seats },
    over.now ?? NOW,
  );
const run = (over: Partial<Run>): Run => ({ id: "r", assignmentId: "as_dm", milestoneId: "m1", startedAt: new Date(NOW - 30 * 60_000).toISOString(), outcome: "progressed", summary: "", kind: "wake", ...over });

describe("(b) stall watch verdict", () => {
  it("ready rows, free seat, no worker or commit for 2 h, DM on → fire on the DM", () => {
    const v = verdict();
    expect(v.verdict).toBe("fire");
    expect(v.assignmentId).toBe("as_dm");
    expect(v.reason).toMatch(/1 ready row \(E901-S1\), no worker or commit for 3 h/);
  });
  it("never for a switched-off or parked Delivery manager (L-10), nor with none assigned", () => {
    expect(verdict({ manager: dm({ enabled: false }) })).toMatchObject({ verdict: "skip", reason: expect.stringMatching(/switched off or parked.*L-10/) });
    expect(verdict({ manager: dm({ parkedAt: "2026-10-26T00:00:00Z" } as Partial<Assignment>) }).verdict).toBe("skip");
    expect(verdict({ manager: null }).reason).toBe("no Delivery manager assigned");
  });
  it("once per epic per 2 h: a Stall watch Run now naming the epic in the last 2 h skips it; older does not", () => {
    const fired = run({ id: "r_sw", instructionsBy: STALL_WATCH_BY, instructions: "Stall watch …\n- docs/spines/epic-1.md — EPIC-901", startedAt: new Date(NOW - 90 * 60_000).toISOString(), endedAt: new Date(NOW - 80 * 60_000).toISOString() });
    expect(verdict({ runs: [fired] })).toMatchObject({ verdict: "skip", reason: expect.stringMatching(/already fired/) });
    const old = { ...fired, startedAt: new Date(NOW - 2.5 * H).toISOString(), endedAt: new Date(NOW - 2.4 * H).toISOString() };
    expect(verdict({ runs: [old] }).verdict).toBe("fire");
    // another epic's firing does not count
    expect(verdict({ runs: [{ ...fired, instructions: "- docs/spines/epic-2.md" }] }).verdict).toBe("fire");
  });
  it("skips: recent commit, recent worker, running worker, running wake, no ready rows, not ready/active, no free seat", () => {
    expect(verdict({ epic: { lastCommitAt: new Date(NOW - 30 * 60_000).toISOString() } }).reason).toMatch(/moved 30 min ago/);
    expect(verdict({ runs: [run({ parentRunId: "p", summary: "E901-S2 build it", endedAt: new Date(NOW - H).toISOString() })] }).reason).toMatch(/moved 60 min ago/);
    expect(verdict({ epic: { workers: [{ ticket: "E901-S2", runId: "c", persona: "DM" }] } }).reason).toMatch(/worker running/);
    expect(verdict({ runs: [run({ outcome: "running" })] }).reason).toMatch(/wake of this milestone is running/);
    expect(verdict({ epic: { ready: [] } }).reason).toBe("no unclaimed ready rows");
    expect(verdict({ epic: { status: "draft" } }).reason).toMatch(/not ready\/active/);
    expect(verdict({ epic: { status: "blocked" } }).verdict).toBe("skip");
    expect(verdict({ seats: [{ ...seats[0], limited: true, status: "limited" as never }] }).reason).toBe("no free seat");
  });
});

// ---------- (c) Moving now data ----------

const node = (over: Partial<TreeNode>): TreeNode => ({ key: over.id ?? "k", id: "x", kind: "ticket", title: "", status: "ready", color: "grey", children: [], flags: [], ...over });

describe("(c) Moving now", () => {
  const tree: Tree = {
    milestoneId: "m1",
    root: node({
      id: "root",
      kind: "spine",
      path: "docs/spines/root.md",
      status: "active",
      children: [
        node({ id: "R1", status: "done" }),
        node({
          id: "EPIC-901",
          kind: "spine",
          path: "docs/spines/epic-1.md",
          title: "EPIC-901: one",
          status: "active",
          children: [node({ id: "E901-S1", ready: true }), node({ id: "E901-S2", ready: true }), node({ id: "E901-S3", status: "done" })],
        }),
        node({ id: "EPIC-902", kind: "spine", path: "docs/spines/epic-2.md", title: "EPIC-902", status: "draft", children: [node({ id: "E902-S1", status: "draft" })] }),
      ],
    }),
    counts: { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 },
    nonGreen: 0,
    closed: 0,
    flagged: 0,
    source: "spines",
    warnings: [],
  };
  it("epicsOf: each spine's own rows and ready rows", () => {
    expect(epicsOf(tree).map((e) => [e.path, e.rows, e.ready])).toEqual([
      ["docs/spines/epic-1.md", ["E901-S1", "E901-S2", "E901-S3"], ["E901-S1", "E901-S2"]],
      ["docs/spines/epic-2.md", ["E902-S1"], []],
      ["docs/spines/root.md", ["R1"], []],
    ]);
  });
  it("movingEpics: worker running (claims), last commit, rows done today; draft epics with nothing moving are left out", () => {
    const claims = [{ ticket: "E901-S2", runId: "c1", assignmentId: "a", persona: "Delivery Manager", summary: "E901-S2 build" }];
    const at = "2026-10-26T10:00:00Z";
    const rows = movingEpics({ id: "m1", repo: "Acme/x" }, epicsOf(tree), claims, { "docs/spines/epic-1.md": { lastCommitAt: at, doneToday: ["E901-S3", "ZZ"] } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: "docs/spines/epic-1.md", status: "active", workers: [{ ticket: "E901-S2", runId: "c1" }], lastCommitAt: at, doneToday: ["E901-S3"], ready: ["E901-S1"] });
    expect(rows[1]).toMatchObject({ path: "docs/spines/root.md", workers: [], doneToday: [] });
  });
  it("doneRows / dayStart", () => {
    expect([...doneRows("## Issue Ledger\n\n| ID | Title | Status |\n|---|---|---|\n| A1 | a | done |\n| A2 | b | ready |\n")]).toEqual(["A1"]);
    expect(dayStart(NOW)).toBe("2026-10-26T00:00:00.000Z");
  });
});

// ---------- app level: git repo fixture ----------

const spineText = (rows: string) => `# EPIC-905: Moving

Spine ID: moving-root

## Current State

Status: active
Waiting on: none

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
${rows}`;

let reposRoot: string;
let db: DB;
const repo = () => path.join(reposRoot, "moving");
const sh = (args: string[], date?: string) =>
  execFileSync("git", ["-C", repo(), ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    stdio: "pipe",
  }).toString();
const commitSpine = (rows: string, date: string) => {
  fs.writeFileSync(path.join(repo(), "docs/spines/root.md"), spineText(rows));
  sh(["add", "-A"]);
  sh(["commit", "-qm", "spine"], date);
};

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e14s8-"));
  fs.mkdirSync(path.join(repo(), "docs/spines"), { recursive: true });
  sh(["init", "-q", "-b", "main"]);
  sh(["remote", "add", "origin", "https://github.com/Acme/moving.git"]);
  fs.writeFileSync(path.join(reposRoot, "seats.json"), JSON.stringify({ seats: { seat1: { usage: { five_hour_pct: 10, known: true }, logged_in: true } } }));
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

async function setup(persona = "Delivery Manager") {
  db = openDb(path.join(reposRoot, "console.db"));
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const m = (await call("POST", "/api/milestones", { title: "Moving", repo: "Acme/moving", path: "docs/spines/root.md" })).json;
  const p = (await call("POST", "/api/personas", { name: persona, remit: "runs the milestone", model: "opus" })).json;
  const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
  return { call, m, a, read };
}

describe("(a) app: the finishing PATCH flags a stalled wake", () => {
  const today = new Date().toISOString();
  it("DM wake, ready row, no worker, no blocker → stalled; with a blocker line → not", async () => {
    commitSpine("| M1 | Build | ready |\n", today);
    const { call, a } = await setup();
    const r1 = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    const p1 = await call("PATCH", `/api/runs/${r1.id}`, { outcome: "progressed", summary: "outcome: progressed: tidied", endedAt: new Date().toISOString() });
    expect(p1.status).toBe(200);
    expect(p1.json.stalled).toMatch(/launched no worker and named no blocker while 1 row reads ready: M1/);
    const r2 = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    const p2 = await call("PATCH", `/api/runs/${r2.id}`, { outcome: "progressed", summary: "outcome: progressed: tidied\nblocker: deploy guard until 18:00Z", endedAt: new Date().toISOString() });
    expect(p2.json.stalled).toBeUndefined();
  });
  it("a DM wake that launched a worker is not stalled", async () => {
    commitSpine("| M1 | Build | ready |\n| M2 | More | ready |\n", today);
    const { call, a } = await setup();
    const r = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    await call("POST", "/api/runs", { assignmentId: a.id, parentRunId: r.id, summary: "M1 build", outcome: "running" });
    const p = await call("PATCH", `/api/runs/${r.id}`, { outcome: "progressed", summary: "outcome: progressed: dispatched M1", endedAt: new Date().toISOString() });
    expect(p.json.stalled).toBeUndefined();
  });
  it("another persona's wake is never flagged", async () => {
    commitSpine("| M1 | Build | ready |\n", today);
    const { call, a } = await setup("steward");
    const r = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    const p = await call("PATCH", `/api/runs/${r.id}`, { outcome: "progressed", summary: "outcome: progressed: x", endedAt: new Date().toISOString() });
    expect(p.json.stalled).toBeUndefined();
  });
});

describe("(b)+(c) app: dry list, strip data, one Run now per epic per 2 h", () => {
  it("GET /moving-now and /stall-watch read the repo; the tick fires once, then skips for 2 h; never for an off persona", async () => {
    const old = new Date(Date.now() - 5 * H).toISOString();
    // A row done today: done now, ready at midnight (first commit before midnight).
    const beforeMidnight = new Date(Math.min(Date.parse(dayStart(Date.now())) - H, Date.now() - 6 * H)).toISOString();
    commitSpine("| M1 | Build | ready |\n| M2 | Ship | ready |\n", beforeMidnight);
    commitSpine("| M1 | Build | ready |\n| M2 | Ship | done |\n", old);
    const { call, a, m } = await setup();

    const strip = (await call("GET", "/api/moving-now")).json;
    expect(strip.epics).toHaveLength(1);
    const e = strip.epics[0];
    expect(e).toMatchObject({ milestoneId: m.id, path: "docs/spines/root.md", status: "active", workers: [], ready: ["M1"] });
    expect(e.lastCommitAt).toBeTruthy();
    expect(e.doneToday).toEqual(Date.parse(old) >= Date.parse(dayStart(Date.now())) ? ["M2"] : []);

    const dry = (await call("GET", "/api/stall-watch")).json;
    expect(dry.enabled).toBe(false);
    expect(dry.epics).toEqual([expect.objectContaining({ path: "docs/spines/root.md", verdict: "fire", assignmentId: a.id })]);

    // The real trigger: fake Run now that records the run as the cycle would.
    const store = createStore(db);
    const fired: string[] = [];
    const repoDir = repo();
    const tree = async () => (await call("GET", `/api/milestones/${m.id}/tree`)).json as Tree;
    const mk = (enabled: boolean) =>
      createMovement({
        store,
        treeFor: tree,
        repoDir: () => repoDir,
        seats: () => [{ id: "seat1", name: "seat1", resetsAt: {}, limited: false, inFlight: 0, status: "ok" }],
        enabled,
        runNow: async (id, note) => {
          fired.push(note);
          const r = store.createRun({ assignmentId: id, outcome: "running", summary: "Run now", instructions: note, instructionsBy: STALL_WATCH_BY });
          return store.updateRun(r.id, { outcome: "progressed", endedAt: new Date().toISOString(), summary: "outcome: progressed\nnote: done: dispatched M1" })!;
        },
      });
    expect((await mk(false).tick()).fired).toEqual([]); // flag off: nothing fires
    const on = mk(true);
    const t1 = await on.tick();
    expect(t1.fired).toHaveLength(1);
    expect(t1.fired[0]).toMatchObject({ assignmentId: a.id, epics: ["docs/spines/root.md"] });
    expect(fired[0]).toMatch(/Stall watch \(root L-26\).*\n- docs\/spines\/root.md/);
    expect((await on.tick()).fired).toEqual([]); // once per epic per 2 h
    expect((await on.evaluate())[0].reason).toMatch(/already fired/);

    // Switched off (L-10): never fires, even after 2 h.
    await call("PATCH", `/api/assignments/${a.id}`, { enabled: false });
    const later = createMovement({ ...{ store, treeFor: tree, repoDir: () => repoDir, seats: () => [{ id: "seat1", name: "seat1", resetsAt: {}, limited: false, inFlight: 0, status: "ok" as const }] }, enabled: true, runNow: async () => { throw new Error("must not fire"); }, now: () => Date.now() + 3 * H });
    expect((await later.tick()).fired).toEqual([]);
    expect((await later.evaluate())[0].reason).toMatch(/switched off/);
  });
});

describe("spineActivity on a real repo", () => {
  it("a spine created today counts every done row", async () => {
    commitSpine("| A | a | done |\n| B | b | ready |\n", new Date().toISOString());
    const act = await spineActivity()(repo(), "docs/spines/root.md");
    expect(act.doneToday).toEqual(["A"]);
    expect(act.lastCommitAt).toBeTruthy();
  });

  it("E944-S5: same HEAD answers from the cache with no git; a moved HEAD recomputes only spines the commit changed", async () => {
    commitSpine("| A | a | done |\n| B | b | ready |\n", new Date().toISOString());
    const calls: string[][] = [];
    const g = (dir: string, args: string[], input?: string) => (calls.push(args), git(dir, args, input));
    const act = spineActivity(g);
    expect((await act(repo(), "docs/spines/root.md")).doneToday).toEqual(["A"]);
    expect((await act(repo(), "docs/spines/other.md")).doneToday).toEqual([]);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);
    // same HEAD, far past the old 60 s TTL: no spawn at all
    await act(repo(), "docs/spines/root.md", Date.now() + 10 * 60_000);
    await act(repo(), "docs/spines/other.md", Date.now() + 10 * 60_000);
    expect(calls.length).toBe(first);
    // a commit that changes root.md: one diff, root.md recomputed (B now done), other.md served from the cache
    commitSpine("| A | a | done |\n| B | b | done |\n", new Date().toISOString());
    calls.length = 0;
    expect((await act(repo(), "docs/spines/root.md")).doneToday).toEqual(["A", "B"]);
    expect((await act(repo(), "docs/spines/other.md")).doneToday).toEqual([]);
    expect(calls.filter((c) => c[0] === "diff")).toHaveLength(1);
    expect(calls.some((c) => c.join(" ").includes("other.md"))).toBe(false);
    expect(calls.some((c) => c.join(" ").includes("root.md"))).toBe(true);
  });
});

describe("E22-1 limitGit: a cold Moving now cannot flood the host with git processes", () => {
  it("runs at most `max` calls at once, all in order, a failure frees its slot", async () => {
    let live = 0;
    let peak = 0;
    const done: number[] = [];
    const slow = (i: number) => new Promise<string>((res, rej) => setTimeout(() => (i === 3 ? rej(new Error("boom")) : res(String(i))), 5));
    const g = limitGit(async (_dir, args) => {
      live++;
      peak = Math.max(peak, live);
      try {
        return await slow(Number(args[0]));
      } finally {
        live--;
        done.push(Number(args[0]));
      }
    }, 4);
    const out = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => g("/r", [String(i)])));
    expect(peak).toBe(4);
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(39);
    expect((out[3] as PromiseRejectedResult).reason.message).toBe("boom");
    expect(done).toHaveLength(40);
  });
});
