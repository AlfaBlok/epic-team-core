import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import { resolveRepo } from "./adapters/repos.js";
import { homeRepo } from "./identity.js";
import { X_STATS_DIR } from "./xStats.js";

/**
 * Every post measured once a day into one store, so status can be read from it and broken down any way: per message,
 * channel, campaign or post, against a plan.
 *
 * The record stays the repo: scripts/x_stats.py reads every post once a day (the channels it cannot read say why) into
 * data/x-stats/<date>.json, each post tagged with its campaign, ledger row and Plan message. This loads each day file
 * into one table, `post_stats`, one row per post per day (a live post nobody could read is a row too, every number
 * empty and `not_measured` saying why: never a 0 that means unknown), plus `post_stats_channels` (per day, campaign and
 * channel: live posts, measured, DMs or why not). A file is loaded again when it changes. GET /api/post-stats queries it.
 */

export interface PostStatRow {
  date: string;
  channel: string;
  postId: string;
  account: string | null;
  product: string | null;
  campaign: string | null;
  ledgerRow: string | null;
  message: string | null;
  url: string;
  postedAt: string | null;
  kind: string;
  measured: boolean;
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  dms: number | null;
  /** what each empty number means: field -> why ("all" for a post nobody could read). */
  notMeasured: Record<string, string>;
  /** views, likes and replies gained since the day before (null when either day has no number). */
  gained: { views: number | null; likes: number | null; replies: number | null };
  readAt: string;
  source: string;
}
export interface PostStatsChannel {
  date: string;
  campaign: string;
  product: string;
  channel: string;
  livePosts: number;
  accountPosts: number | null;
  measured: number;
  dms: number | null;
  /** conversations not in the day before's inbox reading (null: no reading the day before). */
  dmsNew: number | null;
  /** links of the conversations counted in `dms` (never a word of a message). */
  dmLinks: string[];
  dmsWhy: string | null;
  notMeasured: string | null;
}
export interface PostStatsGroup {
  key: string;
  posts: number;
  measured: number;
  /** null when no post of the group has that number. */
  views: number | null;
  likes: number | null;
  replies: number | null;
  gained: { views: number | null; likes: number | null; replies: number | null };
}
export interface PostStatsQuery {
  date?: string;
  product?: string;
  campaign?: string;
  channel?: string;
  message?: string;
  group?: string;
}
export interface PostStatsBody {
  dates: string[];
  date: string | null;
  group: string;
  groups: PostStatsGroup[];
  posts: PostStatRow[];
  channels: PostStatsChannel[];
  how: string;
}

/** One reply someone wrote to us under one of our posts. */
export interface ReplyToUs {
  channel: string; id: string; product: string | null; account: string | null; postId: string | null; postUrl: string | null;
  postKind: string | null; ledgerRow: string | null; url: string | null; by: string | null; text: string | null; at: string | null;
  /** one of ours answers it; null when it could not be told. */
  answered: boolean | null;
}
export interface ReplyRead {
  channel: string; account: string | null; product: string | null; state: string; why: string | null;
  posts: number | null; read: number | null; counted: number | null; listed: number | null;
}
export interface RepliesToUs {
  /** the newest day file that read the replies (null: none has yet). */
  date: string | null;
  readAt: string | null;
  comments: ReplyToUs[];
  reads: ReplyRead[];
  /** per channel, the last day its replies were read at all. */
  lastRead: Record<string, string>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GROUPS = ["message", "channel", "message-channel", "campaign", "post"] as const;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
export const POST_STATS_HOW =
  "One row per post per day, read once a day by scripts/x_stats.py (data/x-stats/<date>.json, the record) and loaded here; " +
  "numbers are totals as read that day, gained = since the day before; an empty number says why in notMeasured.";

export function migratePostStats(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_stats (
      date TEXT NOT NULL, channel TEXT NOT NULL, post_id TEXT NOT NULL, account TEXT, product TEXT, campaign TEXT,
      ledger_row TEXT, message TEXT, url TEXT NOT NULL, posted_at TEXT, kind TEXT NOT NULL, measured INTEGER NOT NULL,
      views INTEGER, likes INTEGER, replies INTEGER, reposts INTEGER, dms INTEGER, not_measured TEXT NOT NULL,
      read_at TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (date, channel, post_id));
    CREATE INDEX IF NOT EXISTS post_stats_message ON post_stats(campaign, message, date);
    CREATE TABLE IF NOT EXISTS post_stats_channels (
      date TEXT NOT NULL, campaign TEXT NOT NULL, product TEXT, channel TEXT NOT NULL, live_posts INTEGER NOT NULL,
      account_posts INTEGER, measured INTEGER NOT NULL, dms INTEGER, dms_why TEXT, not_measured TEXT,
      PRIMARY KEY (date, campaign, channel));
    CREATE TABLE IF NOT EXISTS post_stats_files (date TEXT PRIMARY KEY, mtime REAL NOT NULL, loaded_at TEXT NOT NULL);
  `);
  // DMs read from each channel's inbox: how many are new since the day before, and their links
  const cols = new Set((db.prepare("PRAGMA table_info(post_stats_channels)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("dms_new")) db.exec("ALTER TABLE post_stats_channels ADD COLUMN dms_new INTEGER");
  if (!cols.has("dm_links")) db.exec("ALTER TABLE post_stats_channels ADD COLUMN dm_links TEXT");
  // the replies people wrote to us under our posts (who, what, when, answered), and per channel
  // whether they could be read that day (the day file's `comments` / `commentsRead`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_stats_comments (
      date TEXT NOT NULL, channel TEXT NOT NULL, comment_id TEXT NOT NULL, product TEXT, account TEXT, post_id TEXT,
      post_url TEXT, post_kind TEXT, ledger_row TEXT, url TEXT, by_who TEXT, text TEXT, at TEXT, answered INTEGER,
      PRIMARY KEY (date, channel, comment_id));
    CREATE TABLE IF NOT EXISTS post_stats_comment_reads (
      date TEXT NOT NULL, channel TEXT NOT NULL, account TEXT NOT NULL, product TEXT, state TEXT NOT NULL, why TEXT,
      posts INTEGER, read INTEGER, counted INTEGER, listed INTEGER, PRIMARY KEY (date, channel, account));
  `);
}

