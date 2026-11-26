// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch, type WaitingItem } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleAsk, sampleReview } from "@/components/cardInventory";
import { isUrgentAsk } from "@/components/waiting";
import { isUrgentReview, urgentOrder } from "@/components/review";
import { inboxCountCheck } from "@/lib/countCheck";
import { forgetWorld } from "@/lib/useSocial";
import { resetSnoozes } from "@/lib/snooze";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";

/**
 * E948-S132 (the owner, vn_a80780bd 20 Nov 22:33Z: "we've been asking for like an urgent section in the inbox? You've been
 * telling me that you have dispatched this ... It's still not working ... it's still not there"; 16 Nov 20:27Z: "if we add
 * another section, we can call urgent or priority"): one section, Urgent, at the very top of his inbox, phone and laptop,
 * both skins. Every open card labelled urgent or pressing goes in it, the one he asked first (his dad card) leading;
 * each leaves the section it sat in; empty, the section is not drawn.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const DAD = sampleAsk({ id: "wj_dad", code: "E948-A24", ask: "provide", question: "Your reply to your dad, ready to send?", urgent: true, ownerPriority: { level: "high", ref: "E948-A24", why: "first", pressing: { kind: "first", why: "He asked for the dad cards first", order: 0 } } } as Partial<WaitingItem>);
const AGAIN = sampleAsk({ id: "wj_again", code: "E995-A9", ask: "provide", question: "Which mail do we log on with?", ownerPriority: { level: "high", ref: "E995-A9", why: "asked again", pressing: { kind: "repeated", why: "asked again", order: 3 } } } as Partial<WaitingItem>);
const PLAIN = sampleAsk({ id: "wj_plain", code: "E900-A1", ask: "provide", question: "Which colour for the logo?" } as Partial<WaitingItem>);
const PRESSED_REVIEW = sampleReview({ id: "rv_pressed", ref: "E948-S141", ownerPriority: { level: "high", ref: "E948-S141", why: "pills wrong again", pressing: { kind: "repeated", why: "pills wrong again", order: 2, said: new Date().toISOString() } } } as Partial<ReviewItem>);
const DONE = sampleReview({ id: "rv_done", ref: "E900-S4" });
// Urgent holds at most 5 cards or 15 percent of the inbox, so these tests give it an inbox of 23 or more
const FILLER = Array.from({ length: 20 }, (_, n) => sampleReview({ id: `rv_fill${n}`, ref: `E900-S${10 + n}` }));
const pending = (id: string): PendingItem => ({ id, kind: "ask", state: "open", milestoneId: "ms_sample", title: `row of ${id}` });
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-20T22:00:00Z" });

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

const inbox = (skin: keyof typeof SKINS = "console") =>
  render(
    <SkinProvider skin={SKINS[skin]}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <ProjectProvider>
          <TeamPage only={skin === "social" ? "inbox" : undefined} />
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
const topSections = () => [...document.querySelectorAll("main [data-fold-section], [data-fold-section]")].filter((s) => !s.parentElement?.closest("[data-fold-section]")).map((s) => s.getAttribute("data-testid"));
const drawn = async () => waitFor(() => expect(document.querySelector('[data-testid="inbox-stack"]')?.getAttribute("data-ready")).toBe("yes"));

describe("Urgent: one section at the very top of his inbox", () => {
  it("knows an urgent or pressing card", () => {
    expect(isUrgentAsk(DAD)).toBe(true);
    expect(isUrgentAsk(AGAIN)).toBe(true);
    expect(isUrgentAsk(PLAIN)).toBe(false);
    expect(isUrgentAsk({ ...DAD, state: "answered" })).toBe(false);
    expect(isUrgentAsk({ ...DAD, snoozedUntil: "2026-12-01" })).toBe(false);
    expect(isUrgentReview(PRESSED_REVIEW)).toBe(true);
    expect(isUrgentReview(DONE)).toBe(false);
    // the one he asked first leads, then pressing in the file's order
    expect(urgentOrder([AGAIN, DAD], (i) => !!i.urgent).map((i) => i.id)).toEqual(["wj_dad", "wj_again"]);
  });

  for (const skin of ["console", "social"] as const) {
    it(`${skin}: Urgent is first, his dad card leads it, and each urgent card shows once`, async () => {
      serve([PLAIN, AGAIN, DAD], [DONE, PRESSED_REVIEW, ...FILLER]);
      inbox(skin);
      const urgent = await screen.findByTestId("inbox-urgent");
      await drawn();
      expect(topSections().filter((s) => s !== "other-worlds")[0]).toBe("inbox-urgent");
      await waitFor(() => expect(within(urgent).getAllByTestId("urgent-ask")).toHaveLength(2));
      const asks = within(urgent).getAllByTestId("urgent-ask");
      expect(asks[0]!.textContent).toContain("Your reply to your dad, ready to send?");
      expect(asks[1]!.textContent).toContain("Which mail do we log on with?");
      await waitFor(() => expect(within(urgent).getAllByTestId("review-feed-item").map((c) => c.getAttribute("data-inbox-card"))).toEqual(["review:rv_pressed"]));
      // it opens by itself, its pill counts its three cards
      expect(within(urgent).getByTestId("inbox-urgent-toggle").getAttribute("aria-expanded")).toBe("true");
      expect(within(urgent).getByTestId("inbox-urgent-count").textContent).toBe("3");
      // its order is his (the one he asked first leads): no sort menu on it
      expect(within(urgent).queryByTestId("inbox-urgent-sort")).toBeNull();
      // nothing twice: out of Blocked on you and out of Done, waiting for your review
      expect(screen.getAllByText("Your reply to your dad, ready to send?")).toHaveLength(1);
      expect(document.querySelectorAll('[data-inbox-card="review:rv_pressed"]')).toHaveLength(1);
      expect(within(screen.getByTestId("waiting-on-you")).queryByText("Which mail do we log on with?")).toBeNull();
      await waitFor(() => expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1"));
    });
  }

  // round 2 (his chat 26 Nov: "we cant have 80pct of inbox be urgent"): in a small inbox urgent asks fill the
  // handful, and a pressed review card stays in its own section
  it("caps Urgent: in an inbox of 4 the urgent ask takes the one place", async () => {
    serve([PLAIN, DAD], [DONE, PRESSED_REVIEW]);
    inbox();
    const urgent = await screen.findByTestId("inbox-urgent");
    await waitFor(() => expect(within(urgent).getAllByTestId("urgent-ask")).toHaveLength(1));
    expect(within(urgent).queryAllByTestId("review-feed-item")).toHaveLength(0);
  });

  it("is not drawn when nothing is urgent or pressing", async () => {
    serve([PLAIN], [DONE]);
    inbox();
    await drawn();
    await screen.findByTestId("waiting-on-you");
    expect(screen.queryByTestId("inbox-urgent")).toBeNull();
  });

  // E948-S178 (vn_facd277a, 22 Nov 20:57Z: "The one in Urgent is a red one ... it's being counted as one of the green ones"):
  // every card in Urgent counts red, its finished work too
  it("the count check reads Urgent: every card in it counts red, never green", async () => {
    serve([PLAIN, DAD], [DONE, PRESSED_REVIEW, ...FILLER]);
    inbox();
    const urgent = await screen.findByTestId("inbox-urgent");
    await waitFor(() => expect(within(urgent).getAllByTestId("urgent-ask")).toHaveLength(1));
    await waitFor(() => expect(within(urgent).getAllByTestId("review-feed-item")).toHaveLength(1));
    const r = inboxCountCheck();
    expect(r.sections.find((s) => s.section === "inbox-urgent")).toMatchObject({ pill: 2, cards: 2, folded: false });
    expect(r.mismatches).toEqual([]);
    expect(urgent.querySelectorAll('[data-inbox-tone="red"]')).toHaveLength(2);
    expect(urgent.querySelectorAll('[data-inbox-tone="green"]')).toHaveLength(0);
  });
});
