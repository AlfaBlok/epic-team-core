import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { McpT3Client, type T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { clearRefusals, createTokenWatch, readTokenState, reportRefusal, tokenExpiry } from "../src/t3/tokenWatch.js";
import { tempCheckout } from "./tempCheckout.js";

/**
 * a run with no thread can be cleared, and an expired T3 MCP token is seen before and when it bites.
 * (a planner persona's wake on 2026-11-12: its start hit `T3 MCP HTTP 401 invalid_mcp_credential`, it sat
 * "running" with no thread for 2.5 h, Stop said no_thread and Run now already_running.)
 */
const AT = tempCheckout("home_repo", ["AGENTS.md", "docs/spines/root.md", "docs/spines/m2-team-console.md"]).dir;
const REFUSED = 'T3 MCP HTTP 401: {"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}';

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  refuse = false;
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
    if (this.refuse) throw new Error(REFUSED);
    return { threadId: `thread_${++this.n}` };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId, mode } });
    if (this.refuse) throw new Error(REFUSED);
  }
  async readThreadStatus() {
    return { status: "running", raw: {} };
  }
  async interruptThread(threadId: string) {
    this.calls.push({ op: "interruptThread", args: { threadId } });
  }
}

class FakeDispatcher implements Dispatcher {
  async pick() {
    return { seat: "seat2", providerInstanceId: "claudeAgent_seat2" };
  }
  async done() {}
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  clearRefusals();
  vi.unstubAllGlobals();
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s100-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const t3 = new FakeT3();
  const dispatcher = new FakeDispatcher();
  const cycleOpts = { enabled: true, t3, dispatcher, publicUrl: "http://127.0.0.1:18799", seatsFile: path.join(dir, "seats.json"), runState: async () => undefined, sendRetryMs: 60_000 };
  const app = createApp(db, { cycle: cycleOpts });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const seed = async () => {
    const m = (await call("POST", "/api/milestones", { title: "M2", repo: AT, path: "docs/spines/m2-team-console.md" })).json;
    const p = (await call("POST", "/api/personas", { name: "Strategist", remit: "plans", model: "haiku" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true })).json;
    return { m, p, a };
  };
  /** move a run's start back `min` minutes (a run that has sat that long). */
  const age = (runId: string, min: number) => db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(new Date(Date.now() - min * 60_000).toISOString(), runId);
  const run = async (id: string) => (await call("GET", `/api/runs/${id}`)).json;
  return { db, t3, dir, call, seed, age, run, cycleOpts };
}

/** the defect's start: Run now while T3 refuses the console's token, so the wake waits on its one send retry with no thread. */
async function refusedStart(t: ReturnType<typeof setup>, a: { id: string }) {
  t.t3.refuse = true;
  const w = await t.call("POST", `/api/assignments/${a.id}/run-now`, { instructions: "start the testers experiment" });
  expect(w.status).toBe(201);
  expect(w.json).toMatchObject({ outcome: "running" });
  expect(w.json.threadId ?? null).toBeNull();
  t.t3.refuse = false;
  return w.json;
}

describe("Stop on a run with no thread", () => {
  it("a wake whose send failed (waiting on its retry) stops at once: closed stopped with the reason, nothing interrupted", async () => {
    const t = setup();
    const { a } = await t.seed();
    const w = await refusedStart(t, a);
    expect(w.summary).toMatch(/^Run now: send failed/);
    expect(w.summary).toContain("ALERT: T3 on");
    expect(w.summary).toContain("mcp_login.py");

    const s = await t.call("POST", `/api/runs/${w.id}/stop`, { reason: "stuck since 23:05Z" });
    expect(s.status).toBe(200);
    expect(s.json.run).toMatchObject({ id: w.id, outcome: "stopped" });
    expect(s.json.run.summary).toContain("Stopped: stuck since 23:05Z (no thread: the run never started");
    expect(s.json.run.endedAt).toBeTruthy();
    expect(t.t3.ops("interruptThread")).toHaveLength(0);

    // Run now is free again: a new wake, not already_running
    const again = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(again.status).toBe(201);
    expect(again.json.id).not.toBe(w.id);
    expect(again.json.threadId).toBeTruthy();
  });

  it("a run with no thread past its start window stops; inside the window it still answers no_thread", async () => {
    const t = setup();
    const { a } = await t.seed();
    const r = (await t.call("POST", "/api/runs", { assignmentId: a.id, summary: "waiting" })).json;
    const early = await t.call("POST", `/api/runs/${r.id}/stop`, { reason: "x" });
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("no_thread");

    t.age(r.id, 3);
    const late = await t.call("POST", `/api/runs/${r.id}/stop`, { reason: "never started" });
    expect(late.status).toBe(200);
    expect(late.json.run).toMatchObject({ outcome: "stopped" });
    expect(late.json.run.summary).toContain("was: waiting");
    expect(t.t3.ops("interruptThread")).toHaveLength(0);
  });
});

