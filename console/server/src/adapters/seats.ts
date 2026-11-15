import fs from "node:fs";

/** One seat from M1's seats.json (the ops dir/seats.json), read-only. */
export interface Seat {
  id: string;
  name: string;
  /** 5-hour window utilisation, percent; undefined when unknown. */
  usage5h?: number;
  /** General weekly window, percent; undefined when unknown (Team seats may have none). */
  usageWeekly?: number;
  resetsAt: { fiveHour?: string; weekly?: string; limitedUntil?: string };
  limited: boolean;
  inFlight: number;
  status: "ok" | "limited" | "unknown" | "logged_out";
  /** Why usage is unknown (e.g. "usage endpoint HTTP 429"). */
  reason?: string;
  readAt?: string;
  org?: string;
  /** why there is no weekly % (`not metered`: Team seats have no general weekly cap). */
  weeklySource?: string;
  /** per-model weekly windows (e.g. Fable), percent and reset. */
  modelWeekly?: { model: string; pct?: number; resetsAt?: string }[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function mapSeats(raw: unknown, now: Date = new Date()): Seat[] {
  const seats = (raw as { seats?: Record<string, any> })?.seats;
  if (!seats || typeof seats !== "object") return [];
  return Object.entries(seats)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([id, s]) => {
      const u = (s?.usage ?? {}) as Record<string, unknown>;
      const maxed = str(s?.maxed_until);
      const limitedUntil = str(u.limited_until) ?? maxed;
      const future = (t?: string) => !!t && Date.parse(t) > now.getTime();
      const past = (t?: string) => !!t && Date.parse(t) <= now.getTime();
      // a usage read that says "limited" no longer counts once its reset has passed (seat2 2026-11-01: read 19:56Z,
      // reset 19:59:59Z, still "limited" at 20:00:10Z); a usage-limited status with no reset time stays limited.
      const limited = (u.status === "limited" && !(past(limitedUntil) && !future(maxed))) || future(maxed);
      const known = u.known !== false && num(u.five_hour_pct) !== undefined;
      const status: Seat["status"] = s?.logged_in === false ? "logged_out" : limited ? "limited" : known ? "ok" : "unknown";
      return {
        id,
        name: id,
        usage5h: num(u.five_hour_pct),
        usageWeekly: num(u.weekly_pct),
        resetsAt: { fiveHour: str(u.five_hour_resets_at), weekly: str(u.weekly_resets_at), limitedUntil: limited ? limitedUntil : undefined },
        limited,
        inFlight: num(s?.in_flight) ?? 0,
        status,
        reason: str(u.reason),
        readAt: str(u.read_at),
        org: str(s?.org),
        weeklySource: str(u.weekly_source),
        modelWeekly:
          u.model_weekly && typeof u.model_weekly === "object"
            ? Object.entries(u.model_weekly as Record<string, any>).map(([model, w]) => ({ model, pct: num(w?.pct), resetsAt: str(w?.resets_at) }))
            : undefined,
      };
    });
}

export function readSeats(file: string): Seat[] {
  return mapSeats(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * why a seat cannot take a turn now (`seat1 limited until 2026-11-01T19:50:00Z`, `seat2 logged out`), else
 * undefined. Unknown seat or unreadable seats.json never blocks.
 */
export function seatBlock(seats: Seat[] | undefined, seat: string | undefined): string | undefined {
  if (!seat || !seats) return undefined;
  const s = seats.find((x) => x.id === seat || x.name === seat);
  if (!s) return undefined;
  if (s.status === "logged_out") return `${seat} logged out`;
  if (s.status === "limited") return `${seat} limited${s.resetsAt.limitedUntil ? ` until ${s.resetsAt.limitedUntil}` : ""}`;
  return undefined;
}

/** the seat the broker keeps for the owner (seats.json `owner_seat`), else undefined. */
export function ownerSeatOf(raw: unknown): string | undefined {
  const r = raw as { owner_seat?: unknown; seats?: Record<string, unknown> } | undefined;
  const k = str(r?.owner_seat);
  return k && r?.seats && k in r.seats ? k : undefined;
}

/** The broker's 5-hour skip line (broker.py NEAR_5H): at or above it no pick takes the seat. */
const NEAR_5H = 90;

/**
 * the seat kept for the owner when the broker would give it to his pick now (signed in, not limited, usage known
 * and under the 5-hour skip line), else undefined. Unreadable seats.json = undefined.
 */
export function ownerSeatFree(file: string | undefined, now: Date = new Date()): string | undefined {
  if (!file) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const k = ownerSeatOf(raw);
    const s = k ? mapSeats(raw, now).find((x) => x.id === k) : undefined;
    return s && s.status === "ok" && (s.usage5h ?? 100) < NEAR_5H ? k : undefined;
  } catch {
    return undefined;
  }
}

/**
 * seatBlock over a seats.json path, read on every call (the broker rewrites it each beat). with `persona` (a
 * persona's wake into its home thread) the seat kept for the owner blocks too (`seat4 kept for Sam`), so a home thread
 * launched there before moves off it; the owner's desks leave `persona` unset.
 */
export function seatBlockerFor(file: string | undefined, o: { persona?: boolean; owner?: string } = {}): (seat: string | undefined) => string | undefined {
  return (seat) => {
    if (!file || !seat) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (o.persona && ownerSeatOf(raw) === seat) return `${seat} kept for ${o.owner ?? "the owner"}`;
      return seatBlock(mapSeats(raw), seat);
    } catch {
      return undefined;
    }
  };
}
