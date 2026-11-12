// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Persona, type Run, type RunUsage, type UsageTotals } from "@/api";
import { compactTokens, UsageChip, UsagePanel } from "@/components/usage";
import { RunTimeline } from "@/components/timeline";
import { timelineGroups } from "@/lib/derive";
import { createMockClient } from "@/api/mock";
import { seed } from "@/api/seed";

/** tokens per wake in Activity and the Runs page Usage panel. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  model: "claude-opus-5-5", input: 20, cacheWrite: 50_000, cacheRead: 560_000, output: 8_216, turns: 11, costUsd: 0.53, estimate: true,
  collectedAt: "2026-10-24T02:00:00Z", source: "claude-code:host3", ...over,
});

describe("UsageChip", () => {
  it("shows in/out tokens and the cost estimate", () => {
    render(<UsageChip usage={usage()} />);
    const chip = screen.getByTestId("run-usage");
    expect(chip.textContent).toBe("610k in / 8.2k out · $0.53 est.");
    expect(chip.title).toMatch(/cache read 560,000/);
    expect(chip.title).toMatch(/estimate/);
  });
  it("skipped wake reads 0 tokens; unknown price reads cost n/a; nothing before collection", () => {
    const { rerender, container } = render(<UsageChip usage={usage({ source: "no-thread", input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0 })} />);
    expect(screen.getByTestId("run-usage").textContent).toBe("0 tokens");
    rerender(<UsageChip usage={usage({ costUsd: null })} />);
    expect(screen.getByTestId("run-usage").textContent).toMatch(/cost n\/a$/);
    rerender(<UsageChip usage={undefined} />);
    expect(container.textContent).toBe("");
  });
  it("compacts numbers", () => {
    expect([950, 1_234, 12_345, 3_400_000, 1_000_000].map(compactTokens)).toEqual(["950", "1.2k", "12k", "3.4M", "1M"]);
  });
});

describe("Activity row", () => {
  it("shows the usage chip on a wake", () => {
    const persona = { id: "pe_u", name: "Unblocker", remit: "", skills: [], model: "", mayWrite: false, createdAt: "" } as Persona;
    const runs: Run[] = [
      { id: "run_a", assignmentId: "as_u", milestoneId: "ms", personaId: "pe_u", startedAt: "2026-10-24T01:51:00Z", endedAt: "2026-10-24T01:58:00Z", outcome: "progressed", summary: "answered", usage: usage() },
    ];
    render(
      <MemoryRouter>
        <RunTimeline groups={timelineGroups(runs, [{ id: "as_u", milestoneId: "ms", personaId: "pe_u", cadence: { type: "interval", everyMinutes: 60 }, enabled: true }])} personas={[persona]} now={Date.parse("2026-10-24T03:00:00Z")} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("run-usage").textContent).toBe("610k in / 8.2k out · $0.53 est.");
  });
});

describe("Usage panel", () => {
  const totals = (groupBy: "persona" | "milestone", from: string): UsageTotals => ({
    from, to: "x", groupBy,
    groups: [
      { key: "pe_u", label: groupBy === "persona" ? "Unblocker" : "whatgpt E0", runs: 5, collected: 5, pending: 0, skipped: 3, input: 30, cacheWrite: 100_000, cacheRead: 900_000, output: 20_000, turns: 30, costUsd: 1.234 },
      { key: "pe_dm", label: "Delivery Manager", runs: 2, collected: 1, pending: 1, skipped: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, costUsd: 0 },
    ],
    total: { key: "total", label: "Total", runs: 7, collected: 6, pending: 1, skipped: 3, input: 30, cacheWrite: 100_000, cacheRead: 900_000, output: 20_000, turns: 30, costUsd: 1.234 },
  });

  it("lists per persona for the last 24 h, switches to 7 days and per milestone, and shows skipped / pending counts", async () => {
    const now = Date.parse("2026-10-24T12:00:30Z");
    const spy = vi.spyOn(api, "getUsage").mockImplementation(async (q) => totals(q.groupBy as "persona" | "milestone", q.from!));
    render(<UsagePanel now={now} />);
    const rows = await screen.findAllByTestId("usage-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Unblocker")).toBeTruthy();
    expect(rows[0].textContent).toContain("5 (3 never ran)");
    expect(rows[0].textContent).toContain("$1.23");
    expect(rows[1].textContent).toContain("1 pending");
    expect(screen.getByTestId("usage-total").textContent).toBe("1M in / 20k out · $1.23 est.");
    expect(spy).toHaveBeenLastCalledWith({ from: "2026-10-23T12:00:00.000Z", to: "2026-10-24T12:00:00.000Z", groupBy: "persona" });
    fireEvent.click(screen.getByText("Last 7 days"));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ from: "2026-10-17T12:00:00.000Z", to: "2026-10-24T12:00:00.000Z", groupBy: "persona" }));
    fireEvent.click(screen.getByText("per project"));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: "milestone" })));
    expect(await screen.findByText("whatgpt E0")).toBeTruthy();
  });

  it("mock client groups seeded runs (collected usage, pending runs)", async () => {
    const mock = createMockClient({ db: seed(new Date()) });
    const t = await mock.getUsage({ groupBy: "persona" });
    expect(t.total.collected).toBeGreaterThanOrEqual(1);
    expect(t.total.output).toBeGreaterThanOrEqual(8_900);
    expect(t.total.runs).toBe(t.total.collected + t.total.pending);
  });
});
