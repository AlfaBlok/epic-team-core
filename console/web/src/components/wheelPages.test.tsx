// @vitest-environment jsdom
/**
 * Pages live inside the wheel they belong to (the owner, vn_dad96778): a Pages tab on each objective and milestone,
 * and the global Pages list still shows them all together, each placed in its objective or "not placed".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { PagesBody } from "@/api/pages-types";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import { indexScorecards } from "@/lib/scorecards";
import { pagesOfMilestone, pagesOfObjective, placePages, wheelCounts } from "@/lib/wheelPages";
import { WheelPagesTab } from "@/components/wheelPages";
import { PagesIndexPage } from "@/components/pagesIndex";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const node = (id: string, name: string, spines: string[], children: ScorecardNode[] = []): ScorecardNode =>
  ({ id, kind: "pursuit", name, greens: 0, total: 0, spines, rows: [], children }) as unknown as ScorecardNode;

const SETS: ScorecardsBody = {
  nodes: [
    node("testers", "Five testers use Notes", ["notes:docs/EPIC-910.md"]),
    node("social", "Five testers use Posts", ["app:docs/spines/epic-909.md", "app:docs/spines/epic-907.md"], [node("social~video", "Clips", ["app:docs/spines/epic-907.md"])]),
  ],
  spineInfo: {
    "notes:docs/EPIC-910.md": { repo: "notes", path: "docs/EPIC-910.md", code: "EPIC-910", codes: ["E907-S6"] },
    "app:docs/spines/epic-909.md": { repo: "app", path: "docs/spines/epic-909.md", code: "EPIC-909", codes: ["E907-S5"] },
    "app:docs/spines/epic-907.md": { repo: "app", path: "docs/spines/epic-907.md", code: "EPIC-907", codes: [] },
  },
} as unknown as ScorecardsBody;

const page = (port: number, row: string, repo: string, epic: string, title = `Page ${port}`) => ({ port, url: `http://pages.example:${port}/`, title, row, repo, epic });
const PAGES: PagesBody = {
  total: 5,
  groups: [
    { id: "app-EPIC-907", repo: "app", epic: "EPIC-907", epicTitle: "", pages: [page(9301, "E907-S3", "app", "EPIC-907", "Video clip")] },
    { id: "app-EPIC-908", repo: "app", epic: "EPIC-908", epicTitle: "", pages: [page(9302, "E907-S4", "app", "EPIC-908", "Plans")] },
    { id: "app-EPIC-909", repo: "app", epic: "EPIC-909", epicTitle: "", pages: [page(9303, "E907-S5", "app", "EPIC-909", "Week one")] },
    { id: "notes-EPIC-910", repo: "acme/notes", epic: "EPIC-910", epicTitle: "", pages: [page(9304, "E907-S6", "acme/notes", "EPIC-910", "Testers")] },
    { id: "home_pick-EPIC", repo: "home_pick", epic: "EPIC", epicTitle: "", pages: [page(9204, "E907-S7", "home_pick", "EPIC", "Where to live")] },
  ],
};

describe("pages inside their wheel", () => {
  const ix = indexScorecards(SETS);

  it("places a page by its row's spine, else by its epic, else not placed", () => {
    const placed = placePages(PAGES, SETS, ix);
    const where = Object.fromEntries(placed.map((p) => [p.row, p.wheel?.id ?? "not placed"]));
    // one by its row, one (a row no spine lists) by its epic, one across "acme/notes" and "notes".
    expect(where).toEqual({ "E907-S3": "social", "E907-S4": "not placed", "E907-S5": "social", "E907-S6": "testers", "E907-S7": "not placed" });
    expect(wheelCounts(placed, SETS.nodes)).toEqual([
      { id: "testers", name: "Five testers use Notes", count: 1 },
      { id: "social", name: "Five testers use Posts", count: 2 },
    ]);
  });

  it("an objective's Pages tab holds its own tree's pages, a set inside it only its own", () => {
    expect(pagesOfObjective(PAGES, SETS, ix, "social").map((p) => p.row)).toEqual(["E907-S3", "E907-S5"]);
    expect(pagesOfObjective(PAGES, SETS, ix, "social~video").map((p) => p.row)).toEqual(["E907-S3"]);
    expect(pagesOfObjective(PAGES, SETS, ix, "testers").map((p) => p.row)).toEqual(["E907-S6"]);
  });

  it("a milestone no objective holds (the home pick) holds its repo's pages", () => {
    expect(pagesOfMilestone(PAGES, "acme/home_pick").map((p) => p.title)).toEqual(["Where to live"]);
  });

  it("the tab lists each page opening it, and links to every page", () => {
    render(
      <MemoryRouter>
        <WheelPagesTab pages={pagesOfMilestone(PAGES, "home_pick")} what="milestone" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("wheel-pages-answer").textContent).toContain("1 page was made for this milestone.");
    const link = within(screen.getByTestId("wheel-page")).getByRole("link");
    expect(link.getAttribute("href")).toBe("http://pages.example:9204/");
    expect(screen.getByTestId("wheel-pages-all").getAttribute("href")).toBe("/pages");
  });

  it("the global list still shows every page, with each objective's count opening its Pages tab", async () => {
    vi.spyOn(api, "listPages").mockResolvedValue(PAGES);
    vi.spyOn(api, "listScorecards").mockResolvedValue(SETS);
    render(
      <MemoryRouter initialEntries={["/pages"]}>
        <PagesIndexPage />
      </MemoryRouter>,
    );
    const wheels = await screen.findAllByTestId("pages-wheel");
    expect(wheels.map((w) => w.textContent)).toEqual(["Five testers use Notes1 page", "Five testers use Posts2 pages"]);
    expect(within(wheels[1]).getByRole("link").getAttribute("href")).toBe("/sets/social?tab=pages");
    expect(screen.getByTestId("pages-not-placed").textContent).toContain("2 pages");
    expect(screen.getByTestId("pages-summary").textContent).toBe("5 pages in 5 epics across 3 repos");
  });
});
