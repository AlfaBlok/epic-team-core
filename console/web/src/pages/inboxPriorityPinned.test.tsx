// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type StatusBatch, type WaitingItem } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleAsk, sampleReview } from "@/components/cardInventory";
import { isPinnedPriority } from "@/components/waiting";
import { forgetWorld } from "@/lib/useSocial";
import { resetSnoozes } from "@/lib/snooze";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";

/**
 * the owner (vn_cdcf1208): when a note names a new first thing the team asks him one line, "Put X
 * first in your objectives?", and "you can make that question also very high up ... because otherwise, if the question
 * reaches me 10 notifications deep, then already we've defeated the purpose". The question sits first in his Inbox,
 * above every section and every pressing item.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const PRIORITY = sampleAsk({ id: "wj_prio", code: "E900-A7", ask: "approve", decidable: true, question: "Put Team browser first in your objectives?", putFirst: { objective: "team-browser" } } as Partial<WaitingItem>);
// a pressing ask (he asked again): before it led his inbox
const PRESSING = sampleAsk({ id: "wj_pressing", code: "E900-A8", question: "Which mail address do testers write to?", ownerPriority: { pressing: true } } as unknown as Partial<WaitingItem>);
const pending = (id: string, extra: Partial<PendingItem> = {}): PendingItem => ({ id, kind: "ask", state: "open", milestoneId: "ms_sample", title: `row of ${id}`, ...extra });
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-15T08:00:00Z" });

beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([PRESSING, PRIORITY]);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending("wj_pressing", { ownerPriority: { pressing: true } } as unknown as Partial<PendingItem>), pending("wj_prio")]));
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : [sampleReview({ id: "rv_pressing", ownerPriority: { pressing: true } } as never)])) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
  resetSnoozes();
});

const inbox = (skin = SKINS.console) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <ProjectProvider>
          <TeamPage />
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("a question on what comes first sits first in his inbox", () => {
  it("only an open, unsnoozed priority ask is pinned", () => {
    expect(isPinnedPriority(PRIORITY)).toBe(true);
    expect(isPinnedPriority(PRESSING)).toBe(false);
    expect(isPinnedPriority({ ...PRIORITY, state: "answered" })).toBe(false);
    expect(isPinnedPriority({ ...PRIORITY, snoozedUntil: "2026-11-16" })).toBe(false);
  });

  it("is the first thing on the Inbox, above the search, every section and the pressing items, and shown once", async () => {
    inbox();
    const pinned = await screen.findByTestId("pinned-priority-ask");
    expect(pinned.getAttribute("data-priority")).toBe("team-browser");
    expect(pinned.textContent).toContain("Put Team browser first in your objectives?");
    const sections = [...document.querySelectorAll("[data-fold-section]")];
    await waitFor(() => expect(sections.length + document.querySelectorAll("[data-fold-section]").length).toBeGreaterThan(0));
    for (const s of document.querySelectorAll("[data-fold-section]")) expect(before(pinned, s)).toBe(true);
    const search = screen.queryByTestId("inbox-search");
    if (search) expect(before(pinned, search)).toBe(true);
    // not a second time in Blocked, whose count leaves it out (the pressing ask stays there)
    const blocked = await screen.findByTestId("waiting-on-you");
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1"));
    expect(within(blocked).queryByText("Put Team browser first in your objectives?")).toBeNull();
  });

  it("leads the social skin's inbox too", async () => {
    inbox(SKINS.social);
    const pinned = await screen.findByTestId("pinned-priority-ask");
    for (const s of document.querySelectorAll("[data-fold-section]")) expect(before(pinned, s)).toBe(true);
  });
});
