// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invalidate } from "@/lib/data";
import { MemoryRouter } from "react-router-dom";
import { api, type Milestone, type PendingItem, type ReviewItem, type StatusBatch, type WaitingItem } from "@/api";
import { SidebarNav } from "@/components/Layout";
import { WaitingOnYou } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
import { resetSnoozes } from "@/lib/snooze";
import { blockedItems, resetReviewGone } from "@/lib/inbox";

/**
 * every count of what waits on the owner is the length of the
 * list it stands for. One function returns the items (lib/inbox blockedItems / reviewCards), every pill and section
 * header counts its result, and one shared fetch feeds them all.
 */

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSnoozes();
  resetReviewGone();
});
beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

const ask = (id: string, code: string, extra: Partial<WaitingItem> = {}): WaitingItem =>
  ({
    id,
    source: "ask",
    state: "open",
    repo: "home_repo",
    code,
    milestoneId: "ms_x",
    milestoneTitle: "home_repo",
    path: "docs/spines/epic-9.md",
    line: 12,
    title: `row of ${code}`,
    ask: "decide",
    question: `Question ${code}?`,
    contextLinks: [],
    owner: { label: "Delivery Manager" },
    decidable: false,
    ...extra,
  }) as WaitingItem;
const pending = (id: string, extra: Partial<PendingItem> = {}): PendingItem => ({ id, kind: "ask", state: "open", milestoneId: "ms_x", title: `row of ${id}`, ...extra });
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.filter((i) => i.state === "open").length, at: "2026-11-08T16:00:00Z" });
const blocked = () =>
  render(
    <MemoryRouter>
      <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
    </MemoryRouter>,
  );
/** Cards and status rows in the Blocked body: what the owner sees when he expands it. */
const rows = () => screen.queryAllByTestId("waiting-card").length + screen.queryAllByTestId("status-item").length;

describe("T72-S6 Blocked: the header count is the number of rows inside", () => {
  it("an open item whose list entry is a guessed line (no card) still shows as a row, so 1 is never an empty box", async () => {
    // The old code counted it (status says open) but drew nothing: the list had an entry for it, so no status row, and
    // the entry was a guessed (heuristic) line, so no card either.
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([ask("wj_h", "", { source: "heuristic", code: undefined, title: "Sam decides the venue" })]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending("wj_h", { kind: "free_text_ask", title: "Sam decides the venue" })]));
    blocked();
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1"));
    await waitFor(() => expect(rows()).toBe(1));
    expect(screen.getByTestId("status-item").textContent).toContain("Sam decides the venue");
    expect(screen.queryByTestId("nothing-waiting")).toBeNull();
  });

  it("a status row names its milestone (\"Review and mark the outcome\" alone did not read as an item)", async () => {
    const m = await api.createMilestone({ title: "Market entry signals", repo: "Acme/market-entry-signals", path: "docs/spines/market-entry-signals.md", owner: "Sam" });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending(`ready_to_mark:${m.id}`, { kind: "ready_to_mark", milestoneId: m.id, title: "Review and mark the outcome: every Done means is ticked and the evidence table is written" })]));
    blocked();
    const row = await screen.findByTestId("status-item");
    await waitFor(() => expect(within(row).getByTestId("status-item-milestone").textContent).toBe("Market entry signals"));
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1");
  });

  it("the rows are exactly blockedItems: open items once each, minus snoozes picked here", () => {
    const st = batch([pending("a"), pending("a"), pending("b", { state: "answered" }), pending("c"), pending("d", { kind: "stalled", state: "alarm" })]);
    expect(blockedItems(st).map((i) => i.id)).toEqual(["a", "c"]);
    expect(blockedItems(st, { snoozing: new Set(["c"]) }).map((i) => i.id)).toEqual(["a"]);
    expect(blockedItems(st, { keep: (id) => id !== "ms_x" })).toEqual([]);
  });
});

