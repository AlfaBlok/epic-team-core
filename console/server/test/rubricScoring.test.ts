import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client, T3ModelSelection } from "../src/t3/client.js";
import { createStore, type OpenAsk, type RunCheck } from "../src/store.js";
import type { Grant } from "../src/cycle/grants.js";
import { textHash } from "../src/cycle/skipUnchanged.js";
import { readAskMemory } from "../src/cycle/askMemory.js";
import { tempCheckout } from "./helpers/gitRepo.js";
import { DEFAULT_RUBRIC, FACTORS, HARD_FLOOR, judge, rubricScore, rubricWords, withRubric, type Scores } from "../src/cycle/rubric.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/**
 * the Unblocker decides by a tunable confidence rubric. Four factors 0-4 → a weighted 0-100 score; an answer
 * stands only above the threshold, with no factor under the minimum and outside the hard floor (the owner's hands, new
 * money, new public exposure, irreversible loss). Settings: default, global, per-milestone override. Scores are stamped
 * on each check and kept in the per-ask memory.
 */
class FakeT3 implements T3Client {
  launches: { title: string; message?: string; modelSelection?: T3ModelSelection }[] = [];
  constructor(private root: string) {}
  async listProjects() {
    return [{ id: "proj", title: "work", workspaceRoot: this.root }];
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
const savedGit = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedGit.g], ["GIT_CONFIG_SYSTEM", savedGit.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** the rubric lives in the repo, so the console here works on temp checkouts (a team repo and an epic repo). */
const spineText = (t: string) => `# EPIC-900: ${t}\n\n## Current State\n\nStatus: active\nWaiting on: nobody\nNext action: work\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| T1 | One | active |\n`;

const ask = (code: string, text: string, line = 40): OpenAsk => ({ code, kind: "decide", path: "docs/EPIC-900-ROOT.md", line, textHash: textHash(text) });
const GRANT: Grant = { code: "E900-G1", scope: "deploy whatgpt", source: "docs/EPIC-900-ROOT.md" };
const all = (n: number): Scores => ({ reversal: n, options: n, impact: n, evidence: n });
const answered = (code: string, scores: Scores, floor?: string[]): RunCheck => ({
  code, decision: "answered", answer: "do it", confidence: 85, source: "E900-G1", scores, ...(floor ? { floor } : {}),
});
const left = (code: string, scores: Scores, floor?: string[]): RunCheck => ({ code, decision: "left", why: "Sam's", scores, ...(floor ? { floor } : {}) });

function setup() {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s26-"));
  const reposRoot = path.join(dir, "repos");
  fs.mkdirSync(reposRoot);
  const team = tempCheckout(reposRoot, "team", { "README.md": "# team\n" });
  const work = tempCheckout(reposRoot, "work", { "docs/spines/a.md": spineText("A"), "docs/spines/b.md": spineText("B") });
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new FakeT3(work.dir);
  const store = createStore(db);
  const state = { asks: [ask("E900-A11", "pick the host")], grants: [GRANT] };
  const app = createApp(db, {
    read: { reposRoot, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    cycle: { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", openAsks: async () => state.asks, grants: async () => state.grants },
  });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    team.cleanup();
    work.cleanup();
  };
  const m = store.createMilestone({ title: "M", repo: "work", path: "docs/spines/a.md", owner: "", paused: false });
  const m2 = store.createMilestone({ title: "M2", repo: "work", path: "docs/spines/b.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Unblocker", remit: "answer asks", skills: [], model: "claude-opus-5-5", mayWrite: true, freshThreadEachWake: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  store.updateAssignment(a.id, { t3ScheduledTaskId: "task1" });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const newest = () => store.listRuns({ assignmentId: a.id, limit: 1 })[0];
  const runNow = async () => {
    const r = await call("POST", `/api/assignments/${a.id}/run-now`, {});
    expect(r.status).toBe(201);
    return newest();
  };
  const finish = (checks: RunCheck[], runId = newest().id) =>
    call("PATCH", `/api/runs/${runId}`, { outcome: "idle", endedAt: new Date().toISOString(), summary: "answered · left", checks });
  return { db, store, t3, state, m, m2, a, call, runNow, finish, newest, team, work, memory: () => readAskMemory(db, m.id) };
}

describe("E908-S26 rubric scoring", () => {
  it("each factor moves the score by its weight; all 4 = 100, all 0 = 0", () => {
    const w = DEFAULT_RUBRIC.weights;
    const total = FACTORS.reduce((n, f) => n + w[f], 0);
    expect(rubricScore(all(4), w)).toBe(100);
    expect(rubricScore(all(0), w)).toBe(0);
    for (const f of FACTORS) {
      // one factor dropped from 4 to 0: the score loses exactly that factor's share
      expect(rubricScore({ ...all(4), [f]: 0 }, w)).toBe(Math.round(100 - (100 * w[f]) / total));
      // and each step of that factor is worth a quarter of its share
      expect(rubricScore({ ...all(0), [f]: 2 }, w)).toBe(Math.round((50 * w[f]) / total));
    }
    // equal weights: plain mean
    expect(rubricScore({ reversal: 4, options: 2, impact: 3, evidence: 1 }, all(1))).toBe(63);
    expect(rubricScore(all(4), all(0))).toBe(0);
  });

  it("the threshold: at or above clears, one below does not; a factor under the minimum vetoes whatever the total", () => {
    const s = { ...DEFAULT_RUBRIC, weights: all(1), threshold: 75 };
    expect(judge(all(3), [], s)).toMatchObject({ score: 75, clears: true });
    expect(judge({ ...all(3), evidence: 2 }, [], s)).toMatchObject({ score: 69, clears: false });
    expect(judge({ ...all(3), evidence: 2 }, [], { ...s, threshold: 69 })).toMatchObject({ clears: true });
    // a one-way door (reversal 0) never clears, even at a total over the threshold
    expect(judge({ ...all(4), reversal: 0 }, [], { ...s, threshold: 70 })).toMatchObject({ score: 75, clears: false });
    expect(judge({ ...all(4), reversal: 0 }, [], { ...s, threshold: 70, minFactor: 0 })).toMatchObject({ clears: true });
  });

  it("every hard-floor item keeps an ask Sam's even at a perfect score", () => {
    expect(HARD_FLOOR.map((x) => x.id)).toEqual(["jordi_hands", "new_money", "new_public_exposure", "irreversible_loss"]);
    for (const f of HARD_FLOOR) expect(judge(all(4), [f.id], DEFAULT_RUBRIC)).toMatchObject({ score: 100, clears: false });
  });

  it("rubricWords reads the stamp", () => {
    const c = { scores: { reversal: 4, options: 3, impact: 3, evidence: 4 }, rubric: judge({ reversal: 4, options: 3, impact: 3, evidence: 4 }, [], DEFAULT_RUBRIC) };
    expect(rubricWords(c)).toBe("score 91/75 · reversal 4 · options 3 · impact 3 · evidence 4");
    expect(rubricWords({ ...c, floor: ["new_money"] })).toContain("floor: new_money");
    expect(rubricWords({})).toBeUndefined();
  });
});

describe("E908-S26 the finishing PATCH is judged by the rubric", () => {
  it("the wake prompt carries the rubric, the factors, the threshold and the hard floor", async () => {
    const t = setup();
    await t.runNow();
    const msg = t.t3.launches[0].message!;
    expect(msg).toContain("Decide by the confidence rubric");
    for (const f of FACTORS) expect(msg).toContain(`        - ${f}: `);
    expect(msg).toContain("ANSWER when the score is at least 75, no factor is below 1, and the ask is outside the hard floor");
    for (const f of HARD_FLOOR) expect(msg).toContain(`        - ${f.id}: `);
    expect(msg).toContain("(settings: default)");
    expect(msg).not.toContain("ANSWER otherwise when at least 75% confident");
  });

  it("an assessed check without valid scores is rejected (400 rubric)", async () => {
    const t = setup();
    await t.runNow();
    const r = await t.finish([{ code: "E900-A11", decision: "left", why: "unclear" }]);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("rubric");
    expect(r.json.error.message).toContain("missing or invalid for E900-A11");
    expect((await t.finish([left("E900-A11", { ...all(2), impact: 7 })])).json.error.code).toBe("rubric");
    expect((await t.finish([left("E900-A11", all(2), ["my_own_floor"])])).json.error.message).toContain("unknown floor ids");
  });

  it("an answer below the threshold or with a weak factor is rejected and told to undo; at the threshold it stands", async () => {
    const t = setup();
    await t.call("PUT", `/api/rubric-settings`, { weights: all(1) });
    await t.runNow();
    const low = await t.finish([answered("E900-A11", { ...all(3), evidence: 2 })]);
    expect(low.status).toBe(400);
    expect(low.json.error.message).toContain("E900-A11 scores 69 < threshold 75");
    expect(low.json.error.message).toContain("Undo each in the spine");
    const veto = await t.finish([answered("E900-A11", { ...all(4), reversal: 0 })]);
    expect(veto.json.error.message).toContain("has a factor below 1 (reversal)");
    const ok = await t.finish([answered("E900-A11", all(3))]);
    expect(ok.status).toBe(200);
    expect(ok.json.checks[0].rubric).toEqual({ score: 75, threshold: 75, minFactor: 1, weights: all(1), clears: true, from: "global" });
  });

  it("every hard-floor case is left for Sam even at a perfect score: an answer is rejected, a left is stored", async () => {
    for (const f of HARD_FLOOR) {
      const t = setup();
      await t.runNow();
      const bad = await t.finish([answered("E900-A11", all(4), [f.id])]);
      expect(bad.status).toBe(400);
      expect(bad.json.error.message).toContain(`E900-A11 is in the floor (${f.id})`);
      // a split's answered part may not be in the floor either
      expect((await t.finish([{ ...answered("E900-A11", all(4), [f.id]), decision: "split" }])).status).toBe(400);
      const ok = await t.finish([left("E900-A11", all(4), [f.id])]);
      expect(ok.status).toBe(200);
      expect(ok.json.checks[0].rubric).toMatchObject({ score: 100, clears: false });
      expect(t.memory()[0].check).toMatchObject({ floor: [f.id], rubric: { score: 100, clears: false } });
      cleanup?.();
      cleanup = undefined;
    }
  });

  it("scores are stored per verdict in the per-ask memory (answered and left), with the threshold they were judged by", async () => {
    const t = setup();
    t.state.asks = [ask("E900-A11", "pick the host"), ask("E900-A12", "scan the QR", 41)];
    const run = await t.runNow();
    const r = await t.finish([answered("E900-A11", { reversal: 4, options: 3, impact: 3, evidence: 4 }), left("E900-A12", all(3), ["jordi_hands"])]);
    expect(r.status).toBe(200);
    const mem = Object.fromEntries(t.memory().map((x) => [x.code, x]));
    expect(mem["E900-A11"]).toMatchObject({ runId: run.id, verdict: "answered", check: { scores: { reversal: 4, options: 3, impact: 3, evidence: 4 }, rubric: { score: 91, threshold: 75, clears: true, from: "default" } } });
    expect(mem["E900-A12"]).toMatchObject({ runId: run.id, verdict: "left", check: { scores: all(3), floor: ["jordi_hands"], rubric: { score: 75, threshold: 75, clears: false } } });
    // exported for
    const api = await t.call("GET", `/api/ask-memory?milestoneId=${t.m.id}`);
    expect(api.json.map((x: { check: RunCheck }) => x.check.rubric?.score).sort()).toEqual([75, 91]);
  });

  it("an agent-sent rubric is replaced by the console's stamp", async () => {
    const t = setup();
    await t.runNow();
    const r = await t.finish([{ ...left("E900-A11", all(1)), rubric: { score: 99, threshold: 0, clears: true } as unknown as RunCheck["rubric"] }]);
    expect(r.json.checks[0].rubric).toMatchObject({ score: 25, threshold: 75, clears: false });
  });

  it("the run is judged by the settings its wake prompt showed (a later change does not move the goalposts)", async () => {
    const t = setup();
    const run = await t.runNow();
    await t.call("PUT", `/api/rubric-settings/${t.m.id}`, { threshold: 95 });
    const r = await t.finish([answered("E900-A11", { ...all(4), options: 3 })], run.id);
    expect(r.status).toBe(200);
    expect(r.json.checks[0].rubric).toMatchObject({ threshold: 75, from: "default" });
  });
});

describe("E908-S26 settings: default, global, per-milestone override", () => {
  it("GET shows the default; PUT global, PUT a milestone override, DELETE it; other milestones keep the global", async () => {
    const t = setup();
    const d = await t.call("GET", `/api/rubric-settings?milestoneId=${t.m.id}`);
    expect(d.json).toMatchObject({ threshold: 75, weights: DEFAULT_RUBRIC.weights, minFactor: 1, from: "default", hardFloor: HARD_FLOOR.map((x) => x.id), override: null, global: null });
    expect(d.json.floor.map((x: { id: string }) => x.id)).toEqual(HARD_FLOOR.map((x) => x.id));

    const g = await t.call("PUT", `/api/rubric-settings`, { threshold: 60, by: "Sam" });
    expect(g.json).toMatchObject({ threshold: 60, from: "global", global: { threshold: 60, updatedBy: "Sam" } });
    const o = await t.call("PUT", `/api/rubric-settings/${t.m.id}`, { threshold: 90, weights: all(1), floorExtra: ["anything touching payroll"] });
    expect(o.json).toMatchObject({ threshold: 90, weights: all(1), from: "milestone" });
    // the hard floor stays; extras add to it
    expect(o.json.floor.map((x: { id: string }) => x.id)).toEqual([...HARD_FLOOR.map((x) => x.id), "extra:1"]);
    // a partial PUT keeps the other fields of the override
    expect((await t.call("PUT", `/api/rubric-settings/${t.m.id}`, { minFactor: 2 })).json).toMatchObject({ threshold: 90, minFactor: 2, weights: all(1) });
    expect((await t.call("GET", `/api/rubric-settings?milestoneId=${t.m2.id}`)).json).toMatchObject({ threshold: 60, from: "global" });

    // the wake prompt and the judgement use the override
    await t.runNow();
    const msg = t.t3.launches[0].message!;
    expect(msg).toContain("ANSWER when the score is at least 90, no factor is below 2");
    expect(msg).toContain("(settings: milestone)");
    expect(msg).toContain("        - extra:1: anything touching payroll.");
    expect((await t.finish([answered("E900-A11", { ...all(4), options: 2 })])).json.error.message).toContain("scores 88 < threshold 90");
    expect((await t.finish([answered("E900-A11", all(4), ["extra:1"])])).json.error.message).toContain("in the floor (extra:1)");
    expect((await t.finish([answered("E900-A11", all(4))])).status).toBe(200);

    const del = await t.call("DELETE", `/api/rubric-settings/${t.m.id}`);
    expect(del.json).toMatchObject({ threshold: 60, from: "global", override: null });
  });

  it("rejects bad settings and unknown milestones", async () => {
    const t = setup();
    expect((await t.call("PUT", `/api/rubric-settings`, { threshold: 120 })).status).toBe(400);
    expect((await t.call("PUT", `/api/rubric-settings`, { weights: all(0) })).status).toBe(400);
    expect((await t.call("PUT", `/api/rubric-settings`, { weights: { reversal: 1 } })).status).toBe(400);
    expect((await t.call("PUT", `/api/rubric-settings`, { minFactor: 5 })).status).toBe(400);
    expect((await t.call("PUT", `/api/rubric-settings`, { floor: [] })).status).toBe(400); // the hard floor is not a setting
    expect((await t.call("PUT", `/api/rubric-settings/nope`, { threshold: 50 })).status).toBe(404);
    expect((await t.call("GET", `/api/rubric-settings?milestoneId=nope`)).status).toBe(404);
  });
});

describe("E908-S26 the FYI card shows the scores", () => {
  it("withRubric adds the remembered stamp to a persona-decided card, not to Sam's own asks or left verdicts", async () => {
    const t = setup();
    t.state.asks = [ask("E900-A11", "pick the host"), ask("E900-A12", "scan the QR", 41)];
    await t.runNow();
    await t.finish([answered("E900-A11", { reversal: 4, options: 3, impact: 3, evidence: 4 }), left("E900-A12", all(4), ["jordi_hands"])]);
    const items = withRubric(t.db, [
      { code: "E900-A11", milestoneId: t.m.id, decidedBy: "Unblocker" },
      { code: "E900-A12", milestoneId: t.m.id, decidedBy: "Unblocker" },
      { code: "E900-A11", milestoneId: t.m.id },
    ]);
    expect(items[0].rubric).toBe("score 91/75 · reversal 4 · options 3 · impact 3 · evidence 4");
    expect(items[1].rubric).toBeUndefined();
    expect(items[2].rubric).toBeUndefined();
  });
});