describe("the console closes an orphan wake itself", () => {
  it("Run now meets a wake with no thread past 15 min: closes it failed and starts a fresh wake, never already_running", async () => {
    const t = setup();
    const { a } = await t.seed();
    const w = await refusedStart(t, a);
    t.age(w.id, 16);

    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`, { instructions: "same instructions" });
    expect(r.status).toBe(201);
    expect(r.json.id).not.toBe(w.id);
    expect(r.json.threadId).toBeTruthy();
    const old = await t.run(w.id);
    expect(old.outcome).toBe("failed");
    expect(old.summary).toMatch(/^No thread after 16 min: the wake never started \(Run now: send failed/);
    expect(old.summary).toContain("closed by the console");
  });

  it("inside 15 min the start guard still holds (already_running), so a slow start is never doubled", async () => {
    const t = setup();
    const { a } = await t.seed();
    const w = await refusedStart(t, a);
    t.age(w.id, 10);
    const r = await t.call("POST", `/api/assignments/${a.id}/run-now`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("already_running");
    expect((await t.run(w.id)).outcome).toBe("running");
  });

  it("the reconciler closes the orphan without anyone pressing Run now; a wake with a thread is left alone", async () => {
    const t = setup();
    const { a } = await t.seed();
    const w = await refusedStart(t, a);
    t.age(w.id, 20);
    const cycle = createCycle(t.db, createStore(t.db), t.cycleOpts);
    const res = await cycle.reconcile();
    expect(res.closed).toContain(w.id);
    expect(await t.run(w.id)).toMatchObject({ outcome: "failed", summary: expect.stringContaining("No thread after 20 min") });

    const live = (await t.call("POST", `/api/assignments/${a.id}/run-now`)).json;
    expect(live.threadId).toBeTruthy();
    t.age(live.id, 20);
    const res2 = await cycle.reconcile();
    expect(res2.closed).not.toContain(live.id);
    expect((await t.run(live.id)).outcome).toBe("running");
  });
});

// ---------- token expiry ----------

const DAY = 86_400_000;
/** a token shaped like T3's (base64url JSON payload with exp in ms, then a signature). */
const fakeToken = (expMs: number) => `${Buffer.from(JSON.stringify({ v: 1, kind: "mcp", exp: expMs, iat: expMs - 30 * DAY })).toString("base64url")}.sig`;

describe("T3 MCP token watch", () => {
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s100-tok-"));
    cleanup = () => fs.rmSync(d, { recursive: true, force: true });
    return d;
  };

  it("reads the expiry from the token (ms or s), else nothing", () => {
    const at = Date.parse("2026-11-21T06:25:58Z");
    expect(tokenExpiry(fakeToken(at))).toBe(at);
    expect(tokenExpiry(`${Buffer.from(JSON.stringify({ exp: at / 1000 })).toString("base64url")}.x`)).toBe(at);
    expect(tokenExpiry("opaque-token")).toBeUndefined();
  });

  it("ok far out, warn within 5 days, expired after; a file with no readable exp counts 30 days from its write", () => {
    const d = tmp();
    const now = Date.parse("2026-11-13T02:00:00Z");
    const f = path.join(d, ".t3token");
    fs.writeFileSync(f, fakeToken(now + 20 * DAY));
    expect(readTokenState({ host: "host1", file: f }, now)).toMatchObject({ state: "ok", from: "token", daysLeft: 20 });
    fs.writeFileSync(f, fakeToken(now + 4 * DAY));
    expect(readTokenState({ host: "host1", file: f }, now)).toMatchObject({ state: "warn", daysLeft: 4 });
    fs.writeFileSync(f, fakeToken(now - DAY));
    expect(readTokenState({ host: "host1", file: f }, now)).toMatchObject({ state: "expired" });
    fs.writeFileSync(f, "opaque");
    const old = (now - 27 * DAY) / 1000;
    fs.utimesSync(f, old, old);
    expect(readTokenState({ host: "host1", file: f }, now)).toMatchObject({ state: "warn", from: "file", daysLeft: 3 });
    expect(readTokenState({ host: "host2", file: path.join(d, "nope") }, now).state).toBe("missing");
  });

  it("warns once per episode, alerts at once on a 401 refusal, and a rotation ends it", () => {
    const d = tmp();
    const f = path.join(d, ".t3token-host2");
    fs.writeFileSync(f, fakeToken(Date.now() + 3 * DAY));
    const logs: string[] = [];
    const alerts: string[] = [];
    const w = createTokenWatch({ files: () => [{ host: "host2", file: f }], log: (m) => logs.push(m), alert: (k, text) => alerts.push(`${k}: ${text}`) });
    w.check();
    w.check();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("t3-token-host2: [WARN] T3 MCP token for host2 expires");
    expect(alerts[0]).toContain("mcp_login.py");
    expect(w.health()).toMatchObject({ state: "warn", warnDays: 5 });

    reportRefusal(f, REFUSED, Date.now() + 1000);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain("[ALERT] T3 MCP token for host2 refused by T3");
    expect(w.health().state).toBe("alert");
    reportRefusal(f, REFUSED, Date.now() + 2000); // the same episode: no second alert
    expect(alerts).toHaveLength(2);

    // rotated: a fresh token written after the refusal
    fs.writeFileSync(f, fakeToken(Date.now() + 30 * DAY));
    const later = (Date.now() + 5000) / 1000;
    fs.utimesSync(f, later, later);
    expect(w.health()).toMatchObject({ state: "ok" });
    expect(logs.every((l) => !l.includes(fakeToken(0).slice(0, 10)))).toBe(true);
    w.stop();
  });

  it("the T3 client reports a 401 invalid_mcp_credential to the watch (any call, not only wakes)", async () => {
    const d = tmp();
    const f = path.join(d, ".t3token");
    fs.writeFileSync(f, fakeToken(Date.now() + 20 * DAY));
    const alerts: string[] = [];
    const w = createTokenWatch({ files: () => [{ host: "host1", file: f }], log: () => undefined, alert: (_k, text) => alerts.push(text) });
    vi.stubGlobal("fetch", async () => new Response('{"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}', { status: 401 }));
    const c = new McpT3Client("http://127.0.0.1:9/mcp", f, [0, 0], [0]);
    await expect(c.listProjects()).rejects.toThrow(/T3 MCP HTTP 401/);
    expect(alerts.some((x) => x.includes("[ALERT] T3 MCP token for host1 refused by T3"))).toBe(true);
    w.stop();
  });
});
