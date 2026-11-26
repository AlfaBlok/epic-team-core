import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { mapSeats } from "./seats.js";
import { resolveRepo } from "./repos.js";
import { sameRepo } from "./repoNames.js";
import { DEFAULT_TENANT } from "../db.js";
import { homeRepo, socialProduct } from "../identity.js";
import { TEAM_HEAD } from "../brand.js";
import { PRODUCTS_FILE, parseProducts, productOfCampaign, type ProductRef } from "../products.js";
import { foldApps, seatCapacity, seatWeights, type CapacityRunIn, type CapacitySeatIn, type SeatCapacity } from "./seatCapacity.js";

/**
 * the live reads behind GET /api/seats/capacity (the home team's seats from the seat broker's seats.json) and
 * a customer's own seats (hosted customerSeats.ts). Runs are labelled by app: a run of another of our worlds is that
 * world's product (the social one, by name); a customer's world is "Customers' workspaces" (never a name); a run of the
 * home world is the product of its campaign (products.json deck or posts repo), else the product its title names, else
 * the console's own product for the home repo, else its campaign's title. The four biggest show, the rest fold.
 */
interface RunRow {
  seat: string | null;
  tenant: string | null;
  plan: string | null;
  skin: string | null;
  tname: string | null;
  repo: string | null;
  title: string | null;
  cost: number | null;
  at: string;
}

export const CUSTOMERS = "Customers' workspaces";
const bare = (r: string) => r.trim().toLowerCase().replace(/\.git$/, "").split("/").pop() ?? "";

export function appLabeller(products: ProductRef[], home = homeRepo(), homeTenant = DEFAULT_TENANT) {
  const memo = new Map<string, string>();
  return (r: Pick<RunRow, "tenant" | "plan" | "skin" | "tname" | "repo" | "title">, viewer = homeTenant): string => {
    if (r.tenant && r.tenant !== viewer) {
      if (r.plan !== "internal") return CUSTOMERS;
      return r.skin === "social" ? socialProduct() : r.tname || r.tenant;
    }
    const key = `${r.repo ?? ""}\0${r.title ?? ""}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const p = r.repo ? productOfCampaign(products, r.repo) : null;
    const title = r.title ?? "";
    const named = products.find((x) => x.name.length > 3 && new RegExp(`\\b${x.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(title));
    const out = p?.name ?? named?.name ?? (r.repo && sameRepo(bare(r.repo), bare(home)) ? TEAM_HEAD.name : title || "Unnamed work");
    memo.set(key, out);
    return out;
  };
}

/** runs on seats in the last `days`, with their token cost (runs.usage costUsd, a weight only) and campaign. */
export function seatRuns(db: Database.Database | undefined, o: { since: string; tenant?: string; seatLike?: string }): RunRow[] {
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT r.seat AS seat, r.tenant_id AS tenant, t.plan AS plan, t.skin AS skin, t.name AS tname, m.repo AS repo, m.title AS title,
                CAST(json_extract(r.usage, '$.costUsd') AS REAL) AS cost, r.started_at AS at
           FROM runs r
           LEFT JOIN milestones m ON m.id = r.milestone_id
           LEFT JOIN tenants t ON t.id = r.tenant_id
          WHERE r.started_at >= @since
            AND (@tenant IS NULL OR r.tenant_id = @tenant)
            AND (@seatLike IS NULL OR r.seat LIKE @seatLike)`,
      )
      .all({ since: o.since, tenant: o.tenant ?? null, seatLike: o.seatLike ?? null }) as RunRow[];
  } catch {
    return [];
  }
}

export function readProducts(reposRoot: string): { products: ProductRef[]; fees: unknown } {
  try {
    const dir = resolveRepo(reposRoot, homeRepo())?.path;
    if (!dir) return { products: [], fees: undefined };
    const text = fs.readFileSync(path.join(dir, PRODUCTS_FILE), "utf8");
    return { products: parseProducts(text), fees: (JSON.parse(text) as { seat_fees?: unknown }).seat_fees };
  } catch {
    return { products: [], fees: undefined };
  }
}

export interface SeatCapacityView extends SeatCapacity {
  /** whose seats: "team" (the home team's own) or a customer world. */
  of: string;
}

/** the home team's seats: seats.json as the broker writes it, weighted by seat_fees, every world's runs on them. */
export function homeSeatCapacity(seatsRaw: unknown, db: Database.Database | undefined, reposRoot: string, now = new Date()): SeatCapacityView {
  const { products, fees } = readProducts(reposRoot);
  const w = seatWeights(fees);
  const seats: CapacitySeatIn[] = mapSeats(seatsRaw, now).map((s) => ({
    id: s.id,
    weekly: s.usageWeekly,
    five: s.usage5h,
    weeklyResetsAt: s.resetsAt.weekly,
    fiveResetsAt: s.resetsAt.fiveHour,
    limitedUntil: s.resetsAt.limitedUntil,
    status: s.status,
    weight: w[s.id] ?? 1,
  }));
  const label = appLabeller(products);
  const since = new Date(now.getTime() - 8 * 86_400_000).toISOString();
  const runs: CapacityRunIn[] = seatRuns(db, { since, seatLike: "seat%" }).map((r) => ({ seat: r.seat, app: label(r), cost: r.cost ?? 0, at: r.at }));
  const c = seatCapacity(seats, runs, now);
  return { ...c, apps: foldApps(c.apps), of: "team" };
}

/** a customer world's own seats (customer_seats rows), each weighing one; its runs split by campaign. */
export function worldSeatCapacity(
  rows: { seat: number; state: string; weekly_pct: number | null; five_hour_pct: number | null; weekly_resets_at: string | null; five_hour_resets_at: string | null }[],
  db: Database.Database | undefined,
  world: string,
  now = new Date(),
): SeatCapacityView {
  const seats: CapacitySeatIn[] = rows.map((r) => ({
    id: `seat${r.seat}`,
    weekly: r.weekly_pct ?? undefined,
    five: r.five_hour_pct ?? undefined,
    weeklyResetsAt: r.weekly_resets_at ?? undefined,
    fiveResetsAt: r.five_hour_resets_at ?? undefined,
    status: r.state === "signed_out" || r.state === "off" ? "logged_out" : r.weekly_pct == null ? "unknown" : "ok",
    weight: 1,
  }));
  const label = appLabeller([], "\0", world); // its own campaigns by title, never our products
  const since = new Date(now.getTime() - 8 * 86_400_000).toISOString();
  // a customer's job runs carry no seat of ours: every run of the world counts for its own seats
  const runs: CapacityRunIn[] = seatRuns(db, { since, tenant: world }).map((r) => ({ seat: null, app: label({ ...r, tenant: world }, world), cost: r.cost ?? 0, at: r.at }));
  const c = seatCapacity(seats, runs, now);
  return { ...c, apps: foldApps(c.apps), of: world };
}
