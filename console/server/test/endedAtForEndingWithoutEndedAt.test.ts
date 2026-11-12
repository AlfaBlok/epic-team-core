import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore, endedAtFor } from "../src/store.js";

/** a run's endedAt follows its outcome (every ending stamps it once; running never has one). */
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s37-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const app = createApp(db);
  cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "/nonexistent/repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "worker", remit: "r", skills: [], model: "sonnet", mayWrite: false });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: false });
  const patch = async (id: string, body: unknown) => {
    const res = await app.request(`/api/runs/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { db, store, a, patch };
}

describe("T6-S37 endedAtFor", () => {
  const at = () => "2026-10-31T00:00:00.000Z";
  it("an ending without endedAt is stamped; one already ended keeps its time", () => {
    expect(endedAtFor("progressed", undefined, undefined, at)).toBe(at());
    expect(endedAtFor("monitoring", undefined, null, at)).toBe(at());
    expect(endedAtFor("progressed", "2026-10-28T01:59:15.000Z", undefined, at)).toBeUndefined(); // left as is
    expect(endedAtFor("progressed", "2026-10-28T01:59:15.000Z", null, at)).toBe("2026-10-28T01:59:15.000Z"); // never un-ended
    expect(endedAtFor("failed", undefined, "2026-10-28T02:00:00.000Z", at)).toBe("2026-10-28T02:00:00.000Z"); // the reported time wins
  });
  it("running never carries an endedAt", () => {
    expect(endedAtFor("running", "2026-10-28T01:59:15.000Z", undefined, at)).toBeNull();
    expect(endedAtFor("running", undefined, "2026-10-28T01:59:15.000Z", at)).toBeNull();
    expect(endedAtFor("running", undefined, undefined, at)).toBeUndefined();
  });
});

describe("T6-S37 store + PATCH /api/runs/:id", () => {
  it("run_b15b6a47 replay: monitoring then progressed, never sending endedAt, ends once", async () => {
    const t = setup();
    const r = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "woke" });
    expect(r.endedAt).toBeUndefined();
    const first = await t.patch(r.id, { outcome: "monitoring", nextCheckAt: "2099-01-01T00:00:00Z", summary: "waits" });
    expect(first.status).toBe(200);
    expect(first.json.endedAt).toBeTruthy();
    const second = await t.patch(r.id, { outcome: "progressed", summary: "dispatched T21-S17" });
    expect(second.json.outcome).toBe("progressed");
    expect(second.json.endedAt).toBe(first.json.endedAt); // stamped once
  });

  it("a child run PATCHed progressed without endedAt gets one", async () => {
    const t = setup();
    const parent = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "wake" });
    const child = t.store.createRun({ assignmentId: t.a.id, parentRunId: parent.id, outcome: "running", summary: "T1-S1" });
    const res = await t.patch(child.id, { outcome: "progressed", summary: "done" });
    expect(res.json.endedAt).toBeTruthy();
  });

  it("false blank_report → running clears endedAt; the real ending stamps a new one", async () => {
    const t = setup();
    const parent = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "wake" });
    const child = t.store.createRun({ assignmentId: t.a.id, parentRunId: parent.id, outcome: "running", summary: "go-live" });
    t.store.updateRun(child.id, { outcome: "blank_report", endedAt: "2026-10-28T01:50:00.000Z" }); // the reconciler's close
    const back = await t.patch(child.id, { outcome: "running" });
    expect(back.json.outcome).toBe("running");
    expect(back.json.endedAt).toBeUndefined();
    const done = await t.patch(child.id, { outcome: "progressed", summary: "go-live part 2 done" });
    expect(done.json.endedAt).toBeTruthy();
    expect(done.json.endedAt).not.toBe("2026-10-28T01:50:00.000Z");
  });

  it("a run created with an ending word is ended at its start; a running one is not", () => {
    const t = setup();
    const ended = t.store.createRun({ assignmentId: t.a.id, outcome: "idle", startedAt: "2026-10-28T01:56:38.043Z", summary: "skipped" });
    expect(ended.endedAt).toBe("2026-10-28T01:56:38.043Z");
    const live = t.store.createRun({ assignmentId: t.a.id, outcome: "running", endedAt: "2026-10-28T01:56:38.043Z", summary: "x" });
    expect(live.endedAt).toBeUndefined();
  });

  it("a PATCH that only renames a finished run keeps its endedAt", async () => {
    const t = setup();
    const r = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "woke" });
    const end = (await t.patch(r.id, { outcome: "failed", summary: "x" })).json.endedAt;
    expect((await t.patch(r.id, { summary: "x (more)" })).json.endedAt).toBe(end);
  });
});
