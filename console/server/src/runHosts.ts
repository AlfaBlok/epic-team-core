import { isAgentRun } from "./activeAgents.js";

/**
 * the Runs page's "Live runs by host" chart. How many runs were live at each moment of the last 24 hours or
 * 7 days, split by the host the run's agent ran on (the main server, the worker server, or unknown when nothing places it), from each run's
 * startedAt / endedAt; a run still running counts up to now. Every run counts (console wakes, delegated workers, native
 * subagents, runs any agent created), never a toggle line.
 *
 * Where a run's host comes from, first known wins:
 * 1. `recorded`: runs.host, written at launch by the console (the seat pick knows the host) or sent by the agent that
 *    created the run (POST /api/runs `host`); a child run created without one takes its parent's (from 2026-11-03).
 * 2. `launch`: runs.launch_host, the host a wake fell back to when its persona's host was at its cap.
 * 3. `environment`: the host whose T3 environment id the run's thread has (runs.environment_id, stamped since
 *    from the home thread's host, the parent run, or a T3 read of the thread).
 * 4. `parent`: the same three of the run's parent (delegate_task and native subagents run on their parent's machine).
 * 5. `seat`: a seat field that names a host (one old row says `the worker server`). Seat names (seat1..7) exist on both hosts, so a
 *    seat number alone never places a run.
 * Anything else is `unknown`: shown as its own band, never guessed.
 *
 * Same counting as's Active agents: a run is live on [startedAt, endedAt); one ending at or before its start
 * never was. Each bucket shows the moment inside it with the most runs live, split by host at that moment, so the top of
 * the stack is the bucket's exact peak and a short burst still shows.
 */
/** the two hosts a run can be placed on, main server first (the caller passes its own; the identity names them) */
export type HostPair = readonly [main: string, worker: string];
export const NEUTRAL_HOSTS: HostPair = ["main", "worker"];
/** a host id of the pair, or `unknown` */
export type RunHost = string;
export type HostSource = "recorded" | "launch" | "environment" | "parent" | "seat" | "unknown";

export type { HostRunRow } from "./runHostRow.js"; // the store reads these rows (core)
import type { HostRunRow } from "./runHostRow.js";

export function placeRun(r: HostRunRow, hosts: HostPair = NEUTRAL_HOSTS): { host: RunHost; from: HostSource } {
  const known = (h?: string): h is string => h === hosts[0] || h === hosts[1];
  if (known(r.host)) return { host: r.host, from: "recorded" };
  if (known(r.launchHost)) return { host: r.launchHost, from: "launch" };
  if (known(r.envHost)) return { host: r.envHost, from: "environment" };
  const parent = [r.parentHost, r.parentLaunchHost, r.parentEnvHost].find(known);
  if (parent) return { host: parent, from: "parent" };
  if (known(r.seat)) return { host: r.seat, from: "seat" };
  return { host: "unknown", from: "unknown" };
}

export const RANGES = { "24h": { ms: 24 * 3600_000, bucketMinutes: 5 }, "7d": { ms: 7 * 24 * 3600_000, bucketMinutes: 30 } } as const;
export type RangeKey = keyof typeof RANGES;

export interface HostSeries {
  range: RangeKey;
  /** First instant (ISO UTC) of the first bucket (on the clock); the last bucket holds `now` and stops there. */
  start: string;
  now: string;
  bucketMinutes: number;
  /** Runs live at the bucket's busiest moment, per host; one number per bucket from `start`. */
  counts: Record<RunHost, number[]>;
  /** The range's most runs live at once, the first moment it was reached, and the split then. */
  peak: { count: number; at: string | null; byHost: Record<RunHost, number> };
  /** Runs live at some moment of the range, per host, and what placed them. */
  runs: Record<RunHost, number>;
  sources: Record<HostSource, number>;
  /** A few of the unknown runs, to look them up. */
  unknownIds: string[];
}

export function hostSeries(rows: HostRunRow[], o: { range: RangeKey; now: Date; hosts?: HostPair }): HostSeries {
  const keys = [...(o.hosts ?? NEUTRAL_HOSTS), "unknown"];
  const zero = (): Record<RunHost, number> => Object.fromEntries(keys.map((h) => [h, 0]));
  const { ms, bucketMinutes } = RANGES[o.range];
  const b = bucketMinutes * 60_000;
  const now = o.now.getTime();
  // Buckets sit on the clock (…:00,:05 /:00,:30) so the axis ticks land on whole hours; the last one holds now.
  const n = Math.ceil(ms / b);
  const start = Math.floor(now / b) * b - (n - 1) * b;
  const end = start + n * b; // a run still running is live through the bucket that holds now
  const runs = zero();
  const sources: Record<HostSource, number> = { recorded: 0, launch: 0, environment: 0, parent: 0, seat: 0, unknown: 0 };
  const unknownIds: string[] = [];
  const spans: { s: number; e: number; h: RunHost }[] = [];
  for (const r of rows) {
    if (!isAgentRun(r)) continue;
    const s0 = Date.parse(r.startedAt);
    const e0 = r.endedAt ? Date.parse(r.endedAt) : end;
    if (isNaN(s0) || isNaN(e0) || e0 <= s0) continue;
    const s = Math.max(s0, start);
    const e = Math.min(e0, end);
    if (e <= s) continue;
    const { host, from } = placeRun(r, o.hosts);
    spans.push({ s, e, h: host });
    runs[host]++;
    sources[from]++;
    if (host === "unknown" && unknownIds.length < 20) unknownIds.push(r.id);
  }
  // +1 at a start, -1 at an end; at the same instant ends go first (half-open spans never overlap end-to-start).
  const ev = spans.flatMap((x) => [{ t: x.s, d: 1, h: x.h }, { t: x.e, d: -1, h: x.h }]).sort((a, c) => a.t - c.t || a.d - c.d);
  const counts: Record<RunHost, number[]> = Object.fromEntries(keys.map((h) => [h, new Array(n).fill(0)]));
  const level = zero();
  let total = 0;
  let j = 0;
  let peak = 0;
  let peakAt: number | null = null;
  let peakBy = zero();
  const step = () => {
    level[ev[j].h] += ev[j].d;
    total += ev[j].d;
    if (total > peak) {
      peak = total;
      peakAt = ev[j].t;
      peakBy = { ...level };
    }
    j++;
  };
  for (let i = 0; i < n; i++) {
    const bs = start + i * b;
    const be = bs + b;
    while (j < ev.length && ev[j].t <= bs) step(); // what changed at the bucket's first instant counts in it
    let best = total;
    let split = { ...level };
    while (j < ev.length && ev[j].t < be) {
      step();
      if (total > best) {
        best = total;
        split = { ...level };
      }
    }
    for (const h of keys) counts[h][i] = split[h];
  }
  const at = peakAt as number | null;
  return {
    range: o.range,
    start: new Date(start).toISOString(),
    now: o.now.toISOString(),
    bucketMinutes,
    counts,
    peak: { count: peak, at: at === null ? null : new Date(at).toISOString(), byHost: peakBy },
    runs,
    sources,
    unknownIds,
  };
}
