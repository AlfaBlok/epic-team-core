import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMonitoring } from "../src/adapters/monitoring.js";
import { heldWhat, monitorValue } from "../src/repoState/monitoringLine.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { HELD_RULE, WORKER_FINISH_RULE, wakeProtocol } from "../src/cycle/prompts.js";
import { HELD_FALLBACK_MS } from "../src/cycle/wakeEnding.js";
import { milestoneStatus } from "../src/status/compute.js";

/** a run held on an offline egress (Team Browser HELD) is woken once by the egress online event. */
class FakeT3 implements T3Client {
  launched = 0;
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() {
    this.launched++;
    return { threadId: `thread${this.launched}` };
  }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-held-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new FakeT3();
  const store = createStore(db);
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x" });
  const app = createApp(db, { cycle: { enabled: false, publicUrl: "http://x" } });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "mgr", remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
  const json = (method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const online = async (name = "laptop") => (await json("POST", `/api/egress/${name}/online`)).json();
  /** A wake that ends held on the laptop through the real PATCH route. */
  const held = async (assignmentId = a.id) => {
    const run = store.createRun({ assignmentId, outcome: "running", summary: "Woke" });
    const res = await json("PATCH", `/api/runs/${run.id}`, { outcome: "monitoring", heldOn: "egress:laptop", summary: "inmuebles24 held", endedAt: new Date().toISOString() });
    expect(res.status).toBe(200);
    return res.json();
  };
  return { db, store, cycle, t3, m, p, a, app, json, online, held };
}

describe("M5-B4 held on an egress", () => {
  it("a held ending needs no date: the 6 h fallback nextCheckAt is set (and is the timed wake)", async () => {
    const t = setup();
    const before = Date.now();
    const r = await t.held();
    expect(r).toMatchObject({ outcome: "monitoring", heldOn: "egress:laptop" });
    const at = Date.parse(r.nextCheckAt);
    expect(at).toBeGreaterThanOrEqual(before + HELD_FALLBACK_MS - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + HELD_FALLBACK_MS + 1000);
    expect(t.store.getAssignment(t.a.id)).toMatchObject({ retryAt: r.nextCheckAt, retryRunId: r.id });
  });

  it("an own nextCheckAt is kept; held with progressed is stored as monitoring (no follow-up wake that would only hold again)", async () => {
    const t = setup();
    const own = new Date(Date.now() + 3600_000).toISOString();
    const r1 = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "w" });
    expect(await (await t.json("PATCH", `/api/runs/${r1.id}`, { outcome: "monitoring", heldOn: "egress:laptop", nextCheckAt: own })).json()).toMatchObject({ nextCheckAt: own });
    const r2 = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "w" });
    const res = await (await t.json("PATCH", `/api/runs/${r2.id}`, { outcome: "progressed", heldOn: "egress:laptop", summary: "did A, B held" })).json();
    expect(res).toMatchObject({ outcome: "monitoring", reportedOutcome: "progressed", heldOn: "egress:laptop" });
    expect(res.nextCheckAt).toBeDefined();
  });

  it("rejects a heldOn that is not egress:<name>", async () => {
    const t = setup();
    const r = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "w" });
    expect((await t.json("PATCH", `/api/runs/${r.id}`, { outcome: "monitoring", heldOn: "laptop" })).status).toBe(400);
  });

  it("held run + online event → exactly one wake; repeat online events do not double-wake", async () => {
    const t = setup();
    const r = await t.held();
    const res = await t.online();
    expect(res).toMatchObject({ egress: "laptop", woken: [{ assignmentId: t.a.id, runId: r.id }], skipped: [] });
    expect(Date.parse(t.store.getAssignment(t.a.id)!.retryAt!)).toBeLessThanOrEqual(Date.now());
    // a repeat before the tick: the wake is already due
    expect((await t.online()).woken).toEqual([]);
    expect(await t.cycle.tickRetry()).toEqual([t.a.id]);
    expect(t.t3.launched).toBe(1);
    // after the tick the latest wake is the new one (running), not the held one
    expect(await t.online()).toMatchObject({ woken: [], skipped: [] });
    expect(await t.cycle.tickRetry(new Date(Date.now() + 60_000))).toEqual([]);
    expect(t.t3.launched).toBe(1);
  });

  it("a switched-off persona is not woken (root L-10); other egresses and non-held runs are untouched", async () => {
    const t = setup();
    const p2 = t.store.createPersona({ name: "other", remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
    const off = t.store.createAssignment({ milestoneId: t.m.id, personaId: p2.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
    await t.held(off.id);
    await t.json("PATCH", `/api/assignments/${off.id}`, { enabled: false });
    t.store.createRun({ assignmentId: t.a.id, outcome: "monitoring", endedAt: new Date().toISOString(), summary: "plain watch", nextCheckAt: new Date(Date.now() + 3600_000).toISOString() });
    const res = await t.online();
    expect(res.woken).toEqual([]);
    expect(res.skipped).toMatchObject([{ assignmentId: off.id, reason: expect.stringContaining("switched off") }]);
    expect(t.store.getAssignment(off.id)!.retryAt).toBeUndefined();
    expect((await t.online("other")).woken).toEqual([]);
    expect(await t.cycle.tickRetry()).toEqual([]);
    expect(t.t3.launched).toBe(0);
    expect((await t.json("POST", "/api/egress/Bad%20Name/online")).status).toBe(400);
  });

  it("status reads monitoring (not stalled) while held: from the spine's Monitoring line the held report writes (T62-S8)", async () => {
    const t = setup();
    await t.held();
    const base = { milestone: t.store.getMilestone(t.m.id)!, waiting: [], assignments: t.store.listAssignments(), runs: t.store.listRuns(), personaName: () => "mgr" };
    // the held report alone (this milestone has no spine, so no line was written) is not monitoring
    expect(milestoneStatus(base).flow.word).not.toBe("monitoring");
    // the line the held PATCH writes (unblockerRubricLivesRepo.test.ts), worded calm so it is no monitor alert for the owner
    const st = milestoneStatus({ ...base, monitoring: parseMonitoring(monitorValue({ what: heldWhat("egress:laptop"), nextCheckAt: new Date(Date.now() + 3_600_000).toISOString() })) });
    expect(st.flow.word).toBe("monitoring");
    expect(st.flow.reason).toBe("monitoring: held until the laptop egress is back");
    expect(st.items).toEqual([]);
  });

  it("the wake prompt and worker briefs carry the HELD rule", () => {
    const t = setup();
    const run = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "w" });
    const text = wakeProtocol({ base: "http://x", run, assignment: t.a, milestone: t.m, persona: t.p });
    expect(text).toContain(HELD_RULE);
    expect(text).toContain('"heldOn":"egress:laptop"');
    expect(WORKER_FINISH_RULE).toContain('heldOn: "egress:<name>"');
  });
});
