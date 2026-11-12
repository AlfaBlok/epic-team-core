import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { modelId, type CycleOptions } from "../src/cycle/service.js";
import { matchProject, type T3Client, type T3Project, type T3ScheduledTask } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { actionableCount, parkDecision } from "../src/cycle/park.js";
import type { Tree, TreeColor, TreeNode } from "../src/adapters/tree.js";
import { tempCheckout } from "./tempCheckout.js";
// the code repo milestone lives in a temp checkout (finishing a run fetches its origin; never the real one).
const AT = tempCheckout("home_repo", ["AGENTS.md", "docs/spines/root.md", "docs/spines/m2-team-console.md"]).dir;


const PROJECTS: T3Project[] = [
  {
    id: "mcp:agent-team",
    title: "home_repo",
    workspaceRoot: AT,
    repositoryIdentity: { displayName: "acme/home_repo", canonicalKey: "github.com/acme/home_repo" },
  },
  {
    id: "mcp:infra",
    title: "ops",
    workspaceRoot: "/srv/agent/github/ops",
    repositoryIdentity: { displayName: "acme/ops", canonicalKey: "github.com/acme/ops" },
  },
];

/** In-memory T3: records calls. The console creates no scheduled task; tests seed `tasks` to stand for old ones. */
class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  tasks = new Map<string, T3ScheduledTask & { projectId: string; prompt: string; schedule: any }>();
  threads = new Map<string, { projectId: string; messages: string[] }>();
  failLaunch = false;
  private n = 0;

  private log(op: string, args: any) {
    this.calls.push({ op, args });
  }
  ops = (op: string) => this.calls.filter((c) => c.op === op);

  async listProjects() {
    this.log("listProjects", {});
    return PROJECTS;
  }
  async listScheduledTasks(projectId: string) {
    this.log("listScheduledTasks", { projectId });
    return [...this.tasks.values()].filter((t) => t.projectId === projectId);
  }
  async updateScheduledTask(id: string, patch: any) {
    this.log("updateScheduledTask", { id, ...patch });
    const t = this.tasks.get(id);
    if (!t) throw new Error(`no task ${id}`);
    Object.assign(t, patch);
    return { ...t, nextRunAt: t.enabled ? "2026-10-15T12:00:00.000Z" : undefined };
  }
  async deleteScheduledTask(id: string) {
    this.log("deleteScheduledTask", { id });
    this.tasks.delete(id);
  }
  async runScheduledTaskNow(id: string) {
    this.log("runScheduledTaskNow", { id });
    if (!this.tasks.has(id)) throw new Error(`no task ${id}`);
  }
  async launchThread(input: { projectId: string; title: string; message?: string; modelSelection?: any }) {
    this.log("launchThread", input);
    if (this.failLaunch) throw new Error("launch refused");
    const threadId = `thread_${++this.n}`;
    this.threads.set(threadId, { projectId: input.projectId, messages: input.message ? [input.message] : [] });
    return { threadId };
  }
  failSteer = false;
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.log("sendToThread", { threadId, message, clientRequestId, mode });
    if (mode === "steer" && this.failSteer) throw new Error("t3_thread_send: turn not steerable");
    this.threads.get(threadId)!.messages.push(message);
  }
  async readThreadStatus(threadId: string) {
    this.log("readThreadStatus", { threadId });
    return { status: "idle", raw: {} };
  }
}

class FakeDispatcher implements Dispatcher {
  held: string[] = [];
  released: { seat: string; failed?: boolean }[] = [];
  seat: string | null = "seat2";
  async pick() {
    if (!this.seat) return { seat: null as null, reason: "all seats busy or maxed" };
    this.held.push(this.seat);
    return { seat: this.seat, providerInstanceId: `claudeAgent_${this.seat}` };
  }
  async done(seat: string, failed?: boolean) {
    this.released.push({ seat, failed });
  }
}

