import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { Assignment, Run } from "../src/store.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { milestoneStatus, type StatusInput } from "../src/status/compute.js";
import { FOLLOW_UP_GAP_MS, FOLLOW_UP_MARK, LEFT_READY_RULE, followUp } from "../src/cycle/followUp.js";
import { wakeProtocol } from "../src/cycle/prompts.js";
import { buildWakePrompt } from "../src/wakePrompt.js";

// Stalled item, bounded follow-up wake (1 per hour, depth 1), honest 'off'.

const NOW = Date.parse("2026-10-24T22:00:00Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const node = (key: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "ready", color: "grey", children, flags: [], ...over,
});
const EPIC15: Tree = {
  milestoneId: "m1",
  root: node("m1", { kind: "spine", status: "active", color: "blue" }, [node("m1/R4", { ready: true }), node("m1/R5", { ready: true })]),
  counts: { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 0, closed: 0, flagged: 0, source: "spines", warnings: [],
};
const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  id: "a1", milestoneId: "m1", personaId: "p1", cadence: { type: "interval", everyMinutes: 180 }, enabled: true, writeEnabled: false, writeScope: "", createdAt: iso(-600),
  nextRunAt: iso(30), nextWakeAt: iso(30), ...over,
});
const NAMES: Record<string, string> = { p1: "Diagnostician", p2: "Fixer", p3: "Reporter" };
const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  milestone: { id: "m1", paused: false }, status: "active", tree: EPIC15, waiting: [], runs: [], assignments: [], personaName: (id) => NAMES[id], now: NOW, ...over,
});

describe("T13-S3 Stalled item", () => {
  it("PLAN-15 fixture: 3 assignments enabled=0, 2 ready rows → stalled + one alarm item suggesting the persona that woke last", () => {
    const off = [
      assignment({ id: "a1", personaId: "p1", enabled: false, nextWakeAt: undefined, lastRunAt: iso(-30) }),
      assignment({ id: "a2", personaId: "p2", enabled: false, nextWakeAt: undefined }),
      assignment({ id: "a3", personaId: "p3", enabled: false, nextWakeAt: undefined }),
    ];
    const s = milestoneStatus(input({ assignments: off }));
    expect(s.flow.word).toBe("stalled");
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ id: "stalled:m1", kind: "stalled", state: "alarm", title: "2 steps ready, nobody on. Switch on Diagnostician?" }); // the 2 ready rows, not every open node
    expect(s.items[0].switchOn?.map((x) => x.persona)).toEqual(["Diagnostician", "Fixer", "Reporter"]);
    expect(s.needsYou).toBe(0); // orange, never red: not an ask
  });

  it("enabling one assignment clears it: queued, no stalled item", () => {
    const s = milestoneStatus(input({ assignments: [assignment(), assignment({ id: "a2", personaId: "p2", enabled: false, nextWakeAt: undefined })] }));
    expect(s.flow.word).toBe("queued");
    expect(s.items.filter((i) => i.kind === "stalled")).toEqual([]);
  });

  it("a marked outcome (accomplished) raises no Stalled item", () => {
    const s = milestoneStatus(input({ outcome: { verdict: "accomplished", sentence: "x", evidence: [], risk: null, closedAt: null, closedBy: null } }));
    expect(s.items.filter((i) => i.kind === "stalled")).toEqual([]);
  });

  it("no persona assigned: the item offers only Pause", () => {
    const s = milestoneStatus(input());
    expect(s.items[0]).toMatchObject({ kind: "stalled", title: expect.stringMatching(/steps ready, no persona assigned$/) });
    expect(s.items[0].switchOn).toBeUndefined();
  });
});

const wake = (over: Partial<Run> = {}): Run => ({ id: "r1", assignmentId: "a1", milestoneId: "m1", startedAt: iso(-20), outcome: "running", summary: "", kind: "wake", ...over }) as Run;
const base = { run: wake(), outcome: "progressed" as const, assignment: assignment(), milestone: { paused: false }, runs: [] as Run[], ready: ["R4", "R5"], now: NOW };

