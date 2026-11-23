import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle, type RunState } from "../src/cycle/service.js";
import { HELD_ROUTE_MS, heldToRoute, routedHeldSection, type HeldOfGoal } from "../src/inbox/heldRoute.js";
import { waitsElsewhere } from "../src/inbox/freeText.js";

/**
 * E907-S30 (the owner, closing E907-S18 on 23 Nov: "the held-questions fix for every goal, in the overall check"): a
 * question the ask gate holds back goes to the world's home Delivery Manager when its own goal's manager is off or has
 * not acted on it within 2 hours (TAX-A17 and TAX-A15 sat held 7 days under a switched-off manager). And a ledger row
 * blocked on another world (E907-S26) is never an item for him at all: only `[ask …]` lines are asks.
 */
const NOW = Date.parse("2026-11-23T03:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const NOT_HIS = "it does not name what of Sam's it answers: cite his ask (his words in quotes, a voice note or log id)";
const tax = (since: string): HeldOfGoal["held"][number] => ({ code: "TAX-A17", repo: "tax-assist-research", path: "docs/EPIC_SPINE.md", line: 159, question: "Turn EpicBooks back on, with tighter limits?", reason: NOT_HIS, since });

describe("E907-S30 held asks reach a manager who acts", () => {
  it("a held ask under a switched-off manager goes to the home manager at once", () => {
    const r = heldToRoute([{ milestoneId: "ms_tax", title: "Company and accountant", managerOn: false, held: [tax(hoursAgo(0.1))] }], "ms_home", NOW);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: "TAX-A17", why: "manager off", goal: "Company and accountant", hours: 0 });
  });

  it("under a manager who is on it goes on only after 2 hours untouched; a rewrite restarts the clock", () => {
    const goal = (since: string): HeldOfGoal[] => [{ milestoneId: "ms_tax", title: "Company and accountant", managerOn: true, held: [tax(since)] }];
    expect(heldToRoute(goal(hoursAgo(1.9)), "ms_home", NOW)).toEqual([]);
    expect(heldToRoute(goal(new Date(NOW - HELD_ROUTE_MS).toISOString()), "ms_home", NOW)[0]?.why).toBe("not acted on in 2 h");
    expect(heldToRoute(goal(hoursAgo(7 * 24)), "ms_home", NOW)[0]?.hours).toBe(168);
  });

  it("the home goal's own held asks stay in its own section, and one ask held under two goals is listed once", () => {
    const h = tax(hoursAgo(5));
    expect(heldToRoute([{ milestoneId: "ms_home", title: "Home", managerOn: false, held: [h] }], "ms_home", NOW)).toEqual([]);
    const r = heldToRoute(
      [
        { milestoneId: "ms_a", title: "A", managerOn: false, held: [h] },
        { milestoneId: "ms_b", title: "B", managerOn: false, held: [h] },
      ],
      "ms_home",
      NOW,
    );
    expect(r).toHaveLength(1);
  });

  it("the wake section says rewrite or drop, and another world's ask goes by desk note, never an edit", () => {
    const r = heldToRoute([{ milestoneId: "ms_tax", title: "Company and accountant", managerOn: false, held: [tax(hoursAgo(170))] }], "ms_home", NOW);
    const s = routedHeldSection(r, "home_repo")!;
    expect(s).toMatch(/^## Held questions other goals left/);
    expect(s).toContain("rewrite it so it passes the gate");
    expect(s).toContain("answer: dropped, not his ask");
    expect(s).toContain("desk_note.py send");
    expect(s).toContain("TAX-A17 · Company and accountant · manager off · held 170 h · tax-assist-research/docs/EPIC_SPINE.md:160 (another world: desk note)");
    expect(routedHeldSection([], "home_repo")).toBeUndefined();
  });
});

describe("E907-S30 a row blocked on another world is not his", () => {
  const lines = [
    "## Waiting on",
    "- [waits on infra-repo/C9-14-A2 row E907-S26] infra-repo installs bubblewrap on the worker",
    "| E907-S26 | Ticket worker | unassigned | Lift the sandbox block | blocked (another world: infra-repo installs bubblewrap) |",
  ];
  it("E907-S26: its reference line or its status says another world", () => {
    expect(waitsElsewhere({ id: "E907-S26", status: "blocked (another world: infra-repo installs bubblewrap, C9-14-A2 approved 19 Nov)" }, lines)).toBe(true);
    expect(waitsElsewhere({ id: "E907-S26", status: "blocked" }, lines)).toBe(true); // the reference line alone
  });
  it("E907-S73: blocked on another world by its status only", () => {
    expect(waitsElsewhere({ id: "E907-S73", status: "blocked (another world: infra-repo owns secret run; desk note …, open)" }, [])).toBe(true);
  });
  it("a row blocked on him, or on nothing named, stays his", () => {
    expect(waitsElsewhere({ id: "E907-S9", status: "blocked: waits on the owner" }, lines)).toBe(false);
    expect(waitsElsewhere({ id: "E907-S9", status: "blocked" }, lines)).toBe(false);
    expect(waitsElsewhere({ id: "E907-S2", status: "blocked" }, lines)).toBe(false); // E907-S26's line does not cover E907-S2
  });
});

class FakeT3 implements T3Client {
  private n = 0;
  async listProjects() { return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }]; }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { return { threadId: `thread_${++this.n}` }; }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups) c(); cleanups = []; });

describe("E907-S30 the held-asks sweep wakes the home manager", () => {
  function setup(due: () => Array<{ key: string; at: string }>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-held-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/PLAN-0.md"), "# PLAN-0\n## Current State\nStatus: ready\n");
    const db: DB = openDb(path.join(dir, "c.db"));
    const store = createStore(db);
    const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {}, async status() { return { name: "pool", capacity: 2, available: 1 }; } };
    let mid = "";
    const cycle = createCycle(db, store, {
      enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x", repoDir: () => repo,
      runState: async (): Promise<RunState> => ({ state: "finished", runnable: false }),
      heldRoutedDue: async () => due().map((h) => ({ milestoneId: mid, ...h })),
    });
    cleanups.push(() => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const m = store.createMilestone({ title: "Home", repo: "home_repo", path: "docs/PLAN-0.md", owner: "", paused: false });
    mid = m.id;
    const p = store.createPersona({ name: "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host1" });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 720 }, enabled: true });
    return { store, cycle, a };
  }

  it("wakes it once for routed asks, never with none", async () => {
    const none = setup(() => []);
    expect(await none.cycle.tickHeldRouted()).toEqual([]);
    const t = setup(() => [{ key: "tax-assist-research/TAX-A17", at: new Date(Date.now() - 60_000).toISOString() }]);
    expect(await t.cycle.tickHeldRouted()).toEqual([t.a.id]);
    const run = t.store.listRuns({ assignmentId: t.a.id }).find((r) => !r.parentRunId)!;
    expect(run.wokeBecause ?? run.summary).toMatch(/held asks other goals left: tax-assist-research\/TAX-A17/);
  });
});
