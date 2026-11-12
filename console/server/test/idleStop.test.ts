import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createStore } from "../src/store.js";
import { migrateCycle } from "../src/cycle/service.js";
import { createIdleStopper } from "../src/cycle/idleStop.js";
import type { T3ChildThread, T3Client, T3ThreadRun, T3ThreadState } from "../src/t3/client.js";

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

class FakeT3 {
  threads = new Map<string, { status: string; runs?: T3ThreadRun[]; activeRunId?: string; raw?: Record<string, unknown> }>();
  children: T3ChildThread[] = [];
  queued = new Map<string, number>();
  settled: string[] = [];
  refuse = false;
  async readThreadStatus(id: string): Promise<T3ThreadState> {
    const t = this.threads.get(id);
    if (!t) throw new Error("no thread");
    return { status: t.status, runs: t.runs, activeRunId: t.activeRunId ?? null, raw: t.raw ?? {} };
  }
  async listChildThreads() {
    return this.children;
  }
  async queuedCount(id: string) {
    return this.queued.get(id) ?? 0;
  }
  async settleThread(id: string) {
    if (this.refuse) throw new Error(`t3_thread_organize: Thread ${id} is still running. Stop it before settling.`);
    this.settled.push(id);
    const t = this.threads.get(id);
    if (t) t.raw = { ...(t.raw ?? {}), settled: true };
  }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-idlestop-"));
  const db = openDb(path.join(dir, "console.db"));
  migrateCycle(db);
  const store = createStore(db);
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const m = store.createMilestone({ title: "M", repo: "r", path: "", owner: "J", paused: false });
  const p = store.createPersona({ name: "p", remit: "r", skills: [], model: "haiku", mayWrite: false });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } } as any);
  const main = new FakeT3();
  const worker = new FakeT3();
  let vps3Up = true;
  const logs: string[] = [];
  const stopper = createIdleStopper({
    db,
    clientFor: (h) => (h === "main" ? (main as unknown as T3Client) : vps3Up ? (worker as unknown as T3Client) : undefined),
    log: (l) => logs.push(l),
  });
  const link = (threadId: string, host = "main", assignmentId = a.id) => {
    db.prepare("INSERT OR IGNORE INTO cycle_assignment_link (assignment_id) VALUES (?)").run(assignmentId);
    db.prepare("UPDATE cycle_assignment_link SET thread_id = ?, host = ?, project_id = 'proj' WHERE assignment_id = ?").run(threadId, host, assignmentId);
  };
  const done = (endedMin: number): T3ThreadRun => ({ status: "completed", startedAt: ago((endedMin + 1) * MIN), completedAt: ago(endedMin * MIN) });
  return { db, store, a, m, p, main, worker, setVps3: (up: boolean) => (vps3Up = up), stopper, link, done, logs };
}

