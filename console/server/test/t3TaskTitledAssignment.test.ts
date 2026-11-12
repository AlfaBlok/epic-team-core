import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client, T3ScheduledTask } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";

/**
 * a parked assignment kept waking because T3 held an untracked duplicate task titled `console:<id>`.
 * the console scheduler wakes every host, so sync deletes every task titled for the assignment (the main server too).
 */
type Task = T3ScheduledTask & { projectId: string };
class FakeT3 implements T3Client {
  tasks = new Map<string, Task>();
  deleted: string[] = [];
  failDelete = new Set<string>();
  private n = 0;
  add(title: string, enabled = true, projectId = "proj") {
    const id = `task_${++this.n}`;
    this.tasks.set(id, { id, title, enabled, projectId, raw: {} });
    return id;
  }
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks(projectId: string) {
    return [...this.tasks.values()].filter((t) => t.projectId === projectId).map((t) => ({ ...t }));
  }
  async updateScheduledTask(id: string, patch: any) {
    this.updates.push(id);
    const t = this.tasks.get(id);
    if (!t) throw new Error(`no task ${id}`);
    Object.assign(t, patch);
    return { ...t, nextRunAt: t.enabled ? "2026-10-25T10:00:00.000Z" : undefined };
  }
  async deleteScheduledTask(id: string) {
    if (this.failDelete.has(id)) throw new Error("delete refused");
    this.deleted.push(id);
    this.tasks.delete(id);
  }
  async runScheduledTaskNow() {}
  updates: string[] = [];
  async launchThread() {
    return { threadId: `thread_${++this.n}` };
  }
  async sendToThread() {}
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup(host: "host1" | "host3" = "host1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s21-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new FakeT3();
  const store = createStore(db);
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", });
  cleanup = () => {
    cycle.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery Manager", remit: "r", skills: [], model: "sonnet", mayWrite: false, host });
  const mk = (enabled: boolean) => store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled });
  return { store, cycle, t3, m, p, mk };
}
const live = (t3: FakeT3) => [...t3.tasks.values()].filter((t) => t.enabled);

