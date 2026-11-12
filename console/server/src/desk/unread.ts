import type { DB } from "../db.js";

/**
 * unread replies per chat (the Team desk `team`, each milestone's Chat tab `milestone:<id>`, a world's team desk
 * `world-desk:<world>`), for the Chat and sidebar pills. A chat's unread = the finished replies the owner would see that arrived
 * after both the last time he opened it (`chat_seen`) and his own newest message there (writing means he was reading).
 *
 * Cheap on the request path: the counts read a snapshot per live chat (reply times only, kept in memory); a read older than
 * `staleMs` starts one background pass over the live chats (each an incremental T3 read past the chat's settled cursor,
 * shared with the chat page's own reads), never awaited by the request.
 */
export function migrateChatSeen(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_seen (
      desk_key TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL
    );
  `);
}

export interface ReplyTimes {
  threadId: string;
  /** When each finished reply arrived (T3's updatedAt). */
  replies: string[];
  /** the owner's own newest message in the thread. */
  lastOwnAt?: string;
  /** the newest reply's text (the phone notification's body). */
  lastText?: string;
}

/** The replies after both marks (Date.parse: T3 and the console write ISO times, compared as instants). */
export function unreadOf(t: ReplyTimes, seenAt?: string): number {
  const marks = [seenAt, t.lastOwnAt].map((x) => (x ? Date.parse(x) : NaN)).filter((x) => !isNaN(x));
  const after = marks.length ? Math.max(...marks) : -Infinity;
  return t.replies.filter((at) => Date.parse(at) > after).length;
}

export interface ChatUnreadDeps {
  db: DB;
  /** The chat engine of a key (undefined: unknown or gone milestone / world); `replyTimes` never launches a thread. */
  chatOf: (key: string) => { replyTimes: () => Promise<ReplyTimes | undefined> } | undefined;
  now?: () => number;
  /** A snapshot this old starts a background pass on the next read (default 20 s; 0 = every read). */
  staleMs?: number;
  /** Runs the background pass outside the request that started it (the app: unscoped, every world's chats). */
  detach?: <T>(fn: () => T) => T;
}

export function createChatUnread(d: ChatUnreadDeps) {
  migrateChatSeen(d.db);
  const now = d.now ?? Date.now;
  const staleMs = d.staleMs ?? 20_000;
  const snaps = new Map<string, ReplyTimes>();
  let passAt: number | undefined;
  let passing: Promise<void> | undefined;

  const liveKeys = () => (d.db.prepare("SELECT DISTINCT desk_key FROM desk_session WHERE ended_at IS NULL").all() as { desk_key: string }[]).map((r) => r.desk_key);
  const seenOf = (key: string) => (d.db.prepare("SELECT seen_at FROM chat_seen WHERE desk_key = ?").get(key) as { seen_at: string } | undefined)?.seen_at;

  async function read(key: string): Promise<void> {
    try {
      const t = await d.chatOf(key)?.replyTimes();
      if (t) snaps.set(key, t);
      else snaps.delete(key);
    } catch {
      /* T3 down or the thread unreadable: keep the last snapshot */
    }
  }

  /** One pass over every live chat, one at a time (concurrent callers share it). */
  function refresh(): Promise<void> {
    passing ??= (async () => {
      const keys = liveKeys();
      for (const k of [...snaps.keys()]) if (!keys.includes(k)) snaps.delete(k);
      for (const k of keys) await read(k);
      passAt = now();
    })().finally(() => {
      passing = undefined;
    });
    return passing;
  }

  return {
    refresh,
    /**
     * Unread per chat key among `keys` (only keys with a live chat appear; a chat never opened has none), from the last
     * snapshot. `ready` = at least one pass finished (before it, the pills show nothing rather than a low number).
     */
    counts(keys: (k: string) => boolean): { ready: boolean; byKey: Record<string, number> } {
      if (passAt === undefined || now() - passAt >= staleMs) void (d.detach ?? ((f) => f()))(refresh).catch(() => undefined);
      const byKey: Record<string, number> = {};
      for (const [k, t] of snaps) if (keys(k)) byKey[k] = unreadOf(t, seenOf(k));
      return { ready: passAt !== undefined, byKey };
    },
    /** one chat read fresh, with its seen mark (the phone notification's check that the owner has not read it). */
    async peek(key: string): Promise<(ReplyTimes & { seenAt?: string }) | undefined> {
      await read(key);
      const t = snaps.get(key);
      const seenAt = seenOf(key);
      return t ? { ...t, ...(seenAt ? { seenAt } : {}) } : undefined;
    },
    /**
     * the owner opened the chat: everything there now is seen. The mark is the later of now and the newest reply known (so a
     * reply stamped a moment ahead of this clock is not counted again); the snapshot is read again right away.
     */
    async markSeen(key: string): Promise<{ key: string; seenAt: string; unread: number }> {
      await read(key);
      const t = snaps.get(key);
      const newest = Math.max(now(), ...(t?.replies ?? []).map((at) => Date.parse(at)).filter((x) => !isNaN(x)));
      const seenAt = new Date(newest).toISOString();
      d.db.prepare("INSERT INTO chat_seen (desk_key, seen_at) VALUES (?, ?) ON CONFLICT(desk_key) DO UPDATE SET seen_at = excluded.seen_at").run(key, seenAt);
      return { key, seenAt, unread: t ? unreadOf(t, seenAt) : 0 };
    },
  };
}
export type ChatUnread = ReturnType<typeof createChatUnread>;
