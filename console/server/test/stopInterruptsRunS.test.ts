import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { resolveSkillDir } from "../src/adapters/spines.js";
import type { ReadConfig } from "../src/routes/read.js";
import { addDoneMeans, addIn, addLedgerRow, slugOf } from "../src/status/add.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { McpT3Client, type T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { tempCheckout } from "./tempCheckout.js";
// the code repo milestone lives in a temp checkout (finishing a run fetches its origin; never the real one).
const AT = tempCheckout("home_repo", ["AGENTS.md", "docs/spines/root.md", "docs/spines/m2-team-console.md"]).dir;


/** console run controls: Stop (with workers), Steer on a child run, Add on a tree node. */

// ---------- Stop and Steer (fake T3) ----------

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  failSteer = false;
  failInterrupt = false;
  private n = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  async listProjects() {
    return [{ id: "mcp:agent-team", title: "home_repo", workspaceRoot: AT, repositoryIdentity: { displayName: "acme/home_repo" } }];
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
    return { threadId: `thread_${++this.n}` };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId, mode } });
    if (mode === "steer" && this.failSteer) throw new Error("t3_thread_send: turn not steerable");
  }
  async readThreadStatus() {
    return { status: "running", raw: {} };
  }
  async interruptThread(threadId: string, reason?: string, clientRequestId?: string) {
    this.calls.push({ op: "interruptThread", args: { threadId, reason, clientRequestId } });
    if (this.failInterrupt) throw new Error("t3_thread_interrupt: boom");
  }
}

class FakeDispatcher implements Dispatcher {
  released: { seat: string; failed?: boolean }[] = [];
  async pick() {
    return { seat: "seat2", providerInstanceId: "claudeAgent_seat2" };
  }
  async done(seat: string, failed?: boolean) {
    this.released.push({ seat, failed });
  }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s3-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const t3 = new FakeT3();
  const dispatcher = new FakeDispatcher();
  const app = createApp(db, {
    cycle: { enabled: true, t3, dispatcher, publicUrl: "http://127.0.0.1:18799", seatsFile: path.join(dir, "seats.json"), runState: async () => undefined },
  });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
  };
  const seed = async () => {
    const m = (await call("POST", "/api/milestones", { title: "M2", repo: AT, path: "docs/spines/m2-team-console.md" })).json;
    const p = (await call("POST", "/api/personas", { name: "reader", remit: "read-only", model: "haiku" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true })).json;
    return { m, p, a };
  };
  /** A persona wake (run-now) with its home thread, plus `n` running child worker runs on their own threads. */
  const wakeWithWorkers = async (a: { id: string }, n: number) => {
    const wake = (await call("POST", `/api/assignments/${a.id}/run-now`)).json;
    const kids: any[] = [];
    for (let i = 1; i <= n; i++)
      kids.push((await call("POST", "/api/runs", { assignmentId: a.id, parentRunId: wake.id, threadId: `child_${i}`, seat: `seat${i}`, summary: `worker ${i}` })).json);
    return { wake, kids };
  };
  const run = async (id: string) => (await call("GET", `/api/runs/${id}`)).json;
  return { db, t3, dispatcher, call, seed, wakeWithWorkers, run };
}

