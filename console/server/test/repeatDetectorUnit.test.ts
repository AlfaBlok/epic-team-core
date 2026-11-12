import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { normaliseSummary, REPEAT_MIN, repeatStreak } from "../src/cycle/repeat.js";
import { createStore, type Run } from "../src/store.js";

// an idle wake stays idle (ready steps recorded as ignored); repeated reports are marked repeating.

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
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s11-"));
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
  return { call, a, m, run };
}

const now = () => new Date().toISOString();

const wake = (id: string, startedAt: string, summary: string, outcome: Run["outcome"] = "blocked"): Run => ({ id, assignmentId: "a", startedAt, endedAt: startedAt, outcome, summary, kind: "wake" });

describe("repeat detector (unit)", () => {
  const t = (h: number) => `2026-10-25T${String(h).padStart(2, "0")}:00:00.000Z`;
  it("4 identical blocked wakes → repeating 4 since the first", () => {
    const runs = [1, 2, 3, 4].map((h) => wake(`r${h}`, t(h), "blocked: waits on T0-A11 (QR scan)"));
    expect(REPEAT_MIN).toBe(4);
    expect(repeatStreak(runs[3], runs)).toEqual({ n: 4, since: t(1) });
    expect(repeatStreak(runs[2], runs)).toBeUndefined(); // 3 in a row is not a repeat yet
  });
  it("a changed number, time or run id in the summary still counts as the same report", () => {
    expect(normaliseSummary("nothing runnable; hold green 5/5 at 2026-10-25T10:00Z (run_0b3c2d1e-1111-2222-3333-444455556666)")).toBe(
      normaliseSummary("Nothing runnable; hold green 4/5 at 2026-10-25T12:00Z (run_9f9f9f9f-aaaa-bbbb-cccc-ddddeeeeffff)"),
    );
    const runs = [
      wake("r1", t(1), "idle: hold green 5/5, checked 10:00 UTC", "idle"),
      wake("r2", t(2), "idle: hold green 5/5, checked 12:00 UTC", "idle"),
      wake("r3", t(3), "idle: hold green 4/5, checked 14:00 UTC [console: idle reported with 1 ready step (T2)]", "idle"),
      wake("r4", t(4), "idle: hold green 5/5, checked 16:00 UTC", "idle"),
    ];
    expect(repeatStreak(runs[3], runs)).toEqual({ n: 4, since: t(1) });
  });
  it("a new step or ask code is real change: T0-A11 ×3 then T0-A12 resets; VH-T6/VH-T16 and T13-S10/T13-S11 differ", () => {
    const runs = [1, 2, 3].map((h) => wake(`r${h}`, t(h), "blocked: waits on T0-A11 (QR scan)"));
    expect(repeatStreak(wake("r4", t(4), "blocked: waits on T0-A12 (QR scan)"), runs)).toBeUndefined();
    expect(repeatStreak(wake("r4", t(4), "blocked: waits on T0-A11 (QR scan)"), runs)).toEqual({ n: 4, since: t(1) });
    expect(normaliseSummary("next VH-T6")).not.toBe(normaliseSummary("next VH-T16"));
    expect(normaliseSummary("working T13-S10")).not.toBe(normaliseSummary("working T13-S11"));
    expect(normaliseSummary("PLAN-13 holds")).not.toBe(normaliseSummary("PLAN-25 holds"));
  });
  it("percentages, times, counts and short shas changing still count as the same report", () => {
    const runs = [
      wake("r1", t(1), "monitoring T0-A11: 40% done at 10:00 UTC, 3 of 9 files, head acb048c", "monitoring"),
      wake("r2", t(2), "monitoring T0-A11: 55% done at 11:30 UTC, 5 of 9 files, head 68a1158", "monitoring"),
      wake("r3", t(3), "monitoring T0-A11: 70.5% done at 13:00 UTC, 6 of 9 files, head 54199c6", "monitoring"),
      wake("r4", t(4), "monitoring T0-A11: 90% done at 14:45 UTC, 8 of 9 files, head e4fec88", "monitoring"),
    ];
    expect(repeatStreak(runs[3], runs)).toEqual({ n: 4, since: t(1) });
  });
  it("a different summary or outcome resets the streak; child runs and running wakes are not counted", () => {
    const runs = [
      wake("r0", t(0), "blocked: waits on T0-A11 (QR scan)"),
      wake("r1", t(1), "progressed: shipped the QR page, next T0-S3", "progressed"),
      ...[2, 3, 4].map((h) => wake(`r${h}`, t(h), "blocked: waits on T0-A11 (QR scan)")),
      { ...wake("c1", t(3), "blocked: waits on T0-A11 (QR scan)"), parentRunId: "r3" },
      wake("r5", t(5), "blocked: waits on T0-A11 (QR scan)"),
    ];
    expect(repeatStreak(runs.at(-1)!, runs)).toEqual({ n: 4, since: t(2) });
    expect(repeatStreak(wake("r6", t(6), "blocked: waits on T0-A11, the photo is late"), runs)).toBeUndefined();
    expect(repeatStreak(wake("r6", t(6), "blocked: waits on T0-A11 (QR scan)", "monitoring"), runs)).toBeUndefined();
    expect(repeatStreak({ ...wake("r6", t(6), "x"), outcome: "running" }, runs)).toBeUndefined();
  });
});

