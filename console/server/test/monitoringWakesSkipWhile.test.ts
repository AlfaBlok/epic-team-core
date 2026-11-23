import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { releaseHeld } from "../src/cycle/held.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { CADENCE_SKIP_MAX_AGE_MS, cadenceSkipDecision } from "../src/cycle/skipUnchanged.js";
import { nextRunAfter } from "../src/cycle/nextRun.js";
import { cadenceAfterTimedWake, timedCheckReplaces } from "../src/cycle/timedCheck.js";

/**
 * the cadence skip also applies after a `monitoring` wake while its nextCheckAt is not due, and a timed check
 * that falls due replaces that hour's cadence wake (never two wakes).
 */
class FakeT3 implements T3Client {
  calls: string[] = [];
  private n = 0;
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() { this.calls.push("runScheduledTaskNow"); }
  async launchThread() { this.calls.push("launchThread"); return { threadId: `thread_${++this.n}` }; }
  async sendToThread() { this.calls.push("sendToThread"); }
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const MIN = 60_000;
const node = (id: string, p: string, children: TreeNode[] = []): TreeNode => ({
  key: id, id, kind: "spine", title: id, status: "active", color: "grey", path: p, children, flags: [],
});

function setup(extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s22-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/epic.md"), "# EPIC\n## Current State\nNext action: S2\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const treeFor = async (): Promise<Tree> => ({
    milestoneId: "m",
    root: node("PLAN-1", "docs/epic.md", [node("S1", "docs/epic.md")]),
    counts: { grey: 2, blue: 0, yellow: 0, red: 0, green: 0 },
    nonGreen: 2, closed: 0, flagged: 0, source: "spines", warnings: [],
  });
  const disp = {
    async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; },
    async done() {},
    async status() { return { name: "pool", capacity: 2, available: 0 }; },
  };
  const t3 = new FakeT3();
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo, ...extra });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Responder", remit: "reply", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const due = () => store.updateAssignment(a.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  const top = () => store.listRuns({ assignmentId: a.id }).filter((r) => !r.parentRunId);
  const realWakes = () => top().filter((r) => !r.summary.startsWith("skipped:") && r.kind === "wake");
  /** The woken persona: the stub's /wake claims the run; it then finishes (run-end hook stamps the baseline). */
  const persona = async (end: { outcome: "idle" | "monitoring"; nextCheckAt?: string; heldOn?: string } = { outcome: "idle" }) => {
    const w = await cycle.wake(a.id, { threadId: "thread_1" });
    store.updateRun(w.run!.id, { ...end, endedAt: new Date(Date.now() + 1).toISOString() } as never);
    cycle.runEnded(w.run!.id);
    await cycle.settled();
    return w;
  };
  return { db, store, cycle, t3, m, p, a, due, top, realWakes, persona };
}

