import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { AGENT_VERDICT, deriveVerdict, gitLog, parseCommits, runCommitsLookup, ticketId, UNCONFIRMED, unclosedChild, type CommitRun, type GitLog } from "../src/adapters/outcome.js";
import { currentStateFor, fixtureRunner, outcomeFor, parseSpinesJson, type SpinesJson, type SpinesRunner } from "../src/adapters/spines.js";
import type { ReadConfig } from "../src/routes/read.js";
import { camelState, parseDoc, rawCurrentState } from "../src/adapters/doc.js";
import { makeFixtureRoot } from "./fixtures.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const OUTCOME_FILE = path.join(FIX, "spines-outcome.json");
const S: SpinesJson = parseSpinesJson(fs.readFileSync(OUTCOME_FILE, "utf8"));
const EPIC6 = "docs/EPIC-906-outcome.md";

describe("outcomeFor (console contract #outcome)", () => {
  it("maps snake_case to camelCase", () => {
    expect(outcomeFor(S, EPIC6)).toEqual({
      verdict: "accomplished",
      sentence: "Sam sees, on every milestone, whether it was accomplished and the runs that got it there.",
      evidence: [
        { doneMeans: "E6-1 The console shows the verdict on every milestone page", links: ["https://github.com/Acme/home_repo/pull/12", "0891cbb"] },
        { doneMeans: "E6-2 Activity is a run timeline with spine commits", links: ["PR #13", "docs/spines/m2-team-console.md"] },
      ],
      risk: "commits outside the spine's folder are not listed",
      closedAt: "2026-10-20",
      closedBy: "run_0f3c",
    });
  });
  it("null section, absent field (pre-release), absent node → null; unwritten fields null, evidence []", () => {
    expect(outcomeFor(S, "docs/EPIC-907-open.md")).toBeNull();
    const { outcome: _o, ...noField } = S.nodes[0];
    expect(outcomeFor({ ...S, nodes: [noField] }, EPIC6)).toBeNull();
    expect(outcomeFor(S, "docs/nope.md")).toBeNull();
    const partial = { ...S, nodes: [{ ...S.nodes[0], outcome: { verdict: "superseded", sentence: null, evidence: null } }] } as SpinesJson;
    expect(outcomeFor(partial, `./${EPIC6}`)).toEqual({ verdict: "superseded", sentence: null, evidence: [], risk: null, closedAt: null, closedBy: null });
  });
});

describe("Current State (console contract #latest-state)", () => {
  it("spines.py current_state → camelCase; null section → null; field absent (pre-release) → undefined", () => {
    expect(currentStateFor(S, "docs/EPIC-907-open.md")).toEqual({
      status: "active",
      lastAttempted: "2026-10-20 timeline built (3e563d0)",
      result: "card renders",
      evidence: "PR #14, 3e563d0",
      waitingOn: "Sam's approval of the card copy",
      nextAction: "Sam reviews the card",
      verifiedAt: "2026-10-20",
      source: "spines",
    });
    expect(currentStateFor(S, EPIC6)).toBeUndefined();
    expect(currentStateFor({ ...S, nodes: [{ ...S.nodes[1], current_state: null }] }, "docs/EPIC-907-open.md")).toBeNull();
    expect(camelState({ status: "", result: "x" }, "spines")).toMatchObject({ status: null, result: "x", evidence: null });
  });
  it("markdown fallback maps the same keys; Last attempted wins, else the newest Last/Latest line", () => {
    const md = fs.readFileSync(path.join(FIX, "EPIC-906-outcome.md"), "utf8");
    expect(parseDoc(md).state).toEqual({
      status: "done",
      lastAttempted: "closed with an Outcome.",
      result: "verdict accomplished",
      evidence: "0891cbb",
      waitingOn: "none",
      nextAction: "none",
      verifiedAt: "2026-10-20",
      source: "markdown",
    });
    expect(rawCurrentState(["Last: old", "Last attempted: tried X", "Next: Y"])).toMatchObject({ last_attempted: "tried X", next_action: "Y", evidence: null });
    expect(parseDoc("# x\n\nStatus: active\n").state).toBeUndefined();
  });
});

