import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { wakeProtocol } from "../src/cycle/prompts.js";

/** persona wakes drain the ready queue (pick until null id), capped at N running child workers per milestone. */
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

function setup(maxWorkersPerMilestone?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s7-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const app = createApp(db, { cycle: { enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x", maxWorkersPerMilestone } });
  cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const m2 = store.createMilestone({ title: "Other", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "mgr", remit: "my remit", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
  const a2 = store.createAssignment({ milestoneId: m2.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
  const wake = async (id: string) => {
    const res = await app.request(`/api/assignments/${id}/wake?format=json`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return (await res.json()) as { prompt: string; run: { id: string } };
  };
  return { store, m, a, a2, wake };
}

describe("T13-S7 worker ceiling", () => {
  it("counts the milestone's running child runs and says how many more may launch (other milestones and ended children do not count)", async () => {
    const t = setup();
    const parent = t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", summary: "earlier wake", endedAt: new Date().toISOString() });
    for (let i = 0; i < 7; i++) t.store.createRun({ assignmentId: t.a.id, parentRunId: parent.id, outcome: "running", summary: `T${i}` });
    t.store.createRun({ assignmentId: t.a.id, parentRunId: parent.id, outcome: "progressed", summary: "done", endedAt: new Date().toISOString() });
    const other = t.store.createRun({ assignmentId: t.a2.id, outcome: "progressed", summary: "o", endedAt: new Date().toISOString() });
    for (let i = 0; i < 5; i++) t.store.createRun({ assignmentId: t.a2.id, parentRunId: other.id, outcome: "running", summary: `O${i}` });
    const w = await t.wake(t.a.id);
    expect(w.prompt).toContain("the console counts 7 child run(s) still running for this milestone: you may launch 3 more");
    expect(w.prompt).toContain("Run at most 10 child workers at once");
    expect(w.prompt).toContain("`queued: worker ceiling 10`");
    expect(w.prompt).not.toMatch(/free seats|at most 2 /);
  });

  it("at the ceiling the persona may launch 0 more; the ceiling is configurable", async () => {
    const t = setup(3);
    const parent = t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", summary: "earlier wake", endedAt: new Date().toISOString() });
    for (let i = 0; i < 4; i++) t.store.createRun({ assignmentId: t.a.id, parentRunId: parent.id, outcome: "running", summary: `T${i}` });
    const w = await t.wake(t.a.id);
    expect(w.prompt).toContain("counts 4 child run(s) still running for this milestone: you may launch 0 more");
    expect(w.prompt).toContain("Run at most 3 child workers at once");
    expect(w.prompt).toContain("`queued: worker ceiling 3`");
  });
});

describe("T13-S7 protocol B: pick returning a null id records queued, not idle", () => {
  it("B.0/B.1 name the ceiling, the 10 s pause and the queued summary wording", () => {
    const t = setup();
    const run = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "w" });
    const text = wakeProtocol({ base: "http://x", run, assignment: t.store.getAssignment(t.a.id)!, milestone: t.m, persona: t.store.getPersona(t.store.getAssignment(t.a.id)!.personaId)! });
    expect(text).toContain("If 10 child runs are already `running` for this milestone, stop launching");
    expect(text).toContain("wait 10 s after the previous launch");
    expect(text).toContain("`N ready rows queued: no seat with headroom (<pick reason>)`");
    expect(text).toContain("`queued: worker ceiling 10`");
    expect(text).toContain("queued is waiting, not idle");
    expect(text).not.toContain("launch nothing");
    expect(text).not.toContain("up to free seats");
    expect(text).not.toContain("child runs still running for this milestone: you may"); // no count without runningWorkers
  });
});
