import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { McpT3Client, type T3Client, type T3MessagePage, type T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { createDesk, DESK_PERSONA_NAME, migrateDesk, SEED_MARKER } from "../src/desk/desk.js";

// the Team desk thread (launched once, reused, relaunched when gone) and the chat's read/send.
/** the owner writes in the desk chat from the console page (a browser same-origin call). */
const PAGE = { "Sec-Fetch-Site": "same-origin" };
const BASE = "http://127.0.0.1:18799";
const PROJECTS = [{ id: "p_home_repo", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo", repositoryIdentity: { displayName: "acme/home_repo" } }];

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, { messages: T3ThreadMessage[]; status: string }>();
  gone = new Set<string>();
  sendDelayMs = 0;
  failSend: string | undefined;
  private n = 0;
  private pos = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  private push(threadId: string, role: "user" | "assistant", text: string, status = "completed") {
    const t = this.threads.get(threadId)!;
    t.messages.push({ itemId: `item_${++this.pos}`, position: this.pos * 2, role, text, status, truncated: false, updatedAt: new Date().toISOString() });
  }
  say = (threadId: string, text: string, status = "completed") => this.push(threadId, "assistant", text, status);
  async listProjects() {
    return PROJECTS;
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { projectId: string; title: string; message?: string; modelSelection?: any }) {
    this.calls.push({ op: "launchThread", args: input });
    const threadId = `desk_thread_${++this.n}`;
    this.threads.set(threadId, { messages: [], status: "running" });
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId, mode } });
    if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
    if (this.failSend) throw new Error(this.failSend);
    this.push(threadId, "user", message);
  }
  async readThreadStatus(threadId: string) {
    this.calls.push({ op: "readThreadStatus", args: { threadId } });
    if (this.gone.has(threadId)) throw new Error('t3_thread_read: {"code":"not_found","message":"Thread not found."}');
    return { status: this.threads.get(threadId)?.status ?? "idle", raw: {} };
  }
  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    this.calls.push({ op: "readThreadMessages", args: { threadId, ...opts } });
    if (this.gone.has(threadId)) throw new Error("not_found");
    const all = (this.threads.get(threadId)?.messages ?? []).filter((m) => opts.afterPosition === undefined || m.position > opts.afterPosition);
    const page = all.slice(0, opts.limit ?? 100);
    return { messages: page, nextPosition: page.length ? page[page.length - 1].position : (opts.afterPosition ?? null), hasMore: all.length > page.length, archived: false };
  }
}

class FakeDispatcher implements Dispatcher {
  released: string[] = [];
  async pick() {
    return { seat: "seat2", providerInstanceId: "claudeAgent_seat2" };
  }
  async done(seat: string) {
    this.released.push(seat);
  }
}

