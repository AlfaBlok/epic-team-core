import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client, T3ModelSelection } from "../src/t3/client.js";
import { createStore, type OpenAsk, type RunCheck } from "../src/store.js";
import type { Grant } from "../src/cycle/grants.js";
import { textHash } from "../src/cycle/skipUnchanged.js";
import { commentHash, evidenceHash, evidencePaths, readAskMemory } from "../src/cycle/askMemory.js";

/**
 * the Unblocker remembers each ask. Assessed once when it appears, again only when its line, a grant, the owner's
 * comment or linked evidence changes; unchanged asks are carried as `left (unchanged since <run>)`; a cadence wake with
 * no new or changed ask is skipped, whatever the skip streak.
 */
class FakeT3 implements T3Client {
  launches: { title: string; message?: string; modelSelection?: T3ModelSelection }[] = [];
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { title: string; message?: string; modelSelection?: T3ModelSelection }) {
    this.launches.push(input);
    return { threadId: `thread${this.launches.length}` };
  }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

type Facts = { text: string; comment?: string; evidence?: string; kind?: string };
const ask = (code: string, f: Facts, line = 40): OpenAsk => ({
  code,
  kind: f.kind ?? "decide",
  path: "docs/PLAN-0-ROOT.md",
  line,
  textHash: textHash(f.text),
  ...(f.comment ? { commentHash: textHash(f.comment) } : {}),
  ...(f.evidence ? { evidenceHash: textHash(f.evidence) } : {}),
});
const GRANT: Grant = { code: "T0-G1", scope: "deploy whatgpt", source: "docs/PLAN-0-ROOT.md" };
const left = (code: string, why = `${code}: in the floor`): RunCheck => ({ code, decision: "left", why, scores: { reversal: 1, options: 2, impact: 2, evidence: 1 } });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s24-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new FakeT3();
  const store = createStore(db);
  const state = { asks: [ask("T0-A11", { text: "scan the QR" })], grants: [GRANT] };
  const app = createApp(db, {
    cycle: { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", openAsks: async () => state.asks, grants: async () => state.grants },
  });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "Unblocker", remit: "answer asks", skills: [], model: "claude-opus-5-5", mayWrite: true, freshThreadEachWake: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  store.updateAssignment(a.id, { t3ScheduledTaskId: "task1" });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const newest = () => store.listRuns({ assignmentId: a.id, limit: 1 })[0];
  /** A cadence wake (the scheduled task's /wake): returns the prompt and the run it recorded. */
  const cadence = async () => {
    const w = await call("POST", `/api/assignments/${a.id}/wake?format=json`, { threadId: "home" });
    expect(w.status).toBe(200);
    return { prompt: w.json.prompt as string, run: newest() };
  };
  /** The Unblocker's finishing PATCH with the checks it assessed. */
  const finish = (checks: RunCheck[]) =>
    call("PATCH", `/api/runs/${newest().id}`, { outcome: "idle", endedAt: new Date().toISOString(), summary: `answered 0 · left ${checks.length}`, checks });
  const memory = () => readAskMemory(db, m.id);
  return { db, store, t3, state, m, a, call, cadence, finish, memory, newest };
}

