// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleReview } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";

/**
 * The owner 2026-11-16 20:27Z: "I don't want to add more sections!!! It should just be at the top
 * on blocked waiting for me or top done waiting for your review - if we add another section, we can call urgent or
 * priority, but we can't have so many categories! Also, should be expandable, collapsing. Inbox should have single
 * pattern please - sections you can expand, all look the same".
 * Before (08:04Z "came in too subtly", vn_c95c40ad "how come that this is not the first thing on my inbox?") a ready
 * card had a section of its own, Ready for you, and a deadline card another, Has a deadline, neither folding.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const base = sampleReview().face!;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const DONE = sampleReview({ id: "rv_done", ref: "E900-S4" });
const DUE = () => sampleReview({ id: "rv_due", ref: "E900-S12", face: { ...base, title: "Your Airbnb reply was rewritten.", deadline: { at: at(18), why: 'Your words: "We have a 22-hour deadline."' } } } as Partial<ReviewItem>);
const READY = () =>
  sampleReview({
    id: "rv_ready",
    ref: "E907-S3",
    face: { ...base, title: "Your final reply was saved in your Gmail Drafts.", ready: { why: "asked", whyText: "You asked for it", where: "Gmail Drafts, to help@example.com", url: "https://mail.google.com/mail/u/0/#drafts" } },
  } as Partial<ReviewItem>);
const READY_DECISION = () =>
  sampleReview({ id: "rv_ready_dec", ref: "E907-S5", face: { ...base, title: "Send it?", decision: "Do we send it?", options: ["Yes: plan it", "No: park it"], ready: { why: "urgent", whyText: "You said it is urgent", where: "This card", url: "https://x.example/c" } } } as Partial<ReviewItem>);

beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
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
const sections = () => [...document.querySelectorAll("[data-fold-section]")].filter((s) => !s.parentElement?.closest("[data-fold-section]"));
const ids = (el: Element) => [...el.querySelectorAll("[data-testid=review-feed-item]")].map((c) => c.getAttribute("data-inbox-card"));

describe("one inbox pattern: what is ready leads its own section", () => {
  for (const skin of ["console", "social"] as const) {
    it(`${skin}: no Ready for you or Has a deadline section; ready, then deadline, lead Done, waiting for your review`, async () => {
      vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [DONE, DUE(), READY(), READY_DECISION()])) as never);
      inbox(skin);
      const review = await screen.findByTestId("waiting-for-review");
      // the section lands open while a ready card is in it (the Inbox otherwise lands folded)
      await waitFor(() => expect(ids(review)).toEqual(["review:rv_ready", "review:rv_due", "review:rv_done"]));
      expect(screen.queryByTestId("ready-first")).toBeNull();
      expect(screen.queryByTestId("deadline-first")).toBeNull();
      expect(sections().map((s) => s.getAttribute("data-testid"))).not.toContain("ready-first");
      const first = within(review).getAllByTestId("review-feed-item")[0];
      expect(first.getAttribute("data-lead")).toBe("yes");
      expect(within(first).getByTestId("ready-mark").textContent).toBe("Ready for you.");
      expect(within(first).getByTestId("ready-line").textContent).toContain("You asked for it.");
      expect(within(first).getByTestId("ready-where").textContent).toBe("Gmail Drafts, to help@example.com");
      expect(within(first).getByTestId("ready-open").getAttribute("href")).toBe("https://mail.google.com/mail/u/0/#drafts");
      expect(within(within(review).getAllByTestId("review-feed-item")[1]).getByTestId("deadline-line")).toBeTruthy();
      expect(within(review).getAllByTestId("review-feed-item")[2].getAttribute("data-lead")).toBeNull();
      // a ready decision leads Decisions, its own section, once
      const decisions = screen.getByTestId("inbox-decisions");
      await waitFor(() => expect(ids(decisions)).toEqual(["review:rv_ready_dec"]));
      for (const id of ["rv_ready", "rv_due", "rv_ready_dec"]) expect(document.querySelectorAll(`[data-inbox-card="review:${id}"]`)).toHaveLength(1);
    });

    it(`${skin}: every inbox section folds the same way: chevron button, title, count`, async () => {
      vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [DONE, READY()])) as never);
      inbox(skin);
      await screen.findByTestId("waiting-for-review");
      await waitFor(() => expect(sections().length).toBeGreaterThan(1));
      for (const s of sections()) {
        const id = s.getAttribute("data-testid");
        const toggle = s.querySelector(`[data-testid="${id}-toggle"]`);
        expect(toggle, `${id} folds`).toBeTruthy();
        expect(toggle!.querySelector("svg"), `${id} has its chevron`).toBeTruthy();
      }
      // a section holding a ready card still folds when he taps it
      const review = screen.getByTestId("waiting-for-review");
      await waitFor(() => expect(ids(review)).toContain("review:rv_ready"));
      fireEvent.click(within(review).getByTestId("waiting-for-review-toggle"));
      expect(ids(screen.getByTestId("waiting-for-review"))).toEqual([]);
    });
  }

  it("nothing ready: Done, waiting for your review lands folded on the Inbox", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [DONE])) as never);
    inbox("console");
    const review = await screen.findByTestId("waiting-for-review");
    await waitFor(() => expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1"));
    expect(ids(review)).toEqual([]);
  });
});
