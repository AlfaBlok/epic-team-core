import type { Post as FullPost } from "./types.js";

/** The fields of a posts-ledger row the numbers read (the web's sample rows have the same). */
type Post = Pick<FullPost, "id" | "date" | "kind" | "platform" | "status" | "replies" | "metrics" | "link" | "title" | "community">;
/** What the numbers are computed from: the export's posts and messages (the server's export or the web mock's sample). */
export interface KpiInput {
  posts?: Post[] | null;
  messages?: { chats: { id: string | null; platform: string | null }[]; messages: { chat: string | null; at: string | null; from: string | null }[] } | null;
}

/**
 * the social product performance view (top of Home). GET /api/tenants/:id/social/kpis[?repo=<name>] answers, per
 * platform (X, Reddit), five daily series and the best post, from what the repo already records:
 *  - posts: our top-level posts that went live (posts ledger, Kind post, status posted or measured), on their Date;
 *  - replies sent: our replies and outreach comments that went live, on their Date;
 *  - replies received: the Replies count of each live row of ours, on the day of that row, plus DMs from them (messages
 *    ledger, From them) on the day they came;
 *  - impressions: X impressions as the Reporter read them into Metrics, on the day of the post (Reddit shows none);
 *  - followers: the daily snapshot file below only (no earlier history exists anywhere), "collecting since" its first row.
 * The snapshot file `data/kpi-daily.md` is written by the console's recorder (recordKpis, once per UTC day per social
 * repo): followers read through the world's Team Browser (Reddit about.json, the X profile page), plus the ledger
 * totals at that moment. The repo is the source (L-45): nothing here is kept in console.db.
 * Best post per platform: the top-level post with the most impressions; Reddit gives no impressions, so there the most
 * comments, then score. The rule travels with the answer and is said on screen.
 */

export const KPI_FILE = "data/kpi-daily.md";
export const PLATFORMS = ["x", "reddit"] as const;
export type KpiPlatform = (typeof PLATFORMS)[number];
export const SERIES = ["posts", "repliesSent", "repliesReceived", "followers", "impressions", "likes", "postReplies"] as const;
export type SeriesKey = (typeof SERIES)[number];

export interface KpiPoint {
  date: string;
  value: number;
}
export interface KpiSeries {
  key: SeriesKey;
  /** First day the series has data; null = none yet. */
  since: string | null;
  /** One point per day from `since` to today (counts; zero on a quiet day); followers: only the days recorded. */
  points: KpiPoint[];
  /** "count" sums per day; "level" is a reading (followers). */
  kind: "count" | "level";
  /** What the numbers are, in one plain sentence (shown under the chart). */
  note: string;
  /** where the latest reading came from (likes and replies on posts: the Counts source cell and its time). */
  source?: string | null;
}
export interface BestPost {
  id: string;
  title: string | null;
  date: string | null;
  kind: string | null;
  community: string | null;
  link: string | null;
  impressions: number | null;
  comments: number | null;
  score: number | null;
  likes: number | null;
  replies: number | null;
  /** The Metrics cell as the Reporter wrote it. */
  metrics: string | null;
}
export interface PlatformKpis {
  platform: KpiPlatform;
  label: string;
  /** Our account on it, as the last snapshot read it (null = no snapshot yet). */
  account: string | null;
  series: Record<SeriesKey, KpiSeries>;
  best: BestPost | null;
}
export interface SocialKpisBody {
  tenantId: string;
  repo: string | null;
  /** The world's social repos (pack on, or a posts ledger), so a world with several can switch. */
  repos?: string[];
  today: string;
  bestRule: string;
  platforms: PlatformKpis[];
  recording: { file: string; since: string | null; last: string | null; rows: number };
}

export const BEST_RULE = "Best post: our top-level post with the most impressions. Reddit shows no impressions, so there it is the post with the most comments, then the highest score. Replies received count on the day of the post they answer.";

// ------------------------------------------------------------------------------------------------------------ parsing

