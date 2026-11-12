import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { Milestone } from "../src/store.js";
import { resolveSkillDir, spinesPyRunner } from "../src/adapters/spines.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { createChatScope } from "../src/desk/scope.js";
import { MILESTONE_SEED_VERSION, milestoneEndpointLines } from "../src/desk/milestoneChat.js";

/** a milestone chat acts only from its milestone's epic downward; marks and stamps stay the owner's. */

const PAGE = { "Sec-Fetch-Site": "same-origin" };
const BASE = "http://console.test";
const chatOf = (id: string) => ({ "X-Console-Run": `milestone-chat:${id}` });
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, { messages: T3ThreadMessage[] }>();
  private n = 0;
  private pos = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  private push(threadId: string, role: "user" | "assistant", text: string) {
    this.threads.get(threadId)?.messages.push({ itemId: `item_${++this.pos}`, position: this.pos * 2, role, text, status: "completed", truncated: false, updatedAt: new Date().toISOString() });
  }
  async listProjects() {
    return [{ id: "p_demo", title: "demo", workspaceRoot: "/x/demo", repositoryIdentity: { displayName: "acme/demo" } }];
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
    const threadId = `thread_${++this.n}`;
    this.threads.set(threadId, { messages: [] });
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId, mode } });
    this.push(threadId, "user", message);
  }
  async readThreadStatus() {
    return { status: "running", raw: {} };
  }
  async interruptThread(threadId: string, reason?: string) {
    this.calls.push({ op: "interruptThread", args: { threadId, reason } });
  }
  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    const all = (this.threads.get(threadId)?.messages ?? []).filter((m) => opts.afterPosition === undefined || m.position > opts.afterPosition);
    const page = all.slice(0, opts.limit ?? 100);
    return { messages: page, nextPosition: page.length ? page[page.length - 1].position : (opts.afterPosition ?? null), hasMore: all.length > page.length, archived: false };
  }
}

const spine = (title: string, id: string, parent: string, extra = "", n = 1) => `# ${title}

Spine profile: compact
Spine ID: ${id}
Primary document: docs/spines/${id}.md
Root spine: ${parent === "none" ? "self" : "[demo](root.md)"}
Parent spine: ${parent}
Integration branch: main
Integration policy: main-direct

## Goal

Ship ${title}.

## Current State

Owner: Delivery manager
Status: active
Waiting on: none
Next action: build

${extra}
## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On |
|---|---|---|---|---|---|
| E${n}-S1 | Ticket worker | Builder | First thing | ready | none |

## Decisions

None.
`;
const askIn = (code: string) => `## Waiting on\n\n- [ask ${code}: decide @Sam since 2026-10-20] One logger or two? — options: one | two — recommend: one\n`;

// ---------- the scope rule on its own (no spines.py needed) ----------

describe("T19-S3 scope rule", () => {
  const ms: Record<string, Milestone> = {
    root: { id: "m_root", title: "Root", repo: "demo", path: "docs/spines/root.md" } as Milestone,
    lower: { id: "m_lower", title: "Lower", repo: "demo", path: "docs/spines/lower.md" } as Milestone,
    side: { id: "m_side", title: "Side", repo: "demo", path: "docs/spines/side.md" } as Milestone,
    other: { id: "m_other", title: "Other repo", repo: "other", path: "docs/spines/root.md" } as Milestone,
  };
  const byId = new Map(Object.values(ms).map((m) => [m.id, m]));
  const trees: Record<string, string[]> = {
    m_root: ["docs/spines/root.md", "docs/spines/lower.md", "docs/spines/lower-child.md", "docs/spines/side.md"],
    m_lower: ["docs/spines/lower.md", "docs/spines/lower-child.md"],
    m_side: ["docs/spines/side.md"],
    m_other: ["docs/spines/root.md"],
  };
  const scope = createChatScope({
    store: { getMilestone: (id: string) => byId.get(id) } as any,
    publicUrl: BASE,
    locate: async (m) => ({ repoDir: `/repos/${m.repo}`, rel: m.path }),
    treePaths: async (m) => new Set(trees[m.id]),
  });

  it("covers its own spine, every spine below it and a lower milestone of the same repo", async () => {
    expect(await scope.refusal("m_lower", ms.lower)).toBeUndefined();
    expect(await scope.refusal("m_lower", ms.root, "docs/spines/lower-child.md")).toBeUndefined();
    expect(await scope.refusal("m_root", ms.lower)).toBeUndefined();
    expect(await scope.refusal("m_root", ms.side)).toBeUndefined();
  });

  it("refuses a parent, a sibling, a spine outside the tree and another repo, naming the chat to use", async () => {
    const parent = await scope.refusal("m_lower", ms.root);
    expect(parent).toContain(`the milestone chat of "Root" (${BASE}/milestones/m_root)`);
    expect(parent).toContain("Team desk");
    expect(await scope.refusal("m_lower", ms.side)).toContain('"Side"');
    expect(await scope.refusal("m_lower", ms.root, "docs/spines/side.md")).toBeDefined();
    expect(await scope.refusal("m_root", ms.other)).toContain('"Other repo"');
    expect(await scope.refusal("m_lower", undefined)).toContain(`the Team desk (${BASE}/chat)`);
    expect(await scope.refusal("m_gone", ms.lower)).toContain("Team desk");
  });

  it("the endpoint list opens ask answers (via milestone-chat), says out_of_scope, keeps marks and stamps Sam's; the version moved", () => {
    const lines = milestoneEndpointLines(BASE, { id: "m_lower" }).join("\n");
    expect(MILESTONE_SEED_VERSION).toBeGreaterThanOrEqual(2);
    expect(lines).toContain("/api/waiting-on-owner/<item id>/respond");
    expect(lines).toContain('"via":"milestone-chat"');
    expect(lines).toContain("out_of_scope");
    expect(lines).toContain("stay Sam's own taps");
    expect(lines).not.toContain("/api/desk/stamp");
    expect(lines).not.toContain("not open to this chat yet");
  });
});

