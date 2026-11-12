import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client, T3ModelSelection, T3ScheduledTask } from "../src/t3/client.js";
import { createStore, type OpenAsk } from "../src/store.js";
import { unblockerChecksProblem, unblockerRules } from "../src/inbox/asks.js";

/** the Unblocker reads every wake fresh (new thread, full prompt), on its persona's model, and reports every ask. */
class FakeT3 implements T3Client {
  launches: { title: string; message?: string; modelSelection?: T3ModelSelection }[] = [];
  sent: { threadId: string; message: string }[] = [];
  ran: string[] = [];
  tasks: T3ScheduledTask[] = [];
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return this.tasks; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow(id: string) { this.ran.push(id); }
  async launchThread(input: { title: string; message?: string; modelSelection?: T3ModelSelection }) {
    this.launches.push(input);
    return { threadId: `thread${this.launches.length}` };
  }
  async sendToThread(threadId: string, message: string) { this.sent.push({ threadId, message }); }
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const OPEN: OpenAsk[] = [
  { code: "T0-A6", kind: "decide", path: "docs/PLAN-0-ROOT.md", line: 42 },
  { code: "T0-A8", kind: "provide", path: "docs/PLAN-0-ROOT.md", line: 44 },
];

function setup(persona: { name?: string; model?: string; fresh?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s9-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new FakeT3();
  const store = createStore(db);
  const app = createApp(db, {
    cycle: { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", openAsks: async () => OPEN },
  });
  cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({
    name: persona.name ?? "Unblocker", remit: "answer asks", skills: [], model: persona.model ?? "claude-opus-5-5", mayWrite: true,
    freshThreadEachWake: persona.fresh ?? true,
  });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: false });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { store, t3, m, p, a, call };
}
const done = () => new Date().toISOString();
const complete = [
  { code: "T0-A6", decision: "answered", answer: "yes", confidence: 85, source: "T0-G3", scores: { reversal: 4, options: 4, impact: 4, evidence: 4 } },
  { code: "whatgpt_v3/T0-A8", decision: "left", why: "no credential found", searched: "docker config auths keys, gh auth status: none for ghcr", scores: { reversal: 1, options: 2, impact: 2, evidence: 1 } },
];

describe("T8-S9 persona flag", () => {
  it("freshThreadEachWake defaults false and round-trips through the API", async () => {
    const t = setup({ fresh: false });
    expect(t.store.getPersona(t.p.id)!.freshThreadEachWake).toBe(false);
    const r = await t.call("PATCH", `/api/personas/${t.p.id}`, { freshThreadEachWake: true, model: "claude-opus-5-5" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ freshThreadEachWake: true, model: "claude-opus-5-5" });
    const c = await t.call("POST", "/api/personas", { name: "x", remit: "y" });
    expect(c.json.freshThreadEachWake).toBe(false);
  });
});

describe("T8-S9 fresh thread per wake", () => {
  it("Run now launches a NEW thread each time with the full prompt as its first message, on the persona's model", async () => {
    const t = setup();
    const r1 = await t.call("POST", `/api/assignments/${t.a.id}/run-now`, {});
    expect(r1.status).toBe(201);
    expect(t.t3.launches).toHaveLength(1);
    const l = t.t3.launches[0];
    expect(l.modelSelection).toEqual({ instanceId: "claudeAgent_seat1", model: "claude-opus-5-5" });
    expect(l.message).toContain("Read this whole prompt; it changes between wakes. Do not rely on earlier wakes.");
    expect(l.message).toContain(`## Console protocol (run ${r1.json.id})`);
    expect(l.message).not.toContain("/wake"); // the full prompt, not the stub
    const run1 = t.store.getRun(r1.json.id)!;
    expect(run1).toMatchObject({ threadId: "thread1", outcome: "running" });
    expect(run1.openAsks).toEqual(OPEN.map((x) => ({ ...x, print: expect.any(String), parts: expect.any(Object) }))); // each with its fingerprint
    t.store.updateRun(run1.id, { outcome: "idle", endedAt: done() });
    const r2 = await t.call("POST", `/api/assignments/${t.a.id}/run-now`, {});
    expect(t.t3.launches).toHaveLength(2);
    expect(t.store.getRun(r2.json.id)!.threadId).toBe("thread2");
    expect(t.t3.sent).toEqual([]); // no home thread is woken
    expect(t.t3.ran).toEqual([]);
  });

  it("a scheduled task's /wake launches the fresh thread and hands off", async () => {
    const t = setup();
    t.store.updateAssignment(t.a.id, { enabled: true, t3ScheduledTaskId: "task1" });
    const w = await t.call("POST", `/api/assignments/${t.a.id}/wake?format=json`, { threadId: "home" });
    expect(w.status).toBe(200);
    expect(w.json.prompt).toContain("handed off to thread1");
    expect(t.t3.launches).toHaveLength(1);
    expect(t.t3.launches[0].message).toContain("New or changed at this wake (assess each): T0-A6 (decide, docs/PLAN-0-ROOT.md:42); T0-A8 (provide, docs/PLAN-0-ROOT.md:44).");
    const run = t.store.listRuns({ assignmentId: t.a.id })[0];
    expect(run.threadId).toBe("thread1");
  });

  it("without the flag the home thread is used as before", async () => {
    const t = setup({ fresh: false, model: "" });
    await t.call("POST", `/api/assignments/${t.a.id}/run-now`, {});
    expect(t.t3.launches).toHaveLength(1);
    expect(t.t3.launches[0].message).toContain("/wake");
    expect(t.t3.launches[0].modelSelection!.model).toBe("claude-sonnet-5-5");
  });
});

describe("T8-S9 Unblocker checks enforcement", () => {
  const running = (t: ReturnType<typeof setup>, openAsks: OpenAsk[] | null = OPEN) => {
    const run = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "" });
    return openAsks ? t.store.updateRun(run.id, { openAsks })! : run;
  };
  it("rejects a finishing PATCH without checks", async () => {
    const t = setup();
    const r = await t.call("PATCH", `/api/runs/${running(t).id}`, { outcome: "idle", endedAt: done(), summary: "answered 0 · left 2" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("checks_incomplete");
    expect(r.json.error.message).toContain("missing: T0-A6, T0-A8");
  });
  it("rejects checks missing an open code", async () => {
    const t = setup();
    const r = await t.call("PATCH", `/api/runs/${running(t).id}`, { outcome: "progressed", endedAt: done(), checks: [complete[0]] });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("missing: T0-A8");
  });
  it("rejects a left provide ask without searched", async () => {
    const t = setup();
    const { searched: _s, ...noSearch } = complete[1];
    const r = await t.call("PATCH", `/api/runs/${running(t).id}`, { outcome: "progressed", endedAt: done(), checks: [complete[0], noSearch] });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("searched");
    expect(r.json.error.message).toContain("T0-A8");
  });
  it("accepts complete checks (repo-qualified codes match) and returns them for Activity", async () => {
    const t = setup();
    const run = running(t);
    const r = await t.call("PATCH", `/api/runs/${run.id}`, { outcome: "progressed", endedAt: done(), summary: "answered 1 · left 1", checks: complete });
    expect(r.status).toBe(200);
    expect(r.json.checks).toEqual(complete.map((c) => ({ ...c, rubric: expect.objectContaining({ clears: c.decision !== "left" }) }))); // stamped
    expect(r.json.openAsks).toEqual(OPEN);
  });
  it("does not gate failed runs, mid-run PATCHes, runs without a recorded list, or other personas", async () => {
    const t = setup();
    expect((await t.call("PATCH", `/api/runs/${running(t).id}`, { summary: "working" })).status).toBe(200);
    expect((await t.call("PATCH", `/api/runs/${running(t).id}`, { outcome: "failed", endedAt: done() })).status).toBe(200);
    expect((await t.call("PATCH", `/api/runs/${running(t, null).id}`, { outcome: "idle", endedAt: done() })).status).toBe(200);
    const o = setup({ name: "Delivery Manager", fresh: false });
    expect((await o.call("PATCH", `/api/runs/${running(o).id}`, { outcome: "idle", endedAt: done() })).status).toBe(200);
  });
  it("no open asks at wake: nothing required", () => {
    expect(unblockerChecksProblem([], undefined)).toBeUndefined();
  });
});

describe("T8-S9 section U", () => {
  it("opens with the read-the-whole-prompt line and states the enforced checks", () => {
    const u = unblockerRules("http://c", "ms_1", undefined, OPEN).join("\n");
    expect(u.split("\n")[0]).toBe("U. Read this whole prompt; it changes between wakes. Do not rely on earlier wakes.");
    expect(u).toContain("must carry `checks`, one entry per new or changed ask at this wake");
    expect(u).toContain("`searched`");
    expect(u).toContain("400 checks_incomplete");
    expect(unblockerRules("http://c", "ms_1", undefined, []).join("\n")).toContain("No ask was open at this wake");
  });
});
