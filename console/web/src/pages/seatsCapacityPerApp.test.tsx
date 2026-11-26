// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { SeatBoard, SeatCapacity } from "@/api/types";
import { SeatsPage } from "@/pages/Lists";
import { SeatCapacityView, capacityTone } from "@/components/seatCapacity";

/**
 * the Seats
 * screen opens with how full the seats are, per app, this week and at the last days' pace, and how much more load
 * fits. Percent only: no dollars on the screen.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const board: SeatBoard = { target: 20, signedIn: 1, workingNow: 0, personas: 0, runs24h: 0, seats: [] };
const full: SeatCapacity = {
  of: "team",
  week: 0.62,
  pace: 1.15,
  moreFits: 0,
  runsPerDay: 140,
  moreRunsPerDay: 0,
  apps: [
    { app: "EpicTeam", week: 0.34, pace: 0.63, runsPerDay: 90 },
    { app: "Social", week: 0.2, pace: 0.37, runsPerDay: 40 },
    { app: "Not metered", week: 0.08, pace: 0.15, runsPerDay: 0 },
  ],
  seats: { all: 16, working: 11, signedOut: 1, limited: 0, blocked: 4 },
  lost: 0.27,
  answer: "Your seats are 62% used this week and the last days ran at 115% of capacity: no more load fits.",
  at: "2026-11-26T12:00:00Z",
};

describe("Seats screen capacity", () => {
  it("opens with the answer, both readings per app, and what is out", async () => {
    vi.spyOn(api, "getSeatBoard").mockResolvedValue(board);
    const cap = vi.spyOn(api, "getSeatCapacity").mockResolvedValue(full);
    vi.spyOn(api, "getConsumption").mockResolvedValue({
      at: "2026-11-26T12:00:00Z", seats: 16, usedOfTotal: 0.47, rank: null, of: 2, wheel: null, file: "x",
      wheels: [
        { key: "obj-a", name: "Get the team to understand me", kind: "objective", ofTotal: 0.15, ofUsed: 0.33, runs: 9, outcomes: 3, madeTrue: 0.5, personas: [] },
        { key: "milestone:ms_1", name: "Spring launch", kind: "campaign", ofTotal: 0.05, ofUsed: 0.1, runs: 2, outcomes: 0, madeTrue: 0, personas: [] },
      ],
    } as any);
    render(<MemoryRouter><SeatsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("capacity-answer").textContent).toMatch(/no more load fits/));
    expect(cap).toHaveBeenCalledWith(undefined);
    expect(document.getElementById("capacity")).toBeTruthy();
    const nums = screen.getByTestId("capacity-numbers").textContent!;
    expect(nums).toContain("62%used this week");
    expect(nums).toContain("115%last days' pace");
    expect(nums).toContain("Nonemore load fits");
    const apps = screen.getAllByTestId("capacity-app").map((li) => li.textContent);
    expect(apps[0]).toMatch(/EpicTeam.*34% this week · 63% pace/);
    expect(apps).toHaveLength(3);
    expect(screen.getByTestId("capacity-seats").textContent).toMatch(/16 seats, 11 working, 1 signed out, 4 limited for days \(27% of the capacity out of use\)/);
    await waitFor(() => expect(screen.getAllByTestId("capacity-objective")).toHaveLength(2));
    const objs = screen.getAllByTestId("capacity-objective");
    expect(objs[0].textContent).toMatch(/Get the team to understand me.*33% of used · 15% of all/);
    expect(objs[0].querySelector("a")!.getAttribute("href")).toBe("/sets/obj-a?tab=consumption");
    expect(objs[1].querySelector("a")).toBeNull();
    expect(screen.getByTestId("seat-capacity").textContent).not.toMatch(/\$|€/);
  });

  it("says how much more fits when there is room", () => {
    const room = { ...full, pace: 0.5, moreFits: 1, moreRunsPerDay: 140, answer: "Your seats are 62% used this week at 50% pace: about 100% more load fits, about 140 more runs a day." };
    render(<SeatCapacityView c={room} />);
    expect(screen.getByTestId("capacity-numbers").textContent).toContain("+100%more load fits");
    expect(capacityTone(room)).toBe("room");
    expect(capacityTone(full)).toBe("full");
  });
});