/** One day file into the store (replaces that day's rows). Exported for the tests. */
export function loadPostStatsDay(db: DB, text: string, mtime = 0): number {
  const d = JSON.parse(text) as Record<string, unknown>;
  const date = str(d.date);
  if (!date || !DATE.test(date)) return 0;
  const readAt = str(d.readAt) ?? "";
  const ins = db.prepare(`INSERT OR REPLACE INTO post_stats (date, channel, post_id, account, product, campaign, ledger_row, message, url,
    posted_at, kind, measured, views, likes, replies, reposts, dms, not_measured, read_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insCh = db.prepare(`INSERT OR REPLACE INTO post_stats_channels (date, campaign, product, channel, live_posts, account_posts, measured,
    dms, dms_why, not_measured, dms_new, dm_links) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM post_stats WHERE date = ?").run(date);
    db.prepare("DELETE FROM post_stats_channels WHERE date = ?").run(date);
    for (const a of Array.isArray(d.accounts) ? (d.accounts as Record<string, unknown>[]) : []) {
      const channel = str(a.platform) ?? "x";
      for (const p of Array.isArray(a.posts) ? (a.posts as Record<string, unknown>[]) : []) {
        const id = str(p.id);
        if (!id) continue;
        const nm = p.notMeasured && typeof p.notMeasured === "object" ? (p.notMeasured as Record<string, string>) : {};
        ins.run(date, channel, id, str(a.handle), str(p.product) ?? str(a.product), str(p.campaign), str(p.ledgerRow), str(p.message),
          str(p.url) ?? "", str(p.at), str(p.kind) ?? "post", 1, num(p.views), num(p.likes), num(p.replies), num(p.reposts), num(p.dms),
          JSON.stringify(nm), str(a.readAt) ?? readAt, str(p.source) ?? "");
        n++;
      }
    }
    for (const m of Array.isArray(d.missing) ? (d.missing as Record<string, unknown>[]) : []) {
      const channel = str(m.platform);
      const id = str(m.id) ?? str(m.url);
      if (!channel || !id) continue;
      ins.run(date, channel, id, null, str(m.product), str(m.campaign), str(m.ledgerRow), str(m.message), str(m.url) ?? "", str(m.date),
        "post", 0, null, null, null, null, null, JSON.stringify({ all: str(m.why) ?? "not read on this day" }), readAt, "not measured");
      n++;
    }
    for (const c of Array.isArray(d.channels) ? (d.channels as Record<string, unknown>[]) : []) {
      const campaign = str(c.campaign);
      const channel = str(c.channel);
      if (!campaign || !channel) continue;
      insCh.run(date, campaign, str(c.product), channel, num(c.livePosts) ?? 0, num(c.accountPosts), num(c.measured) ?? 0, num(c.dms),
        str(c.dmsWhy), str(c.notMeasured), num(c.dmsNew),
        JSON.stringify(Array.isArray(c.dmLinks) ? (c.dmLinks as unknown[]).filter((l): l is string => typeof l === "string") : []));
    }
    db.prepare("DELETE FROM post_stats_comments WHERE date = ?").run(date);
    db.prepare("DELETE FROM post_stats_comment_reads WHERE date = ?").run(date);
    const insCm = db.prepare(`INSERT OR REPLACE INTO post_stats_comments (date, channel, comment_id, product, account, post_id, post_url, post_kind,
      ledger_row, url, by_who, text, at, answered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of Array.isArray(d.comments) ? (d.comments as Record<string, unknown>[]) : []) {
      const channel = str(c.channel);
      const id = str(c.id);
      if (!channel || !id) continue;
      insCm.run(date, channel, id, str(c.product), str(c.account), str(c.postId), str(c.postUrl), str(c.postKind), str(c.ledgerRow), str(c.url),
        str(c.by), str(c.text), str(c.at), c.answered === true ? 1 : c.answered === false ? 0 : null);
    }
    const insRd = db.prepare(`INSERT OR REPLACE INTO post_stats_comment_reads (date, channel, account, product, state, why, posts, read, counted, listed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of Array.isArray(d.commentsRead) ? (d.commentsRead as Record<string, unknown>[]) : []) {
      const channel = str(r.channel);
      if (!channel) continue;
      insRd.run(date, channel, str(r.account) ?? str(r.product) ?? "", str(r.product), str(r.state) ?? "not read", str(r.why), num(r.posts), num(r.read), num(r.counted), num(r.listed));
    }
    db.prepare("INSERT OR REPLACE INTO post_stats_files (date, mtime, loaded_at) VALUES (?, ?, ?)").run(date, mtime, new Date().toISOString());
  })();
  return n;
}

