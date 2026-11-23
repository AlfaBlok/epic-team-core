import { classifyRefusal, type Refusal } from "./capRefusal.js";

/**
 * the owner's note: "Hosts shows room on every limit ... while 15 tickets wait for a slot ... why the queue does not
 * drain by itself". A ready row whose pick was refused waits in the console's work queue (a deferred child run
 * with its launch spec, cycle_worker_launch) instead of waiting for its manager's next wake. Every retry tick the console
 * tries the queue in order (queueOrder: urgent first, then his objectives in his order) and starts the first one pick lets through, inside every cap: the worker host's memory
 * and load gate and the central broker's seats and team ceiling (all in pick), and the per-goal worker ceiling (here).
 * A refusal that holds every row (host memory or load, seats, team ceiling, an unreachable dispatcher) ends the tick:
 * the rows after it wait with the same reason, so the order holds and one pick a tick is all it costs.
 */

/** how often a queued row is tried again: the retry tick (30 s), so a freed slot is used within about a minute. */
export const QUEUE_RETRY_MS = 30_000;
/** a queued row gives up (failed, with the reason) only after a day; the manager's next wake sees it and may queue it again. */
export const QUEUE_MAX_MS = 24 * 3600_000;

export interface Queued {
  id: string;
  /** urgent or his feedback (his answer, a card he sent back, an URGENT row): before everything else. */
  first?: boolean;
  /** the milestone's rank (milestoneRanks); breaks ties inside one objective; unknown sorts last. */
  rank?: number;
  /** his objective it moves, its place in his order (docs/pursuits.json, 0 = his first); none sorts after every objective. */
  objective?: number;
  /** when it was queued (first refusal or the run's start). */
  since: string;
}

/** a row waiting longer than this goes first inside its objective (the owner's note: items waited 4 to 10
 * days; anything over a day raises itself), and first among rows on none of his objectives. */
export const OVER_A_DAY_MS = 24 * 3600_000;

/**
 * the one queue order every launch goes through ("a free slot goes to the head of the queue, never to a new
 * arrival"). His 23 Nov note ("in the absence of something urgent, this guy should be at the top of the
 * queue by default"): urgent and his feedback first, then his objectives in his order (his first objective by default,
 * without him marking it urgent), then rows on none; inside each, over a day first (oldest first), then the milestone
 * rank, then first queued first served. Stable. Hosts lists the waiting tickets in this same order.
 */
export function queueOrder<T extends Queued>(items: T[], now = Date.now()): T[] {
  const r = (x: Queued) => (x.rank === undefined ? Number.MAX_SAFE_INTEGER : x.rank);
  const obj = (x: Queued) => (x.first ? -1 : x.objective === undefined ? Number.MAX_SAFE_INTEGER : x.objective);
  const old = (x: Queued) => (!x.first && now - (Date.parse(x.since) || now) > OVER_A_DAY_MS ? 0 : 1);
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => obj(a.it) - obj(b.it) || old(a.it) - old(b.it) || (old(a.it) === 0 || a.it.first ? a.it.since.localeCompare(b.it.since) : 0) || r(a.it) - r(b.it) || a.it.since.localeCompare(b.it.since) || a.i - b.i)
    .map((x) => x.it);
}

/** why a row sits where it does in the queue, in plain words for Hosts: urgent or his feedback, his objective, else waited over a day. */
export function queueTier(x: Queued, now = Date.now()): "first" | "overDay" | "objective" {
  return x.first ? "first" : x.objective !== undefined ? "objective" : now - (Date.parse(x.since) || now) > OVER_A_DAY_MS ? "overDay" : "objective";
}

/** an URGENT row (its title or brief says URGENT in capitals: 4 of 347 briefs did on 23 Nov) or his feedback (a card he sent
 * back, his note) goes first. The brief's standard head quotes his words for every row, so only the title names feedback. */
