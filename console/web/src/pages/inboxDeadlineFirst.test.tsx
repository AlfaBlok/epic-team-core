// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleReview } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";

/**
 * The owner 2026-11-16 06:11Z (vn_c95c40ad): "I think I mentioned that there was something that was time
 * sensitive, you know, that had like a time element to it. So how come that this is not the first thing on my inbox?"
 * The Airbnb reply sat third under Done, waiting for your review. A card with a deadline leads the whole inbox.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  forgetOtherWorlds();
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const base = sampleReview().face!;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const AIRBNB = () => sampleReview({ id: "rv_airbnb", ref: "E900-S12", face: { ...base, title: "Your Airbnb reply was rewritten.", deadline: { at: at(18), why: 'Your words: "We have a 22-hour deadline."' } } } as Partial<ReviewItem>);
const LATE = () => sampleReview({ id: "rv_late", ref: "E900-S13", face: { ...base, title: "A late one.", deadline: { at: at(-3) } } } as Partial<ReviewItem>);
const DONE = sampleReview({ id: "rv_done", ref: "E900-S4" });

beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
});

const inbox = (skin: keyof typeof SKINS, entry: string) =>
  render(
    <SkinProvider skin={SKINS[skin]}>
      <MemoryRouter initialEntries={[entry]}>
        <ProjectProvider>
          <TeamPage only={skin === "social" ? "inbox" : undefined} />
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
const sections = () => [...document.querySelectorAll("[data-fold-section]")].filter((s) => !s.parentElement?.closest("[data-fold-section]")).map((s) => s.getAttribute("data-testid"));

describe("a card with a deadline leads the whole inbox", () => {
  for (const skin of ["console", "social"] as const) {
    it(`${skin}: first above every section, soonest first, overdue in red, and not again below`, async () => {
      vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [DONE, AIRBNB(), LATE()])) as never);
      inbox(skin, "/inbox");
      const lead = await screen.findByTestId("deadline-first");
      await waitFor(() => expect(sections()[0]).toBe("deadline-first"));
      const cards = within(lead).getAllByTestId("deadline-card");
      expect(cards.map((c) => c.getAttribute("data-inbox-card"))).toEqual(["review:rv_late", "review:rv_airbnb"]);
      const [late, airbnb] = cards.map((c) => within(c).getByTestId("deadline-line"));
      expect(late.getAttribute("data-overdue")).toBe("yes");
      expect(within(late).getByTestId("deadline-left").className).toContain("text-destructive");
      expect(within(late).getByTestId("deadline-left").textContent).toMatch(/^Overdue by 3 h/);
      expect(within(airbnb).getByTestId("deadline-left").textContent).toMatch(/^1[78] h( \d+ min)? left$/);
      expect(within(airbnb).getByTestId("deadline-why").textContent).toContain("22-hour deadline");
      // the cards are not listed again under Done, waiting for your review
      await waitFor(() => expect(document.querySelectorAll('[data-inbox-card="review:rv_airbnb"]')).toHaveLength(1));
      expect(document.querySelectorAll('[data-inbox-card="review:rv_done"]').length).toBeLessThanOrEqual(1);
    });
  }

  it("the time left counts down by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [sampleReview({ id: "rv_soon", face: { ...base, deadline: { at: at(0.5) } } } as Partial<ReviewItem>)])) as never);
    inbox("console", "/inbox");
    const left = await screen.findByTestId("deadline-left");
    expect(left.textContent).toMatch(/^(29|30) min left$/);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    await waitFor(() => expect(screen.getByTestId("deadline-left").textContent).toMatch(/^Overdue by/));
  });

  it("no deadline, no lead section", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [DONE])) as never);
    inbox("console", "/inbox");
    await screen.findByTestId("waiting-for-review");
    expect(screen.queryByTestId("deadline-first")).toBeNull();
  });
});