type Raw = {
  date: string; channel: string; post_id: string; account: string | null; product: string | null; campaign: string | null;
  ledger_row: string | null; message: string | null; url: string; posted_at: string | null; kind: string; measured: number;
  views: number | null; likes: number | null; replies: number | null; reposts: number | null; dms: number | null;
  not_measured: string; read_at: string; source: string;
};
const minus = (a: number | null, b: number | null | undefined) => (a == null || b == null ? null : a - b);
const sum = (xs: (number | null)[]) => (xs.some((x) => x != null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);

/** The store, loaded from the home repo's day files on each query (only files that changed are read again). */
export function createPostStats(o: { db: DB; reposRoot: string; home?: string; dir?: () => string | null }) {
  migratePostStats(o.db);
  const dir = o.dir ?? (() => {
    const repo = resolveRepo(o.reposRoot, o.home ?? homeRepo())?.path;
    return repo ? path.join(repo, X_STATS_DIR) : null;
  });
  const sync = (): string[] => {
    const d = dir();
    let files: string[] = [];
    try {
      files = d ? fs.readdirSync(d).filter((f) => f.endsWith(".json") && DATE.test(f.slice(0, -5))).sort() : [];
    } catch {
      files = [];
    }
    const known = new Map((o.db.prepare("SELECT date, mtime FROM post_stats_files").all() as { date: string; mtime: number }[]).map((r) => [r.date, r.mtime]));
    for (const f of files) {
      const file = path.join(d!, f);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (known.get(f.slice(0, -5)) !== mtime) loadPostStatsDay(o.db, fs.readFileSync(file, "utf8"), mtime);
      } catch {
        /* a half-written file is read on the next query */
      }
    }
    return (o.db.prepare("SELECT date FROM post_stats_files ORDER BY date").all() as { date: string }[]).map((r) => r.date);
  };
  return {
    sync,
    /**
     * The replies people wrote to us under our posts, from the newest day file that read them, and
     * per channel and account how that day's read went plus the last day each channel was read at all.
     */
    replies(): RepliesToUs {
      sync();
      const date = (o.db.prepare("SELECT max(date) AS d FROM post_stats_comment_reads").get() as { d: string | null }).d;
      if (!date) return { date: null, readAt: null, comments: [], reads: [], lastRead: {} };
      const readAt = (o.db.prepare("SELECT max(read_at) AS r FROM post_stats WHERE date = ?").get(date) as { r: string | null }).r;
      const comments = (o.db.prepare("SELECT * FROM post_stats_comments WHERE date = ? ORDER BY at DESC").all(date) as Record<string, unknown>[]).map((c) => ({
        channel: String(c.channel), id: String(c.comment_id), product: str(c.product), account: str(c.account), postId: str(c.post_id),
        postUrl: str(c.post_url), postKind: str(c.post_kind), ledgerRow: str(c.ledger_row), url: str(c.url), by: str(c.by_who),
        text: str(c.text), at: str(c.at), answered: c.answered == null ? null : !!c.answered,
      }));
      const reads = (o.db.prepare("SELECT * FROM post_stats_comment_reads WHERE date = ? ORDER BY channel, account").all(date) as Record<string, unknown>[]).map((r) => ({
        channel: String(r.channel), account: str(r.account), product: str(r.product), state: String(r.state), why: str(r.why),
        posts: num(r.posts), read: num(r.read), counted: num(r.counted), listed: num(r.listed),
      }));
      const lastRead: Record<string, string> = {};
      for (const r of o.db.prepare("SELECT channel, max(date) AS d FROM post_stats_comment_reads WHERE state != 'not read' GROUP BY channel").all() as { channel: string; d: string }[])
        lastRead[r.channel] = r.d;
      return { date, readAt, comments, reads, lastRead };
    },
    query(q: PostStatsQuery = {}): PostStatsBody {
      const dates = sync();
      const date = q.date && DATE.test(q.date) && dates.includes(q.date) ? q.date : dates[dates.length - 1] ?? null;
      const group = (GROUPS as readonly string[]).includes(q.group ?? "") ? q.group! : "message";
      if (!date) return { dates, date: null, group, groups: [], posts: [], channels: [], how: POST_STATS_HOW };
      const where = ["date = ?"];
      const args: string[] = [date];
      for (const [col, v] of [["product", q.product], ["campaign", q.campaign], ["channel", q.channel], ["message", q.message]] as const) {
        if (!v) continue;
        if (col === "message" && v === "none") where.push("message IS NULL");
        else if (col === "product") (where.push("lower(product) = lower(?)"), args.push(v));
        else (where.push(`${col} = ?`), args.push(v));
      }
      const rows = o.db.prepare(`SELECT * FROM post_stats WHERE ${where.join(" AND ")} ORDER BY channel, posted_at DESC`).all(...args) as Raw[];
      const prevDate = dates[dates.indexOf(date) - 1];
      const prev = new Map<string, Raw>();
      if (prevDate)
        for (const r of o.db.prepare("SELECT * FROM post_stats WHERE date = ?").all(prevDate) as Raw[]) prev.set(`${r.channel}|${r.post_id}`, r);
      const posts: PostStatRow[] = rows.map((r) => {
        const b = prev.get(`${r.channel}|${r.post_id}`);
        return {
          date: r.date, channel: r.channel, postId: r.post_id, account: r.account, product: r.product, campaign: r.campaign,
          ledgerRow: r.ledger_row, message: r.message, url: r.url, postedAt: r.posted_at, kind: r.kind, measured: !!r.measured,
          views: r.views, likes: r.likes, replies: r.replies, reposts: r.reposts, dms: r.dms,
          notMeasured: JSON.parse(r.not_measured) as Record<string, string>,
          gained: { views: minus(r.views, b?.views), likes: minus(r.likes, b?.likes), replies: minus(r.replies, b?.replies) },
          readAt: r.read_at, source: r.source,
        };
      });
      const keyOf = (p: PostStatRow) =>
        group === "post" ? `${p.channel}|${p.postId}`
          : group === "channel" ? p.channel
          : group === "campaign" ? p.campaign ?? "none"
          : group === "message-channel" ? `${p.message ? `M${p.message}` : "none"}|${p.channel}`
          : p.message ? `M${p.message}` : "none";
      const by = new Map<string, PostStatRow[]>();
      for (const p of posts) by.set(keyOf(p), [...(by.get(keyOf(p)) ?? []), p]);
      const groups = [...by.entries()]
        .map(([key, ps]) => ({
          key, posts: ps.length, measured: ps.filter((p) => p.measured).length,
          views: sum(ps.map((p) => p.views)), likes: sum(ps.map((p) => p.likes)), replies: sum(ps.map((p) => p.replies)),
          gained: { views: sum(ps.map((p) => p.gained.views)), likes: sum(ps.map((p) => p.gained.likes)), replies: sum(ps.map((p) => p.gained.replies)) },
        }))
        .sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
      const chWhere = ["date = ?"];
      const chArgs: string[] = [date];
      if (q.campaign) (chWhere.push("campaign = ?"), chArgs.push(q.campaign));
      if (q.product) (chWhere.push("lower(product) = lower(?)"), chArgs.push(q.product));
      if (q.channel) (chWhere.push("channel = ?"), chArgs.push(q.channel));
      const channels = (o.db.prepare(`SELECT * FROM post_stats_channels WHERE ${chWhere.join(" AND ")} ORDER BY campaign, channel`).all(...chArgs) as Record<string, unknown>[]).map((c) => ({
        date: String(c.date), campaign: String(c.campaign), product: String(c.product ?? ""), channel: String(c.channel),
        livePosts: Number(c.live_posts), accountPosts: num(c.account_posts), measured: Number(c.measured), dms: num(c.dms),
        dmsNew: num(c.dms_new), dmLinks: links(c.dm_links), dmsWhy: str(c.dms_why), notMeasured: str(c.not_measured),
      }));
      return { dates, date, group, groups, posts, channels, how: POST_STATS_HOW };
    },
  };
}

function links(v: unknown): string[] {
  try {
    const a = JSON.parse(String(v ?? "[]")) as unknown;
    return Array.isArray(a) ? a.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}
