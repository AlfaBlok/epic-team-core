import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { createDesk, migrateDesk } from "../src/desk/desk.js";
import { TAIL_WINDOW, viewOpts } from "../src/desk/session.js";

// a chat read never waits on T3 past a short budget (the last good view answers, from
// memory or desk_view_cache after a restart), a long thread is read from its tail, and older messages come page by page.
const PAGE = { "Sec-Fetch-Site": "same-origin" };
const BASE = "http://127.0.0.1:18799";
const PROJECTS = [{ id: "p_home_repo", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo", repositoryIdentity: { displayName: "acme/home_repo" } }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A T3 whose threads have tool items between messages (positions skip, as on the main server: 875 items, ~0.4 messages per item). */
class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, { messages: T3ThreadMessage[]; status: string; items: number }>();
  /** Delay of every read (a slow T3). */
  delayMs = 0;
  private n = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  push(threadId: string, role: "user" | "assistant", text: string, status = "completed") {
    const t = this.threads.get(threadId)!;
    const position = t.items;
    t.items += role === "assistant" ? 3 : 1; // a reply comes with two tool items
    t.messages.push({ itemId: `item_${threadId}_${position}`, position, role, text, status, truncated: false, updatedAt: new Date().toISOString() });
  }
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
  async launchThread(input: { projectId: string; title: string; message?: string }) {
    this.calls.push({ op: "launchThread", args: input });
    const threadId = `desk_thread_${++this.n}`;
    this.threads.set(threadId, { messages: [], status: "idle", items: 0 });
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message } });
    if (this.delayMs) await sleep(this.delayMs);
    this.push(threadId, "user", message);
  }
  async readThreadStatus(threadId: string) {
    this.calls.push({ op: "readThreadStatus", args: { threadId } });
    if (this.delayMs) await sleep(this.delayMs);
    const t = this.threads.get(threadId)!;
    return { status: t.status, raw: { itemCount: t.items } };
  }
  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    this.calls.push({ op: "readThreadMessages", args: { threadId, ...opts } });
    if (this.delayMs) await sleep(this.delayMs);
    const all = (this.threads.get(threadId)?.messages ?? []).filter((m) => opts.afterPosition === undefined || m.position > opts.afterPosition);
    const page = all.slice(0, opts.limit ?? 100);
    return { messages: page, nextPosition: page.length ? page[page.length - 1].position : (opts.afterPosition ?? null), hasMore: all.length > page.length, archived: false };
  }
}

class FakeDispatcher implements Dispatcher {
  async pick() {
    return { seat: "seat2", providerInstanceId: "claudeAgent_seat2" };
  }
  async done() {}
}

let dir: string;
let db: DB;
let t3: FakeT3;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e33s10-"));
  db = openDb(path.join(dir, "console.db"));
  t3 = new FakeT3();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const deskOf = (o: { viewBudgetMs?: number } = {}) => {
  migrateDesk(db);
  return createDesk({ db, store: createStore(db), t3, dispatcher: new FakeDispatcher(), publicUrl: BASE, reposRoot: dir, ...o });
};
/** A desk whose thread holds `n` exchanges (the owner asks, the desk answers), as a fresh console process would find it. */
async function longThread(n: number) {
  const first = deskOf();
  await first.view();
  const tid = first.current()!.threadId;
  for (let i = 1; i <= n; i++) {
    t3.push(tid, "user", `question ${i}`);
    t3.push(tid, "assistant", `answer ${i}`);
  }
  return tid;
}

describe("T33-S10 a long thread is read from its tail", () => {
  it("the first read of a 600-message thread starts TAIL_WINDOW items from its end and says older ones exist", async () => {
    const tid = await longThread(300);
    const items = t3.threads.get(tid)!.items;
    db.prepare("DELETE FROM desk_view_cache").run(); // no cached view: this read must go to T3
    const desk = deskOf(); // a restarted console: empty cache
    t3.calls = [];
    const v = await desk.view({ limit: 30 });
    const reads = t3.ops("readThreadMessages");
    expect(reads[0].args.afterPosition).toBe(items - TAIL_WINDOW - 1);
    expect(reads.length).toBeLessThanOrEqual(2); // not the 6 pages a read from position 0 takes
    expect(v.messages).toHaveLength(30);
    expect(v.messages.at(-1)!.text).toBe("answer 300");
    expect(v.hasEarlier).toBe(true);
    expect(v.messages.every((m) => typeof m.position === "number")).toBe(true);
  });

  it("older pages come back in order, without gaps or repeats, down to the chat's start", async () => {
    await longThread(300);
    db.prepare("DELETE FROM desk_view_cache").run();
    const desk = deskOf();
    const v = await desk.view({ limit: 30 });
    const seen = [...v.messages];
    let before = v.messages[0].position!;
    let more = v.hasEarlier;
    let pages = 0;
    while (more && pages++ < 40) {
      const page = await desk.earlier(before, 30);
      expect(page.messages.length).toBeGreaterThan(0);
      expect(page.messages.every((m) => m.position! < before)).toBe(true);
      seen.unshift(...page.messages);
      before = page.messages[0].position!;
      more = page.hasEarlier;
    }
    const texts = seen.filter((m) => m.kind === "message").map((m) => m.text);
    expect(texts).toHaveLength(600);
    expect(texts[0]).toBe("question 1");
    expect(new Set(seen.map((m) => m.id)).size).toBe(seen.length);
    expect(seen[0].kind).toBe("seed"); // the "Chat started" divider is the very first line
  });

  it("the unread pill and the team repo copy still read the whole thread", async () => {
    await longThread(300);
    db.prepare("DELETE FROM desk_view_cache").run();
    const desk = deskOf();
    await desk.view({ limit: 30 }); // tail only
    const all = await desk.transcript();
    expect(all.filter((m) => m.kind === "message")).toHaveLength(600);
    const r = await desk.replyTimes();
    expect(r!.replies).toHaveLength(300);
  });
});