describe("PATCH /api/runs + status (T13-S11)", () => {
  it("idle with a ready row stays idle, records readyIgnored, and the milestone header names the disagreement", async () => {
    const { call, m, run } = await setup();
    const r = await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "idle", summary: "nothing runnable", endedAt: now() });
    expect(r.json).toMatchObject({ outcome: "idle", readyIgnored: ["T2"] });
    const st = (await call("GET", `/api/milestones/${m.id}/status`)).json;
    expect(st.wakeNotes).toEqual([
      expect.objectContaining({ kind: "ready_ignored", persona: "steward", steps: ["T2"], text: "steward says nothing is runnable, but 1 step reads ready: T2: fix the step status or work them" }),
    ]);
    expect(st.reasons).toContain("steward says nothing is runnable, but 1 step reads ready: T2: fix the step status or work them");
    // a later wake that works the step clears the note
    await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "progressed", summary: "shipped T2, next none", endedAt: now() });
    expect((await call("GET", `/api/milestones/${m.id}/status`)).json.wakeNotes).toBeUndefined();
  });

  it("4 identical blocked wakes → the 4th is repeating 4; the header says same report ×4; a different report resets", async () => {
    const { call, m, run } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await run();
      ids.push(r.id);
      const res = await call("PATCH", `/api/runs/${r.id}`, { outcome: "blocked", summary: `blocked: waits on END-A1 (check ${i + 1})`, endedAt: now() });
      expect(res.json.outcome).toBe("blocked");
      if (i < 3) expect(res.json.repeating).toBeUndefined();
      else expect(res.json).toMatchObject({ repeating: 4, repeatSince: (await call("GET", `/api/runs/${ids[0]}`)).json.startedAt });
    }
    const st = (await call("GET", `/api/milestones/${m.id}/status`)).json;
    expect(st.wakeNotes).toEqual([expect.objectContaining({ kind: "repeating", persona: "steward", n: 4 })]);
    expect(st.wakeNotes[0].text).toMatch(/^steward: same report ×4 since \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/);
    expect(st.items.some((x: { kind: string }) => x.kind === "repeating")).toBe(false); // no inbox item
    const fresh = await call("PATCH", `/api/runs/${(await run()).id}`, { outcome: "blocked", summary: "blocked: waits on END-A1, Sam asked for a new quote", endedAt: now() });
    expect(fresh.json.repeating).toBeUndefined();
    expect((await call("GET", `/api/milestones/${m.id}/status`)).json.wakeNotes).toBeUndefined();
  });
});

describe("GET /api/runs?since (T13-S11 Team footer)", () => {
  it("returns every run started since, past the 500-row default cap; older runs and a bad since are refused", async () => {
    const { call, a } = await setup();
    const store = createStore(db);
    const h = 3_600_000;
    const base = Date.now();
    for (let i = 0; i < 620; i++)
      store.createRun({ assignmentId: a.id, startedAt: new Date(base - (i % 20) * h - i * 1000).toISOString(), endedAt: new Date(base - (i % 20) * h).toISOString(), outcome: "progressed", summary: `w${i}`, kind: "wake" });
    store.createRun({ assignmentId: a.id, startedAt: new Date(base - 30 * h).toISOString(), endedAt: new Date(base - 30 * h).toISOString(), outcome: "progressed", summary: "old", kind: "wake" });
    expect((await call("GET", "/api/runs")).json).toHaveLength(500);
    const since = new Date(base - 24 * h).toISOString();
    const r = await call("GET", `/api/runs?since=${encodeURIComponent(since)}`);
    expect(r.status).toBe(200);
    expect(r.json).toHaveLength(620);
    expect(r.json.some((x: Run) => x.summary === "old")).toBe(false);
    expect((await call("GET", `/api/runs?since=${encodeURIComponent(since)}&limit=10`)).json).toHaveLength(10);
    expect((await call("GET", "/api/runs?since=yesterday")).status).toBe(400);
  });
});