const DAY = /^(\d{4}-\d{2}-\d{2})/;
export const dayOf = (s: string | null | undefined): string | null => (s ? (DAY.exec(s.trim())?.[1] ?? null) : null);
export function platformOf(s: string | null | undefined): KpiPlatform | null {
  const v = (s ?? "").trim().toLowerCase();
  if (/reddit/.test(v)) return "reddit";
  if (v === "x" || /twitter|x\.com/.test(v)) return "x";
  return null;
}
const LIVE = new Set(["posted", "measured"]);
export const isLive = (p: Post) => LIVE.has(String(p.status ?? "").toLowerCase());
const num = (s: string) => Number(s.replace(/,/g, ""));
/** "3 posts: 3 impressions (2/1/0)" → 3; "impressions not readable" → null. */
export function impressionsOf(metrics: string | null | undefined): number | null {
  const m = /(\d[\d,]*)\s+impressions?\b/i.exec(metrics ?? "");
  return m ? num(m[1]) : null;
}
export function commentsOf(metrics: string | null | undefined): number | null {
  const m = /(\d[\d,]*)\s+comments?\b/i.exec(metrics ?? "");
  return m ? num(m[1]) : null;
}
export function scoreOf(metrics: string | null | undefined): number | null {
  const m = /\bscore\s+(-?\d[\d,]*)/i.exec(metrics ?? "");
  return m ? num(m[1]) : null;
}
function countOf(metrics: string | null | undefined, word: string): number | null {
  const m = new RegExp(`(\\d[\\d,]*)\\s+${word}`, "i").exec(metrics ?? "");
  return m ? num(m[1]) : null;
}
export const firstUrl = (s: string | null | undefined): string | null => /https?:\/\/[^\s)|\]]+/.exec(s ?? "")?.[0] ?? null;

export interface SnapshotRow {
  date: string;
  platform: KpiPlatform;
  account: string | null;
  followers: number | null;
  posts: number | null;
  repliesSent: number | null;
  repliesReceived: number | null;
  impressions: number | null;
  readAt: string | null;
  note: string | null;
  /**
   * columns after Note (written by scripts/campaign_counts.py and, later, the console's recorder): the
   * public counts of our live top-level posts on the account, summed, at countsReadAt, and where each was read.
   */
  likes?: number | null;
  postReplies?: number | null;
  reposts?: number | null;
  newPosts24h?: number | null;
  countsReadAt?: string | null;
  countsSource?: string | null;
}
export const SNAPSHOT_HEADER = ["Date", "Platform", "Account", "Followers", "Posts", "Replies sent", "Replies received", "Impressions", "Read at", "Note"];

export function snapshotFileHead(): string {
  return [
    "# KPI daily",
    "",
    "One row per platform per UTC day, written by the console at its first check of the day. Followers are read from the account's profile through the Team Browser (read only). The other numbers are the posts and messages ledgers' totals at that moment: live posts, live replies and outreach, replies received (Replies cells plus DMs from them), X impressions as last measured. An empty cell means the read failed (see Note).",
    "",
    `| ${SNAPSHOT_HEADER.join(" | ")} |`,
    `|${SNAPSHOT_HEADER.map(() => "---").join("|")}|`,
    "",
  ].join("\n");
}

const cellNum = (s: string | undefined): number | null => (s && /^-?\d[\d,]*$/.test(s.trim()) ? num(s.trim()) : null);

export function parseSnapshots(text: string): SnapshotRow[] {
  const out: SnapshotRow[] = [];
  for (const line of text.split("\n")) {
    if (!/^\|\s*\d{4}-\d{2}-\d{2}/.test(line)) continue;
    const c = line.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
    const platform = platformOf(c[1]);
    const date = dayOf(c[0]);
    if (!platform || !date) continue;
    out.push({
      date,
      platform,
      account: c[2] || null,
      followers: cellNum(c[3]),
      posts: cellNum(c[4]),
      repliesSent: cellNum(c[5]),
      repliesReceived: cellNum(c[6]),
      impressions: cellNum(c[7]),
      readAt: c[8] || null,
      note: c[9] || null,
      likes: cellNum(c[10]),
      postReplies: cellNum(c[11]),
      reposts: cellNum(c[12]),
      newPosts24h: cellNum(c[13]),
      countsReadAt: c[14] || null,
      countsSource: c[15] || null,
    });
  }
  return out;
}


