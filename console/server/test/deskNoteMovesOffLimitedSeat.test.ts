import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { createDesk, migrateDesk } from "../src/desk/desk.js";
import { SEAT_MOVE } from "../src/desk/session.js";

// E907-S3: the 20:00 digest (and every console note that must reach the owner) moves the desk off a limited seat, the
// same way his own send does (moveIfBlocked), instead of waiting days for headroom.
const BASE = "http://127.0.0.1:18799";
const PROJECTS = [{ id: "p_home_repo", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo", repositoryIdentity: { displayName: "acme/home_repo" } }];
const LIMIT = "seat5 limited until 2026-11-18T18:59:59Z";

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, T3ThreadMessage[]>();
  private n = 0;
  private pos = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  push(threadId: string, role: "user" | "assistant", text: string) {
    this.threads.get(threadId)!.push({ itemId: `i${++this.pos}`, position: this.pos, role, text, status: "completed", truncated: false, updatedAt: new Date().toISOString() });
  }
  async listProjects() {
    return PROJECTS;
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { message?: string; modelSelection?: any }) {
    this.calls.push({ op: "launchThread", args: input });
    const threadId = `desk${++this.n}`;
    this.threads.set(threadId, []);
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId } });
    this.push(threadId, "user", message);
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
  async readThreadMessages(threadId: string): Promise<T3MessagePage> {
    const messages = this.threads.get(threadId) ?? [];
    return { messages, nextPosition: messages.at(-1)?.position ?? null, hasMore: false, archived: false };
  }
}

/** hands out the seats in order (null = no seat with headroom). */
function dispatcher(seats: (string | null)[]): Dispatcher {
  let i = 0;
  return {
    async pick() {
      const seat = seats[Math.min(i++, seats.length - 1)];
      return seat ? { seat, providerInstanceId: `claudeAgent_${seat}` } : { seat: null, reason: "all seats busy" };
    },
    async done() {},
  } as Dispatcher;
}

let dir: string;
let db: DB;
let t3: FakeT3;
const block: Record<string, string> = {};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e907s3-"));
  db = openDb(path.join(dir, "console.db"));
  migrateDesk(db);
  t3 = new FakeT3();
  for (const k of Object.keys(block)) delete block[k];
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const deskOn = (seats: (string | null)[]) =>
  createDesk({ db, store: createStore(db), t3, dispatcher: dispatcher(seats), publicUrl: BASE, reposRoot: dir, sendWaitMs: 5, seatBlocked: (s) => (s ? block[s] : undefined) });

describe("E907-S3 a console note to the owner moves off a limited seat", () => {
  it("the 20:00 digest on a limited seat moves the desk to a seat with headroom and is delivered there", async () => {
    const desk = deskOn(["seat5", "seat2"]);
    await desk.view(); // desk1 on seat5
    t3.push("desk1", "assistant", "Sent you the 13 Nov digest.");
    block.seat5 = LIMIT;
    const res = await desk.tell("[social digest] acme-social 2026-11-15\nSend him this.", "social-digest-acme-social-2026-11-15");
    expect(res).toBe(true);
    expect(desk.current()).toMatchObject({ threadId: "desk2", seat: "seat2" });
    const launch = t3.ops("launchThread")[1].args;
    expect(launch.modelSelection.instanceId).toBe("claudeAgent_seat2");
    expect(launch.message).toContain("Sent you the 13 Nov digest."); // seeded with a summary of the old thread
    expect(t3.ops("sendToThread").map((c) => c.args)).toEqual([
      { threadId: "desk2", message: "[social digest] acme-social 2026-11-15\nSend him this.", clientRequestId: "social-digest-acme-social-2026-11-15" },
    ]);
    expect(db.prepare("SELECT thread_id, seat, end_reason FROM desk_session ORDER BY seq").all()).toEqual([
      { thread_id: "desk1", seat: "seat5", end_reason: `${SEAT_MOVE}${LIMIT}` },
      { thread_id: "desk2", seat: "seat2", end_reason: null },
    ]);
  });

  it("no seat with headroom: the note waits (never sent onto the limited seat) and the old thread stays", async () => {
    const desk = deskOn(["seat5", null]);
    await desk.view();
    block.seat5 = LIMIT;
    const res = await desk.tell("[social digest] acme-social 2026-11-15", "social-digest-x");
    expect(res).toBe(`desk seat ${LIMIT}: note waits for headroom`);
    expect(t3.ops("sendToThread")).toHaveLength(0);
    expect(desk.current()!.threadId).toBe("desk1");
  });

  it("a seat with headroom: the note goes to the live thread, no move", async () => {
    const desk = deskOn(["seat2", "seat3"]);
    await desk.view();
    expect(await desk.tell("hello", "n1")).toBe(true);
    expect(t3.ops("launchThread")).toHaveLength(1);
    expect(t3.ops("sendToThread").map((c) => c.args.threadId)).toEqual(["desk1"]);
  });
});

