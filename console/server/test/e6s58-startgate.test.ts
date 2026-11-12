import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { classifyRefusal, isStartGap, nextDeferral, refusalText } from "../src/cycle/capRefusal.js";
import { createStartGate, gapReason, SESSION_START_GAP_MS } from "../src/cycle/startGate.js";
import { SEED_VERSION, UPDATE_MARKER } from "../src/desk/desk.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher, HostSessions } from "../src/t3/dispatcher.js";

/**
 * one new the main server agent session per 90 s. After one console deploy on 2026-11-03 (02:30
 * CET) 8 Claude sessions started within 2 min: every live repo desk got its `[repo-desk update]` at once, with no run
 * row and no cap check (0 session-cap deferrals). Every automated the main server start now takes the start gate; queued wakes and
 * desk updates go out one per gap, also right after a restart (the last start is kept on disk).
 */

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e6s58-gate-"))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("T6-S58 start gate", () => {
  it("one start per gap; refusal says how long; cancel gives the slot back; mark counts; default 90 s", () => {
    expect(SESSION_START_GAP_MS).toBe(90_000);
    let t = 1_000_000;
    const lines: string[] = [];
    const g = createStartGate({ gapMs: 90_000, now: () => t, log: (m) => lines.push(m) });
    const a = g.take("wake a");
    expect(a.ok).toBe(true);
    t += 30_000;
    const b = g.take("wake b");
    expect(b).toMatchObject({ ok: false, waitMs: 60_000, reason: "session start gap on main: last start 30 s ago (gap 90 s)" });
    expect(g.waitMs()).toBe(60_000);
    t += 60_000;
    const c = g.take("wake c");
    expect(c.ok).toBe(true);
    g.cancel((c as { token: number }).token); // its pick was refused: the slot goes back
    expect(g.waitMs()).toBe(0);
    g.mark("Sam's message");
    expect(g.take("wake d").ok).toBe(false);
    expect(lines.filter((l) => l.startsWith("session start gate: main start") && !l.includes("given back"))).toHaveLength(3);
    expect(lines.some((l) => l.includes("given back"))).toBe(true);
  });

  it("the last start survives a restart (file); gap 0 = off", () => {
    const file = path.join(tmp, "gate.json");
    let t = 5_000_000;
    createStartGate({ gapMs: 90_000, file, now: () => t, log: () => {} }).take("before the restart");
    t += 10_000;
    const after = createStartGate({ gapMs: 90_000, file, now: () => t, log: () => {} });
    expect(after.take("first after the restart")).toMatchObject({ ok: false, waitMs: 80_000 });
    const off = createStartGate({ gapMs: 0, file, now: () => t });
    expect(off.take("x").ok && off.take("y").ok).toBe(true);
  });

  it("wording: the gap is a retryable sessions refusal; a deferral retries when the gate opens", () => {
    const r = classifyRefusal(gapReason(30_000, 90_000));
    expect(r).toMatchObject({ kind: "sessions", host: "main", retryable: true });
    const text = refusalText([r]);
    expect(text).toBe("session-start gap on main (last start 30 s ago / gap 90 s), will retry");
    expect(isStartGap(text) && isStartGap(gapReason(1, 90_000))).toBe(true);
    expect(isStartGap("session-cap on main (6 live / cap 6), will retry")).toBe(false);
    const d = nextDeferral(undefined, text, "main", 0, 61_000);
    expect(d.nextAt).toBe(new Date(61_000).toISOString());
    expect(nextDeferral(undefined, text, "main", 0).nextAt).toBe(new Date(60_000).toISOString()); // backoff as before
  });
});

