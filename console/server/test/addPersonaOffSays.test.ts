import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { SEED_VERSION, UPDATE_MARKER, deskSeed, endpointLines } from "../src/desk/desk.js";
import { createRepoIndex, type RepoScan } from "../src/desk/repoIndex.js";
import { createStore } from "../src/store.js";

/** the desk's repo index and the "added, will not be delivered" notice. */

/** the owner writes in the desk chat from the console page (a browser same-origin call). */
const PAGE = { "Sec-Fetch-Site": "same-origin" };
const BASE = "http://console.test";
const PROJECTS = [
  { id: "p_home_repo", title: "home_repo", workspaceRoot: "/x/home_repo", repositoryIdentity: { displayName: "acme/home_repo" } },
  { id: "p_inbox", title: "inbox", workspaceRoot: "/x/inbox", repositoryIdentity: { displayName: "acme/inbox" } },
];
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

class FakeT3 {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, { messages: T3ThreadMessage[] }>();
  private n = 0;
  private pos = 0;
  failSends = false;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  sent = (threadId: string) => this.ops("sendToThread").filter((c) => c.args.threadId === threadId);
  private push(threadId: string, role: "user" | "assistant", text: string) {
    this.threads.get(threadId)!.messages.push({ itemId: `item_${++this.pos}`, position: this.pos * 2, role, text, status: "completed", truncated: false, updatedAt: new Date().toISOString() });
  }
  say = (threadId: string, text: string) => this.push(threadId, "assistant", text);
  async listProjects() {
    return PROJECTS;
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {}
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
    if (this.failSends) throw new Error("T3 busy");
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


const SPINE = `# PLAN-9: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active

## Done means

- [ ] E9-1 It ships

## Issue Ledger

| Issue | Role | Owner | Title | Status |
|---|---|---|---|---|
| T9-S1 | Ticket worker | Builder | First thing | review |
`;

let tmp: string;
let repo: string;
let db: DB;
let t3: FakeT3;
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e41s1-"));
  const origin = path.join(tmp, "origin.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  put(seed, "docs/spines/root.md", SPINE);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "spine"]);
  git(seed, ["push", "-q", "origin", "main"]);
  repo = path.join(tmp, "inbox");
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

const NOW = Date.parse("2026-10-31T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const SCANS: Record<string, ReturnType<RepoScan> extends Promise<infer R> ? R : never> = {
  main: [
    { name: "inbox", remote: "Acme/inbox", last: daysAgo(2), subject: "spine", summary: "Sam's inbox." },
    { name: "old-tool", remote: "Acme/old-tool", last: daysAgo(50), subject: "x", summary: "An old tool." },
  ],
  worker: [
    { name: "inbox", remote: "Acme/inbox", last: daysAgo(1), subject: "newer on worker", summary: "" },
    { name: "ancient", remote: null, last: daysAgo(400), subject: "first", summary: "" },
  ],
};

const boot = (scan?: RepoScan) => {
  const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, {
    read: readCfg,
    cycle: {
      enabled: true,
      t3: t3 as unknown as T3Client,
      dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "claudeAgent_seat1" }), done: async () => {} } as unknown as Dispatcher,
      publicUrl: BASE,
    },
    repoIndex: { scan },
  });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  return { app, call };
};
const DESK = { "X-Console-Run": "team-desk" };

/** A milestone on the inbox spine with a Delivery Manager assignment (enabled as given). */
const open = async (dmEnabled: boolean | undefined, scan?: RepoScan) => {
  const x = boot(scan);
  const m = (await x.call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
  let a: any;
  if (dmEnabled !== undefined) {
    const p = (await x.call("POST", "/api/personas", { name: "Delivery Manager", remit: "deliver", skills: ["epic-spine"], model: "opus" })).json;
    a = (await x.call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 } })).json;
    db.prepare("UPDATE assignments SET enabled = ? WHERE id = ?").run(dmEnabled ? 1 : 0, a.id);
  }
  return { ...x, m, a };
};

