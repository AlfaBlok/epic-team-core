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
 * (the owner, Team desk 2026-11-16 08:04Z): "problem is email showed in the drafts but i was hping for an email
 * or somethingi nmy epicteam inbox notifying - came in too subtly". What he waits on, once ready, leads the inbox above
 * the deadline cards, set apart, with why, where it is and Open it. Built on the deadline test (below its words):
 *
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

const READY = () =>
  sampleReview({
    id: "rv_ready",
    ref: "E907-S3",
    face: { ...base, title: "Your final reply was saved in your Gmail Drafts.", ready: { why: "asked", whyText: "You asked for it", where: "Gmail Drafts, to help@example.com", url: "https://mail.google.com/mail/u/0/#drafts" } },
  } as Partial<ReviewItem>);
const READY_DUE = () =>
  sampleReview({ id: "rv_ready_due", ref: "E907-S4", face: { ...base, title: "Due one.", deadline: { at: at(5) }, ready: { why: "deadline", whyText: "It has a deadline", where: "Open the reply", url: "https://x.example/r" } } } as Partial<ReviewItem>);

describe("what he waits on, once ready, leads the whole inbox", () => {
  for (const skin of ["console", "social"] as const) {
    it(`${skin}: Ready for you is first, above the deadline cards, with why, where and Open it, and not again below`, async () => {
      vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [DONE, AIRBNB(), READY(), READY_DUE()])) as never);
      inbox(skin, "/inbox");
      const lead = await screen.findByTestId("ready-first");
      await waitFor(() => expect(sections().slice(0, 2)).toEqual(["ready-first", "deadline-first"]));
      const cards = within(lead).getAllByTestId("ready-card");
      // the one with a deadline first, then the rest
      expect(cards.map((c) => c.getAttribute("data-inbox-card"))).toEqual(["review:rv_ready_due", "review:rv_ready"]);
      const line = within(cards[1]).getByTestId("ready-line");
      expect(line.textContent).toContain("You asked for it.");
      expect(within(line).getByTestId("ready-where").textContent).toBe("Gmail Drafts, to help@example.com");
      expect(within(line).getByTestId("ready-open").getAttribute("href")).toBe("https://mail.google.com/mail/u/0/#drafts");
      expect(within(line).getByTestId("ready-copy").textContent).toBe("Copy link");
      expect(within(cards[0]).getByTestId("deadline-line")).toBeTruthy();
      // the deadline section keeps only the card that is not ready, and no ready card shows twice
      const due = screen.getByTestId("deadline-first");
      expect(within(due).getAllByTestId("deadline-card").map((c) => c.getAttribute("data-inbox-card"))).toEqual(["review:rv_airbnb"]);
      for (const id of ["rv_ready", "rv_ready_due"]) await waitFor(() => expect(document.querySelectorAll(`[data-inbox-card="review:${id}"]`)).toHaveLength(1));
    });
  }

  it("nothing ready, no Ready for you", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [DONE, AIRBNB()])) as never);
    inbox("console", "/inbox");
    await screen.findByTestId("deadline-first");
    expect(screen.queryByTestId("ready-first")).toBeNull();
  });
});