describe("T72-S6 the sidebar's Team pill and the Blocked header never disagree", () => {
  const sidebarAndBlocked = () =>
    render(
      <MemoryRouter>
        <SidebarNav />
        <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
      </MemoryRouter>,
    );
  const teamRed = () => document.querySelector('[data-testid="nav-main"] [data-testid="waiting-count"]')?.textContent ?? "0";

  it("one status fetch feeds both: a refresh moves the pill and the header together (they used to poll on their own clocks)", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([ask("wj_a", "T9-A1")]);
    const status = vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending("wj_a")]));
    vi.spyOn(api, "getCounts").mockResolvedValue({ needsYou: 0, review: 0, chat: 0, milestones: {} }); // the mock /counts reads status too
    sidebarAndBlocked();
    await waitFor(() => expect(teamRed()).toBe("1"));
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1");
    const calls = status.mock.calls.length;
    status.mockResolvedValue(batch([]));
    await act(async () => invalidate("inbox"));
    await waitFor(() => expect(teamRed()).toBe("0"));
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("0");
    expect(status.mock.calls.length - calls).toBe(1); // one read for both
  });

  it("a snooze takes the ask out of the pill and the list at the same moment", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([ask("wj_a", "T9-A1")]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending("wj_a")]));
    vi.spyOn(api, "snoozeWaiting").mockReturnValue(new Promise(() => undefined)); // still landing
    sidebarAndBlocked();
    const card = await screen.findByTestId("waiting-card");
    await waitFor(() => expect(teamRed()).toBe("1"));
    fireEvent.click(within(card).getByRole("button", { name: /Snooze/ }));
    fireEvent.click(within(card).getByText("3 days"));
    // Before: the list was empty and its header 0 while the sidebar still said 1 until the write landed and it refetched.
    expect(screen.queryAllByTestId("waiting-card")).toHaveLength(0);
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("0");
    expect(teamRed()).toBe("0");
  });
});

describe("T72-S6 Done, waiting for your review: the green pill is the list's length", () => {
  const FACE = {
    project: { name: "Memo, the memory app", url: "https://memo.example.com/" },
    goal: { text: "Get Memo into every AI tool directory", code: "PLAN-10" },
    tasks: { done: 1, total: 9 },
    title: "The Memo logo was made for directory listings.",
    taskGoal: "Every directory gets a logo to point at.",
    delivered: [{ ok: true, text: "The logo exists." }],
    evidence: { url: "https://memo.example.com/connect", label: "Open memo.example.com/connect" },
    screenshot: "docs/status/e10-r2/connect.jpg",
    tree: [],
    after: "Next the team lists Memo.",
    next: [],
    closesGoal: false,
    openInGoal: [],
  };
  const card = (id: string, milestoneId = "ms_1"): ReviewItem =>
    ({ id, title: `Task ${id}`, liveUrl: "https://memo.example.com/connect", ref: id, repo: "memo", path: "docs/PLAN-10.md", github: "acme-ai/memo", cardPath: `docs/cards/${id}.md`, milestoneId, state: "review", status: "review", liveStatus: 200, checkedAt: "2026-11-08T01:00:00Z", createdAt: "2026-11-08", verdict: { kind: "card" }, face: FACE }) as unknown as ReviewItem;

  it("a pressed card leaves the list, its header and the sidebar pill together", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([]));
    // /counts would still say 2 while the press lands: the pill no longer reads it
    vi.spyOn(api, "getCounts").mockResolvedValue({ needsYou: 0, review: 2, chat: 0, milestones: {} });
    const list = vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [card("rv_1"), card("rv_2")]));
    vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...card("rv_1"), state: "approved" } as ReviewItem);
    render(
      <MemoryRouter>
        <SidebarNav />
        <WaitingForReview fold="review" />
      </MemoryRouter>,
    );
    const green = () => document.querySelector('[data-testid="nav-main"] [data-testid="team-review-count"]')?.textContent ?? "0";
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    expect(green()).toBe("2");
    expect(list.mock.calls.filter(([q]) => !q?.state)).toHaveLength(1); // one fetch for the pill and the list
    fireEvent.click(within(screen.getAllByTestId("review-card")[0]).getByTestId("review-complete"));
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(1));
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1");
    expect(green()).toBe("1");
  });
});

describe("T72-S6 the milestone list's keep is the pills' keep", () => {
  it("blockedItems keeps an item of a milestone no project owns, as the list does", () => {
    const ms = { id: "ms_free" } as Milestone;
    const keep = (id?: string | null) => id === ms.id || id === "ms_x";
    expect(blockedItems(batch([pending("a", { milestoneId: "ms_free" }), pending("b", { milestoneId: "ms_other" })]), { keep }).map((i) => i.id)).toEqual(["a"]);
  });
});