let dir: string;
let db: DB;
let t3: FakeT3;
let dispatcher: FakeDispatcher;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e18s1s2-"));
  db = openDb(path.join(dir, "console.db"));
  t3 = new FakeT3();
  dispatcher = new FakeDispatcher();
  app = createApp(db, { cycle: { enabled: true, t3, dispatcher, publicUrl: BASE, runState: async () => undefined } });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) => {
  const res = await app.request(url, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
};

describe("T18-S1 the desk session", () => {
  it("launches ONE thread, even for concurrent first opens, and reuses it", async () => {
    const [a, b, c] = await Promise.all([call("GET", "/api/desk/messages"), call("GET", "/api/desk/messages"), call("GET", "/api/desk/messages")]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(t3.ops("launchThread")).toHaveLength(1);
    const again = await call("GET", "/api/desk/messages");
    await call("POST", "/api/desk/messages", { text: "hello" }, PAGE);
    expect(t3.ops("launchThread")).toHaveLength(1);
    expect(again.json.threadId).toBe("desk_thread_1");
    expect(db.prepare("SELECT COUNT(*) n FROM desk_session").get()).toEqual({ n: 1 });
    expect(dispatcher.released).toEqual(["seat2", ]); // seat not held by a long-lived thread
  });

  it("a poll reads the thread status once, not twice", async () => {
    await call("GET", "/api/desk/messages");
    const before = t3.ops("readThreadStatus").length;
    await call("GET", "/api/desk/messages");
    expect(t3.ops("readThreadStatus").length - before).toBe(1);
  });

  it("seeds the persona's remit, console base URL, persona auth header and the endpoints it may call", async () => {
    await call("GET", "/api/desk/messages");
    const launch = t3.ops("launchThread")[0].args;
    expect(launch.projectId).toBe("p_home_repo");
    expect(launch.modelSelection).toEqual({ instanceId: "claudeAgent_seat2", model: "claude-opus-5-5" });
    const seed: string = launch.message;
    expect(seed.startsWith(SEED_MARKER)).toBe(true);
    expect(seed).toContain("You are Team desk");
    expect(seed).toContain(`${BASE}/api`);
    expect(seed).toContain("X-Console-Run: team-desk");
    for (const ep of ["/api/assignments/<assignment id>/run-now", "/api/assignments/<assignment id>/steer", "/api/runs/<run id>/stop", "/api/waiting-on-owner/<item id>/respond"])
      expect(seed).toContain(ep);
    expect(seed).toContain("spines.py --active");
    // its own persona row, remit from docs/personas/team-desk.md or the built-in fallback; no assignment, so it never wakes on its own
    const p = createStore(db).listPersonas().find((x) => x.name === DESK_PERSONA_NAME)!;
    expect(p.remit.length).toBeGreaterThan(50);
    expect(createStore(db).listAssignments({ personaId: p.id })).toHaveLength(0);
  });

  it("relaunches seeded with a summary when T3 lost the thread, and marks the new session", async () => {
    await call("GET", "/api/desk/messages");
    t3.say("desk_thread_1", "Placed it under PLAN-18.");
    await call("POST", "/api/desk/messages", { text: "move it to PLAN-17" }, PAGE);
    t3.gone.add("desk_thread_1");
    const view = await call("GET", "/api/desk/messages");
    expect(t3.ops("launchThread")).toHaveLength(2);
    expect(view.json.threadId).toBe("desk_thread_2");
    expect(view.json.session).toBe(2);
    const seed: string = t3.ops("launchThread")[1].args.message;
    expect(seed).toContain("desk_thread_1");
    expect(seed).toContain("is gone");
    expect(db.prepare("SELECT thread_id, end_reason FROM desk_session WHERE ended_at IS NOT NULL").all()).toEqual([{ thread_id: "desk_thread_1", end_reason: "not found in T3" }]);
    expect(view.json.messages[0]).toMatchObject({ kind: "seed", session: 2, text: "" });
  });

  it("a transient T3 error is not a lost thread (no relaunch)", async () => {
    await call("GET", "/api/desk/messages");
    t3.readThreadStatus = async () => {
      throw new Error("T3 MCP HTTP 500");
    };
    const r = await call("GET", "/api/desk/messages");
    expect(r.status).toBe(502);
    expect(t3.ops("launchThread")).toHaveLength(1);
  });

  it("cycle off: the chat says it is unavailable, launches nothing", async () => {
    const off = createApp(db, { cycle: { enabled: false, publicUrl: BASE } });
    const res = await off.request("/api/desk/messages");
    expect(await res.json()).toMatchObject({ available: false, messages: [] });
    expect((await off.request("/api/desk/messages", { method: "POST", headers: { "content-type": "application/json", ...PAGE }, body: JSON.stringify({ text: "x" }) })).status).toBe(503);
  });
});

describe("T18-S2 the chat reads and sends", () => {
  it("send carries the page hint; the transcript shows the hint as a chip and hides the seed text", async () => {
    await call("GET", "/api/desk/messages");
    const sent = await call("POST", "/api/desk/messages", { text: "what is next here?", page: "M5 · Milestone" }, PAGE);
    expect(sent.status).toBe(201);
    expect(t3.ops("sendToThread")[0].args).toMatchObject({ threadId: "desk_thread_1", message: "[page: M5 · Milestone]\nwhat is next here?", mode: "auto" });
    t3.say("desk_thread_1", "Next is [T18-S3](https://example.test/s3).");
    const v = (await call("GET", "/api/desk/messages")).json;
    expect(v.messages.map((m: any) => [m.role, m.kind, m.text, m.page])).toEqual([
      ["user", "seed", "", undefined],
      ["user", "message", "what is next here?", "M5 · Milestone"],
      ["assistant", "message", "Next is [T18-S3](https://example.test/s3).", undefined],
    ]);
    expect(JSON.stringify(v)).not.toContain("You are Team desk");
  });

  it("a send without a hint is sent as typed; brackets and newlines in a hint cannot break the frame", async () => {
    await call("GET", "/api/desk/messages");
    await call("POST", "/api/desk/messages", { text: "plain" }, PAGE);
    await call("POST", "/api/desk/messages", { text: "x", page: "a]\nb[c" }, PAGE);
    expect(t3.ops("sendToThread").map((c) => c.args.message)).toEqual(["plain", "[page: a b c]\nx"]);
    expect((await call("POST", "/api/desk/messages", { text: "   " }, PAGE)).status).toBe(400);
    expect((await call("POST", "/api/desk/messages", {}, PAGE)).status).toBe(400);
  });

  it("working follows T3's thread status", async () => {
    await call("GET", "/api/desk/messages");
    expect((await call("GET", "/api/desk/messages")).json).toMatchObject({ status: "running", working: true });
    t3.threads.get("desk_thread_1")!.status = "idle";
    expect((await call("GET", "/api/desk/messages")).json).toMatchObject({ status: "idle", working: false });
  });

  it("reads only what is new after the settled cursor, and re-reads a message that was still streaming", async () => {
    await call("GET", "/api/desk/messages");
    t3.say("desk_thread_1", "partial…", "running");
    await call("GET", "/api/desk/messages");
    const streamingPos = t3.threads.get("desk_thread_1")!.messages.at(-1)!.position;
    // the reply finishes: same item, final text
    const m = t3.threads.get("desk_thread_1")!.messages.at(-1)!;
    m.text = "final answer";
    m.status = "completed";
    const v = (await call("GET", "/api/desk/messages")).json;
    expect(v.messages.at(-1)).toMatchObject({ text: "final answer", status: "completed" });
    // the read started from before the open message, not from the top
    const reads = t3.ops("readThreadMessages");
    expect(reads.at(-1)!.args.afterPosition).toBe(streamingPos - 1);
    // now everything is settled: the next read starts after the last message
    await call("GET", "/api/desk/messages");
    expect(t3.ops("readThreadMessages").at(-1)!.args.afterPosition).toBe(streamingPos);
  });

  it("a send T3 keeps refusing answers 202 pending and shows the failure on the next read", async () => {
    const store = createStore(db);
    migrateDesk(db);
    const desk = createDesk({ db, store, t3, dispatcher, publicUrl: BASE, reposRoot: dir, sendWaitMs: 5 });
    await desk.view();
    t3.sendDelayMs = 40;
    t3.failSend = "thread compacting after 5 attempts";
    const r = await desk.send("hello", "Runs");
    expect(r.pending).toBe(true);
    await new Promise((x) => setTimeout(x, 80));
    const v = await desk.view();
    expect(v.sending).toBe(0);
    expect(v.sendError?.text).toContain("compacting");
    // a later good send clears it
    t3.failSend = undefined;
    t3.sendDelayMs = 0;
    expect((await desk.send("again")).pending).toBe(false);
    expect((await desk.view()).sendError).toBeUndefined();
  });
});

describe("T18-S2 McpT3Client.readThreadMessages", () => {
  let tokenFile: string;
  let bodies: any[];
  beforeEach(() => {
    tokenFile = path.join(dir, "token");
    fs.writeFileSync(tokenFile, "tok\n");
    bodies = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  const item = (position: number, type: string, text: string) => ({ position, itemId: `i${position}`, type, status: "completed", text, textTruncated: false, updatedAt: "2026-10-25T10:00:00.000Z" });

  it("asks for the messages view after a position and keeps only user and assistant text (no tool, reasoning or plan noise)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        const result =
          body.method === "tools/call"
            ? {
                structuredContent: {
                  thread: { archived: false },
                  items: [
                    item(1, "user_message", "hi"),
                    item(2, "reasoning", "thinking"),
                    item(3, "tool_call", "Bash ls"),
                    item(4, "assistant_message", "hello"),
                    item(5, "proposed_plan", "plan"),
                  ],
                  nextPosition: 5,
                  hasMore: true,
                },
              }
            : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "mcp-session-id": "s1" } });
      }),
    );
    const c = new McpT3Client("http://127.0.0.1:1/mcp", tokenFile, [0, 0]);
    const page = await c.readThreadMessages("t1", { afterPosition: 0, limit: 50 });
    const call = bodies.find((b) => b.method === "tools/call");
    expect(call.params.name).toBe("t3_thread_read");
    expect(call.params.arguments).toMatchObject({ threadId: "t1", view: "messages", afterPosition: 0, limit: 50 });
    expect(page.messages.map((m) => [m.role, m.text, m.position])).toEqual([["user", "hi", 1], ["assistant", "hello", 4]]);
    expect(page).toMatchObject({ nextPosition: 5, hasMore: true, archived: false });
  });
});
