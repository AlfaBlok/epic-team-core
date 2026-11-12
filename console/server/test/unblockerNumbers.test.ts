import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore, type OpenAsk, type RunCheck } from "../src/store.js";
import { SKIP_PREFIX } from "../src/cycle/skipUnchanged.js";
import { median, unblockerStats } from "../src/cycle/unblockerStats.js";
import { rememberChecks, readAskMemory } from "../src/cycle/askMemory.js";
import type { T3Client } from "../src/t3/client.js";

/**
 * the Unblocker's numbers per milestone and window, from the run log (Unblocker wakes, their open asks and
 * checks), the per-ask memory and the answers table (reversals).
 */
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const NOW = Date.parse("2026-10-26T12:00:00Z");
const H = 3600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ask = (code: string, since?: string, carriedFrom?: string): OpenAsk => ({ code, kind: "decide", path: "docs/PLAN-0-ROOT.md", line: 40, textHash: code, ...(since ? { since } : {}), ...(carriedFrom ? { carriedFrom } : {}) });
const check = (code: string, decision: RunCheck["decision"], extra: Partial<RunCheck> & Record<string, unknown> = {}): RunCheck => ({ code, decision, why: "w", ...extra });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s27-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const app = createApp(db, {});
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const m1 = store.createMilestone({ title: "whatgpt", repo: "/r/whatgpt", path: "", owner: "", paused: false });
  const m2 = store.createMilestone({ title: "infra", repo: "/r/infra", path: "", owner: "", paused: false });
  const ub = store.createPersona({ name: "Unblocker", remit: "answer asks", skills: [], model: "m", mayWrite: true, freshThreadEachWake: true });
  const dm = store.createPersona({ name: "Delivery Manager", remit: "run", skills: [], model: "m", mayWrite: true, freshThreadEachWake: false });
  const cad = { type: "interval" as const, everyMinutes: 60 };
  const u1 = store.createAssignment({ milestoneId: m1.id, personaId: ub.id, cadence: cad, enabled: true }).id;
  const u2 = store.createAssignment({ milestoneId: m2.id, personaId: ub.id, cadence: cad, enabled: true }).id;
  const d1 = store.createAssignment({ milestoneId: m1.id, personaId: dm.id, cadence: cad, enabled: true }).id;
  const run = (assignmentId: string, start: number, end: number | null, o: { summary?: string; outcome?: "progressed" | "idle" | "running"; asks?: OpenAsk[]; checks?: RunCheck[] } = {}) => {
    const r = store.createRun({ assignmentId, startedAt: at(start), endedAt: end === null ? null : at(end), outcome: o.outcome ?? "progressed", summary: o.summary ?? "answered 1 · left 0", checks: o.checks });
    return o.asks ? store.updateRun(r.id, { openAsks: o.asks })! : r;
  };
  const respond = (milestoneId: string, itemId: string, item: Record<string, unknown>, ago: number, kind = "answer") =>
    db
      .prepare("INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, delivery, created_at) VALUES (?, ?, ?, ?, ?, 'no', 'delivered', ?)")
      .run(`jr_${itemId}_${ago}`, itemId, milestoneId, JSON.stringify(item), kind, at(ago));
  return { db, store, app, m1, m2, u1, u2, d1, run, respond };
}

