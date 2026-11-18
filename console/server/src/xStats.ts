import fs from "node:fs";
import path from "node:path";
import { resolveRepo } from "./adapters/repos.js";
import { homeRepo } from "./identity.js";

/**
 * X stats of the team's six accounts: likes, replies, reposts and views per post, read only.
 * scripts/x_stats.py writes one file a day, `data/x-stats/<YYYY-MM-DD>.json` of the home repo (the repo is the record,
 * root L-45); this only reads them for the X stats page (GET /api/x-stats): the asked day (default the newest) in full,
 * and every day's totals per account so the page shows the change since the day before.
 */
export const X_STATS_DIR = "data/x-stats";

export interface XStatsPost {
  id: string;
  url: string;
  at: string;
  kind: string;
  text: string;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes?: number | null;
  views: number | null;
  source: string;
}
export interface XStatsTotals {
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  views: number;
}
export interface XStatsAccount {
  handle: string;
  /** x (default), reddit or tiktok: the same day file carries every channel's posts. */
  platform: string;
  product: string;
  state: string;
  listedBy: string | null;
  followers: number | null;
  postsAllTime: number | null;
  posts: XStatsPost[];
  count: number;
  totals: XStatsTotals;
  notes: string[];
  readAt: string;
}
export interface XStatsDay {
  date: string;
  readAt: string;
  windowDays: number;
  since: string;
  accounts: XStatsAccount[];
  note?: string;
}
export interface XStatsBody {
  dates: string[];
  day: XStatsDay | null;
  /** every stored day, oldest first: per account its totals, post count and followers. */
  history: { date: string; accounts: Record<string, XStatsTotals & { count: number; followers: number | null; state: string }> }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const TOTALS = ["likes", "replies", "reposts", "quotes", "views"] as const;

export function parseXStatsDay(text: string): XStatsDay {
  const d = JSON.parse(text) as Record<string, unknown>;
  const accounts = (Array.isArray(d.accounts) ? d.accounts : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof (a as { handle?: unknown }).handle === "string")
    .map((a) => {
      const posts = (Array.isArray(a.posts) ? a.posts : [])
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string")
        .map((p) => ({
          id: str(p.id), url: str(p.url), at: str(p.at), kind: str(p.kind) || "post", text: str(p.text),
          likes: num(p.likes), replies: num(p.replies), reposts: num(p.reposts), quotes: num(p.quotes), views: num(p.views), source: str(p.source),
        }));
      const t = (a.totals ?? {}) as Record<string, unknown>;
      return {
        handle: str(a.handle), platform: str(a.platform) || "x", product: str(a.product), state: str(a.state) || "not read", listedBy: str(a.listedBy) || null,
        followers: num(a.followers), postsAllTime: num(a.postsAllTime), posts, count: posts.length,
        totals: Object.fromEntries(TOTALS.map((k) => [k, num(t[k]) ?? 0])) as unknown as XStatsTotals,
        notes: Array.isArray(a.notes) ? a.notes.filter((n): n is string => typeof n === "string") : [],
        readAt: str(a.readAt),
      };
    });
  return { date: str(d.date), readAt: str(d.readAt), windowDays: num(d.windowDays) ?? 7, since: str(d.since), accounts, ...(d.note ? { note: str(d.note) } : {}) };
}

/** The home repo's X stats files, each read again when it changes. */
export function createXStatsReader(o: { reposRoot: string; home?: string }) {
  const cache = new Map<string, { mtime: number; day: XStatsDay }>();
  const read = (file: string): XStatsDay | null => {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const hit = cache.get(file);
      if (hit && hit.mtime === mtime) return hit.day;
      const day = parseXStatsDay(fs.readFileSync(file, "utf8"));
      cache.set(file, { mtime, day });
      return day;
    } catch {
      return null;
    }
  };
  return {
    get(date?: string): XStatsBody {
      const repo = resolveRepo(o.reposRoot, o.home ?? homeRepo())?.path;
      const dir = repo ? path.join(repo, X_STATS_DIR) : "";
      let dates: string[] = [];
      try {
        dates = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && DATE.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort();
      } catch {
        return { dates: [], day: null, history: [] };
      }
      const history = dates.flatMap((dt) => {
        const d = read(path.join(dir, `${dt}.json`));
        return d ? [{ date: dt, accounts: Object.fromEntries(d.accounts.map((a) => [a.handle, { ...a.totals, count: a.count, followers: a.followers, state: a.state }])) }] : [];
      });
      const want = date && DATE.test(date) && dates.includes(date) ? date : dates[dates.length - 1];
      return { dates, day: want ? read(path.join(dir, `${want}.json`)) : null, history };
    },
  };
}