describe("T8-S24 per-ask memory", () => {
  it("a new ask is assessed: listed as new in the prompt, required in checks, remembered with its run and verdict", async () => {
    const t = setup();
    const { prompt, run } = await t.cadence();
    expect(t.t3.launches).toHaveLength(1);
    expect(t.t3.launches[0].message).toContain("New or changed at this wake (assess each): T0-A11 (decide, docs/PLAN-0-ROOT.md:40).");
    expect(prompt ?? "").not.toContain("Unchanged since they were assessed");
    expect((await t.finish([])).json.error.code).toBe("checks_incomplete");
    expect((await t.finish([left("T0-A11")])).status).toBe(200);
    expect(t.memory()).toEqual([
      expect.objectContaining({ code: "T0-A11", runId: run.id, verdict: "left", why: "T0-A11: in the floor", print: run.openAsks![0].print }),
    ]);
  });

  it("an unchanged ask is carried as left (unchanged since <run>), never re-assessed; a new one beside it is", async () => {
    const t = setup();
    const r1 = (await t.cadence()).run;
    await t.finish([left("T0-A11")]);
    t.state.asks = [...t.state.asks, ask("T0-A13", { text: "Polygon key", kind: "provide" })];
    const r2 = (await t.cadence()).run;
    expect(t.t3.launches).toHaveLength(2);
    const msg = t.t3.launches[1].message!;
    expect(msg).toContain("New or changed at this wake (assess each): T0-A13 (provide, docs/PLAN-0-ROOT.md:40).");
    expect(msg).toContain(`Unchanged since they were assessed (do not assess again; the console carries each as \`left (unchanged since <run>)\`): T0-A11 (since ${r1.id}).`);
    expect(r2.openAsks!.map((x) => [x.code, x.carriedFrom])).toEqual([["T0-A11", r1.id], ["T0-A13", undefined]]);
    expect(r2.wokeBecause).toContain("new or changed asks: T0-A13 new");
    // only the new ask is required; the carried one is filled in by the console
    const res = await t.finish([{ code: "T0-A13", decision: "answered", answer: "use the fleet key", confidence: 85, source: "secrets catalog", scores: { reversal: 4, options: 4, impact: 4, evidence: 4 } }]);
    expect(res.status).toBe(200);
    expect(res.json.checks).toEqual([
      { code: "T0-A13", decision: "answered", answer: "use the fleet key", confidence: 85, source: "secrets catalog", scores: { reversal: 4, options: 4, impact: 4, evidence: 4 }, rubric: expect.objectContaining({ score: 100, threshold: 75, clears: true }) },
      { code: "T0-A11", decision: "left", why: "T0-A11: in the floor", scores: { reversal: 1, options: 2, impact: 2, evidence: 1 }, rubric: expect.objectContaining({ score: 34, clears: false }), carriedFrom: r1.id, spine: "docs/PLAN-0-ROOT.md:40" },
    ]);
    // the carried ask keeps its assessing run; the answered one is remembered as answered (re-opened if still open)
    const mem = Object.fromEntries(t.memory().map((x) => [x.code, x]));
    expect(mem["T0-A11"]).toMatchObject({ runId: r1.id, verdict: "left" });
    expect(mem["T0-A13"]).toMatchObject({ runId: r2.id, verdict: "answered" });
  });

  it("the agent may still re-assess a carried ask (its own entry wins and is remembered)", async () => {
    const t = setup();
    await t.cadence();
    await t.finish([left("T0-A11")]);
    const r = await t.call("POST", `/api/assignments/${t.a.id}/run-now`, { instructions: "look at T0-A11 again" });
    expect(r.status).toBe(201);
    const run2 = t.newest();
    expect(run2.openAsks![0].carriedFrom).toBeDefined();
    const res = await t.call("PATCH", `/api/runs/${run2.id}`, {
      outcome: "idle", endedAt: new Date().toISOString(), summary: "answered 0 · left 1 · note: done: looked again", checks: [left("T0-A11", "still the phone")],
    });
    expect(res.status).toBe(200);
    expect(res.json.checks).toEqual([{ ...left("T0-A11", "still the phone"), rubric: expect.objectContaining({ clears: false }) }]);
    expect(t.memory()[0]).toMatchObject({ runId: run2.id, why: "still the phone" });
  });

  for (const [what, change] of [
    ["ask text", (t: ReturnType<typeof setup>) => (t.state.asks = [ask("T0-A11", { text: "scan the QR on the new phone" })])],
    ["a grant", (t: ReturnType<typeof setup>) => (t.state.grants = [...t.state.grants, { code: "T0-G2", scope: "pair the bot", source: "x" }])],
    ["Sam's comment", (t: ReturnType<typeof setup>) => (t.state.asks = [ask("T0-A11", { text: "scan the QR", comment: "msg_1 I'm travelling till Friday" })])],
    ["linked evidence", (t: ReturnType<typeof setup>) => (t.state.asks = [ask("T0-A11", { text: "scan the QR", evidence: "runbook v2" })])],
  ] as const) {
    it(`a change of ${what} re-opens the ask: the cadence wake runs and assesses it`, async () => {
      const t = setup();
      await t.cadence();
      await t.finish([left("T0-A11")]);
      await t.cadence();
      expect(t.t3.launches).toHaveLength(1); // unchanged: skipped
      change(t);
      const { run } = await t.cadence();
      expect(t.t3.launches).toHaveLength(2);
      expect(run.openAsks![0].carriedFrom).toBeUndefined();
      expect(run.wokeBecause).toContain(`T0-A11 changed (${what === "a grant" ? "grants" : what})`);
      expect(t.t3.launches[1].message).toContain("New or changed at this wake (assess each): T0-A11");
      expect((await t.finish([])).json.error.code).toBe("checks_incomplete");
      expect((await t.finish([left("T0-A11")])).status).toBe(200);
      expect(t.memory()[0].runId).toBe(run.id);
    });
  }

  it("an Unblocker cadence wake with nothing new or changed is skipped; the skip carries each verdict", async () => {
    const t = setup();
    t.state.asks = [ask("T0-A11", { text: "scan the QR" }), ask("T0-A12", { text: "pick a name" }, 41)];
    const r1 = (await t.cadence()).run;
    await t.finish([left("T0-A11"), left("T0-A12")]);
    // answered by the DM meanwhile: gone, not news
    t.state.asks = t.state.asks.slice(0, 1);
    const { run, prompt } = await t.cadence();
    expect(t.t3.launches).toHaveLength(1);
    expect(prompt).toContain("Nothing changed since the last check");
    expect(run.summary).toBe(`skipped: nothing new since ${r1.id} (T0-A11 left (unchanged since ${r1.id}))`);
    expect(run.checks).toEqual([{ ...left("T0-A11"), rubric: expect.objectContaining({ clears: false }), carriedFrom: r1.id, spine: "docs/PLAN-0-ROOT.md:40", skipped: true }]);
  });

  it("the 12-skip forced re-wake applies to new or changed asks only: unchanged asks skip past the cap", async () => {
    const t = setup();
    await t.cadence();
    await t.finish([left("T0-A11")]);
    for (let i = 0; i < 20; i++) await t.cadence();
    expect(t.t3.launches).toHaveLength(1);
    expect(t.store.listRuns({ assignmentId: t.a.id, limit: 100 }).filter((r) => r.summary.startsWith("skipped: nothing new"))).toHaveLength(20);
    t.state.asks = [...t.state.asks, ask("T0-A14", { text: "new domain" })];
    await t.cadence();
    expect(t.t3.launches).toHaveLength(2);
  });

  it("a verdict other than left on a still-open ask re-opens it (the answer did not land)", async () => {
    const t = setup();
    await t.cadence();
    await t.finish([{ code: "T0-A11", decision: "answered", answer: "x", confidence: 90, source: "T0-G1", scores: { reversal: 4, options: 4, impact: 4, evidence: 4 } }]);
    const { run } = await t.cadence();
    expect(t.t3.launches).toHaveLength(2);
    expect(run.wokeBecause).toContain("T0-A11 changed (last verdict answered, still open)");
  });

  it("a failed run remembers nothing", async () => {
    const t = setup();
    await t.cadence();
    await t.call("PATCH", `/api/runs/${t.newest().id}`, { outcome: "failed", endedAt: new Date().toISOString(), summary: "no seat", checks: [left("T0-A11")] });
    expect(t.memory()).toEqual([]);
    await t.cadence();
    expect(t.t3.launches).toHaveLength(2);
  });

  it("GET /api/ask-memory and the wake-check export the memory for T8-S25..S27", async () => {
    const t = setup();
    const r1 = (await t.cadence()).run;
    await t.finish([left("T0-A11")]);
    const mem = await t.call("GET", `/api/ask-memory?milestoneId=${t.m.id}`);
    expect(mem.status).toBe(200);
    expect(mem.json).toEqual([
      expect.objectContaining({ milestoneId: t.m.id, code: "T0-A11", runId: r1.id, verdict: "left", parts: expect.objectContaining({ text: expect.any(String), grants: expect.any(String) }) }),
    ]);
    const wc = await t.call("GET", `/api/assignments/${t.a.id}/wake-check`);
    expect(wc.json).toMatchObject({ unblocker: true, wouldSkip: true, asks: [{ code: "T0-A11", status: "unchanged" }] });
    t.state.asks = [...t.state.asks, ask("T0-A15", { text: "raise the limit" })];
    const wc2 = await t.call("GET", `/api/assignments/${t.a.id}/wake-check`);
    expect(wc2.json).toMatchObject({ wouldSkip: false, why: "new or changed asks: T0-A15 new", asks: [{ status: "unchanged" }, { code: "T0-A15", status: "new" }] });
  });
});

