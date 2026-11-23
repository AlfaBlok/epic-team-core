// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/api";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import type { TotemMaps } from "@/api/totem-types";
import { GoalSetPage, OBJECTIVE_TABS, objectiveTab } from "@/components/goalSets";
import { SCORECARD_PATH } from "@/lib/scorecards";

// the owner, vn_e6655c98: "each objective is the same class of thing and it should have the same
// class of tabs ... I have said this a trillion times, it's still not implemented." Every objective page shows these
// nine tabs in this order, whatever its product carries; a launch board, a feature list or a product deck is content
// inside one of them. This test refuses any other tab set.
const NINE = ["Key results", "Plan", "Inbox", "Chat", "Personas", "Board", "Context", "Pages", "Trackers"];

const obj = (id: string, name: string, rank: number): ScorecardNode => ({
  id,
  kind: "pursuit",
  name,
  rank,
  greens: 0,
  total: 1,
  spines: [],
  rows: [{ label: "Something counted", state: "red", value: "0", kind: "check" }],
  children: [],
});
const BODY: ScorecardsBody = {
  nodes: [obj("notes-live", "Notes: Get 5 testers", 1), obj("app-multi", "App: Get multi-tenant working", 2), obj("data-feed", "Data: Keep the feed running", 3)],
  spineInfo: {},
};
// three objectives shaped differently the day he said it: one with a launch board, one with a feature list and a
// product deck, one with no product at all.
const MAPS: TotemMaps = {
  statement: "",
  every: { totems: [], grows: [] },
  products: [
    { product: "notes", name: "Notes", repos: [], objectives: ["notes-live"], grows: [], totems: [
      { id: "plan", name: "Plan", shape: "page", tab: "plan", lives: {} },
      { id: "launch-board", name: "Launch board", shape: "table", tab: "launch", lives: {} },
      { id: "pricing", name: "Pricing", shape: "page", tab: "pricing", lives: {} },
      { id: "social-kit", name: "Social kit", shape: "page", tab: "kit", lives: {} },
    ] },
    { product: "app", name: "App", repos: [], objectives: ["app-multi"], grows: [], totems: [
      { id: "feature-list", name: "Feature list", shape: "table", tab: "features", lives: {} },
      { id: "product-deck", name: "Product deck", shape: "page", tab: "product", lives: {} },
      { id: "lean-core", name: "Lean core", shape: "page", tab: "core", lives: {} },
      { id: "something-new", name: "Something new", shape: "page", tab: "newthing", lives: {} },
    ] },
  ],
};

beforeEach(() => {
  vi.spyOn(api, "listScorecards").mockResolvedValue(BODY);
  vi.spyOn(api, "listStatus").mockResolvedValue({ milestones: [], items: [], needsYou: 0, at: "2026-11-22T12:00:00Z" } as never);
  vi.spyOn(api, "listPursuits").mockResolvedValue({ staleDays: 3, pursuits: [] } as never);
  vi.spyOn(api, "listReviewItems").mockResolvedValue([] as never);
  vi.spyOn(api, "getTotems").mockResolvedValue(MAPS);
  vi.spyOn(api, "getTotem").mockImplementation(async (product: string, id: string) => ({ product, id, name: id, shape: "page", where: "somewhere", empty: true }) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const open = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={SCORECARD_PATH} element={<GoalSetPage />} />
      </Routes>
    </MemoryRouter>,
  );
const tabsShown = () => screen.getAllByTestId(/^set-tab-/).map((t) => t.textContent?.replace(/\d+$/, ""));

describe("every objective page has the same nine tabs", () => {
  it("the one list is the nine, in his order", () => {
    expect(OBJECTIVE_TABS.map((t) => t.label)).toEqual(NINE);
  });

  for (const id of ["notes-live", "app-multi", "data-feed"]) {
    it(`${id} shows exactly the nine tabs, no more, no fewer`, async () => {
      open(`/sets/${id}`);
      await screen.findByTestId("set-tab-trackers");
      // the product map has loaded: its totems used to add tabs of their own.
      await new Promise((r) => setTimeout(r, 0));
      expect(tabsShown()).toEqual(NINE);
    });
  }

  it("a launch board lives inside the Board; an old ?tab=launch link opens the Board", async () => {
    expect(objectiveTab("launch")).toBe("kanban");
    // the objective names its launch board itself: only then does the Board show it.
    vi.spyOn(api, "listPursuits").mockResolvedValue({ staleDays: 3, pursuits: [{ id: "notes-live", name: "Notes", totems: [{ label: "Launch board", url: "/launch" }] }] } as never);
    open("/sets/notes-live?tab=launch");
    expect(await screen.findByTestId("set-kanban")).toBeTruthy();
    const homed = await screen.findAllByTestId("homed-totem");
    expect(homed.map((h) => h.dataset.tab)).toEqual(["launch"]);
    expect(screen.getByTestId("set-tab-kanban").getAttribute("aria-current")).toBe("page");
    expect(tabsShown()).toEqual(NINE);
  });

  it("an objective's Context holds only its where-we-are: no product page, pricing, feature list or lean core", async () => {
    for (const old of ["features", "product", "pricing", "core"]) expect(objectiveTab(old)).toBe("context");
    open("/sets/app-multi?tab=features");
    const ctx = await screen.findByTestId("set-context");
    expect(await within(ctx).findByTestId("where-we-are")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryAllByTestId("homed-totem")).toHaveLength(0);
    expect(screen.queryByTestId("set-product")).toBeNull();
    expect(ctx.children).toHaveLength(1);
    expect(tabsShown()).toEqual(NINE);
  });

  it("an old social kit link opens the Plan, which shows the wheel's plan and no kit", async () => {
    expect(objectiveTab("kit")).toBe("plan");
    vi.spyOn(api, "listPursuits").mockResolvedValue({ staleDays: 3, pursuits: [{ id: "notes-live", name: "Notes", kit: true, totems: [] }] } as never);
    vi.spyOn(api, "getPursuitKit").mockResolvedValue({ pursuit: { id: "notes-live", name: "Notes" }, kit: { id: "notes-live", name: "Notes", tagline: "Hi.", colours: [], accounts: [], bios: [], templates: [] } } as never);
    vi.spyOn(api, "getObjectivePlan").mockResolvedValue({ id: "notes-live", path: "docs/scorecards/notes-live.json", present: false, keyResults: [] });
    open("/sets/notes-live?tab=kit");
    expect(await screen.findByTestId("plan-tab")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryAllByTestId("social-kit")).toHaveLength(0);
    expect(screen.queryAllByTestId("homed-totem").map((h) => h.dataset.tab)).not.toContain("kit");
    expect(tabsShown()).toEqual(NINE);
  });
});
