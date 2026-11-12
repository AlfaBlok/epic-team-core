import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { ReadConfig } from "../src/routes/read.js";
import { openDb, type DB } from "../src/db.js";
import { createStore, type OpenAsk, type RunCheck } from "../src/store.js";
import { readAskMemory, rebuildAskMemory, rememberChecks } from "../src/cycle/askMemory.js";
import { parseRubricLine, rubricLine, RUBRIC_FILE } from "../src/cycle/rubric.js";
import { monitoringCurrent, monitorValue } from "../src/repoState/monitoringLine.js";
import { setStateField, stateField } from "../src/repoState/stateField.js";
import { parseMonitoring } from "../src/adapters/monitoring.js";
import { git, tempCheckout, type TempCheckout } from "./helpers/gitRepo.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/**
 * the Unblocker rubric, a run's monitoring report and the desk placements' state
 * live in the repo; console.db keeps only the run log and memos rebuilt from it. Every console here works on temp
 * checkouts whose origin is a local bare repo (never a real checkout).
 */
const SPINE = (t: string) => `# PLAN-7: ${t}

## Current State

Status: active
Waiting on: nobody
Next action: watch the rollout

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| T1 | Roll out | active |
`;
const REL = "docs/spines/root.md";

let tmp: string;
let reposRoot: string;
let team: TempCheckout;
let work: TempCheckout;
const dbs: DB[] = [];
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e62s8-"));
  reposRoot = path.join(tmp, "repos");
  fs.mkdirSync(reposRoot);
  team = tempCheckout(reposRoot, "team", { "state/big-roots.json": "{}\n" });
  work = tempCheckout(reposRoot, "work", { [REL]: SPINE("Rollout"), "docs/spines/other.md": SPINE("Other") });
});
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  team.cleanup();
  work.cleanup();
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A console on `dbFile` (a second call with a fresh file = another host, or a lost database). */
function boot(dbFile = path.join(tmp, "console.db")) {
  const db = openDb(dbFile);
  dbs.push(db);
  const read: ReadConfig = { reposRoot, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
  const store = createStore(db);
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { db, store, call };
}
type Console = ReturnType<typeof boot>;
const milestone = async (c: Console, rel = REL) => (await c.call("POST", "/api/milestones", { title: "Rollout", repo: "work", path: rel })).json as { id: string };
const breakPush = (t: TempCheckout) => git(t.dir, ["remote", "set-url", "--push", "origin", path.join(tmp, "missing.git")]);
const fixPush = (t: TempCheckout) => git(t.dir, ["remote", "set-url", "--push", "origin", t.origin]);
const hasTable = (db: DB, t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const later = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe("T62-S8 the Unblocker rubric lives in the repo", () => {
  it("the spine line reads back what it writes", () => {
    const s = { threshold: 85, minFactor: 2, weights: { reversal: 3, options: 1.5, impact: 2, evidence: 3.5 }, floorExtra: ["anything touching payroll", "a new vendor"] };
    expect(rubricLine(s)).toBe("threshold 85 · min factor 2 · weights reversal 3, options 1.5, impact 2, evidence 3.5 · also ask Sam: anything touching payroll ; a new vendor");
    expect(parseRubricLine(rubricLine(s))).toEqual(s);
    expect(parseRubricLine("threshold 120 · weights reversal 1")).toEqual({}); // what it cannot read is no setting
  });

  it("PUT global writes the team repo file (one commit on main); a console with a fresh database reads the same settings", async () => {
    const a = boot();
    const before = team.log().length;
    const g = await a.call("PUT", "/api/rubric-settings", { threshold: 60, floorExtra: ["anything touching payroll"], by: "Sam" });
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ threshold: 60, from: "global", global: { threshold: 60, floorExtra: ["anything touching payroll"], updatedBy: "Sam", at: RUBRIC_FILE } });
    expect(team.log().length).toBe(before + 1);
    expect(team.log()[0]).toContain("Unblocker rubric: threshold 60");
    expect(JSON.parse(team.onMain(RUBRIC_FILE))).toMatchObject({ threshold: 60, floorExtra: ["anything touching payroll"], updatedBy: "Sam" });
    expect(hasTable(a.db, "rubric_settings")).toBe(false);

    const b = boot(path.join(tmp, "other.db")); // another host, or the database lost
    expect((await b.call("GET", "/api/rubric-settings")).json).toMatchObject({ threshold: 60, from: "global" });
  });

  it("a milestone override is its spine's `Unblocker rubric:` line; DELETE takes it out; both are commits", async () => {
    const a = boot();
    const m = await milestone(a);
    const o = await a.call("PUT", `/api/rubric-settings/${m.id}`, { threshold: 90, minFactor: 2 });
    expect(o.json).toMatchObject({ threshold: 90, minFactor: 2, from: "milestone", override: { threshold: 90, minFactor: 2 } });
    expect(stateField(work.onMain(REL), "Unblocker rubric")?.value).toBe("threshold 90 · min factor 2");
    // a partial PUT keeps the line's other parts
    await a.call("PUT", `/api/rubric-settings/${m.id}`, { floorExtra: ["a new vendor"] });
    expect(stateField(work.onMain(REL), "Unblocker rubric")?.value).toBe("threshold 90 · min factor 2 · also ask Sam: a new vendor");
    // a hand edit of the line on main is what the console reads (no DB copy)
    const b = boot(path.join(tmp, "other.db"));
    const m2 = await milestone(b);
    expect((await b.call("GET", `/api/rubric-settings?milestoneId=${m2.id}`)).json).toMatchObject({ threshold: 90, from: "milestone" });
    const del = await a.call("DELETE", `/api/rubric-settings/${m.id}`);
    expect(del.json).toMatchObject({ threshold: 75, from: "default", override: null });
    expect(stateField(work.onMain(REL), "Unblocker rubric")).toBeUndefined();
  });

  it("a write that does not land answers 409 and changes nothing (no DB fallback)", async () => {
    const a = boot();
    const m = await milestone(a);
    breakPush(team);
    breakPush(work);
    const g = await a.call("PUT", "/api/rubric-settings", { threshold: 50 });
    expect(g.status).toBe(409);
    expect(g.json.error.code).toBe("spine_write_refused");
    const o = await a.call("PUT", `/api/rubric-settings/${m.id}`, { threshold: 95 });
    expect(o.status).toBe(409);
    expect(() => team.onMain(RUBRIC_FILE)).toThrow();
    expect(stateField(work.onMain(REL), "Unblocker rubric")).toBeUndefined();
    // the checkout was put back too: nothing on disk says 50 or 95
    expect((await a.call("GET", `/api/rubric-settings?milestoneId=${m.id}`)).json).toMatchObject({ threshold: 75, from: "default", global: null, override: null });
  });
});