describe("Stop", () => {
  it("interrupts the run's thread and closes it stopped with the reason; nothing wakes afterwards", async () => {
    const t = setup();
    const { a } = await t.seed();
    const { wake } = await t.wakeWithWorkers(a, 0);
    expect(wake.outcome).toBe("running");
    const launches = t.t3.ops("launchThread").length;

    const r = await t.call("POST", `/api/runs/${wake.id}/stop`, { reason: "  wrong repo  " });
    expect(r.status).toBe(200);
    expect(r.json.run).toMatchObject({ id: wake.id, outcome: "stopped" });
    expect(r.json.run.endedAt).toBeTruthy();
    expect(r.json.run.summary).toContain("Stopped: wrong repo");
    expect(t.t3.ops("interruptThread")).toHaveLength(1);
    expect(t.t3.ops("interruptThread")[0].args).toMatchObject({ threadId: wake.threadId, reason: "Stopped from the console: wrong repo" });
    expect(await t.run(wake.id)).toMatchObject({ outcome: "stopped" });

    // L-10: no timed wake, no relaunch, no second run
    const a2 = (await t.call("GET", `/api/assignments/${a.id}`)).json;
    expect(a2.retryAt).toBeUndefined();
    expect(t.t3.ops("launchThread")).toHaveLength(launches);
    expect((await t.call("GET", `/api/runs?assignmentId=${a.id}&limit=50`)).json.filter((x: any) => x.kind === "wake")).toHaveLength(1);
  });

  it("clears a timed wake this run had booked (L-10: nothing resumes on its own)", async () => {
    const t = setup();
    const { a } = await t.seed();
    const { wake } = await t.wakeWithWorkers(a, 0);
    t.db.prepare("UPDATE assignments SET retry_at = ?, retry_run_id = ? WHERE id = ?").run(new Date(Date.now() + 3_600_000).toISOString(), wake.id, a.id);
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.retryAt).toBeTruthy();
    await t.call("POST", `/api/runs/${wake.id}/stop`, { reason: "hold" });
    expect((await t.call("GET", `/api/assignments/${a.id}`)).json.retryAt).toBeUndefined();
  });

  it("needs a reason; a finished or unknown run cannot be stopped; a T3 failure leaves the run running", async () => {
    const t = setup();
    const { a } = await t.seed();
    const { wake } = await t.wakeWithWorkers(a, 0);
    expect((await t.call("POST", `/api/runs/${wake.id}/stop`, {})).json.error.code).toBe("empty_reason");
    expect((await t.call("POST", `/api/runs/${wake.id}/stop`, { reason: "   " })).status).toBe(400);
    expect((await t.call("POST", "/api/runs/run_nope/stop", { reason: "x" })).status).toBe(404);

    t.t3.failInterrupt = true;
    const bad = await t.call("POST", `/api/runs/${wake.id}/stop`, { reason: "x" });
    expect(bad.status).toBe(502);
    expect(bad.json.error.code).toBe("t3_error");
    expect((await t.run(wake.id)).outcome).toBe("running");

    t.t3.failInterrupt = false;
    expect((await t.call("POST", `/api/runs/${wake.id}/stop`, { reason: "x" })).status).toBe(200);
    const again = await t.call("POST", `/api/runs/${wake.id}/stop`, { reason: "x" });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("not_running");
  });

  it("a run with no thread yet answers 409 and interrupts nothing", async () => {
    const t = setup();
    const { a } = await t.seed();
    const r = (await t.call("POST", "/api/runs", { assignmentId: a.id })).json;
    const s = await t.call("POST", `/api/runs/${r.id}/stop`, { reason: "x" });
    expect(s.status).toBe(409);
    expect(s.json.error.code).toBe("no_thread");
    expect(t.t3.ops("interruptThread")).toHaveLength(0);
  });

  it("stopping a persona wake leaves its running workers alone (and says how many)", async () => {
    const t = setup();
    const { a } = await t.seed();
    const { wake, kids } = await t.wakeWithWorkers(a, 2);
    const r = await t.call("POST", `/api/runs/${wake.id}/stop`, { reason: "just the persona" });
    expect(r.json).toMatchObject({ workers: [], workersRunning: 2 });
    expect(t.t3.ops("interruptThread").map((c) => c.args.threadId)).toEqual([wake.threadId]);
    for (const k of kids) expect((await t.run(k.id)).outcome).toBe("running");
  });

  it("withWorkers stops the wake and its running workers, releasing their seats; finished workers are left", async () => {
    const t = setup();
    const { a } = await t.seed();
    const { wake, kids } = await t.wakeWithWorkers(a, 3);
    await t.call("PATCH", `/api/runs/${kids[2].id}`, { outcome: "progressed", summary: "done", endedAt: new Date().toISOString() });
    t.dispatcher.released.length = 0; // run-now's own pick/done is not under test
    const r = await t.call("POST", `/api/runs/${wake.id}/stop`, { reason: "enough", withWorkers: true });
    expect(r.status).toBe(200);
    expect(r.json.workers.map((w: any) => w.id).sort()).toEqual([kids[0].id, kids[1].id].sort());
    expect(r.json).toMatchObject({ workersRunning: 0, workerErrors: [] });
    expect(t.t3.ops("interruptThread").map((c) => c.args.threadId).sort()).toEqual([wake.threadId, "child_1", "child_2"].sort());
    for (const k of kids.slice(0, 2)) expect(await t.run(k.id)).toMatchObject({ outcome: "stopped", summary: expect.stringContaining("Stopped: enough") });
    expect((await t.run(kids[2].id)).outcome).toBe("progressed");
    expect(t.dispatcher.released.map((x) => x.seat).sort()).toEqual(["seat1", "seat2"]);
  });

  it("a child worker run stops on its own", async () => {
    const t = setup();
    const { a } = await t.seed();
    const { wake, kids } = await t.wakeWithWorkers(a, 2);
    t.dispatcher.released.length = 0;
    const r = await t.call("POST", `/api/runs/${kids[0].id}/stop`, { reason: "off track" });
    expect(r.status).toBe(200);
    expect(r.json.run).toMatchObject({ id: kids[0].id, outcome: "stopped", parentRunId: wake.id });
    expect(t.t3.ops("interruptThread").map((c) => c.args.threadId)).toEqual(["child_1"]);
    expect((await t.run(wake.id)).outcome).toBe("running");
    expect((await t.run(kids[1].id)).outcome).toBe("running");
    expect(t.dispatcher.released).toEqual([{ seat: "seat1", failed: false }]);
  });

  it("withWorkers reports a worker T3 would not stop, and still stops the rest", async () => {
    const t = setup();
    const { a } = await t.seed();
    const { wake, kids } = await t.wakeWithWorkers(a, 2);
    const orig = t.t3.interruptThread.bind(t.t3);
    t.t3.interruptThread = async (threadId, reason, crid) => {
      if (threadId === "child_1") throw new Error("t3_thread_interrupt: refused");
      return orig(threadId, reason, crid);
    };
    const r = await t.call("POST", `/api/runs/${wake.id}/stop`, { reason: "x", withWorkers: true });
    expect(r.status).toBe(200);
    expect(r.json.workerErrors).toMatchObject([{ runId: kids[0].id }]);
    expect(r.json.workers.map((w: any) => w.id)).toEqual([kids[1].id]);
    expect(r.json.workersRunning).toBe(1);
    expect((await t.run(kids[0].id)).outcome).toBe("running");
  });

  it("McpT3Client.interruptThread calls t3_thread_interrupt with the thread, reason and a request id", async () => {
    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e18s3-tok-")), "token");
    fs.writeFileSync(tokenFile, "tok\n");
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/call" ? { structuredContent: { ok: true } } : {} }), { headers: { "mcp-session-id": "s1" } });
      }),
    );
    try {
      await new McpT3Client("http://127.0.0.1:1/mcp", tokenFile, [0, 0]).interruptThread("thread_9", "because", "crid-1");
    } finally {
      vi.unstubAllGlobals();
    }
    const c = bodies.find((b) => b.method === "tools/call");
    expect(c.params).toEqual({ name: "t3_thread_interrupt", arguments: { threadId: "thread_9", reason: "because", clientRequestId: "crid-1" } });
  });
});

