import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { RESENT } from "../src/cycle/reconcile.js";
import type { T3Client, T3ThreadRun } from "../src/t3/client.js";
import { runnerDispatcher } from "../src/t3/dispatcher.js";

/**
 * a turn that never starts.
 * Case 1 (run_1bf2f284, 2026-10-28 02:15:25Z): Run now's send died with the console (deploy restart of 237b5e3); 15 min
 * later the reconciler failed it "no T3 turn ever ran". Now: one re-send, then the wake claims the same run.
 * Case 2 (run_694e2165, 2026-10-31 23:40Z): T3 "The provider could not start this turn" (the worker server under load ~60). Now: the
 * exact T3 error is in the run summary, the seat goes to the broker with that text (`done --fail --signal`, it avoids the
 * seat 10 min), and a Run now goes once more to a new home thread on the seat the broker then picks.
 */

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const START_FAIL = "Provider error: The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.";

class FakeT3 implements T3Client {
  sent: string[] = [];
  launched: { threadId: string; instanceId?: string }[] = [];
  turns = new Map<string, T3ThreadRun[]>();
  errors = new Map<string, string>();
  items = new Map<string, number>();
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { modelSelection?: { instanceId?: string } }) {
    const threadId = `home${this.launched.length + 1}`;
    this.launched.push({ threadId, instanceId: input.modelSelection?.instanceId });
    return { threadId };
  }
  async sendToThread(threadId: string) {
    this.sent.push(threadId);
  }
  async readThreadStatus(threadId: string) {
    const runs = this.turns.get(threadId) ?? [];
    return { status: runs[0]?.status ?? "idle", runs, raw: { itemCount: this.items.get(threadId) } };
  }
  async readLastError(threadId: string) {
    return this.errors.get(threadId);
  }
}

/** The dispatcher contract over a fake runner: records every argv (done --fail --signal included). */
function fakeDispatcher(seats: string[]) {
  const calls: string[][] = [];
  let i = 0;
  const d = runnerDispatcher(async (args) => {
    calls.push(args);
    if (args[0] === "pick") {
      const seat = seats[Math.min(i++, seats.length - 1)];
      return JSON.stringify({ id: seat, via: "t3_delegate_task", providerInstanceId: `claudeAgent_${seat}` });
    }
    return JSON.stringify({ ok: true });
  });
  return { d, calls };
}

let db: DB | undefined;
let dir: string | undefined;
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  db = dir = stop = undefined;
});

async function setup(seats = ["seat1", "seat2"]) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s39-"));
  db = openDb(path.join(dir, "cy.db"));
  const t3 = new FakeT3();
  const disp = fakeDispatcher(seats);
  const store = createStore(db);
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp.d, publicUrl: "http://x", sendRetryMs: 0 });
  stop = () => cycle.stop();
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "mgr", remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const first = await cycle.runNow(a.id); // launches home1 on seat1; later wakes send into it
  store.updateRun(first.id, { outcome: "progressed", endedAt: new Date().toISOString() });
  const age = (runId: string, ms: number) => db!.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(ago(ms), runId);
  const turn = (status: string, startMin: number, endMin?: number): T3ThreadRun => ({
    status,
    requestedAt: ago(startMin * MIN),
    startedAt: ago(startMin * MIN),
    completedAt: endMin === undefined ? null : ago(endMin * MIN),
  });
  return { t3, disp, store, cycle, a, age, turn };
}

describe("T6-S39 case 1: a Run now whose send was lost (console restart)", () => {
  it("is re-sent once instead of failing, and the wake then claims the same run", async () => {
    const t = await setup();
    const run = await t.cycle.runNow(t.a.id);
    expect(t.t3.sent).toEqual(["home1"]);
    t.age(run.id, 20 * MIN); // past the 15 min claim window, no turn since (the restart lost the message)
    t.t3.turns.set("home1", [t.turn("completed", 90, 80)]);
    await t.cycle.reconcile();
    let r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("running");
    expect(r.summary).toContain(`${RESENT}: no T3 turn ran within 15 min of the wake (send lost, e.g. a console restart)`);
    expect(t.t3.sent).toEqual(["home1", "home1"]);
    await t.cycle.reconcile(); // grace restarts at the re-send: no second send, no close
    expect(t.store.getRun(run.id)!.outcome).toBe("running");
    expect(t.t3.sent).toHaveLength(2);
    const woke = await t.cycle.wake(t.a.id, { threadId: "home1" });
    expect(woke.run?.id).toBe(run.id); // claimed, not "skipped: previous run still running"
    r = t.store.getRun(run.id)!;
    expect(r.summary).toBe("Run now: woke");
  });

  it("a run already re-sent (e.g. before another restart) fails, saying so", async () => {
    const t = await setup();
    const run = await t.cycle.runNow(t.a.id);
    t.store.updateRun(run.id, { summary: `Run now: waiting for the persona to wake (${RESENT}: x)` });
    t.age(run.id, 20 * MIN);
    t.t3.turns.set("home1", [t.turn("completed", 90, 80)]);
    await t.cycle.reconcile();
    const r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("failed");
    expect(r.summary).toContain("no T3 turn ever ran for this run, also after the re-send");
    expect(t.t3.sent).toHaveLength(1);
  });

  it("a wake run no longer pending (claimed) is never re-sent: the old close stands", async () => {
    const t = await setup();
    const r0 = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "Run now: waiting", threadId: "home1", startedAt: ago(20 * MIN) });
    t.t3.turns.set("home1", [t.turn("completed", 90, 80)]);
    await t.cycle.reconcile();
    expect(t.store.getRun(r0.id)!.summary).toContain("no T3 turn ever ran for this run]");
    expect(t.t3.sent).toHaveLength(0);
  });
});

