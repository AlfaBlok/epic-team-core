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
import { DELIVERED_MARKER, doneMeansLine, ledgerRow, readPlacement } from "../src/desk/placements.js";
import { SEED_VERSION, UPDATE_MARKER, endpointLines } from "../src/desk/desk.js";
import { createStore } from "../src/store.js";

/** the desk's seed update, answers from chat through the ask path, delivered notes. */

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

const A1 = "- [ask T9-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md";
const spine = (asks: string[]) => `# PLAN-9: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam (see Waiting on)

## Done means

- [ ] E9-1 It ships
- [ ] E9-2 It is fast

## Waiting on

${asks.join("\n")}

## Issue Ledger

| Issue | Role | Owner | Title | Status |
|---|---|---|---|---|
| T9-S1 | Ticket worker | Builder | First thing | review |
| T4 | Ticket worker | Builder | Pick the logger layout | blocked |
`;
const CHILD = `# PLAN-20: A child idea

Spine ID: child-idea
Integration policy: main-direct

## Current State

Status: draft

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| T20-S1 | Do it | draft |
`;

let tmp: string;
let repo: string;
let db: DB;
let t3: FakeT3;
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s4s6-"));
  const origin = path.join(tmp, "origin.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  put(seed, "docs/spines/root.md", spine([A1]));
  put(seed, "docs/spines/notes.md", "# notes\n");
  put(seed, "docs/spines/child.md", CHILD);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "asks"]);
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

/** A console process on the shared db (a second one = a restart). */
const boot = () => {
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
  return { app, call };
};
const DESK = { "X-Console-Run": "team-desk" };

