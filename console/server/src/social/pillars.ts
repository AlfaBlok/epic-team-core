/**
 * The owner's voice note of 24 Nov: "what are the pillars of our communication?
 * ... we need to be measuring what pillars are we touching on ... so many posts on this, so many posts on that ... And how
 * are these posts performing ... What's the feedback loop?". The pillars are the product's benefits: the numbered lines
 * of the brief's `## Benefits` table, hard-defined in the repo (only the owner edits them). Each post names the pillar(s) it
 * touches in its `Benefit` cell (`2`, or `1, 5`). This counts, per pillar, the posts that touch it (planned and live) and
 * how the live ones did (views, likes, replies from the Reporter's Metrics cell), plus the posts that name no pillar.
 * Pure: the console's Pillars tab and the Writer brief both read it.
 */

export interface PillarLine {
  id: string | null;
  benefit: string | null;
}

export interface PillarPost {
  id: string | null;
  kind?: string | null;
  status?: string | null;
  platform?: string | null;
  title?: string | null;
  link?: string | null;
  replies?: number | null;
  metrics?: string | null;
  benefit?: string | null;
}

export interface PillarPerf {
  /** top-level posts live (posted or measured). */
  live: number;
  /** live posts with a reading in their Metrics cell. */
  measured: number;
  views: number;
  likes: number;
  replies: number;
  /** views per measured post, rounded; null with none measured. */
  viewsPerPost: number | null;
}

export interface PillarStat extends PillarPerf {
  id: string;
  benefit: string;
  /** every top-level post that touches it, pulled ones left out. */
  posts: number;
  /** drafted, held or scheduled: touches it but not out yet. */
  planned: number;
  /** its share of all pillar touches, 0..100 rounded. */
  share: number;
  /** its live post with the most views (then likes, then replies). */
  best: { id: string; title: string; link: string | null; views: number; likes: number; replies: number } | null;
  postIds: string[];
}

export interface PillarStats {
  pillars: PillarStat[];
  /** top-level posts (pulled left out) whose Benefit cell names no pillar of the table. */
  offPillar: { count: number; ids: string[] };
  /** top-level posts counted (pulled left out). */
  total: number;
}

const LIVE = new Set(["posted", "measured"]);
const GONE = new Set(["pulled", "expired"]);
const num = (s: string) => Number(s.replace(/,/g, ""));
const countOf = (metrics: string | null | undefined, word: string): number | null => {
  const m = new RegExp(`(\\d[\\d,]*)\\s+${word}\\b`, "i").exec(metrics ?? "");
  return m ? num(m[1]) : null;
};

/** "1, 5" / "2" / "#3" / "1 and 4" → ["1", "5"]: the pillar numbers a Benefit cell names. */
export function pillarIds(cell: string | null | undefined): string[] {
  return [...new Set((cell ?? "").match(/\d+/g) ?? [])];
}

/** One live post's reading: views (X views or impressions), likes, replies from people (the Replies cell, else Reddit comments). */
export function postReading(p: PillarPost): { views: number; likes: number; replies: number; read: boolean } {
  const views = countOf(p.metrics, "views?") ?? countOf(p.metrics, "impressions?");
  const likes = countOf(p.metrics, "likes?");
  const score = /\bscore\s+(-?\d[\d,]*)/i.exec(p.metrics ?? "");
  const replies = typeof p.replies === "number" ? p.replies : (countOf(p.metrics, "comments?") ?? countOf(p.metrics, "replies|reply"));
  const read = views !== null || likes !== null || replies !== null || !!score;
  return { views: views ?? 0, likes: likes ?? 0, replies: replies ?? 0, read };
}

export function pillarStats(lines: PillarLine[], posts: PillarPost[]): PillarStats {
  const defs = lines.filter((l) => l.id && (l.benefit ?? "").trim()).map((l) => ({ id: String(l.id).trim(), benefit: String(l.benefit).trim() }));
  const known = new Set(defs.map((d) => d.id));
  const tops = posts.filter((p) => String(p.kind ?? "post").toLowerCase() === "post" && !GONE.has(String(p.status ?? "").toLowerCase()));
  const by = new Map(defs.map((d) => [d.id, [] as PillarPost[]]));
  const off: string[] = [];
  for (const p of tops) {
    const ids = pillarIds(p.benefit).filter((i) => known.has(i));
    if (!ids.length) off.push(p.id ?? "?");
    for (const i of ids) by.get(i)!.push(p);
  }
  const touches = [...by.values()].reduce((a, b) => a + b.length, 0);
  const pillars = defs.map((d): PillarStat => {
    const mine = by.get(d.id)!;
    const live = mine.filter((p) => LIVE.has(String(p.status ?? "").toLowerCase()));
    let views = 0, likes = 0, replies = 0, measured = 0; // prettier-ignore
    let best: PillarStat["best"] = null;
    for (const p of live) {
      const r = postReading(p);
      if (!r.read) continue;
      measured++;
      views += r.views;
      likes += r.likes;
      replies += r.replies;
      const better = !best || r.views > best.views || (r.views === best.views && (r.likes > best.likes || (r.likes === best.likes && r.replies > best.replies)));
      if (better) best = { id: p.id ?? "?", title: (p.title ?? "").trim(), link: /https?:\/\/\S+/.exec(p.link ?? "")?.[0] ?? null, views: r.views, likes: r.likes, replies: r.replies };
    }
    return {
      id: d.id,
      benefit: d.benefit,
      posts: mine.length,
      planned: mine.length - live.length,
      live: live.length,
      measured,
      views,
      likes,
      replies,
      viewsPerPost: measured ? Math.round(views / measured) : null,
      share: touches ? Math.round((mine.length / touches) * 100) : 0,
      best,
      postIds: mine.map((p) => p.id ?? "?"),
    };
  });
  return { pillars, offPillar: { count: off.length, ids: off }, total: tops.length };
}

/** The Writer brief's lines (the feedback loop): each pillar's posts and how its live ones did, the least used first named. */
export function pillarBriefLines(s: PillarStats): string[] {
  if (!s.pillars.length) return [];
  const fewest = [...s.pillars].sort((a, b) => a.posts - b.posts)[0];
  return [
    "Benefits so far (the Benefits chapter; each post names the benefit numbers it touches in its Benefit cell, never none):",
    ...s.pillars.map((p) => `- ${p.id}. ${p.posts} posts (${p.live} live, ${p.measured} measured): ${p.views} views, ${p.likes} likes, ${p.replies} replies${p.viewsPerPost !== null ? `, ${p.viewsPerPost} views a post` : ""}`),
    ...(s.offPillar.count ? [`- No pillar named: ${s.offPillar.count} posts (${s.offPillar.ids.slice(0, 8).join(", ")}); name one when you next touch them.`] : []),
    `Least used pillar: ${fewest.id}. Weigh the next post toward it unless another pillar clearly does better per post.`,
  ];
}
