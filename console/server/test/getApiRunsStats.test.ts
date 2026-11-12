import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { createStore } from "../src/store.js";
import { runStats } from "../src/runStats.js";

/**
 * GET /api/runs/stats gives the Team home its wake numbers (per milestone: wakes in 24 h and the latest; per
 * persona: wakes and the latest) from the same newest 500 runs GET /api/runs sends, without sending them.
 */

let dir: string;
let db: DB;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s18-"))));
afterEach(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  db = openDb(path.join(dir, "console.db"));
  const read: ReadConfig = { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return call;
}

describe("GET /api/runs/stats (T48-S18 Team home)", () => {
  it("counts the newest 500 runs GET /api/runs sends, with the assignments GET /api/assignments sends", async () => {
    const call = await setup();
    const store = createStore(db);
    const ms = await Promise.all(["One", "Two", "Three"].map(async (t) => (await call("POST", "/api/milestones", { title: t, repo: `Acme/${t}`, path: "docs/spines/root.md" })).json));
    const ps = await Promise.all(["dm", "worker", "idle"].map(async (n) => (await call("POST", "/api/personas", { name: n, remit: "r", model: "opus" })).json));
    const as = [
      (await call("POST", "/api/assignments", { milestoneId: ms[0].id, personaId: ps[0].id, cadence: { type: "interval", everyMinutes: 60 } })).json,
      (await call("POST", "/api/assignments", { milestoneId: ms[1].id, personaId: ps[0].id, cadence: { type: "interval", everyMinutes: 60 } })).json,
      (await call("POST", "/api/assignments", { milestoneId: ms[1].id, personaId: ps[1].id, cadence: { type: "interval", everyMinutes: 60 } })).json,
      (await call("POST", "/api/assignments", { milestoneId: ms[2].id, personaId: ps[1].id, cadence: { type: "interval", everyMinutes: 60 } })).json,
    ];
    // 600 runs (100 beyond the 500 cut) over 3 days: wakes, child runs, answer runs and toggle lines, a run whose
    // assignment is deleted afterwards (milestone stamp only), ties on startedAt.
    const now = Date.now();
    const kinds = ["wake", "wake", "wake", "answer_run", "toggle"] as const;
    const outcomes = ["progressed", "idle", "blocked", "running", "failed"] as const;
    let parent: string | undefined;
    for (let i = 0; i < 600; i++) {
      const a = as[i % as.length];
      const startedAt = new Date(now - Math.floor(i / 2) * 7 * 60_000).toISOString(); // pairs share a start
      const child = i % 7 === 3 && parent;
      const r = store.createRun({ assignmentId: a.id, startedAt, outcome: outcomes[i % 5], summary: `r${i}`, kind: child ? "wake" : kinds[i % 5], ...(child ? { parentRunId: parent } : {}) });
      if (!child && kinds[i % 5] === "wake") parent = r.id;
    }
    const doomed = (await call("POST", "/api/assignments", { milestoneId: ms[2].id, personaId: ps[2].id, cadence: { type: "interval", everyMinutes: 60 } })).json;
    store.createRun({ assignmentId: doomed.id, startedAt: new Date(now - 60_000).toISOString(), outcome: "progressed", summary: "orphan", kind: "wake" });
    await call("DELETE", `/api/assignments/${doomed.id}`);

    const runs = (await call("GET", "/api/runs")).json;
    const assignments = (await call("GET", "/api/assignments")).json;
    expect(runs).toHaveLength(500);
    const stats = (await call("GET", "/api/runs/stats")).json;
    // The route counts exactly the runs and assignments the Team home used to fetch (web/src/components/runsPageLinePer.test.tsx
    // proves runStats gives derive.ts's numbers on such lists).
    const want = runStats<{ id: string; assignmentId: string; kind: string; startedAt: string }>(runs, assignments);
    for (const m of ms) {
      const got = stats.milestones[m.id];
      expect(got.last24h).toBe(want.milestones[m.id].last24h);
      expect(got.last24h).toBeGreaterThan(0);
      expect(got.last.id).toBe(want.milestones[m.id].last!.id);
      expect(got.last.summary).toMatch(/^(r\d+|orphan)$/); // a full run (the card shows its outcome and summary)
    }
    expect(stats.milestones[ms[2].id].last.summary).toBe("orphan"); // a deleted assignment's run still counts by its stamp
    for (const p of ps.slice(0, 2)) {
      expect(stats.personas[p.id].count).toBe(want.personas[p.id].count);
      expect(stats.personas[p.id].last.id).toBe(want.personas[p.id].last!.id);
    }
    // Only the newest 500 count: fewer wakes than the 600 created (3 of 5 kinds are wakes, children excluded).
    expect(stats.personas[ps[0].id].count + stats.personas[ps[1].id].count).toBeLessThan(360);
    expect(stats.personas[ps[0].id].count).toBeGreaterThan(0);
    expect(stats.personas[ps[2].id]).toBeUndefined(); // only a deleted assignment's run: 0, as personaRunStats
    // Small: the numbers and one run per milestone and persona, not the 500 runs.
    expect(JSON.stringify(stats).length).toBeLessThan(JSON.stringify(runs).length / 20);
  });

  it("wakes24h counts every ended wake of the last 24 h, beyond the 500 cut (T13-S11's footer)", async () => {
    const call = await setup();
    const store = createStore(db);
    const m = (await call("POST", "/api/milestones", { title: "One", repo: "Acme/one", path: "docs/spines/root.md" })).json;
    const p = (await call("POST", "/api/personas", { name: "dm", remit: "r", model: "opus" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
    const now = Date.now();
    for (let i = 0; i < 600; i++) store.createRun({ assignmentId: a.id, startedAt: new Date(now - (i + 1) * 60_000).toISOString(), outcome: i % 3 ? "progressed" : "idle", summary: `w${i}`, kind: "wake" });
    store.createRun({ assignmentId: a.id, startedAt: new Date(now - 30_000).toISOString(), outcome: "running", summary: "live", kind: "wake" });
    store.createRun({ assignmentId: a.id, startedAt: new Date(now - 26 * 3600_000).toISOString(), outcome: "progressed", summary: "old", kind: "wake" });
    expect((await call("GET", "/api/runs/stats")).json.wakes24h).toEqual({ did: 400, total: 600 });
  });

  it("T77-S4: ?milestones= counts the footer over those milestones' runs only (the selected project's)", async () => {
    const call = await setup();
    const store = createStore(db);
    const [m1, m2] = await Promise.all(["Memo", "Team"].map(async (t) => (await call("POST", "/api/milestones", { title: t, repo: `Acme/${t}`, path: "docs/spines/root.md" })).json));
    const p = (await call("POST", "/api/personas", { name: "dm", remit: "r", model: "opus" })).json;
    const [a1, a2] = await Promise.all([m1, m2].map(async (m) => (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json));
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    for (let i = 0; i < 3; i++) store.createRun({ assignmentId: a1.id, startedAt: at(i + 1), outcome: "progressed", summary: `z${i}`, kind: "wake" });
    store.createRun({ assignmentId: a2.id, startedAt: at(5), outcome: "idle", summary: "t", kind: "wake" });
    store.createRun({ assignmentId: a2.id, startedAt: at(6), outcome: "progressed", summary: "b", kind: "wake" });
    expect((await call("GET", "/api/runs/stats")).json.wakes24h).toEqual({ did: 4, total: 5 });
    expect((await call("GET", `/api/runs/stats?milestones=${m1.id}`)).json.wakes24h).toEqual({ did: 3, total: 3 });
    expect((await call("GET", `/api/runs/stats?milestones=${m2.id}`)).json.wakes24h).toEqual({ did: 1, total: 2 });
    expect((await call("GET", `/api/runs/stats?milestones=${m1.id},${m2.id}`)).json.wakes24h).toEqual({ did: 4, total: 5 });
    // The cards' and personas' numbers stay every milestone's.
    expect((await call("GET", `/api/runs/stats?milestones=${m1.id}`)).json.milestones[m2.id].last24h).toBe(2);
  });

  it("is an empty answer with no runs, and does not shadow GET /api/runs/:id", async () => {
    const call = await setup();
    expect((await call("GET", "/api/runs/stats")).json).toEqual({ milestones: {}, personas: {}, wakes24h: { did: 0, total: 0 } });
    expect((await call("GET", "/api/runs/run_nope")).status).toBe(404);
  });
});