describe("Steer on a child run", () => {
  it("steers a running child by run id into its own thread (steer mode), noted on that run", async () => {
    const t = setup();
    const { a } = await t.seed();
    const { kids } = await t.wakeWithWorkers(a, 2);
    const s = await t.call("POST", `/api/runs/${kids[1].id}/steer`, { message: "  use the staging db  ", clientRequestId: "crid-c" });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ threadId: "child_2", mode: "steer" });
    const sent = t.t3.ops("sendToThread").at(-1)!.args;
    expect(sent).toMatchObject({ threadId: "child_2", message: "use the staging db", clientRequestId: "crid-c", mode: "steer" });
    expect((await t.run(kids[1].id)).steers).toMatchObject([{ mode: "steer", message: "use the staging db" }]);
    expect((await t.run(kids[0].id)).steers).toBeUndefined();
  });

  it("falls back to auto when T3 will not steer; 400 empty, 404 unknown, 409 finished or no thread", async () => {
    const t = setup();
    const { a } = await t.seed();
    const { wake, kids } = await t.wakeWithWorkers(a, 1);
    t.t3.failSteer = true;
    const s = await t.call("POST", `/api/runs/${kids[0].id}/steer`, { message: "hi" });
    expect(s.json.mode).toBe("auto");
    expect(t.t3.ops("sendToThread").slice(-2).map((c) => c.args.mode)).toEqual(["steer", "auto"]);
    expect((await t.call("POST", `/api/runs/${kids[0].id}/steer`, { message: "   " })).json.error.code).toBe("empty_message");
    expect((await t.call("POST", "/api/runs/run_nope/steer", { message: "x" })).status).toBe(404);
    // a persona wake is steerable by run id too
    expect((await t.call("POST", `/api/runs/${wake.id}/steer`, { message: "x" })).status).toBe(200);
    const bare = (await t.call("POST", "/api/runs", { assignmentId: a.id })).json;
    expect((await t.call("POST", `/api/runs/${bare.id}/steer`, { message: "x" })).json.error.code).toBe("no_thread");
    await t.call("PATCH", `/api/runs/${kids[0].id}`, { outcome: "progressed", summary: "done", endedAt: new Date().toISOString() });
    const done = await t.call("POST", `/api/runs/${kids[0].id}/steer`, { message: "x" });
    expect(done.status).toBe(409);
    expect(done.json.error.code).toBe("not_running");
  });
});