class FakeT3 {
  launched: { at: number; title: string }[] = [];
  sent: { at: number; threadId: string; message: string }[] = [];
  constructor(private clock: () => number) {}
  async listProjects() {
    return [
      { id: "main:proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo", repositoryIdentity: { displayName: "acme/home_repo" } },
    ];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(i: { title: string }) {
    this.launched.push({ at: this.clock(), title: i.title });
    return { threadId: `main-thread${this.launched.length}` };
  }
  async sendToThread(threadId: string, message: string) {
    this.sent.push({ at: this.clock(), threadId, message });
  }
  async readThreadStatus() { return { status: "idle", raw: {} }; }
  async readThreadMessages() { return { messages: [], nextPosition: null, hasMore: false, archived: false }; }
}

class Host1 implements Dispatcher {
  async pick() { return { seat: "seat3", providerInstanceId: "claudeAgent_seat3" }; }
  async done() {}
  async sessions(): Promise<HostSessions> { return { host: "main", live: 0, cap: 6, full: false }; }
}

describe("T6-S58 queued wakes start one per gap (a restart burst)", () => {
  it("three main wakes due at once: one launches, two wait for the gate; they start >= 90 s apart, one row each", async () => {
    let off = 0;
    const clock = () => Date.now() + off;
    const db: DB = openDb(path.join(tmp, "c.db"));
    try {
      const store = createStore(db);
      const t3 = new FakeT3(clock);
      const gate = createStartGate({ gapMs: 90_000, now: clock, log: () => {} });
      const cycle = createCycle(db, store, { enabled: true, t3: t3 as unknown as T3Client, dispatcher: new Host1(), publicUrl: "http://main-console", startGate: gate });
      const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
      const as = ["Delivery manager", "Builder", "Writer"].map((name) => {
        const p = store.createPersona({ name, remit: "r", skills: [], model: "sonnet", mayWrite: true, host: "main", freshThreadEachWake: false });
        return store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
      });
      const runs = [];
      for (const a of as) runs.push(await cycle.runNow(a.id));
      expect(t3.launched).toHaveLength(1);
      const r1 = store.getRun(runs[1].id)!;
      expect(r1.outcome).toBe("deferred");
      expect(r1.summary).toMatch(/^Deferred: session-start gap on main \(last start 0 s ago \/ gap 90 s\), will retry/);
      // the retry is set for when the gate opens (~90 s), not the 1-min backoff
      const nextIn = Date.parse(r1.deferred!.nextAt) - Date.now();
      expect(nextIn).toBeGreaterThanOrEqual(90_000);
      expect(nextIn).toBeLessThan(96_000);
      off = 60_000;
      await cycle.tickDeferred(new Date(clock()));
      expect(t3.launched).toHaveLength(1); // nothing due yet
      off = 96_000;
      await cycle.tickDeferred(new Date(clock()));
      expect(t3.launched).toHaveLength(2); // one of the two; the other waits for the next opening
      off = 200_000;
      await cycle.tickDeferred(new Date(clock()));
      expect(t3.launched).toHaveLength(3);
      const at = t3.launched.map((l) => l.at);
      for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(90_000);
      for (const a of as) expect(store.listRuns({ assignmentId: a.id, limit: 10 })).toHaveLength(1);
      cycle.stop?.();
    } finally {
      db.close();
    }
  });
});

describe("T6-S58 desk endpoint updates go out one per gap", () => {
  it("after a launch the update waits for the gate; once open it is sent; Sam's own message never waits", async () => {
    let off = 0;
    const clock = () => Date.now() + off;
    const db: DB = openDb(path.join(tmp, "console.db"));
    try {
      const t3 = new FakeT3(clock);
      const gate = createStartGate({ gapMs: 90_000, now: clock, log: () => {} });
      const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
      const app = createApp(db, {
        read: readCfg,
        cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: new Host1(), publicUrl: "http://console.test", startGate: gate },
      });
      const call = (method: string, url: string, body?: unknown) =>
        app.request(url, { method, headers: { "Sec-Fetch-Site": "same-origin", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      await call("GET", "/api/desk/messages"); // launches the desk thread: counts as a start
      expect(t3.launched).toHaveLength(1);
      db.prepare("UPDATE desk_session SET seed_version = NULL").run();
      const updates = () => t3.sent.filter((s) => s.message.startsWith(UPDATE_MARKER));
      await call("GET", "/api/desk/messages");
      await new Promise((r) => setTimeout(r, 20)); // the update is sent in the background of the read
      expect(updates()).toHaveLength(0); // inside the gap
      expect(db.prepare("SELECT seed_version v FROM desk_session").get()).toEqual({ v: null });
      off = 91_000;
      await call("POST", "/api/desk/sweep"); // the background pass never pushes the update to an idle thread
      expect(updates()).toHaveLength(0);
      await call("GET", "/api/desk/messages"); // the next open of the chat sends it
      await new Promise((r) => setTimeout(r, 20));
      expect(updates()).toHaveLength(1);
      expect(db.prepare("SELECT seed_version v FROM desk_session").get()).toEqual({ v: SEED_VERSION });
      // the owner writes right after: sent at once (never gated)
      const res = await call("POST", "/api/desk/messages", { text: "hello" });
      expect(res.status).toBeLessThan(300);
      expect(t3.sent.some((s) => s.message.includes("hello"))).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("T6-S74 desk endpoint updates never resume an idle main session", () => {
  it("the sweep sends no update; an open waits while main is at its session cap and sends once below it", async () => {
    const db: DB = openDb(path.join(tmp, "console.db"));
    try {
      const t3 = new FakeT3(() => Date.now());
      const main = new Host1();
      let live = 6;
      main.sessions = async () => ({ host: "main", live, cap: 6, full: live >= 6 });
      const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
      const app = createApp(db, {
        read: readCfg,
        cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: main, publicUrl: "http://console.test", startGate: createStartGate({ gapMs: 0 }) },
      });
      const call = (method: string, url: string, body?: unknown) =>
        app.request(url, { method, headers: { "Sec-Fetch-Site": "same-origin", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      await call("GET", "/api/desk/messages"); // launches the desk thread (the owner opened it)
      expect(t3.launched).toHaveLength(1);
      db.prepare("UPDATE desk_session SET seed_version = NULL").run();
      const updates = () => t3.sent.filter((s) => s.message.startsWith(UPDATE_MARKER));
      await call("POST", "/api/desk/sweep");
      expect(updates()).toHaveLength(0);
      await call("GET", "/api/desk/messages");
      await new Promise((r) => setTimeout(r, 20));
      expect(updates()).toHaveLength(0); // 6 live / cap 6: waits
      live = 5;
      await call("GET", "/api/desk/messages");
      await new Promise((r) => setTimeout(r, 20));
      expect(updates()).toHaveLength(1);
      expect(db.prepare("SELECT seed_version v FROM desk_session").get()).toEqual({ v: SEED_VERSION });
      // the owner's own message never waits for the cap
      live = 9;
      const res = await call("POST", "/api/desk/messages", { text: "hello at the cap" });
      expect(res.status).toBeLessThan(300);
      expect(t3.sent.some((s) => s.message.includes("hello at the cap"))).toBe(true);
    } finally {
      db.close();
    }
  });
});