describe("deriveVerdict fallback", () => {
  const dod = (done: number, total: number) => ({ done, total });
  it("outcome.verdict wins over everything", () => {
    expect(deriveVerdict({ outcome: { verdict: "partially accomplished", closedBy: "Sam (console)" } as any, status: "blocked", parked: true, redDots: 3 })).toEqual({
      word: "partially accomplished",
      source: "outcome",
    });
    // an agent-written Verdict (Closed by a run, Status not done) is no mark.
    expect(deriveVerdict({ outcome: { verdict: "accomplished", closedBy: "run_d6cad26e" } as any, status: "active" })).toEqual({ word: "accomplished?", source: "derived", note: AGENT_VERDICT });
  });
  it("done + every Done means ticked → accomplished? (unconfirmed); doctrine Done means preferred over DoD", () => {
    expect(deriveVerdict({ outcome: null, status: "done", dod: dod(2, 2) })).toEqual({ word: "accomplished?", source: "derived", note: UNCONFIRMED });
    expect(deriveVerdict({ status: "done", dod: dod(2, 2), doneMeans: [{ done: true }, { done: false }] }).word).toBe("in progress");
    expect(deriveVerdict({ status: "done", dod: dod(1, 2) }).word).toBe("in progress");
    expect(deriveVerdict({ status: "done", dod: { done: 0, total: 3, tracked: false } }).word).toBe("in progress");
    expect(deriveVerdict({ status: "active", dod: dod(2, 2) }).word).toBe("in progress");
  });
  it("then parked, then blocked on Sam (red dots only: E913-S4 text naming Sam is not red), else in progress", () => {
    expect(deriveVerdict({ status: "active", parked: true, redDots: 1 }).word).toBe("parked");
    expect(deriveVerdict({ status: "blocked", blockedReason: "waiting on Sam's approval" }).word).toBe("in progress");
    expect(deriveVerdict({ status: "blocked", blockedReason: "CI flaky" }).word).toBe("in progress");
    expect(deriveVerdict({ status: "active", redDots: 2 }).word).toBe("blocked on Sam");
    expect(deriveVerdict({ status: "superseded" }).word).toBe("superseded");
  });
});

