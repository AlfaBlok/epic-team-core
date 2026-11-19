import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore, type Run } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { CADENCE_SKIP_MAX_AGE_MS, cadenceSkipDecision, seatFreedNews } from "../src/cycle/skipUnchanged.js";
import { wokeBecause, type WakeParts } from "../src/cycle/wakeWhy.js";
import { WASTED_ALARM, isWastedWake, wakeStats } from "../src/cycle/wakeStats.js";

/**
 * (a) a freed seat is news only when the last real wake did not end blocked; (b) the cadence skip max age is
 * 24 h; (d) a real console-started wake that ended monitoring/blocked with the same fingerprint at its end as at its
 * start is "wasted", counted per assignment per UTC day (GET /api/wake-stats), flagged above WASTED_ALARM a day.
 */
class FakeT3 implements T3Client {
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { return { threadId: "t" }; }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((f) => f());
  cleanups = [];
});

const node = (id: string, p: string, extra: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key: `k/${id}`, id, kind: "spine", title: id, status: "active", color: "grey", path: p, children, flags: [], ...extra,
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s30-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  const spine = path.join(repo, "docs/epic.md");
  fs.writeFileSync(spine, "# EPIC\n## Current State\nNext action: S2\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const state = { ready: ["S2"] as string[], available: 0 };
  const treeFor = async (): Promise<Tree> => ({
    milestoneId: "m",
    root: node("PLAN-1", "docs/epic.md", {}, ["S2", "S3"].map((id) => node(id, "", { kind: "ticket", ...(state.ready.includes(id) ? { ready: true } : {}) }))),
    counts: { grey: 3, blue: 0, yellow: 0, red: 0, green: 0 },
    nonGreen: 3, closed: 0, flagged: 0, source: "spines", warnings: [],
  });
  const disp = {
    async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; },
    async done() {},
    async status() { return { name: "pool", capacity: 2, available: state.available }; },
  };
  const cycle = createCycle(db, store, { enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo });
  const app = createApp(db, { cycle: { enabled: false, publicUrl: "http://x" } });
  cleanups.push(() => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery Manager", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 30 }, enabled: true });
  const newest = () => store.listRuns({ assignmentId: a.id }).find((r) => !r.parentRunId)!;
  const cadence = async () => {
    const w = await cycle.wake(a.id, { threadId: "home", seat: "seat1" });
    return { ...w, real: w.run?.outcome === "running" };
  };
  const finish = async (outcome: "blocked" | "monitoring" | "idle" | "progressed", edit?: string) => {
    const r = newest();
    if (edit) fs.appendFileSync(spine, edit); // the wake's own spine change (not bookkeeping)
    store.updateRun(r.id, { outcome, endedAt: new Date(Date.now() + 1).toISOString() });
    cycle.runEnded(r.id);
    await cycle.settled();
    return store.getRun(r.id)!;
  };
  return { db, store, cycle, app, state, a, cadence, finish };
}

describe("T8-S30 (a) a freed seat after a blocked wake is no news", () => {
  it("blocked DM, ready rows starved of a seat, a seat frees: still skips (live 21:50Z case)", async () => {
    const t = setup();
    await t.cadence();
    const r1 = await t.finish("blocked");
    expect(r1.wakeParts!.ready).toMatch(/^2:/);
    t.state.available = 1;
    expect(await t.cycle.wakeCheck(t.a.id)).toMatchObject({ wouldSkip: true });
    expect((await t.cadence()).real).toBe(false);
    // a new ready row is still news after a blocked end
    t.state.ready = ["S2", "S3"];
    const w = await t.cadence();
    expect(w.real).toBe(true);
    expect(w.run!.wokeBecause).toBe("ready rows nobody is on + a free seat (S2, S3)");
  });

  it("idle / progressed / monitoring ends keep the seat-freed rule", async () => {
    for (const outcome of ["idle", "progressed", "monitoring"] as const) {
      const t = setup();
      await t.cadence();
      await t.finish(outcome);
      t.state.available = 1;
      expect(await t.cycle.wakeCheck(t.a.id)).toMatchObject({ wouldSkip: false, why: "a seat freed for ready rows (S2)" });
    }
  });

  it("pure rules: seatFreedNews, cadenceSkipDecision and wokeBecause agree", () => {
    const P: WakeParts = { spines: "s", prompt: "p", answer: "", running: "r", ready: "2:abc", data: "", rollup: "", news: "" };
    const run = (outcome: string) => ({ id: "r", assignmentId: "a", startedAt: "2026-10-31T21:01:00Z", endedAt: "2026-10-31T21:10:00Z", outcome, summary: "x", kind: "wake", askFingerprint: "f", wakeParts: P }) as Run;
    const now = Date.parse("2026-10-31T21:50:00Z");
    expect(seatFreedNews(run("blocked"), "1:abc")).toBe(false);
    expect(seatFreedNews(run("idle"), "1:abc")).toBe(true);
    expect(seatFreedNews(undefined, "1:abc")).toBe(false);
    expect(cadenceSkipDecision([run("blocked")], "f", CADENCE_SKIP_MAX_AGE_MS, now, "1:abc")).toMatchObject({ skip: true });
    expect(cadenceSkipDecision([run("monitoring")], "f", CADENCE_SKIP_MAX_AGE_MS, now, "1:abc")).toEqual({ skip: false });
    expect(wokeBecause([run("blocked")], { ...P, ready: "1:abc" }, "f", { now, readyIds: ["S2"] })).toBe("nothing changed (skip not applied)");
    expect(wokeBecause([run("idle")], { ...P, ready: "1:abc" }, "f", { now, readyIds: ["S2"] })).toBe("a seat freed for ready rows (S2)");
  });
});

describe("T8-S30 (b) max age 24 h", () => {
  it("CADENCE_SKIP_MAX_AGE_MS is 24 h: 23 h after the last real wake still skips, 24 h does not", () => {
    expect(CADENCE_SKIP_MAX_AGE_MS).toBe(24 * 3_600_000);
    const r = { id: "r", assignmentId: "a", startedAt: "2026-10-30T10:00:00Z", endedAt: "2026-10-30T10:05:00Z", outcome: "blocked", summary: "x", kind: "wake", askFingerprint: "f" } as Run;
    expect(cadenceSkipDecision([r], "f", undefined, Date.parse("2026-10-31T09:00:00Z"))).toMatchObject({ skip: true });
    expect(cadenceSkipDecision([r], "f", undefined, Date.parse("2026-10-31T10:00:00Z"))).toEqual({ skip: false });
  });
});

describe("T8-S30 (d) wasted wakes", () => {
  it("a cadence wake that ended blocked with nothing changed is wasted; one that edited its spine is not", async () => {
    const t = setup();
    await t.cadence();
    const r1 = await t.finish("blocked");
    expect(r1.startFingerprint).toBeTruthy();
    expect(r1.startFingerprint).toBe(r1.askFingerprint);
    expect(isWastedWake(r1)).toBe(true);

    t.state.ready = ["S2", "S3"]; // news: a real wake
    expect((await t.cadence()).real).toBe(true);
    const r2 = await t.finish("monitoring", "\nDecision: S3 waits on T8-A9\n");
    expect(r2.startFingerprint).not.toBe(r2.askFingerprint);
    expect(isWastedWake(r2)).toBe(false);

    const res = await t.app.request("/api/wake-stats?days=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alarmAbove).toBe(WASTED_ALARM);
    expect(body.rows).toMatchObject([{ assignmentId: t.a.id, persona: "Delivery Manager", real: 2, auto: 2, wasted: 1, wastedRunIds: [r1.id], alarm: false }]);
    expect(body.alarms).toEqual([]);
    expect((await t.app.request("/api/wake-stats?days=0")).status).toBe(400);
  });

  it("Run now (no wokeBecause), skips, progressed/idle ends and wakes without a start stamp are never wasted", () => {
    const base = { id: "r", assignmentId: "a", startedAt: "2026-10-31T10:00:00Z", kind: "wake", askFingerprint: "f", startFingerprint: "f", wokeBecause: "spines changed", outcome: "blocked", summary: "blocked" } as Run;
    expect(isWastedWake(base)).toBe(true);
    expect(isWastedWake({ ...base, outcome: "monitoring" })).toBe(true);
    expect(isWastedWake({ ...base, wokeBecause: undefined })).toBe(false);
    expect(isWastedWake({ ...base, outcome: "progressed" })).toBe(false);
    expect(isWastedWake({ ...base, outcome: "idle" })).toBe(false);
    expect(isWastedWake({ ...base, startFingerprint: undefined })).toBe(false);
    expect(isWastedWake({ ...base, summary: "skipped: nothing new since r0" })).toBe(false);
    expect(isWastedWake({ ...base, parentRunId: "p" })).toBe(false);
  });

  it("more than 4 wasted wakes in a UTC day raise the alarm; days are UTC", () => {
    const t = setup();
    const wasted = (startedAt: string) => {
      const r = t.store.createRun({ assignmentId: t.a.id, startedAt, outcome: "blocked", endedAt: startedAt, summary: "blocked", askFingerprint: "f" });
      t.store.updateRun(r.id, { startFingerprint: "f", wokeBecause: "a child run ended" });
    };
    for (let h = 1; h <= 5; h++) wasted(`2026-10-31T0${h}:00:00Z`);
    wasted("2026-10-30T23:30:00Z"); // yesterday (UTC)
    t.store.createRun({ assignmentId: t.a.id, startedAt: "2026-10-31T07:00:00Z", outcome: "idle", endedAt: "2026-10-31T07:00:00Z", summary: "skipped: nothing new since x", askFingerprint: "f" });
    const now = Date.parse("2026-10-31T22:00:00Z");
    const one = wakeStats(t.store, { now });
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]).toMatchObject({ day: "2026-10-31", real: 5, wasted: 5, skipped: 1, alarm: true });
    expect(one.alarms).toHaveLength(1);
    const two = wakeStats(t.store, { now, days: 2 });
    expect(two.rows.map((r) => [r.day, r.wasted, r.alarm])).toEqual([["2026-10-31", 5, true], ["2026-10-30", 1, false]]);
  });
});
