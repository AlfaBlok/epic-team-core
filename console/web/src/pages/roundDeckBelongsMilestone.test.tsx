// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { api, type MilestoneTree, type NodeTree, type TreeNode } from "@/api";
import { AppRoutes } from "@/App";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { deckTarget } from "@/pages/BookRedirect";
import { deckTabHref, spineOf } from "@/pages/Milestone";

/**
 * no global
 * Epic deck in the sidebar; each milestone page, epic page and epic row in the tree opens its own deck. Round 3 (the owner:
 * "it's one more tab section, like chat or summary or definitions. And then the deck shows inside of it, within the tab"):
 * the deck is the milestone page's Deck tab, shown inside it.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function Where() {
  const l = useLocation();
  return <span data-testid="where">{`${l.pathname}${l.search}${l.hash}`}</span>;
}

const at = (path: string, skin: Skin = SKINS.console) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <Where />
      </MemoryRouter>
    </SkinProvider>,
  );

const node = (key: string, id: string, kind: TreeNode["kind"], path: string | undefined, children: TreeNode[] = [], code?: string): TreeNode => ({
  key,
  id,
  kind,
  title: id,
  status: "active",
  color: "blue",
  ...(path ? { path } : {}),
  ...(code ? { code } : {}),
  children,
  flags: [],
});

function treeOf(milestoneId: string, rootPath: string): MilestoneTree {
  const row = node("r/e47/E947-S4", "E947-S4", "ticket", undefined);
  const e47 = node("r/e47", "EPIC-947", "spine", "docs/spines/epic-947-epic-book-per-milestone.md", [row], "EPIC-947");
  const odd = node("r/odd", "Odd spine", "spine", "docs/spines/odd-one.md", [], "odd");
  const root = node("r", "root", "spine", rootPath, [e47, odd], "root");
  return { milestoneId, root, counts: { grey: 0, blue: 4, yellow: 0, red: 0, green: 0 }, nonGreen: 4, closed: 0, flagged: 0, source: "spines", warnings: [] };
}

describe("the deck belongs to its milestone and to each epic", () => {
  it("the sidebar has no global Epic deck; /deck and /deck/all still open by URL", async () => {
    vi.spyOn(api, "listDecks").mockResolvedValue({ decks: [], cards: [] });
    at("/deck");
    await screen.findByTestId("deck-index");
    expect(screen.queryByTestId("nav-deck")).toBeNull();
    expect(screen.getByTestId("nav-main").textContent).not.toMatch(/Epic deck|Epic Book/);
    expect(screen.getByTestId("deck-index-all").getAttribute("href")).toBe("/deck/all");
  });

  it("deckTabHref: the milestone's own spine opens its Deck tab, another epic its own, a codeless spine by file name", () => {
    expect(deckTabHref({ id: "root", code: "root", path: "docs/spines/root.md" }, "docs/spines/root.md")).toBe("?tab=deck");
    expect(deckTabHref({ id: "EPIC-947", code: "EPIC-947", path: "docs/spines/epic-947-x.md" }, "docs/spines/root.md")).toBe("?tab=deck&epic=EPIC-947");
    expect(deckTabHref({ id: "Odd", code: "odd", path: "docs/spines/odd-one.md" }, "docs/spines/root.md")).toBe("?tab=deck&epic=odd-one");
    // old /book links (a review card's goal link, round 2's) still lead to that epic's deck in the same repo
    expect(deckTarget("/deck/home_repo/root", "#EPIC-947")).toBe("/deck/home_repo/EPIC-947");
    expect(deckTarget("/deck/home_repo/root", "#epic:odd-one")).toBe("/deck/home_repo/odd-one");
    expect(deckTarget("/deck/home_repo/root", "#where")).toBe("/deck/home_repo/root?slide=where");
  });

  it("spineOf: a row belongs to the epic above it", () => {
    const t = treeOf("ms_1", "docs/spines/root.md");
    expect(spineOf(t.root, "r/e47/E947-S4")?.id).toBe("EPIC-947");
    expect(spineOf(t.root, "r/e47")?.id).toBe("EPIC-947");
    expect(spineOf(t.root, "r")?.id).toBe("root");
    expect(spineOf(t.root, "nope")).toBeUndefined();
  });

  // a goal opens like an objective; its deck is on the Context tab (Open its deck), shown inside the page.
  const openDeck = async () => {
    fireEvent.click(within(await screen.findByTestId("set-tabs")).getByRole("link", { name: "Context" }));
    fireEvent.click(await screen.findByTestId("goal-open-deck"));
  };
  it("round 3: the deck opens from the goal's Context tab, shown inside the page; no Epic deck button at the top", async () => {
    const m = await api.createMilestone({ title: "Team", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam" });
    vi.spyOn(api, "getTree").mockResolvedValue(treeOf(m.id, "docs/spines/root.md"));
    const deck = vi.spyOn(api, "getEpicDeck");
    at(`/milestones/${m.id}`);
    await screen.findByTestId("set-tabs");
    expect(screen.queryByTestId("epic-book-link")).toBeNull();
    await openDeck();
    await screen.findByText(/tab=deck/);
    // the deck sits inside the tab (no jump to /deck): the milestone's own deck, its slides, the last one Everything made
    const inTab = await screen.findByTestId("epic-deck");
    expect(inTab.getAttribute("data-embedded")).toBe("true");
    expect(screen.getByTestId("where").textContent).toMatch(new RegExp(`^/milestones/${m.id}\\?tab=deck`));
    expect(deck).toHaveBeenLastCalledWith("home_repo", "EPIC-900");
    expect(screen.getByTestId("deck-open-page").getAttribute("href")).toBe("/deck/home_repo/EPIC-900");
    fireEvent.click(screen.getByRole("button", { name: /Everything made for this/ }));
    expect((await screen.findByTestId("slide-title")).textContent).toBe("Everything made for this");
    expect(screen.getByTestId("where").textContent).toMatch(/slide=9/);
  });

  it("round 3: each epic row of the tree opens the Deck tab on that epic; a picked epic's Deck tab shows its deck", async () => {
    const m = await api.createMilestone({ title: "Team", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam" });
    vi.spyOn(api, "getTree").mockResolvedValue(treeOf(m.id, "docs/spines/root.md"));
    const deck = vi.spyOn(api, "getEpicDeck");
    at(`/milestones/${m.id}?tab=tree`);
    expect((await screen.findByTestId("tree-deck-EPIC-947")).getAttribute("href")).toBe(`/milestones/${m.id}?tab=deck&epic=EPIC-947`);
    expect(screen.getByTestId("tree-deck-Odd spine").getAttribute("href")).toBe(`/milestones/${m.id}?tab=deck&epic=odd-one`);
    expect(screen.getByTestId("tree-deck-root").getAttribute("href")).toBe(`/milestones/${m.id}?tab=deck`);
    expect(screen.queryByTestId("tree-deck-E947-S4")).toBeNull(); // rows are not epics
    fireEvent.click(screen.getByTestId("tree-deck-EPIC-947"));
    await screen.findByTestId("epic-deck");
    expect(deck).toHaveBeenLastCalledWith("home_repo", "EPIC-947");
    // back to the milestone's own deck, still inside the tab
    fireEvent.click(screen.getByTestId("deck-milestone-own"));
    await screen.findByText(new RegExp(`^/milestones/${m.id}\\?tab=deck$`));
    expect(deck).toHaveBeenLastCalledWith("home_repo", "EPIC-900");
    cleanup();
    // picking an epic in the Tree (a row would pick the epic above it, spineOf), then the Deck tab: that epic's deck
    at(`/milestones/${m.id}?tab=tree`);
    fireEvent.click(await screen.findByRole("button", { name: "EPIC-947" }));
    await screen.findByText(/node=r%2Fe47/);
    await openDeck();
    await screen.findByTestId("epic-deck");
    expect(deck).toHaveBeenLastCalledWith("home_repo", "EPIC-947");
  });

  it("another world's milestone and the social skin show no deck links", async () => {
    const m = await api.createMilestone({ title: "Team", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam" });
    vi.spyOn(api, "getTree").mockResolvedValue(treeOf(m.id, "docs/spines/root.md"));
    const get = api.getMilestone.bind(api);
    vi.spyOn(api, "getMilestone").mockImplementation(async (id) => ({ ...(await get(id)), world: "social" }));
    at(`/milestones/${m.id}?tab=tree`);
    await screen.findByRole("button", { name: "EPIC-947" });
    expect(screen.queryByTestId("tab-deck")).toBeNull();
    expect(screen.queryByTestId("tree-deck-EPIC-947")).toBeNull();
  });

  it("an epic's own page (no tabs) opens its milestone's Deck tab on it, and each epic below it on its own", async () => {
    const m = await api.createMilestone({ title: "Team", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam" });
    const t = treeOf(m.id, "docs/spines/root.md");
    const sub: NodeTree = { ...t, root: t.root, repo: "home_repo" };
    vi.spyOn(api, "getNodeTree").mockResolvedValue(sub);
    at(`/milestones/${m.id}/node/r`);
    expect((await screen.findByTestId("epic-deck-link")).getAttribute("href")).toBe(`/milestones/${m.id}?tab=deck`);
    expect(screen.getByTestId("tree-deck-EPIC-947").getAttribute("href")).toBe(`/milestones/${m.id}?tab=deck&epic=EPIC-947`);
    expect(screen.getByTestId("tree-deck-Odd spine").getAttribute("href")).toBe(`/milestones/${m.id}?tab=deck&epic=odd-one`);
  });

  it("a spine seen outside any milestone keeps its own deck page", async () => {
    const t = treeOf("ms_x", "docs/spines/root.md");
    vi.spyOn(api, "getSpineTree").mockResolvedValue({ ...t, repo: "home_repo" });
    at("/spines/home_repo/view?path=docs/spines/root.md");
    expect((await screen.findByTestId("epic-deck-link")).getAttribute("href")).toBe("/deck/home_repo/root");
    expect(screen.getByTestId("tree-deck-EPIC-947").getAttribute("href")).toBe("/deck/home_repo/EPIC-947");
  });
});