describe("T6-S39 case 2: the provider could not start the turn", () => {
  it("Run now: the exact error is recorded, the seat goes to the broker with it, the wake goes once to a new thread", async () => {
    const t = await setup(["seat1", "seat2"]);
    const run = await t.cycle.runNow(t.a.id);
    expect(t.store.getRun(run.id)!.seat).toBe("seat1");
    t.age(run.id, 6 * MIN); // the wake was sent, then T3 failed the turn
    t.t3.turns.set("home1", [t.turn("failed", 5, 3)]);
    t.t3.errors.set("home1", START_FAIL);
    await t.cycle.reconcile();
    const r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("running");
    expect(r.summary).toContain(`${RESENT} on a new thread: T3 turn failed: ${START_FAIL}`);
    const done = t.disp.calls.find((c) => c[0] === "done" && c.includes("--signal"))!;
    expect(done.slice(0, 3)).toEqual(["done", "seat1", "--fail"]);
    expect(done[4]).toContain("could not start this turn");
    expect(t.t3.launched.map((l) => l.threadId)).toEqual(["home1", "home2"]);
    expect(t.t3.launched[1].instanceId).toBe("claudeAgent_seat2");
    expect(r.threadId).toBe("home2");
    expect(r.seat).toBe("seat2");
  });

  it("a home thread too long for the provider handoff: the wake goes once to a new thread", async () => {
    const t = await setup(["seat1", "seat2"]);
    const run = await t.cycle.runNow(t.a.id);
    t.age(run.id, 6 * MIN);
    t.t3.turns.set("home1", [t.turn("failed", 5, 3)]);
    t.t3.errors.set("home1", "Provider error: Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model; the current request has not been truncated.");
    await t.cycle.reconcile();
    const r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("running");
    expect(r.summary).toContain(`${RESENT} on a new thread`);
    expect(t.t3.launched.map((l) => l.threadId)).toEqual(["home1", "home2"]);
    expect(r.threadId).toBe("home2");
  });

  it("a home thread past the item limit moves to a new thread at the next wake, the move recorded", async () => {
    const t = await setup(["seat1", "seat2"]);
    t.t3.items.set("home1", 4_001);
    const run = await t.cycle.runNow(t.a.id);
    expect(t.t3.launched.map((l) => l.threadId)).toEqual(["home1", "home2"]);
    expect(t.t3.sent).toEqual([]);
    const r = t.store.getRun(run.id)!;
    expect(r.threadId).toBe("home2");
    expect(r.preWake).toContain("fresh session: home thread too long (4001 items, over 4000)");
    // under the limit: the home thread is reused
    t.store.updateRun(run.id, { outcome: "progressed", endedAt: new Date().toISOString() });
    t.t3.items.set("home2", 120);
    await t.cycle.runNow(t.a.id);
    expect(t.t3.sent).toEqual(["home2"]);
  });

  it("another provider error: recorded in the summary, the run fails, no re-send", async () => {
    const t = await setup();
    const run = await t.cycle.runNow(t.a.id);
    t.age(run.id, 6 * MIN); // the wake was sent, then T3 failed the turn
    t.t3.turns.set("home1", [t.turn("failed", 5, 3)]);
    t.t3.errors.set("home1", "Provider error: model claude-x is not available"); // a usage limit now re-sends (wakeWhoseHomeSeat.test.ts)
    await t.cycle.reconcile();
    const r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("failed");
    expect(r.summary).toContain("T3 turn failed (Provider error: model claude-x is not available), no report from persona");
    expect(t.t3.launched).toHaveLength(1);
  });

  it("a child worker: failed with the exact error, its seat released to the broker with that text", async () => {
    const t = await setup();
    const wake = await t.cycle.runNow(t.a.id);
    t.t3.turns.set("home1", [t.turn("running", 6)]);
    const child = t.store.createRun({ assignmentId: t.a.id, parentRunId: wake.id, seat: "seat1", outcome: "running", summary: "T6-S38 x", threadId: "kid", startedAt: ago(4 * MIN) });
    t.t3.turns.set("kid", [t.turn("failed", 3, 1)]);
    t.t3.errors.set("kid", START_FAIL);
    await t.cycle.reconcile();
    const r = t.store.getRun(child.id)!;
    expect(r.outcome).toBe("failed");
    expect(r.summary).toContain(`T3 turn failed (${START_FAIL}), no report from persona`);
    expect(t.disp.calls).toContainEqual(["done", "seat1", "--fail", "--signal", START_FAIL]);
  });
});