// ---------- pure edits ----------

const LEDGER = `# EPIC-909: Demo

## Done means

- [ ] E909-1 First
- [x] E909-2 Second

## Current State

Status: active

## Issue Ledger

Steps: each is independently testable.

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| E909-S1 | Ticket worker | worker | First | done | none | none | main | none | 2026-10-20 | none |
| E909-S2 | Ticket worker | unassigned | Second | draft | none | none | main | none | 2026-10-20 | wait for ready |

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-20 | accepted | x | y | z | never |
`;

describe("Add: pure edits", () => {
  it("a ledger row follows the header, takes the next id and is a draft", () => {
    const r = addLedgerRow(LEDGER, { title: "Third thing", line: "does it | well" }, "2026-10-25");
    if ("skip" in r) throw new Error(r.skip);
    expect(r.id).toBe("E909-S3");
    const rows = r.text.split("\n").filter((l) => l.startsWith("| E909-S"));
    expect(rows).toHaveLength(3);
    expect(rows[2]).toBe("| E909-S3 | Ticket worker | unassigned | Third thing: does it / well | draft | none | none | main | none | 2026-10-25 | wait for ready |");
    expect(r.text.replace(rows[2] + "\n", "")).toBe(LEDGER); // nothing else moved
  });
  it("refuses a duplicate title, a spine without a ledger, and an id prefix it cannot tell", () => {
    expect(addLedgerRow(LEDGER, { title: "Second" }, "2026-10-25")).toMatchObject({ skip: expect.stringContaining("already has a row") });
    expect(addLedgerRow("# x\n\n## Done means\n\n- [ ] E901-1 a\n", { title: "t" }, "d")).toMatchObject({ skip: expect.stringContaining("no Issue Ledger") });
    expect(addLedgerRow("## Issue Ledger\n\n| Issue | Status |\n|---|---|\n| draft | draft |\n", { title: "t" }, "d")).toMatchObject({ skip: expect.stringContaining("prefix") });
  });
  it("the first row of a scaffolded ledger takes its prefix from Done means", () => {
    const text = "## Done means\n\n- [ ] E919-1 x\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| draft | first step | draft |\n";
    const r = addLedgerRow(text, { title: "Real" }, "d");
    if ("skip" in r) throw new Error(r.skip);
    expect(r.id).toBe("E919-S1");
    expect(r.text).toContain("| E919-S1 | Real | draft |");
  });
  it("a Done-means line is unticked, numbered after the last criterion and sits with the others", () => {
    const r = addDoneMeans(LEDGER, { title: "Third", line: "works on a phone" });
    if ("skip" in r) throw new Error(r.skip);
    expect(r.id).toBe("E909-3");
    expect(r.text).toContain("- [x] E909-2 Second\n- [ ] E909-3 Third: works on a phone\n\n## Current State");
    expect(addDoneMeans("## Done means\n\nnothing\n", { title: "t" })).toMatchObject({ skip: expect.stringContaining("numbered criterion") });
    expect(addDoneMeans(LEDGER, { title: "First" })).toMatchObject({ skip: expect.stringContaining("already has") });
  });
  it("CRLF files keep CRLF; input validation and slugs", () => {
    const crlf = LEDGER.replace(/\n/g, "\r\n");
    const r = addDoneMeans(crlf, { title: "New" });
    if ("skip" in r) throw new Error(r.skip);
    expect(r.text).toContain("- [ ] E909-3 New\r\n");
    expect(addIn({ kind: "nope", title: "x" })).toMatch(/kind must be/);
    expect(addIn({ kind: "row", title: "  " })).toBe("title is required");
    expect(addIn({ kind: "row", title: "x".repeat(121) })).toMatch(/under 120/);
    expect(addIn({ kind: "epic", title: "A  new\nthing", line: "one", path: " docs/x.md " })).toEqual({ kind: "epic", title: "A new thing", line: "one", path: "docs/x.md" });
    expect(slugOf("Phone: the “new” desk!")).toBe("phone-the-new-desk");
    expect(slugOf("???")).toBe("new-epic");
  });
});

