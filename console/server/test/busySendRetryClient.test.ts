import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpT3Client, T3BusyError, T3Error, isThreadBusy, sendFailureText, type T3Client } from "../src/t3/client.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { BUSY_PREFIX, createCycle } from "../src/cycle/service.js";

// a wake T3 refuses because the thread is compacting is retried (then re-woken soon), not failed at once.
const COMPACTING = "Failed to dispatch orchestration command message.dispatch [cause]: Error: Wait for context compaction to finish before steering the thread.";
const WRAPPER = "Failed to dispatch orchestration command message.dispatch";
// The REAL error the console got in the incident (run_28710940, console journal 05:03:08 CEST), copied verbatim from the run
// record; the compaction text is NOT in it (only in the worker server's T3 trace). `t3_thread_send: ` is what McpT3Client prefixes.
const REAL_TEXT =
  '{"_tag":"OrchestratorMcpFailure","code":"orchestration_error","message":"Unable to send to thread mcp:ad45c28d-…: Failed to dispatch orchestration command message.dispatch (command:mcp:client%3A…:thread-send:console-send-b4204d5b-…)."}';
const REAL = `t3_thread_send: ${REAL_TEXT}`;
const UNKNOWN_THREAD =
  '{"_tag":"OrchestratorMcpFailure","code":"not_found","message":"Thread mcp:ad45c28d-… not found."}';
const URL_ = "http://127.0.0.1:1/mcp";

let tokenFile: string;
let bodies: any[];
beforeEach(() => {
  tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e6s17-")), "token");
  fs.writeFileSync(tokenFile, "tok\n");
  bodies = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fake T3 MCP: the first `fails` tools/call answer isError with `text`; later ones succeed. */
function fakeFetch(fails: number, text = COMPACTING) {
  let left = fails;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      let result: unknown = {};
      if (body.method === "tools/call" && body.params.name === "t3_thread_read") result = { structuredContent: { thread: { runStatus: "running" } } };
      else if (body.method === "tools/call")
        result = left-- > 0 ? { isError: true, content: [{ type: "text", text }] } : { structuredContent: { ok: true } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "mcp-session-id": "s1" } });
    }),
  );
}
const sends = () => bodies.filter((b) => b.method === "tools/call" && b.params.name === "t3_thread_send");
const client = () => new McpT3Client(URL_, tokenFile, [0, 0], [0, 0, 0, 0]);

describe("busy send retry (client)", () => {
  it("compacting 2x then accepted: delivered", async () => {
    fakeFetch(2);
    await client().sendToThread("thread_1", "wake");
    expect(sends()).toHaveLength(3);
  });

  it("REAL wrapper-only error twice, then accepted: delivered, not failed", async () => {
    fakeFetch(2, REAL_TEXT);
    await client().sendToThread("thread_1", "wake");
    expect(sends()).toHaveLength(3);
  });

  it("always the REAL wrapper-only error: T3BusyError with the full text after 5 attempts", async () => {
    fakeFetch(99, REAL_TEXT);
    const e = await client().sendToThread("thread_1", "wake").catch((x) => x);
    expect(e).toBeInstanceOf(T3BusyError);
    expect(e.message).toContain(REAL);
    expect(e.message).toMatch(/thread refused, cause unknown after 5 attempts/);
    expect(sends()).toHaveLength(5);
  });

  it("always compacting: T3BusyError with T3's text after 5 attempts", async () => {
    fakeFetch(99);
    const e = await client().sendToThread("thread_1", "wake").catch((x) => x);
    expect(e).toBeInstanceOf(T3BusyError);
    expect(e.message).toMatch(/thread compacting after 5 attempts( \(T3 thread state: running\))?: .*Wait for context compaction/);
    expect(sends()).toHaveLength(5);
  });

  it("a fresh clientRequestId per busy attempt; the same id across socket retries of one attempt", async () => {
    // attempt 1: socket reset once then the real refusal; attempt 2: refusal; attempt 3: accepted
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        let result: unknown = {};
        if (body.method === "tools/call" && body.params.name === "t3_thread_send") {
          call++;
          if (call === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
          result = call <= 3 ? { isError: true, content: [{ type: "text", text: REAL_TEXT }] } : { structuredContent: { ok: true } };
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "mcp-session-id": "s1" } });
      }),
    );
    await client().sendToThread("thread_1", "wake", "base-id");
    const ids = sends().map((b) => b.params.arguments.clientRequestId);
    expect(ids).toEqual(["base-id", "base-id", "base-id-busy1", "base-id-busy2"]); // socket retry keeps the id; busy retries do not
    expect(new Set(ids.slice(2)).size).toBe(2);
  });

  it("generated ids too: busy attempts differ", async () => {
    fakeFetch(2, REAL_TEXT);
    await client().sendToThread("thread_1", "wake");
    expect(new Set(sends().map((b) => b.params.arguments.clientRequestId)).size).toBe(3);
  });

  it("reads the thread state before each busy retry and puts it in the final error (best effort)", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        let result: unknown = {};
        if (body.method === "tools/call")
          result =
            body.params.name === "t3_thread_read"
              ? (reads++, reads === 1 ? { isError: true, content: [{ type: "text", text: "boom" }] } : { structuredContent: { thread: { runStatus: "compacting" } } })
              : { isError: true, content: [{ type: "text", text: REAL_TEXT }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "mcp-session-id": "s1" } });
      }),
    );
    const e = await client().sendToThread("thread_1", "wake").catch((x) => x); // first read throws: ignored
    expect(e).toBeInstanceOf(T3BusyError);
    expect(bodies.filter((b) => b.method === "tools/call" && b.params.name === "t3_thread_read")).toHaveLength(5);
    expect(e.state).toBe("compacting");
    expect(e.message).toMatch(/thread compacting after 5 attempts \(T3 thread state: compacting\)/);
  });

  it("a steer is not busy-retried (steer() falls back to auto, which is)", async () => {
    fakeFetch(99, REAL_TEXT);
    await expect(client().sendToThread("thread_1", "note", "c1", "steer")).rejects.toBeInstanceOf(T3BusyError);
    expect(sends()).toHaveLength(1);
  });

  it("another orchestration error (unknown thread) fails at once, not retried", async () => {
    fakeFetch(99, UNKNOWN_THREAD);
    const e = await client().sendToThread("thread_1", "wake").catch((x) => x);
    expect(e).not.toBeInstanceOf(T3BusyError);
    expect(e.message).toContain("not_found");
    expect(sends()).toHaveLength(1);
    expect(isThreadBusy(e)).toBe(false);
  });

  it("other tools are not busy-retried", async () => {
    fakeFetch(99);
    await expect(client().runScheduledTaskNow("task_1")).rejects.toThrow(/compaction/);
    expect(bodies.filter((b) => b.method === "tools/call")).toHaveLength(1);
  });

  it("sendFailureText names thread + host when T3 gave only the wrapper; keeps a [cause]", () => {
    expect(sendFailureText(new T3Error(`t3_thread_send: ${WRAPPER}`), "th1", "worker")).toBe(
      `t3_thread_send: ${WRAPPER} (thread th1 on worker; T3 gave no cause; see T3 trace on worker)`,
    );
    expect(sendFailureText(new T3Error(`${WRAPPER} [cause]: Error: disk full`), "th1", "worker")).toBe(`${WRAPPER} [cause]: Error: disk full`);
    expect(sendFailureText(new T3Error("T3 MCP HTTP 500: boom"), "th1", "main")).toBe("T3 MCP HTTP 500: boom");
    expect(isThreadBusy(new T3Error("Thread x is still running. Stop it before settling."))).toBe(true);
  });
});