const BASE = "http://127.0.0.1:18799";
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup(over: Partial<CycleOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-cycle-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const t3 = new FakeT3();
  const dispatcher = new FakeDispatcher();
  // the fixture milestone is a real (done) spine; the run_state gate is tested in runnableGate.test.ts, not here.
  const opts: CycleOptions = { enabled: true, t3, dispatcher, publicUrl: BASE, seatsFile: path.join(dir, "seats.json"), runState: async () => undefined, ...over };
  const app = createApp(db, { cycle: opts });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  // Background work (setup polling) runs on timers; wait for it via a status poll.
  const settle = async (assignmentId: string) => {
    for (let i = 0; i < 200; i++) {
      const s = (await call("GET", `/api/assignments/${assignmentId}/cycle`)).json;
      if (s.syncState !== "pending") return s;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("sync never settled");
  };
  const seed = async (cadence: any = { type: "interval", everyMinutes: 120 }) => {
    const m = (await call("POST", "/api/milestones", { title: "M2", repo: AT, path: "docs/spines/m2-team-console.md" })).json;
    const p = (await call("POST", "/api/personas", { name: "reader", remit: "read-only: report one sentence", model: "haiku" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence })).json;
    return { m, p, a };
  };
  return { db, dir, t3, dispatcher, call, settle, seed };
}

describe("pure mapping", () => {
  it("maps persona model text to T3 model ids", () => {
    expect(modelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelId("Haiku")).toBe("claude-haiku-5-5");
    expect(modelId("")).toBe("claude-sonnet-5-5");
  });
  it("finds the T3 project for path, owner/name and bare name", () => {
    expect(matchProject(PROJECTS, "/srv/agent/github/ops/")?.id).toBe("mcp:infra");
    expect(matchProject(PROJECTS, "Acme/ops")?.id).toBe("mcp:infra");
    expect(matchProject(PROJECTS, "home_repo")?.id).toBe("mcp:agent-team");
    expect(matchProject(PROJECTS, "someone/else")).toBeUndefined();
  });
});

describe("kill switch", () => {
  it("makes sync, run-now and bootstrap no-ops and tells wakes to stop", async () => {
    const t = setup({ enabled: false });
    const { a } = await t.seed();
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    expect((await t.call("POST", `/api/assignments/${a.id}/run-now`)).json.error.code).toBe("cycle_disabled");
    const b = await t.call("POST", "/api/milestones/bootstrap", { repo: "home_repo", title: "X", goal: "Y", kind: "spine" });
    expect(b.status).toBe(409);
    const w = await t.call("POST", `/api/assignments/${a.id}/wake`);
    expect(w.text).toMatch(/kill switch/);
    expect(t.t3.calls).toEqual([]);
    // only the toggle line (switched on) is logged; no wake run.
    expect((await t.call("GET", "/api/runs")).json.map((r: any) => r.kind)).toEqual(["toggle"]);
    expect((await t.call("GET", "/api/milestones")).json).toHaveLength(1); // only the seeded one; bootstrap created none
  });
});

describe("assignment ↔ T3 scheduled task sync", () => {
  it("creates nothing in T3 while the assignment is disabled (the default)", async () => {
    const t = setup();
    const { a } = await t.seed();
    expect(a.enabled).toBe(false);
    // sync only reads (looks for stray tasks titled for it); it writes nothing
    expect(t.t3.calls.filter((c) => !c.op.startsWith("list"))).toEqual([]);
  });

  it("T8-S18: enable → no setup turn and no T3 task; nextRunAt from the cadence; edits, disable and pause only move it", async () => {
    const t = setup();
    const { a } = await t.seed();
    const on = (await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true })).json;
    expect(t.t3.calls.filter((c) => !c.op.startsWith("list"))).toEqual([]);
    expect(on.t3ScheduledTaskId).toBeUndefined();
    const due = Date.parse(on.nextRunAt) - Date.now();
    expect(due).toBeGreaterThan(119 * 60_000);
    expect(due).toBeLessThanOrEqual(120 * 60_000);
    expect((await t.settle(a.id)).syncState).toBe("synced");

    const fixed = { type: "fixed_time", timeOfDay: "09:30", weekdays: [1, 2, 3, 4, 5] };
    const moved = (await t.call("PATCH", `/api/assignments/${a.id}`, { cadence: fixed })).json;
    expect([new Date(moved.nextRunAt).getHours(), new Date(moved.nextRunAt).getMinutes()]).toEqual([9, 30]); // server-local time, any TZ
    const off = (await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: false })).json;
    expect(off.nextRunAt).toBeUndefined();
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    await t.call("PATCH", `/api/milestones/${a.milestoneId}`, { paused: true });
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.nextRunAt).toBeUndefined();
    expect(t.t3.calls.filter((c) => !c.op.startsWith("list"))).toEqual([]);
    expect((await t.call("DELETE", `/api/assignments/${a.id}`)).status).toBe(204);
  });

  it("T8-S18: sync deletes only tasks titled console:<id> (logged, idempotent); every other task stays", async () => {
    const t = setup();
    const { a } = await t.seed();
    const task = (id: string, title: string) =>
      t.t3.tasks.set(id, { id, title, enabled: true, projectId: "mcp:agent-team", prompt: "", schedule: {}, raw: {} });
    task("old", `console:${a.id} · reader → M2`);
    task("bare", `console:${a.id}`);
    task("other", "console:asg_someone_else");
    task("prefix", `console:${a.id}x`);
    task("mine", "daily digest");
    t.db.prepare("UPDATE assignments SET t3_scheduled_task_id = 'old' WHERE id = ?").run(a.id);
    const logs: string[] = [];
    const log = console.log;
    console.log = (...x: unknown[]) => void logs.push(x.join(" "));
    try {
      await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    } finally {
      console.log = log;
    }
    expect(t.t3.ops("deleteScheduledTask").map((c) => c.args.id).sort()).toEqual(["bare", "old"]);
    expect([...t.t3.tasks.keys()].sort()).toEqual(["mine", "other", "prefix"]);
    expect(logs.filter((l) => l.includes("deleted T3 scheduled task"))).toHaveLength(2);
    const after = (await t.call("GET", `/api/assignments/${a.id}`)).json;
    expect(after.t3ScheduledTaskId).toBeUndefined();
    expect(after.nextRunAt).toBeTruthy();
    // idempotent: a second sync finds nothing to delete
    await t.call("PATCH", `/api/assignments/${a.id}`, { cadence: { type: "interval", everyMinutes: 60 } });
    expect(t.t3.ops("deleteScheduledTask")).toHaveLength(2);
    expect(t.t3.ops("updateScheduledTask")).toEqual([]);
  });

  it("T8-S18: clearTasks at start syncs host1 / tracked assignments only and never wakes", async () => {
    const t = setup();
    const { a } = await t.seed();
    t.t3.tasks.set("old", { id: "old", title: `console:${a.id}`, enabled: true, projectId: "mcp:agent-team", prompt: "", schedule: {}, raw: {} });
    const store = createStore(t.db);
    const cycle = createCycle(t.db, store, { enabled: true, t3: t.t3, dispatcher: t.dispatcher, publicUrl: BASE });
    expect(await cycle.clearTasks()).toEqual([a.id]);
    expect(t.t3.tasks.has("old")).toBe(false);
    expect(await cycle.clearTasks()).toEqual([a.id]); // again: lists, deletes nothing
    expect(t.t3.ops("deleteScheduledTask")).toHaveLength(1);
    expect(t.t3.ops("launchThread")).toEqual([]);
    expect(t.t3.ops("sendToThread")).toEqual([]);
  });

  it("deleting an assignment deletes a leftover titled task", async () => {
    const t = setup();
    const { a } = await t.seed();
    t.t3.tasks.set("left", { id: "left", title: `console:${a.id}`, enabled: false, projectId: "mcp:agent-team", prompt: "", schedule: {}, raw: {} });
    expect((await t.call("DELETE", `/api/assignments/${a.id}`)).status).toBe(204);
    expect(t.t3.tasks.size).toBe(0);
  });

  it("T8-S18: Run now right after enabling launches the home thread (no setup turn, no setting_up 409)", async () => {
    const t = setup();
    const { a } = await t.seed();
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(r.status).toBe(201);
    expect(t.t3.ops("launchThread")).toHaveLength(1);
    expect(t.t3.ops("launchThread")[0].args.message).toContain(`/api/assignments/${a.id}/wake`);
    expect(t.t3.ops("launchThread")[0].args.message).not.toContain("schedule_task");
  });

  it("an unregistered repo needs no T3 task: sync succeeds (a wake would report the missing project)", async () => {
    const t = setup();
    const m = (await t.call("POST", "/api/milestones", { title: "x", repo: "nobody/nothing", path: "a.md" })).json;
    const p = (await t.call("POST", "/api/personas", { name: "p", remit: "r" })).json;
    const r = await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    expect(r.status).toBe(201);
    expect((await t.call("GET", `/api/assignments/${r.json.id}/cycle`)).json).toMatchObject({ syncState: "synced" });
  });

  it("a listing failure is a sync error and deletes nothing (the tracked id stays)", async () => {
    const t = setup();
    const { a } = await t.seed();
    t.db.prepare("UPDATE assignments SET t3_scheduled_task_id = 'tracked' WHERE id = ?").run(a.id);
    t.t3.listScheduledTasks = async () => {
      throw new Error("t3 down");
    };
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    expect((await t.call("GET", `/api/assignments/${a.id}/cycle`)).json).toMatchObject({ syncState: "error" });
    expect(t.t3.ops("deleteScheduledTask")).toEqual([]);
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.t3ScheduledTaskId).toBe("tracked");
  });
});