describe("T6-S57 idle stop", () => {
  it("settles a home thread whose wake ended and whose turn is done, once", async () => {
    const t = setup();
    t.link("home");
    t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", summary: "wake", threadId: "home", startedAt: ago(5 * MIN), endedAt: ago(2 * MIN) });
    t.main.threads.set("home", { status: "completed", runs: [t.done(2)] });
    expect((await t.stopper.tick()).map((s) => s.threadId)).toEqual(["home"]);
    expect(t.main.settled).toEqual(["home"]);
    expect(await t.stopper.tick()).toEqual([]); // not again after the same run
    expect(t.stopper.recent()[0]).toMatchObject({ threadId: "home", host: "main" });
  });

  it("waits a minute after the run ended", async () => {
    const t = setup();
    t.link("home");
    t.store.createRun({ assignmentId: t.a.id, outcome: "idle", summary: "wake", threadId: "home", startedAt: ago(2 * MIN), endedAt: ago(20_000) });
    t.main.threads.set("home", { status: "completed", runs: [t.done(0.3)] });
    expect(await t.stopper.tick()).toEqual([]);
  });

  it("never touches an open run, a live turn, a queued message or a live child thread", async () => {
    const t = setup();
    t.link("home");
    const r = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "wake", threadId: "home", startedAt: ago(5 * MIN) });
    t.main.threads.set("home", { status: "completed", runs: [t.done(2)] });
    expect(await t.stopper.tick()).toEqual([]);
    t.store.updateRun(r.id, { outcome: "progressed", endedAt: ago(2 * MIN) });
    // a delegated worker of that wake still runs
    const w = t.store.createRun({ assignmentId: t.a.id, parentRunId: r.id, outcome: "running", summary: "worker", threadId: "thread:delegated-task:x", startedAt: ago(4 * MIN) });
    expect(await t.stopper.tick()).toEqual([]);
    t.store.updateRun(w.id, { outcome: "progressed", endedAt: ago(2 * MIN) });
    t.main.threads.set("home", { status: "running", activeRunId: "t3run", runs: [{ status: "running", startedAt: ago(MIN), completedAt: null }, t.done(2)] });
    expect(await t.stopper.tick()).toEqual([]);
    t.main.threads.set("home", { status: "completed", runs: [t.done(2)] });
    t.main.queued.set("home", 1);
    expect(await t.stopper.tick()).toEqual([]);
    t.main.queued.clear();
    t.main.children = [{ threadId: "kid", status: "running" }];
    expect(await t.stopper.tick()).toEqual([]);
    t.main.children = [{ threadId: "kid", status: "completed" }];
    expect((await t.stopper.tick()).length).toBe(1);
  });

  it("waits 10 min of idleness when the thread had a turn after the wake ended (a hand-typed message, a worker result)", async () => {
    const t = setup();
    t.link("home");
    t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", summary: "wake", threadId: "home", startedAt: ago(30 * MIN), endedAt: ago(25 * MIN) });
    t.main.threads.set("home", { status: "completed", runs: [t.done(4), t.done(25)] });
    expect(await t.stopper.tick()).toEqual([]);
    t.main.threads.set("home", { status: "completed", runs: [t.done(11), t.done(25)] });
    expect((await t.stopper.tick()).length).toBe(1);
  });

  it("skips delegated worker threads, desks, ticket chats and handovers", async () => {
    const t = setup();
    t.link("thread:delegated-task:abc");
    t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", summary: "w", threadId: "thread:delegated-task:abc", startedAt: ago(9 * MIN), endedAt: ago(8 * MIN) });
    t.main.threads.set("thread:delegated-task:abc", { status: "completed", runs: [t.done(8)] });
    expect(await t.stopper.tick()).toEqual([]);
    t.link("desk-thread");
    t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", summary: "w", threadId: "desk-thread", startedAt: ago(7 * MIN), endedAt: ago(6 * MIN) });
    t.main.threads.set("desk-thread", { status: "completed", runs: [t.done(6)] });
    t.db.exec("CREATE TABLE IF NOT EXISTS desk_session (thread_id TEXT)");
    t.db.prepare("INSERT INTO desk_session (thread_id) VALUES (?)").run("desk-thread");
    expect(await t.stopper.tick()).toEqual([]);
    expect(t.main.settled).toEqual([]);
  });

  it("uses the thread's host, never starts an unreachable worker, and survives a refusal", async () => {
    const t = setup();
    t.link("v3", "worker");
    t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", summary: "wake", threadId: "v3", startedAt: ago(5 * MIN), endedAt: ago(2 * MIN) });
    t.worker.threads.set("v3", { status: "completed", runs: [t.done(2)] });
    t.setVps3(false);
    expect(await t.stopper.tick()).toEqual([]);
    t.setVps3(true);
    t.worker.refuse = true;
    expect(await t.stopper.tick()).toEqual([]);
    expect(t.logs.at(-1)).toMatch(/still running/);
    t.worker.refuse = false;
    expect((await t.stopper.tick()).map((s) => s.host)).toEqual(["worker"]);
    expect(t.main.settled).toEqual([]);
  });

  it("records a thread T3 already shows settled without settling it again, and settles after the next wake", async () => {
    const t = setup();
    t.link("home");
    t.store.createRun({ assignmentId: t.a.id, outcome: "idle", summary: "w1", threadId: "home", startedAt: ago(9 * MIN), endedAt: ago(8 * MIN) });
    t.main.threads.set("home", { status: "completed", runs: [t.done(8)], raw: { settled: true } });
    expect(await t.stopper.tick()).toEqual([]);
    t.store.createRun({ assignmentId: t.a.id, outcome: "idle", summary: "w2", threadId: "home", startedAt: ago(3 * MIN), endedAt: ago(2 * MIN) });
    t.main.threads.set("home", { status: "completed", runs: [t.done(2), t.done(8)], raw: { settled: false } });
    expect((await t.stopper.tick()).length).toBe(1);
    expect(t.main.settled).toEqual(["home"]);
  });
});
