import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle, ORPHAN_CHECK_MS, ORPHAN_REWAKE_MS, type RunState } from "../src/cycle/service.js";

/**
 * the orphan sweep wakes the repo's home milestone's
 * Delivery Manager past the runnable gate (a finished or parked spine), once per new orphan, again only after the re-wake
 * gap; a fresh orphan gets its grace; a milestone with no Delivery Manager is not woken.
 */
class FakeT3 implements T3Client {
  calls: string[] = [];
  private n = 0;
  async listProjects() { return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }]; }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { this.calls.push("launchThread"); return { threadId: `thread_${++this.n}` }; }
  async sendToThread() { this.calls.push("sendToThread"); }
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const SECTION = "## Commits that name no ticket (T63-S7)\n- skill fee7d83 …";

function setup(o: { persona?: string; orphans: () => Array<{ short: string; date: string }> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e63s16-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/PLAN-0.md"), "# PLAN-0\n## Current State\nStatus: done\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {}, async status() { return { name: "pool", capacity: 2, available: 1 }; } };
  const t3 = new FakeT3();
  let mid = "";
  const cycle = createCycle(db, store, {
    enabled: true, t3, dispatcher: disp, publicUrl: "http://x", repoDir: () => repo,
    runState: async (): Promise<RunState> => ({ state: "finished", runnable: false }),
    orphanCommits: async (m) => (m.id === mid ? SECTION : undefined),
    orphansDue: async () => o.orphans().map((c) => ({ milestoneId: mid, ...c })),
  });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "EpicSpine", repo: "home_repo", path: "docs/PLAN-0.md", owner: "", paused: false });
  mid = m.id;
  const p = store.createPersona({ name: o.persona ?? "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 720 }, enabled: true });
  const top = () => store.listRuns({ assignmentId: a.id }).filter((r) => !r.parentRunId);
  return { store, cycle, t3, a, top };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("T63-S16 orphan sweep", () => {
  it("a finished home milestone: the cadence wake skips, the sweep wakes its Delivery Manager and the wake carries the section", async () => {
    const t = setup({ orphans: () => [{ short: "fee7d83", date: ago(2.5 * 86_400_000) }] });
    t.store.updateAssignment(t.a.id, { nextRunAt: ago(1000) });
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.top()[0]).toMatchObject({ outcome: "idle", summary: "skipped: finished" });
    expect(await t.cycle.tickOrphans()).toEqual([t.a.id]);
    expect(t.t3.calls).toContain("launchThread");
    const run = t.top().find((r) => r.outcome === "running")!;
    expect(run).toMatchObject({ wokeBecause: "orphan commits: fee7d83" });
    const w = await t.cycle.wake(t.a.id, { threadId: "thread_1" });
    expect(w.skipped).toBeFalsy();
    expect(w.prompt).toContain("## Commits that name no ticket (T63-S7)");
    // the wake ran: the same orphan does not wake it again until the re-wake gap is over
    t.store.updateRun(w.run!.id, { outcome: "monitoring", endedAt: new Date().toISOString() });
    const later = new Date(Date.now() + ORPHAN_CHECK_MS + 1000);
    expect(await t.cycle.tickOrphans(later)).toEqual([]);
    expect(await t.cycle.tickOrphans(new Date(Date.now() + ORPHAN_REWAKE_MS + 2 * ORPHAN_CHECK_MS))).toEqual([t.a.id]);
  });

  it("a fresh orphan gets its grace; a newer orphan after the last wake wakes it again", async () => {
    let list = [{ short: "aaaaaaa", date: ago(60_000) }];
    const t = setup({ orphans: () => list });
    expect(await t.cycle.tickOrphans()).toEqual([]);
    expect(t.t3.calls).toEqual([]);
    list = [{ short: "aaaaaaa", date: ago(20 * 60_000) }];
    expect(await t.cycle.tickOrphans(new Date(Date.now() + ORPHAN_CHECK_MS))).toEqual([t.a.id]);
  });

  it("no Delivery Manager on the milestone, or no orphans: no wake", async () => {
    const t = setup({ persona: "Writer", orphans: () => [{ short: "fee7d83", date: ago(86_400_000) }] });
    expect(await t.cycle.tickOrphans()).toEqual([]);
    const u = setup({ orphans: () => [] });
    expect(await u.cycle.tickOrphans()).toEqual([]);
    expect(u.t3.calls).toEqual([]);
  });
});