const esc = (s: string | number | null | undefined) => (s === null || s === undefined ? "" : String(s).replace(/\|/g, "/").replace(/\n/g, " "));
export function snapshotLine(r: SnapshotRow): string {
  const label = r.platform === "x" ? "X" : "Reddit";
  const counts = [r.likes, r.postReplies, r.reposts, r.newPosts24h, r.countsReadAt, r.countsSource];
  // the recorder's rows stay ten cells; a row that carries the counts keeps them.
  const tail = counts.some((v) => v !== null && v !== undefined) ? counts : [];
  return `| ${[r.date, label, r.account, r.followers, r.posts, r.repliesSent, r.repliesReceived, r.impressions, r.readAt, r.note, ...tail].map(esc).join(" | ")} |`;
}

// -------------------------------------------------------------------------------------------------------- the numbers

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-05" → "5 Nov" (notes are read by the owner, never an ISO date). */
export const shortDay = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= end && i < 2000; i++, d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

function countSeries(key: SeriesKey, byDay: Map<string, number>, today: string, note: string, emptyNote: string): KpiSeries {
  const days = [...byDay.keys()].sort();
  if (!days.length) return { key, since: null, points: [], kind: "count", note: emptyNote };
  const since = days[0];
  return { key, since, points: daysBetween(since, today).map((date) => ({ date, value: byDay.get(date) ?? 0 })), kind: "count", note };
}

const add = (m: Map<string, number>, day: string | null, n: number) => {
  if (day) m.set(day, (m.get(day) ?? 0) + n);
};

/**
 * Followers per day of one platform's readings: the day's reading (the last one wins). A campaign whose brief
 * lists accounts on the platform (`listed`, towerwatch-campaign's @TowerwatchHQ and @YieldDesk_data) has one row per
 * account a day; once any of them is read, the day's number is the sum of the listed accounts' readings and rows of an
 * account not listed (the world's own account the reads named before) are left out.
 */
export function followersByDay(snaps: SnapshotRow[], listed: string[] = []): Map<string, number> {
  return levelByDay(snaps, listed, (r) => r.followers);
}

/**
 * one reading per day of a level a snapshot row carries (followers, likes, replies on posts). With listed
 * accounts, only theirs count and the day sums them; otherwise the day's last reading wins (one account at a time).
 */
export function levelByDay(snaps: SnapshotRow[], listed: string[], pick: (r: SnapshotRow) => number | null | undefined): Map<string, number> {
  const acc = (r: { account: string | null } | string | null) => (typeof r === "string" || r === null ? r ?? "" : r.account ?? "").trim().toLowerCase().replace(/^@|^u\//, "");
  const want = new Set(listed.map((l) => acc(l)).filter(Boolean));
  const read = snaps.filter((r) => pick(r) !== null && pick(r) !== undefined);
  const own = want.size ? read.filter((r) => want.has(acc(r))) : [];
  const perDay = new Map<string, Map<string, number>>();
  for (const r of own.length ? own : read) {
    const day = perDay.get(r.date) ?? new Map<string, number>();
    day.set(own.length ? acc(r) : "", pick(r)!);
    perDay.set(r.date, day);
  }
  return new Map([...perDay].map(([d, m]) => [d, [...m.values()].reduce((a, b) => a + b, 0)]));
}

/** "2026-11-12T09:30:40Z" → "12 Nov 09:30 UTC" (null when it is not a time). */
const readTime = (s: string | null | undefined) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec((s ?? "").trim());
  return m ? `${shortDay(m[1])} ${m[2]} UTC` : null;
};

