import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { wakeProtocol } from "../src/cycle/prompts.js";
import { MONITORING_NEEDS_DATE, WAKE_ENDING_RULE } from "../src/cycle/wakeEnding.js";

// the wake-ending contract (progressed / blocked / monitoring / idle; anything else is failed).

const spine = (rows: string) => `# PLAN-9: Ending

Spine ID: ending-root

## Current State

Status: active
Waiting on: Sam (END-A1)

## Waiting on

- [ask END-A1: approve @Sam since 2026-10-22 row T1] Drop the old archive? — rollback: none — recommend: approve — unblocks: T1
- [answered END-A2 2026-10-22 @Sam] Use pg1? — answer: yes

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T1 | Drop archive | Sam | blocked |
${rows}`;

let reposRoot: string;
let db: DB;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s5-"));
  write("ending/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/ending.git\n`);
  write("ending/docs/spines/root.md", spine("| T2 | Ship the page | | ready |\n"));
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

async function setup() {
  db = openDb(path.join(reposRoot, "console.db"));
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const m = (await call("POST", "/api/milestones", { title: "Ending", repo: "Acme/ending", path: "docs/spines/root.md" })).json;
  const p = (await call("POST", "/api/personas", { name: "steward", remit: "runs the milestone", model: "opus" })).json;
  const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
  const run = async () => (await call("POST", "/api/runs", { assignmentId: a.id })).json;
  return { call, a, run };
}

const now = () => new Date().toISOString();

describe("PATCH /api/runs wake-ending contract", () => {
  it("monitoring without a date → 400 'monitoring needs a date'; with nextCheckAt, until or retryAt it is stored", async () => {
    const { call, run } = await setup();
    const r = await run();
    const bad = await call("PATCH", `/api/runs/${r.id}`, { outcome: "monitoring", summary: "waiting for DNS", endedAt: now() });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toBe(MONITORING_NEEDS_DATE);
    expect((await call("GET", `/api/runs/${r.id}`)).json.outcome).toBe("running");
    const later = new Date(Date.now() + 3_600_000).toISOString();
    // the spine already says it monitors (a dated report otherwise has the console write the line: unblockerRubricLivesRepo.test.ts)
    write("ending/docs/spines/root.md", spine("| T2 | Ship the page | | ready |\n").replace("Status: active\n", "Status: active\nMonitoring: DNS · next check 2099-01-01T00:00:00Z\n"));
    for (const date of [{ nextCheckAt: later }, { until: later }, { retryAt: later }]) {
      const ok = await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "monitoring", summary: "waiting for DNS", endedAt: now(), ...date });
      expect(ok.status).toBe(200);
      expect(ok.json.outcome).toBe("monitoring");
    }
    // a date set by an earlier PATCH of the same run counts
    const r2 = await run();
    await call("PATCH", `/api/runs/${r2.id}`, { nextCheckAt: later });
    expect((await call("PATCH", `/api/runs/${r2.id}`, { outcome: "monitoring", endedAt: now() })).status).toBe(200);
  });

  it("blocked citing a closed (answered) code → monitoring, reported word kept", async () => {
    const { call, run } = await setup();
    const r = await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "blocked", summary: "blocked: waits on END-A2", endedAt: now() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ outcome: "monitoring", reportedOutcome: "blocked" });
    const open = await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "blocked", summary: "blocked: waits on END-A1", endedAt: now() });
    expect(open.json.outcome).toBe("blocked");
  });

  it("idle with a ready row stays idle (T13-S11: readyIgnored + note); idle with none ready stays idle", async () => {
    const { call, run } = await setup();
    const r = await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "idle", summary: "nothing to do", endedAt: now() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ outcome: "idle", readyIgnored: ["T2"] });
    expect(r.json.reportedOutcome).toBeUndefined();
    expect(r.json.summary).toBe("nothing to do [console: idle reported with 1 ready step (T2)]");

    write("ending/docs/spines/root.md", spine("| T2 | Ship the page | | done |\n"));
    const quiet = await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "idle", summary: "nothing to do", endedAt: now() });
    expect(quiet.json).toMatchObject({ outcome: "idle", summary: "nothing to do" });
    expect(quiet.json.reportedOutcome).toBeUndefined();
    expect(quiet.json.readyIgnored).toBeUndefined();
  });

  it("idle of a non-runnable spine stays idle even with a ready row", async () => {
    write("ending/docs/spines/root.md", spine("| T2 | Ship the page | | ready |\n").replace("Status: active", "Status: draft"));
    const { call, run } = await setup();
    const r = await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "idle", summary: "idle: not runnable (Status draft)", endedAt: now() });
    expect(r.json).toMatchObject({ outcome: "idle", summary: "idle: not runnable (Status draft)" });
  });

  it("a finishing PATCH that still says running, or a console-only word, is failed with the reason", async () => {
    const { call, run } = await setup();
    const r = await call("PATCH", `/api/runs/${(await run()).id}`, { summary: "half way", endedAt: now() });
    expect(r.json).toMatchObject({ outcome: "failed", reportedOutcome: "running" });
    expect(r.json.summary).toContain("[console: 'running' is not a wake ending; stored as failed]");
    const b = await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "blank_report", endedAt: now() });
    expect(b.json).toMatchObject({ outcome: "failed", reportedOutcome: "blank_report" });
    // an unknown word is still a 400 (schema)
    expect((await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "done" })).status).toBe(400);
    // a progress PATCH without endedAt is untouched
    expect((await call("PATCH", `/api/runs/${(await run()).id}`, { summary: "step 1" })).json.outcome).toBe("running");
  });
});

describe("prompts say the contract in one block", () => {
  it("section E carries WAKE_ENDING_RULE", () => {
    const text = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", mayWrite: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1", name: "steward" },
    } as never);
    expect(text).toContain(WAKE_ENDING_RULE);
    expect(WAKE_ENDING_RULE).toContain("monitoring needs a date");
    expect(WAKE_ENDING_RULE).toContain("`idle` only when no step is ready");
  });
});
