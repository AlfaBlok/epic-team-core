// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ActiveAgentsSeries } from "@/api";
import { RunsPage } from "@/pages/Runs";
import { ActiveAgentsSection, dayIn, niceMax, shiftDay, stepPath, viewerTimeZone } from "@/components/activeAgents";
import { activeSeries } from "../../../server/src/activeAgents";

/** the Runs page's Active agents chart: today's step line from the server's series, the peak, hover, previous day. */

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no PointerEvent: without it fireEvent drops clientX.
  if (!("PointerEvent" in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tz = viewerTimeZone();
const today = dayIn(new Date(), tz);
const series = (day: string, counts: number[], peak: ActiveAgentsSeries["peak"]): ActiveAgentsSeries => {
  const start = new Date(`${day}T00:00:00Z`).toISOString();
  return { day, tz, start, end: new Date(Date.parse(start) + 86_400_000).toISOString(), bucketMinutes: 1, counts, peak, runs: 7, now: new Date().toISOString() };
};

describe("T48-S20 Active agents chart", () => {
  it("shows today's line with the peak in the fold header, hover gives count and time, and steps back to yesterday", async () => {
    const counts = Array.from({ length: 600 }, (_, i) => (i >= 120 && i < 180 ? 4 : i >= 300 && i < 360 ? 2 : 0));
    const spy = vi.spyOn(api, "getActiveAgents").mockImplementation(async ({ day }) =>
      day === today ? series(today, counts, { count: 4, at: new Date(Date.parse(`${today}T02:00:00Z`)).toISOString(), runIds: ["a", "b", "c", "d"] }) : series(day!, new Array(1440).fill(1), { count: 1, at: `${day}T00:00:00.000Z`, runIds: ["y"] }),
    );
    render(
      <MemoryRouter>
        <ActiveAgentsSection />
      </MemoryRouter>,
    );
    const section = await screen.findByTestId("active-agents-chart");
    expect(spy).toHaveBeenCalledWith({ day: today, tz });
    // Same fold header and pill as every section; the pill is the day's peak.
    const box = screen.getByTestId("active-agents");
    expect(box.hasAttribute("data-fold-section")).toBe(true);
    expect(screen.getByTestId("active-agents-count").textContent).toBe("4");
    expect(screen.getByTestId("active-agents-meta").textContent).toMatch(/^peak 4 at \d\d:\d\d$/);
    expect(screen.getByTestId("active-agents-day").textContent).toBe("Today");
    expect((screen.getByTestId("active-agents-next") as HTMLButtonElement).disabled).toBe(true);
    // The line stops at the last bucket the server sent (now), the peak is marked.
    expect(screen.getByTestId("active-agents-line").getAttribute("d")).toMatch(/H600$/);
    expect(screen.getByTestId("active-agents-peak").textContent).toMatch(/^peak 4 · \d\d:\d\d$/);
    expect(screen.getByTestId("active-agents-plot").getAttribute("aria-label")).toMatch(/peak 4 at/);
    // Hover at minute 150 (of a 1440-minute day 1440 px wide): 4 agents.
    const plot = screen.getByTestId("active-agents-plot");
    plot.getBoundingClientRect = () => ({ left: 0, width: 1440, top: 0, height: 120, right: 1440, bottom: 120, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(plot, { clientX: 150.5 });
    expect(screen.getByTestId("active-agents-tooltip").textContent).toMatch(/^4 agents · \d\d:\d\d$/);
    fireEvent.pointerMove(plot, { clientX: 1000 }); // after now: nothing
    expect(screen.queryByTestId("active-agents-tooltip")).toBeNull();
    // A table view for screen readers and exact reading.
    expect(within(section).getByTestId("active-agents-table").querySelectorAll("tbody tr")).toHaveLength(10);
    // Back a day.
    fireEvent.click(screen.getByTestId("active-agents-prev"));
    await waitFor(() => expect(screen.getByTestId("active-agents-day").textContent).toBe("Yesterday"));
    expect(spy).toHaveBeenLastCalledWith({ day: shiftDay(today, -1), tz });
    await waitFor(() => expect(screen.getByTestId("active-agents-count").textContent).toBe("1"));
    expect((screen.getByTestId("active-agents-next") as HTMLButtonElement).disabled).toBe(false);
    // Folds to its header line.
    fireEvent.click(screen.getByTestId("active-agents-toggle"));
    expect(screen.queryByTestId("active-agents-chart")).toBeNull();
    expect(screen.getByTestId("active-agents-count").textContent).toBe("1");
  });

  it("sits on the Runs page above the wakes and reads only the series, never a run list for it", async () => {
    const spy = vi.spyOn(api, "getActiveAgents");
    render(
      <MemoryRouter>
        <RunsPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("active-agents-chart");
    expect(spy).toHaveBeenCalledTimes(1);
    const sections = [...document.querySelectorAll("[data-fold-section]")].map((s) => s.getAttribute("data-testid"));
    expect(sections.indexOf("active-agents")).toBeLessThan(Math.max(sections.indexOf("runs"), sections.length));
  });

  it("draws a step path, a tidy axis top, and steps days across months", () => {
    expect(stepPath([0, 0, 2, 2, 1], 2)).toEqual({ line: "M0 120H2V0H4V60H5", area: "M0 120H2V0H4V60H5V120H0Z" });
    expect([0, 1, 2, 3, 5, 6, 11, 23].map(niceMax)).toEqual([2, 2, 2, 5, 5, 10, 20, 50]);
    expect(shiftDay("2026-11-01", -1)).toBe("2026-10-31");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(dayIn(new Date("2026-11-01T23:30:00Z"), "Europe/Madrid")).toBe("2026-11-02");
    // The mock client uses the server's own series function.
    expect(activeSeries([], { day: "2026-11-02", tz: "UTC", now: new Date("2026-11-03T00:00:00Z") }).counts).toHaveLength(1440);
  });
});
