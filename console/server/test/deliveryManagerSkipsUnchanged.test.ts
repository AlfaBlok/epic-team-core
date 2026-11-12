import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { CADENCE_SKIP_MAX_AGE_MS, cadenceSkipDecision } from "../src/cycle/skipUnchanged.js";
import { askParts, askPrint, classifyAsks, grantsHash, memorySkipDecision } from "../src/cycle/askMemory.js";

/** a Delivery Manager (any cadence persona) cadence wake with nothing new since its last real wake is skipped. */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s17-"));
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
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => state.todo, repoDir: () => repo });
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
  return { db, store, cycle, t3, state, repo, m, a, p, cadence, finish, child, newest };
}

describe("T8-S17 Delivery Manager skips unchanged cadence wakes", () => {
  it("same state: skipped (idle run, summary cites the last real wake, persona told to stop)", async () => {
    const t = setup();
    expect((await t.cadence()).real).toBe(true);
    const r1 = await t.finish();
    const w = await t.cadence();
    expect(w.real).toBe(false);
    expect(w.skipped).toBe(true);
    expect(w.run).toMatchObject({ outcome: "idle", threadId: "home", summary: `skipped: nothing new since ${r1.id}` });
    expect(w.prompt).toContain("Nothing changed");
    expect((await t.cadence()).run!.summary).toBe(`skipped: nothing new since ${r1.id}`);
  });

  it("its own spine edit during the wake is not news (fingerprint refreshed at run end); a later edit runs", async () => {
    const t = setup();
    await t.cadence();
    await t.finish("progressed", () => fs.appendFileSync(path.join(t.repo, "docs/epic.md"), "Last attempted: S1\n"));
    expect((await t.cadence()).real).toBe(false);
    fs.appendFileSync(path.join(t.repo, "docs/child.md"), "an answer landed\n");
    expect((await t.cadence()).real).toBe(true);
  });

  it("a child run that ended since the last real wake runs", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    t.child("S1 worker", "progressed");
    expect((await t.cadence()).real).toBe(true);
  });

  it("a child that starts running changes the fingerprint; while the same one runs, wakes skip", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    t.child("S1 worker");
    expect((await t.cadence()).real).toBe(true);
    await t.finish();
    expect((await t.cadence()).real).toBe(false);
  });

  it("a seat going free with ready rows nobody is on runs once; the same ready rows + free seat then skip (T8-S29)", async () => {
    const t = setup();
    t.state.ready = true;
    await t.cadence();
    await t.finish();
    expect((await t.cadence()).real).toBe(false); // ready row but no free seat
    t.state.available = 1;
    expect((await t.cadence()).real).toBe(true); // busy → free while S2 is ready: news
    await t.finish();
    expect((await t.cadence()).real).toBe(false); // still ready + seat free, same rows: the wake could not start them
    t.child("S2: worker on it");
    expect((await t.cadence()).real).toBe(true); // a child started (running changed; S2 is no longer "nobody is on")
    await t.finish();
    expect((await t.cadence()).real).toBe(false);
  });

  it("an answer saved in the console runs", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    t.db.prepare("INSERT INTO jordi_responses (id, item_id, milestone_id, kind, delivery, created_at) VALUES ('jr_1', 'i', ?, 'answer', 'delivered', ?)").run(t.m.id, new Date().toISOString());
    expect((await t.cadence()).real).toBe(true);
  });

  it("a change only the wake prompt shows (answered ask of another epic in the to-do section) runs", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    t.state.todo += "\n## Answered by Sam, act on these:\n- ops:docs/spines/epic10.md:4 — answer: APPROVED";
    expect((await t.cadence()).real).toBe(true);
  });

  it("Run now and instructions always run", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    await t.cycle.runNow(t.a.id, { instructions: "look at S2 again" });
    expect(t.t3.ranTasks).toBe(0); // never a T3 scheduled task; the stub goes to the home thread
    const w = await t.cadence(); // the stub's /wake claims the Run-now run
    expect(w.real).toBe(true);
    expect(w.run!.instructions).toBe("look at S2 again");
  });

  it("a failed last wake runs; a blocked one (waiting on a human ask) skips until something changes", async () => {
    const t = setup();
    await t.cadence();
    await t.finish("failed");
    expect((await t.cadence()).real).toBe(true);
    await t.finish("blocked");
    expect((await t.cadence()).real).toBe(false);
  });

  it("T8-S29/S30: skips hold by age, not count: any number of skips under 24 h; 24 h after the last real wake it is real", async () => {
    const t = setup();
    await t.cadence();
    const r1 = await t.finish();
    for (let i = 0; i < 30; i++) expect((await t.cadence()).real).toBe(false); // 30 skips (15 h at 30 min) no longer force a wake
    t.db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(new Date(Date.now() - CADENCE_SKIP_MAX_AGE_MS - 1000).toISOString(), r1.id);
    const w = await t.cadence();
    expect(w.real).toBe(true);
    expect(w.run!.wokeBecause).toMatch(/^max age \(last real wake 24 h ago, cap 24 h\)/);
    await t.finish();
    expect((await t.cadence()).real).toBe(false); // the age starts again
  });

  it("a persona that opted out always runs; the setting round-trips and defaults on", async () => {
    const t = setup({ skipUnchanged: false });
    expect(t.p.skipUnchanged).toBe(false);
    await t.cadence();
    await t.finish();
    expect((await t.cadence()).real).toBe(true);
    expect(t.store.createPersona({ name: "X", remit: "r", skills: [], model: "", mayWrite: false }).skipUnchanged).toBe(true);
    expect(t.store.updatePersona(t.p.id, { skipUnchanged: true })!.skipUnchanged).toBe(true);
  });

  it("an Unblocker that opted out always runs", async () => {
    const t = setup({ name: "Unblocker", skipUnchanged: false });
    await t.cadence();
    await t.finish();
    expect((await t.cadence()).real).toBe(true);
  });

  it("no readable tree (no spine path): never skipped", async () => {
    const t = setup();
    t.store.updateMilestone(t.m.id, { path: "" });
    await t.cadence();
    await t.finish();
    expect((await t.cadence()).real).toBe(true);
  });
});

