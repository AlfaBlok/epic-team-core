import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { migrateDesk } from "../src/desk/desk.js";
import { chatCaller, MILESTONE_SEED_MARKER, MILESTONE_UPDATE_MARKER, REPO_DESK_PERSONA_NAME } from "../src/desk/milestoneChat.js";

// one repo-desk thread per milestone, in the milestone repo's T3 project, on the Team desk's session engine.
const PAGE = { "Sec-Fetch-Site": "same-origin" };
const BASE = "http://127.0.0.1:18799";

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, { messages: T3ThreadMessage[]; status: string }>();
  gone = new Set<string>();
  private n = 0;
  private pos = 0;
  constructor(private root: string) {}
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  private push(threadId: string, role: "user" | "assistant", text: string) {
    this.threads.get(threadId)!.messages.push({ itemId: `item_${++this.pos}`, position: this.pos * 2, role, text, status: "completed", truncated: false, updatedAt: new Date().toISOString() });
  }
  say = (threadId: string, text: string) => this.push(threadId, "assistant", text);
  async listProjects() {
    return [
      { id: "p_demo", title: "demo", workspaceRoot: path.join(this.root, "demo"), repositoryIdentity: { displayName: "acme/demo" } },
      { id: "p_other", title: "other", workspaceRoot: path.join(this.root, "other"), repositoryIdentity: { displayName: "acme/other" } },
      { id: "p_home_repo", title: "home_repo", workspaceRoot: "/x/home_repo", repositoryIdentity: { displayName: "acme/home_repo" } },
    ];
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
    const threadId = `thread_${++this.n}`;
    this.threads.set(threadId, { messages: [], status: "idle" });
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId, mode } });
    this.push(threadId, "user", message);
  }
  async readThreadStatus(threadId: string) {
    if (this.gone.has(threadId)) throw new Error('t3_thread_read: {"code":"not_found","message":"Thread not found."}');
    return { status: this.threads.get(threadId)?.status ?? "idle", raw: {} };
  }
  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    if (this.gone.has(threadId)) throw new Error("not_found");
    const all = (this.threads.get(threadId)?.messages ?? []).filter((m) => opts.afterPosition === undefined || m.position > opts.afterPosition);
    const page = all.slice(0, opts.limit ?? 100);
    return { messages: page, nextPosition: page.length ? page[page.length - 1].position : (opts.afterPosition ?? null), hasMore: all.length > page.length, archived: false };
  }
}

class FakeDispatcher implements Dispatcher {
  async pick() {
    return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" };
  }
  async done() {}
}

const SPINE = (title: string) => `# ${title}\n\n## Current State\n\nStatus: active\n`;

