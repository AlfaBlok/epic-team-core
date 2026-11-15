import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore, type Run } from "../src/store.js";
import { createPriorityMode, epicOfRow, ticketOf } from "../src/cycle/priorityMode.js";
import { createApp } from "../src/app.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { tempCheckout } from "./tempCheckout.js";

/** Priority mode: park every other running session, run only the named rows, resume the rest in rank order. */

let cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
});

function tmpDb(): DB {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s95-"));
  const db = openDb(path.join(dir, "console.db"));
  cleanup.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** a store with one Delivery Manager assignment, its wake and fake worker runs (one per row). */
function world(rows: string[]) {
  const db = tmpDb();
  const store = createStore(db);
  const m = store.createMilestone({ title: "root", repo: "acme/home_repo", path: "docs/spines/root.md", owner: "Owner", paused: false });
  const p = store.createPersona({ name: "Delivery manager", remit: "dispatch", skills: [], model: "opus", mayWrite: true });
  const other = store.createPersona({ name: "Writer", remit: "write", skills: [], model: "opus", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const b = store.createAssignment({ milestoneId: m.id, personaId: other.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const wake = store.createRun({ assignmentId: a.id, outcome: "running", summary: "Woke on cadence", threadId: "t_wake", seat: "seat3" });
  const otherWake = store.createRun({ assignmentId: b.id, outcome: "running", summary: "Woke on cadence", threadId: "t_writer", seat: "seat1" });
  const workers: Record<string, Run> = {};
  rows.forEach((row, i) => {
    workers[row] = store.createRun({ assignmentId: a.id, parentRunId: wake.id, outcome: "running", summary: `${row} work on ${row}`, threadId: `t_${row}`, seat: `seat${i + 4}` });
  });
  return { db, store, a, b, wake, otherWake, workers };
}

function fakeDeps(over: { failOn?: (threadId: string) => boolean; ranks?: Record<string, number | null>; t?: { now: number } } = {}) {
  const sent: { runId: string; threadId: string; text: string }[] = [];
  const woken: { assignmentId: string; note: string }[] = [];
  const logs: string[] = [];
  return {
    sent,
    woken,
    logs,
    deps: {
      base: "http://console.test",
      send: async (run: Run, text: string) => {
        if (over.failOn?.(run.threadId ?? "")) throw new Error("t3_thread_send: thread closed");
        sent.push({ runId: run.id, threadId: run.threadId ?? "", text });
      },
      rankOf: (row: string) => over.ranks?.[epicOfRow(row) ?? ""] ?? null,
      wake: async (assignmentId: string, note: string) => {
        woken.push({ assignmentId, note });
      },
      isManager: () => true,
      now: over.t ? () => over.t!.now : undefined,
      log: (l: string) => logs.push(l),
    },
  };
}

describe("ticketOf / epicOfRow", () => {
  it("reads the row from a child run summary and its epic", () => {
    expect(ticketOf("E906-S95 E906-S95 priority mode")).toBe("E906-S95");
    expect(ticketOf("TAX-A10 the key box")).toBe("TAX-A10");
    expect(ticketOf("Woke on cadence")).toBeUndefined();
    expect(epicOfRow("E948-S60")).toBe("EPIC-948");
    expect(epicOfRow("TAX-A10")).toBeUndefined();
  });
});

describe("priority mode (fake runs)", () => {
  it("parks every other running session with a save-state steer and leaves the named row running", async () => {
    const w = world(["E906-S95", "E948-S60", "E940-S21"]);
    const f = fakeDeps();
    const pm = createPriorityMode(w.db, w.store, f.deps);
    const v = await pm.start({ rows: ["e906-s95"], by: "Owner", reason: "ship it tonight" });
    expect(v.on).toBe(true);
    expect(v.session!.rows).toEqual(["E906-S95"]);
    // two workers and two wakes asked; the named row's worker never
    expect(f.sent.map((s) => s.threadId).sort()).toEqual(["t_E940-S21", "t_E948-S60", "t_wake", "t_writer"]);
    const worker = f.sent.find((s) => s.threadId === "t_E948-S60")!;
    expect(worker.text).toContain("Commit and push your work in progress");
    expect(worker.text).toContain("E948-S60's Last attempted");
    expect(worker.text).toContain(`/api/runs/${w.workers["E948-S60"].id}`);
    expect(worker.text).toContain('"outcome":"monitoring"');
    // the Delivery Manager's own wake is told to dispatch only the named row
    expect(f.sent.find((s) => s.threadId === "t_wake")!.text).toContain("Dispatch only E906-S95");
    expect(v.parked.map((p) => p.state)).toEqual(["asked", "asked", "asked", "asked"]);
    expect(v.log.filter((l) => l.event === "park")).toHaveLength(4);
    expect(f.logs.some((l) => l.includes("park") && l.includes("E948-S60"))).toBe(true);
    // the named row is running, so no wake to dispatch it
    expect(f.woken).toHaveLength(0);
    expect(v.focusRunning).toEqual([w.workers["E906-S95"].id]);
  });

  it("refuses other rows' workers, holds other wakes and tells the Delivery Manager in its wake prompt", async () => {
    const w = world(["E906-S95"]);
    const pm = createPriorityMode(w.db, w.store, fakeDeps().deps);
    expect(pm.refusesChild({ parentRunId: w.wake.id, summary: "E901-S1 x" })).toBeUndefined();
    await pm.start({ rows: ["E906-S95", "E948-S60"], by: "Owner" });
    expect(pm.refusesChild({ parentRunId: w.wake.id, summary: "E901-S1 something" })).toMatch(/priority mode is on for E906-S95 and E948-S60/);
    expect(pm.refusesChild({ parentRunId: w.wake.id, summary: "E948-S60 go" })).toBeUndefined();
    expect(pm.refusesChild({ parentRunId: null, summary: "Woke on cadence" })).toBeUndefined(); // a wake is not a worker
    // the home Delivery Manager (whose runs worked E906-S95) keeps waking; the Writer waits
    expect(pm.holdsWake(w.a.id)).toBeUndefined();
    expect(pm.holdsWake(w.b.id)).toMatch(/priority mode on/);
    expect(pm.promptLines()).toContain("PRIORITY MODE IS ON");
    expect(pm.promptLines()).toContain("Dispatch only E906-S95 and E948-S60");
    expect(pm.view().log.some((l) => l.event === "refused" && l.ticket === "E901-S1")).toBe(true);
    // a named row with no worker yet: its Delivery Manager was woken to dispatch it
    expect(pm.view().log.some((l) => l.event === "wake" && l.detail.includes("E948-S60"))).toBe(true);
  });

  it("validates rows and refuses a second start or a resume when off", async () => {
    const w = world([]);
    const pm = createPriorityMode(w.db, w.store, fakeDeps().deps);
    await expect(pm.start({ rows: [], by: "o" })).rejects.toMatchObject({ code: "rows_count" });
    await expect(pm.start({ rows: ["A", "B", "C"], by: "o" })).rejects.toMatchObject({ code: "rows_count" });
    await expect(pm.start({ rows: ["not a row"], by: "o" })).rejects.toMatchObject({ code: "bad_row" });
    await expect(pm.resume({ by: "o", why: "x" })).rejects.toMatchObject({ code: "not_on" });
    await pm.start({ rows: ["E906-S95"], by: "o" });
    await expect(pm.start({ rows: ["E906-S96"], by: "o" })).rejects.toMatchObject({ code: "already_on" });
  });

  it("resumes each parked worker in its own thread, best pursuit rank first, when the named row finishes", async () => {
    const w = world(["E906-S95", "E948-S60", "E940-S21", "E999-S1"]);
    // E40 rank 1, E48 rank 3, E99 no rank (last)
    const f = fakeDeps({ ranks: { "EPIC-940": 1, "EPIC-948": 3, "EPIC-906": 2 } });
    const pm = createPriorityMode(w.db, w.store, f.deps);
    await pm.start({ rows: ["E906-S95"], by: "Owner" });
    const at = new Date().toISOString();
    // the parked workers saved their state and ended monitoring; one finished outright
    for (const row of ["E948-S60", "E940-S21"]) w.store.updateRun(w.workers[row].id, { outcome: "monitoring", nextCheckAt: at, endedAt: at, summary: `${row} parked by priority mode: half way` });
    w.store.updateRun(w.workers["E999-S1"].id, { outcome: "progressed", endedAt: at, summary: "E999-S1 done" });
    expect(await pm.tick()).toBeUndefined(); // the named row still runs: nothing resumes
    f.sent.length = 0;
    w.store.updateRun(w.workers["E906-S95"].id, { outcome: "progressed", endedAt: new Date(Date.now() + 1000).toISOString(), summary: "E906-S95 done" });
    const v = (await pm.tick())!;
    expect(v.on).toBe(false);
    expect(v.session!.endWhy).toBe("E906-S95 finished");
    // rank order: E40 (1) before E48 (3); E99 finished, skipped
    expect(f.sent.map((s) => s.threadId)).toEqual(["t_E940-S21", "t_E948-S60"]);
    for (const s of f.sent) expect(s.text.startsWith("resume from your row's Last attempted")).toBe(true);
    const parks = Object.fromEntries(v.parked.map((p) => [p.ticket ?? p.kind + p.runId, p]));
    expect(parks["E940-S21"]).toMatchObject({ state: "resumed", rank: 1 });
    expect(parks["E948-S60"]).toMatchObject({ state: "resumed", rank: 3 });
    expect(parks["E999-S1"]).toMatchObject({ state: "skipped" });
    // each resumed worker has a new running child run on its old thread, which the message names
    const fresh = w.store.getRun(parks["E940-S21"].resumeRunId!)!;
    expect(fresh).toMatchObject({ outcome: "running", parentRunId: w.wake.id, threadId: "t_E940-S21" });
    expect(f.sent[0].text).toContain(fresh.id);
    expect(w.store.getRun(w.workers["E940-S21"].id)!.summary).toContain(`resumed as ${fresh.id}`);
    expect(v.log.map((l) => l.event)).toEqual(expect.arrayContaining(["on", "park", "off", "resume", "resume_skipped"]));
    // off again: nothing held, no prompt line
    expect(pm.holdsWake(w.b.id)).toBeUndefined();
    expect(pm.promptLines()).toBe("");
  });

  it("hands a worker whose thread cannot be reached to its Delivery Manager; Resume by hand and the time limit work", async () => {
    const w = world(["E906-S95", "E948-S60"]);
    const t = { now: Date.now() };
    const f = fakeDeps({ failOn: (id) => id === "t_E948-S60", t });
    const pm = createPriorityMode(w.db, w.store, f.deps);
    const v0 = await pm.start({ rows: ["E906-S95"], by: "Owner" });
    expect(v0.parked.find((p) => p.ticket === "E948-S60")!.state).toBe("ask_failed");
    w.store.updateRun(w.workers["E948-S60"].id, { outcome: "stopped", endedAt: new Date(t.now).toISOString(), summary: "Stopped: by hand" });
    const v = await pm.resume({ by: "Owner", why: "Resume pressed" });
    expect(v.session!.endedBy).toBe("Owner");
    const p = v.parked.find((x) => x.ticket === "E948-S60")!;
    expect(p.state).toBe("handed_to_manager");
    expect(f.woken.at(-1)!.note).toContain(`resume from your row's Last attempted`);
    expect(f.woken.at(-1)!.note).toContain("E948-S60");

    // the time limit: a mode nobody ends resumes by itself
    await pm.start({ rows: ["E907-S1"], by: "Owner" });
    t.now += 7 * 3_600_000;
    const v2 = (await pm.tick())!;
    expect(v2.on).toBe(false);
    expect(v2.session!.endWhy).toMatch(/resumed by itself/);
  });
});

// ---------- through the console API with a fake T3 ----------

const AT = tempCheckout("home_repo", ["AGENTS.md", "docs/spines/root.md", "docs/spines/m2-team-console.md"]).dir;

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  private n = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  async listProjects() {
    return [{ id: "mcp:agent-team", title: "home_repo", workspaceRoot: AT, repositoryIdentity: { displayName: "acme/home_repo" } }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: any) {
    this.calls.push({ op: "launchThread", args: input });
    return { threadId: `thread_${++this.n}` };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId, mode } });
  }
  async readThreadStatus() {
    return { status: "running", raw: {} };
  }
  async interruptThread() {}
}
class FakeDispatcher implements Dispatcher {
  async pick() {
    return { seat: "seat2", providerInstanceId: "claudeAgent_seat2" };
  }
  async done() {}
}

describe("priority mode API", () => {
  it("POST parks through T3 steers, refuses other rows' workers, GET shows it, Resume wakes the parked worker", async () => {
    const db = tmpDb();
    const t3 = new FakeT3();
    const app = createApp(db, {
      cycle: { enabled: true, t3, dispatcher: new FakeDispatcher(), publicUrl: "http://127.0.0.1:18799", seatsFile: path.join(os.tmpdir(), `seats-${Date.now()}.json`), runState: async () => undefined },
      passive: true,
    } as any);
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    const m = (await call("POST", "/api/milestones", { title: "M2", repo: AT, path: "docs/spines/m2-team-console.md" })).json;
    const p = (await call("POST", "/api/personas", { name: "Delivery manager", remit: "dispatch", model: "haiku" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true })).json;
    const wake = (await call("POST", "/api/runs", { assignmentId: a.id, threadId: "home_thread", seat: "seat3", outcome: "running", summary: "Woke on cadence" })).json;
    const focus = (await call("POST", "/api/runs", { assignmentId: a.id, parentRunId: wake.id, threadId: "child_focus", seat: "seat4", summary: "E906-S95 priority mode" })).json;
    const other = (await call("POST", "/api/runs", { assignmentId: a.id, parentRunId: wake.id, threadId: "child_other", seat: "seat5", summary: "E948-S60 inbox" })).json;

    expect((await call("GET", "/api/priority-mode")).json.on).toBe(false);
    expect((await call("POST", "/api/priority-mode", { rows: [] })).status).toBe(400);
    const on = await call("POST", "/api/priority-mode", { rows: ["E906-S95"], reason: "one ticket tonight" });
    expect(on.status).toBe(201);
    expect(on.json.on).toBe(true);
    const steers = t3.ops("sendToThread");
    expect(steers.map((s) => s.args.threadId).sort()).toEqual(["child_other", "home_thread"]);
    expect(steers.every((s) => s.args.mode === "steer")).toBe(true);
    expect(steers.find((s) => s.args.threadId === "child_other")!.args.message).toContain("PRIORITY MODE");

    const refused = await call("POST", "/api/runs", { assignmentId: a.id, parentRunId: wake.id, seat: "seat6", summary: "E901-S1 something else" });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("priority_mode");
    expect((await call("POST", "/api/runs", { assignmentId: a.id, parentRunId: wake.id, seat: "seat6", summary: "E906-S95 second hand" })).status).toBe(201);
    expect((await call("POST", "/api/priority-mode", { rows: ["E907-S1"] })).status).toBe(409);

    // the parked worker saved its state
    await call("PATCH", `/api/runs/${other.id}`, { outcome: "monitoring", nextCheckAt: new Date(Date.now() + 3_600_000).toISOString(), summary: "E948-S60 parked by priority mode: half way", endedAt: new Date().toISOString() });
    const off = await call("POST", "/api/priority-mode/resume", {});
    expect(off.status).toBe(200);
    expect(off.json.on).toBe(false);
    const resumed = t3.ops("sendToThread").filter((s) => s.args.threadId === "child_other").at(-1)!;
    expect(resumed.args.message.startsWith("resume from your row's Last attempted")).toBe(true);
    expect(off.json.parked.find((x: any) => x.runId === other.id).state).toBe("resumed");
    expect(off.json.log.map((l: any) => l.event)).toEqual(expect.arrayContaining(["on", "park", "refused", "off", "resume"]));
    expect(focus.outcome).toBe("running");
  });
});
