import { describe, expect, it } from "vitest";
import { DEFAULT_TENANT, openDb } from "../src/db.js";
import { socialProduct } from "../src/identity.js";
import { CUSTOMER_AGENT, SEAT_TARGET, seatBoard } from "../src/adapters/seatBoard.js";

/**
 * the Seats screen shows every AI subscription in seats.json (never padded to the 20 the landing page
 * shows), the persona on each now and over 24 h from the runs table (a Delivery Manager's child run is a Ticket
 * worker), its load, and no private names (no org; a customer world's runs carry no persona name).
 */
const NOW = new Date("2026-11-18T10:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

const seats = {
  updated: "2026-11-18T09:59:00Z",
  seats: {
    seat1: { org: "SecretCo", subscription: "team", logged_in: true, running: 1, in_flight: 1, usage: { five_hour_pct: 40, weekly_pct: 20, status: "allowed" } },
    seat2: { org: null, subscription: null, logged_in: false, usage: { status: "unknown" } },
    seat3: { org: "SecretCo", subscription: "team", logged_in: true, maxed_until: "2026-11-18T12:00:00Z", usage: { five_hour_pct: 100, weekly_pct: 50, status: "limited" } },
    seat10: { org: "Other", subscription: "team", logged_in: true, running: 0, usage: { five_hour_pct: 5, weekly_pct: 9, status: "allowed" } },
  },
};

function db() {
  const d = openDb(":memory:");
  d.prepare("INSERT OR IGNORE INTO tenants (id, name, plan, created_at) VALUES (@h, @h, 'internal', @c)").run({ h: DEFAULT_TENANT, c: ago(100) });
  d.prepare("INSERT INTO tenants (id, name, plan, skin, created_at) VALUES ('social-world','Sam','internal','social',@c), ('cust-1','Acme Corp team','team','console',@c)").run({ c: ago(100) });
  const persona = d.prepare("INSERT INTO personas (id, name, remit, created_at, tenant_id) VALUES (?, ?, '', ?, ?)");
  persona.run("pe_dm", "Delivery Manager", ago(100), DEFAULT_TENANT);
  persona.run("pe_pub", "Publisher", ago(100), "social-world");
  persona.run("pe_cust", "Acme Secret Persona", ago(100), "cust-1");
  const run = d.prepare(
    "INSERT INTO runs (id, assignment_id, started_at, ended_at, seat, outcome, persona_id, tenant_id, parent_run_id) VALUES (?, 'as_x', ?, ?, ?, ?, ?, ?, ?)",
  );
  run.run("r1", ago(2), ago(1), "seat1", "done", "pe_dm", DEFAULT_TENANT, null);
  run.run("r2", ago(0.5), null, "seat1", "running", "pe_dm", DEFAULT_TENANT, "r1"); // a DM's child: a Ticket worker, on it now
  run.run("r3", ago(3), ago(2.5), "seat1", "done", "pe_pub", "social-world", null);
  run.run("r4", ago(4), ago(3.5), "seat3", "done", "pe_cust", "cust-1", null);
  run.run("r5", ago(30), ago(29), "seat3", "done", "pe_dm", DEFAULT_TENANT, null); // older than 24 h: not counted
  run.run("r6", ago(20), null, "seat10", "running", "pe_dm", DEFAULT_TENANT, null); // open for 20 h: lost, not on it now
  return d;
}

describe("seatBoard", () => {
  const b = seatBoard(seats, db(), NOW);

  it("lists every real seat and only those, against the 20 target", () => {
    expect(b.seats.map((s) => s.id)).toEqual(["seat1", "seat2", "seat3", "seat10"]);
    expect(b.target).toBe(SEAT_TARGET);
    expect(b.signedIn).toBe(3);
    expect(b.workingNow).toBe(1);
  });

  it("names the persona on each seat now and over 24 h", () => {
    const s1 = b.seats.find((s) => s.id === "seat1")!;
    expect(s1.state).toBe("working");
    expect(s1.plan).toBe("Claude Team");
    expect(s1.now).toEqual([{ name: "Ticket worker", world: "EpicTeam", runs: 1 }]);
    expect(s1.day.map((p) => `${p.name}@${p.world}`).sort()).toEqual(["Delivery Manager@EpicTeam", `Publisher@${socialProduct()}`, "Ticket worker@EpicTeam"]);
    expect(s1.runs24h).toBe(3);
    expect(b.seats.find((s) => s.id === "seat10")!.now).toEqual([]);
  });

  it("keeps private names out", () => {
    const s3 = b.seats.find((s) => s.id === "seat3")!;
    expect(s3.state).toBe("limited");
    expect(s3.day).toEqual([{ name: CUSTOMER_AGENT, runs: 1 }]);
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/SecretCo|Other|Acme/);
    expect(b.seats.find((s) => s.id === "seat2")!.state).toBe("signed_out");
  });

  it("works with no database and with no seats", () => {
    expect(seatBoard(seats, undefined, NOW).seats).toHaveLength(4);
    expect(seatBoard({}, undefined, NOW).seats).toEqual([]);
  });
});