describe("T18-S4 the desk learns the new endpoint list once per seed version", () => {
  it("a thread seeded at an older version gets ONE update message with the list; restarts and repeated opens send no second", async () => {
    const a = boot();
    await a.call("GET", "/api/desk/messages"); // launches the thread (seeded at the current version)
    expect(t3.ops("launchThread")).toHaveLength(1);
    expect(db.prepare("SELECT seed_version v FROM desk_session").get()).toEqual({ v: SEED_VERSION });
    await a.call("POST", "/api/desk/sweep");
    expect(t3.sent("thread_1")).toHaveLength(0); // a fresh thread already has the current list

    // The live the main server thread was seeded by S1/S2 (version 1, column absent then).
    db.prepare("UPDATE desk_session SET seed_version = NULL").run();
    await Promise.all([a.call("GET", "/api/desk/messages"), a.call("GET", "/api/desk/messages"), a.call("POST", "/api/desk/sweep"), a.call("POST", "/api/desk/sweep")]);
    await vi.waitFor(() => expect(t3.sent("thread_1")).toHaveLength(1));
    const upd = t3.sent("thread_1")[0].args;
    expect(upd.message.startsWith(`${UPDATE_MARKER} v${SEED_VERSION}`)).toBe(true);
    for (const ep of ["/api/runs/<run id>/stop", "/api/runs/<run id>/steer", "/tree/add", "/api/waiting-on-owner/<item id>/respond", "/api/desk/placements", "/api/desk/links", "/api/tickets/session"])
      expect(upd.message).toContain(ep);
    expect(upd).toMatchObject({ threadId: "thread_1", mode: "auto", clientRequestId: `desk-seed-v${SEED_VERSION}-s1` });
    expect(db.prepare("SELECT seed_version v FROM desk_session").get()).toEqual({ v: SEED_VERSION });

    // restart + more opens + sweeps: never again for this version
    const b = boot();
    await b.call("GET", "/api/desk/messages");
    await b.call("POST", "/api/desk/sweep");
    await b.call("POST", "/api/desk/messages", { text: "hello" }, PAGE);
    expect(t3.sent("thread_1").filter((c) => c.args.message.startsWith(UPDATE_MARKER))).toHaveLength(1);
    expect(t3.ops("launchThread")).toHaveLength(1); // no relaunch
  });

  it("his send to a thread behind the version takes the update first, then his message (an update beside his turn met a busy thread)", async () => {
    const a = boot();
    await a.call("GET", "/api/desk/messages");
    db.prepare("UPDATE desk_session SET seed_version = NULL").run();
    await a.call("POST", "/api/desk/messages", { text: "file the dispatcher fix" }, PAGE);
    await vi.waitFor(() => expect(t3.sent("thread_1").length).toBeGreaterThanOrEqual(2));
    const msgs = t3.sent("thread_1").map((c) => c.args.message as string);
    const upd = msgs.findIndex((m) => m.startsWith(UPDATE_MARKER));
    const his = msgs.findIndex((m) => m.includes("file the dispatcher fix"));
    expect(upd).toBeGreaterThanOrEqual(0);
    expect(upd).toBeLessThan(his);
    expect(msgs.filter((m) => m.startsWith(UPDATE_MARKER))).toHaveLength(1);
    expect(db.prepare("SELECT seed_version v FROM desk_session").get()).toEqual({ v: SEED_VERSION });
  });

  it("a failed send is retried by the next open, then recorded once (T6-S74: the sweep never sends it)", async () => {
    const a = boot();
    const open = async () => {
      await a.call("GET", "/api/desk/messages");
      await new Promise((r) => setTimeout(r, 20)); // the update goes out in the background of the read
    };
    await a.call("GET", "/api/desk/messages");
    db.prepare("UPDATE desk_session SET seed_version = NULL").run();
    await a.call("POST", "/api/desk/sweep");
    expect(t3.sent("thread_1").filter((c) => c.args.message.startsWith(UPDATE_MARKER))).toHaveLength(0);
    t3.failSends = true;
    await open();
    expect(db.prepare("SELECT seed_version v FROM desk_session").get()).toEqual({ v: null });
    t3.failSends = false;
    await open();
    await open();
    expect(db.prepare("SELECT seed_version v FROM desk_session").get()).toEqual({ v: SEED_VERSION });
    expect(t3.sent("thread_1").filter((c) => c.args.message.startsWith(UPDATE_MARKER))).toHaveLength(2); // 1 failed attempt + 1 accepted
  });

  it("the chat never shows the update or the desk's 'Updated.' reply; a real reply after it stays", async () => {
    const a = boot();
    await a.call("GET", "/api/desk/messages");
    db.prepare("UPDATE desk_session SET seed_version = NULL").run();
    await a.call("GET", "/api/desk/messages");
    await new Promise((r) => setTimeout(r, 20));
    t3.say("thread_1", "Updated.");
    await a.call("POST", "/api/desk/messages", { text: "what is next?" }, PAGE);
    t3.say("thread_1", "Updated. Next is X.");
    const v = (await a.call("GET", "/api/desk/messages")).json;
    expect(v.messages.map((m: any) => [m.role, m.kind, m.text])).toEqual([
      ["user", "seed", ""],
      ["user", "message", "what is next?"],
      ["assistant", "message", "Updated. Next is X."],
    ]);
  });

  it("the seed carries the same list and the S5 pointer line", async () => {
    await boot().call("GET", "/api/desk/messages");
    const seed: string = t3.ops("launchThread")[0].args.message;
    for (const line of endpointLines(BASE)) expect(seed).toContain(line);
    expect(seed).toContain("/api/tickets/session");
  });
});

