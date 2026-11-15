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
 * The owner ( 2026-11-14: "don't objectives have perdonas that wake up on the regular?"): the milestone's
 * Delivery Manager wake reads its objectives below green, and while one is idle its cadence wake is never skipped.
 */
class FakeT3 implements T3Client {
  ranTasks = 0;
  sent = 0;
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() { this.ranTasks++; }
  async launchThread() { return { threadId: "t" }; }
  async sendToThread() { this.sent++; }
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const node = (id: string, p: string, extra: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key: id, id, kind: "spine", title: id, status: "active", color: "grey", path: p, children, flags: [], ...extra,
});

function setup(o: { name?: string; skipUnchanged?: boolean } = {}) {
  const obj = { idle: [] as string[], section: undefined as string | undefined };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e40s34-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/epic.md"), "# EPIC\n## Current State\nNext action: S2\n");
  fs.writeFileSync(path.join(repo, "docs/child.md"), "# child\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const state = { ready: false, available: 0, todo: "## To do\n- S2 ready" };
  const treeFor = async (): Promise<Tree> => ({
    milestoneId: "m",
    root: node("PLAN-1", "docs/epic.md", {}, [node("S1", "docs/child.md"), node("S2", "", { kind: "ticket", ...(state.ready ? { ready: true } : {}) })]),
    counts: { grey: 3, blue: 0, yellow: 0, red: 0, green: 0 },
    nonGreen: 3, closed: 0, flagged: 0, source: "spines", warnings: [],
  });
  const disp = {
    async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; },
    async done() {},
    async status() { return { name: "pool", capacity: 2, available: state.available }; },
  };
  const t3 = new FakeT3();
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => state.todo, repoDir: () => repo, objectives: async () => ({ ...obj }) });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
  const p = store.createPersona({ name: o.name ?? "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true, ...(o.skipUnchanged === undefined ? {} : { skipUnchanged: o.skipUnchanged }) });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const newest = () => store.listRuns({ assignmentId: a.id }).find((r) => !r.parentRunId)!;
  /** The scheduled task's /wake (a cadence wake): real when it records a running run. */
  const cadence = async () => {
    const w = await cycle.wake(a.id, { threadId: "home" });
    return { ...w, real: w.run?.outcome === "running" };
  };
  /** Finish the newest wake the way the persona does (PATCH with endedAt → run-end hook). */
  const finish = async (outcome: "idle" | "progressed" | "failed" | "blocked" = "idle", edit?: () => void) => {
    const r = newest();
    edit?.();
    store.updateRun(r.id, { outcome, endedAt: new Date(Date.now() + 1).toISOString() });
    cycle.runEnded(r.id);
    await cycle.settled();
    return r;
  };
  const child = (summary: string, outcome: "running" | "progressed" = "running") =>
    store.createRun({ assignmentId: a.id, parentRunId: newest().id, outcome, summary, ...(outcome === "running" ? {} : { endedAt: new Date(Date.now() + 5).toISOString() }) });
  return { db, store, cycle, t3, state, obj, repo, m, a, p, cadence, finish, child, newest };
}

describe("objectives in the regular Delivery Manager wake", () => {
  it("an idle objective is news: the cadence wake runs instead of 'nothing new', and says why", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    expect((await t.cadence()).real).toBe(false); // nothing new, no objective idle
    t.obj.idle = ["bitwarden"];
    t.obj.section = "## Objectives of this milestone below green\n- [objective bitwarden] Bitwarden: idle";
    const w = await t.cadence();
    expect(w.real).toBe(true);
    expect(t.newest().wokeBecause).toMatch(/objective below green with nothing moving: bitwarden/);
    expect(w.prompt).toContain("[objective bitwarden]");
    const check = await t.cycle.wakeCheck(t.a.id);
    expect(check).toMatchObject({ wouldSkip: false, idleObjectives: ["bitwarden"] });
  });
  it("once it moves (no idle objective), the usual skip rule is back", async () => {
    const t = setup();
    t.obj.idle = ["bitwarden"];
    await t.cadence();
    await t.finish("progressed");
    t.obj.idle = [];
    expect((await t.cadence()).real).toBe(false);
  });
  it("another persona of the milestone neither gets the section nor stops skipping", async () => {
    const t = setup({ name: "Strategist" });
    t.obj.idle = ["bitwarden"];
    t.obj.section = "## Objectives of this milestone below green";
    const w = await t.cadence();
    expect(w.prompt).not.toContain("## Objectives of this milestone");
    await t.finish();
    expect((await t.cadence()).real).toBe(false);
  });
});
