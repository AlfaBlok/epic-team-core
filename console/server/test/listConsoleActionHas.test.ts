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
import { SEED_VERSION, endpointLines, updateMessage } from "../src/desk/desk.js";
import { asksForMark, asksForSettle } from "../src/status/mark.js";

/** the Team desk runs the console fully: every web action is in its list; mark / settle only on the owner's own words. */
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e41s4-"));
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
const CHAT = (id: string) => ({ "X-Console-Run": `milestone-chat:${id}` });
const markBody = { verdict: "accomplished", sentence: "Scratch shipped" };

describe("T41-S4 list: every console action Sam has on the web is in the desk's list", () => {
  it("names milestone create / bootstrap / patch, personas, assignments, approvals, desk mark / settle, and the no-'no way' rule", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(11);
    const list = endpointLines(BASE).join("\n");
    for (const s of [
      `-X POST ${BASE}/api/milestones -H 'X-Console-Run: team-desk'`,
      `${BASE}/api/milestones/bootstrap`,
      `-X PATCH ${BASE}/api/milestones/<id>`,
      `${BASE}/api/personas`,
      "PATCH /api/personas/<id>",
      `${BASE}/api/assignments`,
      "PATCH /api/assignments/<id>",
      `${BASE}/api/milestones/<id>/approvals`,
      "/approvals/<code>/revoke",
      `${BASE}/api/desk/mark`,
      `${BASE}/api/desk/settle`,
      `${BASE}/api/desk/stamp`,
      "/run-now",
      "/steer",
      "/stop",
      "/tree/add",
      "/respond",
      "/hosts/worker/wake",
    ])
      expect(list).toContain(s);
    expect(list).toMatch(/Never tell Sam "I have no way to"/);
    expect(list).toMatch(/only on his own words \(below\)/);
    expect(updateMessage(BASE)).toContain(`[team-desk update] v${SEED_VERSION}`);
  });

  it("asksForMark / asksForSettle read the verdict from his words", () => {
    expect(asksForMark("mark scratch done please", "accomplished")).toBe(true);
    expect(asksForMark("scratch is not done", "accomplished")).toBe(false);
    expect(asksForMark("what is scratch?", "accomplished")).toBe(false);
    expect(asksForMark("scratch was partially done", "partially")).toBe(true);
    expect(asksForMark("scratch is superseded by PLAN-9", "superseded")).toBe(true);
    expect(asksForMark("reopen scratch, it is not done", "not_accomplished")).toBe(true);
    expect(asksForSettle("settle scratch", true)).toBe(true);
    expect(asksForSettle("unsettle scratch", true)).toBe(false);
    expect(asksForSettle("unsettle scratch", false)).toBe(true);
    expect(asksForSettle("hello", true)).toBe(false);
  });
});

describe("T41-S4 desk mark / settle: Sam's own newest desk message, Team desk only", () => {
  it("accepts his words, refuses everything else; milestone chats keep refusing", async () => {
    const x = await boot();
    await x.call("GET", "/api/desk/messages"); // launches thread_1
    const mark = (b: object, h: Record<string, string> = DESK) => x.call("POST", "/api/desk/mark", { milestoneId: x.m.id, ...markBody, ...b }, h);
    const settle = (b: object, h: Record<string, string> = DESK) => x.call("POST", "/api/desk/settle", { milestoneId: x.m.id, ...b }, h);

    // nothing from the owner yet
    expect((await mark({ chat: "scratch is done" })).json.error.code).toBe("not_asked");
    await x.call("POST", "/api/desk/messages", { text: "scratch is done, mark it accomplished" }, PAGE);

    // not the Team desk: a milestone chat, a run id, a token, no header, the owner's browser
    for (const h of [CHAT(x.m.id), { ...DESK, "X-Run-Id": "run_1" }, { ...DESK, Authorization: "Bearer t" }, {} as Record<string, string>, PAGE]) {
      expect((await mark({ chat: "scratch is done" }, h)).status).toBe(403);
      expect((await settle({ chat: "scratch is done" }, h)).status).toBe(403);
    }
    // a milestone chat still cannot mark or settle by the page routes either
    expect((await x.call("POST", `/api/milestones/${x.m.id}/mark`, markBody, CHAT(x.m.id))).status).toBe(403);
    expect((await x.call("POST", `/api/milestones/${x.m.id}/settle`, {}, CHAT(x.m.id))).json.error.code).toBe("jordi_only");
    expect((await x.call("POST", `/api/milestones/${x.m.id}/settle`, {}, DESK)).json.error.code).toBe("jordi_only");
    // words he never wrote; a verdict he did not name; bad body
    expect((await mark({ chat: "close everything" })).json.error.code).toBe("not_asked");
    expect((await mark({ chat: "scratch is done", verdict: "superseded" })).json.error.code).toBe("not_asked");
    expect((await mark({ chat: undefined })).status).toBe(400);
    expect((await x.call("POST", "/api/desk/mark", { ...markBody, chat: "scratch is done" }, DESK)).status).toBe(400);
    expect(statusOf().status).toBe("draft");

    const ok = await mark({ chat: "scratch is done" });
    expect(ok.status).toBe(201);
    expect(ok.json.verdict).toBe("accomplished");
    const s = statusOf();
    expect(s.status).toBe("done");
    expect(s.text).toMatch(/Sam via the Team desk: outcome marked accomplished, Status done \(desk chat: "scratch is done, mark it accomplished"\)/);
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("Outcome marked accomplished (Sam, asking the Team desk)");

    // settle / unsettle on his words only
    expect((await settle({ chat: "scratch is done" })).json.error.code).toBe("not_asked"); // his message does not say settle
    await x.call("POST", "/api/desk/messages", { text: "unsettle scratch for now" }, PAGE);
    expect((await settle({ settled: true, chat: "unsettle scratch" })).json.error.code).toBe("not_asked");
    const un = await settle({ settled: false, chat: "unsettle scratch" });
    expect(un.status).toBe(200);
    expect(un.json.settledAt ?? null).toBeNull();
    await x.call("POST", "/api/desk/messages", { text: "ok settle scratch" }, PAGE);
    // his words pass the chat check and reach the settle rule itself (this fixture reads no outcome back: e13s2 covers the 200)
    const st = await settle({ chat: "settle scratch" });
    expect(st.json.error.code).toBe("not_accomplished");
    // the owner's page settle is unchanged
    expect((await x.call("POST", `/api/milestones/${x.m.id}/unsettle`, {}, PAGE)).status).toBe(200);
  });

  it("the desk creates milestones and assignments with its header (acme legacy trust), as Sam does on the page", async () => {
    const x = await boot();
    const m = await x.call("POST", "/api/milestones", { title: "hair_flow", repo: "Acme/hair_flow", path: "docs/spines/root.md", owner: "Sam" }, DESK);
    expect(m.status).toBe(201);
    expect((await x.call("PATCH", `/api/milestones/${m.json.id}`, { paused: true }, DESK)).json.paused).toBe(true);
    const p = await x.call("POST", "/api/personas", { name: "Helper", remit: "helps" }, DESK);
    expect(p.status).toBe(201);
    const a = await x.call("POST", "/api/assignments", { milestoneId: m.json.id, personaId: p.json.id, cadence: { type: "interval", everyMinutes: 60 } }, DESK);
    expect(a.status).toBe(201);
    expect(a.json.enabled).toBe(false);
  });
});