/** The fixture: M1 (whatgpt) with 5 Unblocker wakes (one skipped, one running) and a DM wake; M2 (infra) with one wake and a reversal. */
function fixture() {
  const t = setup();
  const { run, u1, u2, d1, m1, m2, respond } = t;
  // 10 days ago: A0 seen with no line time (pre- run log), split after 20 min.
  run(u1, 240 * H, 240 * H - 20 * 60_000, { asks: [ask("T0-A0")], checks: [check("T0-A0", "split")] });
  // 3 days ago: A1 raised 2 h before the wake, left after 10 min.
  const r1 = run(u1, 72 * H, 72 * H - 10 * 60_000, { asks: [ask("T0-A1", at(74 * H))], checks: [check("T0-A1", "left")] });
  // 2 h ago: a skipped cadence wake (copies A1's left, skipped).
  run(u1, 2 * H, 2 * H, { outcome: "idle", summary: `${SKIP_PREFIX} ${r1.id} (T0-A1 left (unchanged since ${r1.id}))`, checks: [check("T0-A1", "left", { skipped: true, carriedFrom: r1.id })] });
  // 1 h ago: A2 (raised 5 h ago) answered with a score; A1 carried.
  run(u1, 1 * H, 50 * 60_000, {
    asks: [ask("T0-A1", at(74 * H), r1.id), ask("T0-A2", at(5 * H))],
    checks: [check("T0-A2", "answered", { answer: "yes", confidence: 90, score: 80, threshold: 70 }), check("T0-A1", "left", { carriedFrom: r1.id })],
  });
  // 30 min ago: still running with A3 open (no line time known).
  run(u1, 30 * 60_000, null, { outcome: "running", asks: [ask("T0-A3")] });
  // A Delivery Manager wake on M1 never counts.
  run(d1, 1 * H, 30 * 60_000, { checks: [check("T0-A9", "answered")] });
  // M2: B1 raised 30 h ago, answered 19 h ago; the owner reversed it 10 h ago (two saves on the card count once).
  run(u2, 20 * H, 19 * H, { asks: [ask("T2-A1", at(30 * H))], checks: [check("T2-A1", "answered", { answer: "yes", confidence: 85 })] });
  respond(m2.id, "wj_b1", { decidedBy: "Unblocker", code: "T2-A1" }, 10 * H);
  respond(m2.id, "wj_b1", { decidedBy: "Unblocker", code: "T2-A1" }, 9 * H);
  // Not reversals of the Unblocker: a reversal of the DM's decision, an approval on an ordinary ask.
  respond(m1.id, "wj_dm", { decidedBy: "Delivery Manager", code: "T0-A8" }, 3 * H);
  respond(m1.id, "wj_x", { code: "T0-A7" }, 3 * H, "approve");
  return t;
}

const MIN = 60_000;

