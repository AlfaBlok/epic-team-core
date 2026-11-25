import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import { runnerDispatcher } from "../src/t3/dispatcher.js";
import { createChatSession, migrateDeskSessions, SEND_WAIT_MS } from "../src/desk/session.js";

/**
 * his chat sends failed "Not sent: The console did not answer in 30 s" and worked on retry: before the send,
 * the console built his objectives block, up to 34 s on a busy main server. Now the console context before his words is built
 * after the reply: the send answers inside its short wait however slow the build, and the build still reaches T3.
 */

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

class SlowT3 implements T3Client {
  /** the next sends take the message, then never answer in time. */
  slow = 0;
  /** the next send takes the message, then answers some other error. */
  breakAfter = false;
  /** every send waits for this before T3 takes it (production 25 Nov: T3 took his typed sends 7 to 28 s after the post). */
  hold?: Promise<void>;
  sends: { message: string; crid?: string }[] = [];
  seen = new Set<string>();
  threads = new Map<string, T3ThreadMessage[]>();
  private n = 0;
  private pos = 0;
  async listProjects() {
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
    const threadId = `desk${++this.n}`;
    this.threads.set(threadId, []);
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, crid?: string) {
    if (this.hold) await this.hold;
    if (crid && this.seen.has(crid)) return; // a copy it already took is dropped
    if (crid) this.seen.add(crid);
    this.sends.push({ message, crid });
    this.push(threadId, "user", message);
    if (this.breakAfter) {
      this.breakAfter = false;
      throw new Error("tools/call t3_thread_send: socket hang up");
    }
    if (this.slow > 0) {
      this.slow--;
      throw timeout();
    }
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
  async readThreadMessages(threadId: string): Promise<T3MessagePage> {
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

function chat(o: { sendWaitMs?: number } = { sendWaitMs: 200 }) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-fast-send-"));
  db = openDb(path.join(dir, "d.db"));
  migrateDeskSessions(db);
  const t3 = new SlowT3();
  const dispatcher = runnerDispatcher(async (args) =>
    args[0] === "pick" ? JSON.stringify({ id: "seat1", via: "t3_delegate_task", providerInstanceId: "claudeAgent_seat1" }) : JSON.stringify({ ok: true }),
  );
  const c = createChatSession(
    { db, store: createStore(db), t3, dispatcher, ...o },
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
  return { t3, c };
}

describe("his chat send answers at once while the context before his words is still building", () => {
  it("an objectives build still running never holds the reply; the message reaches T3 with the block once it is built", async () => {
    const { t3, c } = chat();
    await c.view();
    let release!: (s: string) => void;
    const built = new Promise<string>((r) => (release = r));
    const t0 = Date.now();
    const r = await c.send("why we are always having these issues?", undefined, "crid-fast", () => built);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.pending).toBe(true);
    release("[his objectives]");
    await new Promise((r) => setTimeout(r, 50));
    const sent = t3.sends.find((s) => s.crid === "crid-fast");
    expect(sent?.message).toContain("[his objectives]");
    expect(sent?.message).toContain("why we are always having these issues?");
  });

  it("a build that fails sends his words without it", async () => {
    const { t3, c } = chat();
    await c.view();
    await c.send("still slow", undefined, "crid-fail", () => Promise.reject(new Error("scorecards down")));
    await new Promise((r) => setTimeout(r, 50));
    expect(t3.sends.find((s) => s.crid === "crid-fail")?.message).toContain("still slow");
  });
});

/**
 * The owner 25 Nov (vn_083b0ef7): "Why can't the console get the message at once? And then say to the front end, I got the
 * message. Go away." On production T3 took his typed sends 7 to 28 s after the post, and the console's answer waited
 * SEND_WAIT_MS (1.2 s) for it every time before saying pending. The app now says Sent on that answer, so it comes at once.
 */
describe("the console answers his send at once while T3 has not taken it", () => {
  it("20 sends to a T3 that takes 10 s: every answer comes back within the default wait, p95 under 500 ms", async () => {
    const { t3, c } = chat({});
    await c.view();
    let release!: () => void;
    t3.hold = new Promise<void>((r) => (release = r));
    const took: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = await c.send(`send ${i}`, undefined, `chat-e48s210-${i}`);
      took.push(performance.now() - t0);
      expect(r.pending).toBe(true);
    }
    const sorted = [...took].sort((a, b) => a - b);
    const p50 = sorted[9];
    const p95 = sorted[18];
    console.log(`20 sends, T3 holding them: p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${sorted[19].toFixed(0)} ms (SEND_WAIT_MS ${SEND_WAIT_MS})`);
    expect(p95).toBeLessThan(500);
    // T3 comes back: every one of them still reaches the thread, in his order
    release();
    for (let i = 0; i < 100 && t3.sends.length < 20; i++) await new Promise((r) => setTimeout(r, 20));
    expect(t3.sends.map((s) => s.crid)).toEqual(Array.from({ length: 20 }, (_, i) => `chat-e48s210-${i}`));
  }, 60_000);
});
