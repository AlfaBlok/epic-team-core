import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { textHash, wakeFingerprint } from "../src/cycle/skipUnchanged.js";
import { RELEASE_BACKOFF_MS, heldRelease, releasedWhy } from "../src/cycle/held.js";

/**
 * the cadence skip holds when nothing changed. Ready rows nobody is on + a free seat are news only when the set
 * of rows changes (or a seat goes busy → free while they are ready), and only for the Delivery Manager; personas that
 * never dispatch ignore them. Timed and release wakes record why they woke; a flapping egress wakes at most once per
 * RELEASE_BACKOFF_MS.
 */
class FakeT3 implements T3Client {
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { return { threadId: "t" }; }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((f) => f());
  cleanups = [];
});

const node = (id: string, p: string, extra: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key: `k/${id}`, id, kind: "spine", title: id, status: "active", color: "grey", path: p, children, flags: [], ...extra,
});

function setup(name = "Delivery Manager") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s29-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/epic.md"), "# EPIC\n## Current State\nNext action: S2\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  // `ready`: ids of ticket rows that read ready (blocked on asks in real life: the wake cannot start them).
  const state = { ready: ["S2"] as string[], available: 1 };
  const treeFor = async (): Promise<Tree> => ({
    milestoneId: "m",
    root: node("PLAN-1", "docs/epic.md", {}, ["S2", "S3", "S4"].map((id) => node(id, "", { kind: "ticket", ...(state.ready.includes(id) ? { ready: true } : {}) }))),
    counts: { grey: 4, blue: 0, yellow: 0, red: 0, green: 0 },
    nonGreen: 4, closed: 0, flagged: 0, source: "spines", warnings: [],
  });
  const disp = {
    async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; },
    async done() {},
    async status() { return { name: "pool", capacity: 2, available: state.available }; },
  };
  const cycle = createCycle(db, store, { enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo });
  cleanups.push(() => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
  const p = store.createPersona({ name, remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 30 }, enabled: true });
  const newest = () => store.listRuns({ assignmentId: a.id }).find((r) => !r.parentRunId)!;
  const cadence = async () => {
    const w = await cycle.wake(a.id, { threadId: "home" });
    return { ...w, real: w.run?.outcome === "running" };
  };
  /** The wake reports blocked: it could not start the ready rows (they wait on asks). */
  const finish = async (outcome: "blocked" | "monitoring" | "idle" = "blocked") => {
    const r = newest();
    store.updateRun(r.id, { outcome, endedAt: new Date(Date.now() + 1).toISOString() });
    cycle.runEnded(r.id);
    await cycle.settled();
    return store.getRun(r.id)!;
  };
  return { db, store, cycle, state, a, cadence, finish };
}

