import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONSUMPTION_FILE, readConsumption } from "../src/consumption.js";

// the owner's voice note: "percentage of total subscription and percentage of the used subscription
// ... at the objective level ... which personas have been consuming what".
const w = (key: string, ofTotal: number, ofUsed: number, kind = "objective") => ({
  key, name: key, kind, ofTotal, ofUsed, runs: 3, outcomes: 2, madeTrue: 0.5,
  personas: [{ persona: "Ticket worker", ofTotal, ofUsed, ofWheel: 1, runs: 3, outcomes: 2, madeTrue: 0.5 }],
});
const home = (body: unknown) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cons-"));
  fs.mkdirSync(path.join(d, "docs/consumption"), { recursive: true });
  fs.writeFileSync(path.join(d, CONSUMPTION_FILE), JSON.stringify(body));
  return d;
};

describe("a wheel's Consumption chapter", () => {
  const file = {
    at: "2026-11-25T15:00:00Z", seats: 16, usedOfTotal: 0.46,
    wheels: { alignment: w("alignment", 0.15, 0.33), servers: w("servers", 0.02, 0.05) }, order: ["alignment", "servers"],
    personas: [{ persona: "Ticket worker", ofTotal: 0.28, ofUsed: 0.61, runs: 9, outcomes: 9, madeTrue: 0.86 }],
    milestones: { "milestone:ms_1": w("milestone:ms_1", 0.01, 0.02, "campaign") },
  };
  it("an objective reads its share of the whole subscription and of what was used, its rank, and its personas", () => {
    const c = readConsumption(home(file), "servers");
    expect(c.wheel?.ofTotal).toBe(0.02);
    expect(c.wheel?.ofUsed).toBe(0.05);
    expect([c.rank, c.of, c.usedOfTotal]).toEqual([2, 2, 0.46]);
    expect(c.wheel?.personas[0]?.persona).toBe("Ticket worker");
    expect(c.wheels).toBeUndefined();
  });
  it("a campaign reads its milestone's line; `all` lists every wheel and persona; a wheel that used nothing reads null", () => {
    const h = home(file);
    expect(readConsumption(h, "milestone:ms_1").wheel?.kind).toBe("campaign");
    const all = readConsumption(h, "all");
    expect(all.wheels?.map((x) => x.key)).toEqual(["alignment", "servers"]);
    expect(all.personas).toHaveLength(1);
    expect(readConsumption(h, "hair").wheel).toBeNull();
    expect(readConsumption(undefined, "hair")).toMatchObject({ wheel: null, at: null, usedOfTotal: 0 });
  });
});