describe("T33-S10 a chat open never waits on a slow T3", () => {
  it("past the budget the last good view answers (stale), and the next read has the live one", async () => {
    const desk = deskOf({ viewBudgetMs: 30 });
    await desk.view();
    const tid = desk.current()!.threadId;
    t3.push(tid, "assistant", "new reply");
    t3.delayMs = 200;
    const t0 = Date.now();
    const v = await desk.view();
    expect(Date.now() - t0).toBeLessThan(150);
    expect(v.stale).toBe(true);
    expect(v.messages.some((m) => m.text === "new reply")).toBe(false);
    await sleep(700); // the live read lands
    t3.delayMs = 0;
    const next = await desk.view();
    expect(next.stale).toBeUndefined();
    expect(next.messages.at(-1)!.text).toBe("new reply");
  });

  it("a restarted console answers the first open from desk_view_cache, then reads T3 in the background", async () => {
    await longThread(50);
    const warm = deskOf();
    await warm.view(); // writes the cache row
    expect(db.prepare("SELECT COUNT(*) n FROM desk_view_cache").get()).toEqual({ n: 1 });
    t3.delayMs = 200;
    const restarted = deskOf({ viewBudgetMs: 30 });
    const t0 = Date.now();
    const v = await restarted.view({ limit: 30 });
    expect(Date.now() - t0).toBeLessThan(150);
    expect(v.stale).toBe(true);
    expect(v.messages).toHaveLength(30);
    expect(v.messages.at(-1)!.text).toBe("answer 50");
  });

  it("a cached view of an ended thread is never shown", async () => {
    await longThread(5);
    deskOf();
    await deskOf().view();
    db.prepare("UPDATE desk_view_cache SET thread_id = 'old_thread'").run();
    t3.delayMs = 100;
    const v = await deskOf({ viewBudgetMs: 10 }).view();
    expect(v.stale).toBeUndefined(); // waited for T3 instead
    expect(v.threadId).toBe("desk_thread_1");
  });

  it("right after Sam's send the view waits for T3, so his message shows", async () => {
    const desk = deskOf({ viewBudgetMs: 10 });
    await desk.view();
    t3.delayMs = 60;
    await desk.send("hello desk");
    const v = await desk.view();
    expect(v.stale).toBeUndefined();
    expect(v.messages.at(-1)!.text).toBe("hello desk");
  });

  it("concurrent opens share one live read", async () => {
    const desk = deskOf();
    await desk.view();
    t3.calls = [];
    await Promise.all([desk.view(), desk.view(), desk.view({ limit: 30 })]);
    expect(t3.ops("readThreadStatus")).toHaveLength(1);
  });
});

describe("T33-S10 the routes take ?limit and ?before", () => {
  it("GET /api/desk/messages?limit=30 then ?before=<oldest>", async () => {
    await longThread(100);
    const app = createApp(db, { cycle: { enabled: true, t3, dispatcher: new FakeDispatcher(), publicUrl: BASE, runState: async () => undefined } });
    const get = async (u: string) => (await app.request(u, { headers: PAGE })).json();
    const v = await get("/api/desk/messages?limit=30");
    expect(v.messages).toHaveLength(30);
    expect(v.hasEarlier).toBe(true);
    const older = await get(`/api/desk/messages?limit=30&before=${v.messages[0].position}`);
    expect(older.messages).toHaveLength(30);
    expect(older.messages.at(-1).position).toBeLessThan(v.messages[0].position);
    const plain = await get("/api/desk/messages");
    expect(plain.messages.length).toBeGreaterThan(30); // no limit: the old tail of up to 120
  });

  it("viewOpts reads only plain numbers", () => {
    const q = (o: Record<string, string>) => (n: string) => o[n];
    expect(viewOpts(q({ limit: "30", before: "0" }))).toEqual({ limit: 30, before: 0 });
    // an earlier session's positions are negative (historyPosition), so `before` may be; `limit` stays plain
    expect(viewOpts(q({ limit: "x", before: "-1" }))).toEqual({ before: -1 });
    expect(viewOpts(q({ limit: "-5", before: "1.5" }))).toEqual({});
    expect(viewOpts(q({}))).toEqual({});
  });
});

