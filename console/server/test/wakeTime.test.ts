import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";

/** no starter opens a second wake while one runs: its note is queued into the running wake, else "already running". */
class FakeT3 implements T3Client {
  launched = 0;
  sends: { threadId: string; text: string; mode?: string }[] = [];
  failSteer = false;
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
    if (this.failSteer && mode) throw new Error("T3 down");
    this.sends.push({ threadId, text, mode });
  }
  async readThreadStatus() { return { status: "running", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s36-"));
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
  const wakes = () => store.listRuns().filter((r) => r.assignmentId === a.id && r.kind === "wake" && !r.parentRunId);
  return { db, t3, store, a, call, runNow, wakes };
}

describe("T6-S36 one wake at a time", () => {
  it("a Stall watch Run now while the wake runs queues its note into that wake: same run, no second wake, recorded", async () => {
    const t = setup();
    const first = await t.runNow({});
    expect(first.status).toBe(201);
    const r = await t.runNow({ note: "Stall watch: PLAN-18 has ready rows", noteBy: "Stall watch" });
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(first.json.id);
    expect(r.json.startGuard).toBe("queued");
    expect(t.wakes()).toHaveLength(1);
    expect(t.t3.launched).toBe(1);
    const steer = t.t3.sends.find((s) => s.mode === "steer")!;
    expect(steer.threadId).toBe("thread1");
    expect(steer.text).toContain("Stall watch: PLAN-18 has ready rows");
    expect(steer.text).toContain(`Report on run ${first.json.id} only`);
    const run = t.store.getRun(first.json.id)!;
    expect(run.startGuards).toEqual([expect.objectContaining({ by: "Stall watch", action: "queued", note: "Stall watch: PLAN-18 has ready rows" })]);
    const steers = (await t.call("GET", `/api/runs/${first.json.id}`)).json;
    expect(steers.startGuards?.[0]?.action ?? run.startGuards![0].action).toBe("queued");
  });

  it("a Run now with no note while the wake runs: 409 already_running, recorded as already_running", async () => {
    const t = setup();
    const first = await t.runNow({});
    const r = await t.runNow({});
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("already_running");
    expect(r.json.error.details).toMatchObject({ runId: first.json.id, action: "already_running" });
    expect(t.wakes()).toHaveLength(1);
    expect(t.store.getRun(first.json.id)!.startGuards).toEqual([expect.objectContaining({ action: "already_running" })]);
  });

  it("a note that cannot be queued (T3 refuses) is already_running with the reason, still no second wake", async () => {
    const t = setup();
    const first = await t.runNow({});
    t.t3.failSteer = true;
    const r = await t.runNow({ note: "do X" });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toMatchObject({ action: "already_running" });
    expect(r.json.error.details.reason).toContain("could not queue the note");
    expect(t.wakes()).toHaveLength(1);
    expect(t.store.getRun(first.json.id)!.startGuards![0]).toMatchObject({ action: "already_running", note: "do X" });
  });

  it("an answer wake while the wake runs is a steer, never a second wake (inbox path, T15-S1 kept)", async () => {
    const t = setup();
    await t.runNow({});
    await t.runNow({ note: "Sam answered PLAN-6-A1: yes", noteBy: "Sam" });
    await t.runNow({ note: "Unblocker answered T6-A2", noteBy: "Unblocker" });
    expect(t.wakes()).toHaveLength(1);
    expect(t.t3.sends.filter((s) => s.mode === "steer")).toHaveLength(2);
  });

  it("after the wake ends, Run now starts a new wake again", async () => {
    const t = setup();
    const first = await t.runNow({});
    await t.call("PATCH", `/api/runs/${first.json.id}`, { outcome: "progressed", summary: "done", endedAt: new Date().toISOString() });
    const next = await t.runNow({ note: "go" });
    expect(next.status).toBe(201);
    expect(next.json.id).not.toBe(first.json.id);
    expect(next.json.startGuard).toBeUndefined();
  });

  it("a report PATCHed onto an ended wake while a newer wake runs is refused (one report, one wake: run_5064482d + run_b5d76a14)", async () => {
    const t = setup();
    const old = await t.runNow({});
    // the 2026-10-28 shape: the earlier wake was reported monitoring and left without an end time
    await t.call("PATCH", `/api/runs/${old.json.id}`, { outcome: "monitoring", summary: "go-live running", nextCheckAt: new Date(Date.now() + 3600_000).toISOString() });
    const now = await t.runNow({ note: "Stall watch: 7 epics", noteBy: "Stall watch" });
    expect(now.status).toBe(201);
    const report = { outcome: "progressed", summary: "Stall watch answered: dispatched T14-S9", endedAt: new Date().toISOString() };
    const onOld = await t.call("PATCH", `/api/runs/${old.json.id}`, report);
    expect(onOld.status).toBe(409);
    expect(onOld.json.error.code).toBe("superseded_wake");
    expect(onOld.json.error.details).toMatchObject({ runId: now.json.id });
    expect(t.store.getRun(old.json.id)!.summary).toBe("go-live running");
    // closing the old one without a report is fine, and the new wake takes the report
    expect((await t.call("PATCH", `/api/runs/${old.json.id}`, { endedAt: new Date().toISOString() })).status).toBe(200);
    const onNew = await t.call("PATCH", `/api/runs/${now.json.id}`, { ...report, summary: `${report.summary}\nnote: done: dispatched` });
    expect(onNew.status).toBe(200);
  });

  it("a blocked (asking) wake may still be finished after the answer while a newer wake runs (M2-2, T13-S10)", async () => {
    const t = setup();
    const asking = await t.runNow({});
    await t.call("PATCH", `/api/runs/${asking.json.id}`, { outcome: "blocked", summary: "waits on Sam" });
    const m = t.store.getRun(asking.json.id)!.milestoneId!;
    // the run raised its ask through the API (the raise log; the ask itself is a line in the spine).
    t.store.logRaisedAsk({ runId: asking.json.id, milestoneId: m, question: "Approve: restore env?", proposedAction: "restore env", by: "repo/T1-A1" });
    expect((await t.runNow({ note: "Sam answered: yes", noteBy: "Sam" })).status).toBe(201);
    const done = await t.call("PATCH", `/api/runs/${asking.json.id}`, { outcome: "progressed", summary: "env restored", endedAt: new Date().toISOString() });
    expect(done.status).toBe(200);
  });
});