describe("run now + wake", () => {
  it("without a task: launches the wake in a home thread; the wake claims the placeholder run", async () => {
    const t = setup();
    const { a, m } = await t.seed();
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ outcome: "running", threadId: "thread_1", seat: "seat2" });
    const launch = t.t3.ops("launchThread")[0].args;
    expect(launch.message).toContain(`/api/assignments/${a.id}/wake`);

    // concurrency guard: a second run-now while the first runs
    const again = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("already_running");

    const w = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, {});
    expect(w.json.run.id).toBe(r.json.id);
    expect(w.json.prompt).toContain("read-only: report one sentence");
    expect(w.json.prompt).toContain(`/api/runs/${r.json.id}`);
    expect(w.json.prompt).toContain("$EPICSPINE_DISPATCHER pick");
    // commits carry a Run trailer (this wake's id; a child's id for its brief and on-behalf commits)
    expect(w.json.prompt).toContain(`\`Run: ${r.json.id}\``);
    expect(w.json.prompt).toContain("trailer line `Run: <child run id>`");
    expect(w.json.prompt).toContain("/api/needs-owner");
    expect(w.json.prompt).toContain(m.id);
    expect((await t.call("GET", "/api/runs")).json).toHaveLength(1);

    // a second run-now reuses the home thread
    await t.call("PATCH", `/api/runs/${r.json.id}`, { outcome: "idle", summary: "ok", endedAt: new Date().toISOString() });
    await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(t.t3.ops("launchThread")).toHaveLength(1);
    expect(t.t3.ops("sendToThread")[0].args.threadId).toBe("thread_1");
  });

  it("M2-37 steer: posts into the running run's thread as a steer, notes it on the run", async () => {
    const t = setup();
    const { a } = await t.seed();
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    const before = t.t3.ops("sendToThread").length;
    const s = await t.call("POST", `/api/assignments/${a.id}/steer`, { message: "  focus on E4 first  ", clientRequestId: "crid-1" });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ threadId: "thread_1", mode: "steer" });
    const sends = t.t3.ops("sendToThread");
    expect(sends).toHaveLength(before + 1);
    expect(sends[before].args).toMatchObject({ threadId: "thread_1", message: "focus on E4 first", clientRequestId: "crid-1", mode: "steer" });
    const run = (await t.call("GET", `/api/runs/${r.json.id}`)).json;
    expect(run.steers).toMatchObject([{ mode: "steer", message: "focus on E4 first" }]);
    expect(s.json.run.steers).toHaveLength(1);
  });

  it("T6-S4 steer notes live apart from the summary: a later persona PATCH cannot erase them", async () => {
    const t = setup();
    const { a } = await t.seed();
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    await t.call("POST", `/api/assignments/${a.id}/steer`, { message: "first" });
    await t.call("PATCH", `/api/runs/${r.json.id}`, { summary: "persona progress" });
    await t.call("POST", `/api/assignments/${a.id}/steer`, { message: "second" });
    await t.call("PATCH", `/api/runs/${r.json.id}`, { outcome: "progressed", summary: "done", endedAt: new Date().toISOString() });
    const run = (await t.call("GET", `/api/runs/${r.json.id}`)).json;
    expect(run.summary).toBe("done");
    expect(run.steers.map((x: { message: string }) => x.message)).toEqual(["first", "second"]);
    const listed = (await t.call("GET", `/api/runs?assignmentId=${a.id}`)).json.find((x: { id: string }) => x.id === r.json.id);
    expect(listed.steers).toHaveLength(2);
  });

  it("M2-37 steer: falls back to auto when T3 will not steer; 400 on empty; 409 when idle", async () => {
    const t = setup();
    const { a } = await t.seed();
    expect((await t.call("POST", `/api/assignments/${a.id}/steer`, { message: "hi" })).json.error.code).toBe("not_running");
    expect((await t.call("POST", `/api/assignments/${a.id}/steer`, { message: "hi" })).status).toBe(409);
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect((await t.call("POST", `/api/assignments/${a.id}/steer`, { message: "   " })).status).toBe(400);
    expect((await t.call("POST", `/api/assignments/${a.id}/steer`, {})).json.error.code).toBe("empty_message");
    t.t3.failSteer = true;
    const s = await t.call("POST", `/api/assignments/${a.id}/steer`, { message: "x".repeat(100) });
    expect(s.status).toBe(200);
    expect(s.json.mode).toBe("auto");
    const modes = t.t3.ops("sendToThread").slice(-2).map((c) => c.args.mode);
    expect(modes).toEqual(["steer", "auto"]);
    expect((await t.call("GET", `/api/runs/${r.json.id}`)).json.steers).toEqual([expect.objectContaining({ mode: "auto", message: "x".repeat(100) })]);
    await t.call("PATCH", `/api/runs/${r.json.id}`, { outcome: "idle", summary: "ok", endedAt: new Date().toISOString() });
    expect((await t.call("POST", `/api/assignments/${a.id}/steer`, { message: "late" })).status).toBe(409);
  });

  it("T8-S18: with a home thread, Run now posts the stub there (never a T3 scheduled task)", async () => {
    const t = setup();
    const { a } = await t.seed();
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    const r1 = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    await t.call("PATCH", `/api/runs/${r1.json.id}`, { outcome: "idle", summary: "ok", endedAt: new Date().toISOString() });
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(r.status).toBe(201);
    expect(r.json.threadId).toBe("thread_1");
    expect(t.t3.ops("sendToThread").at(-1)!.args).toMatchObject({ threadId: "thread_1" });
    expect(t.t3.ops("runScheduledTaskNow")).toEqual([]);
  });

  it("a scheduled wake while a run is still running is recorded as skipped idle", async () => {
    const t = setup({ treeFor: undefined }); // the fixture spine (M2) is all green: no park gate here;
    const { a } = await t.seed();
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    await t.settle(a.id);
    const w1 = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`);
    expect(w1.json.run.outcome).toBe("running");
    const w2 = await t.call("POST", `/api/assignments/${a.id}/wake`);
    expect(w2.text).toMatch(/still running/);
    const runs = (await t.call("GET", `/api/runs?assignmentId=${a.id}`)).json.filter((r: any) => r.kind !== "toggle");
    expect(runs.map((r: any) => r.outcome).sort()).toEqual(["idle", "running"]);
    expect(runs.find((r: any) => r.outcome === "idle").summary).toMatch(/^skipped/);
  });

  it("T6-S37: a reported run with no endedAt (old row) is not 'still running': the next wake starts", async () => {
    const t = setup({ treeFor: undefined });
    const { a } = await t.seed();
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    await t.settle(a.id);
    const w1 = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`);
    await t.call("PATCH", `/api/runs/${w1.json.run.id}`, { outcome: "progressed", summary: "dispatched E1" });
    t.db.prepare("UPDATE runs SET ended_at = NULL WHERE id = ?").run(w1.json.run.id); // as run_b15b6a47 was left before
    const w2 = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`);
    expect(w2.json.run.outcome).toBe("running");
    expect(w2.json.run.id).not.toBe(w1.json.run.id);
  });

  it("a stale running run no longer blocks: it is marked failed", async () => {
    const t = setup({ staleRunMs: 1000, treeFor: undefined }); // no park gate on the all-green fixture spine;
    const { a } = await t.seed();
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    await t.settle(a.id);
    const old = (await t.call("POST", "/api/runs", { assignmentId: a.id, startedAt: "2026-01-01T00:00:00.000Z" })).json;
    const w = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`);
    expect(w.json.run.id).not.toBe(old.id);
    expect((await t.call("GET", `/api/runs/${old.id}`)).json.outcome).toBe("failed");
  });

  it("notes a limited home-thread seat in the run summary and the prompt", async () => {
    const t = setup();
    const { a } = await t.seed();
    await t.call("POST", `/api/assignments/${a.id}/run-now`);
    const until = new Date(Date.now() + 3600_000).toISOString().slice(0, 19) + "Z"; // a past reset no longer counts
    fs.writeFileSync(
      path.join(t.dir, "seats.json"),
      JSON.stringify({ seats: { seat2: { logged_in: true, usage: { known: true, status: "limited", five_hour_pct: 100, limited_until: until } } } }),
    );
    const w = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, {});
    expect(w.json.run.summary).toContain(`seat seat2 limited until ${until}`);
    expect(w.json.prompt).toContain("the next wake moves to a new home thread on a seat with headroom"); // (was: no seat switch yet)
  });

  it("a wake for a disabled assignment records nothing", async () => {
    const t = setup();
    const { a } = await t.seed();
    const w = await t.call("POST", `/api/assignments/${a.id}/wake`);
    expect(w.text).toMatch(/disabled/);
    expect((await t.call("GET", "/api/runs")).json).toEqual([]);
  });

  it("T6-S46: no seat free is a deferred run (all seats busy, will retry), never a failed one", async () => {
    const t = setup();
    t.dispatcher.seat = null;
    const { a } = await t.seed();
    await t.call("POST", `/api/assignments/${a.id}/run-now`);
    const run = (await t.call("GET", "/api/runs")).json[0];
    expect(run.outcome).toBe("deferred");
    expect(run.summary).toMatch(/^Deferred: all seats busy or maxed, will retry/);
  });
});