/** Cycle-level fake: sendToThread fails with `sendError` while set. */
class FakeT3 implements T3Client {
  sendError: Error | undefined;
  sent = 0;
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { return { threadId: "home" }; }
  async sendToThread() {
    this.sent++;
    if (this.sendError) throw this.sendError;
  }
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s17-cycle-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const t3 = new FakeT3();
  const store = createStore(db);
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", busyRewakeMs: 5 * 60_000, busyRewakeCap: 2 });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "mgr", remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "main" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  // first wake launches the home thread; later wakes send into it
  const first = await cycle.runNow(a.id);
  store.updateRun(first.id, { outcome: "progressed", endedAt: new Date().toISOString() });
  return { store, cycle, t3, a };
}

describe("busy wake → timed re-wake (cycle)", () => {
  it("REAL wrapper-only refusal after the send retries: run not failed, retryAt set, summary names the time; cap → failed with the full text", async () => {
    const t = await setup();
    // what McpT3Client throws after its busy retries on the incident's error (state read from t3_thread_read)
    t.t3.sendError = new T3BusyError(`t3_thread_send home: thread refused, cause unknown after 5 attempts (T3 thread state: compacting): ${REAL}`, {
      kind: "refused, cause unknown",
      state: "compacting",
    });
    for (let i = 0; i < 2; i++) {
      const run = await t.cycle.runNow(t.a.id);
      expect(run.outcome).toBe("idle");
      expect(run.retryAt).toBeTruthy();
      expect(run.summary).toBe(`${BUSY_PREFIX} (refused, cause unknown; T3 thread state: compacting), re-wake at ${run.retryAt}`);
      expect(Date.parse(run.retryAt!) - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(t.store.getAssignment(t.a.id)!.retryAt).toBe(run.retryAt);
      t.store.updateAssignment(t.a.id, { retryAt: null, retryRunId: null }); // tickRetry clears it before re-waking
    }
    const e = await t.cycle.runNow(t.a.id).catch((x) => x);
    expect(e.code).toBe("t3_error");
    const failed = t.store.getRun(e.details.runId)!;
    expect(failed.outcome).toBe("failed");
    expect(failed.summary).toContain("thread still refused, cause unknown after 2 re-wakes");
    expect(failed.summary).toContain(REAL_TEXT);
    expect(failed.summary).toContain("see T3 trace on main");
    // a delivered wake resets the streak
    t.t3.sendError = undefined;
    const ok = await t.cycle.runNow(t.a.id);
    expect(ok.outcome).toBe("running");
  });

  it("a compaction text T3 did give still reads 'compacting'", async () => {
    const t = await setup();
    t.t3.sendError = new T3BusyError(`t3_thread_send home: thread compacting after 5 attempts: ${COMPACTING}`);
    const run = await t.cycle.runNow(t.a.id);
    expect(run.outcome).toBe("idle");
    expect(run.summary).toBe(`${BUSY_PREFIX} (compacting), re-wake at ${run.retryAt}`);
  });

  it("another orchestration error (not message.dispatch) fails at once", async () => {
    const t = await setup();
    t.t3.sendError = new T3Error(`t3_thread_send: ${UNKNOWN_THREAD}`);
    const e = await t.cycle.runNow(t.a.id).catch((x) => x);
    expect(e.code).toBe("t3_error");
    // look the run up by id: listRuns orders by started_at (ms) then random id, so same-ms runs have no stable "newest"
    const failed = t.store.getRun(e.details.runId)!;
    expect(failed.outcome).toBe("failed");
    expect(failed.summary).toBe(`Run now failed: t3_thread_send: ${UNKNOWN_THREAD}`);
    expect(failed.retryAt).toBeFalsy();
    expect(t.t3.sent).toBe(1);
  });
});