describe("T8-S24 what feeds an ask's fingerprint", () => {
  it("Sam's comments: messages sent with the ask's card and answers saved for it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s24c-"));
    const db = openDb(path.join(dir, "c.db"));
    cleanup = () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    expect(commentHash(db, "item1")).toBe("");
    db.prepare("INSERT INTO messages (id, assignment_id, text, ref_item_id, delivery, created_at) VALUES ('msg_1', 'as_1', 'travelling till Friday', 'item1', 'sent', '2026-10-26T10:00:00Z')").run();
    const one = commentHash(db, "item1");
    expect(one).not.toBe("");
    expect(commentHash(db, "item2")).toBe("");
    db.prepare("INSERT INTO jordi_responses (id, item_id, item, kind, text, delivery, created_at) VALUES ('jr_1', 'item1', '{}', 'answer', 'use the old phone', 'queued', '2026-10-26T11:00:00Z')").run();
    expect(commentHash(db, "item1")).not.toBe(one);
  });

  it("linked evidence: the local files the ask line links to (URLs left out); a file edit changes the hash", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s24e-"));
    cleanup = () => fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(path.join(repo, "docs/status"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/status/probe.md"), "probe: 401\n");
    fs.writeFileSync(path.join(repo, "docs/runbook.md"), "step 1\n");
    const line =
      "- [ask T0-A16: decide @Sam since 2026-10-26] raise the limit — context: the probe failed [probe](status/probe.md#today) — details: docs/runbook.md — see https://example.com/x";
    expect(evidencePaths(line, "docs/PLAN-0-ROOT.md", repo)).toEqual(["docs/runbook.md", "docs/status/probe.md"]);
    const before = evidenceHash(line, "docs/PLAN-0-ROOT.md", repo);
    expect(before).not.toBe("");
    expect(evidenceHash(line, "docs/PLAN-0-ROOT.md", repo)).toBe(before);
    fs.writeFileSync(path.join(repo, "docs/status/probe.md"), "probe: 200\n");
    expect(evidenceHash(line, "docs/PLAN-0-ROOT.md", repo)).not.toBe(before);
    expect(evidenceHash("- [ask T0-A17: decide @Sam] no links here", "docs/PLAN-0-ROOT.md", repo)).toBe("");
  });
});