// the Needs the owner follow-up (PATCH /needs-owner/:id → a decision message to the run's thread) is gone: an ask
// raised through the API is a spine ask, answered at its line, and the asker is woken with a pointer to it (pureCodeLineWaiting.test.ts).

describe("bootstrap", () => {
  it("creates a pending milestone + run, launches the agent in the repo's project, holds a seat until the run closes", async () => {
    const t = setup();
    const r = await t.call("POST", "/api/milestones/bootstrap", {
      repo: "Acme/ops",
      title: "E9 Backups",
      goal: "nightly offsite backups with restore drill",
      kind: "ticket",
    });
    expect(r.status).toBe(201);
    const { milestone, run } = r.json;
    expect(milestone).toMatchObject({ title: "E9 Backups", repo: "Acme/ops", path: "" });
    expect(run).toMatchObject({ milestoneId: milestone.id, outcome: "running", threadId: "thread_1", seat: "seat2" });
    const launch = t.t3.ops("launchThread")[0].args;
    expect(launch.projectId).toBe("mcp:infra");
    expect(launch.message).toContain("nightly offsite backups with restore drill");
    expect(launch.message).toContain(`/api/milestones/${milestone.id}`);
    expect(launch.message).toContain(`/api/runs/${run.id}`);
    expect(launch.message).toContain("AGENTS.md");
    expect(t.dispatcher.released).toEqual([]);
    expect((await t.call("GET", "/api/bootstraps")).json[0]).toMatchObject({ milestoneId: milestone.id, runId: run.id, kind: "ticket" });
    expect((await t.call("GET", `/api/runs?milestoneId=${milestone.id}`)).json).toHaveLength(1);
    // empty path while bootstrapping: plain defaults, no docError, empty backlog
    const got = (await t.call("GET", `/api/milestones/${milestone.id}`)).json;
    expect(got).toMatchObject({ path: "", status: "active", dod: { done: 0, total: 0 } });
    expect(got.docError).toBeUndefined();
    expect((await t.call("GET", `/api/milestones/${milestone.id}/backlog`)).json).toEqual([]);

    // the agent finishes: sets the path and closes the run → seat released
    await t.call("PATCH", `/api/milestones/${milestone.id}`, { path: "tickets/E9-backups.md" });
    await t.call("PATCH", `/api/runs/${run.id}`, { outcome: "progressed", summary: "created", endedAt: new Date().toISOString() });
    expect(t.dispatcher.released).toEqual([{ seat: "seat2", failed: false }]);
    expect((await t.call("GET", `/api/milestones/${milestone.id}`)).json.path).toBe("tickets/E9-backups.md");
  });

  it("validates input and unknown repos", async () => {
    const t = setup();
    expect((await t.call("POST", "/api/milestones/bootstrap", { repo: "x" })).status).toBe(400);
    const r = await t.call("POST", "/api/milestones/bootstrap", { repo: "nobody/nothing", title: "a", goal: "b", kind: "spine" });
    expect(r.json.error.code).toBe("unknown_project");
    expect((await t.call("GET", "/api/milestones")).json).toEqual([]);
  });

  it("a launch failure fails the run and releases the seat", async () => {
    const t = setup();
    t.t3.failLaunch = true;
    const r = await t.call("POST", "/api/milestones/bootstrap", { repo: "home_repo", title: "a", goal: "b", kind: "spine" });
    expect(r.status).toBe(502);
    expect((await t.call("GET", `/api/runs/${r.json.error.details.runId}`)).json.outcome).toBe("failed");
    expect(t.dispatcher.released).toEqual([{ seat: "seat2", failed: true }]);
  });
});