describe("runCommitsLookup (temp git repo)", () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const commit = (file: string, msg: string, at: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.appendFileSync(path.join(dir, file), msg + "\n");
    git("add", ".");
    execFileSync("git", ["-C", dir, "commit", "-qm", msg], {
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-commits-"));
    git("init", "-q");
    commit("docs/EPIC-906.md", "before the run", "2026-10-20T09:00:00Z");
    commit("docs/EPIC-906.md", "spine: tick E6-1 | evidence\n\nbody\n\nRun: c1\nCo-Authored-By: x <x@x>", "2026-10-20T10:05:00Z");
    commit("src/app.ts", "code, not spine", "2026-10-20T10:06:00Z");
    commit("docs/outcome/notes.md", "linked page", "2026-10-20T10:07:00Z");
    commit("docs/EPIC-906.md", "after the run", "2026-10-20T12:00:00Z");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const wake = { id: "w1", startedAt: "2026-10-20T10:00:00Z", endedAt: "2026-10-20T11:00:00Z" };
  const child = { id: "c1", parentRunId: "w1", startedAt: "2026-10-20T10:01:00Z", summary: "E6-9 unrelated" };

  it("one log over the milestone window: spine + linked-dir commits only; Run trailer wins; subjects keep their pipes", async () => {
    const out = await runCommitsLookup()(dir, ["docs/EPIC-906.md", "docs/outcome"], [wake, child]);
    expect(Object.keys(out).sort()).toEqual(["c1", "w1"]);
    expect(out.c1.map((x) => x.subject)).toEqual(["spine: tick E6-1 | evidence"]);
    expect(out.w1.map((x) => x.subject)).toEqual(["linked page"]);
    expect(out.w1[0].sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(Date.parse(out.w1[0].at)).toBe(Date.parse("2026-10-20T10:07:00Z"));
  });

  it("open wake → until now; capped per run; ended window cached; failure → {}", async () => {
    let calls = 0;
    const look = runCommitsLookup(async (d, a) => (calls++, gitLog(d, a)), { cap: 2 });
    const open = await look(dir, ["docs"], [{ id: "w0", startedAt: "2026-10-20T08:00:00Z" }]);
    expect(open.w0.map((x) => x.subject)).toEqual(["after the run", "linked page"]);
    const ended = [{ id: "w0", startedAt: "2026-10-20T08:00:00Z", endedAt: "2026-10-20T09:30:00Z" }];
    await look(dir, ["docs"], ended);
    await look(dir, ["docs"], ended);
    expect(calls).toBe(2);
    expect(await look("/nonexistent-repo", ["docs"], ended)).toEqual({});
    expect(await look(dir, [], ended)).toEqual({});
    expect(await look(dir, ["docs"], [])).toEqual({});
  });

  it("parseCommits drops junk records; reads Run trailers", () => {
    expect(parseCommits("\x1eabc1234\x1fa | b\x1f2026-10-20T10:00:00Z\x1fr1,r2\n\x1enot a commit\n\n")).toEqual([
      { sha: "abc1234", subject: "a | b", at: "2026-10-20T10:00:00Z", runIds: ["r1", "r2"] },
    ]);
  });
});

describe("run commit attribution (M2-28, fake git log)", () => {
  const rec = (sha: string, subject: string, at: string, run = "") => `\x1e${sha}\x1f${subject}\x1f${at}\x1f${run}\n`;
  //-like wake: parent W ended 10:30; children N10-4 (closed 10:20), N10-5 and N10-6 never closed; a later wake W2.
  const runs: CommitRun[] = [
    { id: "W", startedAt: "2026-10-20T10:00:00Z", endedAt: "2026-10-20T10:30:00Z", summary: "EPIC-910 wake" },
    { id: "C4", parentRunId: "W", startedAt: "2026-10-20T10:02:00Z", endedAt: "2026-10-20T10:20:00Z", summary: "N10-4 docs worker" },
    { id: "C5", parentRunId: "W", startedAt: "2026-10-20T10:03:00Z", summary: "N10-5 memo-mt patch" },
    { id: "C6", parentRunId: "W", startedAt: "2026-10-20T10:04:00Z", summary: "N10-6 agent-part worker" },
    { id: "W2", startedAt: "2026-10-20T11:00:00Z", endedAt: "2026-10-20T11:10:00Z", summary: "EPIC-910 wake" },
  ];
  const log = [
    rec("a000001", "EPIC-910: N10-5 follow-up", "2026-10-20T11:05:00Z"), // C5's window stops at W's end → W2
    rec("a000002", "EPIC-910 N10-5: memo-mt patched", "2026-10-20T10:25:00Z"), // ticket → C5
    rec("a000003", "spine: tidy | notes", "2026-10-20T10:20:00Z", "C4"), // trailer → C4
    rec("a000004", "EPIC-910: N10-6 agent-part worker dispatched", "2026-10-20T10:15:00Z"), // manager commit, ticket → C6
    rec("a000005", "EPIC-910: state update", "2026-10-20T10:10:00Z"), // no match → W
    rec("a000006", "N10-4 done", "2026-10-20T10:08:00Z", "not-a-run-here"), // unknown trailer → ticket → C4
    rec("a000007", "misc", "2026-10-20T10:06:00Z", "C6"), // trailer → C6
    rec("a000008", "N10-60 other ticket", "2026-10-20T10:05:00Z"), // N10-6 is not a token of N10-60 → W
    rec("a000009", "outside every run", "2026-10-20T09:00:00Z"), // nowhere
  ].join("");
  const NOW = Date.parse("2026-10-20T12:00:00Z");

  it("each commit lands on exactly one run; children no longer share the wake's commits", async () => {
    const calls: string[][] = [];
    const fake: GitLog = async (_d, args) => (calls.push(args), log);
    const out = await runCommitsLookup(fake, { now: () => NOW })("/repo", ["docs/EPIC-910.md"], runs);
    const shas = (id: string) => (out[id] ?? []).map((c) => c.sha);
    expect(shas("C4")).toEqual(["a000003", "a000006"]);
    expect(shas("C5")).toEqual(["a000002"]);
    expect(shas("C6")).toEqual(["a000004", "a000007"]);
    expect(shas("W")).toEqual(["a000005", "a000008"]);
    expect(shas("W2")).toEqual(["a000001"]);
    const all = Object.values(out).flat().map((c) => c.sha);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(8);
    // one query for the whole milestone, window = earliest start.. latest effective end
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--since=2026-10-20T10:00:00.000Z");
    expect(calls[0]).toContain("--until=2026-10-20T11:10:00.000Z");
    expect(calls[0].slice(-2)).toEqual(["--", "docs/EPIC-910.md"]);
  });

  it("open wake → until now, cached 30 s; unclosed child of an open wake stays open", async () => {
    let calls = 0;
    let t = NOW;
    const fake: GitLog = async (_d, args) => (calls++, expect(args).toContain(`--until=${new Date(t).toISOString()}`), log);
    const live = [{ ...runs[0], endedAt: undefined }, runs[2]];
    const look = runCommitsLookup(fake, { now: () => t });
    const out = await look("/repo", ["docs"], live);
    expect(out.C5.map((c) => c.sha)).toEqual(["a000001", "a000002"]); // C5 runs to now while W is open
    await look("/repo", ["docs"], live);
    expect(calls).toBe(1);
    t += 31_000;
    await look("/repo", ["docs"], live);
    expect(calls).toBe(2);
  });

  it("ticketId takes the first id token; unclosedChild needs an ended parent", () => {
    expect(ticketId("N10-6 agent-part worker")).toBe("N10-6");
    expect(ticketId("worker for M2-28 and E4-3")).toBe("M2-28");
    expect(ticketId("E4-3-1: sub")).toBe("E4-3-1");
    expect(ticketId("no ticket here")).toBeUndefined();
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(unclosedChild(runs[2], byId)).toBe(true);
    expect(unclosedChild(runs[1], byId)).toBe(false);
    expect(unclosedChild({ ...runs[2], parentRunId: "gone" }, byId)).toBe(false);
  });
});

describe("GET /api/milestones outcome + verdict", () => {
  let fx: ReturnType<typeof makeFixtureRoot>;
  let dbDir: string;
  let db: DB;
  beforeEach(() => {
    fx = makeFixtureRoot();
    fx.write("epicspine-skill/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/epicspine-skill.git\n`);
    fx.write(`epicspine-skill/${EPIC6}`, fs.readFileSync(path.join(FIX, "EPIC-906-outcome.md"), "utf8"));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-outcome-db-"));
    db = openDb(path.join(dbDir, "c.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fx.cleanup();
  });
  const appWith = (spines?: SpinesRunner) => {
    const cfg: ReadConfig = { reposRoot: fx.root, seatsFile: path.join(fx.root, "seats.json"), listThreads: async () => [], spines };
    return createApp(db, { read: cfg });
  };
  const req = async (app: ReturnType<typeof createApp>, method: string, url: string, body?: unknown) =>
    (await app.request(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })).json();

  it("passes the outcome through with its verdict; list carries the verdict too", async () => {
    const app = appWith(fixtureRunner(OUTCOME_FILE));
    const created = await req(app, "POST", "/api/milestones", { title: "m", repo: "Acme/epicspine-skill", path: EPIC6, owner: "Sam" });
    const m = await req(app, "GET", `/api/milestones/${created.id}`);
    expect(m.outcome).toEqual(outcomeFor(S, EPIC6));
    expect(m.verdict).toEqual({ word: "accomplished", source: "outcome" });
    expect(m.remote).toBe("Acme/epicspine-skill");
    const [listed] = await req(app, "GET", "/api/milestones");
    expect(listed.verdict.word).toBe("accomplished");
    expect(listed.doctrine).toBeUndefined();
    expect(m.state.source).toBe("markdown"); // node has no current_state field → own parse
  });

  it("state from spines.py current_state when the node carries it", async () => {
    fx.write("epicspine-skill/docs/EPIC-907-open.md", "# EPIC-907: Open\n\n## Current State\n\nStatus: active\nLast attempted: markdown says otherwise\n");
    const app = appWith(fixtureRunner(OUTCOME_FILE));
    const created = await req(app, "POST", "/api/milestones", { title: "m", repo: "Acme/epicspine-skill", path: "docs/EPIC-907-open.md", owner: "Sam" });
    const m = await req(app, "GET", `/api/milestones/${created.id}`);
    expect(m.state).toMatchObject({ source: "spines", lastAttempted: "2026-10-20 timeline built (3e563d0)", evidence: "PR #14, 3e563d0" });
    expect(m.outcome).toBeNull();
    const noRunner = await req(appWith(undefined), "GET", `/api/milestones/${created.id}`);
    expect(noRunner.state).toMatchObject({ source: "markdown", lastAttempted: "markdown says otherwise", verifiedAt: null });
  });

  it("no outcome field (spines.py before the release, or no runner): accomplished? from Status done + all ticked", async () => {
    const app = appWith(undefined);
    const created = await req(app, "POST", "/api/milestones", { title: "m", repo: "Acme/epicspine-skill", path: EPIC6, owner: "Sam" });
    expect(created.outcome).toBeNull();
    expect(created.verdict).toEqual({ word: "accomplished?", source: "derived", note: UNCONFIRMED });
    const unreadable = await req(app, "POST", "/api/milestones", { title: "x", repo: "nope", path: EPIC6, owner: "Sam" });
    expect(unreadable).toMatchObject({ outcome: null, verdict: { word: "in progress" } });
  });

  it("parked (M2-11 parkedAt on an assignment) when there is no outcome and the spine is not done", async () => {
    fx.write("epicspine-skill/docs/EPIC-907-open.md", "# EPIC-907: Open\n\n## Current State\n\nStatus: active\n");
    const app = appWith(undefined);
    const m = await req(app, "POST", "/api/milestones", { title: "m", repo: "Acme/epicspine-skill", path: "docs/EPIC-907-open.md", owner: "Sam" });
    expect(m.verdict.word).toBe("in progress");
    const p = await req(app, "POST", "/api/personas", { name: "p", remit: "r", skills: [], model: "opus" });
    const a = await req(app, "POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } });
    createStore(db).updateAssignment(a.id, { enabled: false, parkedAt: "2026-10-20T10:00:00Z", parkedReason: "nothing actionable" });
    expect((await req(app, "GET", `/api/milestones/${m.id}`)).verdict).toEqual({ word: "parked", source: "derived" });
  });

  it("run-commits: empty object when the checkout is no git repo (failures hidden)", async () => {
    const app = appWith(fixtureRunner(OUTCOME_FILE));
    const created = await req(app, "POST", "/api/milestones", { title: "m", repo: "Acme/epicspine-skill", path: EPIC6, owner: "Sam" });
    expect(await req(app, "GET", `/api/milestones/${created.id}/run-commits`)).toEqual({});
  });
});