describe("T33-S10 claims read only the running child runs", () => {
  it("listRunningChildRuns returns a milestone's running child runs and nothing else", () => {
    const store = createStore(db);
    const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
    const other = store.createMilestone({ title: "N", repo: "home_repo", path: "docs/other.md", owner: "", paused: false });
    const p = store.createPersona({ name: "DM", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
    const b = store.createAssignment({ milestoneId: other.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
    const wake = store.createRun({ assignmentId: a.id, outcome: "running", summary: "wake" });
    const kid = store.createRun({ assignmentId: a.id, parentRunId: wake.id, outcome: "running", summary: "T1-S1 worker" });
    store.createRun({ assignmentId: a.id, parentRunId: wake.id, outcome: "progressed", summary: "T1-S2 worker", endedAt: new Date().toISOString() });
    store.createRun({ assignmentId: b.id, parentRunId: wake.id, outcome: "running", summary: "T2-S1 worker" });
    expect(store.listRunningChildRuns(m.id).map((r) => r.id)).toEqual([kid.id]);
  });
});

describe("T33-S10 the app's files are cached and compressed", () => {
  it("hashed assets are immutable and gzipped, index.html is revalidated with an ETag", async () => {
    const dist = path.join(dir, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), `<!doctype html><script src="/assets/index-abc.js"></script>${"<!-- pad -->".repeat(200)}`);
    fs.writeFileSync(path.join(dist, "assets", "index-abc.js"), "console.log('app');\n".repeat(5000));
    const app = createApp(db, { staticDir: dist });
    const js = await app.request("/assets/index-abc.js", { headers: { "Accept-Encoding": "gzip, br" } });
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("content-encoding")).toBe("gzip");
    expect((await js.arrayBuffer()).byteLength).toBeLessThan(5000);
    const plain = await app.request("/assets/index-abc.js");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect((await plain.text()).length).toBe(100000);
    const page = await app.request("/chat", { headers: { "Accept-Encoding": "gzip" } });
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const etag = page.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect((await app.request("/chat", { headers: { "If-None-Match": etag } })).status).toBe(304);
  });

  it("the chat read is gzipped for a browser that takes it", async () => {
    await longThread(40);
    const app = createApp(db, { cycle: { enabled: true, t3, dispatcher: new FakeDispatcher(), publicUrl: BASE, runState: async () => undefined } });
    const res = await app.request("/api/desk/messages?limit=30", { headers: { ...PAGE, "Accept-Encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });
});

describe("T33-S10 HEAD and upstream read from .git, no git child", () => {
  it("matches git for loose refs, packed refs and a detached HEAD, and is undefined for a worktree", async () => {
    const { execFileSync } = await import("node:child_process");
    const { headSha, upstreamSha } = await import("../src/gitRefs.js");
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
    const origin = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    g(dir, "init", "-q", "--bare", "-b", "main", origin);
    g(dir, "clone", "-q", origin, repo);
    for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) g(repo, "config", k, v);
    fs.writeFileSync(path.join(repo, "a.md"), "a\n");
    g(repo, "add", ".");
    g(repo, "commit", "-qm", "a");
    g(repo, "push", "-q", "origin", "HEAD:main");
    g(repo, "fetch", "-q");
    expect(headSha(repo)).toBe(g(repo, "rev-parse", "HEAD"));
    expect(upstreamSha(repo)).toBe(g(repo, "rev-parse", "origin/main"));
    g(repo, "pack-refs", "--all");
    expect(headSha(repo)).toBe(g(repo, "rev-parse", "HEAD"));
    expect(upstreamSha(repo)).toBe(g(repo, "rev-parse", "origin/main"));
    fs.writeFileSync(path.join(repo, "b.md"), "b\n");
    g(repo, "add", ".");
    g(repo, "commit", "-qm", "b");
    expect(headSha(repo)).toBe(g(repo, "rev-parse", "HEAD"));
    expect(upstreamSha(repo)).not.toBe(headSha(repo));
    g(repo, "checkout", "-q", "--detach", "HEAD~1");
    expect(headSha(repo)).toBe(g(repo, "rev-parse", "HEAD"));
    expect(upstreamSha(repo)).toBeUndefined();
    const wt = path.join(dir, "wt");
    g(repo, "worktree", "add", "-q", wt, "main");
    expect(headSha(wt)).toBeUndefined(); // a worktree's.git is a file: the caller asks git
    expect(headSha(path.join(dir, "nope"))).toBeUndefined();
  });
});
