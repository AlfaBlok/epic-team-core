// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { AppRoutes } from "@/App";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { deckCodeOf, sampleDeck, sampleDeckCards, sampleDeckList, sampleRocks } from "@/lib/deck";
import { DeckCards } from "@/components/deckCards";

/** the epic deck, its index, the big rocks board and the Team home's deck cards. */

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const at = (path: string, skin: Skin = SKINS.console) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );

describe("the epic deck", () => {
  it("opens on slide 1, the big rocks it serves, numbered n / N; Next walks the nine slides", async () => {
    const spy = vi.spyOn(api, "getEpicDeck").mockResolvedValue({ deck: sampleDeck("home_repo", "EPIC-940"), building: false });
    at("/deck/home_repo/EPIC-940");
    expect(await screen.findByText("Lanes and radar: epic deck")).toBeTruthy();
    expect(spy).toHaveBeenCalledWith("home_repo", "EPIC-940");
    expect(screen.getByTestId("slide-title").textContent).toBe("The big rocks it serves");
    expect(screen.getByTestId("slide-count").textContent).toBe("1 / 9");
    expect(screen.getAllByTestId("deck-rock").map((r) => r.textContent)).toEqual([expect.stringContaining("Get real users now"), expect.stringContaining("A goal tree he trusts")]);
    const titles: string[] = [];
    for (let k = 0; k < 9; k++) {
      titles.push(screen.getByTestId("slide-title").textContent!);
      if (k < 8) fireEvent.click(screen.getByTestId("deck-next"));
    }
    expect(titles).toEqual([
      "The big rocks it serves",
      "What we are doing, and why",
      "Where we are",
      "What we just did",
      "How we measure it",
      "The plan",
      "Decisions landed",
      "What waits on you",
      "Everything made for this",
    ]);
    expect((screen.getByTestId("deck-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("draws its diagrams from the data: the goal track, the weekly bars, the plan by state", async () => {
    vi.spyOn(api, "getEpicDeck").mockResolvedValue({ deck: sampleDeck(), building: false });
    at("/deck/home_repo/EPIC-940?slide=3");
    await screen.findByTestId("deck-track");
    expect(screen.getByTestId("deck-track").querySelectorAll("li[data-done]")).toHaveLength(1);
    expect(screen.getByTestId("deck-track").textContent).toContain("· we are here");
    fireEvent.click(screen.getByTestId("deck-next"));
    fireEvent.click(screen.getByTestId("deck-next"));
    expect(screen.getByTestId("deck-weekly").querySelectorAll("rect")).toHaveLength(8);
    expect(screen.getAllByTestId("deck-kpi")[0].textContent).toContain("1 of 3");
    expect(screen.getByTestId("deck-trend").textContent).toContain("grows by one point");
    fireEvent.click(screen.getByTestId("deck-next"));
    expect(Array.from(screen.getByTestId("deck-plan").querySelectorAll("li")).map((l) => l.getAttribute("data-state"))).toEqual(["moving", "moving", "done"]);
  });

  it("the index lists the focus milestones, then the lanes; the deck code follows the server's rule", async () => {
    vi.spyOn(api, "listDecks").mockResolvedValue({ decks: sampleDeckList(), cards: [] });
    at("/deck");
    await screen.findByTestId("deck-index");
    expect(within(screen.getByTestId("deck-index-big")).getByText("Epic Social launch").closest("a")!.getAttribute("href")).toBe("/deck/home_repo/EPIC-946");
    expect(within(screen.getByTestId("deck-index-lane")).getByText("Lanes and radar")).toBeTruthy();
    expect(deckCodeOf("root", "docs/spines/root.md")).toBe("root");
    expect(deckCodeOf("epic-940", "docs/spines/epic-940-x.md")).toBe("EPIC-940");
  });
});

describe("the big rocks board", () => {
  it("leads with how often each rock comes back, then one card per rock with its decks and quoted notes", async () => {
    vi.spyOn(api, "getBigRocks").mockResolvedValue({ rocks: sampleRocks(), file: "docs/big-rocks.md" });
    at("/rocks");
    await screen.findByTestId("big-rocks");
    expect(screen.getByTestId("rocks-bars").querySelectorAll("li")).toHaveLength(2);
    const cards = screen.getAllByTestId("rock");
    expect(cards.map((c) => c.id)).toEqual(["R1", "R2"]);
    expect(within(cards[0]).getByTestId("rock-frequency").textContent).toContain("6 notes on 5 days");
    expect(within(cards[0]).getByText("Get real users now", { selector: "a" }).getAttribute("href")).toBe("/deck/home_repo/EPIC-936");
    expect(within(cards[0]).getByTestId("rock-evidence").textContent).toContain("It's time to get testers.");
  });
});

describe("deck cards on the Team home", () => {
  it("one card per changed deck: Open deck, and Seen spins then calls the server", async () => {
    vi.spyOn(api, "listDeckCards").mockResolvedValue({ cards: sampleDeckCards() });
    let done!: (v: { ok: boolean }) => void;
    const seen = vi.spyOn(api, "deckCardSeen").mockReturnValue(new Promise((r) => (done = r)));
    render(
      <MemoryRouter>
        <DeckCards />
      </MemoryRouter>,
    );
    const card = await screen.findByTestId("deck-card");
    expect(card.textContent).toContain("A goal is met: E46-3.");
    expect(within(card).getByTestId("deck-card-open").getAttribute("href")).toBe("/deck/home_repo/EPIC-946");
    fireEvent.click(within(card).getByTestId("deck-card-seen"));
    expect(seen).toHaveBeenCalledWith({ repo: "home_repo", code: "EPIC-946", date: "2026-11-07" });
    expect(await within(card).findByText("Marking…")).toBeTruthy();
    done({ ok: true });
  });
});