describe("T8-S17 cadenceSkipDecision", () => {
  const run = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, assignmentId: "a", startedAt: "2026-10-24T10:00:00Z", endedAt: "2026-10-24T10:05:00Z", outcome: "idle", summary: "woke", kind: "wake", askFingerprint: "f", ...extra }) as never;
  const at = Date.parse("2026-10-24T12:00:00Z");
  it("running newest wake, no real wake, or another fingerprint never skip", () => {
    expect(cadenceSkipDecision([run("r", { outcome: "running" })], "f", CADENCE_SKIP_MAX_AGE_MS, at)).toEqual({ skip: false });
    expect(cadenceSkipDecision([], "f", CADENCE_SKIP_MAX_AGE_MS, at)).toEqual({ skip: false });
    expect(cadenceSkipDecision([run("r")], "g", CADENCE_SKIP_MAX_AGE_MS, at)).toEqual({ skip: false });
    expect(cadenceSkipDecision([run("r")], "f", CADENCE_SKIP_MAX_AGE_MS, at)).toMatchObject({ skip: true, sourceRunId: "r" });
  });
  it("rows without a fingerprint (parks, busy re-wakes) are passed over", () => {
    expect(cadenceSkipDecision([run("p", { askFingerprint: undefined, summary: "parked: x" }), run("r")], "f", CADENCE_SKIP_MAX_AGE_MS, at)).toMatchObject({ skip: true, sourceRunId: "r" });
  });
  it("T8-S29/S30: 24 h after the last real wake started, never skips (however many skips came before)", () => {
    const skips = Array.from({ length: 23 }, (_, i) => run(`s${i}`, { summary: "skipped: nothing new since r" }));
    expect(cadenceSkipDecision([...skips, run("r")], "f", CADENCE_SKIP_MAX_AGE_MS, Date.parse("2026-10-25T09:59:00Z"))).toMatchObject({ skip: true, sourceRunId: "r" });
    expect(cadenceSkipDecision([...skips, run("r")], "f", CADENCE_SKIP_MAX_AGE_MS, Date.parse("2026-10-25T10:00:00Z"))).toEqual({ skip: false });
  });
  it("T8-S14: a run whose next check (nextCheckAt or retryAt) is due never skips; a future one still does", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    for (const due of [{ nextCheckAt: "2026-10-24T11:00:00Z" }, { retryAt: "2026-10-24T11:59:00Z" }])
      expect(cadenceSkipDecision([run("r", due)], "f", CADENCE_SKIP_MAX_AGE_MS, now)).toEqual({ skip: false });
    expect(cadenceSkipDecision([run("s", { summary: "skipped: nothing new since r" }), run("r", { nextCheckAt: "2026-10-24T11:00:00Z" })], "f", CADENCE_SKIP_MAX_AGE_MS, now)).toEqual({ skip: false });
    expect(cadenceSkipDecision([run("r", { nextCheckAt: "2026-10-24T13:00:00Z" })], "f", CADENCE_SKIP_MAX_AGE_MS, now)).toMatchObject({ skip: true, sourceRunId: "r" });
    // the Unblocker rule too: a monitoring run that left every ask but whose check is due wakes
    const mon = run("m", { outcome: "monitoring", nextCheckAt: "2026-10-24T11:00:00Z", checks: [{ code: "T0-A1", decision: "left" }] });
    // (the Unblocker's per-ask rule, memorySkipDecision)
    const mem = { milestoneId: "m", code: "T0-A1", print: askPrint(askParts({ code: "T0-A1", kind: "do" }, grantsHash([]))), parts: askParts({ code: "T0-A1", kind: "do" }, grantsHash([])), runId: "m", verdict: "left" as const, check: { code: "T0-A1", decision: "left" as const }, assessedAt: "" };
    const st = classifyAsks([{ code: "T0-A1", kind: "do" }], [], [mem]);
    expect(memorySkipDecision([mon], [{ code: "T0-A1", kind: "do" }], st, now)).toMatchObject({ skip: false });
    expect(memorySkipDecision([{ ...(mon as object), nextCheckAt: "2026-10-24T13:00:00Z" } as never], [{ code: "T0-A1", kind: "do" }], st, now)).toMatchObject({ skip: true, sourceRunId: "m" });
  });
});
