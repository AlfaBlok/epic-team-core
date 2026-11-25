import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { T3Error, T3UnavailableError, t3DownReason, withT3Retry, type T3Client, type T3MessagePage, type T3ThreadMessage } from "../src/t3/client.js";
import { runnerDispatcher } from "../src/t3/dispatcher.js";
import { createChatSession, migrateDeskSessions, NOT_DELIVERED_AFTER_MS } from "../src/desk/session.js";

/* fake T3 copied from t3DownTypedChat.test.ts, plus a queue: a send T3 takes into its queue never shows in the thread */
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
  /** T3 takes sends into its queue and never starts them (22 Nov after a T3 restart). */
  queueing = false;
  queue: { threadId: string; message: string }[] = [];
  /** T3 starts what sat in its queue: each lands in the thread. */
  drain() {
    for (const q of this.queue.splice(0)) this.push(q.threadId, "user", q.message);
  }
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
    if (this.queueing) {
      this.queue.push({ threadId, message });
      return;
    }
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

function chat(reason?: () => "restarting" | "maintenance", clock?: { t: number }) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "typed-undelivered-"));
  db = openDb(path.join(dir, "d.db"));
  migrateDeskSessions(db);
  const t3 = new FlakyT3();
  const dispatcher = runnerDispatcher(async (args) =>
    args[0] === "pick" ? JSON.stringify({ id: "seat1", via: "t3_delegate_task", providerInstanceId: "claudeAgent_seat1" }) : JSON.stringify({ ok: true }),
  );
  const c = createChatSession(
    { db, store: createStore(db), t3, dispatcher, sendWaitMs: 200, ...(reason ? { t3DownReason: reason } : {}), ...(clock ? { now: () => clock.t } : {}) },
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


/**
 * his 22 Nov chat, three typed messages of 03:00 to 03:30Z sat in T3's queue after a T3 restart and reached the
 * desk at 05:02Z; his screen showed nothing ("everything seems broken. tempted to give up."). A typed message the desk's
 * thread does not show 2 minutes after he sent it now comes back in the view as `undelivered`, with why, until it lands.
 */
describe("a typed message that has not reached the desk says so", () => {
  const start = Date.parse("2026-11-22T03:00:00Z");

  it("a typed send stuck in T3's queue is undelivered after 2 minutes, with why and when, and leaves once it lands", async () => {
    const clock = { t: start };
    const { t3, c } = chat(undefined, clock);
    await c.view(); // the thread exists
    t3.queueing = true;
    await c.send("everything seems broken. tempted to give up.", undefined, "chat-aaa");
    expect((await c.view()).undelivered).toBeUndefined(); // just sent: the chat's own Sending bubble covers it
    clock.t = start + NOT_DELIVERED_AFTER_MS + 1_000;
    const v = await c.view();
    expect(v.undelivered).toHaveLength(1);
    expect(v.undelivered![0]).toMatchObject({ id: "chat-aaa", text: "everything seems broken. tempted to give up.", at: new Date(start).toISOString() });
    expect(v.undelivered![0].why).toMatch(/queue/);
    t3.drain(); // T3 starts it (05:02Z)
    clock.t += 60_000;
    expect((await c.view()).undelivered).toBeUndefined();
    t3.queueing = false;
    expect((await c.view()).undelivered).toBeUndefined(); // landed stays landed
  });

  it("a typed send the thread shows at once is never reported", async () => {
    const clock = { t: start };
    const { c } = chat(undefined, clock);
    await c.view();
    await c.send("hello desk", "Team home", "chat-bbb");
    await c.view();
    clock.t = start + 10 * NOT_DELIVERED_AFTER_MS;
    expect((await c.view()).undelivered).toBeUndefined();
  });

  it("a stuck message re-sent inside one longer console message counts as landed", async () => {
    const clock = { t: start };
    const { t3, c } = chat(undefined, clock);
    await c.view();
    t3.queueing = true;
    await c.send("where is my page?", undefined, "chat-ccc");
    clock.t = start + NOT_DELIVERED_AFTER_MS + 1_000;
    expect((await c.view()).undelivered).toHaveLength(1);
    t3.queue.splice(0);
    const tid = t3.sends.at(-1)!.threadId;
    t3.push(tid, "user", "[console] re-sent from a stuck T3 queue: 1 message\n--- 1 of 1 ---\nwhere is my page?");
    expect((await c.view()).undelivered).toBeUndefined();
  });

  it("console sends (not typed by him) and voice notes are never watched", async () => {
    const clock = { t: start };
    const { t3, c } = chat(undefined, clock);
    await c.view();
    t3.queueing = true;
    await c.send("[delivered] x", undefined, "desk-delivered-1");
    await c.send("🎙 Voice note", undefined, "voice-note-chat-vn_1");
    clock.t = start + 10 * NOT_DELIVERED_AFTER_MS;
    expect((await c.view()).undelivered).toBeUndefined();
  });

  it("a send held by the console while T3 is down shows as queued, and as undelivered once T3 took it but never started it", async () => {
    const clock = { t: start };
    const { t3, c } = chat(() => "restarting", clock);
    await c.view();
    t3.down = true;
    const r = await c.send("are you there?", undefined, "chat-ddd");
    expect(r.queued).toBe(true);
    expect((await c.view()).queued).toHaveLength(1);
    t3.down = false;
    t3.queueing = true; // back after the restart, but its queue does not move
    await c.view(); // T3 answered: the held send is delivered into T3's queue
    await c.flushQueued();
    clock.t = start + NOT_DELIVERED_AFTER_MS + 1_000;
    const v = await c.view();
    expect(v.queued).toBeUndefined();
    expect(v.undelivered?.map((u) => u.id)).toEqual(["chat-ddd"]);
  });
});
