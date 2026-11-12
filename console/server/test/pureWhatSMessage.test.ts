import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { SEED_VERSION, STAMP_ASK_MAX_MS, endpointLines } from "../src/desk/desk.js";
import { DELIVERED_MARKER } from "../src/desk/placements.js";
import { asksFor, writeStamp } from "../src/status/stamp.js";

/** Mark ready works for the owner: the button over plain http (Origin), and the desk on his own chat request. */

/** the owner writes in the desk chat from the console page (a browser same-origin call). */
const PAGE = { "Sec-Fetch-Site": "same-origin" };
const BASE = "http://console.test";
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const spine = (status: string) => `# PLAN-20: Scratch

Spine ID: scratch
Integration policy: main-direct

## Current State

Status: ${status}

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| T20-S1 | Do it | draft |

## Decisions

| Date | Status | Decision | Summary | Evidence | Revisit |
|---|---|---|---|---|---|
`;

class FakeT3 {
  threads = new Map<string, { messages: T3ThreadMessage[] }>();
  private n = 0;
  private pos = 0;
  push(threadId: string, role: "user" | "assistant", text: string, updatedAt = new Date().toISOString()) {
    this.threads.get(threadId)!.messages.push({ itemId: `item_${++this.pos}`, position: this.pos * 2, role, text, status: "completed", truncated: false, updatedAt });
  }
  async listProjects() {
    return [{ id: "p_home_repo", title: "home_repo", workspaceRoot: "/x/home_repo", repositoryIdentity: { displayName: "acme/home_repo" } }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {}
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: any) {
    const threadId = `thread_${++this.n}`;
    this.threads.set(threadId, { messages: [] });
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string) {
    if (this.threads.has(threadId)) this.push(threadId, "user", message);
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    const all = (this.threads.get(threadId)?.messages ?? []).filter((m) => opts.afterPosition === undefined || m.position > opts.afterPosition);
    const page = all.slice(0, opts.limit ?? 100);
    return { messages: page, nextPosition: page.length ? page[page.length - 1].position : (opts.afterPosition ?? null), hasMore: all.length > page.length, archived: false };
  }
}

let tmp: string;
let repo: string;
let db: DB;
let t3: FakeT3;
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e14s7-"));
  const origin = path.join(tmp, "origin.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  put(seed, "docs/spines/scratch.md", spine("draft"));
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "scratch"]);
  git(seed, ["push", "-q", "origin", "main"]);
  repo = path.join(tmp, "scratch");
  git(tmp, ["clone", "-q", origin, repo]);
  db = openDb(path.join(tmp, "console.db"));
  t3 = new FakeT3();
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_SYSTEM", savedEnv.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const boot = async () => {
  const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, {
    read: readCfg,
    cycle: {
      enabled: true,
      t3: t3 as unknown as T3Client,
      dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "claudeAgent_seat1" }), done: async () => {} } as unknown as Dispatcher,
      publicUrl: BASE,
    },
  });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const m = (await call("POST", "/api/milestones", { title: "Scratch", repo: "Acme/scratch", path: "docs/spines/scratch.md" })).json;
  return { call, m };
};
const statusOf = () => {
  git(repo, ["pull", "-q", "--ff-only"]);
  const text = fs.readFileSync(path.join(repo, "docs/spines/scratch.md"), "utf8");
  return { status: /^Status: (\w+)$/m.exec(text)?.[1], text };
};
const DESK = { "X-Console-Run": "team-desk" };

describe("T14-S7 pure: what Sam's message asks for, the Decisions row quoting it", () => {
  it("asksFor and the desk-chat Decisions row", () => {
    expect(asksFor("can you mark it ready for me please", "ready")).toBe(true);
    expect(asksFor("go on PLAN-20", "ready")).toBe(true);
    expect(asksFor("what is PLAN-20 about?", "ready")).toBe(false);
    expect(asksFor("move it back to Planning", "draft")).toBe(true);
    expect(asksFor("mark it ready", "draft")).toBe(false);
    const out = writeStamp(spine("draft"), "ready", "2026-10-25", `mark "scratch" | ready ${"x".repeat(200)}`);
    expect(out).toMatch(/\| stamped ready by Sam 2026-10-25 \(desk chat: "mark 'scratch' \/ ready x+"\) \|/);
    expect((out as string).match(/desk chat: "([^"]*)"/)![1]).toHaveLength(120);
  });
});

