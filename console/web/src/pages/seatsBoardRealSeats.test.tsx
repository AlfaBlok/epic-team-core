// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { SeatBoard } from "@/api/types";
import { SeatsPage } from "@/pages/Lists";

/** one card per real seat with its persona and load, and the gap to 20 said in words, never filled in. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const board: SeatBoard = {
  target: 20,
  signedIn: 2,
  workingNow: 1,
  personas: 2,
  runs24h: 5,
  seats: [
    { id: "seat1", plan: "Claude Team", state: "working", usage5h: 40, usageWeekly: 20, running: 1, now: [{ name: "Ticket worker", world: "EpicTeam", runs: 1 }], day: [{ name: "Publisher", world: "SocialApp", runs: 4 }], runs24h: 5 },
    { id: "seat2", state: "signed_out", running: 0, now: [], day: [], runs24h: 0 },
    { id: "seat3", plan: "Claude Team", state: "free", usage5h: 3, running: 0, now: [], day: [], runs24h: 0 },
  ],
};

describe("Seats screen", () => {
  it("shows each real seat, its persona and load, and says how many of the 20 are missing", async () => {
    vi.spyOn(api, "getSeatBoard").mockResolvedValue(board);
    render(<MemoryRouter><SeatsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("seat-card")).toHaveLength(3));
    expect(screen.getByText("Seat 1")).toBeTruthy();
    expect(screen.getByText("Ticket worker")).toBeTruthy();
    expect(screen.getByText("Publisher")).toBeTruthy();
    expect(screen.getByText("Signed out")).toBeTruthy();
    expect(screen.getByTestId("seat-target").textContent).toMatch(/3 of the 20 subscriptions .* 17 more are not bought yet\. 1 signed out\./);
  });
});
