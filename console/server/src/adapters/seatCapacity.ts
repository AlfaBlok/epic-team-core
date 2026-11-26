/**
 * how full a workspace's AI seats are, per app, and how much more
 * load fits. The same counting as scripts/seat_capacity.py (the page:18968 he liked), read live from the console:
 *
 * - Each seat's use is its own weekly percent as the AI provider reports it (the seat broker's seats.json for the home
 *   team, customer_seats for a customer). A signed-out seat, or one limited for days past its own week, gives nothing.
 * - Seats weigh by their price: a seat that costs five times another counts five times (docs/scorecard/products.json
 *   `seat_fees` for the home team; a customer's seats weigh one each).
 * - This week: the weighted average of the working seats' weekly percent.
 * - Pace: each seat's use so far over the part of its own week gone by (ratio of sums). Above 100% the work needs more
 *   than the seats give: they reach their limit before they reset.
 * - Per app: each seat's weekly percent split over the runs it served in its own week, by each run's token cost (used
 *   only as a weight). A seat with use but no run seen is "Not metered".
 * - More that fits: 1 / pace - 1 of today's load, and that many more runs a day (runs a day of the last 7 days).
 * Dollars are never shown: only shares.
 */
export interface CapacitySeatIn {
  id: string;
  /** weekly use, percent; undefined when not read. */
  weekly?: number;
  /** 5-hour use, percent. */
  five?: number;
  weeklyResetsAt?: string;
  fiveResetsAt?: string;
  limitedUntil?: string;
  status: "ok" | "limited" | "unknown" | "logged_out";
  /** price weight (premium 5, standard 1). */
  weight: number;
}
export interface CapacityRunIn {
  /** the seat it ran on; a run on no known seat counts for the seats with no run of their own (a customer's jobs). */
  seat?: string | null;
  app: string;
  /** token cost, used only as a weight. */
  cost: number;
  at: string;
}
export interface CapacityApp {
  app: string;
  /** share of the working seats' capacity used this week, 0..1. */
  week: number;
  /** share of a week's capacity at the last days' pace, 0..1+ (sums to the pace). */
  pace: number;
  runsPerDay: number;
}
export interface SeatCapacity {
  /** share of the working seats used this week, 0..1. */
  week: number;
  /** the last days' pace as a share of capacity; 1 = exactly full by the reset. null with no seat read. */
  pace: number | null;
  /** more load that fits at this pace, as a share of today's load (0.5 = half as much again); 0 when none fits. */
  moreFits: number | null;
  runsPerDay: number;
  moreRunsPerDay: number | null;
  apps: CapacityApp[];
  seats: { all: number; working: number; signedOut: number; limited: number; blocked: number };
  /** share of the whole capacity out of use (signed out or blocked for days). */
  lost: number;
  /** the one line. */
  answer: string;
  at: string;
}

export const NOT_METERED = "Not metered";
const WEEK = 7 * 86_400_000;
const DAY = 86_400_000;
const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);