describe("T62-S8 a monitoring report is the spine's Monitoring line", () => {
  const wake = (c: Console, m: { id: string }) => {
    const p = c.store.createPersona({ name: "Worker", remit: "w", skills: [], model: "claude-opus-5-5", mayWrite: true, freshThreadEachWake: true });
    const a = c.store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    return () => c.store.createRun({ assignmentId: a.id, outcome: "running", summary: "w" });
  };
  const flow = async (c: Console, m: { id: string }) => (await c.call("GET", `/api/milestones/${m.id}/status`)).json.flow;

  it("value grammar: what parseMonitoring reads back", () => {
    const v = monitorValue({ what: "rollout · 7-day hold ; then close", nextCheckAt: "2026-11-09T10:00:00.000Z", until: "2026-11-10T00:00:00.000Z" });
    // the line's own separators in the text are taken out, so the line reads back as one item
    expect(parseMonitoring(v)).toEqual([{ what: "rollout, 7-day hold, then close", until: "2026-11-10T00:00:00.000Z", nextCheckAt: "2026-11-09T10:00:00.000Z" }]);
    const text = setStateField(SPINE("x"), "Monitoring", v, ["Waiting on"]);
    expect(text).toContain("Waiting on: nobody\nMonitoring: ");
    expect(monitoringCurrent(text, Date.parse("2026-11-08T00:00:00Z"))).toBe(true);
    expect(monitoringCurrent(text, Date.parse("2026-11-11T00:00:00Z"))).toBe(false);
  });

  it("PATCH monitoring writes the line (one commit), status reads monitoring from it; a current line is not written twice", async () => {
    const c = boot();
    const m = await milestone(c);
    const run = wake(c, m);
    const next = later(6);
    const r = await c.call("PATCH", `/api/runs/${run().id}`, { outcome: "monitoring", summary: "monitoring: 7-day hold on the rollout", nextCheckAt: next, endedAt: new Date().toISOString() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ outcome: "monitoring", nextCheckAt: next });
    const line = stateField(work.onMain(REL), "Monitoring")?.value;
    expect(line).toBe(`7-day hold on the rollout · next check ${next}`);
    expect(work.log()[0]).toMatch(/^Monitoring: 7-day hold/);
    expect(await flow(c, m)).toMatchObject({ word: "monitoring", reason: "monitoring: 7-day hold on the rollout", nextWakeAt: next });

    const commits = work.log().length;
    const r2 = await c.call("PATCH", `/api/runs/${run().id}`, { outcome: "monitoring", summary: "still holding", nextCheckAt: later(12), endedAt: new Date().toISOString() });
    expect(r2.status).toBe(200);
    expect(work.log().length).toBe(commits); // the spine already says it: the worker owns the line from here
  });

  it("a held report (heldOn) writes a calm `held until the <egress> egress is back` line: monitoring, never a monitor alert", async () => {
    const c = boot();
    const m = await milestone(c);
    const run = wake(c, m);
    const r = await c.call("PATCH", `/api/runs/${run().id}`, { outcome: "monitoring", heldOn: "egress:laptop", summary: "inmuebles24 reads held", retryAt: later(1), endedAt: new Date().toISOString() });
    expect(r.status).toBe(200);
    expect(stateField(work.onMain(REL), "Monitoring")?.value).toMatch(/^held until the laptop egress is back · next check /);
    expect(await flow(c, m)).toMatchObject({ word: "monitoring", reason: "monitoring: held until the laptop egress is back" });
    expect((await c.call("GET", `/api/milestones/${m.id}/status`)).json.items.filter((i: { kind: string }) => i.kind === "monitor_alert")).toEqual([]);
  });

  it("a line that cannot be written refuses the report (409) and records nothing; status is not monitoring", async () => {
    const c = boot();
    const m = await milestone(c);
    const run = wake(c, m)();
    breakPush(work);
    const r = await c.call("PATCH", `/api/runs/${run.id}`, { outcome: "monitoring", summary: "waits for DNS", nextCheckAt: later(2), endedAt: new Date().toISOString() });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("monitoring_not_in_spine");
    expect(r.json.error.message).toContain("Write `Monitoring: waits for DNS · next check");
    expect((await c.call("GET", `/api/runs/${run.id}`)).json).toMatchObject({ outcome: "running" });
    expect((await c.call("GET", `/api/runs/${run.id}`)).json.nextCheckAt).toBeUndefined();
    expect((await flow(c, m)).word).not.toBe("monitoring");
    // once the push works the same report goes through and the spine says it
    fixPush(work);
    expect((await c.call("PATCH", `/api/runs/${run.id}`, { outcome: "monitoring", summary: "waits for DNS", nextCheckAt: later(2), endedAt: new Date().toISOString() })).status).toBe(200);
    expect(stateField(work.onMain(REL), "Monitoring")?.value).toMatch(/^waits for DNS · next check /);
  });

  it("a run's monitoring fields alone never make the status monitoring (the line is the source)", async () => {
    const c = boot();
    const m = await milestone(c);
    const run = wake(c, m)();
    c.store.updateRun(run.id, { outcome: "monitoring", nextCheckAt: later(5), until: later(48), endedAt: new Date().toISOString(), summary: "monitoring: written straight into the DB" });
    expect((await flow(c, m)).word).not.toBe("monitoring");
  });
});

