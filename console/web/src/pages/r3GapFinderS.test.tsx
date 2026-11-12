// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type Assignment, type Persona } from "@/api";
import { GAP_FINDER_WHERE, GapFinderPage, gapFinderFileOf, gapFinderPathOf, runCounts } from "@/pages/GapFinder";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// the Gap finder shows only while it is switched on; these tests run with it on.
beforeEach(() => {
  vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "pe_gap", name: "Gap finder" } as Persona]);
  vi.spyOn(api, "listAssignments").mockResolvedValue([{ id: "as_gap", personaId: "pe_gap", milestoneId: "ms_1", enabled: true } as Assignment]);
});

/**
 * /gap-finder lists the runs, each opens inside the console
 * with a way back, and one block says where its settings and findings live and who reads them.
 */
const RUNS = {
  runs: [
    { date: "2026-11-08", title: "What you asked for more than once and still don't have (8 Nov 2026)", page: "2026-11-08.html", row: "T79-G20261108", gaps: 6, still_pending: 2, in_flight: 4, closed: 0 },
  ],
};

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/gap-finder" element={<GapFinderPage />} />
        <Route path="/gap-finder/:date" element={<GapFinderPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("T79-S1 r3 the Gap finder's page", () => {
  it("lists its runs with their states and says where it lives", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(RUNS), { status: 200 }));
    at("/gap-finder");
    const run = await screen.findByTestId("gap-finder-run");
    expect(run.getAttribute("href")).toBe("/gap-finder/2026-11-08");
    expect(run.textContent).toContain("2 still pending · 4 in flight");
    expect(screen.getByTestId("gap-finder-back").getAttribute("href")).toBe("/");
    const where = screen.getByTestId("gap-finder-where");
    expect(where.textContent).toContain("The root, across every project");
    expect(within(where).getByTestId("gap-where-persona").getAttribute("href")).toBe(GAP_FINDER_WHERE.persona);
    expect(within(where).getByTestId("gap-where-schedule").getAttribute("href")).toBe(GAP_FINDER_WHERE.schedule);
    expect(within(where).getByTestId("gap-where-findings").getAttribute("href")).toContain("Acme/home_repo/tree/main/docs/status/gap-finder");
    expect(where.textContent).toContain("Read by");
  });

  it("a run opens its page inside the console, with Team home and All runs to go back", async () => {
    at("/gap-finder/2026-11-08");
    expect((await screen.findByTestId("gap-finder-frame")).getAttribute("src")).toBe("/landing/gap-finder/2026-11-08.html");
    expect(screen.getByTestId("gap-finder-all").getAttribute("href")).toBe("/gap-finder");
    expect(screen.getByTestId("gap-finder-back").getAttribute("href")).toBe("/");
  });

  it("a bad date frames nothing", async () => {
    at("/gap-finder/x..y");
    expect(screen.queryByTestId("gap-finder-frame")).toBeNull();
    expect((await screen.findByTestId("gap-finder-missing"))).toBeTruthy();
  });

  it("maps console paths and landing files both ways", () => {
    expect(gapFinderFileOf("/gap-finder/2026-11-08")).toBe("/landing/gap-finder/2026-11-08.html");
    expect(gapFinderFileOf("/gap-finder")).toBeUndefined();
    expect(gapFinderPathOf("/landing/gap-finder/2026-11-08.html")).toBe("/gap-finder/2026-11-08");
    expect(gapFinderPathOf("/landing/gap-finder/index.html")).toBe("/gap-finder");
    expect(runCounts({ date: "d", title: "t", page: "p", row: "r", gaps: 3 })).toBe("3 gaps");
  });
});