/** likes or replies on our posts, per day, as the daily count read (scripts/campaign_counts.py) wrote them. */
function countsSeries(key: "likes" | "postReplies", snaps: SnapshotRow[], listed: string[], what: string): KpiSeries {
  const pick = (r: SnapshotRow) => (key === "likes" ? r.likes : r.postReplies);
  const by = levelByDay(snaps, listed, pick);
  const days = [...by.keys()].sort();
  if (!days.length) return { key, since: null, points: [], kind: "level", note: `Not counted yet. ${what} are read once a day from now on.`, source: null };
  const last = [...snaps].filter((r) => pick(r) !== null && pick(r) !== undefined && r.date === days[days.length - 1]).pop();
  const at = readTime(last?.countsReadAt);
  // the cell also says where followers were read ("…; followers from …"): under likes only the posts' part matters.
  const posts = (last?.countsSource ?? "").split(/;\s*followers\b/i)[0].trim();
  const said = /^0 of 0 posts\b/i.test(posts) ? "no live post to count yet" : posts;
  const src = said ? `${said}${at ? `, read ${at}` : ""}` : at ? `read ${at}` : null;
  return {
    key,
    since: days[0],
    points: days.map((date) => ({ date, value: by.get(date)! })),
    kind: "level",
    note: `${what} on our live posts, added up, read once a day. Collecting since ${days[0]}.`,
    source: src,
  };
}

/** Ledger totals now, per platform (what a snapshot row records beside followers). */
export function ledgerTotals(data: KpiInput, platform: KpiPlatform) {
  const live = (data.posts ?? []).filter((p) => isLive(p) && platformOf(p.platform) === platform);
  const chats = new Map((data.messages?.chats ?? []).map((c) => [c.id, platformOf(c.platform)]));
  const start = (data.posts ?? []).filter(isLive).map((p) => dayOf(p.date)).filter((d): d is string => !!d).sort()[0];
  const dmsIn = (data.messages?.messages ?? []).filter((m) => {
    const day = dayOf(m.at);
    return String(m.from ?? "").toLowerCase() === "them" && chats.get(m.chat) === platform && !!start && !!day && day >= start;
  }).length;
  const xImp = live.map((p) => impressionsOf(p.metrics)).filter((n): n is number => n !== null);
  return {
    posts: live.filter((p) => p.kind === "post").length,
    repliesSent: live.filter((p) => p.kind === "reply" || p.kind === "outreach").length,
    repliesReceived: live.reduce((s, p) => s + (p.replies ?? 0), 0) + dmsIn,
    impressions: platform === "x" && xImp.length ? xImp.reduce((a, b) => a + b, 0) : null,
  };
}

export function bestPost(posts: Post[], platform: KpiPlatform): BestPost | null {
  const tops = posts.filter((p) => isLive(p) && p.kind === "post" && platformOf(p.platform) === platform && p.id);
  const scored = tops.map((p) => ({ p, imp: impressionsOf(p.metrics), com: commentsOf(p.metrics), sc: scoreOf(p.metrics) }));
  const key = (s: (typeof scored)[number]): [number, number, number] =>
    platform === "x" ? [s.imp ?? -1, s.p.replies ?? 0, 0] : [s.com ?? -1, s.sc ?? -1, s.p.replies ?? 0];
  const best = scored
    .filter((s) => (platform === "x" ? s.imp !== null : s.com !== null || s.sc !== null))
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return kb[0] - ka[0] || kb[1] - ka[1] || kb[2] - ka[2] || String(a.p.date).localeCompare(String(b.p.date));
    })[0];
  if (!best) return null;
  const p = best.p;
  return {
    id: p.id!,
    title: p.title,
    date: dayOf(p.date),
    kind: p.kind,
    community: p.community,
    link: firstUrl(p.link),
    impressions: best.imp,
    comments: best.com,
    score: best.sc,
    likes: countOf(p.metrics, "likes?"),
    replies: p.replies,
    metrics: p.metrics,
  };
}

/** The X date from which the Reporter wrote "impressions not readable" (the X API answered 402), if any. */
function viewsLostSince(live: Post[]): string | null {
  const m = live
    .map((p) => /not readable[^|]*?\bat (\d{4}-\d{2}-\d{2})/i.exec(p.metrics ?? "")?.[1] ?? (/not readable/i.test(p.metrics ?? "") ? dayOf(p.date) : null))
    .filter((d): d is string => !!d)
    .sort();
  return m[0] ?? null;
}