describe("T8-S29 ready rows no longer bypass the cadence skip", () => {
  it("Delivery Manager: the same ready rows + a free seat skip; a new ready row wakes it once", async () => {
    const t = setup();
    const w1 = await t.cadence();
    expect(w1.real).toBe(true);
    expect(w1.run!.wokeBecause).toBe("first wake; ready rows nobody is on + a free seat (S2)");
    await t.finish();
    for (let i = 0; i < 5; i++) expect((await t.cadence()).real).toBe(false); // before: every one real
    expect(await t.cycle.wakeCheck(t.a.id)).toMatchObject({ wouldSkip: true, readyIds: ["S2"] });

    t.state.ready = ["S2", "S3"]; // a new row turns ready
    const w2 = await t.cadence();
    expect(w2.real).toBe(true);
    expect(w2.run!.wokeBecause).toBe("ready rows nobody is on + a free seat (S2, S3)");
    await t.finish();
    expect((await t.cadence()).real).toBe(false);

    t.state.ready = ["S3"]; // a row leaves the set: also a change
    expect((await t.cadence()).real).toBe(true);
    await t.finish();
    expect((await t.cadence()).real).toBe(false);
  });

  it("Delivery Manager: rows starved of a seat at the last real wake → a seat frees → wakes once, then skips", async () => {
    const t = setup();
    t.state.available = 0;
    await t.cadence();
    const r1 = await t.finish("monitoring"); // after a blocked end a freed seat is no news (freedSeatAfterBlocked.test.ts)
    expect(r1.wakeParts!.ready).toMatch(/^2:/); // ready rows, no free seat
    expect((await t.cadence()).real).toBe(false); // ready, no seat
    t.state.available = 1;
    expect(await t.cycle.wakeCheck(t.a.id)).toMatchObject({ wouldSkip: false, why: "a seat freed for ready rows (S2)" });
    const w = await t.cadence();
    expect(w.real).toBe(true);
    expect(w.run!.wokeBecause).toBe("a seat freed for ready rows (S2)");
    t.state.available = 0; // busy again when the wake ends: it still had its chance with a free seat
    const r2 = await t.finish();
    expect(r2.wakeParts!.ready).toBe(`1:${r1.wakeParts!.ready.slice(2)}`);
    for (const free of [0, 1, 2, 0, 1]) {
      t.state.available = free;
      expect((await t.cadence()).real).toBe(false);
    }
  });

  it("Delivery Manager: the shared pool flipping busy ↔ free between cadence wakes never wakes it for the same rows", async () => {
    const t = setup(); // W1 with a free seat
    expect((await t.cadence()).real).toBe(true);
    await t.finish();
    for (const free of [0, 1, 0, 2, 0, 1, 1, 0]) {
      t.state.available = free;
      expect((await t.cadence()).real).toBe(false);
    }
    t.state.ready = ["S2", "S4"]; // a new row still wakes it, seat or not
    t.state.available = 0;
    const w = await t.cadence();
    expect(w.real).toBe(true);
    expect(w.run!.wokeBecause).toBe("ready rows changed, no free seat (S2, S4)");
  });

  it("non-dispatching personas (Publisher, Responder) ignore ready rows: a new ready row or a free seat is no news", async () => {
    for (const name of ["Publisher", "Responder"]) {
      const t = setup(name);
      const w1 = await t.cadence();
      expect(w1.run!.wokeBecause).toBe("first wake (no earlier wake to compare)"); // no ready-rows reason
      const r1 = await t.finish("monitoring");
      expect(r1.wakeParts).toMatchObject({ ready: "0" });
      expect((await t.cadence()).real).toBe(false);
      t.state.ready = ["S2", "S3", "S4"];
      expect((await t.cadence()).real).toBe(false);
      t.state.available = 0;
      expect((await t.cadence()).real).toBe(false);
      t.state.available = 2;
      expect((await t.cadence()).real).toBe(false);
      expect(await t.cycle.wakeCheck(t.a.id)).toMatchObject({ wouldSkip: true, parts: { ready: "0" } });
    }
  });

  it("fingerprints without ready rows + a free seat are the pre-T8-S29 ones (no extra wake after deploy)", () => {
    const s = { spines: "s", running: ["c2", "c1"], readyAndSeatFree: false, answer: "jr", prompt: "p", data: "d" };
    const old = createHash("sha256").update(JSON.stringify({ s: "s", r: ["c1", "c2"], f: false, j: "jr", p: textHash("p"), d: "d" })).digest("hex").slice(0, 32);
    expect(wakeFingerprint(s)).toBe(old);
    expect(wakeFingerprint({ ...s, ready: [] })).toBe(old);
    // the seat is not a part: same rows, free or not, same fingerprint; the row set is
    expect(wakeFingerprint({ ...s, readyAndSeatFree: true, ready: ["k/S2"] })).toBe(wakeFingerprint({ ...s, readyAndSeatFree: false, ready: ["k/S2"] }));
    expect(wakeFingerprint({ ...s, readyAndSeatFree: true, ready: ["k/S3", "k/S2"] })).toBe(wakeFingerprint({ ...s, readyAndSeatFree: true, ready: ["k/S2", "k/S3"] }));
    expect(wakeFingerprint({ ...s, readyAndSeatFree: true, ready: ["k/S2"] })).not.toBe(wakeFingerprint({ ...s, readyAndSeatFree: true, ready: ["k/S3"] }));
    expect(wakeFingerprint({ ...s, ready: ["k/S2"] })).not.toBe(old);
  });
});