// ---------- auto-park ----------
type Leaf = { color: TreeColor; flags?: string[]; status?: string };
function tree(leaves: Leaf[], source: Tree["source"] = "spines"): Tree {
  const node = (l: Leaf, i: number): TreeNode => ({
    key: `n${i}`,
    id: `T-${i}`,
    kind: "ticket",
    title: `t${i}`,
    status: l.status ?? { green: "done", blue: "active", yellow: "blocked on T-1", red: "waiting on Sam", grey: "ready" }[l.color],
    color: l.color,
    children: [],
    flags: l.flags ?? [],
  });
  // Green root so the leaves decide.
  const root: TreeNode = { key: "root", id: "root", kind: "spine", title: "M", status: "done", color: "green", children: leaves.map(node), flags: [] };
  const counts = { grey: 0, blue: 0, yellow: 0, red: 0, green: 1 };
  for (const l of leaves) counts[l.color]++;
  return { milestoneId: "m", root, counts, nonGreen: 0, closed: 0, flagged: 0, source, warnings: source === "fallback" ? ["no spines"] : [] };
}

describe("auto-park predicate", () => {
  it("all green → park", () => {
    expect(parkDecision(tree([{ color: "green" }, { color: "green" }]))).toEqual({ park: true, reason: "all green" });
  });
  it("only red → park, waiting on Sam", () => {
    expect(parkDecision(tree([{ color: "green" }, { color: "red" }, { color: "red" }]))).toEqual({ park: true, reason: "waiting on Sam: 2 red" });
  });
  it("one blue → wake", () => {
    expect(parkDecision(tree([{ color: "red" }, { color: "blue" }]))).toEqual({ park: false, actionable: 1 });
  });
  it("flagged (dishonest green) → wake", () => {
    expect(parkDecision(tree([{ color: "green", flags: ["dishonest-green"] }]))).toEqual({ park: false, actionable: 1 });
  });
  it("closed (superseded) grey and reference nodes are not actionable", () => {
    const t = tree([{ color: "grey", status: "superseded by T-4" }, { color: "grey", flags: ["repeat"] }]);
    expect(parkDecision(t)).toEqual({ park: true, reason: "all green" });
  });
  it("tree error or fallback tree → wake", () => {
    expect(parkDecision(undefined)).toEqual({ park: false });
    expect(parkDecision(tree([{ color: "green" }], "fallback"))).toEqual({ park: false });
    expect(actionableCount(tree([{ color: "grey" }, { color: "yellow" }, { color: "red", flags: ["stale"] }]))).toBe(3);
  });
});

