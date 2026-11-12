// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type DeckLive } from "@/api";
import { AppRoutes } from "@/App";
import { SKINS, SkinProvider } from "@/lib/skin";
import { sampleDeck } from "@/lib/deck";

/** the memory service's Epic Book, its deck, links its testers page with the live counts. */

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const at = (path: string) =>
  render(
    <SkinProvider skin={SKINS.console}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );

const from = "Memo's public counts, active_testers, read hourly from cloud.memo.example.com/api/public/counts";
const live: DeckLive = {
  link: { label: "Memo testers and counts", url: "https://cloud.memo.example.com/admin/testers" },
  counts: [
    { label: "Active testers", source: "memory-counts#active_testers", value: 0, sourceText: from, note: "read 2026-11-11 03:05 UTC" },
    { label: "Tester applications", source: "memory-counts#applications", value: 1, sourceText: from },
    { label: "Paying customers", source: "memory-counts#paying_customers", value: null, sourceText: from },
  ],
};

describe("T80-S5 the testers page on Memo's deck", () => {
  it("shows one plain label opening the page, the numbers beside it and where they came from", async () => {
    vi.spyOn(api, "getEpicDeck").mockResolvedValue({ deck: sampleDeck("memo", "PLAN-0"), live, building: false });
    at("/deck/memo/PLAN-0");
    const a = (await screen.findByTestId("deck-live-link")) as HTMLAnchorElement;
    expect(a.textContent).toBe("Memo testers and counts");
    expect(a.getAttribute("href")).toBe("https://cloud.memo.example.com/admin/testers");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.className).toContain("min-h-11");
    expect(screen.getAllByTestId("deck-live-count").map((e) => e.textContent)).toEqual(["0 active testers", "1 tester applications", "– paying customers"]);
    expect(screen.getByTestId("deck-live-from").textContent).toBe("from Memo's public counts, read 03:05 UTC");
  });

  it("a deck without a live page shows no strip", async () => {
    vi.spyOn(api, "getEpicDeck").mockResolvedValue({ deck: sampleDeck("home_repo", "PLAN-40"), building: false });
    at("/deck/home_repo/PLAN-40");
    await screen.findByTestId("slide-title");
    expect(screen.queryByTestId("deck-live")).toBeNull();
  });
});