describe("T14-S7 button: the stamp route over plain http", () => {
  it("Origin = own host passes (no Sec-Fetch-Site); curl without Origin, a foreign Origin, a token are 403", async () => {
    const x = await boot();
    const url = `/api/milestones/${x.m.id}/stamp`;
    const HOST = { Host: "10.104.206.10:8750" };
    expect((await x.call("POST", url, { to: "ready" }, HOST)).status).toBe(403); // curl
    expect((await x.call("POST", url, { to: "ready" }, { ...HOST, Origin: "http://evil.example" })).status).toBe(403);
    expect((await x.call("POST", url, { to: "ready" }, { ...HOST, Origin: "http://10.104.206.10:8750", Authorization: "Bearer t" })).status).toBe(403);
    const ok = await x.call("POST", url, { to: "ready" }, { ...HOST, Origin: "http://10.104.206.10:8750" });
    expect(ok.status).toBe(201);
    expect(statusOf().status).toBe("ready");
    expect((await x.call("POST", url, { to: "draft" }, { ...HOST, Origin: "http://10.104.206.10:8750" })).status).toBe(201);
    expect(statusOf().status).toBe("draft");
    // the outcome mark has the same wall
    expect((await x.call("POST", `/api/milestones/${x.m.id}/mark`, { verdict: "accomplished", sentence: "s" }, HOST)).status).toBe(403);
  });
});

describe("T14-S7 desk: stamps only on Sam's own newest desk message", () => {
  it("the desk's endpoint list names the desk stamp; the seed version moved", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(3);
    expect(endpointLines(BASE).join("\n")).toContain(`${BASE}/api/desk/stamp`);
  });

  it("Sam asks → the desk stamps ready (Decisions quotes him) and back; refusals for every other case", async () => {
    const x = await boot();
    await x.call("GET", "/api/desk/messages"); // launches thread_1
    const stamp = (b: object, h: Record<string, string> = DESK) => x.call("POST", "/api/desk/stamp", { milestoneId: x.m.id, ...b }, h);

    // only the console page writes the owner's desk messages: a persona, the desk, a token or a curl cannot
    for (const h of [{} as Record<string, string>, DESK, { ...PAGE, "X-Run-Id": "run_1" }, { ...PAGE, Authorization: "Bearer t" }, { Origin: "http://evil.example", Host: "10.104.206.10:8750" }])
      expect((await x.call("POST", "/api/desk/messages", { text: "mark scratch ready" }, h)).status).toBe(403);
    expect((await x.call("POST", "/api/desk/messages", { text: "hello" }, { Origin: "http://10.104.206.10:8750", Host: "10.104.206.10:8750" })).status).toBe(201);
    // nothing asking for a stamp yet
    expect((await stamp({ to: "ready", chat: "mark it ready" })).status).toBe(403);
    await x.call("POST", "/api/desk/messages", { text: "can you mark scratch ready for me please", page: "Scratch · Tree" }, PAGE);

    // not the desk: no header, a persona run, a run id, a token, the owner's browser
    expect((await stamp({ to: "ready", chat: "mark scratch ready" }, {})).status).toBe(403);
    expect((await stamp({ to: "ready", chat: "mark scratch ready" }, { "X-Console-Run": "run_1" })).status).toBe(403);
    expect((await stamp({ to: "ready", chat: "mark scratch ready" }, { ...DESK, "X-Run-Id": "run_1" })).status).toBe(403);
    expect((await stamp({ to: "ready", chat: "mark scratch ready" }, { ...DESK, Authorization: "Bearer t" })).status).toBe(403);
    expect((await stamp({ to: "ready", chat: "mark scratch ready" }, { Origin: BASE, "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
    // words he never wrote; asking for the other direction; bad body
    expect((await stamp({ to: "ready", chat: "stamp everything" })).json.error.code).toBe("not_asked");
    expect((await stamp({ to: "draft", chat: "mark scratch ready" })).json.error.code).toBe("not_asked");
    expect((await stamp({ to: "ready" })).status).toBe(400);
    expect((await stamp({ to: "go", chat: "mark scratch ready" })).status).toBe(400);
    expect(statusOf().status).toBe("draft");

    const ok = await stamp({ to: "ready", chat: "mark scratch ready" });
    expect(ok.status).toBe(201);
    const s = statusOf();
    expect(s.status).toBe("ready");
    expect(s.text).toMatch(/stamped ready by Sam \d{4}-\d\d-\d\d \(desk chat: "can you mark scratch ready for me please"\)/);
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("Stamped ready for delivery (Sam, asking the Team desk)");

    // a console note arriving after his message: the desk is no longer answering him
    await t3.sendToThread("thread_1", `${DELIVERED_MARKER} something closed`);
    await x.call("POST", "/api/desk/messages", { text: "ok, move scratch back to Planning" }, PAGE);
    expect((await stamp({ to: "draft", chat: "move scratch back to planning" })).status).toBe(201);
    expect(statusOf().status).toBe("draft");
    await t3.sendToThread("thread_1", `${DELIVERED_MARKER} something closed`);
    expect((await stamp({ to: "ready", chat: "move scratch back" })).status).toBe(403);
  });

  it("a message older than 15 minutes is not a stamp", async () => {
    const x = await boot();
    await x.call("GET", "/api/desk/messages");
    t3.push("thread_1", "user", "mark scratch ready", new Date(Date.now() - STAMP_ASK_MAX_MS - 60_000).toISOString());
    const r = await x.call("POST", "/api/desk/stamp", { milestoneId: x.m.id, to: "ready", chat: "mark scratch ready" }, DESK);
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/older than 15 minutes/);
    expect(statusOf().status).toBe("draft");
  });
});