export function computeKpis(data: KpiInput, snapshots: SnapshotRow[], today: string, listed?: Partial<Record<KpiPlatform, string[]>>): Omit<SocialKpisBody, "tenantId" | "repo"> {
  const platforms: PlatformKpis[] = PLATFORMS.map((platform) => {
    const label = platform === "x" ? "X" : "Reddit";
    const live = (data.posts ?? []).filter((p) => isLive(p) && platformOf(p.platform) === platform);
    const posts = new Map<string, number>();
    const sent = new Map<string, number>();
    const received = new Map<string, number>();
    const impressions = new Map<string, number>();
    for (const p of live) {
      const day = dayOf(p.date);
      if (p.kind === "post") add(posts, day, 1);
      if (p.kind === "reply" || p.kind === "outreach") add(sent, day, 1);
      add(received, day, p.replies ?? 0);
      const imp = platform === "x" ? impressionsOf(p.metrics) : null;
      if (imp !== null) add(impressions, day, imp);
    }
    const chats = new Map((data.messages?.chats ?? []).map((c) => [c.id, platformOf(c.platform)]));
    // DMs from before the campaign's first live row (old chats of the account) are not this campaign's replies.
    const start = (data.posts ?? []).filter(isLive).map((p) => dayOf(p.date)).filter((d): d is string => !!d).sort()[0];
    for (const m of data.messages?.messages ?? []) {
      const day = dayOf(m.at);
      if (String(m.from ?? "").toLowerCase() === "them" && chats.get(m.chat) === platform && start && day && day >= start) add(received, day, 1);
    }

    const snaps = snapshots.filter((s) => s.platform === platform).sort((a, b) => a.date.localeCompare(b.date));
    const fol = new Map<string, number>();
    for (const [d, n] of followersByDay(snaps, listed?.[platform] ?? [])) fol.set(d, n);
    const folDays = [...fol.keys()].sort();
    const lost = platform === "x" ? viewsLostSince(live) : null;

    const series: Record<SeriesKey, KpiSeries> = {
      posts: countSeries("posts", posts, today, "Our new posts that went live.", "No post of ours is live yet."),
      repliesSent: countSeries("repliesSent", sent, today, "Our replies that went live.", "No reply of ours is live yet."),
      repliesReceived: countSeries(
        "repliesReceived",
        received,
        today,
        "Replies to us, plus DMs.",
        "Nothing of ours is live yet.",
      ),
      followers: folDays.length
        ? { key: "followers", since: folDays[0], points: folDays.map((date) => ({ date, value: fol.get(date)! })), kind: "level", note: `Read once a day. No earlier history exists, so we are collecting since ${folDays[0]}.` }
        : { key: "followers", since: null, points: [], kind: "level", note: "Not recorded yet. Read once a day from now on." },
      impressions:
        platform === "reddit"
          ? { key: "impressions", since: null, points: [], kind: "count", note: "Reddit does not show impressions." }
          : countSeries(
              "impressions",
              impressions,
              today,
              `Views read about 48 h after each post.${lost ? ` X has given no view counts since ${shortDay(lost)}.` : ""}`,
              "No view count read yet.",
            ),
      likes: countsSeries("likes", snaps, listed?.[platform] ?? [], "Likes"),
      postReplies: countsSeries("postReplies", snaps, listed?.[platform] ?? [], "Public replies"),
    };
    return { platform, label, account: (listed?.[platform]?.length ?? 0) > 1 ? listed![platform]!.join(" and ") : snaps.length ? snaps[snaps.length - 1].account : null, series, best: bestPost(data.posts ?? [], platform) };
  });
  const dates = snapshots.map((s) => s.date).sort();
  return { today, bestRule: BEST_RULE, platforms, recording: { file: KPI_FILE, since: dates[0] ?? null, last: dates[dates.length - 1] ?? null, rows: snapshots.length } };
}

