// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import { PursuitsPage, SidebarPursuits } from "@/components/pursuits";
import { PursuitBackBar } from "@/components/pursuitsMap";
import type { Pursuit, PursuitsBody } from "@/api/pursuit-types";

/** Pursuits in the owner's order, what each rank buys, his reorder and park, and the way from a pursuit to its decks and back. */
const effort = (tier: string, words: string, maxWorkers: number) => ({ tier, wakeFactor: 1, maxWorkers, stallHours: 2, words });
const P = (id: string, name: string, rank: number | null, extra: Partial<Pursuit> = {}): Pursuit => ({
  id,
  name,
  greenWhen: "It is done.",
  state: "amber",
  greens: 1,
  total: 3,
  lines: [],
  totems: [],
  motion: "moving",
  lastMove: null,
  rank,
  parked: rank === null,
  effort: rank === null ? effort("Parked", "Parked: no wakes, no workers, no nudges.", 0) : rank === 1 ? effort("Top", "Wakes twice as often, up to 10 workers, nudged after 1 h idle.", 10) : effort("High", "Wakes at the pace set, up to 6 workers, nudged after 2 h idle.", 6),
  epics: [],
  milestones: [],
  ...extra,
});
const BODY: PursuitsBody = {
  staleDays: 3,
  effort: {
    minWakeMinutes: 15,
    outside: "A team in no pursuit keeps the pace it was set to, up to 10 workers.",
    tiers: [
      { name: "Top", upToRank: 1, wakeFactor: 2, maxWorkers: 10, stallHours: 1 },
      { name: "High", upToRank: 3, wakeFactor: 1, maxWorkers: 6, stallHours: 2 },
      { name: "Low", upToRank: 99, wakeFactor: 0.5, maxWorkers: 3, stallHours: 6 },
    ],
  },
  pursuits: [
    P("testers", "First testers", 1, {
      epics: [{ repo: "app", path: "docs/spines/launch.md", code: "EPIC-946", title: "Social launch", milestoneId: "ms_launch" }],
      milestones: [{ id: "ms_launch", title: "Social launch", via: "own", teams: [{ persona: "Delivery manager", enabled: true, pace: "every 60 min", paceNow: "every 30 min" }] }],
    }),
    P("notes", "Notes live", 2),
    P("tenants", "Multi-tenant", 3),
    P("vault", "Secrets kept", null),
  ],
};