describe("T62-S8 the Unblocker's memory is a memo of the run log", () => {
  it("dropped and rebuilt from runs.openAsks + runs.checks it is the same", async () => {
    const c = boot();
    const m = await milestone(c);
    const p = c.store.createPersona({ name: "Unblocker", remit: "u", skills: [], model: "claude-opus-5-5", mayWrite: true, freshThreadEachWake: true });
    const a = c.store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    const ask = (code: string, print: string): OpenAsk => ({ code, kind: "decide", path: REL, line: 9, print, parts: { text: print, grants: "", comment: "", evidence: "" } });
    const check = (code: string, decision: RunCheck["decision"], why: string): RunCheck => ({ code, decision, why });
    const runs = [
      { asks: [ask("T7-A1", "p1"), ask("T7-A2", "p2")], checks: [check("T7-A1", "left", "Sam's hands"), check("T7-A2", "left", "money")] },
      { asks: [ask("T7-A2", "p2b")], checks: [check("T7-A2", "answered", "the grant settles it")] },
    ].map((x, i) => {
      const r = c.store.createRun({ assignmentId: a.id, outcome: "running", summary: `u${i}` });
      return c.store.updateRun(r.id, { openAsks: x.asks, checks: x.checks, outcome: "idle", endedAt: new Date(Date.UTC(2026, 10, 2, 10, i)).toISOString() })!;
    });
    for (const r of runs) rememberChecks(c.db, r, m.id, r.endedAt!);
    const before = readAskMemory(c.db, m.id);
    expect(before.map((x) => [x.code, x.verdict])).toEqual([["T7-A2", "answered"], ["T7-A1", "left"]]);
    c.db.exec("DROP TABLE ask_memory");
    expect(rebuildAskMemory(c.db, c.store.listRuns({ limit: 500 }), () => m.id)).toBe(2);
    expect(readAskMemory(c.db, m.id)).toEqual(before);
  });
});