describe("T13-S3 followUp()", () => {
  it("progressed with ready rows on an enabled assignment books one, now", () => {
    expect(followUp(base)).toEqual({ book: true, at: new Date(NOW).toISOString(), note: `[console: 2 steps still ready (R4, R5); ${FOLLOW_UP_MARK} ${new Date(NOW).toISOString()}]` });
  });
  it("nothing ready, not progressed, a child run, a paused milestone: nothing", () => {
    expect(followUp({ ...base, ready: [] })).toEqual({ book: false });
    expect(followUp({ ...base, outcome: "monitoring" })).toEqual({ book: false });
    expect(followUp({ ...base, run: wake({ parentRunId: "r0" }) })).toEqual({ book: false });
    expect(followUp({ ...base, milestone: { paused: true } })).toEqual({ book: false });
  });
  it("a disabled (or parked) assignment books none: one-off wake", () => {
    for (const a of [assignment({ enabled: false }), assignment({ enabled: false, parkedAt: iso(-60) })]) {
      const f = followUp({ ...base, assignment: a });
      expect(f.book).toBe(false);
      expect(f.note).toMatch(/off, so this was a one-off wake/);
    }
  });
  it("not a second within the hour; again after an hour", () => {
    // r0 booked, r0b was its follow-up (books none), r1 = the next wake, still within the hour of r0's booking
    const booker = wake({ id: "r0", startedAt: iso(-60), endedAt: iso(-50), outcome: "progressed", summary: `done [console: ${FOLLOW_UP_MARK} x]` });
    const followed = wake({ id: "r0b", startedAt: iso(-49), endedAt: iso(-30), outcome: "progressed", summary: "R4 done" });
    const f = followUp({ ...base, runs: [booker, followed] });
    expect(f.book).toBe(false);
    expect(f.note).toMatch(/already booked within the hour \(run r0\)/);
    expect(followUp({ ...base, runs: [booker, followed], now: NOW + FOLLOW_UP_GAP_MS }).book).toBe(true);
  });
  it("depth 1: the follow-up wake itself books none, even past the hour", () => {
    const booker = wake({ id: "r0", startedAt: iso(-200), endedAt: iso(-21), outcome: "progressed", summary: `done [console: ${FOLLOW_UP_MARK} x]` });
    const f = followUp({ ...base, runs: [booker], now: NOW + 2 * FOLLOW_UP_GAP_MS });
    expect(f.book).toBe(false);
    expect(f.note).toMatch(/depth 1/);
  });
});

// ---------- through the API (run PATCH) ----------

let reposRoot: string;
let db: DB;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const SPINE = `# PLAN-15: VPS health team

## Current State

Status: active

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| R4 | Diagnose disk | | ready |
| R5 | Diagnose swap | | ready |
`;

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s3-"));
  write("vps/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/vps.git\n`);
  write("vps/docs/spines/root.md", SPINE);
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

async function setup(enabled: boolean, remit = "diagnoses") {
  db = openDb(path.join(reposRoot, "console.db"));
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const m = (await call("POST", "/api/milestones", { title: "PLAN-15", repo: "Acme/vps", path: "docs/spines/root.md" })).json;
  const p = (await call("POST", "/api/personas", { name: "Diagnostician", remit, model: "opus" })).json;
  const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 180 }, enabled })).json;
  const finish = async (summary: string) => {
    const r = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    return (await call("PATCH", `/api/runs/${r.id}`, { outcome: "progressed", summary, endedAt: new Date().toISOString() })).json;
  };
  return { call, a, m, finish };
}

describe("T13-S3 follow-up through PATCH /api/runs", () => {
  it("T34-S19: a standing-duty (pack-role) persona books none and is not flagged for the ready rows", async () => {
    const { call, a, finish } = await setup(true, "writes posts\nPack role: Writer");
    const done = await finish("P-0048 scheduled");
    expect(done.summary).toBe("P-0048 scheduled");
    expect((await call("GET", `/api/assignments/${a.id}`)).json.retryAt).toBeFalsy();
  });
  it("enabled: books exactly one follow-up (assignment retryAt), not a second within the hour", async () => {
    const { call, a, finish } = await setup(true);
    const first = await finish("R3 done, next R4; left ready: R4, R5 (row cap)");
    expect(first.outcome).toBe("progressed");
    expect(first.summary).toMatch(/2 steps still ready \(R4, R5\); follow-up booked /);
    const as = (await call("GET", `/api/assignments/${a.id}`)).json;
    expect(as.retryRunId).toBe(first.id);
    expect(Date.parse(as.retryAt)).toBeLessThanOrEqual(Date.now());
    // the follow-up wake (next wake right after) books none: depth 1
    const second = await finish("R4 done, next R5");
    expect(second.summary).not.toMatch(/follow-up booked/);
    expect(second.summary).toMatch(/depth 1/);
    // and a third within the hour neither
    const third = await finish("R5 started");
    expect(third.summary).not.toMatch(/follow-up booked 2/);
  });

  it("disabled (Run now): books none, the milestone shows Stalled with its item", async () => {
    const { call, a, m, finish } = await setup(false);
    const r = await finish("R3 done");
    expect(r.summary).toMatch(/one-off wake: no follow-up booked/);
    expect((await call("GET", `/api/assignments/${a.id}`)).json.retryAt).toBeUndefined();
    const st = (await call("GET", `/api/milestones/${m.id}/status`)).json;
    expect(st.flow.word).toBe("stalled");
    expect(st.items.find((i: { kind: string }) => i.kind === "stalled")).toMatchObject({ state: "alarm", switchOn: [{ assignmentId: a.id, persona: "Diagnostician" }] });
    expect(st.needsYou).toBe(0);
  });
});

describe("T13-S3 prompt rule", () => {
  it("wake prompt and protocol tell the wake to name ready rows left and why", () => {
    expect(buildWakePrompt({ name: "D", remit: "r", skills: [] }, { title: "t", repo: "r", path: "p", owner: "" })).toContain(LEFT_READY_RULE);
    expect(LEFT_READY_RULE).toMatch(/worker ceiling \| no seat with headroom \| row cap/);
    const text = wakeProtocol({ base: "http://c", run: { id: "run_1" }, assignment: { id: "asg_1", mayWrite: true, writeScope: "spine" }, milestone: { id: "ms_1" }, persona: { id: "p_1", name: "steward" } } as never);
    expect(text).toContain(LEFT_READY_RULE);
  });
});
