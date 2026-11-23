// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch } from "@/api";
import { TeamPage } from "@/pages/Team";
import { TopBarPills } from "@/components/Layout";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleReview } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";
import { COUNTED_SECTIONS, inboxCountCheck } from "@/lib/countCheck";
import { splitDecisions } from "@/lib/cardKind";
import { resetSent } from "@/lib/sentRows";
import { resetReviewGone } from "@/lib/inbox";
import { resetSnoozes } from "@/lib/snooze";

/**
 * E948-S178, a regression of E948-S141 (the owner 22 Nov 20:57Z, vn_facd277a: "The inbox count is wrong again. It's
 * showing three, but there is only two waiting for review and one in Urgent. The one in Urgent is a red one ... it's being
 * counted as one of the green ones."). Urgent is a red section: every card in it counts red, once, never green.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const base = sampleReview().face!;
const done = (n: number) => sampleReview({ id: `rv_done_${n}`, ref: `E900-S${n}`, milestoneId: "ms_x", face: { ...base, title: `Finished work number ${n}.` } } as Partial<ReviewItem>);
// finished work he called urgent: not a decision, so before the fix it counted green while drawn in the red Urgent section
const urgentDone = sampleReview({
  id: "rv_urgent",
  ref: "E900-S7",
  milestoneId: "ms_x",
  ownerPriority: { level: "high", ref: "E900-S7", why: "he asked for it today" },
  face: { ...base, title: "The urgent thing was made.", ready: { why: "urgent", whyText: "You marked it urgent", where: "The page", url: "http://example.com/u" } },
} as Partial<ReviewItem>);
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: new Date().toISOString() });

beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [done(1), done(2), urgentDone])) as never);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch([]));
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
  vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({ worlds: [] });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
  resetSent();
  resetReviewGone();
  resetSnoozes();
});

const pill = (id: string) => document.querySelector(`[data-testid="${id}-count"]`)?.textContent;
const top = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "0";

describe("a card in Urgent counts red, never green", () => {
  it("splitDecisions puts an urgent card with the red ones", () => {
    const s = splitDecisions([done(1), done(2), urgentDone]);
    expect(s.review.map((c) => c.id)).toEqual(["rv_done_1", "rv_done_2"]);
    expect(s.decisions.map((c) => c.id)).toEqual(["rv_urgent"]);
  });

  it("his inbox of 22 Nov: two Done cards and one urgent card read green 2 and red 1, every pill equal to its cards", async () => {
    render(
      <SkinProvider skin={SKINS.console}>
        <MemoryRouter initialEntries={["/inbox"]}>
          <ProjectProvider>
            <TopBarPills counts={undefined} />
            <TeamPage />
          </ProjectProvider>
        </MemoryRouter>
      </SkinProvider>,
    );
    await waitFor(() => expect(pill("waiting-for-review")).toBe("2"));
    await waitFor(() => expect(pill("inbox-urgent")).toBe("1"));
    for (const id of COUNTED_SECTIONS) {
      const t = document.querySelector(`[data-testid="${id}-toggle"]`);
      if (t?.getAttribute("aria-expanded") === "false") fireEvent.click(t);
    }
    const card = await waitFor(() => {
      const c = document.querySelector('[data-testid="inbox-urgent"] [data-inbox-card="review:rv_urgent"]');
      expect(c).toBeTruthy();
      return c!;
    });
    expect(card.getAttribute("data-inbox-tone")).toBe("red");
    expect(top("topbar-review")).toBe("2");
    expect(top("topbar-needs-you")).toBe("1");
    expect(document.querySelectorAll('[data-inbox-card="review:rv_urgent"]')).toHaveLength(1);
    await waitFor(() => expect(inboxCountCheck().mismatches).toEqual([]));
  });

  it("the check fails a card in Urgent counted green, and top bar numbers that count it green", () => {
    document.body.innerHTML = `
      <a data-testid="topbar-team"><span data-testid="topbar-needs-you">0</span><span data-testid="topbar-review">3</span></a>
      <section data-fold-section data-testid="inbox-urgent"><button data-testid="inbox-urgent-toggle" aria-expanded="true"><span data-testid="inbox-urgent-count">1</span></button>
        <ul><li data-inbox-open="" data-inbox-tone="green"></li></ul></section>
      <section data-fold-section data-testid="waiting-for-review"><button data-testid="waiting-for-review-toggle" aria-expanded="true"><span data-testid="waiting-for-review-count">2</span></button>
        <ul><li data-inbox-open=""></li><li data-inbox-open=""></li></ul></section>`;
    expect(inboxCountCheck().mismatches).toEqual([
      "Urgent: 1 card counted green, Urgent counts red",
      "top bar red: 0, 1 open cards in Urgent, Blocked on you and Decisions",
      "top bar green: 3, 2 open cards in Done, waiting for your review",
    ]);
  });
});
