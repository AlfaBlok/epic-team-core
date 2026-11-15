import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore, type Milestone } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";

/** the console scheduler follows the pursuit's rank: a top pursuit wakes faster, a parked one not at all. */
class FakeT3 implements T3Client {
  calls: string[] = [];
  private n = 0;
  async listProjects() { return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }]; }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  sent: string[] = [];
  async launchThread(...args: unknown[]) { this.calls.push("launchThread"); this.sent.push(JSON.stringify(args)); return { threadId: `thread_${++this.n}` }; }
  async sendToThread(...args: unknown[]) { this.calls.push("sendToThread"); this.sent.push(JSON.stringify(args)); }
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());
const node = (id: string, p: string, children: TreeNode[] = []): TreeNode => ({ key: id, id, kind: "spine", title: id, status: "active", color: "grey", path: p, children, flags: [] });

function setup(effort: { parked: boolean; wakeFactor: number; maxWorkers: number; minWakeMinutes?: number; pursuitName: string } | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-effort-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/epic.md"), "# EPIC\n## Current State\nNext action: S2\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const treeFor = async (): Promise<Tree> => ({ milestoneId: "m", root: node("PLAN-1", "docs/epic.md", [node("S1", "docs/epic.md")]), counts: { grey: 2, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 2, closed: 0, flagged: 0, source: "spines", warnings: [] });
  const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {}, async status() { return { name: "pool", capacity: 2, available: 0 }; } };
  const t3 = new FakeT3();
  const seen: Milestone[] = [];
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo, effortFor: (m) => (seen.push(m), effort), priorityFor: () => "## Priority (test)" });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  return { store, cycle, t3, a, seen };
}

describe("effort follows priority in the cadence scheduler ", () => {
  it("a top pursuit's milestone wakes twice as often: the next wake is 60 min out, not 120", async () => {
    const t = setup({ parked: false, wakeFactor: 2, maxWorkers: 10, minWakeMinutes: 15, pursuitName: "First testers" });
    t.store.updateAssignment(t.a.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
    const next = Date.parse(t.store.getAssignment(t.a.id)!.nextRunAt!);
    expect(next).toBeLessThan(Date.now() + 61 * 60_000);
    expect(next).toBeGreaterThan(Date.now() + 59 * 60_000);
  });

  it("a raised rank pulls a far-off wake in: last wake 70 min ago at the 2 h pace, now due at the 1 h pace", async () => {
    const t = setup({ parked: false, wakeFactor: 2, maxWorkers: 10, pursuitName: "First testers" });
    t.store.updateAssignment(t.a.id, { lastRunAt: new Date(Date.now() - 70 * 60_000).toISOString(), nextRunAt: new Date(Date.now() + 50 * 60_000).toISOString() });
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
  });

  it("a low pursuit's milestone wakes half as often: due now, next in 4 h", async () => {
    const t = setup({ parked: false, wakeFactor: 0.5, maxWorkers: 3, pursuitName: "Later" });
    t.store.updateAssignment(t.a.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
    expect(Date.parse(t.store.getAssignment(t.a.id)!.nextRunAt!)).toBeGreaterThan(Date.now() + 239 * 60_000);
  });

  it("a parked pursuit's milestone gets no cadence wake at all, and no T3 call", async () => {
    const t = setup({ parked: true, wakeFactor: 0, maxWorkers: 0, pursuitName: "Secrets kept" });
    t.store.updateAssignment(t.a.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    expect(t.store.listRuns({ assignmentId: t.a.id })).toHaveLength(0);
  });

  it("the wake prompt carries the rank's worker ceiling and the priority lines", async () => {
    const t = setup({ parked: false, wakeFactor: 0.5, maxWorkers: 3, pursuitName: "Later" });
    await t.cycle.runNow(t.a.id);
    const w = await t.cycle.wake(t.a.id, { threadId: "thread_1" });
    const prompt = JSON.stringify(w) + t.t3.sent.join("\n");
    expect(prompt).toContain("## Priority (test)");
    expect(prompt).toContain("Run at most 3 child workers at once for this milestone");
  });

  it("no pursuit: the pace as set (2 h)", async () => {
    const t = setup(null);
    t.store.updateAssignment(t.a.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
    expect(Date.parse(t.store.getAssignment(t.a.id)!.nextRunAt!)).toBeGreaterThan(Date.now() + 119 * 60_000);
  });
});