describe("T62-S8 carry-over, once per console", () => {
  it("rubric rows go to the repo and the table is dropped; a monitoring report gets its line; placement state columns go", async () => {
    const c = boot();
    const m = await milestone(c);
    const m2 = await milestone(c, "docs/spines/other.md");
    // the old stores, as a console before had them
    c.db.exec("CREATE TABLE rubric_settings (scope TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)");
    c.db.prepare("INSERT INTO rubric_settings VALUES (?, ?, ?, ?)").run("", JSON.stringify({ threshold: 70 }), "2026-11-01T00:00:00Z", "Sam");
    c.db.prepare("INSERT INTO rubric_settings VALUES (?, ?, ?, ?)").run(m.id, JSON.stringify({ threshold: 88, floorExtra: ["payroll"] }), "2026-11-01T00:00:00Z", null);
    const p = c.store.createPersona({ name: "Worker", remit: "w", skills: [], model: "claude-opus-5-5", mayWrite: true, freshThreadEachWake: true });
    const a = c.store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    const r = c.store.createRun({ assignmentId: a.id, outcome: "running", summary: "w" });
    const next = later(30);
    c.store.updateRun(r.id, { outcome: "monitoring", nextCheckAt: next, endedAt: new Date().toISOString(), summary: "monitoring: 7-day hold" });
    c.db.exec("ALTER TABLE desk_placement ADD COLUMN state TEXT NOT NULL DEFAULT 'placed'");
    c.db.exec("ALTER TABLE desk_placement ADD COLUMN closed_at TEXT");
    c.db.prepare("INSERT INTO desk_placement (id, repo, path, kind, item_id, title, placed_at, state, closed_at) VALUES ('pl_1', 'work', ?, 'row', 'T1', 'Roll out', '2026-11-01T00:00:00Z', 'delivered', '2026-11-01T01:00:00Z')").run(REL);

    const dry = await c.call("POST", "/api/e62s8/carry", { dry: true });
    expect(dry.json.counts).toEqual({ "rubric: would write": 2, "monitoring: would write": 1, "placement: state differs": 1, "placement: would drop columns": 1 });
    expect(hasTable(c.db, "rubric_settings")).toBe(true);
    expect(stateField(work.onMain(REL), "Monitoring")).toBeUndefined();

    const real = await c.call("POST", "/api/e62s8/carry", {});
    expect(real.json.counts).toEqual({ "rubric: written": 2, "rubric: table dropped": 1, "monitoring: written": 1, "placement: state differs": 1, "placement: columns dropped": 1 });
    expect(real.json.lines.find((l: { part: string; key: string }) => l.part === "placement" && l.key === "pl_1").detail).toContain("delivered → placed");
    expect(JSON.parse(team.onMain(RUBRIC_FILE))).toMatchObject({ threshold: 70, updatedBy: "Sam" });
    expect(stateField(work.onMain(REL), "Unblocker rubric")?.value).toBe("threshold 88 · also ask Sam: payroll");
    expect(stateField(work.onMain(REL), "Monitoring")?.value).toBe(`7-day hold · next check ${next}`);
    expect(stateField(work.onMain("docs/spines/other.md"), "Monitoring")).toBeUndefined(); // m2 reported nothing
    expect(hasTable(c.db, "rubric_settings")).toBe(false);
    expect((c.db.prepare("PRAGMA table_info(desk_placement)").all() as { name: string }[]).map((x) => x.name)).not.toContain("state");
    expect((await c.call("GET", `/api/rubric-settings?milestoneId=${m.id}`)).json).toMatchObject({ threshold: 88, from: "milestone", global: { threshold: 70 } });
    expect((await c.call("GET", `/api/rubric-settings?milestoneId=${m2.id}`)).json).toMatchObject({ threshold: 70, from: "global" });
    expect((await c.call("GET", `/api/milestones/${m.id}/status`)).json.flow).toMatchObject({ word: "monitoring", nextWakeAt: next });
    expect(((await c.call("GET", "/api/desk/placements")).json as { state: string }[])[0].state).toBe("placed");

    // once: a second run has nothing to do
    const again = await c.call("POST", "/api/e62s8/carry", {});
    expect(again.json.counts).toEqual({});
  });
});
