import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import { runnerDispatcher } from "../src/t3/dispatcher.js";
import { createChatSession, migrateDeskSessions } from "../src/desk/session.js";

/**
 * the owner's chat said "Not sent: The operation was aborted due to timeout" under a message the desk had: T3 took the
 * send but did not answer in time. Now a send T3 does not answer in time is kept and sent again with the same request id
 * (T3 drops a copy it already took), never shown as a failure; an error left from before goes once the message shows.
 */

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

class SlowT3 implements T3Client {
  /** the next sends take the message, then never answer in time. */
  slow = 0;
  /** the next send takes the message, then answers some other error. */
  breakAfter = false;
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

function chat() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-timeout-"));
  db = openDb(path.join(dir, "d.db"));
  migrateDeskSessions(db);
  const t3 = new SlowT3();
  const dispatcher = runnerDispatcher(async (args) =>
    args[0] === "pick" ? JSON.stringify({ id: "seat1", via: "t3_delegate_task", providerInstanceId: "claudeAgent_seat1" }) : JSON.stringify({ ok: true }),
  );
  const c = createChatSession(
    { db, store: createStore(db), t3, dispatcher, sendWaitMs: 200 },
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

describe("a send T3 does not answer in time is sent, never a false Not sent", () => {
  it("the timed-out send is kept, re-sent with the same id, and the chat never shows an error; T3 keeps one copy", async () => {
    const { t3, c } = chat();
    await c.view();
    t3.slow = 1;
    const r = await c.send("Nothing is working, man", undefined, "crid-1");
    expect(r).toMatchObject({ pending: true, queued: true });
    const v = await c.view();
    expect(v.sendError).toBeUndefined();
    await c.flushQueued();
    expect(t3.sends.filter((s) => s.crid === "crid-1")).toHaveLength(1);
    const after = await c.view();
    expect(after.sendError).toBeUndefined();
    expect(after.queued).toBeUndefined();
    expect(after.messages.filter((m) => m.role === "user" && m.text.includes("Nothing is working, man"))).toHaveLength(1);
  });

  it("an error shown for a send whose message is in the thread after all goes on the next read", async () => {
    const { t3, c } = chat();
    await c.view();
    t3.breakAfter = true;
    await c.send("Why is it so slow", undefined, "crid-2").catch(() => undefined);
    // the old read: the message is there, yet the chat said Not sent
    const v = await c.view();
    expect(v.sendError).toBeUndefined();
    expect(v.messages.some((m) => m.role === "user" && m.text.includes("Why is it so slow"))).toBe(true);
  });
});
