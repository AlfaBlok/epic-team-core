import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { createDesk, migrateDesk } from "../src/desk/desk.js";

/**
 * E948-S193 (follow-up of E948-S178, the owner closing it 23 Nov): on 22 Nov at 20:49Z and 20:59Z the desk's Add filed rows
 * from his words as drafts, "he has written nothing in the desk chat in the last 24 hours", though his voice notes of 20:47Z
 * to 20:58Z were in the Team desk thread. Cause: both Adds came a minute or two after a console restart, so the thread cache
 * was empty, and a full read starts at the thread's FIRST message (T3 with no position = position 0) and stops after 40
 * pages. Real pages are small (about 30 positions each), so 40 pages reached position 1251 of about 4,900 (16 Nov), and
 * readBack then marked the whole thread read. Now his words are read from the thread's end, back to 24 hours ago.
 */
const NOW = Date.parse("2026-11-22T20:59:20Z");
const HIS = "The inbox count is wrong again. It's showing three, but there is only two waiting for review and one in Urgent.";
const QUOTE = "It's showing three, but there is only two waiting for review and one in Urgent";

/** A T3 like the worker server's: a read with no position starts at position 0, and a page holds only a dozen messages. */
class SmallPageT3 implements T3Client {
  threads = new Map<string, { messages: T3ThreadMessage[]; items: number }>();
  reads = 0;
  private n = 0;
  push(threadId: string, role: "user" | "assistant", text: string, at: number) {
    const t = this.threads.get(threadId)!;
    const position = t.items;
    t.items += role === "assistant" ? 3 : 1; // a reply comes with two tool items
    t.messages.push({ itemId: `item_${position}`, position, role, text, status: "completed", truncated: false, updatedAt: new Date(at).toISOString() });
  }
  async listProjects() {
    return [{ id: "p_home", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo", repositoryIdentity: { displayName: "acme/home_repo" } }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { message?: string }) {
    const threadId = `desk_thread_${++this.n}`;
    this.threads.set(threadId, { messages: [], items: 0 });
    if (input.message) this.push(threadId, "user", input.message, Date.parse("2026-11-15T05:22:49Z"));
    return { threadId };
  }
  async sendToThread(threadId: string, message: string) {
    this.push(threadId, "user", message, NOW);
  }
  async readThreadStatus(threadId: string) {
    return { status: "idle", raw: { itemCount: this.threads.get(threadId)!.items } };
  }
  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    this.reads++;
    const all = (this.threads.get(threadId)?.messages ?? []).filter((m) => opts.afterPosition === undefined || m.position > opts.afterPosition);
    const page = all.slice(0, 12); // T3 caps a page by size, not by `limit`
    return { messages: page, nextPosition: page.length ? page[page.length - 1].position : (opts.afterPosition ?? null), hasMore: all.length > page.length, archived: false };
  }
}

class OneSeat implements Dispatcher {
  async pick() {
    return { seat: "seat4", providerInstanceId: "claudeAgent_seat4" };
  }
  async done() {}
}

let dir: string;
let db: DB;
let t3: SmallPageT3;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e948-s193-"));
  db = openDb(path.join(dir, "console.db"));
  migrateDesk(db);
  t3 = new SmallPageT3();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const deskOf = () => createDesk({ db, store: createStore(db), t3, dispatcher: new OneSeat(), publicUrl: "http://console.test", reposRoot: dir, now: () => NOW });

/** The Team desk thread of 22 Nov: a week of talk (about 5,000 items) from 15 Nov, then his notes of the evening. */
async function weekLongThread(): Promise<string> {
  const desk = deskOf();
  await desk.view();
  const tid = desk.current()!.threadId;
  const start = Date.parse("2026-11-15T06:00:00Z");
  const end = Date.parse("2026-11-22T20:40:00Z");
  const n = 1250;
  for (let i = 0; i < n; i++) {
    const at = start + ((end - start) * i) / n;
    t3.push(tid, "user", `[delivered] console line ${i}`, at);
    t3.push(tid, "assistant", `reply ${i}`, at + 1000);
  }
  t3.push(tid, "user", "In the objective sidebar, right now we have like a circle which has three colors.", Date.parse("2026-11-22T20:47:53Z"));
  t3.push(tid, "assistant", "Got it.", Date.parse("2026-11-22T20:48:30Z"));
  t3.push(tid, "user", HIS, Date.parse("2026-11-22T20:58:36Z"));
  return tid;
}

describe("E948-S193 the desk reads his words from the thread's end", () => {
  it("right after a console restart, the Add finds his note of a minute ago in a week-long thread", async () => {
    const tid = await weekLongThread();
    expect(t3.threads.get(tid)!.items).toBeGreaterThan(4_900);
    const restarted = deskOf(); // empty cache, as at 20:57:31Z
    t3.reads = 0;
    expect(await restarted.jordiWords(QUOTE)).toMatchObject({ text: HIS, at: "2026-11-22T20:58:36.000Z" });
    expect(t3.reads).toBeLessThan(40); // the last day only, not the week from its first message
  });

  it("a message he sends is in the very next read", async () => {
    await weekLongThread();
    const desk = deskOf();
    expect(await desk.jordiWords("words he has not said yet at all")).toMatch(/not in any of his desk messages/);
    await t3.sendToThread(desk.current()!.threadId, "Please check the tester table again before tonight.");
    expect(await desk.jordiWords("check the tester table again")).toMatchObject({ text: "Please check the tester table again before tonight." });
  });

  it("words older than a day still do not count, and the read stops once it passes a day", async () => {
    const desk = deskOf();
    await desk.view();
    const tid = desk.current()!.threadId;
    t3.push(tid, "user", "An old ask from two days ago about the inbox colours.", NOW - 2 * 86_400_000);
    for (let i = 0; i < 400; i++) t3.push(tid, "assistant", `reply ${i}`, NOW - 86_400_000 + i * 60_000);
    const restarted = deskOf();
    expect(await restarted.jordiWords("about the inbox colours")).toMatch(/he has written nothing in the desk chat/);
  });
});
