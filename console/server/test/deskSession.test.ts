import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { McpT3Client, type T3Client, type T3MessagePage, type T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { createDesk, DEFAULT_DESK_REPO, DESK_PERSONA_NAME, migrateDesk, SEED_MARKER } from "../src/desk/desk.js";

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
  /** a slow T3 status read (the tunnel to the worker server). */
  statusDelayMs = 0;
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
    if (this.statusDelayMs) await new Promise((r) => setTimeout(r, this.statusDelayMs));
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

describe("Send never waits on T3", () => {
  it("answers within sendWaitMs while the thread check and the send run on after the reply", async () => {
    const desk = createDesk({ db, store: createStore(db), t3, dispatcher, publicUrl: BASE, reposRoot: dir, sendWaitMs: 30 });
    await desk.view();
    t3.statusDelayMs = 150; // the thread check alone is slower than the wait
    const t0 = Date.now();
    const r = await desk.send("fast please", undefined, "chat-a");
    expect(Date.now() - t0).toBeLessThan(120);
    expect(r).toMatchObject({ pending: true });
    expect(r.threadId).toMatch(/^desk_thread_/);
    await new Promise((x) => setTimeout(x, 250));
    expect(t3.ops("sendToThread").map((c) => c.args.clientRequestId)).toEqual(["chat-a"]);
    t3.statusDelayMs = 0;
    expect((await desk.view()).sending).toBe(0);
  });

  it("his sends reach T3 in the order he wrote them, even when each answers before T3 took it", async () => {
    const desk = createDesk({ db, store: createStore(db), t3, dispatcher, publicUrl: BASE, reposRoot: dir, sendWaitMs: 5 });
    await desk.view();
    t3.sendDelayMs = 40;
    const rs = await Promise.all(["one", "two", "three"].map((w) => desk.send(w, undefined, `chat-${w}`)));
    expect(rs.every((r) => r.pending)).toBe(true);
    await new Promise((x) => setTimeout(x, 200));
    expect(t3.ops("sendToThread").map((c) => c.args.clientRequestId)).toEqual(["chat-one", "chat-two", "chat-three"]);
  });

  it("a failure after the reply names his message by its clientRequestId, so the chat shows it on that bubble", async () => {
    const desk = createDesk({ db, store: createStore(db), t3, dispatcher, publicUrl: BASE, reposRoot: dir, sendWaitMs: 5 });
    await desk.view();
    t3.sendDelayMs = 30;
    t3.failSend = "thread compacting after 5 attempts";
    expect((await desk.send("hello", undefined, "chat-x")).pending).toBe(true);
    await new Promise((x) => setTimeout(x, 80));
    expect((await desk.view()).sendError).toMatchObject({ clientRequestId: "chat-x" });
  });

  it("a failure inside the wait still answers the request with the error", async () => {
    const desk = createDesk({ db, store: createStore(db), t3, dispatcher, publicUrl: BASE, reposRoot: dir, sendWaitMs: 200 });
    await desk.view();
    t3.failSend = "no seat available: all seats busy";
    await expect(desk.send("hello", undefined, "chat-y")).rejects.toThrow(/no seat available/);
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

describe("the desk reads every message against his objectives", () => {
  // his words file holds only his words per objective id and the other worlds; the pursuits are his live objectives.
  const words = (refreshedAt: string) => ({
    version: 2,
    refreshedAt,
    objectives: [
      { id: "product-testers", match: [["tester"]], after: { words: "more importantly for the product", said: new Date().toISOString().slice(0, 16) + "Z", via: "WhatsApp" } },
      { id: "ops", match: [["browser"]], after: { words: "use the browser" } },
      { id: "house", name: "The house", match: [["house"]], world: { repo: "home_two", status: "active", next: "worldwide weather search" }, after: { words: "the right weather at an affordable price" } },
    ],
  });
  const objectives = async () => ({
    nodes: [
      { id: "ops", kind: "pursuit", name: "Ops", rank: 1, headline: "The browser works", greens: 1, total: 2, keyResults: [{ label: "Signs in", state: "red", value: "not yet" }, { state: "green" }] },
      { id: "product-testers", kind: "pursuit", name: "T", rank: 2, headline: "Five testers use the product", greens: 0, total: 1, keyResults: [{ label: "Applications", state: "amber", value: "1" }] },
      { id: "new-one", kind: "pursuit", name: "N", rank: 3, headline: "A new objective he just added", greens: 0, total: 1, keyResults: [{ state: "red" }] },
    ],
    progress: { sets: { "product-testers": { today: 1, week: 1 } } },
  });
  const writeWords = (f: unknown) => {
    fs.mkdirSync(path.join(dir, DEFAULT_DESK_REPO, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, DEFAULT_DESK_REPO, "docs", "his-words.json"), JSON.stringify(f));
  };

  it("puts his objectives block before his words: every live objective, the ones he names first with his words; the chat and his words never show it", async () => {
    writeWords(words(new Date().toISOString()));
    const desk = createDesk({ db, store: createStore(db), t3, dispatcher, publicUrl: BASE, reposRoot: dir, sendWaitMs: 50, objectives });
    await desk.view();
    await desk.send("what about the tester alert I got?", "Pursuits", "obj-1");
    await new Promise((x) => setTimeout(x, 60));
    const sent = t3.ops("sendToThread").at(-1)!.args.message as string;
    expect(sent.startsWith("[page: Pursuits]\n[his objectives]\n")).toBe(true);
    expect(sent).not.toMatch(/plot/i);
    expect(sent).toContain("His 3 objectives live from the objectives screen");
    // the one his message names comes first, with his words; the others follow in his order, short
    expect(sent.indexOf("2. 🟡 Five testers use the product")).toBeLessThan(sent.indexOf("1. 🔴 The browser works"));
    expect(sent).toContain('his words');
    expect(sent).toContain('"more importantly for the product"');
    expect(sent).toContain("moved today: 1 turned green");
    expect(sent).toContain("next: Signs in (not yet)");
    expect(sent).not.toContain('"use the browser"');
    // an objective he just added is in the block with no hand edit; the other world he names too
    expect(sent).toContain("3. 🔴 A new objective he just added");
    expect(sent).toContain("· The house (its own world home_two: notes only) · active · next: worldwide weather search");
    expect(sent).toMatch(/\[\/his objectives\]\nwhat about the tester alert I got\?$/);
    const v = await desk.view();
    const mine = v.messages.filter((m: any) => m.role === "user" && m.kind === "message").at(-1) as any;
    expect(mine.text).toBe("what about the tester alert I got?");
    expect(mine.page).toBe("Pursuits");
    // a quote from the block is never his: no stamp on the block's words
    expect(await desk.jordiSaid("more importantly for the product")).toBe(false);
    expect(await desk.jordiSaid("the tester alert I got")).toBe(true);
  });

  it("a stale refresh says so; no words file and no objectives = no block", async () => {
    writeWords(words("2026-11-01T00:00Z"));
    const desk = createDesk({ db, store: createStore(db), t3, dispatcher, publicUrl: BASE, reposRoot: dir, sendWaitMs: 50 });
    await desk.view();
    await desk.send("hi", undefined, "obj-2");
    await new Promise((x) => setTimeout(x, 60));
    expect(t3.ops("sendToThread").at(-1)!.args.message).toContain("STALE: run scripts/his_words.py refresh");
    fs.rmSync(path.join(dir, DEFAULT_DESK_REPO, "docs", "his-words.json"));
    await desk.send("hi again", undefined, "obj-3");
    await new Promise((x) => setTimeout(x, 60));
    expect(t3.ops("sendToThread").at(-1)!.args.message).toBe("hi again");
  });

  it("the seed and the endpoint-list update carry the objectives rule (v39: every live objective, no invented name)", async () => {
    const { deskSeed, updateMessage, SEED_VERSION } = await import("../src/desk/desk.js");
    expect(SEED_VERSION).toBeGreaterThanOrEqual(39);
    const seed = deskSeed({ persona: { name: DESK_PERSONA_NAME, remit: "r" }, publicUrl: BASE, reposRoot: dir });
    expect(seed).toContain("His objectives first (");
    expect(seed).toContain("every live objective");
    expect(seed).not.toContain("--stands");
    expect(updateMessage(BASE)).toContain("his objectives first");
    expect(seed).not.toContain("Plot:");
    expect(updateMessage(BASE)).not.toContain("Plot:");
  });
});
