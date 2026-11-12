/**
 * the Runs page's "Active agents" chart. How many agents (wakes and their child runs; never a toggle line) were
 * active at each moment of one day in the viewer's timezone, from each run's startedAt / endedAt; a run still running
 * counts up to now. The server sends one small series per day (one number per bucket), never the runs.
 *
 * A run is active on [startedAt, endedAt): one ending at the instant another starts never overlaps it. A run whose end is
 * at or before its start (an instant idle wake, or a reported end before the start) was never active. Each bucket holds
 * the most agents active at any moment inside it, so a short burst still shows; the peak is the day's exact maximum and
 * the first moment it was reached, with the runs active then (a few ids, to check it against the runs list).
 */
export interface ActiveRun {
  id: string;
  startedAt: string;
  endedAt?: string | null;
  kind?: string;
}

export interface ActiveSeries {
  day: string;
  tz: string;
  /** The day's first and last instant (ISO UTC, end exclusive); 23 or 25 hours on a clock-change day. */
  start: string;
  end: string;
  bucketMinutes: number;
  /** One number per bucket from `start`; today stops at now (no future buckets). */
  counts: number[];
  peak: { count: number; at: string | null; runIds: string[] };
  /** Runs active at some moment of the day. */
  runs: number;
  now: string;
}

export const BUCKETS = [1, 5, 10, 15] as const;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmt = new Map<string, Intl.DateTimeFormat>();
/** The tz's offset from UTC (ms) at instant `t`. */
function offsetAt(t: number, tz: string): number {
  let f = fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmt.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(t / 1000) * 1000;
}

/** The UTC instant of local midnight starting `day` (YYYY-MM-DD) in `tz`. */
function localMidnight(day: string, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offsetAt(wall, tz);
  return wall - offsetAt(first, tz);
}

/** The day's bounds in `tz` (end exclusive): next local midnight, so a clock-change day is 23 or 25 hours. */
export function dayBounds(day: string, tz: string): { start: number; end: number } {
  if (!DAY_RE.test(day) || isNaN(Date.parse(`${day}T00:00:00Z`))) throw new RangeError(`day must be YYYY-MM-DD, got ${day}`);
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: localMidnight(day, tz), end: localMidnight(next, tz) };
}

/** Today's date (YYYY-MM-DD) in `tz` at `now`. */
export function localDay(now: Date, tz: string): string {
  return new Date(now.getTime() + offsetAt(now.getTime(), tz)).toISOString().slice(0, 10);
}

/** Runs that are agents: wakes and child runs (answer runs too), never a toggle line. */
export const isAgentRun = (r: Pick<ActiveRun, "kind">) => r.kind !== "toggle";

export function activeSeries(runs: ActiveRun[], o: { day: string; tz: string; now: Date; bucketMinutes?: number }): ActiveSeries {
  const b = (o.bucketMinutes ?? 1) * 60_000;
  const { start, end } = dayBounds(o.day, o.tz);
  const now = o.now.getTime();
  const stop = Math.min(end, now); // nothing after now is known
  // Each run clipped to the day (and to now); a run never active inside it is dropped.
  const spans: { id: string; s: number; e: number }[] = [];
  for (const r of runs) {
    if (!isAgentRun(r)) continue;
    const s0 = Date.parse(r.startedAt);
    const e0 = r.endedAt ? Date.parse(r.endedAt) : now;
    if (isNaN(s0) || isNaN(e0) || e0 <= s0) continue;
    const s = Math.max(s0, start);
    const e = Math.min(e0, stop);
    if (e > s) spans.push({ id: r.id, s, e });
  }
  // +1 at a start, -1 at an end; at the same instant ends go first (half-open spans never overlap end-to-start).
  const ev = spans.flatMap((x) => [{ t: x.s, d: 1 }, { t: x.e, d: -1 }]).sort((a, c) => a.t - c.t || a.d - c.d);
  const n = stop > start ? Math.ceil((stop - start) / b) : 0;
  const counts = new Array<number>(n).fill(0);
  let level = 0;
  let j = 0;
  let peak = 0;
  let peakAt: number | null = null;
  const step = () => {
    level += ev[j].d;
    if (level > peak) {
      peak = level;
      peakAt = ev[j].t;
    }
    j++;
  };
  for (let i = 0; i < n; i++) {
    const bs = start + i * b;
    const be = Math.min(bs + b, stop);
    while (j < ev.length && ev[j].t <= bs) step(); // what changed at the bucket's first instant counts in it
    let m = level;
    while (j < ev.length && ev[j].t < be) {
      step();
      m = Math.max(m, level);
    }
    counts[i] = m;
  }
  const at = peakAt as number | null;
  return {
    day: o.day,
    tz: o.tz,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    bucketMinutes: b / 60_000,
    counts,
    peak: { count: peak, at: at === null ? null : new Date(at).toISOString(), runIds: at === null ? [] : spans.filter((x) => x.s <= at && at < x.e).map((x) => x.id) },
    runs: spans.length,
    now: o.now.toISOString(),
  };
}
