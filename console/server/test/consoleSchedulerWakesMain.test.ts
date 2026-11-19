import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";

/**
 * the main server cadence wakes go through the console scheduler (tickCadence), like the worker server: the skip check runs before any T3
 * call, so a wake with nothing new costs no turn in the home thread; a real wake goes through Run now.
 */
class FakeT3 implements T3Client {
  calls: string[] = [];
  private n = 0;
  async listProjects() {
    this.calls.push("listProjects");
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { this.calls.push("listScheduledTasks"); return []; }
  async updateScheduledTask() { this.calls.push("updateScheduledTask"); return undefined; }
  async deleteScheduledTask() { this.calls.push("deleteScheduledTask"); }
  async runScheduledTaskNow() { this.calls.push("runScheduledTaskNow"); }
  async launchThread() { this.calls.push("launchThread"); return { threadId: `thread_${++this.n}` }; }
  async sendToThread() { this.calls.push("sendToThread"); }
  async readThreadStatus() { this.calls.push("readThreadStatus"); return { status: "idle", raw: {} }; }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const node = (id: string, p: string, children: TreeNode[] = []): TreeNode => ({
  key: id, id, kind: "spine", title: id, status: "active", color: "grey", path: p, children, flags: [],
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s18-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/epic.md"), "# EPIC\n## Current State\nNext action: S2\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const treeFor = async (): Promise<Tree> => ({
    milestoneId: "m",
    root: node("PLAN-1", "docs/epic.md", [node("S1", "docs/epic.md")]),
    counts: { grey: 2, blue: 0, yellow: 0, red: 0, green: 0 },
    nonGreen: 2, closed: 0, flagged: 0, source: "spines", warnings: [],
  });
  const disp = {
    async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; },
    async done() {},
    async status() { return { name: "pool", capacity: 2, available: 0 }; },
  };
  const t3 = new FakeT3();
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const due = () => store.updateAssignment(a.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  const nextRun = () => Date.parse(store.getAssignment(a.id)!.nextRunAt!);
  const top = () => store.listRuns({ assignmentId: a.id }).filter((r) => !r.parentRunId);
  /** The woken persona: the stub's /wake claims the run; it then finishes idle (run-end hook stamps the baseline). */
  const persona = async () => {
    const w = await cycle.wake(a.id, { threadId: "thread_1" });
    store.updateRun(w.run!.id, { outcome: "idle", endedAt: new Date(Date.now() + 1).toISOString() });
    cycle.runEnded(w.run!.id);
    await cycle.settled();
    return w;
  };
  return { store, cycle, t3, m, p, a, due, nextRun, top, persona };
}

describe("T8-S18 console scheduler wakes host1 personas", () => {
  it("a due host1 assignment: real wake goes through Run now (home thread launched), nextRunAt advances", async () => {
    const t = setup();
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
    expect(t.t3.calls).toContain("launchThread");
    expect(t.t3.calls).not.toContain("runScheduledTaskNow");
    expect(t.nextRun()).toBeGreaterThan(Date.now() + 119 * 60_000);
    expect(t.top()[0]).toMatchObject({ outcome: "running", summary: "Cadence wake: waiting for the persona to wake", threadId: "thread_1" });
    const w = await t.persona();
    expect(w.run!.summary).toMatch(/^Woke on cadence( · woke: |$)/);
  });

  it("nothing new since the last real wake: skipped with no T3 call at all, nextRunAt advances; the next wake posts to the home thread", async () => {
    const t = setup();
    t.due();
    await t.cycle.tickCadence();
    await t.persona();
    t.t3.calls = [];
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    expect(t.nextRun()).toBeGreaterThan(Date.now() + 119 * 60_000);
    expect(t.top()[0]).toMatchObject({ outcome: "idle", threadId: "thread_1" });
    expect(t.top()[0].summary).toMatch(/^skipped: nothing new since /);

    // something changed (a child run ended): a real wake, the stub goes to the existing home thread
    t.store.createRun({ assignmentId: t.a.id, parentRunId: t.top()[1].id, outcome: "progressed", summary: "worker", endedAt: new Date(Date.now() + 5).toISOString() });
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
    expect(t.t3.calls).toEqual(["readThreadStatus", "sendToThread"]); // the home thread's size is read before the post
  });

  it("disabled assignments and paused or settled milestones do not wake (no T3 call, no run)", async () => {
    const t = setup();
    t.due();
    t.store.updateAssignment(t.a.id, { enabled: false });
    expect(await t.cycle.tickCadence()).toEqual([]);
    t.store.updateAssignment(t.a.id, { enabled: true });
    t.store.updateMilestone(t.m.id, { paused: true });
    expect(await t.cycle.tickCadence()).toEqual([]);
    t.store.updateMilestone(t.m.id, { paused: false });
    t.store.setSettled(t.m.id, true);
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    expect(t.top()).toEqual([]);
  });

  it("a wake still running: the tick advances nextRunAt and sends nothing", async () => {
    const t = setup();
    t.due();
    await t.cycle.tickCadence();
    t.t3.calls = [];
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    expect(t.nextRun()).toBeGreaterThan(Date.now() + 119 * 60_000);
  });
});
