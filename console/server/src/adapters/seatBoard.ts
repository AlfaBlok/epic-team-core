import type Database from "better-sqlite3";
import { mapSeats, type Seat } from "./seats.js";
import { isDeliveryManager } from "../inbox/asks.js";
import { TICKET_WORKER } from "../outcomeDefs.js";
import { DEFAULT_TENANT } from "../db.js";
import { socialProduct } from "../identity.js";

/**
 * The Seats screen: every AI subscription the team runs on (M1's seats.json, nothing made up), the
 * persona on it now and the personas that used it in the last 24 h (the runs table), and its load. Seats float:
 * the broker gives each wake a free seat, so "who is on it" is the runs on it, never a fixed owner. Private
 * names stay out: no account org, and a customer world's runs count as "A customer's agent" with no name.
 */
export interface BoardPersona {
  name: string;
  /** the product the persona works for (the home team, the social product…); absent for a customer's agent. */
  world?: string;
  runs: number;
}
export interface BoardSeat {
  id: string;
  /** "Claude Team" etc.; absent when the seat has not reported its plan (a signed-out seat). */
  plan?: string;
  state: "working" | "free" | "limited" | "signed_out" | "unknown";
  usage5h?: number;
  usageWeekly?: number;
  limitedUntil?: string;
  /** turns running on it now (the broker's count). */
  running: number;
  /** who is on it now (open runs on this seat). */
  now: BoardPersona[];
  /** who used it in the last 24 h, most runs first. */
  day: BoardPersona[];
  runs24h: number;
  lastUsed?: string;
}
export interface SeatBoard {
  seats: BoardSeat[];
  /** the seat count the landing page promises (20 subscriptions): a target, never filled with made-up seats. */
  target: number;
  signedIn: number;
  workingNow: number;
  personas: number;
  runs24h: number;
  readAt?: string;
}

export const SEAT_TARGET = 20;
const PLAN: Record<string, string> = { team: "Claude Team", max: "Claude Max", pro: "Claude Pro", enterprise: "Claude Enterprise" };
export const CUSTOMER_AGENT = "A customer's agent";

interface RunRow {
  seat: string;
  tenant: string;
  plan: string | null;
  skin: string | null;
  tname: string | null;
  persona: string | null;
  child: number;
  open: number;
}

const tryRows = <T>(f: () => T[]): T[] => {
  try {
    return f();
  } catch {
    return [];
  }
};

/** the product a world of ours is, the way the console names a team (app.ts teamName). */
function worldName(r: RunRow): string {
  if (r.tenant === DEFAULT_TENANT) return "EpicTeam";
  return r.skin === "social" ? socialProduct() : r.tname || r.tenant;
}

/** the persona a run counts as: a Delivery Manager's child run is a Ticket worker (outcomes.ts); a customer's run has no name. */
function who(r: RunRow): { name: string; world?: string } {
  if (r.plan !== "internal") return { name: CUSTOMER_AGENT };
  const name = r.persona ?? "Unnamed persona";
  return { name: r.child && isDeliveryManager(name) ? TICKET_WORKER : name, world: worldName(r) };
}

function tally(rows: RunRow[]): BoardPersona[] {
  const m = new Map<string, BoardPersona>();
  for (const r of rows) {
    const w = who(r);
    const k = `${w.world ?? ""}\0${w.name}`;
    const cur = m.get(k) ?? { ...w, runs: 0 };
    cur.runs++;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

export function seatBoard(seatsRaw: unknown, db: Database.Database | undefined, now: Date = new Date()): SeatBoard {
  const seats: Seat[] = mapSeats(seatsRaw, now);
  const raw = ((seatsRaw as { seats?: Record<string, any> })?.seats ?? {}) as Record<string, any>;
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  // an open run older than 12 h is a lost one (no end recorded), not someone on the seat now
  const openSince = new Date(now.getTime() - 12 * 3600_000).toISOString();
  const rows: RunRow[] = db
    ? tryRows(
        () =>
          db
            .prepare(
              `SELECT r.seat AS seat, r.tenant_id AS tenant, t.plan AS plan, t.skin AS skin, t.name AS tname, p.name AS persona,
                      (r.parent_run_id IS NOT NULL) AS child,
                      (r.ended_at IS NULL AND r.outcome = 'running' AND r.started_at >= @open) AS open
                 FROM runs r
                 LEFT JOIN personas p ON p.id = COALESCE(r.persona_id, (SELECT a.persona_id FROM assignments a WHERE a.id = r.assignment_id))
                 LEFT JOIN tenants t ON t.id = r.tenant_id
                WHERE r.seat IS NOT NULL AND r.seat <> 'None' AND (r.started_at >= @since OR (r.ended_at IS NULL AND r.outcome = 'running' AND r.started_at >= @open))`,
            )
            .all({ since, open: openSince }) as RunRow[],
      )
    : [];
  const bySeat = new Map<string, RunRow[]>();
  for (const r of rows) bySeat.set(r.seat, [...(bySeat.get(r.seat) ?? []), r]);

  const out: BoardSeat[] = seats.map((s) => {
    const mine = bySeat.get(s.id) ?? [];
    const rs = raw[s.id] ?? {};
    const running = Math.max(typeof rs.running === "number" ? rs.running : 0, s.inFlight, mine.filter((r) => r.open).length);
    const state: BoardSeat["state"] =
      s.status === "logged_out" ? "signed_out" : s.status === "limited" ? "limited" : running > 0 ? "working" : s.status === "ok" ? "free" : "unknown";
    const sub = typeof rs.subscription === "string" ? rs.subscription : undefined;
    return {
      id: s.id,
      plan: sub ? (PLAN[sub] ?? `Claude ${sub}`) : undefined,
      state,
      usage5h: s.usage5h,
      usageWeekly: s.usageWeekly,
      limitedUntil: s.resetsAt.limitedUntil,
      running,
      now: tally(mine.filter((r) => r.open)),
      day: tally(mine),
      runs24h: mine.length,
      lastUsed: typeof rs.last_used === "string" ? rs.last_used : undefined,
    };
  });
  const names = new Set(tally(rows).map((p) => `${p.world ?? ""}\0${p.name}`));
  return {
    seats: out,
    target: SEAT_TARGET,
    signedIn: out.filter((s) => s.state !== "signed_out").length,
    workingNow: out.filter((s) => s.state === "working").length,
    personas: names.size,
    runs24h: out.reduce((n, s) => n + s.runs24h, 0),
    readAt: typeof (seatsRaw as { updated?: unknown })?.updated === "string" ? (seatsRaw as { updated: string }).updated : undefined,
  };
}
