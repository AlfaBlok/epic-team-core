// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleReview } from "@/components/cardInventory";
import { CARD_WORD, DECISIONS_SECTION, isDecisionCard, REVIEW_SECTION } from "@/components/review";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";

/**
 * E948-S103, the owner 2026-11-15 06:51Z (vn_a8293638): "we have done waiting for your review. These are things that are
 * completed, and I just need to mark them as completed. But then we also have, like, these decision things ... it needs
 * to be on a different bucket because it's different to just waiting for my review ... It is a higher level of priority
 * ... it's incredibly important that you are kind of consistent with the language that you use".
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
});

const base = sampleReview().face!;
const DECISION = sampleReview({
  id: "rv_decision",
  ref: "E900-S2",
  face: { ...base, title: "Every town was refiltered on your wind line.", decision: "Which cluster first? We recommend Tenerife.", options: ["Tenerife: plan the month there", "Salta: plan a deeper look", "Another: tell us which"] },
} as Partial<ReviewItem>);
const FEEDBACK_ONLY = sampleReview({
  id: "rv_review_with_options",
  ref: "E900-S3",
  face: { ...base, title: "A forecast was added to the scorecard.", decision: "Is this the forecast you wanted? We recommend yes.", options: ["Yes: keep it", "No: say what to change"] },
} as Partial<ReviewItem>);
const DONE = sampleReview({ id: "rv_done", ref: "E900-S4" });

beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [DECISION, FEEDBACK_ONLY, DONE])) as never);
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const inbox = () =>
  render(
    <SkinProvider skin={SKINS.console}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <ProjectProvider>
          <TeamPage />
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
const sections = () => [...document.querySelectorAll("[data-fold-section]")].filter((s) => !s.parentElement?.closest("[data-fold-section]")).map((s) => s.getAttribute("data-testid"));

describe("cards that need his decision have their own bucket, above Done waiting for your review", () => {
  it("a decision is a choice between next steps, not a yes beside a feedback answer", () => {
    expect(isDecisionCard(DECISION.face)).toBe(true);
    expect(isDecisionCard(FEEDBACK_ONLY.face)).toBe(false);
    expect(isDecisionCard(DONE.face)).toBe(false);
    expect(isDecisionCard({ ...base, decision: "Should we post twice a day? We recommend yes." })).toBe(true);
  });

  it("the Decisions bucket sits right under Blocked, before Goals to set and Done waiting for your review", async () => {
    inbox();
    await screen.findByTestId("inbox-decisions");
    await waitFor(() => {
      const s = sections();
      expect(s.indexOf("inbox-decisions")).toBeGreaterThan(s.indexOf("waiting-on-you"));
      expect(s.indexOf("inbox-decisions")).toBeLessThan(s.indexOf("waiting-for-review"));
    });
    expect(screen.getByTestId("inbox-decisions-toggle").textContent).toContain(DECISIONS_SECTION);
    expect(screen.getByTestId("waiting-for-review-toggle").textContent).toContain(REVIEW_SECTION);
  });

  it("holds only the decision cards, counted red, each card's word Decision; finished work stays in review with the word Review", async () => {
    inbox();
    const decisions = await screen.findByTestId("inbox-decisions");
    await waitFor(() => expect(screen.getByTestId("inbox-decisions-count").textContent).toBe("1"));
    expect(screen.getByTestId("inbox-decisions-count").getAttribute("data-tone")).toBe("needs-you");
    await waitFor(() => expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("2"));
    fireEvent.click(screen.getByTestId("inbox-decisions-toggle"));
    fireEvent.click(screen.getByTestId("waiting-for-review-toggle"));
    const decided = within(decisions).getAllByTestId("review-card");
    expect(decided.map((c) => c.getAttribute("data-review-id"))).toEqual(["rv_decision"]);
    expect(within(decided[0]).getByTestId("review-kind-word").textContent).toBe(CARD_WORD.decision);
    const review = screen.getByTestId("waiting-for-review");
    const done = within(review).getAllByTestId("review-card");
    expect(done.map((c) => c.getAttribute("data-review-id")).sort()).toEqual(["rv_done", "rv_review_with_options"]);
    for (const c of done) expect(within(c).getByTestId("review-kind-word").textContent).toBe(CARD_WORD.review);
  });

  it("one Snoozed reviews list, last below every section, holds a snoozed decision too", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) =>
      Promise.resolve(q?.state === "snoozed" ? [{ ...DECISION, id: "rv_snoozed_decision", snoozedUntil: "2026-12-01" }] : [DONE])) as never);
    inbox();
    await screen.findByTestId("inbox-decisions");
    await waitFor(() => expect(screen.getAllByTestId("review-snoozed")).toHaveLength(1));
    const s = sections();
    // vn_303babf4: it hung under Done for review and pushed Blocked on you down; now it is the inbox's last fold
    expect(s.indexOf("review-snoozed")).toBe(s.length - 1);
    expect(s.indexOf("review-snoozed")).toBeGreaterThan(s.indexOf("waiting-for-review"));
  });
});