describe("auto-park wake gate + re-arm", () => {
  const enable = async (t: ReturnType<typeof setup>, id: string) => {
    await t.call("PATCH", `/api/assignments/${id}`, { enabled: true });
    await t.settle(id);
  };

  it("a cadence wake with nothing actionable parks: disabled, no next wake, run logged (Activity), no Needs Sam note (T6-S9)", async () => {
    let current = tree([{ color: "green" }, { color: "red" }]);
    const t = setup({ treeFor: async () => current });
    const { a } = await t.seed();
    await enable(t, a.id);
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.nextRunAt).toBeTruthy();

    const w = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, {});
    expect(w.json.prompt).toContain("parked: waiting on Sam: 1 red");
    expect(w.json.skipped).toBe(true);
    const after = (await t.call("GET", `/api/assignments/${a.id}`)).json;
    expect(after.enabled).toBe(false);
    expect(after.parkedReason).toBe("waiting on Sam: 1 red");
    expect(after.parkedAt).toBeTruthy();
    expect(after.nextRunAt).toBeUndefined();
    const runs = (await t.call("GET", "/api/runs")).json.filter((r: any) => r.kind !== "toggle"); // toggle lines aside
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "idle", summary: "parked: waiting on Sam: 1 red" });
    expect((await t.call("GET", "/api/needs-owner")).json).toEqual([]);
    // A note an older park raised (Needs the owner row on the park run) is not an inbox item: by type, the row is untouched.
    const store0 = createStore(t.db);
    const old = store0.createNeedsJordi({ milestoneId: after.milestoneId, runId: runs[0].id, question: "M2 parked: all green", proposedAction: "Nothing to do", status: "open" });
    expect(((await t.call("GET", "/api/waiting-on-owner")).json as any[]).some((i) => i.id === old.id)).toBe(false);
    expect(store0.getNeedsJordi(old.id)!.status).toBe("open");
    // A second wake (already parked) records nothing more.
    await t.call("POST", `/api/assignments/${a.id}/wake`);
    expect((await t.call("GET", "/api/needs-owner")).json).toHaveLength(1);

    // Actionable work appears → the re-arm check re-enables it.
    current = tree([{ color: "blue" }, { color: "red" }]);
    const store = createStore(t.db);
    const cycle = createCycle(t.db, store, { enabled: true, t3: t.t3, publicUrl: BASE, treeFor: async () => current });
    expect(await cycle.rearmParked()).toEqual([a.id]);
    const re = store.getAssignment(a.id)!;
    expect(re.enabled).toBe(true);
    expect(re.parkedAt).toBeUndefined();
    expect(re.nextRunAt).toBeTruthy();
    expect(store.listRuns({ assignmentId: a.id }).map((r) => r.summary)).toContain("re-armed: 1 actionable");
  });

  it("one actionable node wakes normally; a tree error wakes normally", async () => {
    const t = setup({ treeFor: async () => tree([{ color: "yellow" }]) });
    const { a } = await t.seed();
    await enable(t, a.id);
    const w = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, {});
    expect(w.json.run.outcome).toBe("running");

    const t2 = setup({
      treeFor: async () => {
        throw new Error("spine unreadable");
      },
    });
    const s2 = await t2.seed();
    await enable(t2, s2.a.id);
    const w2 = await t2.call("POST", `/api/assignments/${s2.a.id}/wake?format=json`, {});
    expect(w2.json.run.outcome).toBe("running");
  });

  it("run-now bypasses the gate", async () => {
    const t = setup({ treeFor: async () => tree([{ color: "green" }]) });
    const { a } = await t.seed();
    await enable(t, a.id);
    await t.call("POST", `/api/assignments/${a.id}/run-now`);
    const w = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, {});
    expect(w.json.run.summary).toBe("Run now: woke");
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.enabled).toBe(true);
  });

  it("re-arm leaves hand-disabled assignments alone; a manual toggle clears parkedAt", async () => {
    let current = tree([{ color: "green" }]);
    const t = setup({ treeFor: async () => current });
    const { a } = await t.seed();
    const store = createStore(t.db);
    // Parked by the gate, then the owner toggles it off by hand → no longer parked.
    await enable(t, a.id);
    await t.call("POST", `/api/assignments/${a.id}/wake`);
    expect(store.getAssignment(a.id)!.parkedAt).toBeTruthy();
    await t.call("PATCH", `/api/assignments/${a.id}`, { enabled: false });
    expect(store.getAssignment(a.id)!.parkedAt).toBeUndefined();

    current = tree([{ color: "blue" }]);
    const cycle = createCycle(t.db, store, { enabled: true, t3: t.t3, publicUrl: BASE, treeFor: async () => current });
    expect(await cycle.rearmParked()).toEqual([]);
    expect(store.getAssignment(a.id)!.enabled).toBe(false);
  });
});