export function isFirst(o: { title?: string | null; brief?: string | null; pickup?: boolean }): boolean {
  if (o.pickup) return true;
  if (/\bURGENT\b/.test(o.title ?? "") || /\bURGENT\b/.test(o.brief ?? "")) return true;
  return /^\s*urgent\b/i.test(o.title ?? "") || /\b(sent back|his (card )?notes?|his feedback|vn_[0-9a-f]{6,})\b/i.test(o.title ?? "");
}

/** a stored queue reason (a pick refusal or refusalText of one) that holds every row behind it too: host memory or load,
 * sessions, seats, the team ceiling, an unreachable server. The per-goal ceiling holds only its own goal. */
export function reasonHoldsEveryRow(reason: string | undefined): boolean {
  const r = reason ?? "";
  if (!r || /workers per goal/.test(r)) return false;
  return /(load-cap on|low memory on|high load on|session-cap on|session cap on|session-start gap on|team ceiling|^all seats busy|^no seat|unreachable|unavailable)/i.test(r);
}

/** a refusal every later row would get too (host memory or load, seats, team ceiling, unreachable): stop this tick. */
export function holdsEveryRow(r: Refusal): boolean {
  return r.kind === "load" || r.kind === "memory" || r.kind === "seats" || r.kind === "ceiling" || r.kind === "unreachable" || r.kind === "sessions";
}

/** the per-goal ceiling refusal, in the same `…, will retry` shape as a pick refusal. */
export const goalCeilingReason = (running: number, max: number) => `workers per goal: ${running} of ${max} running on this goal, will retry`;

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * the one limit holding a waiting row, in plain words for Hosts (his "show each waiting ticket and the one limit holding
 * it"). Reads a deferral reason (refusalText, possibly with `, will retry`) or a dispatcher reason.
 */
export function plainHold(reason: string | undefined): string {
  const r = (reason ?? "").replace(/, will retry$/, "").trim();
  if (!r) return "Waiting for its first try.";
  let m = /workers per goal: (\d+) of (\d+)/.exec(r);
  if (m) return `Workers per goal: ${m[1]} of ${m[2]} already run on this goal.`;
  m = /load-cap on ([\w.-]+) \(memory (-?\d+) MB \/ floor (\d+)\)/.exec(r) ?? /low memory on ([\w.-]+): (-?\d+) MB available \(floor (\d+)\)/.exec(r);
  if (m) return `${m[1]} memory: ${fmt(Number(m[2]))} MB free after recent starts, ${fmt(Number(m[3]))} MB must stay free.`;
  m = /load-cap on ([\w.-]+) \(load5 ([\d.]+) \/ cap ([\d.]+)\)/.exec(r) ?? /high load on ([\w.-]+): load5 ([\d.]+) on \d+ CPUs \(cap ([\d.]+)\)/.exec(r);
  if (m) return `${m[1]} load: ${m[2]}, at its cap of ${m[3]}.`;
  m = /team ceiling reached \((\d+) of (\d+) workers open\)/.exec(r);
  if (m) return `Team ceiling: ${m[1]} of ${m[2]} agents already run.`;
  if (/^all seats busy|^no seat/i.test(r)) return "Claude seats: every seat is busy or near its limit.";
  if (/unreachable/i.test(r)) return "The dispatcher did not answer; it is tried again.";
  if (/unavailable/i.test(r)) return `${r.split(":")[0]}: the worker server is starting or unreachable.`;
  const c = classifyRefusal(r);
  return c.kind === "final" ? r : c.text;
}

/**
 * pick's memory rule, read from pick's own numbers (the worker server's dispatcher client's MEM_FLOOR_MB, MEM_PER_LAUNCH_MB and its
 * recent-launch file), so Hosts and pick never disagree: a launch passes when MemAvailable less one share per launch in
 * the last 2 minutes is at the floor or above. `more` = how many launches pass back to back from here.
 */
export function memRoom(o: { availMb: number; recent: number; floorMb: number; perLaunchMb: number }): { freeMb: number; more: number } {
  const freeMb = o.availMb - o.perLaunchMb * o.recent;
  const more = freeMb < o.floorMb ? 0 : Math.floor((freeMb - o.floorMb) / o.perLaunchMb) + 1;
  return { freeMb, more };
}
