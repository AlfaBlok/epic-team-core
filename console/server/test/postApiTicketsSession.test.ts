import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { milestoneChatUrl, rowClosed } from "../src/tickets/sessions.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";

/** ticket sessions,: Discuss opens the milestone chat about the row; POST /api/tickets/session never launches a thread. */

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  gone = new Set<string>();
  private n = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  async listProjects() {
    return [{ id: "mcp:demo", title: "demo", workspaceRoot: "/x/demo", repositoryIdentity: { displayName: "acme/demo" } }];
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
    await new Promise((r) => setTimeout(r, 5));
    this.calls.push({ op: "launchThread", args: input });
    return { threadId: `thread_${++this.n}` };
  }
  async sendToThread() {}
  async readThreadStatus(threadId: string) {
    if (this.gone.has(threadId)) throw new Error("t3_thread_read: thread not found");
    return { status: "idle", raw: {} };
  }
}

class FakeDispatcher implements Dispatcher {
  released: string[] = [];
  seatless = false;
  async pick() {
    return this.seatless ? { seat: null, reason: "all busy" } : { seat: "seat2", providerInstanceId: "claudeAgent_seat2" };
  }
  async done(seat: string) {
    this.released.push(seat);
  }
}

const SPINE = (rows: string) => `# EPIC-909: Demo epic

Spine profile: compact
Spine ID: demo-epic
Primary document: docs/spines/epic.md
Root spine: self
Parent spine: none
Integration branch: main
Integration policy: main-direct

## Goal

Ship the demo so Sam can try it on his phone.

## Current State

Owner: Delivery manager
Status: active
Last attempted: nothing yet
Result: none
Waiting on: none
Next action: build S1
Verified at: 2026-10-25

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On |
|---|---|---|---|---|---|
${rows}

## Decisions

None.
`;
const ROWS = [
  "| E909-S1 | Ticket worker | Builder | Build the thing | ready | none |",
  "| E909-S2 | Ticket worker | unassigned | Unowned thing | draft | none |",
  "| E909-S3 | Ticket worker | Sam | Needs Sam's call | blocked | none |",
  "| E909-S4 | Ticket worker | Builder | Finished thing | done (abc123) | none |",
  "| E909-S5 | Ticket worker | Builder | Shipped thing | deployed (live on host1) | none |",
].join("\n");

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s5-"));
});
afterEach(() => {
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const writeSpine = (rows = ROWS) => fs.writeFileSync(path.join(tmp, "demo", "docs", "spines", "epic.md"), SPINE(rows));

function setup(o: { cycle?: boolean; seatless?: boolean; personas?: boolean } = {}) {
  const repo = path.join(tmp, "demo");
  fs.mkdirSync(path.join(repo, "docs", "spines"), { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  writeSpine();
  db = openDb(path.join(tmp, "console.db"));
  const t3 = new FakeT3();
  const dispatcher = new FakeDispatcher();
  dispatcher.seatless = !!o.seatless;
  const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, {
    read,
    cycle: { enabled: o.cycle !== false, t3, dispatcher, publicUrl: "http://127.0.0.1:18799", seatsFile: path.join(tmp, "seats.json"), runState: async () => undefined },
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const seed = async () => {
    const m = (await call("POST", "/api/milestones", { title: "Demo", repo: "Acme/demo", path: "docs/spines/epic.md" })).json;
    const builder = (await call("POST", "/api/personas", { name: "Builder", remit: "You build things carefully.", model: "sonnet" })).json;
    const dm = o.personas === false ? undefined : (await call("POST", "/api/personas", { name: "Delivery manager", remit: "You own delivery.", model: "opus" })).json;
    return { m, builder, dm };
  };
  return { t3, dispatcher, call, seed, session: (mid: string, row: string, extra: object = {}) => call("POST", "/api/tickets/session", { milestoneId: mid, row, ...extra }) };
}

const storeSession = (mid: string, row: string, thread: string) =>
  db
    .prepare(
      `INSERT INTO ticket_session (milestone_id, repo, spine_path, row_id, row_key, thread_id, persona_id, persona_name, created_at)
       VALUES (?, 'demo', 'docs/spines/epic.md', ?, ?, ?, 'p1', 'Builder', '2026-10-24T00:00:00Z')`,
    )
    .run(mid, row, row.toLowerCase(), thread);

describe("E919-S6 POST /api/tickets/session: the milestone chat, never a launch", () => {
  it("answers with this milestone's Chat tab about the row (page hint + chip) and launches nothing", async () => {
    const t = setup();
    const { m } = await t.seed();
    const r = await t.session(m.id, "E909-S1");
    expect(r.status).toBe(200);
    const chat = `http://127.0.0.1:18799/milestones/${m.id}?tab=chat&about=E909-S1&title=Build+the+thing`;
    expect(r.json).toEqual({ milestoneId: m.id, rowId: "E909-S1", title: "Build the thing", path: "docs/spines/epic.md", launched: false, link: chat, chat, page: "Demo · E909-S1" });
    // Unowned and the owner-owned rows too: nobody is picked, no seat taken, no thread, nothing stored.
    for (const row of ["E909-S2", "e909-s3"]) expect((await t.session(m.id, row)).json).toMatchObject({ launched: false });
    expect(t.t3.ops("launchThread")).toHaveLength(0);
    expect(t.dispatcher.released).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_session").get()).toEqual({ n: 0 });
  });

  it("works with the cycle off and with no seat (no T3 needed)", async () => {
    const t = setup({ cycle: false, seatless: true, personas: false });
    const { m } = await t.seed();
    expect((await t.session(m.id, "E909-S1")).json).toMatchObject({ launched: false, page: "Demo · E909-S1" });
  });

  it("a session launched before stays readable: listed, and returned with its thread link plus the chat link", async () => {
    const t = setup();
    const { m } = await t.seed();
    storeSession(m.id, "E909-S1", "thread_old");
    const r = await t.session(m.id, "E909-S1");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ threadId: "thread_old", launched: false, persona: { name: "Builder" }, page: "Demo · E909-S1" });
    expect(r.json.chat).toContain("tab=chat");
    expect((await t.call("GET", `/api/tickets/sessions?milestoneId=${m.id}`)).json.map((s: any) => s.threadId)).toEqual(["thread_old"]);
    expect(t.t3.ops("launchThread")).toHaveLength(0);
  });

  it("milestoneChatUrl: no double slash, id and title encoded, no title when none", () => {
    expect(milestoneChatUrl("http://c/", "ms 1", "X-1", "t&u")).toBe("http://c/milestones/ms%201?tab=chat&about=X-1&title=t%26u");
    expect(milestoneChatUrl("http://c", "m", "X-1")).toBe("http://c/milestones/m?tab=chat&about=X-1");
  });
});

describe("E918-S5 ticket sessions: closed rows", () => {
  it("rowClosed: done, merged, superseded, cancelled and deployed are closed; open words are not", () => {
    const c = (status: string, statusDetail?: string) => rowClosed({ status, statusDetail });
    expect(c("done", "done (abc123)")).toBe(true);
    expect(c("done", "merged 1a44941")).toBe(true);
    expect(c("done", "superseded by E909-S7")).toBe(true);
    expect(c("—", "deployed (36d80a0 live on host1)")).toBe(true);
    expect(c("ready")).toBe(false);
    expect(c("active", "review (merged 1a44941, deploying)")).toBe(false);
    expect(c("blocked", "blocked on Sam")).toBe(false);
    expect(c("—", "running (seat2)")).toBe(false);
  });

  it("a closed row: 409 row_closed", async () => {
    const t = setup();
    const { m } = await t.seed();
    for (const row of ["E909-S4", "E909-S5"]) {
      const r = await t.session(m.id, row);
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("row_closed");
    }
  });

  it("when the row closes its stored session is archived and no longer listed", async () => {
    const t = setup();
    const { m } = await t.seed();
    storeSession(m.id, "E909-S1", "thread_1");
    storeSession(m.id, "E909-S3", "thread_2");
    expect((await t.call("GET", `/api/tickets/sessions?milestoneId=${m.id}`)).json.map((s: any) => s.rowId)).toEqual(["E909-S1", "E909-S3"]);
    writeSpine(ROWS.replace("| Builder | Build the thing | ready |", "| Builder | Build the thing | done (f00d) |"));
    expect((await t.call("GET", `/api/tickets/sessions?milestoneId=${m.id}`)).json.map((s: any) => s.rowId)).toEqual(["E909-S3"]);
    expect(db.prepare("SELECT row_id, archive_reason FROM ticket_session WHERE archived_at IS NOT NULL").all()).toEqual([{ row_id: "E909-S1", archive_reason: "row closed" }]);
    expect((await t.session(m.id, "E909-S1")).status).toBe(409);
  });

  it("closing on a POST archives the stored session too", async () => {
    const t = setup();
    const { m } = await t.seed();
    storeSession(m.id, "E909-S1", "thread_1");
    writeSpine(ROWS.replace("| Builder | Build the thing | ready |", "| Builder | Build the thing | done |"));
    expect((await t.session(m.id, "E909-S1")).status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_session WHERE archived_at IS NULL").get()).toEqual({ n: 0 });
  });
});

describe("E918-S5 ticket sessions: errors", () => {
  it("validation, unknown milestone / row, a path outside the tree", async () => {
    const t = setup();
    const { m } = await t.seed();
    expect((await t.call("POST", "/api/tickets/session", { milestoneId: m.id })).status).toBe(400);
    expect((await t.session("nope", "E909-S1")).status).toBe(404);
    expect((await t.session(m.id, "E909-S99")).status).toBe(404);
    const r = await t.session(m.id, "E909-S1", { path: "docs/other.md" });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("not a spine in this milestone's tree");
    expect((await t.call("GET", "/api/tickets/sessions")).status).toBe(400);
  });
});
