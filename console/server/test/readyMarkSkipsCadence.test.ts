import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { readyToMarkOf, settleOnMark } from "../src/status/autoSettle.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import type { Outcome } from "../src/adapters/spines.js";

/**
 * a finished goal stops spending wakes. the owner's mark (Accomplished / Partially / Superseded) settles the
 * milestone; a milestone waiting for his mark (Ready to mark) skips cadence and timed wakes; Run now still wakes.
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

function setup(readyToMark: () => Promise<boolean>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s8-"));
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
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo, readyToMark });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const due = () => store.updateAssignment(a.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  const top = () => store.listRuns({ assignmentId: a.id }).filter((r) => !r.parentRunId);
  return { store, cycle, t3, m, a, due, top };
}

describe("T6-S8 Ready to mark skips cadence and timed wakes", () => {
  it("cadence tick: no run, no T3 call, one 'skipped: ready to mark' line (not repeated); the assignment stays on", async () => {
    const t = setup(async () => true);
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    expect(t.top()).toHaveLength(1);
    expect(t.top()[0]).toMatchObject({ outcome: "idle", summary: "skipped: ready to mark" });
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.top()).toHaveLength(1);
    expect(t.store.getAssignment(t.a.id)!.enabled).toBe(true); // not parked: a Not accomplished mark resumes wakes
  });

  it("timed wake (retryAt): dropped with the same line", async () => {
    const t = setup(async () => true);
    t.store.updateAssignment(t.a.id, { retryAt: new Date(Date.now() - 1000).toISOString() });
    expect(await t.cycle.tickRetry()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    expect(t.store.getAssignment(t.a.id)!.retryAt).toBeFalsy();
    expect(t.top()[0]).toMatchObject({ outcome: "idle", summary: "skipped: ready to mark" });
  });

  it("Run now still wakes a Ready to mark milestone", async () => {
    const t = setup(async () => true);
    const run = await t.cycle.runNow(t.a.id);
    expect(run.outcome).toBe("running");
    expect(t.t3.calls).toContain("launchThread");
  });

  it("not ready to mark, or the check fails: wakes as before", async () => {
    const t = setup(async () => false);
    t.due();
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
    const t2 = setup(async () => { throw new Error("spines.py slow"); });
    t2.due();
    expect(await t2.cycle.tickCadence()).toEqual([t2.a.id]);
  });
});

describe("T6-S8 readyToMarkOf", () => {
  const outcome = (verdict: string | null, closedBy: string | null = "Sam (console)"): Outcome => ({ verdict, sentence: "x", evidence: [{ doneMeans: "E-1", links: ["a"] }], risk: null, closedAt: null, closedBy }) as unknown as Outcome;
  it("true only for an Outcome with evidence, every Done means ticked and no verdict", async () => {
    const all = { doctrine: { doneMeans: [{ done: true }, { done: true }] } };
    expect(await readyToMarkOf(async () => ({ ...all, outcome: outcome(null) }))({} as never)).toBe(true);
    expect(await readyToMarkOf(async () => ({ ...all, outcome: outcome("accomplished") }))({} as never)).toBe(false);
    // a Verdict an agent wrote is not the owner's mark: still Ready to mark.
    expect(await readyToMarkOf(async () => ({ ...all, status: "active", outcome: outcome("accomplished", "run_d6cad26e") }))({} as never)).toBe(true);
    expect(await readyToMarkOf(async () => ({ doctrine: { doneMeans: [{ done: true }, { done: false }] }, outcome: outcome(null) }))({} as never)).toBe(false);
    expect(await readyToMarkOf(async () => ({ ...all, outcome: null }))({} as never)).toBe(false);
  });
});

describe("T6-S8 settleOnMark", () => {
  const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s8m-"));
    const db = openDb(path.join(dir, "c.db"));
    cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    const store = createStore(db);
    return { store, m: store.createMilestone({ title: "M", repo: "r", path: "docs/e.md", owner: "", paused: false }) };
  };
  it("settles when the status reads Sam's verdict (accomplished, partially, superseded)", async () => {
    for (const v of ["accomplished", "partially", "superseded"] as const) {
      const { store, m } = mk();
      expect(await settleOnMark(store, m, v, v)).toBe(true);
      expect(store.getMilestone(m.id)!.settledAt).toBeTruthy();
      cleanup!();
    }
  });
  it("does not settle Not accomplished, a Reopened read-back, a stale read, or an already settled milestone", async () => {
    const { store, m } = mk();
    expect(await settleOnMark(store, m, "not_accomplished", "not_yet")).toBe(false);
    expect(await settleOnMark(store, m, "accomplished", "reopened")).toBe(false);
    expect(await settleOnMark(store, m, "accomplished", "ready_to_mark")).toBe(false);
    expect(await settleOnMark(store, m, "partially", "accomplished")).toBe(false);
    expect(store.getMilestone(m.id)!.settledAt).toBeFalsy();
    store.setSettled(m.id, true);
    const first = store.getMilestone(m.id)!.settledAt;
    expect(await settleOnMark(store, m, "accomplished", "accomplished")).toBe(false);
    expect(store.getMilestone(m.id)!.settledAt).toBe(first);
  });
});
