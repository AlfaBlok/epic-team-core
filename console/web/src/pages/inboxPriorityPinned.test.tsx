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

  // (the owner 16 Nov 20:27Z: "I don't want to add more sections!!! It should just be at the top on blocked
  // waiting for me"): the question leads Blocked on you, never loose above every section, and Blocked opens by itself.
  // E948-S132: the pressing ask sits in Urgent, the one section above it (vn_a80780bd).
  it("leads Blocked on you, shown once and counted there; the pressing ask is in Urgent above it", async () => {
    inbox();
    const pinned = await screen.findByTestId("pinned-priority-ask");
    expect(pinned.getAttribute("data-priority")).toBe("team-browser");
    expect(pinned.textContent).toContain("Put Team browser first in your objectives?");
    const blocked = screen.getByTestId("waiting-on-you");
    expect(blocked.contains(pinned)).toBe(true);
    const urgent = await screen.findByTestId("inbox-urgent");
    await waitFor(() => expect(within(urgent).getByText("Which mail address do testers write to?")).toBeTruthy());
    expect(within(blocked).queryByText("Which mail address do testers write to?")).toBeNull();
    expect(before(urgent, blocked)).toBe(true);
    expect(within(blocked).getAllByText("Put Team browser first in your objectives?")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1"));
    // nothing loose between the sections: the question sits inside one
    expect(pinned.closest("[data-fold-section]")).toBe(blocked);
  });

  it("leads Blocked on you in the social skin's inbox too", async () => {
    inbox(SKINS.social);
    const pinned = await screen.findByTestId("pinned-priority-ask");
    expect(pinned.closest("[data-fold-section]")?.getAttribute("data-testid")).toBe("waiting-on-you");
  });
});

// E948-S155 (the owner, 20 Nov, on his personal reply cards: "top of inbox as priority"): an ask labelled urgent is pinned the same
// way, first of the pinned ones.
describe("an urgent ask leads his inbox", () => {
  const URGENT = sampleAsk({ id: "wj_urgent", code: "E900-A9", ask: "provide", question: "Which option do you send?", urgent: true } as Partial<WaitingItem>);
  it("is pinned while open and unsnoozed", () => {
    expect(isPinnedPriority(URGENT)).toBe(true);
    expect(isPinnedPriority({ ...URGENT, state: "answered" })).toBe(false);
    expect(isPinnedPriority({ ...URGENT, snoozedUntil: "2026-11-30" })).toBe(false);
  });
  // E948-S132 (vn_a80780bd): it sits first in Urgent, above the pressing ask; the priority question stays in Blocked on you.
  it("sits first in Urgent, above the pressing ask; the priority question leads Blocked on you", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([PRESSING, PRIORITY, URGENT]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending("wj_pressing"), pending("wj_prio"), pending("wj_urgent")]));
    inbox();
    const urgent = await screen.findByTestId("inbox-urgent");
    await waitFor(() => expect(within(urgent).getAllByTestId("urgent-ask")).toHaveLength(2));
    const [first, second] = within(urgent).getAllByTestId("urgent-ask");
    expect(first!.getAttribute("data-urgent")).toBe("label");
    expect(first!.textContent).toContain("Which option do you send?");
    expect(second!.textContent).toContain("Which mail address do testers write to?");
    const pinned = screen.getAllByTestId("pinned-priority-ask");
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.getAttribute("data-priority")).toBe("team-browser");
  });
});
