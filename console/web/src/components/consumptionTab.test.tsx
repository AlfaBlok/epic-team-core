// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { ConsumptionTab } from "./consumptionTab";

// the owner's voice note: "is this a chapter? I think yes ... you click and you get the breakdown of
// consumption. Like, which personas have been consuming what and what's been the contribution of the personas?"
const wheel = {
  key: "alignment", name: "EpicTeam: Get the team to understand me", kind: "objective", ofTotal: 0.154, ofUsed: 0.333, runs: 649, outcomes: 596, madeTrue: 0.8,
  personas: [
    { persona: "Ticket worker", ofTotal: 0.112, ofUsed: 0.243, ofWheel: 0.73, runs: 420, outcomes: 560, madeTrue: 0.9 },
    { persona: "Delivery Manager", ofTotal: 0.025, ofUsed: 0.053, ofWheel: 0.16, runs: 200, outcomes: 1, madeTrue: 0.3 },
  ],
};

describe("a wheel's Consumption chapter", () => {
  afterEach(() => (cleanup(), vi.restoreAllMocks()));

  it("opens on its share of the whole subscription and of what was used, then each persona's part and what it made true", async () => {
    vi.spyOn(api, "getConsumption").mockResolvedValue({ at: "2026-11-25T15:00:00Z", seats: 16, usedOfTotal: 0.46, wheel, rank: 1, of: 30, file: "docs/consumption/latest.json" });
    render(<ConsumptionTab wheel="alignment" />);
    expect((await screen.findByTestId("consumption-answer")).textContent).toContain("15% of your whole subscription · 33% of what was used");
    expect(screen.getByTestId("consumption-answer").textContent).toContain("number 1 of 30");
    expect(screen.getByTestId("consumption-bar").textContent).toContain("Everything else 31%");
    const rows = screen.getAllByTestId("consumption-persona");
    expect(rows.map((r) => r.getAttribute("data-persona"))).toEqual(["Ticket worker", "Delivery Manager"]);
    expect(rows[0]!.textContent).toContain("73% of this");
    expect(rows[1]!.textContent).toContain("1 thing made true in 200 runs");
  });

  it("says plainly when the wheel used nothing this week", async () => {
    vi.spyOn(api, "getConsumption").mockResolvedValue({ at: null, seats: 16, usedOfTotal: 0.46, wheel: null, rank: null, of: 30, file: "docs/consumption/latest.json" });
    render(<ConsumptionTab wheel="hair" />);
    expect((await screen.findByTestId("consumption-answer")).textContent).toContain("Nothing used this week");
    expect(screen.queryAllByTestId("consumption-persona")).toHaveLength(0);
  });
});
