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
 * a plan's wake limit (the hosted cap of customer workspaces on a limited plan) is checked before every wake: a capped
 * cadence tick or timed wake starts nothing (no run row, no T3 call), Run now refuses 409 wake_cap and keeps its note.
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

function setup(capped: { why?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e46s149-"));
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
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo, wakeCap: () => capped.why });
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

describe("the engine holds a capped wake", () => {
  it("a due cadence wake under its cap wakes; over it nothing starts and nextRunAt still advances", async () => {
    const cap: { why?: string } = {};
    const t = setup(cap);
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
    await t.persona();
    const before = t.top().length;
    const calls = t.t3.calls.length;
    cap.why = "this plan allows the campaign manager at most 2 wakes a day: 2 today already. It wakes again tomorrow.";
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.top().length).toBe(before); // no run row
    expect(t.t3.calls.length).toBe(calls); // no T3 call
    expect(t.nextRun()).toBeGreaterThan(Date.now() + 119 * 60_000);
  });

  it("a timed wake over its cap stays pending until the cap frees", async () => {
    const cap: { why?: string } = { why: "capped" };
    const t = setup(cap);
    const at = new Date(Date.now() - 1000).toISOString();
    t.store.updateAssignment(t.a.id, { retryAt: at });
    expect(await t.cycle.tickRetry()).toEqual([]);
    expect(t.store.getAssignment(t.a.id)!.retryAt).toBe(at);
    cap.why = undefined;
    expect(await t.cycle.tickRetry()).toEqual([t.a.id]);
  });

  it("Run now over its cap refuses 409 wake_cap and holds the note for the next allowed wake", async () => {
    const cap: { why?: string } = { why: "this plan allows the campaign manager at most 2 wakes a day: 2 today already. It wakes again tomorrow." };
    const t = setup(cap);
    await expect(t.cycle.runNow(t.a.id, { instructions: "please check the plan", instructionsBy: "a customer" })).rejects.toMatchObject({ status: 409, code: "wake_cap" });
    expect(t.top()).toEqual([]);
    cap.why = undefined;
    const run = await t.cycle.runNow(t.a.id);
    expect(run.instructions).toContain("please check the plan");
  });
});
