import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";

/**
 * The console once queued notes into wakes through T3's own queue (steer refused, then `auto`). Those turns ran
 * after the wake ended, so every report was refused as superseded_wake, and a queue that stood still while T3 was being
 * upgraded replayed them hours later with old run ids (an answered question came again). Now a note goes
 * only into the live turn, else it is held for the next wake; a note a wake already took is never sent again; a late
 * report on the wake a note named is kept on it.
 */
class FakeT3 implements T3Client {
  launched = 0;
  sends: { threadId: string; text: string; mode?: string }[] = [];
  /** the running turn will not take a steer (T3 answers so when the turn is ending or the thread is idle). */
  refuseSteer = false;
  async listProjects() {
    return [{ id: "host1:proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() {
    this.launched++;
    return { threadId: `thread${this.launched}` };
  }
  async sendToThread(threadId: string, text: string, _crid?: string, mode?: string) {
    if (this.refuseSteer && mode === "steer") throw new Error("thread is not running a turn that can be steered");
    this.sends.push({ threadId, text, mode });
  }
  async readThreadStatus() { return { status: "running", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-note-once-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new FakeT3();
  const store = createStore(db);
  const app = createApp(db, { cycle: { enabled: true, t3, dispatcher: disp, publicUrl: "http://x" } });
  cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery manager", remit: "r", skills: [], model: "sonnet", mayWrite: false });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const runNow = (body: unknown = {}) => call("POST", `/api/assignments/${a.id}/run-now`, body);
  const end = (id: string, outcome = "progressed", summary = "done") => call("PATCH", `/api/runs/${id}`, { outcome, summary, endedAt: new Date().toISOString() });
  const wakes = () => store.listRuns().filter((r) => r.assignmentId === a.id && r.kind === "wake" && !r.parentRunId);
  const notesSent = (words: string) => t3.sends.filter((s) => s.text.includes(words));
  return { db, t3, store, a, call, runNow, end, wakes, notesSent };
}

describe("E907-S3 a note reaches a wake once, on a wake that can take its report", () => {
  it("a note the running turn cannot take is held, never put in T3's queue, and the next wake carries it", async () => {
    const t = setup();
    const first = await t.runNow({});
    t.t3.refuseSteer = true;
    const r = await t.runNow({ note: "Sam answered E907-A1: yes", noteBy: "Sam" });
    expect(r.status).toBe(200);
    expect(r.json.startGuard).toBe("held");
    expect(t.t3.sends.filter((s) => s.mode === "auto" && s.text.includes("E907-A1"))).toHaveLength(0);
    expect(t.wakes()).toHaveLength(1);
    // the wake ends: a new wake starts by itself with the held note in its instructions
    t.t3.refuseSteer = false;
    expect((await t.end(first.json.id)).status).toBe(200);
    await vi.waitFor(() => expect(t.wakes()).toHaveLength(2));
    const next = t.wakes().find((w) => w.id !== first.json.id)!;
    expect(next.instructions).toContain("Sam answered E907-A1: yes");
    expect(next.instructions).toContain(`because wake ${first.json.id} could not take it`);
  });

  it("the same note twice in one wake is steered once; again after the wake did its work, it wakes nothing", async () => {
    const t = setup();
    const first = await t.runNow({});
    const note = { note: "Sam: a card asked again for the token", noteBy: "Sam" };
    expect((await t.runNow(note)).json.startGuard).toBe("queued");
    const again = await t.runNow(note);
    expect(again.json.startGuard).toBe("handled");
    expect(t.notesSent("asked again for the token")).toHaveLength(1);
    await t.end(first.json.id);
    // hours later (a replay, a re-send): no new wake, no new send
    const later = await t.runNow(note);
    expect(later.status).toBe(200);
    expect(later.json.startGuard).toBe("handled");
    expect(later.json.id).toBe(first.json.id);
    expect(t.wakes()).toHaveLength(1);
    expect(t.notesSent("asked again for the token")).toHaveLength(1);
  });

  it("a note whose wake failed is not handled: it starts a new wake", async () => {
    const t = setup();
    const first = await t.runNow({ note: "do the thing", noteBy: "Stall watch" });
    expect(first.status).toBe(201);
    await t.end(first.json.id, "failed", "Run now failed: host1 unavailable");
    const again = await t.runNow({ note: "do the thing", noteBy: "Stall watch" });
    expect(again.status).toBe(201);
    expect(again.json.id).not.toBe(first.json.id);
  });

  it("a late report on the wake a queued note named is kept on it, not refused as superseded_wake", async () => {
    const t = setup();
    const old = await t.runNow({});
    expect((await t.runNow({ note: "Sam closed E907-S4", noteBy: "Sam" })).json.startGuard).toBe("queued");
    await t.end(old.json.id, "progressed", "outcome: progressed: E907-S5 dispatched");
    const now = await t.runNow({});
    expect(now.status).toBe(201);
    const late = await t.call("PATCH", `/api/runs/${old.json.id}`, { outcome: "progressed", summary: "queued note: done: E907-S4 closed", endedAt: new Date().toISOString() });
    expect(late.status).toBe(200);
    expect(late.json.lateNoteReport).toBe(true);
    const kept = t.store.getRun(old.json.id)!;
    expect(kept.summary).toContain("outcome: progressed: E907-S5 dispatched");
    expect(kept.summary).toContain("late note report");
    expect(kept.summary).toContain("queued note: done: E907-S4 closed");
    expect(t.store.getRun(now.json.id)!.outcome).toBe("running");
  });

  it("a wake that took no note still refuses a report after a newer wake started (one report, one wake kept)", async () => {
    const t = setup();
    const old = await t.runNow({});
    await t.end(old.json.id);
    const now = await t.runNow({});
    const late = await t.call("PATCH", `/api/runs/${old.json.id}`, { outcome: "progressed", summary: "again", endedAt: new Date().toISOString() });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("superseded_wake");
    expect(late.json.error.details).toMatchObject({ runId: now.json.id });
  });
});
