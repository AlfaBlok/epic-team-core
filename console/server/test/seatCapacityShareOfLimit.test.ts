import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TENANT, openDb } from "../src/db.js";
import { homeRepo, socialProduct } from "../src/identity.js";
import { NOT_METERED, foldApps, seatCapacity, seatWeights, type CapacitySeatIn } from "../src/adapters/seatCapacity.js";
import { CUSTOMERS, appLabeller, homeSeatCapacity, worldSeatCapacity } from "../src/adapters/seatCapacityRead.js";
import { readRoutes } from "../src/routes/read.js";
import { isTenantSafe } from "../src/auth/routeScope.js";

/**
 * the Seats screen's capacity,
 * read live: each seat's weekly percent weighted by its price, split per app by the runs it served in its own week, the
 * last days' pace, and how much more load fits. Percent only, no dollars, no customer's name.
 */
const NOW = new Date("2026-11-26T12:00:00Z");
const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const reset = (hFromNow: number) => new Date(NOW.getTime() + hFromNow * 3600_000).toISOString();

describe("seatCapacity", () => {
  // both seats half way through their week (reset in 84 h)
  const seats: CapacitySeatIn[] = [
    { id: "seat1", weekly: 60, weeklyResetsAt: reset(84), status: "ok", weight: 5 },
    { id: "seat9", weekly: 20, weeklyResetsAt: reset(84), status: "ok", weight: 1 },
    { id: "seat2", status: "logged_out", weight: 5 },
  ];
  const runs = [
    { seat: "seat1", app: "EpicTeam", cost: 3, at: at(10) },
    { seat: "seat1", app: "Social", cost: 1, at: at(20) },
    { seat: "seat1", app: "EpicTeam", cost: 99, at: at(24 * 6) }, // before seat1's week began (84 h ago): not in its split
    { seat: "seat9", app: "Research", cost: 1, at: at(5) },
  ];
  const c = seatCapacity(seats, runs, NOW);

  it("weighs each working seat by price and leaves a signed-out seat out", () => {
    // (60*5 + 20*1) / (100*5 + 100*1) = 320 / 600
    expect(c.week).toBeCloseTo(320 / 600, 5);
    expect(c.seats).toMatchObject({ all: 3, working: 2, signedOut: 1 });
    expect(c.lost).toBeCloseTo(500 / 1100, 5);
  });

  it("splits each seat's use over the runs of its own week, per app", () => {
    const by = Object.fromEntries(c.apps.map((a) => [a.app, a.week]));
    expect(by.EpicTeam).toBeCloseTo((300 * 0.75) / 600, 5);
    expect(by.Social).toBeCloseTo((300 * 0.25) / 600, 5);
    expect(by.Research).toBeCloseTo(20 / 600, 5);
    expect(c.apps.reduce((a, x) => a + x.week, 0)).toBeCloseTo(c.week, 5);
  });

  it("reads the pace over the part of the week gone by and says how much more fits", () => {
    // half the week gone: pace = 320 / 300
    expect(c.pace).toBeCloseTo(320 / 300, 5);
    expect(c.moreFits).toBe(0);
    expect(c.answer).toMatch(/no more load fits/);
    expect(c.apps.reduce((a, x) => a + x.pace, 0)).toBeCloseTo(c.pace!, 5);
    const light = seatCapacity([{ id: "seat1", weekly: 25, weeklyResetsAt: reset(84), status: "ok", weight: 1 }], [{ seat: "seat1", app: "EpicTeam", cost: 1, at: at(1) }], NOW);
    expect(light.pace).toBeCloseTo(0.5, 5);
    expect(light.moreFits).toBeCloseTo(1, 5);
    expect(light.answer).toMatch(/about 100% more load fits/);
    expect(JSON.stringify(c)).not.toMatch(/\$|usd|cost/i);
  });

  it("counts a seat with use but no run seen as Not metered, and a seat limited for days as out", () => {
    const x = seatCapacity(
      [
        { id: "seat3", weekly: 40, weeklyResetsAt: reset(84), status: "ok", weight: 1 },
        { id: "seat6", weekly: 100, weeklyResetsAt: reset(84), limitedUntil: reset(24 * 5), status: "limited", weight: 1 },
      ],
      [],
      NOW,
    );
    expect(x.apps).toEqual([expect.objectContaining({ app: NOT_METERED, week: 0.4 })]);
    expect(x.seats.blocked).toBe(1);
    expect(x.seats.working).toBe(1);
  });

  it("says so with no seat, and folds small apps", () => {
    expect(seatCapacity([], [], NOW).answer).toBe("No AI seat connected yet.");
    const f = foldApps(["A", "B", "C", "D", "E", "F"].map((app, i) => ({ app, week: 0.1 - i / 100, pace: 0.1, runsPerDay: 1 })));
    expect(f.map((a) => a.app)).toEqual(["A", "B", "C", "D", "Everything else"]);
    expect(f[4].week).toBeCloseTo(0.06 + 0.05, 5);
  });

  it("weighs seats from the products file's seat fees", () => {
    expect(seatWeights({ premium: { eur_month: 100, seats: ["seat1"] }, standard: { eur_month: 20, seats: ["seat9"] } })).toEqual({ seat1: 5, seat9: 1 });
    expect(seatWeights(undefined)).toEqual({});
  });
});

