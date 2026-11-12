// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { api, type DeckAbout, type RocksAbout } from "@/api";
import { AppRoutes } from "@/App";
import { SKINS, SkinProvider } from "@/lib/skin";
import { sampleDeck, sampleRocks } from "@/lib/deck";
import { deckTarget } from "@/pages/BookRedirect";

/**
 * and (each page says who keeps it, on which
 * milestone, how often, from which repo, and that his voice notes come from the memory service).
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

const at = (path: string) =>
  render(
    <SkinProvider skin={SKINS.console}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <Where />
      </MemoryRouter>
    </SkinProvider>,
  );

const rocksAbout: RocksAbout = {
  file: "docs/big-rocks.md",
  repo: "home_repo",
  keptBy: "Gap finder (EPIC-979)",
  keeper: { name: "Gap finder", personaId: "pe_gap", milestoneId: "ms_root", milestone: "home_repo · home_repo", cadence: "every day at 13:00 Madrid time", enabled: true },
  refresh: "The Gap finder reads the notes again once a week",
  sources: "Sam's voice notes come from Memory, his shared memory",
  lastRead: "2026-11-07",
};
const deckAbout: DeckAbout = {
  repo: "home_repo",
  spinePath: "docs/spines/epic-40-lanes-and-radar.md",
  milestone: { id: "ms_root", title: "home_repo · home_repo", own: false },
  workers: [
    { name: "Delivery manager", personaId: "pe_dm", milestoneId: "ms_root", milestone: "home_repo · home_repo", cadence: "every 2 hours", enabled: true },
    { name: "Gap finder", personaId: "pe_gap", milestoneId: "ms_root", milestone: "home_repo · home_repo", cadence: "every day at 13:00 Madrid time", enabled: true },
  ],
  refresh: { at: "06:00 Madrid time", lastOkAt: "2026-11-08T05:00:00.000Z" },
  rocks: rocksAbout,
};

describe("E975-S3 the epic deck replaces the Epic Book", () => {
  it("/book opens the decks (E947-S4 round 2: no sidebar entry, the deck sits on each milestone and epic)", async () => {
    vi.spyOn(api, "listDecks").mockResolvedValue({ decks: [], cards: [] });
    at("/book");
    await screen.findByTestId("deck-index");
    expect(screen.getByTestId("where").textContent).toBe("/deck");
    expect(screen.queryByTestId("nav-deck")).toBeNull();
    expect(screen.queryByText("Epic Book")).toBeNull();
    expect(screen.getByTestId("deck-index-all").getAttribute("href")).toBe("/deck/all");
  });

  it("an old /book link with a filter or #capabilities opens Every epic, kept whole at /deck/all", async () => {
    at("/book?show=stuck#capabilities");
    expect(await screen.findByText("Every epic")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/deck/all?show=stuck#capabilities");
  });

  it("/book/<milestone> opens the deck of its spine; #where opens that slide, #EPIC-n that epic's deck", async () => {
    vi.spyOn(api, "deckOf").mockResolvedValue({ href: "/deck/home_repo/EPIC-940", repo: "home_repo" });
    vi.spyOn(api, "getEpicDeck").mockResolvedValue({ deck: sampleDeck("home_repo", "EPIC-940"), building: false });
    at("/book/ms_1#where");
    await screen.findByTestId("epic-deck");
    expect(screen.getByTestId("where").textContent).toBe("/deck/home_repo/EPIC-940?slide=where");
    expect(screen.getByTestId("slide-title").textContent).toBe("Where we are");
    expect(api.deckOf).toHaveBeenCalledWith("ms_1");
    expect(deckTarget("/deck/home_repo/EPIC-940", "#EPIC-975")).toBe("/deck/home_repo/EPIC-975");
    expect(deckTarget("/deck/home_repo/EPIC-940", "")).toBe("/deck/home_repo/EPIC-940");
    expect(deckTarget("/deck/home_repo/EPIC-940", "#made")).toBe("/deck/home_repo/EPIC-940?slide=made");
  });

  it("keeps E947-S4's whole Everything made for this list on the deck, 8 shown then all", async () => {
    const d = sampleDeck("home_repo", "EPIC-940");
    const made = Array.from({ length: 11 }, (_, i) => ({ ...d.made[0], url: `https://x.test/${i}`, label: `Made ${i}` }));
    vi.spyOn(api, "getEpicDeck").mockResolvedValue({ deck: { ...d, made }, building: false });
    at("/deck/home_repo/EPIC-940?slide=made");
    await screen.findByTestId("deck-made");
    expect(screen.getAllByTestId("made-item")).toHaveLength(8);
    expect(screen.getByTestId("made-more").textContent).toBe("Show all 11");
  });
});

describe("E975-S2 round 2: each page says where it lives and who keeps it", () => {
  it("the deck: one line (repo, spine, who works it, the daily rebuild) and an About fold with settings links and Memory", async () => {
    vi.spyOn(api, "getEpicDeck").mockResolvedValue({ deck: sampleDeck("home_repo", "EPIC-940"), about: deckAbout, building: false });
    at("/deck/home_repo/EPIC-940");
    const line = await screen.findByTestId("deck-about-line");
    expect(line.textContent).toBe(
      "From the home_repo spine EPIC-940. Worked by Delivery manager and Gap finder on home_repo · home_repo. The console rebuilds it every day at 06:00 Madrid time.",
    );
    const links = within(line).getAllByTestId("about-persona").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/personas?edit=pe_dm", "/personas?edit=pe_gap"]);
    const fold = screen.getByTestId("deck-about");
    expect(fold.textContent).toContain("docs/spines/epic-40-lanes-and-radar.md");
    expect(fold.textContent).toContain("It is a console job, not a persona");
    expect(fold.textContent).toContain("Memory is only where Sam's voice notes are kept");
    expect(within(screen.getByTestId("about-rocks")).getByRole("link", { name: "home_repo · home_repo" }).getAttribute("href")).toBe("/milestones/ms_root?tab=personas");
  });

  it("the big rocks board: kept by the Gap finder from Sam's voice notes in Memory, lives in home_repo", async () => {
    vi.spyOn(api, "getBigRocks").mockResolvedValue({ rocks: sampleRocks(), file: "docs/big-rocks.md", about: rocksAbout });
    at("/rocks");
    const line = await screen.findByTestId("rocks-about-line");
    expect(line.textContent).toBe("Kept by the Gap finder on home_repo · home_repo, from Sam's voice notes in Memory. It lives in home_repo, docs/big-rocks.md.");
    expect(within(line).getByTestId("about-persona").getAttribute("href")).toBe("/personas?edit=pe_gap");
    expect(screen.getByTestId("about-keeper").textContent).toContain("every day at 13:00 Madrid time");
  });

  it("/personas?edit=<id> opens that persona's settings", async () => {
    vi.spyOn(api, "listPersonas").mockResolvedValue([
      { id: "pe_gap", name: "Gap finder", remit: "Finds gaps.", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host3", freshThreadEachWake: true, skipUnchanged: false, createdAt: "2026-11-08T00:00:00Z" } as never,
    ]);
    // the persona dialog measures itself (jsdom has no ResizeObserver)
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
    at("/personas?edit=pe_gap");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/personas");
  });
});