describe("T8-S27 Unblocker numbers", () => {
  it("24 h: wakes fired / skipped, new asks, assessed / answered / left, ask → verdict, waiting, score", () => {
    const t = fixture();
    const s = unblockerStats(t.db, t.store, { window: "24h", now: NOW });
    expect(s.from).toBe(at(24 * H));
    const w = s.milestones.find((m) => m.milestoneId === t.m1.id)!;
    expect(w).toMatchObject({ milestoneTitle: "whatgpt", wakesFired: 2, wakesSkipped: 1, newAsks: 2, assessed: 1, answered: 1, left: 0, split: 0, reversed: 0 });
    expect(w.askToVerdict).toMatchObject({ count: 1, medianMs: 5 * H - 50 * MIN, worstMs: 5 * H - 50 * MIN, worstCode: "T0-A2", estimated: 0, waiting: 1, oldestWaitingCode: "T0-A3", oldestWaitingMs: 30 * MIN });
    expect(w.score).toEqual({ count: 1, median: 80, threshold: 70 });
    const i = s.milestones.find((m) => m.milestoneId === t.m2.id)!;
    expect(i).toMatchObject({ wakesFired: 1, wakesSkipped: 0, newAsks: 0, assessed: 1, answered: 1, reversed: 1 });
    expect(i.askToVerdict).toMatchObject({ count: 1, medianMs: 11 * H, worstCode: "T2-A1" });
    expect(i.score).toBeUndefined();
    expect(s.total).toMatchObject({ wakesFired: 3, wakesSkipped: 1, newAsks: 2, assessed: 2, answered: 2, left: 0, reversed: 1 });
    expect(s.total.askToVerdict).toMatchObject({ count: 2, medianMs: (5 * H - 50 * MIN + 11 * H) / 2, worstMs: 11 * H, worstCode: "T2-A1" });
  });

  it("7 d and all: older wakes and verdicts come in; asks timed from the first wake are flagged estimated", () => {
    const t = fixture();
    const w7 = unblockerStats(t.db, t.store, { window: "7d", now: NOW }).milestones.find((m) => m.milestoneId === t.m1.id)!;
    expect(w7).toMatchObject({ wakesFired: 3, wakesSkipped: 1, newAsks: 3, assessed: 2, answered: 1, left: 1, split: 0 });
    expect(w7.askToVerdict).toMatchObject({ count: 2, medianMs: (2 * H + 10 * MIN + 5 * H - 50 * MIN) / 2, worstCode: "T0-A2", estimated: 0 });
    const all = unblockerStats(t.db, t.store, { window: "all", now: NOW });
    expect(all.from).toBeNull();
    const wa = all.milestones.find((m) => m.milestoneId === t.m1.id)!;
    expect(wa).toMatchObject({ wakesFired: 4, wakesSkipped: 1, newAsks: 4, assessed: 3, answered: 1, left: 1, split: 1 });
    expect(wa.askToVerdict).toMatchObject({ count: 3, medianMs: 2 * H + 10 * MIN, estimated: 1 });
  });

  it("a carried or skipped verdict never counts as an assessment, and a re-assessment keeps the first verdict time", () => {
    const t = setup();
    const r1 = t.run(t.u1, 6 * H, 5 * H, { asks: [ask("T0-A1", at(8 * H))], checks: [check("T0-A1", "left")] });
    t.run(t.u1, 4 * H, 4 * H - MIN, { asks: [ask("T0-A1", at(8 * H), r1.id)], checks: [check("T0-A1", "left", { carriedFrom: r1.id })] });
    t.run(t.u1, 2 * H, 1 * H, { asks: [ask("T0-A1", at(3 * H))], checks: [check("T0-A1", "answered")] }); // reworded, then answered
    const s = unblockerStats(t.db, t.store, { window: "24h", now: NOW }).milestones[0];
    expect(s).toMatchObject({ wakesFired: 3, assessed: 2, answered: 1, left: 1, newAsks: 1 });
    expect(s.askToVerdict).toMatchObject({ count: 1, medianMs: 3 * H, waiting: 0 });
  });

  it("reads the same verdicts the per-ask memory keeps (T8-S24)", () => {
    const t = setup();
    const r = t.run(t.u1, 2 * H, 1 * H, { asks: [{ ...ask("T0-A1", at(3 * H)), print: "p", parts: { text: "a", grants: "", comment: "", evidence: "" } }], checks: [check("T0-A1", "answered")] });
    rememberChecks(t.db, r, t.m1.id, at(1 * H));
    const mem = readAskMemory(t.db, t.m1.id);
    const s = unblockerStats(t.db, t.store, { window: "24h", now: NOW }).milestones[0];
    expect(mem.map((m) => [m.code, m.verdict])).toEqual([["T0-A1", "answered"]]);
    expect(s).toMatchObject({ answered: mem.filter((m) => m.verdict === "answered").length, askToVerdict: { count: 1, medianMs: 2 * H } });
  });

  it("GET /api/unblocker-stats: window and milestone filter; a bad window is a 400; no Unblocker → no rows", async () => {
    // the route reads the clock; pin it to the fixture's day (the 7d window went stale on 2026-11-01)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    onTestFinished(() => { vi.useRealTimers(); });
    const t = fixture();
    const get = async (q: string) => {
      const res = await t.app.request(`/api/unblocker-stats${q}`);
      return { status: res.status, json: await res.json() };
    };
    const all = await get("?window=all");
    expect(all.status).toBe(200);
    expect(all.json.milestones.map((m: { milestoneTitle: string }) => m.milestoneTitle).sort()).toEqual(["infra", "whatgpt"]);
    const one = await get(`?window=7d&milestoneId=${t.m2.id}`);
    expect(one.json.milestones).toHaveLength(1);
    expect(one.json.total).toMatchObject({ wakesFired: 1, reversed: 1 });
    expect((await get("?window=1y")).status).toBe(400);
    const def = await get("");
    expect(def.json.window).toBe("24h");
  });

  it("median of an even list is the mean of the middle two", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("T8-S27 the one write: an Unblocker wake stores each open ask's line time", () => {
  class FakeT3 implements T3Client {
    launches = 0;
    async listProjects() {
      return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
    }
    async listScheduledTasks() { return []; }
    async updateScheduledTask() { return undefined; }
    async deleteScheduledTask() {}
    async runScheduledTaskNow() {}
    async launchThread() {
      return { threadId: `thread${++this.launches}` };
    }
    async sendToThread() {}
    async readThreadStatus() { return { status: "idle", raw: {} }; }
  }
  it("`since` from the open-asks reader lands on run.openAsks (new and carried asks alike)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s27w-"));
    const db = openDb(path.join(dir, "c.db"));
    cleanup = () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    const store = createStore(db);
    const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };
    const app = createApp(db, { cycle: { enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x", openAsks: async () => [ask("T0-A11", "2026-10-25T08:00:00.000Z")], grants: async () => [] } });
    const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
    const p = store.createPersona({ name: "Unblocker", remit: "answer asks", skills: [], model: "m", mayWrite: true, freshThreadEachWake: true });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    store.updateAssignment(a.id, { t3ScheduledTaskId: "task1" });
    const res = await app.request(`/api/assignments/${a.id}/wake?format=json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: "home" }) });
    expect(res.status).toBe(200);
    const run = store.listRuns({ assignmentId: a.id, limit: 1 })[0];
    expect(run.openAsks?.[0]).toMatchObject({ code: "T0-A11", since: "2026-10-25T08:00:00.000Z" });
  });
});