describe("M2-21 settled milestone", () => {
  const enable = async (t: ReturnType<typeof setup>, id: string) => {
    await t.call("PATCH", `/api/assignments/${id}`, { enabled: true });
    await t.settle(id);
  };

  it("a wake on a settled milestone parks: no run, one log line, no Needs Sam; unsettle lets re-arm resume it", async () => {
    let current = tree([{ color: "blue" }]);
    const t = setup({ treeFor: async () => current });
    const { m, a } = await t.seed();
    await enable(t, a.id);
    // set the flag as settled.test.ts does. The route's outcome gate (pureEdits.test.ts) reads the live the code repo
    // checkout's m2 spine; in loaded full-file runs it answered 409 not_yet, the milestone stayed unsettled and the wake ran.
    createStore(t.db).setSettled(m.id, true);

    const w = await t.call("POST", `/api/assignments/${a.id}/wake?format=json`, {});
    expect(w.json.skipped).toBe(true);
    expect(w.json.prompt).toContain("parked: settled");
    const after = (await t.call("GET", `/api/assignments/${a.id}`)).json;
    expect(after).toMatchObject({ enabled: false, parkedReason: "settled" });
    expect(after.nextRunAt).toBeUndefined();
    const runs = (await t.call("GET", "/api/runs")).json.filter((r: any) => r.kind !== "toggle"); // toggle lines aside
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "idle", summary: "parked: settled" });
    expect((await t.call("GET", "/api/needs-owner")).json).toHaveLength(0);
    // the parked assignment does not make the milestone's verdict "parked"
    expect((await t.call("GET", `/api/milestones/${m.id}`)).json.verdict.word).not.toBe("parked");
    // a second wake logs nothing more
    await t.call("POST", `/api/assignments/${a.id}/wake`);
    expect((await t.call("GET", "/api/runs")).json.filter((r: any) => r.kind !== "toggle")).toHaveLength(1);

    // Settled: the re-arm check leaves it parked even with actionable work, and Run now is refused.
    const store = createStore(t.db);
    const cycle = createCycle(t.db, store, { enabled: true, t3: t.t3, publicUrl: BASE, treeFor: async () => current });
    expect(await cycle.rearmParked()).toEqual([]);
    expect((await t.call("POST", `/api/assignments/${a.id}/run-now`)).status).toBe(409);

    // Unsettled: the existing re-arm check resumes it.
    await t.call("POST", `/api/milestones/${m.id}/unsettle`);
    expect(await cycle.rearmParked()).toEqual([a.id]);
    expect(store.getAssignment(a.id)).toMatchObject({ enabled: true });
    expect(store.getAssignment(a.id)!.nextRunAt).toBeTruthy();
  });

  it("an unsettled all-green milestone stays parked with a fresh reason", async () => {
    const t = setup({ treeFor: async () => tree([{ color: "green" }]) });
    const { m, a } = await t.seed();
    await enable(t, a.id);
    createStore(t.db).setSettled(m.id, true); // as above
    await t.call("POST", `/api/assignments/${a.id}/wake`);
    await t.call("POST", `/api/milestones/${m.id}/unsettle`);
    const store = createStore(t.db);
    const cycle = createCycle(t.db, store, { enabled: true, t3: t.t3, publicUrl: BASE, treeFor: async () => tree([{ color: "green" }]) });
    expect(await cycle.rearmParked()).toEqual([]);
    expect(store.getAssignment(a.id)).toMatchObject({ enabled: false, parkedReason: "all green" });
  });
});