/** a seat limited for more than a day past both its own resets: no capacity this week. */
function blockedFor(s: CapacitySeatIn, now: number): boolean {
  if (s.status !== "limited" || !s.limitedUntil) return false;
  if (s.limitedUntil === s.weeklyResetsAt || s.limitedUntil === s.fiveResetsAt) return false;
  return ms(s.limitedUntil) - now > DAY;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function capacityAnswer(c: Pick<SeatCapacity, "pace" | "moreFits" | "moreRunsPerDay" | "week" | "seats">): string {
  if (c.pace == null) return c.seats.all ? "Your seats have not reported their use yet." : "No AI seat connected yet.";
  if (c.moreFits == null || c.moreFits < 0.05)
    return `Your seats are ${pct(c.week)} used this week and the last days ran at ${pct(c.pace)} of capacity: no more load fits.`;
  const runs = c.moreRunsPerDay != null && c.moreRunsPerDay >= 1 ? `, about ${Math.round(c.moreRunsPerDay)} more runs a day` : "";
  return `Your seats are ${pct(c.week)} used this week at ${pct(c.pace)} pace: about ${pct(c.moreFits)} more load fits${runs}.`;
}

export function seatCapacity(seats: CapacitySeatIn[], runs: CapacityRunIn[], now: Date = new Date()): SeatCapacity {
  const t = now.getTime();
  const live = seats.filter((s) => s.status !== "logged_out" && typeof s.weekly === "number" && !blockedFor(s, t));
  const whole = seats.reduce((a, s) => a + 100 * s.weight, 0);
  const cap = live.reduce((a, s) => a + 100 * s.weight, 0);
  const winStart = (s: CapacitySeatIn) => (Number.isFinite(ms(s.weeklyResetsAt)) ? ms(s.weeklyResetsAt) - WEEK : t - WEEK);

  const seatIds = new Set(seats.map((s) => s.id));
  const unseated = runs.filter((r) => !r.seat || !seatIds.has(r.seat));
  const split = (rs: CapacityRunIn[]) => {
    const m = new Map<string, number>();
    for (const r of rs) m.set(r.app, (m.get(r.app) ?? 0) + Math.max(0, r.cost || 0));
    return m;
  };
  // per app, weighted weekly points across the working seats
  const used = new Map<string, number>();
  for (const s of live) {
    const from = winStart(s);
    const inWin = (r: CapacityRunIn) => ms(r.at) >= from;
    let parts = split(runs.filter((r) => r.seat === s.id && inWin(r)));
    if (![...parts.values()].some((v) => v > 0)) parts = split(unseated.filter(inWin));
    const tot = [...parts.values()].reduce((a, v) => a + v, 0);
    const w = (s.weekly ?? 0) * s.weight;
    if (tot > 0) for (const [app, v] of parts) used.set(app, (used.get(app) ?? 0) + (w * v) / tot);
    else if (w > 0) used.set(NOT_METERED, (used.get(NOT_METERED) ?? 0) + w);
  }
  const week = cap ? [...used.values()].reduce((a, v) => a + v, 0) / cap : 0;

  const paced = live.filter((s) => Number.isFinite(ms(s.weeklyResetsAt)));
  const gone = (s: CapacitySeatIn) => Math.min(1, Math.max(0, (t - winStart(s)) / WEEK));
  const paceBase = paced.reduce((a, s) => a + 100 * s.weight * gone(s), 0);
  const pace = live.length === 0 ? null : paced.length && paceBase > 0 ? paced.reduce((a, s) => a + (s.weekly ?? 0) * s.weight, 0) / paceBase : week;
  const moreFits = pace == null ? null : pace > 0 ? Math.max(0, 1 / pace - 1) : null;

  const since = t - WEEK;
  const runsByApp = new Map<string, number>();
  for (const r of runs) if (ms(r.at) >= since) runsByApp.set(r.app, (runsByApp.get(r.app) ?? 0) + 1);
  const runsPerDay = [...runsByApp.values()].reduce((a, v) => a + v, 0) / 7;
  const moreRunsPerDay = moreFits == null ? null : runsPerDay * moreFits;

  const totalUsed = [...used.values()].reduce((a, v) => a + v, 0);
  const names = new Set([...used.keys(), ...runsByApp.keys()]);
  const apps: CapacityApp[] = [...names]
    .map((app) => {
      const u = used.get(app) ?? 0;
      return {
        app,
        week: cap ? u / cap : 0,
        pace: pace != null && totalUsed > 0 ? (pace * u) / totalUsed : 0,
        runsPerDay: (runsByApp.get(app) ?? 0) / 7,
      };
    })
    .sort((a, b) => b.week - a.week || b.runsPerDay - a.runsPerDay || a.app.localeCompare(b.app));

  const seatsOut = {
    all: seats.length,
    working: live.length,
    signedOut: seats.filter((s) => s.status === "logged_out").length,
    limited: seats.filter((s) => s.status === "limited" && !blockedFor(s, t)).length,
    blocked: seats.filter((s) => blockedFor(s, t)).length,
  };
  const base = { week, pace, moreFits, runsPerDay, moreRunsPerDay, seats: seatsOut };
  return {
    ...base,
    apps,
    lost: whole ? 1 - cap / whole : 0,
    answer: capacityAnswer(base),
    at: now.toISOString(),
  };
}

/** a seat's price weight from the products file's `seat_fees` ({tier: {eur_month, seats: [...]}}): the cheapest tier is 1. */
export function seatWeights(fees: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!fees || typeof fees !== "object") return out;
  const tiers = Object.values(fees as Record<string, any>).filter(
    (v) => v && typeof v === "object" && typeof v.eur_month === "number" && v.eur_month > 0 && Array.isArray(v.seats),
  ) as { eur_month: number; seats: unknown[] }[];
  const low = Math.min(...tiers.map((v) => v.eur_month));
  for (const v of tiers) for (const s of v.seats) if (typeof s === "string") out[s] = Math.round((v.eur_month / low) * 100) / 100;
  return out;
}

/** the apps a workspace's runs count for: up to `top` by use, the rest as one line. */
export function foldApps(apps: CapacityApp[], top = 4, rest = "Everything else"): CapacityApp[] {
  const keep = apps.filter((a) => a.app !== NOT_METERED).slice(0, top);
  const names = new Set(keep.map((a) => a.app));
  const others = apps.filter((a) => !names.has(a.app) && a.app !== NOT_METERED);
  const nm = apps.find((a) => a.app === NOT_METERED);
  const sum = (k: keyof CapacityApp) => others.reduce((a, x) => a + (x[k] as number), 0);
  return [
    ...keep,
    ...(others.length ? [{ app: rest, week: sum("week"), pace: sum("pace"), runsPerDay: sum("runsPerDay") }] : []),
    ...(nm ? [nm] : []),
  ];
}