// ---------- through the API, on a real spine tree ----------

const skillDir = resolveSkillDir(process.env);

describe.skipIf(!skillDir)("T19-S3 milestone chat verbs through the API", () => {
  let tmp: string;
  let origin: string;
  let repo: string;
  let db: DB;
  let t3: FakeT3;
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e19s3-"));
    origin = path.join(tmp, "origin.git");
    git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = path.join(tmp, "seed");
    git(tmp, ["clone", "-q", origin, seed]);
    git(seed, ["checkout", "-q", "-b", "main"]);
    put(seed, "docs/spines/root.md", spine("PLAN-1: Demo", "root", "none", "", 1).replace("## Issue Ledger", "## Spine Map\n\n| Spine | Status |\n|---|---|\n| [lower](lower.md) | active |\n| [side](side.md) | active |\n\n## Issue Ledger"));
    put(seed, "docs/spines/lower.md", spine("PLAN-2: Lower", "lower", "[demo](root.md)", askIn("T2-A1"), 2));
    put(seed, "docs/spines/side.md", spine("PLAN-3: Side", "side", "[demo](root.md)", askIn("T3-A1"), 3));
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-q", "-m", "seed"]);
    git(seed, ["push", "-q", "origin", "main"]);
    repo = path.join(tmp, "demo");
    git(tmp, ["clone", "-q", origin, repo]);
    db = openDb(path.join(tmp, "console.db"));
    t3 = new FakeT3();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const boot = async () => {
    const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [], skillDir, spines: spinesPyRunner(skillDir!) };
    const app = createApp(db, {
      read,
      cycle: {
        enabled: true,
        t3,
        dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "claudeAgent_seat1" }), done: async () => {} } as unknown as Dispatcher,
        publicUrl: BASE,
        seatsFile: path.join(tmp, "seats.json"),
        runState: async () => undefined,
      },
    });
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    const builder = (await call("POST", "/api/personas", { name: "Builder", remit: "You build.", model: "sonnet" })).json;
    const mk = async (title: string, p: string) => {
      const m = (await call("POST", "/api/milestones", { title, repo: "Acme/demo", path: p })).json;
      const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: builder.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false })).json;
      return { m, a };
    };
    const root = await mk("Root", "docs/spines/root.md");
    const lower = await mk("Lower", "docs/spines/lower.md");
    const side = await mk("Side", "docs/spines/side.md");
    return { call, root, lower, side };
  };

  it("Run now, Steer and Stop: in scope for its own and lower milestones; 403 out_of_scope for a sibling and a parent", async () => {
    const x = await boot();
    const L = chatOf(x.lower.m.id);
    const ok = await x.call("POST", `/api/assignments/${x.lower.a.id}/run-now`, { note: "check" }, L);
    expect(ok.status).toBe(201);
    for (const target of [x.side, x.root]) {
      const r = await x.call("POST", `/api/assignments/${target.a.id}/run-now`, {}, L);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("out_of_scope");
      expect(r.json.error.message).toContain(`${BASE}/milestones/${target.m.id}`);
      expect((await x.call("POST", `/api/assignments/${target.a.id}/steer`, { message: "hi" }, L)).status).toBe(403);
    }
    // the root milestone's chat reaches a lower milestone's persona
    const fromRoot = await x.call("POST", `/api/assignments/${x.side.a.id}/run-now`, {}, chatOf(x.root.m.id));
    expect(fromRoot.status).toBe(201);
    // by run id: the side run is out of scope for Lower, its own run is not
    const sideStop = await x.call("POST", `/api/runs/${fromRoot.json.id}/stop`, { reason: "no" }, L);
    expect(sideStop.status).toBe(403);
    expect(sideStop.json.error.code).toBe("out_of_scope");
    expect((await x.call("POST", `/api/runs/${fromRoot.json.id}/steer`, { message: "x" }, L)).status).toBe(403);
    expect((await x.call("POST", `/api/runs/${ok.json.id}/steer`, { message: "go on" }, L)).status).not.toBe(403);
    expect((await x.call("POST", `/api/runs/${ok.json.id}/stop`, { reason: "Sam said stop" }, L)).status).toBe(200);
    // other callers are untouched (the owner's page, the Team desk)
    expect((await x.call("POST", `/api/runs/${fromRoot.json.id}/stop`, { reason: "Sam" }, PAGE)).status).toBe(200);
    expect((await x.call("POST", `/api/assignments/${x.root.a.id}/run-now`, {}, { "X-Console-Run": "team-desk" })).status).toBe(201);
    // an unknown target still answers the route's own 404
    expect((await x.call("POST", `/api/assignments/nope/run-now`, {}, L)).status).toBe(404);
  });

  it("Add: on its own spine (also through a parent milestone's tree), refused on a sibling or the parent's spine", async () => {
    const x = await boot();
    const L = chatOf(x.lower.m.id);
    const add = (mid: string, body: object) => x.call("POST", `/api/milestones/${mid}/tree/add`, { kind: "row", title: "Idea", line: "one line", ...body }, L);
    expect((await add(x.lower.m.id, {})).status).toBe(201);
    const viaRoot = await add(x.root.m.id, { path: "docs/spines/lower.md", title: "Second idea" });
    expect(viaRoot.status, JSON.stringify(viaRoot.json)).toBe(201);
    for (const [mid, body] of [[x.side.m.id, {}], [x.root.m.id, {}], [x.root.m.id, { path: "docs/spines/side.md" }]] as const) {
      const r = await add(mid, body);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("out_of_scope");
    }
  });

  it("answers an ask in its subtree with Sam's words from ITS thread; a sibling's ask is out of scope; words from another chat do not count", async () => {
    const x = await boot();
    const L = chatOf(x.lower.m.id);
    const items = (await x.call("GET", `/api/waiting-on-owner?milestoneId=${x.root.m.id}`)).json as any[];
    const mine = items.find((i) => i.code === "T2-A1");
    const sibling = items.find((i) => i.code === "T3-A1");
    expect(mine && sibling).toBeTruthy();
    const respond = (item: any, body: object, h: Record<string, string> = L) => x.call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "answer", text: "two", milestoneId: x.root.m.id, ...body }, h);

    // the owner said it in the SIDE chat, not the lower one
    expect((await x.call("POST", `/api/milestones/${x.side.m.id}/chat/messages`, { text: "go with two" }, PAGE)).status).toBeLessThan(300);
    const notHere = await respond(mine, { via: "milestone-chat", chat: "go with two" });
    expect(notHere.status).toBe(409);
    expect(notHere.json.error.code).toBe("not_in_chat");

    const out = await respond(sibling, { via: "milestone-chat", chat: "go with two" });
    expect(out.status).toBe(403);
    expect(out.json.error.code).toBe("out_of_scope");
    expect(out.json.error.message).toContain('"Lower"');

    expect((await respond(mine, {})).status).toBe(400); // a chat call must say via + chat
    expect((await respond(mine, { via: "team-desk", chat: "go with two" })).status).toBe(400); // not the desk
    expect((await respond(mine, { via: "milestone-chat", chat: "go with two" }, {})).status).toBe(403); // via without the chat header

    await x.call("POST", `/api/milestones/${x.lower.m.id}/chat/messages`, { text: "For the logger, go with two" }, PAGE);
    const r = await respond(mine, { via: "milestone-chat", chat: "go with two" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ via: "milestone-chat", chat: "go with two", spine: { status: "written" } });
    git(repo, ["pull", "-q", "--ff-only"]);
    const line = fs.readFileSync(path.join(repo, "docs/spines/lower.md"), "utf8").split("\n").find((l) => l.includes("[answered T2-A1"))!;
    expect(line).toMatch(/— answer: two \(by Sam via milestone chat\)$/);
    expect(fs.readFileSync(path.join(repo, "docs/spines/side.md"), "utf8")).toContain("[ask T3-A1");
  });

  it("marks and stamps stay Sam's: refused from a milestone chat, even on its own milestone and with a page header", async () => {
    const x = await boot();
    const head = git(origin, ["rev-parse", "main"]);
    const L = { ...chatOf(x.lower.m.id), ...PAGE };
    const mark = await x.call("POST", `/api/milestones/${x.lower.m.id}/mark`, { outcome: "done" }, L);
    expect(mark.status).toBe(403);
    expect(mark.json.error.code).toBe("jordi_only");
    const stamp = await x.call("POST", `/api/milestones/${x.lower.m.id}/stamp`, { to: "ready" }, L);
    expect(stamp.status).toBe(403);
    await x.call("POST", `/api/milestones/${x.lower.m.id}/chat/messages`, { text: "please mark it ready" }, PAGE);
    const desk = await x.call("POST", "/api/desk/stamp", { milestoneId: x.lower.m.id, to: "ready", chat: "please mark it ready" }, L);
    expect(desk.status).toBe(403);
    expect(desk.json.error.code).toBe("desk_only");
    expect(git(origin, ["rev-parse", "main"])).toBe(head);
  });
});
