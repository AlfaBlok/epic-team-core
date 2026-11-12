import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { T3Error, T3UnavailableError, t3DownReason, withT3Retry, type T3Client, type T3MessagePage, type T3ThreadMessage } from "../src/t3/client.js";
import { runnerDispatcher } from "../src/t3/dispatcher.js";
import { createChatSession, migrateDeskSessions } from "../src/desk/session.js";

/**
 * on 2026-11-02 05:42:56-05:50:27Z T3 on the main server was stopped on purpose and the a social world repo
 * Chat showed `tools/call t3_thread_read: fetch failed (ECONNREFUSED 127.0.0.1:3773) after 3 attempts`. Now: (1) T3 down is a
 * T3UnavailableError and the chat keeps its last good transcript with `t3: restarting`; (2) a send while T3 is down is stored
 * and delivered once it is back with its original clientRequestId; (3) a maintenance marker makes it `maintenance`.
 */

/** What undici throws while nothing listens on T3's port. */
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:3773" } });
/** A T3 call while T3 is down, through the client's real 3-attempt retry (no backoff in tests). */
const downCall = (tool: string) => withT3Retry(`tools/call ${tool}`, async () => Promise.reject(refused()), [0, 0], async () => undefined);

class FlakyT3 implements T3Client {
  down = false;
  /** Sends T3 took (threadId, message, clientRequestId). */
  sends: { threadId: string; message: string; crid?: string }[] = [];
  /** T3 drops a repeated clientRequestId, as its dispatch receipts do. */
  seen = new Set<string>();
  /** Fail the next send with a refusal AFTER T3 took it (the answer was lost). */
  loseNextAnswer = false;
  threads = new Map<string, T3ThreadMessage[]>();
  private n = 0;
  private pos = 0;
  private gate = async (tool: string) => {
    if (this.down) await downCall(tool);
  };
  async listProjects() {
    await this.gate("t3_project_list");
    return [{ id: "p", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  push(threadId: string, role: "user" | "assistant", text: string) {
    this.threads.get(threadId)!.push({ itemId: `i${++this.pos}`, position: this.pos, role, text, status: "completed", truncated: false, updatedAt: new Date().toISOString() });
  }
  async launchThread(input: { message?: string }) {
    await this.gate("t3_thread_launch");
    const threadId = `desk${++this.n}`;
    this.threads.set(threadId, []);
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, crid?: string) {
    await this.gate("t3_thread_send");
    if (crid && this.seen.has(crid)) return; // duplicate dropped
    if (crid) this.seen.add(crid);
    this.sends.push({ threadId, message, crid });
    this.push(threadId, "user", message);
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      this.down = true;
      await downCall("t3_thread_send");
    }
  }
  async readThreadStatus() {
    await this.gate("t3_thread_read");
    return { status: "idle", raw: {} };
  }
  async readThreadMessages(threadId: string): Promise<T3MessagePage> {
    await this.gate("t3_thread_read");
    const messages = this.threads.get(threadId) ?? [];
    return { messages, nextPosition: messages.at(-1)?.position ?? null, hasMore: false, archived: false };
  }
}

let db: DB | undefined;
let dir: string | undefined;
afterEach(() => {
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  db = dir = undefined;
});

function chat(reason?: () => "restarting" | "maintenance") {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s53-"));
  db = openDb(path.join(dir, "d.db"));
  migrateDeskSessions(db);
  const t3 = new FlakyT3();
  const dispatcher = runnerDispatcher(async (args) =>
    args[0] === "pick" ? JSON.stringify({ id: "seat1", via: "t3_delegate_task", providerInstanceId: "claudeAgent_seat1" }) : JSON.stringify({ ok: true }),
  );
  const c = createChatSession(
    { db, store: createStore(db), t3, dispatcher, sendWaitMs: 200, ...(reason ? { t3DownReason: reason } : {}) },
    {
      key: "milestone:m1",
      repo: "home_repo",
      title: "Repo desk",
      personaName: "Repo desk",
      remit: () => "r",
      seedMarker: "[repo-desk seed]",
      updateMarker: "[repo-desk update]",
      seedVersion: 1,
      seed: () => "[repo-desk seed]",
      update: () => "[repo-desk update]",
      unavailable: "off",
    },
  );
  return { t3, c, db: db! };
}

describe("T6-S53 (1) T3 down is typed, and the chat keeps its last good transcript", () => {
  it("refused after the retries is a T3UnavailableError (still a T3Error, same message)", async () => {
    const e = await downCall("t3_thread_read").catch((x) => x);
    expect(e).toBeInstanceOf(T3UnavailableError);
    expect(e).toBeInstanceOf(T3Error);
    expect(e.message).toBe("tools/call t3_thread_read: fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3773) after 3 attempts");
  });

  it("a read while T3 is down answers with the last good messages and t3: restarting, never the raw error", async () => {
    const { t3, c } = chat(() => "restarting");
    await c.view();
    t3.push("desk1", "assistant", "Placed it under PLAN-18.");
    const good = await c.view();
    expect(good.t3).toBeUndefined();
    t3.down = true;
    const v = await c.view(); // the old code threw DeskError 502 "tools/call t3_thread_read: fetch failed (ECONNREFUSED …)"
    expect(v.available).toBe(true);
    expect(v.t3).toBe("restarting");
    expect(v.threadId).toBe("desk1");
    expect(v.messages.map((m) => m.text)).toEqual(good.messages.map((m) => m.text));
    expect(v.messages.at(-1)?.text).toBe("Placed it under PLAN-18.");
    expect(JSON.stringify(v)).not.toMatch(/ECONNREFUSED|fetch failed/);
    t3.down = false;
    expect((await c.view()).t3).toBeUndefined(); // back: the line goes
  });

  it("T3 down before the chat was ever read: an empty chat with the quiet line, no thread relaunched", async () => {
    const { t3, c } = chat(() => "restarting");
    t3.down = true;
    const v = await c.view();
    expect(v).toMatchObject({ available: true, t3: "restarting", messages: [], working: false });
    expect(c.current()).toBeUndefined();
  });
});

describe("T6-S53 (2) a send while T3 is down is stored and delivered once, with its clientRequestId", () => {
  it("queued in the console DB, shown as queued, delivered when T3 is back, never twice", async () => {
    const { t3, c, db } = chat(() => "restarting");
    await c.view();
    t3.down = true;
    const r = await c.send("move it to PLAN-17", "M6 · Milestone", "chat-abc");
    expect(r).toEqual({ threadId: "desk1", pending: true, queued: true });
    expect(db.prepare("SELECT client_request_id, text, sent_at FROM desk_outbox").all()).toEqual([{ client_request_id: "chat-abc", text: "move it to PLAN-17", sent_at: null }]);
    // the browser retries the same POST: stored once
    await c.send("move it to PLAN-17", "M6 · Milestone", "chat-abc");
    const later = await c.send("and close T6-S1", undefined, "chat-def"); // behind the first, in order
    expect(later.queued).toBe(true);
    const v = await c.view();
    expect(v.t3).toBe("restarting");
    expect(v.queued?.map((q) => [q.text, q.page])).toEqual([
      ["move it to PLAN-17", "M6 · Milestone"],
      ["and close T6-S1", undefined],
    ]);
    expect(await c.flushQueued()).toBe(0); // still down: nothing sent, nothing failed
    expect(t3.sends).toEqual([]);

    t3.down = false;
    expect(await c.flushQueued()).toBe(2);
    expect(t3.sends.map((s) => [s.crid, s.message])).toEqual([
      ["chat-abc", "[page: M6 · Milestone]\nmove it to PLAN-17"],
      ["chat-def", "and close T6-S1"],
    ]);
    expect(await c.flushQueued()).toBe(0);
    const after = await c.view();
    expect(after.queued).toBeUndefined();
    expect(after.messages.filter((m) => m.text === "move it to PLAN-17")).toHaveLength(1);
  });

  it("a send whose answer was lost to the restart is queued and re-sent with the same id: T3 keeps one copy", async () => {
    const { t3, c } = chat(() => "restarting");
    await c.view();
    t3.loseNextAnswer = true;
    const r = await c.send("ship it", undefined, "chat-xyz");
    expect(r).toMatchObject({ pending: true, queued: true });
    t3.down = false;
    await c.flushQueued();
    expect(t3.sends.filter((s) => s.message === "ship it")).toHaveLength(1);
    expect((await c.view()).messages.filter((m) => m.text === "ship it")).toHaveLength(1);
  });

  it("the next read after T3 is back delivers the queue by itself", async () => {
    const { t3, c } = chat(() => "restarting");
    await c.view();
    t3.down = true;
    await c.send("hello again", undefined, "chat-1");
    t3.down = false;
    await c.view();
    await c.flushQueued(); // waits for the pass the read started
    expect(t3.sends.map((s) => s.crid)).toEqual(["chat-1"]);
  });
});

describe("T6-S53 (3) planned maintenance", () => {
  it("t3DownReason: a marker file under home = maintenance, none = restarting", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "e6s53h-"));
    try {
      expect(t3DownReason(home)).toBe("restarting");
      fs.mkdirSync(path.join(home, ".t3/runtime"), { recursive: true });
      fs.writeFileSync(path.join(home, ".t3/runtime/.service-stopping"), "");
      expect(t3DownReason(home)).toBe("maintenance");
      fs.rmSync(path.join(home, ".t3/runtime/.service-stopping"));
      fs.mkdirSync(path.join(home, "team_m0"), { recursive: true });
      fs.writeFileSync(path.join(home, "team_m0/PAUSE_WATCHDOG"), "");
      expect(t3DownReason(home)).toBe("maintenance");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("the chat says maintenance while a marker exists", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "e6s53m-"));
    try {
      fs.mkdirSync(path.join(home, "team_m0"));
      fs.writeFileSync(path.join(home, "team_m0/PAUSE_WATCHDOG"), "");
      const { t3, c } = chat(() => t3DownReason(home));
      await c.view();
      t3.down = true;
      expect((await c.view()).t3).toBe("maintenance");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