describe("E41-3 an Add for a persona that is off says so", () => {
  it("DM off: the desk's Add answers 201 with the notice, and the placement too", async () => {
    const x = await open(false);
    const r = await x.call("POST", `/api/milestones/${x.m.id}/tree/add`, { kind: "row", title: "Desk row" }, DESK);
    expect(r.status).toBe(201);
    expect(r.json.notice).toBe("added, will not be delivered: Delivery Manager is off");
    expect(r.json.delivery).toMatchObject({ delivered: false, persona: "Delivery Manager", assignmentId: x.a.id });
    const p = await x.call("POST", "/api/desk/placements", { repo: "inbox", path: "docs/spines/root.md", kind: "row", itemId: "T9-S1" }, DESK);
    expect(p.status).toBe(201);
    expect(p.json.notice).toBe("added, will not be delivered: Delivery Manager is off");
    // reading only: the assignment stays off
    expect(db.prepare("SELECT enabled FROM assignments WHERE id = ?").get(x.a.id)).toEqual({ enabled: 0 });
  });

  it("DM on: no notice; delivered true", async () => {
    const x = await open(true);
    const r = await x.call("POST", `/api/milestones/${x.m.id}/tree/add`, { kind: "done_means", title: "It is fast" }, DESK);
    expect(r.status).toBe(201);
    expect(r.json.notice).toBeUndefined();
    expect(r.json.delivery).toMatchObject({ delivered: true, persona: "Delivery Manager" });
  });

  it("no DM assigned, or the milestone paused: a notice naming why", async () => {
    const x = await open(undefined);
    const r = await x.call("POST", `/api/milestones/${x.m.id}/tree/add`, { kind: "row", title: "R" }, DESK);
    expect(r.json.notice).toBe("added, will not be delivered: no Delivery Manager is assigned to Inbox");
    const y = await open(true);
    db.prepare("UPDATE milestones SET paused = 1 WHERE id = ?").run(y.m.id);
    expect((await y.call("POST", `/api/milestones/${y.m.id}/tree/add`, { kind: "row", title: "R2" }, DESK)).json.notice).toBe("added, will not be delivered: Inbox is paused");
  });

  it("the desk's endpoint list tells it to say the notice word for word and never to switch a persona itself; seed version moved", () => {
    const text = endpointLines(BASE).join("\n");
    expect(text).toContain("added, will not be delivered: Delivery Manager is off");
    expect(text).toContain("word for word");
    expect(text).toMatch(/Never switch a persona's assignment on or off .* unless Sam asks/);
    expect(SEED_VERSION).toBeGreaterThanOrEqual(8);
  });
});

describe("E41-2 the repo index the desk reads", () => {
  it("joins both hosts and the milestones, groups by last activity, and serves stored rows (no scan on the request)", async () => {
    let scans = 0;
    const scan: RepoScan = async (h) => {
      scans++;
      return SCANS[h];
    };
    const x = await open(false, scan);
    expect((await x.call("GET", "/api/desk/repos")).text).toContain("not scanned yet");
    expect(scans).toBe(0); // the route never scans

    const idx = createRepoIndex({ db, store: createStore(db), scan, publicUrl: BASE, now: () => NOW });
    expect(await idx.refresh()).toEqual([
      { host: "main", repos: 2 },
      { host: "worker", repos: 2 },
    ]);
    const e = idx.entries();
    const inbox = e.find((r) => r.name === "inbox")!;
    expect(inbox).toMatchObject({ hosts: ["main", "worker"], last: daysAgo(1), subject: "newer on worker", summary: "Sam's inbox." });
    expect(inbox.milestones).toEqual([{ id: x.m.id, title: "Inbox", world: "home", link: `${BASE}/milestones/${x.m.id}`, delivery: "Delivery Manager is off" }]);

    const md = idx.markdown();
    const month = md.slice(md.indexOf("## Worked in the last month"), md.indexOf("## Last 3 months"));
    const quarter = md.slice(md.indexOf("## Last 3 months"), md.indexOf("## All time"));
    const older = md.slice(md.indexOf("## All time"));
    expect(month).toContain("**inbox** (Acme/inbox): Sam's inbox. · last activity 2026-10-30 (1 d ago) on main+worker · [Inbox](http://console.test/milestones/");
    expect(month).toContain("Delivery Manager is off");
    expect(quarter).toContain("**old-tool**");
    expect(quarter).toContain("no milestone");
    expect(older).toContain("**ancient**: no README; last commit: first");

    // the app's route reads what the refresh stored
    const served = await x.call("GET", "/api/desk/repos");
    expect(served.status).toBe(200);
    expect(served.text).toContain("**old-tool**");
    const json = (await x.call("GET", "/api/desk/repos?format=json")).json;
    expect(json.repos.map((r: any) => r.name).sort()).toEqual(["ancient", "inbox", "old-tool"]);
    expect(scans).toBe(2);
  });

  it("a host that fails keeps its last rows and the index says so", async () => {
    let fail = false;
    const scan: RepoScan = async (h) => {
      if (fail && h === "worker") throw new Error("ssh to worker failed: unreachable");
      return SCANS[h];
    };
    const idx = createRepoIndex({ db, store: createStore(db), scan, publicUrl: BASE, now: () => NOW });
    await idx.refresh();
    fail = true;
    expect(await idx.refresh()).toEqual([
      { host: "main", repos: 2 },
      { host: "worker", error: "ssh to worker failed: unreachable" },
    ]);
    expect(idx.entries().map((r) => r.name)).toContain("ancient");
    expect(idx.markdown()).toContain("worker scanned 2026-10-31T12:00Z (last try failed: ssh to worker failed: unreachable");
  });

  it("another world's milestone is named only as such (no id, no link)", async () => {
    const x = await open(true);
    db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, owner_handle, owner_name, created_at) VALUES ('social', 'Memo social', 'social', 'j', 'J', ?)").run(new Date().toISOString());
    db.prepare("UPDATE milestones SET tenant_id = 'social' WHERE id = ?").run(x.m.id);
    const idx = createRepoIndex({ db, store: createStore(db), scan: async (h) => SCANS[h], publicUrl: BASE, now: () => NOW });
    await idx.refresh();
    const inbox = idx.entries().find((r) => r.name === "inbox")!;
    expect(inbox.milestones).toEqual([{ title: "another world's milestone (social)", world: "social" }]);
    expect(idx.markdown()).not.toContain(x.m.id);
  });

  it("the desk's seed and update point at the index", async () => {
    const seed = deskSeed({ persona: { name: "Team desk", remit: "r" }, publicUrl: BASE, reposRoot: "/x" });
    expect(seed).toContain(`${BASE}/api/desk/repos`);
    const x = await open(true);
    await x.call("GET", "/api/desk/messages");
    db.prepare("UPDATE desk_session SET seed_version = 7").run();
    await x.call("GET", "/api/desk/messages"); // the next open sends the update (the sweep never does)
    await vi.waitFor(() => expect(t3.sent("thread_1").length).toBeGreaterThan(0));
    const upd = t3.sent("thread_1").find((c) => c.args.message.startsWith(`${UPDATE_MARKER} v${SEED_VERSION}`))!.args.message;
    expect(upd).toContain("/api/desk/repos");
    expect(upd).toContain("added, will not be delivered");
  });

  it("the scanner script: summary, remote, last commit; worktrees skipped", () => {
    const root = path.join(tmp, "root");
    fs.mkdirSync(root);
    const r = path.join(root, "alpha");
    git(tmp, ["clone", "-q", path.join(tmp, "origin.git"), r]);
    put(r, "README.md", "# alpha\n\n[![badge](x)](y)\n\nAlpha does **one** thing\nwell, in two lines.\n\nMore.\n");
    put(r, "AGENTS.md", "Root spine: docs/spines/root.md\n");
    git(r, ["add", "-A"]);
    git(r, ["commit", "-q", "-m", "readme"]);
    // fleet housekeeping after the work: an EpicSpine block, and a commit touching only AGENTS.md: neither counts as activity
    put(r, "docs/x.md", "x\n");
    git(r, ["add", "-A"]);
    git(r, ["commit", "-q", "-m", "chore: EpicSpine repo block"]);
    put(r, "AGENTS.md", "Root spine: docs/spines/root.md\nmore\n");
    git(r, ["commit", "-q", "-am", "pointer line"]);
    git(r, ["worktree", "add", "-q", path.join(root, "alpha-wt"), "-b", "wt"]);
    const out = JSON.parse(execFileSync("python3", ["-I", path.resolve(__dirname, "../scripts/repo_index.py"), JSON.stringify({ root })], { encoding: "utf8" }));
    expect(out.repos).toHaveLength(1);
    expect(out.repos[0]).toMatchObject({ name: "alpha", subject: "readme", summary: "Alpha does one thing well, in two lines." });
    expect(Date.parse(out.repos[0].last)).toBeGreaterThan(Date.now() - 3600_000);
  });
});