describe("T8-S22 monitoring wakes skip while the next check is not due", () => {
  it("monitoring + unchanged fingerprint + nextCheckAt hours away: the cadence wake is skipped with a run-log line", async () => {
    const t = setup();
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
    const w = await t.persona({ outcome: "monitoring", nextCheckAt: new Date(Date.now() + 3 * 60 * MIN).toISOString() });
    t.t3.calls = [];
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    expect(t.top()[0]).toMatchObject({ outcome: "idle", summary: `skipped: nothing new since ${w.run!.id}` });
  });

  it("a timed check due within the hour replaces the cadence wake: exactly one wake that hour, cadence moved a full interval on", async () => {
    const t = setup();
    t.due();
    await t.cycle.tickCadence();
    const check = new Date(Date.now() + 20 * MIN).toISOString();
    const w1 = await t.persona({ outcome: "monitoring", nextCheckAt: check });
    expect(t.store.getAssignment(t.a.id)!.retryAt).toBe(check);
    const before = t.realWakes().length;
    t.t3.calls = [];

    t.due(); // this hour's cadence wake
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    expect(t.top()[0].summary).toBe(`skipped: timed check at ${check} (requested by run ${w1.run!.id}) replaces this cadence wake`);

    const at = new Date(Date.parse(check) + 1000); // the check falls due
    expect(await t.cycle.tickRetry(at)).toEqual([t.a.id]);
    expect(t.top()[0].summary).toMatch(/^Timed wake \(retryAt /);
    expect(Date.parse(t.store.getAssignment(t.a.id)!.nextRunAt!)).toBeGreaterThanOrEqual(at.getTime() + 60 * MIN);
    await t.persona({ outcome: "idle" });
    // rest of the hour: no cadence wake is due, no timed check pending
    expect(await t.cycle.tickCadence(new Date(at.getTime() + 30 * MIN))).toEqual([]);
    expect(await t.cycle.tickRetry(new Date(at.getTime() + 30 * MIN))).toEqual([]);
    expect(t.realWakes().length - before).toBe(1);
  });

  it("a due timed check at cadence time: the cadence gives way and the retry tick wakes once", async () => {
    const t = setup();
    t.due();
    await t.cycle.tickCadence();
    await t.persona({ outcome: "idle" });
    t.store.updateAssignment(t.a.id, { retryAt: new Date(Date.now() - 1000).toISOString() });
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(await t.cycle.tickRetry()).toEqual([t.a.id]);
    expect(t.top().filter((r) => r.outcome === "running")).toHaveLength(1);
  });

  it("a Publisher's cadence wake never gives way to its timed check (its cadence is the catch-up pace), and covers it", async () => {
    const t = setup({ wakeGate: async () => ({ work: true, why: "scheduled P-1 (slot 2026-11-23T02:00:00Z) due" }) });
    t.store.updatePersona(t.p.id, { name: "Publisher", remit: "post each scheduled item in its slot", skipUnchanged: true });
    t.due();
    await t.cycle.tickCadence();
    await t.persona({ outcome: "idle" });
    t.store.updateAssignment(t.a.id, { retryAt: new Date(Date.now() + 20 * MIN).toISOString(), retryRunId: null });
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
    expect(t.top()[0].summary).not.toMatch(/replaces this cadence wake/);
    expect(t.store.getAssignment(t.a.id)!.retryAt ?? null).toBeNull();
  });

  it("a check further than the hour away does not hold the cadence wake back (it wakes or fp-skips as usual)", async () => {
    const t = setup();
    t.due();
    await t.cycle.tickCadence();
    await t.persona({ outcome: "idle" });
    t.store.createRun({ assignmentId: t.a.id, parentRunId: t.top()[0].id, outcome: "progressed", summary: "w", endedAt: new Date(Date.now() + 5).toISOString() });
    t.store.updateAssignment(t.a.id, { retryAt: new Date(Date.now() + 90 * MIN).toISOString() });
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
  });

  it("Run now and an answer's wake (Run now with instructions) still wake after a monitoring skip", async () => {
    const t = setup();
    t.due();
    await t.cycle.tickCadence();
    await t.persona({ outcome: "monitoring", nextCheckAt: new Date(Date.now() + 3 * 60 * MIN).toISOString() });
    t.due();
    await t.cycle.tickCadence();
    expect(t.top()[0].summary).toMatch(/^skipped: nothing new since /);
    await t.cycle.runNow(t.a.id);
    expect((await t.persona({ outcome: "monitoring", nextCheckAt: new Date(Date.now() + 3 * 60 * MIN).toISOString() })).run!.outcome).toBe("running");
    await t.cycle.runNow(t.a.id, { instructions: "Sam answered T0-A1: yes" });
    const w = await t.cycle.wake(t.a.id, { threadId: "thread_1" });
    expect(w.run).toMatchObject({ outcome: "running", instructions: "Sam answered T0-A1: yes" });
  });

  it("M5-B4 held wake: an egress coming online still wakes the held persona once", async () => {
    const t = setup();
    t.due();
    await t.cycle.tickCadence();
    await t.persona({ outcome: "monitoring", nextCheckAt: new Date(Date.now() + 6 * 60 * MIN).toISOString(), heldOn: "egress:laptop" });
    expect(releaseHeld(t.store, "laptop").woken).toHaveLength(1);
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([]); // gives way to the held wake
    expect(await t.cycle.tickRetry()).toEqual([t.a.id]);
  });
});

describe("T8-S22 cadenceSkipDecision / timedCheck", () => {
  const run = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, assignmentId: "a", startedAt: "2026-10-24T10:00:00Z", endedAt: "2026-10-24T10:05:00Z", outcome: "monitoring", summary: "woke", kind: "wake", askFingerprint: "f", ...extra }) as never;
  const now = Date.parse("2026-10-24T12:00:00Z");
  it("monitoring skips while its check is in the future, wakes once it is due; failed still never skips", () => {
    expect(cadenceSkipDecision([run("r", { nextCheckAt: "2026-10-24T15:00:00Z" })], "f", CADENCE_SKIP_MAX_AGE_MS, now)).toMatchObject({ skip: true, sourceRunId: "r" });
    expect(cadenceSkipDecision([run("r", { nextCheckAt: "2026-10-24T11:00:00Z" })], "f", CADENCE_SKIP_MAX_AGE_MS, now)).toEqual({ skip: false });
    expect(cadenceSkipDecision([run("r", { nextCheckAt: "2026-10-24T15:00:00Z" })], "g", CADENCE_SKIP_MAX_AGE_MS, now)).toEqual({ skip: false });
    expect(cadenceSkipDecision([run("r", { outcome: "failed" })], "f", CADENCE_SKIP_MAX_AGE_MS, now)).toEqual({ skip: false });
  });
  it("timedCheckReplaces: only a check due within the hour and before the next cadence fire", () => {
    const n = new Date(now);
    expect(timedCheckReplaces(undefined, new Date(now + 60 * MIN), n)).toBeUndefined();
    expect(timedCheckReplaces("2026-10-24T12:20:00.000Z", new Date(now + 60 * MIN), n)).toBe("2026-10-24T12:20:00.000Z");
    expect(timedCheckReplaces("2026-10-24T11:50:00.000Z", new Date(now + 60 * MIN), n)).toBe("2026-10-24T11:50:00.000Z");
    expect(timedCheckReplaces("2026-10-24T13:30:00.000Z", new Date(now + 120 * MIN), n)).toBeUndefined();
    expect(timedCheckReplaces("2026-10-24T12:40:00.000Z", new Date(now + 30 * MIN), n)).toBeUndefined();
    expect(timedCheckReplaces("2026-10-24T12:20:00.000Z", new Date(now + 60 * MIN), n, true)).toBeUndefined(); // a Publisher keeps its cadence
  });
  it("cadenceAfterTimedWake: interval moves a full interval on; fixed time keeps its slot", () => {
    const n = new Date(now);
    expect(cadenceAfterTimedWake({ type: "interval", everyMinutes: 60 }, "2026-10-24T12:30:00.000Z", n)).toBe("2026-10-24T13:00:00.000Z");
    expect(cadenceAfterTimedWake({ type: "interval", everyMinutes: 60 }, "2026-10-24T14:00:00.000Z", n)).toBeUndefined();
    const daily = { type: "fixed_time" as const, timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };
    expect(cadenceAfterTimedWake(daily, nextRunAfter(daily, n).toISOString(), n)).toBeUndefined();
  });
});
