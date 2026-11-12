import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { classifyRead } from "../src/cycle/reconcile.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client, T3ThreadRun, T3ThreadState } from "../src/t3/client.js";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const turn = (status: string, startMin: number, endMin?: number): T3ThreadRun => ({
  status,
  requestedAt: ago(startMin * MIN),
  startedAt: ago(startMin * MIN),
  completedAt: endMin === undefined ? null : ago(endMin * MIN),
});

class FakeT3 {
  threads = new Map<string, { status: string; runs?: T3ThreadRun[] }>();
  reads = 0;
  async readThreadStatus(id: string): Promise<T3ThreadState> {
    this.reads++;
    if (!this.threads.has(id)) throw new Error("no thread");
    return { ...this.threads.get(id)!, raw: {} };
  }
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
});

function seed(db: DB) {
  const store = createStore(db);
  const m = store.createMilestone({ title: "M", repo: "r", path: "", owner: "J", paused: false });
  const p = store.createPersona({ name: "p", remit: "r", skills: [], model: "haiku", mayWrite: false });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } } as any);
  return { store, a };
}

describe("T6-S10 classifyRead", () => {
  const start = ago(10 * MIN);
  it("live / completed / failed / unknown from the matched turn or the thread", () => {
    expect(classifyRead({ status: "running", runs: [turn("running", 11)], raw: {} }, start)).toMatchObject({ status: "live", detail: "running" });
    expect(classifyRead({ status: "completed", runs: [turn("completed", 11, 2)], raw: {} }, start)).toMatchObject({ status: "completed" });
    expect(classifyRead({ status: "failed", runs: [turn("failed", 11, 2)], raw: {} }, start)).toMatchObject({ status: "failed", detail: "failed" });
    expect(classifyRead({ status: "cancelled", runs: [turn("cancelled", 11, 2)], raw: {} }, start)).toMatchObject({ status: "failed", detail: "cancelled" });
    expect(classifyRead({ status: "running", raw: {} }, start)).toMatchObject({ status: "live" });
    expect(classifyRead(undefined, start)).toEqual({ status: "unknown", detail: "read failed" });
    expect(classifyRead({ status: "idle", runs: [], raw: {} }, start)).toMatchObject({ status: "unknown", detail: "no T3 turn yet" });
    expect(classifyRead({ status: "running", runs: [turn("running", 11)], raw: {} }, start).startedAt).toEqual(expect.any(String));
  });
});

describe("T6-S10 reconciler keeps the last T3 state per running run", () => {
  it("records live / unknown, forgets closed runs, never reads T3 itself", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-live-"));
    const db = openDb(path.join(dir, "console.db"));
    const { store, a } = seed(db);
    const t3 = new FakeT3();
    const cycle = createCycle(db, store, { enabled: true, t3: t3 as unknown as T3Client, publicUrl: "http://x" });
    cleanup = () => (cycle.stop(), db.close(), fs.rmSync(dir, { recursive: true, force: true }));
    const live = store.createRun({ assignmentId: a.id, outcome: "running", summary: "w", threadId: "live", startedAt: ago(10 * MIN) });
    const gone = store.createRun({ assignmentId: a.id, outcome: "running", summary: "w", threadId: "gone", startedAt: ago(10 * MIN) });
    const done = store.createRun({ assignmentId: a.id, outcome: "running", summary: "w", threadId: "done", startedAt: ago(10 * MIN) });
    const bare = store.createRun({ assignmentId: a.id, outcome: "running", summary: "w", startedAt: ago(1 * MIN) });
    t3.threads.set("live", { status: "running", runs: [turn("running", 9)] });
    t3.threads.set("done", { status: "completed", runs: [turn("completed", 9, 1)] });
    expect(cycle.runT3State(live.id)).toBeUndefined();
    await cycle.reconcile();
    const st = cycle.runT3State(live.id)!;
    expect(st).toMatchObject({ status: "live", detail: "running", startedAt: expect.any(String) });
    expect(Date.now() - Date.parse(st.checkedAt)).toBeLessThan(5_000);
    expect(cycle.runT3State(gone.id)).toMatchObject({ status: "unknown", detail: expect.stringMatching(/^thread unreadable since \d\d:\d\dZ \(1 read failed\)$/) } /* */);
    expect(store.getRun(done.id)!.outcome).toBe("blank_report");
    expect(cycle.runT3State(done.id)).toBeUndefined(); // closed: the OutcomeBadge takes over
    expect(cycle.runT3State(bare.id)).toBeUndefined(); // no thread: the web shows status unknown
    const reads = t3.reads;
    cycle.runT3State(live.id);
    expect(t3.reads).toBe(reads);
    // the persona closes the live run: the next tick drops its state
    store.updateRun(live.id, { outcome: "progressed", endedAt: new Date().toISOString() });
    await cycle.reconcile();
    expect(cycle.runT3State(live.id)).toBeUndefined();
  });
});

describe("T6-S10 /api/runs carries t3 per running run", () => {
  it("GET /runs and /runs/:id add t3 from the last reconcile; closed runs carry none; no T3 read per request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-live-api-"));
    const db = openDb(path.join(dir, "console.db"));
    const { store, a } = seed(db);
    const t3 = new FakeT3();
    const read: ReadConfig = { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read, cycle: { enabled: true, t3: t3 as unknown as T3Client, publicUrl: "http://x", reconcileEveryMs: 60_000 } });
    cleanup = () => (db.close(), fs.rmSync(dir, { recursive: true, force: true }));
    const wake = store.createRun({ assignmentId: a.id, outcome: "running", summary: "w", threadId: "home", startedAt: ago(10 * MIN) });
    const child = store.createRun({ assignmentId: a.id, parentRunId: wake.id, outcome: "running", summary: "c", threadId: "child", startedAt: ago(5 * MIN) });
    const closed = store.createRun({ assignmentId: a.id, outcome: "progressed", summary: "x", threadId: "old", startedAt: ago(90 * MIN), endedAt: ago(80 * MIN) });
    t3.threads.set("home", { status: "running", runs: [turn("running", 10)] });
    t3.threads.set("child", { status: "running", runs: [turn("running", 5)] });
    const get = async (u: string) => (await app.request(u)).json() as Promise<any>;
    // before the first reconcile: nothing known
    expect((await get("/api/runs")).find((r: any) => r.id === child.id).t3).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_001); // first reconcile tick
    const reads = t3.reads;
    const runs = await get("/api/runs");
    const by = (id: string) => runs.find((r: any) => r.id === id);
    expect(by(child.id).t3).toMatchObject({ status: "live", detail: "running", startedAt: expect.any(String), checkedAt: expect.any(String) });
    expect(by(wake.id).t3).toMatchObject({ status: "live" });
    expect(by(closed.id).t3).toBeUndefined();
    expect((await get(`/api/runs/${child.id}`)).t3).toMatchObject({ status: "live" });
    expect(t3.reads).toBe(reads);
  });
});