describe("live reads", () => {
  function db() {
    const d = openDb(":memory:");
    d.prepare("INSERT OR IGNORE INTO tenants (id, name, plan, created_at) VALUES (@h, @h, 'internal', @c)").run({ h: DEFAULT_TENANT, c: at(500) });
    d.prepare("INSERT INTO tenants (id, name, plan, skin, created_at) VALUES ('social-world','Sam','internal','social',@c), ('cust-1','Acme Corp team','team','console',@c)").run({ c: at(500) });
    d.prepare("INSERT INTO milestones (id, title, repo, path, created_at) VALUES ('ms_team','root',@home,'docs/spines/root.md',@c), ('ms_cust','Acme launch','acme/site','docs/spines/root.md',@c)").run({ c: at(500), home: homeRepo() });
    const run = d.prepare("INSERT INTO runs (id, assignment_id, milestone_id, started_at, seat, outcome, tenant_id, usage) VALUES (?, 'as_x', ?, ?, ?, 'done', ?, ?)");
    const u = (usd: number) => JSON.stringify({ costUsd: usd, input: 1, output: 1 });
    run.run("r1", "ms_team", at(3), "seat1", DEFAULT_TENANT, u(3));
    run.run("r2", null, at(4), "seat1", "social-world", u(1));
    run.run("r3", "ms_cust", at(2), "seat1", "cust-1", u(1));
    run.run("r4", "ms_cust", at(2), null, "cust-1", u(2)); // a customer's job on its own seat
    return d;
  }
  const seatsRaw = {
    seats: {
      seat1: { logged_in: true, usage: { five_hour_pct: 10, weekly_pct: 50, weekly_resets_at: reset(84), status: "allowed" } },
      seat2: { logged_in: false, usage: { status: "unknown" } },
    },
  };

  it("labels runs by app and never names a customer", () => {
    const label = appLabeller([], homeRepo());
    expect(label({ tenant: DEFAULT_TENANT, plan: "internal", skin: "console", tname: null, repo: `Acme/${homeRepo()}`, title: "root" })).toBe("EpicTeam");
    expect(label({ tenant: "social-world", plan: "internal", skin: "social", tname: "Sam", repo: null, title: null })).toBe(socialProduct());
    expect(label({ tenant: "cust-1", plan: "team", skin: "console", tname: "Acme Corp team", repo: null, title: null })).toBe(CUSTOMERS);
    const v = homeSeatCapacity(seatsRaw, db(), "/nonexistent", NOW);
    expect(v.apps.map((a) => a.app).sort()).toEqual([CUSTOMERS, "EpicTeam", socialProduct()].sort());
    expect(v.week).toBeCloseTo(0.5, 5);
    expect(JSON.stringify(v)).not.toMatch(/Acme/);
  });

  it("reads a customer's own seats and splits by its own campaigns", () => {
    const v = worldSeatCapacity(
      [{ seat: 1, state: "connected", weekly_pct: 30, five_hour_pct: 5, weekly_resets_at: reset(84), five_hour_resets_at: null }],
      db(),
      "cust-1",
      NOW,
    );
    expect(v.of).toBe("cust-1");
    expect(v.apps).toEqual([expect.objectContaining({ app: "Acme launch", week: 0.3 })]);
    expect(v.pace).toBeCloseTo(0.6, 5);
  });

  it("GET /seats/capacity answers from seats.json and the runs; a customer reads only its own", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e46s121-"));
    try {
      const seatsFile = path.join(dir, "seats.json");
      fs.writeFileSync(seatsFile, JSON.stringify(seatsRaw));
      const r = readRoutes({ reposRoot: dir, seatsFile } as any, {} as any, undefined, db());
      const res = await r.request("/seats/capacity");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.of).toBe("team");
      expect(body.answer).toMatch(/Your seats are 50% used this week/);
      fs.rmSync(seatsFile);
      expect((await r.request("/seats/capacity")).status).toBe(503);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(isTenantSafe("GET", "/api/tenants/cust-1/seats/capacity")).toBe(true);
    expect(isTenantSafe("GET", "/api/seats/capacity")).toBe(false);
  });
});
