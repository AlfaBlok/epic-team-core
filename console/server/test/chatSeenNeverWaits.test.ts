import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createChatUnread, type ReplyTimes } from "../src/desk/unread.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * opening a chat marks it seen (POST /api/chat/seen). That mark read T3 first and waited however long it took:
 * 30 to 114 s on production 2026-11-13 while the worker server's tunnel dropped calls. It now waits at most seenWaitMs,
 * then marks from the snapshot it has; the read finishes in the background.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let dir: string;
let db: DB;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-seen-"));
  db = openDb(path.join(dir, "c.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function unread(delayMs: number, times: ReplyTimes) {
  let reads = 0;
  const u = createChatUnread({
    db,
    seenWaitMs: 50,
    chatOf: () => ({
      replyTimes: async () => {
        reads++;
        await sleep(delayMs);
        return times;
      },
    }),
  });
  return { u, reads: () => reads };
}

describe("marking a chat seen never waits on a slow T3", () => {
  it("a slow read: the mark answers within seenWaitMs and is written", async () => {
    const { u } = unread(2_000, { threadId: "t", replies: ["2020-01-01T00:00:00.000Z"] });
    const t0 = Date.now();
    const r = await u.markSeen("team");
    expect(Date.now() - t0).toBeLessThan(400);
    expect(r.unread).toBe(0);
    const row = db.prepare("SELECT seen_at FROM chat_seen WHERE desk_key = 'team'").get() as { seen_at: string };
    expect(Date.parse(row.seen_at)).toBeGreaterThan(Date.now() - 5_000);
  });

  it("a quick read is still used: a reply stamped ahead of the clock is marked seen", async () => {
    const ahead = new Date(Date.now() + 60_000).toISOString();
    const { u } = unread(0, { threadId: "t", replies: [ahead] });
    const r = await u.markSeen("team");
    expect(r.seenAt).toBe(ahead);
    expect(r.unread).toBe(0);
  });
});