let tmp: string;
let db: DB;
let t3: FakeT3;
let read: ReadConfig;
const mkApp = () => createApp(db, { read, cycle: { enabled: true, t3, dispatcher: new FakeDispatcher(), publicUrl: BASE, runState: async () => undefined } });
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e19s1-"));
  for (const repo of ["demo", "other"]) {
    fs.mkdirSync(path.join(tmp, repo, "docs", "spines"), { recursive: true });
    execFileSync("git", ["-C", path.join(tmp, repo), "init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(tmp, repo, "docs", "spines", "root.md"), SPINE(`${repo} root`));
  }
  fs.writeFileSync(path.join(tmp, "demo", "docs", "spines", "epic-2.md"), SPINE("PLAN-2 lower"));
  // A stand-in EpicSpine skill: spines.py --bind echoes what it was asked and where.
  const skill = path.join(tmp, "skill");
  fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skill, "scripts", "spines.py"), "import os, sys\nprint('BIND', ' '.join(sys.argv[1:]), 'in', os.path.basename(os.getcwd()))\n");
  db = openDb(path.join(tmp, "console.db"));
  t3 = new FakeT3(tmp);
  read = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [], skillDir: skill };
  app = mkApp();
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: string, url: string, body?: unknown, extra: Record<string, string> = {}, on = app) => {
  const res = await on.request(url, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
const milestone = async (title: string, repo: string, p: string) => (await call("POST", "/api/milestones", { title, repo, path: p })).json.id as string;
const seeds = () => t3.ops("launchThread").map((c) => c.args);

describe("T19-S1 one repo-desk thread per milestone", () => {
  it("launches each milestone's thread in its repo's project, once, and reuses it; the Team desk keeps its own", async () => {
    const root = await milestone("Demo root", "Acme/demo", "docs/spines/root.md");
    const lower = await milestone("Demo PLAN-2", "Acme/demo", "docs/spines/epic-2.md");
    const other = await milestone("Other", "Acme/other", "docs/spines/root.md");
    const [a, b] = await Promise.all([call("GET", `/api/milestones/${root}/chat/messages`), call("GET", `/api/milestones/${root}/chat/messages`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.json.threadId).toBe(b.json.threadId);
    const l = await call("GET", `/api/milestones/${lower}/chat/messages`);
    const o = await call("GET", `/api/milestones/${other}/chat/messages`);
    await call("GET", `/api/milestones/${root}/chat/messages`);
    // two milestones of the same repo: two threads, same project
    expect(seeds().map((s) => s.projectId)).toEqual(["p_demo", "p_demo", "p_other"]);
    expect(new Set([a.json.threadId, l.json.threadId, o.json.threadId]).size).toBe(3);
    expect(seeds()[0].title).toBe(`${REPO_DESK_PERSONA_NAME} · Demo root`);
    const desk = await call("GET", "/api/desk/messages");
    expect(desk.json.threadId).not.toBe(a.json.threadId);
    expect(t3.ops("launchThread")).toHaveLength(4);
    expect(seeds()[3].projectId).toBe("p_home_repo");
    // one shared persona row, never assigned (it never wakes on its own)
    const store = createStore(db);
    const p = store.listPersonas().filter((x) => x.name === REPO_DESK_PERSONA_NAME);
    expect(p).toHaveLength(1);
    expect(store.listAssignments({ personaId: p[0].id })).toHaveLength(0);
  });

  it("seeds the remit, the milestone, its repo and spine, the bind view, its own run header and the endpoints", async () => {
    const lower = await milestone("Demo PLAN-2", "Acme/demo", "docs/spines/epic-2.md");
    await call("GET", `/api/milestones/${lower}/chat/messages`);
    const seed: string = seeds()[0].message;
    expect(seed.startsWith(MILESTONE_SEED_MARKER)).toBe(true);
    expect(seed).toContain(`You are ${REPO_DESK_PERSONA_NAME} for the milestone "Demo PLAN-2" of the repo demo`);
    expect(seed).toContain(`console id ${lower}`);
    expect(seed).toContain("Spine: docs/spines/epic-2.md");
    expect(seed).toContain(path.join(tmp, "demo"));
    expect(seed).toContain("BIND --bind docs/spines/epic-2.md in demo");
    expect(seed).toContain(`X-Console-Run: milestone-chat:${lower}`);
    expect(chatCaller(`milestone-chat:${lower}`)).toBe(lower);
    for (const ep of ["/run-now", "/api/runs/<run id>/steer", "/api/runs/<run id>/stop", `/api/milestones/${lower}/tree/add`, `/api/waiting-on-owner?milestoneId=${lower}`])
      expect(seed).toContain(ep);
    expect(seed.length).toBeGreaterThan(500);
  });

  it("survives a console restart: a new app on the same db reuses the stored thread", async () => {
    const root = await milestone("Demo root", "Acme/demo", "docs/spines/root.md");
    const first = await call("GET", `/api/milestones/${root}/chat/messages`);
    await call("POST", `/api/milestones/${root}/chat/messages`, { text: "what happened today?" }, PAGE);
    t3.say(first.json.threadId, "Two commits landed.");
    const restarted = mkApp();
    const again = await call("GET", `/api/milestones/${root}/chat/messages`, undefined, {}, restarted);
    expect(again.json.threadId).toBe(first.json.threadId);
    expect(t3.ops("launchThread")).toHaveLength(1);
    expect(again.json.messages.map((m: any) => [m.role, m.kind, m.text])).toEqual([
      ["user", "seed", ""],
      ["user", "message", "what happened today?"],
      ["assistant", "message", "Two commits landed."],
    ]);
  });

  it("relaunches only the lost milestone's thread, seeded with a summary", async () => {
    const root = await milestone("Demo root", "Acme/demo", "docs/spines/root.md");
    const other = await milestone("Other", "Acme/other", "docs/spines/root.md");
    const r1 = (await call("GET", `/api/milestones/${root}/chat/messages`)).json.threadId;
    const o1 = (await call("GET", `/api/milestones/${other}/chat/messages`)).json.threadId;
    t3.say(r1, "PLAN-2 is waiting on S3.");
    t3.gone.add(r1);
    const r2 = await call("GET", `/api/milestones/${root}/chat/messages`);
    const o2 = await call("GET", `/api/milestones/${other}/chat/messages`);
    expect(r2.json.threadId).not.toBe(r1);
    expect(r2.json.messages[0]).toMatchObject({ kind: "seed", text: "" });
    expect(o2.json.threadId).toBe(o1);
    const seed: string = seeds()[2].message;
    expect(seed).toContain(r1);
    expect(seed).toContain("is gone");
    expect(db.prepare("SELECT desk_key, end_reason FROM desk_session WHERE ended_at IS NOT NULL").all()).toEqual([{ desk_key: `milestone:${root}`, end_reason: "not found in T3" }]);
  });

  it("sends Sam's message with the page hint; only Sam, from the page; unknown milestone is 404", async () => {
    const root = await milestone("Demo root", "Acme/demo", "docs/spines/root.md");
    const sent = await call("POST", `/api/milestones/${root}/chat/messages`, { text: "run the builder", page: "Demo root · Chat" }, PAGE);
    expect(sent.status).toBe(201);
    expect(t3.ops("sendToThread").at(-1)!.args).toMatchObject({ threadId: sent.json.threadId, message: "[page: Demo root · Chat]\nrun the builder", mode: "auto" });
    const persona = await call("POST", `/api/milestones/${root}/chat/messages`, { text: "x" }, { ...PAGE, "X-Console-Run": `milestone-chat:${root}` });
    expect(persona.status).toBe(403);
    expect(persona.json.error.code).toBe("jordi_only");
    expect((await call("GET", "/api/milestones/nope/chat/messages")).status).toBe(404);
    expect((await call("POST", `/api/milestones/${root}/chat/messages`, { text: "  " }, PAGE)).status).toBe(400);
  });

  it("a live thread with an older endpoint list gets one [repo-desk update], hidden from the chat with its ack", async () => {
    const root = await milestone("Demo root", "Acme/demo", "docs/spines/root.md");
    const tid = (await call("GET", `/api/milestones/${root}/chat/messages`)).json.threadId;
    db.prepare("UPDATE desk_session SET seed_version = 0 WHERE thread_id = ?").run(tid);
    await call("GET", `/api/milestones/${root}/chat/messages`);
    await vi.waitFor(() => expect(t3.ops("sendToThread").filter((c) => c.args.message.startsWith(MILESTONE_UPDATE_MARKER))).toHaveLength(1));
    t3.say(tid, "Updated.");
    await call("GET", `/api/milestones/${root}/chat/messages`);
    expect(t3.ops("sendToThread").filter((c) => c.args.message.startsWith(MILESTONE_UPDATE_MARKER))).toHaveLength(1);
    const v = (await call("GET", `/api/milestones/${root}/chat/messages`)).json;
    expect(v.messages.map((m: any) => m.kind)).toEqual(["seed"]);
  });

  it("cycle off: the milestone chat says it is unavailable and launches nothing", async () => {
    const root = await milestone("Demo root", "Acme/demo", "docs/spines/root.md");
    const off = createApp(db, { read, cycle: { enabled: false, publicUrl: BASE } });
    const r = await call("GET", `/api/milestones/${root}/chat/messages`, undefined, {}, off);
    expect(r.json).toMatchObject({ available: false, messages: [] });
    expect(t3.ops("launchThread")).toHaveLength(0);
  });
});

describe("T19-S1 desk_session keys", () => {
  it("rows from before keys are the Team desk's", () => {
    const legacy = openDb(path.join(tmp, "legacy.db"));
    legacy.exec("CREATE TABLE desk_session (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, project_id TEXT, seat TEXT, created_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT)");
    legacy.prepare("INSERT INTO desk_session (thread_id, created_at) VALUES ('old_desk', '2026-10-25')").run();
    migrateDesk(legacy);
    migrateDesk(legacy);
    expect(legacy.prepare("SELECT desk_key, thread_id FROM desk_session").all()).toEqual([{ desk_key: "team", thread_id: "old_desk" }]);
    legacy.close();
  });
});

// a world's team desk runs on the same engine: one thread for the world (key world-desk:<world>), launched in the
// world's home repo project by the world's own "Team desk" persona, seeded with the world's milestones and token; the home world's
// Team desk keeps its own thread.
describe("T58-S4 the world's team desk", () => {
  it("launches once in the world's home repo, as that world's Team desk, with its token rule; never acme's milestones; Sam's message lands there", async () => {
    db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES ('zen', 'Zen world', 'social', 'founding', ?)").run(new Date().toISOString());
    const zs = createStore(db, { tenant: "zen" });
    zs.createMilestone({ title: "Zen campaign", repo: "Acme/other", path: "docs/spines/root.md", owner: "Sam", paused: false, bigRoot: 1 });
    await milestone("ALPHA demo root", "Acme/demo", "docs/spines/root.md");
    const [a, b] = await Promise.all([call("GET", "/api/tenants/zen/desk/messages"), call("GET", "/api/tenants/zen/desk/messages")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.json.threadId).toBe(b.json.threadId);
    const seed = seeds().find((s) => s.title === "Team desk · Zen world")!;
    expect(seed.projectId).toBe("p_other");
    expect(seed.message.startsWith("[world-desk seed]")).toBe(true);
    expect(seed.message).toContain("Zen campaign");
    expect(seed.message).not.toContain("ALPHA demo root");
    expect(seed.message).toMatch(/Authorization: Bearer|world token|zen/);
    expect(zs.listPersonas().some((p) => p.name === "Team desk")).toBe(true);
    const sent = await call("POST", "/api/tenants/zen/desk/messages", { text: "Which campaign needs me?" }, PAGE);
    expect([201, 202]).toContain(sent.status);
    expect(t3.ops("sendToThread").some((c) => c.args.threadId === a.json.threadId && String(c.args.message).includes("Which campaign needs me?"))).toBe(true);
    const desk = await call("GET", "/api/desk/messages");
    expect(desk.json.threadId).not.toBe(a.json.threadId);
  });
});

describe("T58-S4 a chat's first session is its first (the divider)", () => {
  it("the seed's session number counts this chat's sessions only, so a new chat says Chat started even after other chats", async () => {
    const a = await milestone("Demo root", "Acme/demo", "docs/spines/root.md");
    const b = await milestone("Other", "Acme/other", "docs/spines/root.md");
    await call("GET", "/api/desk/messages");
    await call("GET", `/api/milestones/${a}/chat/messages`);
    const second = await call("GET", `/api/milestones/${b}/chat/messages`);
    const seed = second.json.messages.find((m: any) => m.kind === "seed");
    expect(seed.session).toBe(1);
  });
});