// ---------- point 3: timed and release wakes ----------

const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };
function heldSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s29h-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const cycle = createCycle(db, store, { enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x" });
  const app = createApp(db, { cycle: { enabled: false, publicUrl: "http://x" } });
  cleanups.push(() => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "Responder", remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const json = (method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const online = async () => (await json("POST", "/api/egress/laptop/online")).json();
  /** The newest wake ends held on the laptop (PATCH route: nextCheckAt falls back to 6 h). */
  const endHeld = async (runId: string) => (await json("PATCH", `/api/runs/${runId}`, { outcome: "monitoring", heldOn: "egress:laptop", summary: "P-0047 held", endedAt: new Date().toISOString() })).json();
  return { store, cycle, a, online, endHeld };
}

describe("T8-S29 timed and release wakes record why they woke", () => {
  it("heldRelease tells a release (retryAt = release time) from the run's own timed check", () => {
    const src = { id: "r", heldOn: "egress:laptop", nextCheckAt: "2026-10-30T19:19:21.171Z" } as never;
    expect(heldRelease(src, "2026-10-30T13:32:00.000Z")).toBe(true);
    expect(heldRelease(src, "2026-10-30T19:19:21.171Z")).toBe(false);
    expect(heldRelease({ id: "r", nextCheckAt: "x" } as never, "2026-10-30T13:32:00.000Z")).toBe(false); // not held
  });

  it("the egress-online release wake records `released: …`; the held run's own 6 h check records `Timed wake`", async () => {
    const t = heldSetup();
    const r0 = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "Woke" });
    await t.endHeld(r0.id);
    expect((await t.online()).woken).toHaveLength(1);
    expect(await t.cycle.tickRetry()).toEqual([t.a.id]);
    const w = t.store.listRuns({ assignmentId: t.a.id }).find((r) => !r.parentRunId)!;
    expect(w.id).not.toBe(r0.id);
    expect(w.wokeBecause).toBe(releasedWhy("egress:laptop", r0.id));
    expect(w.wokeBecause).toBe(`released: egress:laptop back (held run ${r0.id})`);

    // the release wake ends held again; its own nextCheckAt (6 h) fires as a plain timed wake
    const r1 = await t.endHeld(w.id);
    expect(await t.cycle.tickRetry(new Date(Date.parse(r1.nextCheckAt) + 1000))).toEqual([t.a.id]);
    const w2 = t.store.listRuns({ assignmentId: t.a.id }).find((r) => !r.parentRunId)!;
    expect(w2.wokeBecause).toMatch(/^Timed wake \(retryAt .*, requested by run /);
  });

  it("flapping egress: online again right after a release wake ended held → wake booked 30 min after it, not now", async () => {
    const t = heldSetup();
    const r0 = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "Woke" });
    await t.endHeld(r0.id);
    await t.online();
    await t.cycle.tickRetry();
    const w = t.store.listRuns({ assignmentId: t.a.id }).find((r) => !r.parentRunId)!;
    await t.endHeld(w.id); // the laptop was gone again (2026-10-30 13:32 → 13:54, 21:56 → 22:13)
    const res = await t.online();
    expect(res.woken).toEqual([]);
    const at = Date.parse(w.startedAt) + RELEASE_BACKOFF_MS;
    expect(res.deferred).toEqual([{ assignmentId: t.a.id, runId: w.id, at: new Date(at).toISOString() }]);
    expect(await t.cycle.tickRetry()).toEqual([]); // nothing now
    expect((await t.online()).skipped).toMatchObject([{ reason: "wake already booked" }]); // a third flip books nothing more
    expect(await t.cycle.tickRetry(new Date(at + 1000))).toEqual([t.a.id]); // one wake at the end of the window
    const w2 = t.store.listRuns({ assignmentId: t.a.id }).find((r) => !r.parentRunId)!;
    expect(w2.wokeBecause).toBe(releasedWhy("egress:laptop", w.id));
  });
});