describe("E906-S21 every T3 task titled for an assignment is reconciled", () => {
  it("parked assignment with two title-matching tasks: both deleted, so nothing wakes it", async () => {
    const s = setup();
    const a = s.mk(false);
    s.store.updateAssignment(a.id, { parkedAt: new Date().toISOString(), parkedReason: "all green" });
    s.t3.add(`console:${a.id} · Delivery Manager → M`);
    s.t3.add(`console:${a.id}`);
    await s.cycle.sync(a.id);
    expect(s.t3.tasks.size).toBe(0);
    expect(s.store.getAssignment(a.id)!.t3ScheduledTaskId).toBeUndefined();
    expect(s.store.getAssignment(a.id)!.nextRunAt).toBeUndefined();
  });

  it("host1 live assignment: tracked and untracked titled tasks go; nextRunAt comes from the cadence", async () => {
    const s = setup();
    const a = s.mk(true);
    const tracked = s.t3.add(`console:${a.id} · Delivery Manager → M`);
    const dup = s.t3.add(`console:${a.id}`);
    s.store.updateAssignment(a.id, { t3ScheduledTaskId: tracked });
    await s.cycle.sync(a.id);
    expect(s.t3.deleted.sort()).toEqual([tracked, dup].sort());
    expect(s.store.getAssignment(a.id)!.t3ScheduledTaskId).toBeUndefined();
    expect(Date.parse(s.store.getAssignment(a.id)!.nextRunAt!)).toBeGreaterThan(Date.now() + 119 * 60_000);
    expect(s.cycle.getLink(a.id)).toMatchObject({ syncState: "synced" });
  });

  it("a task that will not delete is paused instead, and deleted on the next sync", async () => {
    const s = setup();
    const a = s.mk(false);
    const x = s.t3.add(`console:${a.id}`);
    const y = s.t3.add(`console:${a.id}`);
    s.t3.failDelete.add(y);
    await s.cycle.sync(a.id);
    expect(s.t3.deleted).toEqual([x]);
    expect(live(s.t3)).toEqual([]);
    s.t3.failDelete.clear();
    await s.cycle.sync(a.id);
    expect(s.t3.tasks.size).toBe(0);
  });

  it("the wake of a disabled assignment deletes the task that woke it", async () => {
    const s = setup();
    const a = s.mk(false);
    s.t3.add(`console:${a.id} · Delivery Manager → M`);
    const r = await s.cycle.wake(a.id);
    expect(r.prompt).toContain("disabled in the console");
    expect(r.run).toBeUndefined();
    await s.cycle.settled();
    expect(s.t3.tasks.size).toBe(0);
  });

  it("a task of another assignment whose id starts with this id is never touched", async () => {
    const s = setup();
    const a = s.mk(false);
    const other = s.t3.add(`console:${a.id}0 · Other → M`);
    const other2 = s.t3.add(`console:${a.id}-x`);
    await s.cycle.sync(a.id);
    expect(s.t3.tasks.get(other)).toMatchObject({ enabled: true });
    expect(s.t3.tasks.get(other2)).toMatchObject({ enabled: true });
    expect(s.t3.deleted).toEqual([]);
    expect(s.store.getAssignment(a.id)!.t3ScheduledTaskId).toBeUndefined();
  });

  it("host3 persona: every title-matching task on HOST1 goes, not only the tracked id", async () => {
    const s = setup("host3");
    const a = s.mk(true);
    const tracked = s.t3.add(`console:${a.id} · Delivery Manager → M`);
    const dup = s.t3.add(`console:${a.id}`);
    const other = s.t3.add(`console:${a.id}0`);
    s.store.updateAssignment(a.id, { t3ScheduledTaskId: tracked });
    await s.cycle.sync(a.id);
    expect([...s.t3.tasks.keys()]).toEqual([other]);
    expect(s.t3.deleted.sort()).toEqual([tracked, dup].sort());
    expect(s.store.getAssignment(a.id)!.t3ScheduledTaskId).toBeUndefined();
    expect(s.store.getAssignment(a.id)!.nextRunAt).toBeDefined(); // the console scheduler wakes it
  });

  it("host3 persona: a tracked task that will not delete keeps its id (retried next sync)", async () => {
    const s = setup("host3");
    const a = s.mk(true);
    const tracked = s.t3.add(`console:${a.id}`);
    s.store.updateAssignment(a.id, { t3ScheduledTaskId: tracked });
    s.t3.failDelete.add(tracked);
    await s.cycle.sync(a.id);
    expect(s.store.getAssignment(a.id)!.t3ScheduledTaskId).toBe(tracked);
    expect(s.t3.tasks.get(tracked)).toMatchObject({ enabled: false }); // paused meanwhile
    s.t3.failDelete.clear();
    await s.cycle.sync(a.id);
    expect(s.t3.tasks.size).toBe(0);
    expect(s.store.getAssignment(a.id)!.t3ScheduledTaskId).toBeUndefined();
  });

  it("listing failure: nothing deleted; the tracked task is paused and keeps its id", async () => {
    const s = setup();
    const a = s.mk(true);
    const tracked = s.t3.add(`console:${a.id}`);
    s.store.updateAssignment(a.id, { t3ScheduledTaskId: tracked });
    s.t3.listScheduledTasks = async () => {
      throw new Error("T3 down");
    };
    await s.cycle.sync(a.id).catch(() => undefined);
    expect(s.t3.deleted).toEqual([]);
    expect(s.t3.tasks.get(tracked)).toMatchObject({ enabled: false });
    expect(s.store.getAssignment(a.id)!.t3ScheduledTaskId).toBe(tracked);
    expect(s.cycle.getLink(a.id)).toMatchObject({ syncState: "error" });
  });
});
