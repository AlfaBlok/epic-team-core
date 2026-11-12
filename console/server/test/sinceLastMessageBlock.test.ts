import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore, type Milestone, type Store } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { maskSecrets, SINCE_END, SINCE_MARKER, SINCE_MAX_CHARS, sinceBlock, splitSince, type SinceDeps } from "../src/desk/since.js";

// each message the owner sends in a milestone chat carries "what changed since your last message".
const PAGE = { "Sec-Fetch-Site": "same-origin" };
const T0 = "2026-10-20T10:00:00Z";
const SINCE = "2026-10-21T00:00:00Z";
const T1 = "2026-10-22T10:00:00Z";
const NOW = Date.parse("2026-10-22T12:00:00Z");

const spine = (rows: [string, string, string][], asks: string[], parent = "") =>
  [
    "# EPIC-905: Demo",
    "",
    ...(parent ? [`Parent spine: ${parent}`, ""] : []),
    "## Current State",
    "Status: active",
    "",
    "## Waiting on",
    ...asks,
    "",
    "## Issue Ledger",
    "| ID | Title | Status |",
    "|---|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
  ].join("\n");

let tmp: string;
let repo: string;
let db: DB;
let store: Store;

const gitIn = (args: string[], date?: string) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
const commit = (msg: string, date: string, files: Record<string, string>) => {
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body);
  }
  gitIn(["add", "-A"]);
  gitIn(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], date);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e19s2-"));
  repo = path.join(tmp, "demo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  db = openDb(path.join(tmp, "console.db"));
  store = createStore(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const deps = (rel = "docs/spines/root.md"): SinceDeps => ({ db, store, locate: async () => ({ repoDir: repo, rel }), now: () => NOW });
const mk = (p = "docs/spines/root.md") => store.createMilestone({ title: "Demo", repo: "Acme/demo", path: p, owner: "Sam", paused: false });

function fixture() {
  commit("EPIC-905: start", T0, {
    "docs/spines/root.md": spine(
      [
        ["E905-S1", "Build it", "active"],
        ["E905-S2", "Test it", "draft"],
      ],
      ["- [ask E905-A1: decide @Sam since 2026-10-20] Which host? — recommend: host1 — unblocks: E905-S2"],
    ),
  });
  commit("E905-S1: build it\n\nRun: run_x", T1, {
    "docs/spines/root.md": spine(
      [
        ["E905-S1", "Build it", "done"],
        ["E905-S2", "Test it", "draft"],
        ["E905-S3", "Ship it", "ready"],
      ],
      ["- [answered E905-A1 2026-10-22 @Sam] Which host? — answer: host1", "- [ask E905-A2: approve @Sam since 2026-10-22] Spend 5 EUR? — recommend: yes — unblocks: E905-S3"],
    ),
    "src/app.ts": "x",
  });
  commit("chore: deploy token=abc123secretvalue", T1, { "src/b.ts": "y" });
  const m = mk();
  const pe = store.createPersona({ name: "Builder", remit: "r", skills: [], model: "m", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: pe.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const old = store.createRun({ assignmentId: a.id, startedAt: T0, endedAt: T0, outcome: "progressed", summary: "old wake" });
  const wake = store.createRun({ assignmentId: a.id, startedAt: T1, endedAt: T1, outcome: "progressed", summary: "E905-S1 built and merged" });
  store.createRun({ assignmentId: a.id, startedAt: T1, outcome: "running", summary: "E905-S3 worker", parentRunId: wake.id });
  void old;
  // an ask raised through the API is a spine line; the raise log names its code.
  const nj = store.logRaisedAsk({ milestoneId: m.id, question: "Restart the relay?", proposedAction: "restart", by: "repo/E905-A3" });
  // pin the item's time inside the fixture (created_at was the real clock, so "nothing new" broke after 2026-10-29)
  db.prepare("UPDATE needs_jordi SET created_at = ? WHERE id = ?").run(new Date(T1).toISOString(), nj.id);
  return m;
}

describe("E919-S2 since-your-last-message block", () => {
  it("lists commits, runs, asks and ledger rows changed since the previous message", async () => {
    const m = fixture();
    const block = (await sinceBlock(deps(), m, SINCE))!;
    expect(block.startsWith(`${SINCE_MARKER}\nSince 2026-10-21 00:00Z`)).toBe(true);
    expect(block.endsWith(SINCE_END)).toBe(true);
    expect(block).toMatch(/Commits \(2\):\n- [0-9a-f]+ chore: deploy token=\[redacted\]\n- [0-9a-f]+ E905-S1: build it/);
    expect(block).not.toContain("EPIC-905: start");
    expect(block).not.toContain("abc123secretvalue");
    expect(block).toContain("Runs (2):\n- Builder wake: progressed: E905-S1 built and merged\n- Builder worker: running: E905-S3 worker");
    expect(block).not.toContain("old wake");
    expect(block).toContain("- ask raised through the API (E905-A3): Restart the relay?");
    expect(block).toContain("- answered: E905-A1 Which host?");
    expect(block).toContain("- opened: E905-A2 Spend 5 EUR?");
    expect(block).toContain("Ledger rows (2):\n- E905-S1 Build it: active → done\n- E905-S3 Ship it: new → ready");
    expect(block).not.toContain("E905-S2 Test it");
    expect(block.length).toBeLessThanOrEqual(SINCE_MAX_CHARS);
  });

  it("nothing new → no block", async () => {
    const m = fixture();
    expect(await sinceBlock({ ...deps(), now: () => Date.parse("2026-10-30T00:00:00Z") }, m, "2026-10-29T00:00:00Z")).toBeUndefined();
    // no checkout at all and an empty db: still nothing, no throw
    const bare = store.createMilestone({ title: "X", repo: "Acme/x", path: "docs/x.md", owner: "Sam", paused: false });
    expect(await sinceBlock({ db, store, locate: async () => ({}) }, bare, SINCE)).toBeUndefined();
  });

  it("caps each section with 'N more' and the whole block at ~1.5k chars; the first message looks back at most 7 days", async () => {
    commit("seed", T0, { "a.txt": "0" });
    for (let i = 0; i < 30; i++) commit(`E5-S${i}: change number ${i} ${"words ".repeat(12)}`, T1, { "a.txt": String(i + 1) });
    const m = mk();
    const pe = store.createPersona({ name: "Builder", remit: "r", skills: [], model: "m", mayWrite: true });
    const a = store.createAssignment({ milestoneId: m.id, personaId: pe.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    for (let i = 0; i < 10; i++) store.createRun({ assignmentId: a.id, startedAt: T1, endedAt: T1, outcome: "progressed", summary: `wake ${i} ${"did things ".repeat(12)}` });
    const block = (await sinceBlock(deps(), m, "2020-01-01T00:00:00Z"))!;
    expect(block).toContain("Commits (31):");
    // trimmed evenly: both sections keep their title and some lines
    expect(block).toMatch(/Commits \(31\):\n(- .*\n){3,}  … \d+ more\nRuns \(10\):\n(- .*\n){3,}  … \d+ more\n\[\/since\]$/);
    expect(block.length).toBeLessThanOrEqual(SINCE_MAX_CHARS);
    expect(block).toContain("Since 2026-10-15 12:00Z");
  });

  it("a lower milestone sees only commits touching its subtree or naming its ids", async () => {
    commit("seed", T0, { "docs/spines/epic-905.md": spine([["E905-S1", "Build", "active"]], [], "root.md"), "docs/spines/epic-906.md": "# EPIC-906\n" });
    commit("EPIC-906: other work", T1, { "docs/spines/epic-906.md": "# EPIC-906\nmore\n" });
    commit("E905-S1: code only", T1, { "src/x.ts": "1" });
    commit("spine edit", T1, { "docs/spines/epic-905.md": spine([["E905-S1", "Build", "done"]], [], "root.md") });
    const m = mk("docs/spines/epic-905.md");
    commit("E905-S9: a row the tree does not know yet", T1, { "src/y.ts": "1" });
    // spines.py ids are slugs: the epic number comes from the file name
    const tree = async () => ({ root: { key: m.id, id: "epic-905-demo", kind: "spine", title: "x", status: "active", color: "blue", path: "docs/spines/epic-905.md", children: [{ key: "k", id: "E905-S1", kind: "ticket", title: "Build", status: "done", color: "green", children: [], flags: [] }], flags: [] } }) as any;
    const block = (await sinceBlock({ ...deps("docs/spines/epic-905.md"), tree }, m, SINCE))!;
    expect(block).toContain("E905-S1: code only");
    expect(block).toContain("E905-S9: a row the tree does not know yet");
    expect(block).toContain("spine edit");
    expect(block).not.toContain("EPIC-906: other work");
    expect(block).toContain("- E905-S1 Build: active → done");
    // the repo's root spine (`Parent spine: none`) sees every commit
    commit("root spine", T1, { "docs/spines/root.md": spine([], [], "none") });
    const root = (await sinceBlock(deps("docs/spines/root.md"), mk(), SINCE))!;
    expect(root).toContain("EPIC-906: other work");
  });

  it("splitSince gives back Sam's words and the block; masking keeps commit shas and run ids", () => {
    const block = `${SINCE_MARKER}\nSince x:\nCommits (1):\n- abc fix\n${SINCE_END}`;
    expect(splitSince(`${block}\nwhat happened?`)).toEqual({ text: "what happened?", since: "Since x:\nCommits (1):\n- abc fix" });
    expect(splitSince("plain words")).toEqual({ text: "plain words" });
    expect(maskSecrets("run_c2372452-bdbd-4b64-b186-b793d237d3f8 and 0123456789abcdef0123456789abcdef01234567")).toBe("run_c2372452-bdbd-4b64-b186-b793d237d3f8 and 0123456789abcdef0123456789abcdef01234567");
    expect(maskSecrets("key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA end")).toBe("key [redacted] end");
  });
});

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, T3ThreadMessage[]>();
  private n = 0;
  private pos = 0;
  constructor(private root: string) {}
  async listProjects() {
    return [{ id: "p_demo", title: "demo", workspaceRoot: path.join(this.root, "demo"), repositoryIdentity: { displayName: "acme/demo" } }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  private push(threadId: string, text: string, at: string) {
    this.threads.get(threadId)!.push({ itemId: `i${++this.pos}`, position: this.pos, role: "user", text, status: "completed", truncated: false, updatedAt: at });
  }
  at = new Date(NOW).toISOString();
  async launchThread(input: { projectId: string; title: string; message?: string }) {
    const threadId = `thread_${++this.n}`;
    this.threads.set(threadId, []);
    if (input.message) this.push(threadId, input.message, "2026-10-20T00:00:00Z");
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId, mode } });
    this.push(threadId, message, this.at);
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    const page = (this.threads.get(threadId) ?? []).filter((m) => opts.afterPosition === undefined || m.position > opts.afterPosition);
    return { messages: page, nextPosition: page.length ? page[page.length - 1].position : (opts.afterPosition ?? null), hasMore: false, archived: false };
  }
}
class FakeDispatcher implements Dispatcher {
  async pick() {
    return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" };
  }
  async done() {}
}

describe("E919-S2 in the milestone chat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("prefixes the block before Sam's words, since his previous message; the chat and his words never include it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fixture();
    const t3 = new FakeT3(tmp);
    t3.at = new Date(NOW + 60_000).toISOString();
    const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read, cycle: { enabled: true, t3, dispatcher: new FakeDispatcher(), publicUrl: "http://127.0.0.1:1", runState: async () => undefined } });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: { ...PAGE, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json() };
    };
    const m: Milestone = store.listMilestones({ includeSettled: true })[0];
    await call("GET", `/api/milestones/${m.id}/chat/messages`);
    db.prepare("UPDATE desk_session SET created_at = ?").run(SINCE);
    // first message: since the thread started (2026-10-21): the T1 commits and runs are new
    expect((await call("POST", `/api/milestones/${m.id}/chat/messages`, { text: "what's new?", page: "Demo · Chat" })).status).toBe(201);
    const first: string = t3.calls.at(-1)!.args.message;
    expect(first.startsWith(`[page: Demo · Chat]\n${SINCE_MARKER}\n`)).toBe(true);
    expect(first).toContain("E905-S1: build it");
    expect(first.endsWith(`${SINCE_END}\nwhat's new?`)).toBe(true);
    // second message right after: nothing changed since the first → no block
    await call("POST", `/api/milestones/${m.id}/chat/messages`, { text: "thanks" });
    expect(t3.calls.at(-1)!.args.message).toBe("thanks");
    const view = await call("GET", `/api/milestones/${m.id}/chat/messages`);
    const mine = view.json.messages.filter((x: any) => x.kind === "message");
    expect(mine.map((x: any) => x.text)).toEqual(["what's new?", "thanks"]);
    expect(mine[0].page).toBe("Demo · Chat");
    expect(mine[0].since).toContain("Commits (2):");
    expect(mine[1].since).toBeUndefined();
  });
});