// ---------- Add through the API (real git: bare origin + clone) ----------

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

const ROOT = `# EPIC: demo root

Spine profile: compact
Repository: demo
Primary document: docs/spines/root.md
Spine ID: demo-root
Root spine: self
Parent spine: none
Integration branch: main
Integration policy: main-direct

## Goal

Demo.

## Done means

- [ ] R-1 Something works.

## Current State

Owner: me
Status: active
Last attempted: none
Result: none
Evidence: none
Waiting on: none
Approved work: none
Next action: none
Source revision: main
Verified at: 2026-10-25

## Non-Goals

None.

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| R-S1 | Ticket worker | unassigned | Thing | draft | none | none | main | none | 2026-10-25 | none |

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-25 | accepted | x | y | z | never |

## Operating Learnings

None yet.
`;

describe("Add: through the API", () => {
  let tmp: string;
  let origin: string;
  let repo: string;
  let db: DB;
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  const skillDir = resolveSkillDir(process.env);
  const put = (rel: string, text: string, root = repo) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s3-add-"));
    origin = path.join(tmp, "origin.git");
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(tmp, "seed");
    git(tmp, "clone", "-q", origin, seed);
    git(seed, "checkout", "-q", "-b", "main");
    put("docs/spines/root.md", ROOT, seed);
    put("docs/spines/epic.md", LEDGER.replace("# EPIC-909: Demo\n", "# EPIC-909: Demo\n\nSpine profile: compact\nSpine ID: demo-epic\nPrimary document: docs/spines/epic.md\nRoot spine: [demo root](root.md)\nParent spine: [demo root](root.md)\nIntegration branch: main\nIntegration policy: main-direct\n"), seed);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "main");
    repo = path.join(tmp, "demo");
    git(tmp, "clone", "-q", origin, repo);
  });
  afterEach(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const boot = async () => {
    db = openDb(path.join(tmp, "console.db"));
    const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [], skillDir };
    const app = createApp(db, { read });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    const m = (await call("POST", "/api/milestones", { title: "Demo", repo: "Acme/demo", path: "docs/spines/epic.md" })).json;
    return { call, m };
  };
  const onOrigin = (rel: string) => git(origin, "show", `main:${rel}`);
  const head = () => git(origin, "rev-parse", "main");

  it("adds a draft ledger row: committed and pushed on main, in the existing format", async () => {
    const { call, m } = await boot();
    const r = await call("POST", `/api/milestones/${m.id}/tree/add`, { kind: "row", title: "Phone layout", line: "412 px check" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: "row", path: "docs/spines/epic.md", id: "E909-S3" });
    expect(r.json.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(onOrigin("docs/spines/epic.md")).toContain("| E909-S3 | Ticket worker | unassigned | Phone layout: 412 px check | draft | none | none | main | none | ");
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Add draft row E909-S3 to epic.md (via console)");
    expect(git(repo, "status", "--porcelain")).toBe("");
    // a repeat adds nothing
    const again = await call("POST", `/api/milestones/${m.id}/tree/add`, { kind: "row", title: "Phone layout", line: "412 px check" });
    expect(again.status).toBe(409);
  });

  it("adds a Done-means line", async () => {
    const { call, m } = await boot();
    const r = await call("POST", `/api/milestones/${m.id}/tree/add`, { kind: "done_means", title: "It works on a phone" });
    expect(r.status).toBe(201);
    expect(r.json.id).toBe("E909-3");
    expect(onOrigin("docs/spines/epic.md")).toContain("- [x] E909-2 Second\n- [ ] E909-3 It works on a phone\n");
  });

  it.skipIf(!skillDir)("adds a child epic through spine_new.py: new draft spine + Spine Map row, one commit, trackable", async () => {
    const { call, m } = await boot();
    const r = await call("POST", `/api/milestones/${m.id}/tree/add`, { kind: "epic", title: "Offline mode", line: "The console keeps working without the network" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ kind: "epic", path: "docs/spines/epic.md", newPath: "docs/spines/offline-mode.md" });
    const fresh = onOrigin("docs/spines/offline-mode.md");
    expect(fresh).toMatch(/^# EPIC-\d+: Offline mode/);
    expect(fresh).toContain("Status: draft");
    expect(fresh).toContain("The console keeps working without the network");
    expect(onOrigin("docs/spines/epic.md")).toMatch(/\| offline-mode \| child \| \[EPIC-\d+: Offline mode\]\(offline-mode\.md\)/);
    expect(git(origin, "show", "--name-only", "--format=", "main").split("\n").sort()).toEqual(["docs/spines/epic.md", "docs/spines/offline-mode.md"]);
    expect(execFileSync("python3", [path.join(skillDir!, "scripts", "validate_spine.py"), "--trackable", path.join(repo, "docs/spines/offline-mode.md")], { encoding: "utf8" })).toContain("trackable");
    // the same title again gets its own file, never an overwrite
    const two = await call("POST", `/api/milestones/${m.id}/tree/add`, { kind: "epic", title: "Offline mode" });
    expect(two.json.newPath).toBe("docs/spines/offline-mode-2.md");
  });

  it("refuses without writing: bad input, an unknown path, a dirty checkout, a gated policy", async () => {
    const { call, m } = await boot();
    const before = head();
    expect((await call("POST", `/api/milestones/${m.id}/tree/add`, { kind: "row" })).status).toBe(400);
    expect((await call("POST", `/api/milestones/${m.id}/tree/add`, { kind: "x", title: "t" })).status).toBe(400);
    expect((await call("POST", "/api/milestones/ms_nope/tree/add", { kind: "row", title: "t" })).status).toBe(404);
    const other = await call("POST", `/api/milestones/${m.id}/tree/add`, { kind: "row", title: "t", path: "docs/spines/root.md" });
    expect(other.status).toBe(400);
    put("scratch.txt", "dirty");
    const dirty = await call("POST", `/api/milestones/${m.id}/tree/add`, { kind: "row", title: "t" });
    expect(dirty.status).toBe(409);
    expect(dirty.json.error.message).toMatch(/uncommitted changes/);
    expect(head()).toBe(before);
  });
});