describe("pursuits in order, effort follows", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens with the answer and the map: ranks in order, what each buys, milestones with teams, epics with their deck", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(
      <MemoryRouter>
        <PursuitsPage />
      </MemoryRouter>,
    );
    const map = await screen.findByTestId("pursuits-map");
    expect(screen.getByText(/First testers leads and gets the most effort/)).toBeTruthy();
    const rows = within(map).getAllByTestId("pursuit-map-row");
    expect(rows.map((r) => r.dataset.pursuit)).toEqual(["testers", "notes", "tenants", "vault"]);
    expect(rows.map((r) => within(r).getByTestId("pursuit-rank").dataset.rank)).toEqual(["1", "2", "3", "parked"]);
    expect(within(rows[0]).getByTestId("pursuit-effort").textContent).toBe("Wakes twice as often, up to 10 workers, nudged after 1 h idle.");
    expect(within(rows[0]).getByTestId("pursuit-map-milestone").textContent).toContain("Delivery manager every 30 min");
    expect(within(rows[0]).getByTestId("pursuit-map-milestone").getAttribute("href")).toBe("/milestones/ms_launch?tab=deck");
    expect(within(rows[0]).getByTestId("pursuit-map-epic").getAttribute("href")).toBe("/deck/app/EPIC-946?pursuit=testers");
    expect(within(screen.getByTestId("pursuits-parked")).getByText("Secrets kept")).toBeTruthy();
    expect(within(map).getAllByTestId("effort-tier").map((t) => t.textContent)).toEqual([
      "Rank 1 · TopWakes twice as often, up to 10 workers, nudged after 1 h idle.",
      "Ranks 2 to 3 · HighWakes the pace set, up to 6 workers, nudged after 2 h idle.",
      "Rank 4 and below · LowWakes half as often, up to 3 workers, nudged after 6 h idle.",
      "ParkedNo wakes, no workers, no nudges.",
    ]);
    // the scorecards follow in the same order, each with its rank and its decks
    const panels = screen.getAllByTestId("pursuit");
    expect(panels.map((p) => p.dataset.pursuit)).toEqual(["testers", "notes", "tenants", "vault"]);
    expect(within(panels[0]).getByTestId("pursuit-epic").getAttribute("href")).toBe("/deck/app/EPIC-946?pursuit=testers");
    expect(within(panels[0]).getByTestId("pursuit-milestone").textContent).toContain("Delivery manager: every 30 min (set every 60 min)");
  });

  it("an arrow moves a pursuit and saves the whole order; parked ones stay last", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    const order = vi.spyOn(api, "reorderPursuits").mockResolvedValue({ ok: true });
    render(
      <MemoryRouter>
        <PursuitsPage />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByTestId("pursuit-map-row");
    expect((within(rows[0]).getByTestId("pursuit-up") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(rows[2]).getByTestId("pursuit-up"));
    await waitFor(() => expect(order).toHaveBeenCalledWith(["testers", "tenants", "notes", "vault"]));
  });

  it("a drag drops a pursuit on another's place", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    const order = vi.spyOn(api, "reorderPursuits").mockResolvedValue({ ok: true });
    render(
      <MemoryRouter>
        <PursuitsPage />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByTestId("pursuit-map-row");
    fireEvent.dragStart(rows[2]);
    fireEvent.dragOver(rows[0]);
    fireEvent.drop(rows[0]);
    await waitFor(() => expect(order).toHaveBeenCalledWith(["tenants", "testers", "notes", "vault"]));
  });

  it("a failed save puts the order back and says why", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    vi.spyOn(api, "reorderPursuits").mockRejectedValue(new Error("write_skipped"));
    render(
      <MemoryRouter>
        <PursuitsPage />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByTestId("pursuit-map-row");
    fireEvent.click(within(rows[0]).getByTestId("pursuit-down"));
    expect((await screen.findByTestId("pursuits-map-error")).textContent).toBe("Not saved: write_skipped");
    expect(screen.getAllByTestId("pursuit-map-row").map((r) => r.dataset.pursuit)).toEqual(["testers", "notes", "tenants", "vault"]);
  });

  it("park and resume are one button each", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    const park = vi.spyOn(api, "parkPursuit").mockResolvedValue({ ok: true });
    render(
      <MemoryRouter>
        <PursuitsPage />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByTestId("pursuit-map-row");
    fireEvent.click(within(rows[1]).getByTestId("pursuit-park"));
    await waitFor(() => expect(park).toHaveBeenCalledWith("notes", true));
    fireEvent.click(within(rows[3]).getByTestId("pursuit-park"));
    await waitFor(() => expect(park).toHaveBeenCalledWith("vault", false));
  });

  it("an older server without ranks: the map shows, nothing to reorder", async () => {
    const old: PursuitsBody = { staleDays: 3, pursuits: BODY.pursuits.map(({ rank: _r, parked: _p, effort: _e, epics: _x, milestones: _m, ...p }) => p as Pursuit) };
    vi.spyOn(api, "listPursuits").mockResolvedValue(old);
    render(
      <MemoryRouter>
        <PursuitsPage />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("pursuits-map-hint")).textContent).toBe("Reordering arrives with the next console release.");
    expect(screen.getAllByTestId("pursuit-up").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryAllByTestId("pursuit-rank")).toHaveLength(0); // no "#undefined"
  });

  it("the sidebar lists them in order with their rank; a parked one says parked", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(
      <MemoryRouter>
        <SidebarPursuits />
      </MemoryRouter>,
    );
    const items = await screen.findAllByTestId("sidebar-pursuit");
    expect(items.map((i) => i.dataset.pursuit)).toEqual(["testers", "notes", "tenants", "vault"]);
    expect(within(items[0]).getByTestId("sidebar-pursuit-rank").textContent).toBe("1.");
    expect(within(items[3]).getByText("parked")).toBeTruthy();
  });

  it("an epic deck opened from a pursuit leads back to it and to every pursuit", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(
      <MemoryRouter initialEntries={["/deck/app/EPIC-946?pursuit=testers"]}>
        <Routes>
          <Route path="/deck/:repo/:code" element={<PursuitBackBar repo="app" code="EPIC-946" />} />
        </Routes>
      </MemoryRouter>,
    );
    const bar = await screen.findByTestId("deck-pursuit-bar");
    expect(within(bar).getByTestId("deck-pursuit-back").getAttribute("href")).toBe("/pursuits");
    expect(within(bar).getByTestId("deck-pursuit-open").getAttribute("href")).toBe("/pursuits/testers");
    expect(within(bar).getByTestId("pursuit-rank").dataset.rank).toBe("1");
  });

  it("a deck of an epic a pursuit names shows the bar without the link's hint; any other deck shows none", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(
      <MemoryRouter>
        <PursuitBackBar repo="Acme/app" code="EPIC-946" />
        <div data-testid="other">
          <PursuitBackBar repo="app" code="EPIC-999" />
        </div>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("deck-pursuit-open")).textContent).toBe("First testers");
    expect(within(screen.getByTestId("other")).queryByTestId("deck-pursuit-bar")).toBeNull();
  });
});