describe("T18-S4 an ask answered from the chat goes through the ask path", () => {
  const setup = async () => {
    const x = boot();
    const m = (await x.call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const dmP = (await x.call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
    const dm = (await x.call("POST", "/api/assignments", { milestoneId: m.id, personaId: dmP.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    await x.call("POST", "/api/runs", { assignmentId: dm.id, outcome: "progressed", startedAt: "2026-10-20T09:55:00.000Z", endedAt: "2026-10-20T10:01:00.000Z" });
    await x.call("GET", "/api/desk/messages"); // desk thread_1
    const item = ((await x.call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "T9-A1");
    return { ...x, m, dm, item };
  };
  const respond = (x: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>, headers: Record<string, string> = DESK) =>
    x.call("POST", `/api/waiting-on-owner/${x.item.id}/respond`, { kind: "answer", text: "two", milestoneId: x.m.id, ...body }, headers);

  it("writes `by Sam via Team desk` + Sam's chat words in the commit, and wakes the asker (PLAN-15)", async () => {
    const x = await setup();
    await x.call("POST", "/api/desk/messages", { text: "For the logger, go with two please", page: "Inbox · Milestone" }, PAGE);
    const r = await respond(x, { via: "team-desk", chat: "go with two" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ via: "team-desk", chat: "go with two", spine: { status: "written" }, wake: { notified: "woken", persona: "Delivery Manager", assignmentId: x.dm.id } });
    git(repo, ["pull", "-q", "--ff-only"]);
    const line = fs.readFileSync(path.join(repo, "docs/spines/root.md"), "utf8").split("\n").find((l) => l.includes("[answered T9-A1"))!;
    expect(line).toMatch(/^- \[answered T9-A1 \d{4}-\d\d-\d\d @Sam\] .*— answer: two \(by Sam via Team desk\)$/);
    expect(git(repo, ["log", "-1", "--format=%s%n%b"])).toContain("(Sam, via Team desk)");
    expect(git(repo, ["log", "-1", "--format=%b"])).toContain("Sam gave it in the Team desk chat: go with two");
    // the asker was woken with the answer, through the same notifier as the web card
    const run = ((await x.call("GET", `/api/runs?assignmentId=${x.dm.id}`)).json as any[]).find((y) => y.id === r.json.wake.runId);
    expect(run).toMatchObject({ outcome: "running", instructionsBy: "Sam" });
    expect(run.instructions).toContain('Sam answered T9-A1 (inbox/docs/spines/root.md): "two"');
    expect(t3.ops("launchThread").filter((c) => c.args.projectId === "p_inbox")).toHaveLength(1);
  });

  it("never a desk-authored answer: words that are not in Sam's chat are refused and nothing is written", async () => {
    const x = await setup();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const r = await respond(x, { via: "team-desk", chat: "go with two" }); // the owner said nothing yet
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("not_in_chat");
    // the desk's own text and the console's plumbing messages do not count as the owner's words
    t3.say("thread_1", "I think go with two is best");
    expect((await respond(x, { via: "team-desk", chat: "go with two" })).status).toBe(409);
    expect((await respond(x, { via: "team-desk", chat: "You are Team desk" })).status).toBe(409); // the seed is console plumbing, not his words
    git(repo, ["fetch", "-q"]);
    expect(git(repo, ["rev-parse", "origin/main"])).toBe(head);
    expect(db.prepare("SELECT COUNT(*) n FROM jordi_responses").get()).toEqual({ n: 0 });
  });

  it("his voice-note transcript in the desk counts exactly like typed words (punctuation, case and a cut middle aside)", async () => {
    const x = await setup();
    const note = [
      "🎙 Voice note (Chat), 2026-11-12 23:03Z · 1 min 23 s · $0.0035 (gpt-4o-mini-transcribe) · vn_1",
      "Audio: https://example.test/voice/notes/vn_1/audio",
      "",
      "I mean, for me, if you, yes, for me. The logger? But generally, just go for it — two. I'll take a look, then feedback.",
    ].join("\n");
    await x.call("POST", "/api/desk/messages", { text: note, page: "voice note to Memory" }, PAGE);
    // the desk quotes him with the punctuation dropped and a middle part left out: still his words, in one message, in order
    const r = await respond(x, { via: "team-desk", chat: "if you yes for me [...] just go for it - two" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ via: "team-desk", spine: { status: "written" } });
  });

  it("a cut quote still needs every part in his words, in order, in one message", async () => {
    const x = await setup();
    await x.call("POST", "/api/desk/messages", { text: "🎙 Voice note (Chat) · vn_1\n\nJust go for it. Two." }, PAGE);
    expect((await respond(x, { via: "team-desk", chat: "two [...] just go for it" })).status).toBe(409); // out of order
    expect((await respond(x, { via: "team-desk", chat: "just go for it [...] three" })).status).toBe(409); // a part he never said
    expect((await respond(x, { via: "team-desk", chat: "[...]" })).status).toBe(409); // no words at all
  });

  it("a world's own desk (the social skin) registers his voice-note answer against ITS thread, never the Team desk's", async () => {
    const x = boot();
    const W = "social-world";
    db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'internal', ?)").run(W, W, new Date().toISOString());
    const m = createStore(db, { tenant: W }).createMilestone({ title: "Testers", repo: "Acme/inbox", path: "docs/spines/root.md", owner: "Sam", paused: false });
    await x.call("GET", `/api/tenants/${W}/desk/messages`); // the world desk's thread
    const item = ((await x.call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "T9-A1");
    expect(item).toBeTruthy();
    const WD = { "X-Console-Run": `world-desk:${W}` };
    const answer = (chat: string, headers: Record<string, string>) =>
      x.call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "answer", text: "two", milestoneId: m.id, via: "team-desk", chat }, headers);
    const said = "but generally, just go for it, two. I'll take a look";
    // his words are in the HOME Team desk only: the world desk cannot use them
    await x.call("GET", "/api/desk/messages");
    await x.call("POST", "/api/desk/messages", { text: said }, PAGE);
    expect((await answer("just go for it, two", WD)).json.error?.code).toBe("not_in_chat");
    // his voice note in the world desk (the Chat mic posts its transcript there): it counts, from the world desk's own header
    const note = `🎙 Voice note (Chat), 2026-11-12 23:03Z · 1 min 23 s · vn_1\nAudio: https://example.test/a\n\nI mean, yes. ${said}, you know.`;
    expect((await x.call("POST", `/api/tenants/${W}/desk/messages`, { text: note, page: "voice note to Memory" }, PAGE)).status).toBeLessThan(300);
    const r = await answer("I mean yes [...] just go for it - two", WD);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ via: "team-desk", spine: { status: "written" } });
  });

  it("the desk must say via + chat; via is only for the desk's own calls; the web card path is unchanged", async () => {
    const x = await setup();
    await x.call("POST", "/api/desk/messages", { text: "two" }, PAGE);
    expect((await respond(x, {}, DESK)).status).toBe(400); // desk call without via / chat
    expect((await respond(x, { via: "team-desk" }, DESK)).status).toBe(400); // via without his words
    expect((await respond(x, { via: "team-desk", chat: "two" }, {})).status).toBe(403); // not the desk's header
    expect((await respond(x, { via: "team-desk", chat: "two" }, { "X-Console-Run": "someone-else" })).status).toBe(403);
    // the owner's own card: no via, no chat, the line carries no desk note
    const ok = await respond(x, {}, {});
    expect(ok.status).toBe(201);
    expect(ok.json.via).toBeUndefined();
    git(repo, ["pull", "-q", "--ff-only"]);
    expect(fs.readFileSync(path.join(repo, "docs/spines/root.md"), "utf8")).toMatch(/— answer: two\n/);
  });
});

describe("T18-S6 delivered notes, once per closed placed item", () => {
  const delivered = () => t3.sent("thread_1").filter((c) => c.args.message.startsWith(DELIVERED_MARKER));
  const open = async () => {
    const x = boot();
    const m = (await x.call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    await x.call("GET", "/api/desk/messages");
    return { ...x, m };
  };
  const edit = (rel: string, fn: (t: string) => string) => {
    const f = path.join(repo, rel);
    fs.writeFileSync(f, fn(fs.readFileSync(f, "utf8")));
  };

  it("pure readers: row status by header, Done-means tick, epic status", () => {
    const t = spine([]);
    expect(ledgerRow(t, "T9-S1")).toEqual({ title: "First thing", status: "review" });
    expect(ledgerRow(t, "nope")).toBeUndefined();
    expect(doneMeansLine(t, "E9-2")).toEqual({ text: "It is fast", done: false });
    expect(readPlacement(t, { kind: "epic", itemId: "" })).toMatchObject({ title: "PLAN-9: Inbox spine", closed: undefined });
    expect(readPlacement(t.replace("Status: active", "Status: review"), { kind: "epic", itemId: "" }).closed).toBe("delivered");
    expect(readPlacement(t.replace("| review |", "| deployed (abc live) |"), { kind: "row", itemId: "T9-S1" }).closed).toBe("delivered");
    expect(readPlacement(t, { kind: "row", itemId: "T9-S1" }).closed).toBeUndefined(); // a row in review is not delivered
    expect(readPlacement(t.replace("[ ] E9-2", "[x] E9-2"), { kind: "done_means", itemId: "E9-2" }).closed).toBe("delivered");
  });

  it("one note per closed item (row, Done-means line, epic), none while open, none again after a restart", async () => {
    const x = await open();
    const place = (b: object) => x.call("POST", "/api/desk/placements", { repo: "inbox", ...b }, DESK);
    expect((await place({ path: "docs/spines/root.md", kind: "row", itemId: "T4" })).status).toBe(201);
    expect((await place({ path: "docs/spines/root.md", kind: "done_means", itemId: "E9-2" })).status).toBe(201);
    const epic = await place({ path: "docs/spines/child.md", kind: "epic", title: "A child idea" });
    expect(epic.status).toBe(201);
    expect((await place({ path: "docs/spines/child.md", kind: "epic" })).json.id).toBe(epic.json.id); // idempotent
    // registered only when the item exists
    expect((await place({ path: "docs/spines/root.md", kind: "row", itemId: "T99" })).status).toBe(404);
    expect((await place({ path: "docs/spines/nope.md", kind: "epic" })).status).toBe(404);
    expect((await place({ path: "../etc/passwd", kind: "epic" })).status).toBe(404);
    expect((await place({ path: "docs/spines/root.md", kind: "row" })).status).toBe(400);

    expect(await x.call("POST", "/api/desk/sweep")).toMatchObject({ json: { delivered: 0, noted: 0 } });
    expect(delivered()).toHaveLength(0);

    edit("docs/spines/root.md", (t) => t.replace("| blocked |", "| done |"));
    edit("docs/spines/child.md", (t) => t.replace("Status: draft", "Status: review"));
    expect((await x.call("POST", "/api/desk/sweep")).json).toEqual({ delivered: 2, noted: 2 });
    expect(delivered()).toHaveLength(2);
    const [row, ep] = delivered().map((c) => c.args);
    expect(row.message).toContain("Pick the logger layout");
    expect(row.message).toContain(`console ${BASE}/milestones/${x.m.id}`);
    expect(row.message).toMatch(/Tell him in one line, links first/);
    expect(ep.message).toContain("A child idea");
    expect(row.mode).toBe("auto");
    expect(row.clientRequestId).toMatch(/^desk-delivered-pl_/);

    // sweeping again, and a restarted console, send nothing more; the Done-means line (still open) stays quiet
    await x.call("POST", "/api/desk/sweep");
    await boot().call("POST", "/api/desk/sweep");
    expect(delivered()).toHaveLength(2);
    edit("docs/spines/root.md", (t) => t.replace("[ ] E9-2", "[x] E9-2"));
    const y = boot();
    await y.call("POST", "/api/desk/sweep");
    await y.call("POST", "/api/desk/sweep");
    expect(delivered()).toHaveLength(3);
    expect(delivered()[2].args.message).toContain("It is fast");
    const list = (await y.call("GET", "/api/desk/placements")).json as any[];
    expect(list.map((p) => [p.itemId, p.state, !!p.notedAt])).toEqual([["T4", "delivered", true], ["E9-2", "delivered", true], ["", "delivered", true]]);
  });

  it("a note T3 refused is held by the console and re-sent next pass (once accepted, never again); the chat does not show the note", async () => {
    const x = await open();
    await x.call("POST", "/api/desk/placements", { repo: "inbox", path: "docs/spines/root.md", kind: "row", itemId: "T4" }, DESK);
    edit("docs/spines/root.md", (t) => t.replace("| blocked |", "| merged |"));
    t3.failSends = true;
    // 22 Nov: the note is held in desk_console_lines (noted once), the console re-sends it until T3 takes it
    expect((await x.call("POST", "/api/desk/sweep")).json).toEqual({ delivered: 1, noted: 1 });
    t3.failSends = false;
    await x.call("POST", "/api/desk/sweep");
    await x.call("POST", "/api/desk/sweep");
    expect(delivered()).toHaveLength(2); // the refused attempt + the accepted one, same request id
    expect(new Set(delivered().map((c) => c.args.clientRequestId)).size).toBe(1);
    t3.say("thread_1", "Done: Pick the logger layout.");
    const v = (await x.call("GET", "/api/desk/messages")).json;
    expect(JSON.stringify(v.messages)).not.toContain(DELIVERED_MARKER);
    expect(v.messages.at(-1)).toMatchObject({ role: "assistant", text: "Done: Pick the logger layout." });
  });

  it("T62-S8: the state is the spine's on every read: a row reopened after delivery reads placed again, and nothing stores it", async () => {
    const x = await open();
    await x.call("POST", "/api/desk/placements", { repo: "inbox", path: "docs/spines/root.md", kind: "row", itemId: "T4" }, DESK);
    edit("docs/spines/root.md", (t) => t.replace("| blocked |", "| merged |"));
    expect((await x.call("POST", "/api/desk/sweep")).json).toEqual({ delivered: 1, noted: 1 });
    expect(((await x.call("GET", "/api/desk/placements")).json as any[])[0]).toMatchObject({ state: "delivered" });
    edit("docs/spines/root.md", (t) => t.replace("| merged |", "| active |")); // the owner reopened it
    expect(((await x.call("GET", "/api/desk/placements")).json as any[])[0]).toMatchObject({ state: "placed" });
    expect((await x.call("POST", "/api/desk/sweep")).json).toEqual({ delivered: 0, noted: 0 }); // the note was sent once
    const cols = (db.prepare("PRAGMA table_info(desk_placement)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("state");
    expect(cols).not.toContain("closed_at");
  });

  it("a superseded item is dropped quietly (no note); an item the desk did not place gets none", async () => {
    const x = await open();
    await x.call("POST", "/api/desk/placements", { repo: "inbox", path: "docs/spines/root.md", kind: "row", itemId: "T4" }, DESK);
    edit("docs/spines/root.md", (t) => t.replace("| blocked |", "| superseded |").replace("| review |", "| done |"));
    expect((await x.call("POST", "/api/desk/sweep")).json).toEqual({ delivered: 0, noted: 0 }); // closed but was not placed by the desk
    expect(delivered()).toHaveLength(0);
    expect(((await x.call("GET", "/api/desk/placements")).json as any[])[0].state).toBe("dropped");
  });

  it("Add by the desk is recorded as its placement automatically; Sam's own Add is not", async () => {
    const x = await open();
    const add = (headers: Record<string, string>, title: string) => x.call("POST", `/api/milestones/${x.m.id}/tree/add`, { kind: "row", title }, headers);
    // root.md's ids (T4) give a prefix and a number
    const mine = await add(DESK, "Desk row");
    expect(mine.status).toBe(201);
    expect((await add({}, "Sam row")).status).toBe(201);
    const list = (await x.call("GET", "/api/desk/placements")).json as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ repo: "inbox", path: "docs/spines/root.md", kind: "row", itemId: mine.json.id, title: "Desk row", state: "placed" });
  });

  it("links: the console page where Sam marks it ready (the milestone holding the spine), never a desk stamp", async () => {
    const x = await open();
    const own = (await x.call("GET", "/api/desk/links?repo=inbox&path=docs/spines/root.md")).json;
    expect(own).toMatchObject({ milestoneId: x.m.id, markReady: `${BASE}/milestones/${x.m.id}?tab=tree` });
    expect((await x.call("GET", "/api/desk/links?repo=inbox")).status).toBe(400);
    expect((await x.call("GET", "/api/desk/links?repo=inbox&path=docs/spines/zzz.md")).json.markReady).toBeUndefined();
    // the stamp endpoint stays the owner's: the desk's header is refused
    expect((await x.call("POST", `/api/milestones/${x.m.id}/stamp`, { to: "ready", path: "docs/spines/child.md" }, DESK)).status).toBe(403);
  });
});
