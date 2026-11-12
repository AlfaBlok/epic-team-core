// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type RunHostsSeries } from "@/api";
import { RunsPage } from "@/pages/Runs";
import { bandPath, edgePath, RunHostsSection } from "@/components/runHosts";

/** the Runs page's Live runs by host chart: stacked by host, 24 h / 7 d, hover gives the count per host. */

beforeEach(() => {
  window.localStorage.clear();
  if (!("PointerEvent" in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const series = (range: "24h" | "7d", unknown = 0): RunHostsSeries => {
  const n = range === "24h" ? 288 : 336;
  const bucketMinutes = range === "24h" ? 5 : 30;
  const now = new Date("2026-11-03T12:00:00.000Z");
  const fill = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
  return {
    range,
    start: new Date(now.getTime() - n * bucketMinutes * 60_000).toISOString(),
    now: now.toISOString(),
    bucketMinutes,
    counts: { main: fill((i) => (i >= 100 && i < 120 ? 2 : 0)), worker: fill((i) => (i >= 110 && i < 200 ? 3 : 0)), unknown: fill((i) => (unknown && i === 115 ? 1 : 0)) },
    peak: { count: 5 + (unknown ? 1 : 0), at: new Date(now.getTime() - (n - 115) * bucketMinutes * 60_000).toISOString(), byHost: { main: 2, worker: 3, unknown } },
    runs: { main: 4, worker: 9, unknown },
    sources: { recorded: 3, launch: 0, environment: 8, parent: 2, seat: 0, unknown },
    unknownIds: unknown ? ["run_x"] : [],
  };
};

describe("T48-S29 Live runs by host", () => {
  it("stacks main and worker (unknown only when there is one), hovers per host, and switches to 7 d", async () => {
    const spy = vi.spyOn(api, "getRunHosts").mockImplementation(async ({ range }) => series(range, range === "7d" ? 1 : 0));
    render(
      <MemoryRouter>
        <RunHostsSection />
      </MemoryRouter>,
    );
    const chart = await screen.findByTestId("run-hosts-chart");
    expect(spy).toHaveBeenCalledWith({ range: "24h" });
    expect(screen.getByTestId("run-hosts").hasAttribute("data-fold-section")).toBe(true);
    expect(screen.getByTestId("run-hosts-count").textContent).toBe("5");
    expect(screen.getByTestId("run-hosts-range-24h").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("run-hosts-legend").textContent).toBe("main4 runsworker9 runs");
    expect(screen.queryByTestId("run-hosts-band-unknown")).toBeNull();
    expect(screen.queryByTestId("run-hosts-unknown")).toBeNull();
    const plot = screen.getByTestId("run-hosts-plot");
    expect(plot.getAttribute("aria-label")).toMatch(/13 runs \(main 4, worker 9\); peak 5 at \d\d:\d\d/);
    plot.getBoundingClientRect = () => ({ left: 0, width: 288, top: 0, height: 140, right: 288, bottom: 140, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(plot, { clientX: 115.5 });
    const tip = screen.getByTestId("run-hosts-tooltip").textContent!;
    expect(tip).toMatch(/^\d\d:\d\d–\d\d:\d\d3 worker2 main5 live in all$/);
    fireEvent.pointerLeave(plot);
    expect(screen.queryByTestId("run-hosts-tooltip")).toBeNull();
    expect(within(chart).getByTestId("run-hosts-table").querySelectorAll("tbody tr").length).toBeGreaterThanOrEqual(24);

    fireEvent.click(screen.getByTestId("run-hosts-range-7d"));
    await waitFor(() => expect(screen.getByTestId("run-hosts-count").textContent).toBe("6"));
    expect(spy).toHaveBeenLastCalledWith({ range: "7d" });
    expect(screen.getByTestId("run-hosts-band-unknown")).toBeTruthy();
    expect(screen.getByTestId("run-hosts-unknown").textContent).toBe("1 of 14 runs have no host on record, so they show as unknown.");
    expect(screen.getByTestId("run-hosts-table").querySelectorAll("tbody tr").length).toBeGreaterThanOrEqual(7);
  });

  it("sits on the Runs page under Active agents (mock data from the server's own function)", async () => {
    render(
      <MemoryRouter>
        <RunsPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("run-hosts-chart");
    const sections = [...document.querySelectorAll("[data-fold-section]")].map((s) => s.getAttribute("data-testid"));
    expect(sections.indexOf("run-hosts")).toBe(sections.indexOf("active-agents") + 1);
  });

  it("draws each band as steps between the lower and upper stack", () => {
    expect(bandPath([0, 0], [1, 2], 2)).toBe("M0 70V70H1V0H2V140H1V140H0Z");
    expect(edgePath([0, 0, 1, 0], [1, 2, 1, 2], 2)).toBe("M0 70H1V0H2M3 0H4");
  });
});
