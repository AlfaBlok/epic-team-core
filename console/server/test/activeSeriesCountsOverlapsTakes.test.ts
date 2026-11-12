import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { createStore } from "../src/store.js";
import { activeSeries, dayBounds, localDay, type ActiveRun } from "../src/activeAgents.js";

/**
 * the Runs page's Active agents chart. GET /api/runs/active gives one number per bucket (the most agents active
 * at any moment in it) for one day in the viewer's timezone, plus the peak; never the runs.
 */

const run = (id: string, startedAt: string, endedAt?: string, kind = "wake"): ActiveRun => ({ id, startedAt, endedAt, kind });
const at = (s: ActiveSeries["counts"], hhmm: string, start = "00:00") => {
  const [h, m] = hhmm.split(":").map(Number);
  const [h0, m0] = start.split(":").map(Number);
  return s[h * 60 + m - (h0 * 60 + m0)];
};
type ActiveSeries = ReturnType<typeof activeSeries>;
const END = new Date("2026-11-03T12:00:00Z"); // the day is over: no "now" cut

describe("activeSeries (T48-S20)", () => {
  it("counts overlaps, takes each minute's most, and finds the peak and its runs", () => {
    const s = activeSeries(
      [
        run("a", "2026-11-02T10:00:00Z", "2026-11-02T10:30:00Z"),
        run("b", "2026-11-02T10:10:00Z", "2026-11-02T10:20:00Z"),
        run("c", "2026-11-02T10:15:30Z", "2026-11-02T10:15:40Z"), // 10 s inside 10:15: that minute still shows 3
        run("d", "2026-11-02T10:30:00Z", "2026-11-02T10:40:00Z"), // starts as a ends: never 2 at 10:30
        run("t", "2026-11-02T10:00:00Z", "2026-11-02T11:00:00Z", "toggle"), // a toggle line is no agent
        run("z", "2026-11-02T10:05:00.010Z", "2026-11-02T10:05:00.004Z"), // ended before it started: never active
      ],
      { day: "2026-11-02", tz: "UTC", now: END },
    );
    expect(s.counts).toHaveLength(1440);
    expect(at(s.counts, "09:59")).toBe(0);
    expect(at(s.counts, "10:00")).toBe(1);
    expect(at(s.counts, "10:10")).toBe(2);
    expect(at(s.counts, "10:15")).toBe(3);
    expect(at(s.counts, "10:16")).toBe(2);
    expect(at(s.counts, "10:20")).toBe(1);
    expect(at(s.counts, "10:29")).toBe(1);
    expect(at(s.counts, "10:30")).toBe(1);
    expect(at(s.counts, "10:40")).toBe(0);
    expect(s.peak).toEqual({ count: 3, at: "2026-11-02T10:15:30.000Z", runIds: ["a", "b", "c"] });
    expect(s.runs).toBe(4);
    expect(Math.max(...s.counts)).toBe(s.peak.count);
  });

  it("counts a run still running up to now, and stops the series at now", () => {
    const now = new Date("2026-11-02T06:30:20Z");
    const s = activeSeries(
      [run("live", "2026-11-02T05:00:00Z"), run("live2", "2026-11-01T22:00:00Z"), run("done", "2026-11-02T06:00:00Z", "2026-11-02T06:10:00Z")],
      { day: "2026-11-02", tz: "UTC", now },
    );
    expect(s.counts).toHaveLength(6 * 60 + 31); // 00:00 … 06:30, the bucket now is in
    expect(at(s.counts, "00:00")).toBe(1); // started yesterday, still running
    expect(at(s.counts, "05:00")).toBe(2);
    expect(at(s.counts, "06:05")).toBe(3);
    expect(at(s.counts, "06:30")).toBe(2);
    expect(s.peak.count).toBe(3);
    // A past day: a run still running fills it to its end; a future day is empty.
    const y = activeSeries([run("live2", "2026-11-01T22:00:00Z")], { day: "2026-11-01", tz: "UTC", now });
    expect(y.counts).toHaveLength(1440);
    expect(at(y.counts, "21:59")).toBe(0);
    expect(at(y.counts, "23:59")).toBe(1);
    expect(activeSeries([run("live", "2026-11-02T05:00:00Z")], { day: "2026-11-03", tz: "UTC", now }).counts).toEqual([]);
  });

  it("clips runs to the day's boundaries: a run across midnight counts on both days, one ending at midnight only before", () => {
    const runs = [run("x", "2026-11-01T23:50:00Z", "2026-11-02T00:10:00Z"), run("y", "2026-11-01T23:00:00Z", "2026-11-02T00:00:00Z"), run("w", "2026-11-02T00:00:00Z", "2026-11-02T00:01:00Z")];
    const d1 = activeSeries(runs, { day: "2026-11-01", tz: "UTC", now: END });
    const d2 = activeSeries(runs, { day: "2026-11-02", tz: "UTC", now: END });
    expect(at(d1.counts, "23:55")).toBe(2);
    expect(d1.runs).toBe(2);
    expect(at(d2.counts, "00:00")).toBe(2); // x and w; y ended at the first instant
    expect(at(d2.counts, "00:05")).toBe(1);
    expect(d2.runs).toBe(2);
    expect(d2.peak).toEqual({ count: 2, at: "2026-11-02T00:00:00.000Z", runIds: ["x", "w"] });
  });

  it("uses the viewer's timezone for the day, also on clock-change days", () => {
    // Madrid, winter: 2026-11-02 runs 2026-11-01T23:00Z → 2026-11-02T23:00Z.
    expect(dayBounds("2026-11-02", "Europe/Madrid")).toEqual({ start: Date.parse("2026-11-01T23:00:00Z"), end: Date.parse("2026-11-02T23:00:00Z") });
    const r = [run("late", "2026-11-01T23:30:00Z", "2026-11-01T23:45:00Z")]; // 00:30 in Madrid on the 2nd, 23:30 UTC on the 1st
    const madrid = activeSeries(r, { day: "2026-11-02", tz: "Europe/Madrid", now: END });
    expect(madrid.start).toBe("2026-11-01T23:00:00.000Z");
    expect(at(madrid.counts, "00:30")).toBe(1);
    expect(activeSeries(r, { day: "2026-11-02", tz: "UTC", now: END }).runs).toBe(0);
    expect(activeSeries(r, { day: "2026-11-01", tz: "UTC", now: END }).runs).toBe(1);
    // Spring forward (23 h) and fall back (25 h); a zone ahead of UTC by a half hour.
    expect(activeSeries([], { day: "2026-03-29", tz: "Europe/Madrid", now: END }).counts).toHaveLength(23 * 60);
    const back = activeSeries([run("n", "2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z")], { day: "2026-10-25", tz: "Europe/Madrid", now: END });
    expect(back.counts).toHaveLength(25 * 60);
    expect(back.start).toBe("2026-10-24T22:00:00.000Z");
    expect(back.counts.slice(150, 210).every((c) => c === 1)).toBe(true); // 00:30Z..01:30Z = minutes 150..209 of the day
    expect(dayBounds("2026-11-02", "Asia/Kolkata").start).toBe(Date.parse("2026-11-01T18:30:00Z"));
    expect(localDay(new Date("2026-11-01T23:30:00Z"), "Europe/Madrid")).toBe("2026-11-02");
    expect(localDay(new Date("2026-11-01T23:30:00Z"), "UTC")).toBe("2026-11-01");
  });

  it("buckets of 5 minutes hold the most of their minutes", () => {
    const s = activeSeries([run("a", "2026-11-02T10:01:00Z", "2026-11-02T10:02:00Z"), run("b", "2026-11-02T10:01:30Z", "2026-11-02T10:03:00Z")], { day: "2026-11-02", tz: "UTC", now: END, bucketMinutes: 5 });
    expect(s.counts).toHaveLength(288);
    expect(s.counts[120]).toBe(2);
    expect(s.counts[121]).toBe(0);
  });
});

