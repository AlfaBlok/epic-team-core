import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { classifyRefusal, isHostCap, refusalText } from "../src/cycle/capRefusal.js";
import type { T3Client } from "../src/t3/client.js";
import { runnerDispatcher, type Dispatcher, type HostSessions } from "../src/t3/dispatcher.js";

/**
 * the infra repo S9, at most 6 concurrent agent sessions on the main server. The broker refuses the main server pick at the cap
 * (`session cap on the main server: 6 live (cap 6)`); a wake into an existing the main server home thread takes no pick, so the console asks
 * the dispatcher's `sessions` first. Over the cap the wake is deferred (`session-cap on the main server (…), will retry`), never
 * refused silently, and launches once a session ends.
 */

class FakeT3 implements T3Client {
  launched: { title: string; message?: string }[] = [];
  sent: { threadId: string; message: string }[] = [];
  async listProjects() {
    return [{ id: "main:proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(i: { title: string; message?: string }) {
    this.launched.push(i);
    return { threadId: `main-thread${this.launched.length}` };
  }
  async sendToThread(threadId: string, message: string) {
    this.sent.push({ threadId, message });
  }
  async readThreadStatus() { return { status: "running", raw: {} }; }
}

/** The the main server broker: refuses picks at the session cap, answers `sessions` with the same count. */
class Main implements Dispatcher {
  live: number | null = 0;
  cap = 6;
  calls: string[] = [];
  private refusal() {
    return this.live !== null && this.live >= this.cap ? `session cap on main: ${this.live} live (cap ${this.cap})` : undefined;
  }
  async pick() {
    this.calls.push("pick");
    const r = this.refusal();
    return r ? { seat: null, reason: r } : { seat: "seat3", providerInstanceId: "claudeAgent_seat3" };
  }
  async done(seat: string) {
    this.calls.push(`done ${seat}`);
  }
  async sessions(): Promise<HostSessions> {
    this.calls.push("sessions");
    return { host: "main", live: this.live, cap: this.cap, full: !!this.refusal() };
  }
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(over: { fresh?: boolean; host?: "main" | "worker" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s48-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new FakeT3();
  const main = new Main();
  const store = createStore(db);
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: main, publicUrl: "http://main-console" });
  cleanup = () => {
    cycle.stop?.();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery manager", remit: "runs the epic", skills: [], model: "sonnet", mayWrite: true, host: over.host ?? "main", freshThreadEachWake: over.fresh ?? false });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
  const later = (min: number) => new Date(Date.now() + min * 60_000);
  const end = (id: string) => store.updateRun(id, { outcome: "progressed", endedAt: new Date().toISOString() });
  return { store, cycle, t3, main, a, later, end };
}

describe("T6-S48 wording", () => {
  it("session cap → session-cap on main (n live / cap c), will retry; a host cap", () => {
    const r = classifyRefusal("session cap on main: 6 live (cap 6)");
    expect(r).toMatchObject({ kind: "sessions", host: "main", retryable: true });
    expect(isHostCap(r)).toBe(true);
    expect(refusalText([r])).toBe("session-cap on main (6 live / cap 6), will retry");
    expect(refusalText([classifyRefusal("high load on worker: load5 25.5 on 8 CPUs (cap 16)"), r])).toBe(
      "load-cap on worker (load5 25.5 / cap 16); main: session-cap (6 live / cap 6), will retry",
    );
  });

  it("runnerDispatcher.sessions reads the dispatcher's `sessions` JSON (live null = unreadable, never full)", async () => {
    const asked: string[][] = [];
    const out: Record<string, string> = {
      full: JSON.stringify({ host: "main", live: 7, cap: 6, full: true, threads: [] }),
      unknown: JSON.stringify({ host: "main", live: null, cap: 6, full: false, error: "no token" }),
    };
    let which = "full";
    const d = runnerDispatcher(async (args) => (asked.push(args), out[which]));
    expect(await d.sessions!()).toEqual({ host: "main", live: 7, cap: 6, full: true });
    which = "unknown";
    expect(await d.sessions!()).toEqual({ host: "main", live: null, cap: 6, full: false });
    expect(asked).toEqual([["sessions"], ["sessions"]]);
  });
});

describe("T6-S48 a 7th session never starts on main", () => {
  it("wake into an existing main home thread at the cap: deferred, nothing sent; sent once a session ends", async () => {
    const t = setup();
    const first = await t.cycle.runNow(t.a.id); // launches the home thread (5 live: room)
    t.main.live = 5;
    expect(t.t3.launched).toHaveLength(1);
    t.end(first.id);
    t.main.live = 6;
    const run = await t.cycle.runNow(t.a.id);
    let r = t.store.getRun(run.id)!;
    expect(t.t3.sent).toHaveLength(0);
    expect(r.outcome).toBe("deferred");
    expect(r.endedAt).toBeUndefined();
    expect(r.summary).toMatch(/^Deferred: session-cap on main \(6 live \/ cap 6\), will retry \(attempt 1, next try \d\d:\d\dZ\)$/);
    // still full at the retry: same row, attempt 2
    await t.cycle.tickDeferred(t.later(1.5));
    r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("deferred");
    expect(r.summary).toContain("attempt 2");
    expect(t.t3.sent).toHaveLength(0);
    // a session ended: the same row sends into the home thread
    t.main.live = 5;
    await t.cycle.tickDeferred(t.later(4));
    r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("running");
    expect(t.t3.sent).toHaveLength(1);
    expect(t.t3.sent[0].threadId).toBe("main-thread1");
    expect(t.store.listRuns({ assignmentId: t.a.id, limit: 10 })).toHaveLength(2); // one row per wake, none per retry
  });

  it("fresh-thread wake on main at the cap (broker refuses the pick): deferred with the same wording, no launch", async () => {
    const t = setup({ fresh: true });
    t.main.live = 6;
    const run = await t.cycle.runNow(t.a.id);
    expect(t.t3.launched).toHaveLength(0);
    expect(t.store.getRun(run.id)!).toMatchObject({ outcome: "deferred" });
    expect(t.store.getRun(run.id)!.summary).toMatch(/^Deferred: session-cap on main \(6 live \/ cap 6\), will retry/);
    t.main.live = 2;
    await t.cycle.tickDeferred(t.later(2));
    expect(t.store.getRun(run.id)!.outcome).toBe("running");
    expect(t.t3.launched).toHaveLength(1);
  });

  it("below the cap, or count unreadable: the wake goes out as before", async () => {
    const t = setup();
    const first = await t.cycle.runNow(t.a.id);
    t.end(first.id);
    t.main.live = null; // T3 unreadable never blocks
    const run = await t.cycle.runNow(t.a.id);
    expect(t.store.getRun(run.id)!.outcome).toBe("running");
    expect(t.t3.sent).toHaveLength(1);
    expect(t.main.calls).toContain("sessions");
  });
});