// 22 Nov outage: 88 receipts went into the busy desk one turn each, his voice notes waited behind them and were dropped.
describe("console lines wait while the desk is busy and go in together, never ahead of him", () => {
  it("a busy desk holds the lines; once idle they go in as ONE message, oldest first", async () => {
    let status = "idle";
    t3.readThreadStatus = async () => ({ status, raw: {} });
    const desk = deskOn(["seat2"]);
    await desk.view();
    status = "running";
    expect(await desk.tell("receipt one", "r1")).toBe(true);
    expect(await desk.tell("receipt two", "r2")).toBe(true);
    expect(await desk.tell("receipt two", "r2")).toBe(true); // the same line twice is held once
    expect(t3.ops("sendToThread")).toHaveLength(0);
    expect(desk.outbox().map((x) => x.crid)).toEqual(["r1", "r2"]);
    status = "completed";
    expect(await desk.flushOutbox()).toBe(2);
    const sent = t3.ops("sendToThread").map((c) => c.args);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain("2 lines, oldest first");
    expect(sent[0].message.indexOf("receipt one")).toBeLessThan(sent[0].message.indexOf("receipt two"));
    expect(desk.outbox()).toEqual([]);
    expect(await desk.flushOutbox()).toBe(0);
  });

  it("T3 queue not empty (his message waiting): the lines stay held", async () => {
    t3.readThreadStatus = async () => ({ status: "completed", raw: {} });
    (t3 as any).queuedCount = async () => 1;
    const desk = deskOn(["seat2"]);
    await desk.view();
    expect(await desk.tell("digest", "d1")).toBe(true);
    expect(t3.ops("sendToThread")).toHaveLength(0);
    (t3 as any).queuedCount = async () => 0;
    expect(await desk.flushOutbox()).toBe(1);
    expect(t3.ops("sendToThread").map((c) => c.args)).toEqual([{ threadId: "desk1", message: "digest", clientRequestId: "d1" }]);
  });
});

describe("22 Nov: T3's queue stuck on an idle desk is sent again as one message", () => {
  it("idle desk + queued messages for 2 ticks past QUEUE_STUCK_MS: cancelled from T3's queue and re-sent once", async () => {
    let t = Date.parse("2026-11-22T05:00:00Z");
    t3.readThreadStatus = async () => ({ status: "completed", raw: {} });
    let q = [
      { queuedRunId: "q1", text: "his words: why these failures all the time????", truncated: false },
      { queuedRunId: "q2", text: "↔ Passed to the other desk…", truncated: true },
    ];
    const cancelled: string[] = [];
    Object.assign(t3, {
      queueItems: async () => q,
      queueRead: async (_th: string, id: string) => `${id} whole text`,
      queueCancel: async (_th: string, id: string) => {
        cancelled.push(id);
        q = q.filter((x) => x.queuedRunId !== id);
      },
      queuedCount: async () => q.length,
    });
    const desk = createDesk({ db, store: createStore(db), t3, dispatcher: dispatcher(["seat2"]), publicUrl: BASE, reposRoot: dir, sendWaitMs: 5, now: () => t });
    await desk.view();
    expect(await desk.unstickQueue()).toBe(0); // first sight: maybe T3 is just about to start it
    t += 30_000;
    expect(await desk.unstickQueue()).toBe(0);
    t += 70_000;
    expect(await desk.unstickQueue()).toBe(2);
    expect(cancelled).toEqual(["q1", "q2"]);
    const sent = t3.ops("sendToThread").map((c) => c.args.message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("why these failures all the time????");
    expect(sent[0]).toContain("q2 whole text");
    expect(await desk.unstickQueue()).toBe(0);
  });

  it("a working desk never counts as stuck", async () => {
    t3.readThreadStatus = async () => ({ status: "running", raw: {} });
    Object.assign(t3, { queueItems: async () => [{ queuedRunId: "q1", text: "x", truncated: false }], queueCancel: async () => undefined });
    let t = 0;
    const desk = createDesk({ db, store: createStore(db), t3, dispatcher: dispatcher(["seat2"]), publicUrl: BASE, reposRoot: dir, sendWaitMs: 5, now: () => t });
    await desk.view();
    for (let i = 0; i < 5; i++) {
      t += 60_000;
      expect(await desk.unstickQueue()).toBe(0);
    }
  });
});
