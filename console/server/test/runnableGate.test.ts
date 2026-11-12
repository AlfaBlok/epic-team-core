import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle, type RunState } from "../src/cycle/service.js";
import { runStateFor } from "../src/cycle/runState.js";
import { RUNNABLE_RULE } from "../src/wakePrompt.js";
import type { SpinesJson } from "../src/adapters/spines.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";

/**
 * a wake works only what is runnable. The spine's run_state (spines.py --json) gates cadence ticks,
 * timed wakes and wakes the console did not start; a confirmed Run now proceeds; an unknown run_state wakes as before.
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

function setup(state: () => Promise<RunState | undefined>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e14s2-"));
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
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo, runState: state });
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


const is = (state: string, runnable: boolean) => async (): Promise<RunState> => ({ state, runnable });

describe("T14-S2 runnable gate", () => {
  for (const state of ["planning", "parked", "finished"]) {
    it(`cadence tick on a ${state} spine: no run started, no T3 call, one run-log line "skipped: ${state}"`, async () => {
      const t = setup(is(state, false));
      t.due();
      expect(await t.cycle.tickCadence()).toEqual([]);
      expect(t.t3.calls).toEqual([]);
      expect(t.top()).toHaveLength(1);
      expect(t.top()[0]).toMatchObject({ outcome: "idle", summary: `skipped: ${state}` });
      expect(t.top()[0].endedAt).toBeTruthy();
      expect(t.nextRun()).toBeGreaterThan(Date.now() + 119 * 60_000);
      t.due();
      expect(await t.cycle.tickCadence()).toEqual([]);
      expect(t.top()).toHaveLength(1); // not repeated while it is the newest line
    });
  }

  for (const state of ["ready", "running"]) {
    it(`cadence tick on a ${state} spine wakes as before`, async () => {
      const t = setup(is(state, true));
      t.due();
      expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
      expect(t.t3.calls).toContain("launchThread");
      expect(t.top()[0]).toMatchObject({ outcome: "running", summary: "Cadence wake: waiting for the persona to wake" });
    });
  }

  it("run_state absent (older skill) or unreadable: wakes as before and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = setup(async () => undefined);
      t.due();
      expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
      await t.persona();
      t.store.createRun({ assignmentId: t.a.id, parentRunId: t.top()[0].id, outcome: "progressed", summary: "worker", endedAt: new Date(Date.now() + 5).toISOString() });
      t.due();
      expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("run_state unknown"))).toHaveLength(1);
      const t2 = setup(async () => { throw new Error("spines.py failed"); });
      t2.due();
      expect(await t2.cycle.tickCadence()).toEqual([t2.a.id]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a wake the console did not start (home thread / T3 task) on a planning spine: idle prompt, skipped line, no running run", async () => {
    const t = setup(is("planning", false));
    const w = await t.cycle.wake(t.a.id, { threadId: "thread_x" });
    expect(w.skipped).toBe(true);
    expect(w.prompt).toMatch(/skipped: planning/);
    expect(w.run).toMatchObject({ outcome: "idle", summary: "skipped: planning" });
    expect(t.top().filter((r) => r.outcome === "running")).toEqual([]);
  });

  it("a confirmed Run now on a planning spine proceeds one-off: the persona's wake claims it with the full prompt", async () => {
    const t = setup(is("planning", false));
    const run = await t.cycle.runNow(t.a.id);
    expect(run.outcome).toBe("running");
    const w = await t.cycle.wake(t.a.id, { threadId: "thread_1" });
    expect(w.run!.id).toBe(run.id);
    expect(w.run!.summary).toBe("Run now: woke");
    expect(w.prompt).toContain(RUNNABLE_RULE);
  });

  it("a timed wake (retryAt) on a spine that became planning: dropped, skipped line, no T3 call", async () => {
    const t = setup(is("planning", false));
    t.store.updateAssignment(t.a.id, { retryAt: new Date(Date.now() - 1000).toISOString() });
    expect(await t.cycle.tickRetry()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    expect(t.store.getAssignment(t.a.id)!.retryAt).toBeFalsy();
    expect(t.top()[0]).toMatchObject({ outcome: "idle", summary: "skipped: planning" });
  });
});

describe("T14-S2 runStateFor", () => {
  const spines = (node: Record<string, unknown>): SpinesJson =>
    ({ root: "docs/root.md", nodes: [{ id: "E", path: "docs/epic.md", title: "E", parent: null, status: "draft", rollup_status: "draft", dod: [], children: [], ...node }], orphans: [], mismatches: [] }) as SpinesJson;
  it("reads run_state / runnable; absent field or node = undefined", () => {
    expect(runStateFor(spines({ run_state: "planning", runnable: false }), "docs/epic.md")).toEqual({ state: "planning", runnable: false });
    expect(runStateFor(spines({ run_state: "running" }), "docs/epic.md")).toEqual({ state: "running", runnable: true });
    expect(runStateFor(spines({}), "docs/epic.md")).toBeUndefined();
    expect(runStateFor(spines({ run_state: "ready", runnable: true }), "docs/other.md")).toBeUndefined();
  });
});
