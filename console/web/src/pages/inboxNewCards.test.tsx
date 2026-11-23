// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleReview } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";
import { invalidate } from "@/lib/data";
import { resetNewCards } from "@/lib/inboxNew";
import { inboxExtras } from "@/lib/inboxOnly";

/**
 * The owner, vn_a63d5805: "when I close it, the page has moved under me because maybe new cards showed up"):
 * on his real Inbox, both skins, a card that arrives while he reads waits behind the quiet "N new" line; every card on
 * the page stays as it was until he taps it, and the line is the only thing added (it floats, out of the page's flow).
 */
let review = [sampleReview({ id: "rv_reading", ref: "E900-S4", title: "The card he is reading" })];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  resetNewCards();
  review = [sampleReview({ id: "rv_reading", ref: "E900-S4", title: "The card he is reading" })];
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state === "snoozed" ? [] : review.map((r) => ({ ...r })))) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
  resetNewCards();
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const inbox = (skin: keyof typeof SKINS) =>
  render(
    <SkinProvider skin={SKINS[skin]}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <ProjectProvider>
          <main>
            <TeamPage only={skin === "social" ? "inbox" : undefined} />
          </main>
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
/** the cards drawn in Done, waiting for your review, and its count */
const section = () => document.querySelector('[data-testid="waiting-for-review"]');
const cards = () => section()?.querySelectorAll("[data-card-shell]").length ?? 0;
const count = () => document.querySelector('[data-testid="waiting-for-review-count"]')?.textContent;
const drawn = async () => {
  await waitFor(() => expect(document.querySelector('[data-testid="inbox-stack"]')?.getAttribute("data-ready")).toBe("yes"), { timeout: 3000 });
  // he opens Done, waiting for your review and reads its card
  const toggle = await waitFor(() => document.querySelector<HTMLElement>('[data-testid="waiting-for-review-toggle"]') ?? Promise.reject(new Error("no review section")));
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  await waitFor(() => expect(cards()).toBe(1));
};

describe("new cards arriving never move the card he reads", () => {
  for (const skin of ["console", "social"] as const) {
    it(`${skin} skin: a card that arrives waits behind 'N new' until he taps it`, async () => {
      inbox(skin);
      await drawn();
      // half an answer typed on the card he reads
      const box = section()!.querySelector("textarea");
      if (box) fireEvent.change(box, { target: { value: "half an answer" } });
      const before = document.querySelector("main")!.innerHTML;

      review = [sampleReview({ id: "rv_arrived", ref: "E900-S7", title: "A card that just arrived" }), ...review];
      await act(async () => {
        invalidate("inbox", "background"); // a poll or a push
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(cards()).toBe(1);
      expect(count()).toBe("1");
      const line = document.querySelector('[data-testid="inbox-new-show"]');
      expect(line?.textContent).toBe("1 new");
      if (box) expect(box.value).toBe("half an answer");
      // nothing on the page changed but the floating line
      document.querySelector('[data-testid="inbox-new-line"]')!.remove();
      expect(document.querySelector("main")!.innerHTML).toBe(before);
      expect(inboxExtras(document.querySelector("main"), () => true)).toEqual([]);
    });

    it(`${skin} skin: his tap shows the new card`, async () => {
      inbox(skin);
      await drawn();
      review = [sampleReview({ id: "rv_arrived", ref: "E900-S7", title: "A card that just arrived" }), ...review];
      await act(async () => {
        invalidate("inbox", "background");
        await new Promise((r) => setTimeout(r, 20));
      });
      fireEvent.click(document.querySelector('[data-testid="inbox-new-show"]')!);
      await waitFor(() => expect(cards()).toBe(2));
      expect(count()).toBe("2");
      expect(document.querySelector('[data-testid="inbox-new-line"]')).toBeNull();
    });
  }
});
