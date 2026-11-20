// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleReview } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";
import { INBOX_ORDER, inboxExtras, inboxOrder } from "@/lib/inboxOnly";

/**
 * Root L-87, the owner 18 Nov (vn_5025a4c5): "I want to have a clear rule that you never add anything to the inbox unless I
 * explicitly ask you for it ... The inbox only have sections and cards. Nothing else ... Don't add anything ever else
 * again". The Inbox page holds its title, the filters on top and the sections with their cards; this fails the moment
 * anything else (a counter box, a line of text, a footer, a band) is drawn on it, in either skin. The same rule runs on
 * his live inbox after every release (hosted/console/scripts/inbox-load-check.mjs).
 *
 * The sections keep one order whatever is pressing (the owner 18 Nov: "why did blocked on me in the sections in the inbox
 * go down? Whose decision was it to make the blocked on you section in the middle"): a pressing card leads inside its own
 * section, Blocked on you stays first, Snoozed reviews stays last. Both shipped once because no test said what the
 * inbox holds; this is that test.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
});
beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) =>
    Promise.resolve(q?.state === "snoozed" ? [sampleReview({ id: "rv_snoozed", ref: "E900-S9", snoozedUntil: "2026-12-01" } as never)] : [sampleReview({ id: "rv_done", ref: "E900-S4" })])) as never);
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const inbox = (skin: keyof typeof SKINS, extra?: React.ReactNode) =>
  render(
    <SkinProvider skin={SKINS[skin]}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <ProjectProvider>
          <main>
            <TeamPage only={skin === "social" ? "inbox" : undefined} />
            {extra}
          </main>
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
// every section says it is in (a section that never does holds the whole inbox), then the stack draws them all at once
const drawn = async () => {
  await waitFor(() => expect([...document.querySelectorAll("[data-slot]")].filter((x) => x.getAttribute("data-in") !== "yes").map((x) => x.getAttribute("data-slot"))).toEqual([]), { timeout: 3000 });
  await waitFor(() => expect(document.querySelector('[data-testid="inbox-stack"]')?.getAttribute("data-ready")).toBe("yes"));
};
const extras = () => inboxExtras(document.querySelector("main"), () => true);

describe("root L-87: the Inbox holds only the filters on top and the sections with their cards", () => {
  for (const skin of ["console", "social"] as const) {
    it(`${skin} skin: nothing else on the page, loading or loaded`, async () => {
      inbox(skin);
      expect(extras()).toEqual([]);
      await drawn();
      expect(document.querySelectorAll("main [data-fold-section]").length).toBeGreaterThan(0);
      expect(extras()).toEqual([]);
    });
  }

  it("anything else drawn on the Inbox fails it (the 33 asks box, a footer line)", async () => {
    inbox(
      "console",
      <>
        <a href="/asks" data-testid="asks-this-week">
          33 asks to you this week
        </a>
        <p data-testid="sync-footer">Oldest sync from GitHub: 14 min ago</p>
      </>,
    );
    await drawn();
    expect(extras()).toEqual(["a[asks-this-week]: 33 asks to you this week", "p[sync-footer]: Oldest sync from GitHub: 14 min ago"]);
  });

  // E948-S132 (the owner, vn_a80780bd: "we've been asking for like an urgent section in the inbox"): a pressing card sits in
  // Urgent, the one section above Blocked on you; the rest keep their order.
  it("the sections keep one order, Urgent then Blocked on you first, when a pressing card waits for review", async () => {
    const pressing = sampleReview({ id: "rv_pressing", ref: "E900-S5", ownerPriority: { pressing: { why: "said again" } } } as never);
    vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) =>
      Promise.resolve(q?.state === "snoozed" ? [sampleReview({ id: "rv_snoozed", ref: "E900-S9", snoozedUntil: "2026-12-01" } as never)] : [pressing, sampleReview({ id: "rv_done", ref: "E900-S4" })])) as never);
    inbox("console");
    await drawn();
    const { sections, ok } = inboxOrder(document.querySelector("main"));
    expect(sections[0]).toBe("inbox-urgent");
    expect(sections[1]).toBe("waiting-on-you");
    expect(sections.indexOf("inbox-decisions")).toBeLessThan(sections.indexOf("waiting-for-review"));
    expect(sections.filter((x) => (INBOX_ORDER as readonly string[]).includes(x))).toEqual(sections);
    expect(ok).toBe(true);
    expect(sections.at(-1)).toBe("review-snoozed");
    expect(extras()).toEqual([]);
  });

  it("the order check fails a flipped inbox", () => {
    document.body.innerHTML = '<main><section data-fold-section data-testid="waiting-for-review"></section><section data-fold-section data-testid="waiting-on-you"></section></main>';
    expect(inboxOrder(document.querySelector("main")).ok).toBe(false);
  });
});