let dir: string;
let db: DB;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s20-"))));
afterEach(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/runs/active (T48-S20)", () => {
  it("sends the day's series from the stored runs, never the runs, and refuses bad input", async () => {
    db = openDb(path.join(dir, "console.db"));
    const read: ReadConfig = { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
    const call = async (url: string) => {
      const res = await app.request(url);
      return { status: res.status, text: await res.text() };
    };
    const store = createStore(db);
    const m = store.createMilestone({ title: "One", repo: "one", path: "docs/spines/root.md", owner: "", paused: false });
    const p = store.createPersona({ name: "Worker", remit: "work", skills: [], model: "claude-opus-5-5", mayWrite: true });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
    const wake = store.createRun({ assignmentId: a.id, startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T11:00:00Z", outcome: "progressed", summary: "secret-summary" });
    store.createRun({ assignmentId: a.id, startedAt: "2026-10-21T10:30:00.000Z", endedAt: "2026-10-21T10:45:00.000Z", outcome: "progressed", summary: "child", parentRunId: wake.id });
    store.createRun({ assignmentId: a.id, startedAt: "2026-10-20T09:00:00.000Z", endedAt: "2026-10-20T09:10:00.000Z", outcome: "idle", summary: "yesterday" });
    // Stored without milliseconds, ending exactly at the day's start: not active on the day.
    store.createRun({ assignmentId: a.id, startedAt: "2026-10-20T23:00:00Z", endedAt: "2026-10-21T00:00:00Z", outcome: "idle", summary: "edge" });

    const r = await call("/api/runs/active?day=2026-10-21&tz=UTC");
    expect(r.status).toBe(200);
    const s = JSON.parse(r.text);
    expect(s.counts).toHaveLength(1440);
    expect(s.counts[10 * 60 + 30]).toBe(2);
    expect(s.peak.count).toBe(2);
    expect(s.peak.at).toBe("2026-10-21T10:30:00.000Z");
    expect(s.runs).toBe(2);
    expect(r.text).not.toContain("secret-summary");
    expect(r.text.length).toBeLessThan(8000);
    expect(JSON.parse((await call("/api/runs/active?day=2026-10-20&tz=UTC")).text).runs).toBe(2);
    expect(JSON.parse((await call("/api/runs/active?day=2026-10-21&tz=Europe/Madrid&bucket=5")).text).counts).toHaveLength(288);
    for (const bad of ["day=2026-13-40", "day=yesterday", "tz=Mars/Base", "bucket=7"]) expect((await call(`/api/runs/active?${bad}`)).status).toBe(400);
    // /api/runs/:id is not shadowed, and the default day is today.
    expect((await call(`/api/runs/${wake.id}`)).status).toBe(200);
    expect(JSON.parse((await call("/api/runs/active")).text).day).toBe(new Date().toISOString().slice(0, 10));
  });
});
