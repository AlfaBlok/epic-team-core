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

  it("the registry's own objective wins over the row's spine ", () => {
    // a check row lives in the social epic but its page was made for the testers objective: it shows there only.
    const named = { total: 1, groups: [{ id: "app-EPIC-909", repo: "app", epic: "EPIC-909", epicTitle: "", pages: [{ ...page(9305, "E907-S5", "app", "EPIC-909", "Check"), objective: "testers" }] }] } as PagesBody;
    expect(placePages(named, SETS, ix).map((p) => p.wheel?.id)).toEqual(["testers"]);
    expect(pagesOfObjective(named, SETS, ix, "testers").map((p) => p.port)).toEqual([9305]);
    expect(pagesOfObjective(named, SETS, ix, "social")).toEqual([]);
    expect(pagesOfObjective(named, SETS, ix, "social~video")).toEqual([]);
  });

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

  // the owner: "Pages shows every file homed there": the answer and the counts hold the
  // pages and notes kept in the repo too, so a tab never says fewer than it lists.
  it("the tab's answer counts the served pages and the files kept in the repo", () => {
    const entries = [
      { id: "app:docs/status/e907-s1/index.html", repo: "app", path: "docs/status/e907-s1", open: "docs/status/e907-s1/index.html", title: "Kept page", kind: "page" as const, row: "E907-S1", files: 1 },
      { id: "app:docs/status/e907-s2.md", repo: "app", path: "docs/status/e907-s2.md", open: "docs/status/e907-s2.md", title: "Kept note", kind: "note" as const, row: "E907-S2", files: 1 },
    ];
    render(
      <MemoryRouter>
        <WheelPagesTab pages={pagesOfMilestone(PAGES, "home_pick")} what="objective" files={{ entries }} />
      </MemoryRouter>,
    );
    const answer = screen.getByTestId("wheel-pages-answer");
    expect(answer.textContent).toContain("3 pages and notes were made for this objective: 1 served, 2 kept in the repo.");
    expect(answer.dataset.total).toBe("3");
    expect(screen.getAllByTestId("wheel-page-files-row")).toHaveLength(2);
  });

  it("each objective's count in the global list adds its kept files", () => {
    const placed = placePages(PAGES, SETS, indexScorecards(SETS));
    const files = new Map<string, unknown[]>([["testers", [1, 2, 3]], ["social", []]]);
    expect(wheelCounts(placed, SETS.nodes, files).map((w) => [w.id, w.count])).toEqual([
      ["testers", 4],
      ["social", 2],
    ]);
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

  // a page whose spine no tree holds names the objective (or world) it was made for, or why none holds it.
  const NAMED: PagesBody = {
    total: 3,
    groups: [
      {
        id: "app-EPIC-908",
        repo: "app",
        epic: "EPIC-908",
        epicTitle: "",
        pages: [
          { ...page(9302, "E907-S4", "app", "EPIC-908", "Plans"), objective: "testers" },
          { ...page(9305, "E907-S8", "app", "EPIC-908", "Errand"), notPlaced: "a personal errand" },
          // a page that names no objective goes by its row's tree (one that names one goes there, test above).
          { ...page(9303, "E907-S5", "app", "EPIC-909", "Week one") },
        ],
      },
      { id: "home_pick-EPIC", repo: "home_pick", epic: "EPIC", epicTitle: "", pages: [{ ...page(9204, "E907-S7", "home_pick", "EPIC", "Where to live"), objective: "home", objectiveName: "The home" }] },
    ],
  };

  it("an objective made from existing work shows that work's pages: pages follow the tickets under its key results", () => {
    // a new objective made from an errand row, whose page names the errands objective; its key result lists the rows.
    const born = { ...node("gadget", "Buy a gadget", ["errands:docs/spines/gadget.md"]), keyResults: [{ label: "The gadget is bought", kind: "key-result", work: [{ code: "E907-S9", repo: "errands", kind: "ticket" }, { code: "E907-S8", repo: "acme/errands", kind: "ticket" }] }] } as unknown as ScorecardNode;
    const body = { ...SETS, nodes: [...SETS.nodes, node("errands", "Handle errands", ["errands:docs/spines/root.md"]), born] } as ScorecardsBody;
    const bix = indexScorecards(body);
    const made = (port: number, row: string) => ({ ...page(port, row, "errands", "errands"), objective: "errands" });
    const research = { total: 3, groups: [{ id: "errands", repo: "errands", epic: "errands", epicTitle: "", pages: [made(9650, "E907-S8"), made(9651, "E907-S9"), made(9645, "E907-S3")] }] } as PagesBody;
    expect(pagesOfObjective(research, body, bix, "gadget").map((p) => p.port)).toEqual([9650, 9651]);
    // still on the objective it names: an item may sit in two chapters, nothing moves off.
    expect(pagesOfObjective(research, body, bix, "errands").map((p) => p.port)).toEqual([9650, 9651, 9645]);
    // a page whose row is under no key result of the objective stays off it.
    expect(pagesOfObjective(research, body, bix, "testers")).toEqual([]);
  });

  it("places a page its tree misses where it names itself, a world after the objectives", () => {
    const placed = placePages(NAMED, SETS, ix);
    expect(Object.fromEntries(placed.map((p) => [p.row, p.wheel?.id ?? "not placed"]))).toEqual({ "E907-S4": "testers", "E907-S8": "not placed", "E907-S5": "social", "E907-S7": "home" });
    expect(wheelCounts(placed, SETS.nodes)).toEqual([
      { id: "testers", name: "Five testers use Notes", count: 1 },
      { id: "social", name: "Five testers use Posts", count: 1 },
      { id: "home", name: "The home", count: 1, world: true },
    ]);
    expect(pagesOfObjective(NAMED, SETS, ix, "testers").map((p) => p.row)).toEqual(["E907-S4"]);
    expect(pagesOfObjective(NAMED, SETS, ix, "social").map((p) => p.row)).toEqual(["E907-S5"]);
  });

  it("the global list names each page not placed with its reason", async () => {
    vi.spyOn(api, "listPages").mockResolvedValue(NAMED);
    vi.spyOn(api, "listScorecards").mockResolvedValue(SETS);
    render(
      <MemoryRouter initialEntries={["/pages"]}>
        <PagesIndexPage />
      </MemoryRouter>,
    );
    const wheels = await screen.findAllByTestId("pages-wheel");
    expect(wheels.map((w) => w.textContent)).toEqual(["Five testers use Notes1 page", "Five testers use Posts1 page", "The home1 page"]);
    expect(within(wheels[2]).queryByRole("link")).toBeNull();
    expect(screen.getAllByTestId("pages-not-placed-page").map((li) => li.textContent)).toEqual(["Errand: a personal errand"]);
  });
});
