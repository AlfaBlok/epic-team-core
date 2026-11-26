// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch, type WaitingItem } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleAsk, sampleReview } from "@/components/cardInventory";
import { isUrgentReview } from "@/components/review";
import { cardHeading } from "@/lib/askLead";
import { forgetWorld } from "@/lib/useSocial";
import { resetSnoozes } from "@/lib/snooze";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";

/**
 * E948-S168 (the owner, 22 Nov 05:09Z, with a screenshot of the Adeje card: "If something is being marked urgent, why is it
 * not actually labeled urgent properly?"). The card read "Urgent." as its title, sat under Done, waiting for your review
 * and said "High priority". Now a card he called urgent goes in the Urgent section, says Urgent, and keeps its real title.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const base = sampleReview();
const ADEJE = sampleReview({
  id: "rv_adeje",
  ref: "E907-S3",
  title: "URGENT: where to stay in Adeje, Tenerife today",
  ownerPriority: { level: "high", ref: "E907-S3", why: "he flies today" },
  face: {
    ...base.face!,
    title: "Urgent. A map of where to stay in Adeje was made.",
    deadline: { at: "2026-11-22T00:00:00.000Z" },
    ready: { why: "urgent", whyText: "You marked it urgent", where: "The Adeje map", url: "http://example.com/adeje" },
  },
} as Partial<ReviewItem>);
const DONE = sampleReview({ id: "rv_done", ref: "E900-S4" });
// Urgent holds at most 5 cards or 15 percent of the inbox, so the inbox here is 23 cards
const FILLER = Array.from({ length: 20 }, (_, n) => sampleReview({ id: `rv_fill${n}`, ref: `E900-S${10 + n}` }));
const URGENT_ASK = sampleAsk({ id: "wj_urgent", code: "E900-A7", ask: "provide", question: "URGENT: Which day do you fly back?", urgent: true } as Partial<WaitingItem>);
const pending = (id: string): PendingItem => ({ id, kind: "ask", state: "open", milestoneId: "ms_sample", title: `row of ${id}` });
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-22T06:00:00Z" });
const serve = (asks: WaitingItem[], reviews: ReviewItem[]) => {
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue(asks);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch(asks.map((a) => pending(a.id))));
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : reviews)) as never);
};

beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
  resetSnoozes();
});

const inbox = (skin: keyof typeof SKINS) =>
  render(
    <SkinProvider skin={SKINS[skin]}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <ProjectProvider>
          <TeamPage only={skin === "social" ? "inbox" : undefined} />
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );

describe("a card he called urgent: in Urgent, labelled Urgent, its real title", () => {
  it("a leading Urgent label is never the heading", () => {
    expect(cardHeading({ title: "Urgent. A map of where to stay in Adeje was made." })).toBe("A map of where to stay in Adeje was made.");
    expect(cardHeading({ question: "URGENT: Which day do you fly back?" })).toBe("Which day do you fly back?");
    expect(cardHeading({ title: "**Urgent** - the hotel answered" })).toBe("The hotel answered");
    // the word inside a sentence stays
    expect(cardHeading({ title: "Urgently needed keys were found." })).toBe("Urgently needed keys were found.");
    expect(isUrgentReview(ADEJE)).toBe(true);
  });

  for (const skin of ["console", "social"] as const) {
    it(`${skin}: the Adeje card leads Urgent, says Urgent, never sits under Done`, async () => {
      serve([URGENT_ASK], [DONE, ADEJE, ...FILLER]);
      inbox(skin);
      const urgent = await screen.findByTestId("inbox-urgent");
      await waitFor(() => expect(within(urgent).getAllByTestId("review-feed-item").map((c) => c.getAttribute("data-inbox-card"))).toEqual(["review:rv_adeje"]));
      const card = within(urgent).getAllByTestId("review-feed-item")[0]!;
      expect(card.textContent).toContain("A map of where to stay in Adeje was made.");
      expect(card.textContent).not.toMatch(/Urgent\.\s*A map/);
      const tag = within(card).getByTestId("owner-priority");
      expect(tag.textContent).toBe("Urgent");
      expect(tag.hasAttribute("data-urgent")).toBe(true);
      // once only: not again under Done, waiting for your review
      expect(document.querySelectorAll('[data-inbox-card="review:rv_adeje"]')).toHaveLength(1);
      // the urgent ask is in Urgent too, its heading without the label
      await waitFor(() => expect(within(urgent).getAllByTestId("urgent-ask")).toHaveLength(1));
      const ask = within(urgent).getByTestId("urgent-ask");
      expect(ask.textContent).toContain("Which day do you fly back?");
      expect(within(ask).getByText("Urgent")).toBeTruthy();
    });
  }
});