describe("writer.scaffold guards", () => {
  let tmp: string;
  let repo: string;
  let origin: string;
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s3-sc-"));
    origin = path.join(tmp, "origin.git");
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(tmp, "seed");
    git(tmp, "clone", "-q", origin, seed);
    git(seed, "checkout", "-q", "-b", "main");
    fs.mkdirSync(path.join(seed, "docs"), { recursive: true });
    fs.writeFileSync(path.join(seed, "docs/p.md"), "# p\n\nIntegration policy: main-direct\n");
    fs.writeFileSync(path.join(seed, "docs/other.md"), "other\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "main");
    repo = path.join(tmp, "r");
    git(tmp, "clone", "-q", origin, repo);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const w = createSpineWriter();
  const input = (scaffold: (dir: string) => Promise<any>) => ({ repoDir: repo, path: "docs/p.md", label: "t", msg: "scaffolded", body: "b", scaffold });

  it("commits and pushes exactly the files the script reports", async () => {
    const r = await w.scaffold(input(async (dir) => {
      fs.writeFileSync(path.join(dir, "docs/new.md"), "new\n");
      fs.appendFileSync(path.join(dir, "docs/p.md"), "more\n");
      return { ok: true, files: ["docs/new.md", "docs/p.md"] };
    }));
    expect(r.status).toBe("written");
    expect(git(origin, "show", "--name-only", "--format=%s", "main").split("\n").filter(Boolean)).toEqual(["scaffolded", "docs/new.md", "docs/p.md"]);
  });

  it("a script that touches anything else is reverted and refused; so is a failing script", async () => {
    const before = git(origin, "rev-parse", "main");
    const extra = await w.scaffold(input(async (dir) => {
      fs.writeFileSync(path.join(dir, "docs/new.md"), "new\n");
      fs.writeFileSync(path.join(dir, "docs/other.md"), "changed\n");
      return { ok: true, files: ["docs/new.md"] };
    }));
    expect(extra).toMatchObject({ status: "skipped", reason: expect.stringContaining("docs/other.md") });
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(repo, "docs/new.md"))).toBe(false);
    const bad = await w.scaffold(input(async (dir) => {
      fs.writeFileSync(path.join(dir, "docs/new.md"), "half\n");
      return { ok: false, error: "script blew up" };
    }));
    expect(bad).toMatchObject({ status: "skipped", reason: "script blew up" });
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(origin, "rev-parse", "main")).toBe(before);
  });

  it("is refused when the Integration policy is not main-direct", async () => {
    fs.writeFileSync(path.join(repo, "docs/p.md"), "# p\n\nIntegration policy: pr-approval\n");
    git(repo, "commit", "-qam", "gate");
    git(repo, "push", "-q", "origin", "main");
    const r = await w.scaffold(input(async (dir) => {
      fs.writeFileSync(path.join(dir, "docs/new.md"), "new\n");
      return { ok: true, files: ["docs/new.md"] };
    }));
    expect(r.status).toBe("skipped");
    expect(fs.existsSync(path.join(repo, "docs/new.md"))).toBe(false);
  });
});
