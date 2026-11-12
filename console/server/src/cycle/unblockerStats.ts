import type { Hono } from "hono";
import type { DB } from "../db.js";
import { isUnblocker } from "../inbox/asks.js";
import type { Run, RunCheck, Store } from "../store.js";
import { SKIP_PREFIX } from "./skipUnchanged.js";

/**
 * the Unblocker's numbers per milestone and window (24 h, 7 d, all): wakes fired and skipped, new asks seen,
 * asks assessed / answered / left (split apart), decisions the owner reversed, and the time from ask to verdict (median and
 * worst). Read only: the run log (Unblocker runs: their `openAsks` and `checks`), the per-ask memory (for the
 * milestones and asks it knows) and the answers table (`jordi_responses`, reversals). The one write it needs lives at
 * wake time: each open ask on an Unblocker run carries `since` (when its spine line was written, git blame), so the
 * clock starts when the ask was raised, not when the Unblocker first looked. Asks seen before that field existed are
 * timed from the first Unblocker wake that listed them (`estimated`).
 *
 * adds a score per verdict: `score` / `threshold` on a check (or under `rubric`) are summed up
 * when present (median score, latest threshold); absent, nothing is shown.
 */
export const STATS_WINDOWS = { "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000, all: Infinity } as const;
export type StatsWindow = keyof typeof STATS_WINDOWS;

export interface AskTiming {
  /** Asks whose first verdict fell in the window. */
  count: number;
  medianMs: number | null;
  worstMs: number | null;
  worstCode?: string;
  /** Of `count`: timed from the first Unblocker wake that listed the ask (no line time recorded). */
  estimated: number;
  /** Asks open in the window with no verdict yet, and the oldest one's age at `to`. */
  waiting: number;
  oldestWaitingMs: number | null;
  oldestWaitingCode?: string;
}

export interface UnblockerCounts {
  wakesFired: number;
  wakesSkipped: number;
  newAsks: number;
  /** Ask checks the Unblocker made itself (not carried `left (unchanged since …)`, not copied by a skipped wake). */
  assessed: number;
  answered: number;
  left: number;
  split: number;
  /** Decisions the Unblocker took that the owner reversed (distinct FYI cards). */
  reversed: number;
  askToVerdict: AskTiming;
  /** when its checks carry scores. */
  score?: { count: number; median: number; threshold?: number };
}

export interface UnblockerMilestoneStats extends UnblockerCounts {
  milestoneId: string;
  milestoneTitle: string;
}

export interface UnblockerStats {
  window: StatsWindow;
  from: string | null;
  to: string;
  milestones: UnblockerMilestoneStats[];
  total: UnblockerCounts;
}

const bareCode = (c: string) => c.trim().replace(/^.*\//, "").toUpperCase();
const ms = (t?: string) => (t ? Date.parse(t) : NaN);
const own = (c: RunCheck) => !c.carriedFrom && !c.skipped;
const isSkip = (r: Run) => r.summary.startsWith(SKIP_PREFIX);

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**'s score on a check: `score` / `threshold`, or the same under `rubric`; undefined when absent. */
function scoreOf(c: RunCheck): { score: number; threshold?: number } | undefined {
  const x = c as RunCheck & { score?: unknown; threshold?: unknown; rubric?: { score?: unknown; threshold?: unknown } };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const score = num(x.score) ?? num(x.rubric?.score);
  if (score === undefined) return undefined;
  const threshold = num(x.threshold) ?? num(x.rubric?.threshold);
  return { score, ...(threshold !== undefined ? { threshold } : {}) };
}

/** Every Unblocker run of the visible world (wakes only: no child runs, answer runs or toggles), oldest first. */
export function unblockerRuns(store: Store): Run[] {
  const ids = new Set(store.listPersonas().filter((p) => isUnblocker(p.name)).map((p) => p.id));
  const personaOf = new Map(store.listAssignments({}).map((a) => [a.id, a.personaId]));
  return store
    .listRuns({ since: "0000" })
    .filter((r) => !r.parentRunId && r.kind === "wake" && r.milestoneId && ids.has(r.personaId ?? personaOf.get(r.assignmentId) ?? ""))
    .reverse();
}

/** Reversals of decisions an Unblocker took: answers the owner gave on its FYI cards (one per card). */
export function unblockerReversals(db: DB): { milestoneId: string; itemId: string; code?: string; at: string }[] {
  const rows = db
    .prepare("SELECT item_id, milestone_id, item, created_at FROM jordi_responses WHERE kind = 'answer' AND milestone_id IS NOT NULL ORDER BY created_at, id")
    .all() as { item_id: string; milestone_id: string; item: string; created_at: string }[];
  const seen = new Set<string>();
  const out: { milestoneId: string; itemId: string; code?: string; at: string }[] = [];
  for (const r of rows) {
    let item: { decidedBy?: string; code?: string } = {};
    try {
      item = JSON.parse(r.item);
    } catch {
      continue;
    }
    if (!isUnblocker(item.decidedBy) || seen.has(r.item_id)) continue;
    seen.add(r.item_id);
    out.push({ milestoneId: r.milestone_id, itemId: r.item_id, ...(item.code ? { code: item.code } : {}), at: r.created_at });
  }
  return out;
}

interface AskLife {
  milestoneId: string;
  code: string;
  /** Earliest line time (`since`) on any wake that listed it, else the first such wake's start. */
  askedAt: number;
  estimated: boolean;
  /** End of the first Unblocker run that assessed it (its own check). */
  verdictAt?: number;
  /** Last time an Unblocker wake listed it open (or carried / skipped it). */
  lastSeen: number;
}

/** Per (milestone, ask): when it was raised (line time, else first wake listing it), its first verdict, last seen open. */
export function askLives(runs: Run[]): AskLife[] {
  const acc = new Map<string, { milestoneId: string; code: string; since?: number; firstWake: number; verdictAt?: number; lastSeen: number }>();
  for (const r of runs) {
    const start = ms(r.startedAt);
    const end = ms(r.endedAt ?? r.startedAt);
    const touch = (code: string, since?: string) => {
      const k = `${r.milestoneId}\u0000${bareCode(code)}`;
      const l = acc.get(k) ?? { milestoneId: r.milestoneId!, code: bareCode(code), firstWake: start, lastSeen: end };
      const s = ms(since);
      if (Number.isFinite(s)) l.since = Math.min(l.since ?? s, s);
      l.firstWake = Math.min(l.firstWake, start);
      l.lastSeen = Math.max(l.lastSeen, end);
      acc.set(k, l);
      return l;
    };
    for (const a of r.openAsks ?? []) touch(a.code, a.since);
    for (const c of r.checks ?? []) {
      const l = touch(c.code);
      if (own(c) && r.outcome !== "running" && l.verdictAt === undefined) l.verdictAt = end;
    }
  }
  return [...acc.values()].map((l) => ({
    milestoneId: l.milestoneId,
    code: l.code,
    askedAt: l.since !== undefined ? Math.min(l.since, l.firstWake) : l.firstWake,
    estimated: l.since === undefined,
    ...(l.verdictAt !== undefined ? { verdictAt: l.verdictAt } : {}),
    lastSeen: l.lastSeen,
  }));
}

const emptyTiming = (): AskTiming => ({ count: 0, medianMs: null, worstMs: null, estimated: 0, waiting: 0, oldestWaitingMs: null });

function counts(runs: Run[], lives: AskLife[], reversals: { at: string }[], inWin: (t: number) => boolean, to: number): UnblockerCounts {
  const c: UnblockerCounts = { wakesFired: 0, wakesSkipped: 0, newAsks: 0, assessed: 0, answered: 0, left: 0, split: 0, reversed: 0, askToVerdict: emptyTiming() };
  const scores: number[] = [];
  let threshold: { at: number; v: number } | undefined;
  for (const r of runs) {
    if (inWin(ms(r.startedAt))) isSkip(r) ? c.wakesSkipped++ : c.wakesFired++;
    const end = ms(r.endedAt ?? r.startedAt);
    if (isSkip(r) || r.outcome === "running" || !inWin(end)) continue;
    for (const x of (r.checks ?? []).filter(own)) {
      c.assessed++;
      c[x.decision === "answered" ? "answered" : x.decision === "split" ? "split" : "left"]++;
      const s = scoreOf(x);
      if (s) {
        scores.push(s.score);
        if (s.threshold !== undefined && (!threshold || end >= threshold.at)) threshold = { at: end, v: s.threshold };
      }
    }
  }
  c.reversed = reversals.filter((x) => inWin(ms(x.at))).length;
  c.newAsks = lives.filter((l) => inWin(l.askedAt)).length;
  const timed = lives.filter((l) => l.verdictAt !== undefined && inWin(l.verdictAt));
  const waits = timed.map((l) => Math.max(0, l.verdictAt! - l.askedAt));
  const worst = timed.reduce<AskLife | undefined>((w, l) => (!w || l.verdictAt! - l.askedAt > w.verdictAt! - w.askedAt ? l : w), undefined);
  // Waiting: raised before `to`, no verdict, and still listed open at a wake inside the window.
  const waiting = lives.filter((l) => l.verdictAt === undefined && l.askedAt <= to && inWin(l.lastSeen));
  const oldest = waiting.reduce<AskLife | undefined>((o, l) => (!o || l.askedAt < o.askedAt ? l : o), undefined);
  c.askToVerdict = {
    count: timed.length,
    medianMs: median(waits),
    worstMs: worst ? Math.max(0, worst.verdictAt! - worst.askedAt) : null,
    ...(worst ? { worstCode: worst.code } : {}),
    estimated: timed.filter((l) => l.estimated).length,
    waiting: waiting.length,
    oldestWaitingMs: oldest ? to - oldest.askedAt : null,
    ...(oldest ? { oldestWaitingCode: oldest.code } : {}),
  };
  if (scores.length) c.score = { count: scores.length, median: median(scores)!, ...(threshold ? { threshold: threshold.v } : {}) };
  return c;
}

/** The numbers for one window, per milestone (milestones with any Unblocker run or reversal, in the store's order) and in total. */
export function unblockerStats(db: DB, store: Store, o: { window?: StatsWindow; milestoneId?: string; now?: number } = {}): UnblockerStats {
  const window = o.window ?? "24h";
  const to = o.now ?? Date.now();
  const span = STATS_WINDOWS[window];
  const from = span === Infinity ? -Infinity : to - span;
  const inWin = (t: number) => Number.isFinite(t) && t > from && t <= to;
  const milestones = store.listMilestones({ includeSettled: true }).filter((m) => !o.milestoneId || m.id === o.milestoneId);
  const visible = new Set(milestones.map((m) => m.id));
  const runs = unblockerRuns(store).filter((r) => visible.has(r.milestoneId!));
  const lives = askLives(runs);
  const reversals = unblockerReversals(db).filter((x) => visible.has(x.milestoneId));
  const per = milestones
    .filter((m) => runs.some((r) => r.milestoneId === m.id) || reversals.some((x) => x.milestoneId === m.id))
    .map((m) => ({
      milestoneId: m.id,
      milestoneTitle: m.title,
      ...counts(
        runs.filter((r) => r.milestoneId === m.id),
        lives.filter((l) => l.milestoneId === m.id),
        reversals.filter((x) => x.milestoneId === m.id),
        inWin,
        to,
      ),
    }));
  return {
    window,
    from: span === Infinity ? null : new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    milestones: per,
    total: counts(runs, lives, reversals, inWin, to),
  };
}

/** GET /api/unblocker-stats?window=24h|7d|all[&milestoneId=]. */
export function mountUnblockerStats(api: Hono, db: DB, store: Store): void {
  api.get("/unblocker-stats", (c) => {
    const w = c.req.query("window") ?? "24h";
    if (!(w in STATS_WINDOWS)) return c.json({ error: "validation_error", message: "window must be 24h, 7d or all" }, 400);
    return c.json(unblockerStats(db, store, { window: w as StatsWindow, milestoneId: c.req.query("milestoneId") || undefined }));
  });
}
