// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api, type RunUsage, type Seat, type UsageTotals } from "@/api";
import { UsageChip, UsagePanel } from "@/components/usage";

/** the Usage panel says what it does not count, shows live runs, splits per seat, and carries the seat quota strip. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const g = (key: string, over: object = {}) => ({
  key, label: key, runs: 4, collected: 2, pending: 1, missing: 1, skipped: 0, input: 1000, cacheWrite: 0, cacheRead: 0, output: 100, turns: 3, costUsd: 2.5,
  live: { runs: 0, input: 0, output: 0, costUsd: 0 }, ...over,
});
const totals = (groupBy: UsageTotals["groupBy"]): UsageTotals => ({
  from: "a", to: "b", groupBy,
  groups: groupBy === "seat" ? [g("seat3", { live: { runs: 1, input: 5_000_000, output: 20_000, costUsd: 3 } }), g("seat1")] : [g("Delivery Manager")],
  total: g("total", { runs: 8, missing: 2, live: { runs: 1, input: 5_000_000, output: 20_000, costUsd: 3 } }),
  missingReasons: { "no transcript on host3": 2 },
  updatedAt: new Date().toISOString(),
});
const seats: Seat[] = [
  { id: "seat1", name: "seat1", usage5h: 47, usageWeekly: 92, resetsAt: { fiveHour: new Date(Date.now() + 2 * 3600_000).toISOString(), weekly: new Date(Date.now() + 3 * 86400_000).toISOString() }, limited: false, inFlight: 2, status: "ok", org: "Memo" },
  { id: "seat3", name: "seat3", resetsAt: {}, limited: false, inFlight: 0, status: "unknown", reason: "usage endpoint HTTP 429" },
  { id: "seat5", name: "seat5", usage5h: 12, resetsAt: {}, limited: false, inFlight: 1, status: "ok", weeklySource: "not metered", modelWeekly: [{ model: "Fable", pct: 4, resetsAt: new Date(Date.now() + 2 * 86400_000).toISOString() }] },
];

describe("Usage panel (T55-S1)", () => {
  it("shows each seat's 5-hour / weekly quota, a per-seat tab, live runs apart, and missing runs with their reason", async () => {
    vi.spyOn(api, "listSeats").mockResolvedValue(seats);
    const spy = vi.spyOn(api, "getUsage").mockImplementation(async (q) => totals(q.groupBy));
    render(<UsagePanel />);
    const quota = await screen.findAllByTestId("seat-quota");
    expect(quota).toHaveLength(3);
    expect(quota[2].textContent).toContain("week not metered");
    expect(quota[2].textContent).toMatch(/Fable week 4% · in \d/);
    expect(quota[0].textContent).toContain("5h 47%");
    expect(quota[0].textContent).toContain("week 92%");
    expect(quota[0].textContent).toMatch(/resets in \d/);
    expect(quota[1].textContent).toContain("5h ?");
    expect((await screen.findAllByTestId("usage-row"))[0].textContent).toContain("4 (1 pending, 1 missing)");
    expect(screen.getByTestId("usage-missing").textContent).toContain("2 ended runs with no transcript found (2 no transcript on host3)");
    expect(screen.getByTestId("usage-live").textContent).toContain("1 run working: 5M in / 20k out · $3.00 so far");
    expect(screen.queryByText(/not counted yet/)).toBeNull();
    fireEvent.click(screen.getByText("per seat"));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: "seat" })));
    const rows = await screen.findAllByTestId("usage-row");
    expect(within(rows[0]).getByText("seat3")).toBeTruthy();
    expect(rows[0].textContent).toContain("1 live");
    expect(screen.getByText("Seat")).toBeTruthy();
  });

  it("a running run's chip shows its tokens so far, marked live; a never-ran wake shows 0", () => {
    const live: RunUsage = { model: "m", input: 10, cacheWrite: 0, cacheRead: 1_990, output: 500, turns: 2, costUsd: 0.12, estimate: true, collectedAt: new Date().toISOString(), source: "claude-code:host3", live: true };
    render(<UsageChip live={live} />);
    expect(screen.getByTestId("run-usage").textContent).toBe("live 2k in / 500 out · $0.12 so far");
    cleanup();
    render(<UsageChip usage={{ ...live, live: false, input: 0, cacheRead: 0, output: 0, source: "no-turn" }} />);
    expect(screen.getByTestId("run-usage").textContent).toBe("0 tokens");
    cleanup();
    render(<UsageChip usage={{ ...live, live: false, source: "same-as:run_12345678-0000-4000-8000-000000000001" }} />);
    expect(screen.getByTestId("run-usage").textContent).toBe("counted on run_12345678");
  });
});
