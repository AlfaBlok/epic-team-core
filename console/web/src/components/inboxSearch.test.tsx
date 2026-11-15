// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type InboxSearchResult, type PendingItem, type ReviewItem, type StatusBatch, type WaitingItem } from "@/api";
import { WaitingOnYou } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
import { InboxSearchBox } from "@/components/inboxSearch";
import { InboxSearchProvider } from "@/lib/inboxSearch";
import { resetSnoozes } from "@/lib/snooze";
import { resetReviewGone } from "@/lib/inbox";

/**
 * the owner, 2026-11-12 21:17Z: a search box at the top of the inbox; typing a word (e.g. Condesa) filters
 * every section (blocked, review, done) at once. The server names the matching items; each section keeps only those.
 */

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ownSearch = api.searchInbox;
afterEach(() => {
  api.searchInbox = ownSearch;
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
  ({ id, source: "ask", state: "open", repo: "home_repo", code, milestoneId: "ms_x", milestoneTitle: "home_repo", path: "docs/spines/epic-9.md", line: 12, title: `row of ${code}`, ask: "decide", question: `Question ${code}?`, contextLinks: [], owner: { label: "Delivery Manager" }, decidable: false, ...extra }) as WaitingItem;
const pending = (id: string): PendingItem => ({ id, kind: "ask", state: "open", milestoneId: "ms_x", title: `row of ${id}` });
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-12T21:00:00Z" });
const FACE = {
  project: { name: "Memo" },
  goal: { text: "Get Memo out", code: "PLAN-10" },
  tasks: { done: 1, total: 9 },
  title: "",
  taskGoal: "Every directory gets a logo.",
  delivered: [{ ok: true, text: "The logo exists." }],
  evidence: { url: "https://memo.example.com/connect", label: "Open" },
  tree: [],
  next: [],
  closesGoal: false,
  openInGoal: [],
};
const card = (id: string, title: string): ReviewItem =>
  ({ id, title, liveUrl: "https://memo.example.com/connect", ref: id, repo: "memo", path: "docs/PLAN-10.md", milestoneId: "ms_1", state: "review", status: "review", liveStatus: 200, checkedAt: "2026-11-12T01:00:00Z", createdAt: "2026-11-12", verdict: { kind: "card" }, face: { ...FACE, title } }) as unknown as ReviewItem;

function inbox(listed: WaitingItem[] = [], moreHits: string[] = []) {
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([ask("wj_a", "E938-A4", { question: "Which flat in La Condesa?" }), ask("wj_b", "E909-A1", { question: "Logo A or B?" }), ...listed]);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending("wj_a"), pending("wj_b")]));
  vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [card("rv_1", "The Condesa flat was booked."), card("rv_2", "The logo was made.")]));
  const old = { ...ask("wj_old", "E938-A2", { question: "Also the Condesa flat?", state: "done" }), slim: true } as WaitingItem;
  const search = vi.fn(async (q: string): Promise<InboxSearchResult> =>
    /condesa/i.test(q)
      ? { q, tookMs: 3, total: 3, counts: { blocked: 1, review: 1, done: 1 }, hits: [{ id: "wj_a", section: "blocked", where: ["card"], title: "" }, { id: "rv_1", section: "review", where: ["title"], title: "" }, { id: "wj_old", section: "done", where: ["note"], title: "" }, ...moreHits.map((id) => ({ id, section: "done" as const, where: ["card" as const], title: "" }))], rows: [old] }
      : { q, tookMs: 2, total: 0, counts: { blocked: 0, review: 0, done: 0 }, hits: [], rows: [] },
  );
  api.searchInbox = search;
  render(
    <MemoryRouter>
      <InboxSearchProvider>
        <InboxSearchBox />
        <WaitingOnYou title="Blocked on you" fold="blocked" part="blocked" />
        <WaitingForReview fold="review" />
        <WaitingOnYou title="Blocked on you" fold="blocked" part="rest" />
      </InboxSearchProvider>
    </MemoryRouter>,
  );
  return { search };
}

describe("the Inbox search box", () => {
  it("an ask the list holds and the search sends again as a row (same repo and code, another id) shows once", async () => {
    // the same ask written in two spines of one repo came back twice in Answered on the phone (2026-11-12)
    inbox([ask("wj_listed", "E938-A2", { question: "Also the Condesa flat?", state: "done" })], ["wj_listed"]);
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(2));
    fireEvent.change(screen.getByTestId("inbox-search-input"), { target: { value: "Condesa" } });
    await waitFor(() => expect(screen.getByTestId("answered-section")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("answered-section").textContent).toContain("Also the Condesa flat?"));
    const txt = screen.getByTestId("answered-section").textContent!;
    expect(txt.split("Also the Condesa flat?").length - 1).toBe(1);
  });

  it("typing a word filters blocked, review and done at once; each count follows; Clear brings everything back", async () => {
    const { search } = inbox();
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    fireEvent.change(screen.getByTestId("inbox-search-input"), { target: { value: "Condesa" } });
    await waitFor(() => expect(screen.getByTestId("inbox-search-line").textContent).toBe("Showing what matches “Condesa”: each section counts its matches."));
    expect(search).toHaveBeenCalledWith("Condesa");
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(1));
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1");
    expect(screen.getAllByTestId("review-card")).toHaveLength(1);
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1");
    // the done item older than the list's window comes from the search as its row, the Answered list open.
    expect(screen.getByTestId("answered-section").textContent).toContain("Also the Condesa flat?");
    fireEvent.click(screen.getByTestId("inbox-search-clear"));
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(2);
    expect(screen.queryByTestId("inbox-search-line")).toBeNull();
    expect(screen.queryByTestId("answered-section")).toBeNull();
  });

  it("nothing matches: one plain line, and each section says nothing here matches", async () => {
    inbox();
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(2));
    fireEvent.change(screen.getByTestId("inbox-search-input"), { target: { value: "Polanco" } });
    await waitFor(() => expect(screen.getByTestId("inbox-search-line").textContent).toBe("Nothing matches “Polanco”."));
    await waitFor(() => expect(screen.queryAllByTestId("waiting-card")).toHaveLength(0));
    expect(screen.getByTestId("nothing-matches-blocked").textContent).toContain("Polanco");
    expect(screen.getByTestId("nothing-matches-review").textContent).toContain("Polanco");
    expect(screen.queryByTestId("nothing-waiting")).toBeNull();
  });

  it("one letter is no search; Escape clears", async () => {
    const { search } = inbox();
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(2));
    const box = screen.getByTestId("inbox-search-input");
    fireEvent.change(box, { target: { value: "C" } });
    await new Promise((r) => setTimeout(r, 250));
    expect(search).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(2);
    fireEvent.change(box, { target: { value: "Condesa" } });
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(1));
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(2));
    expect((box as HTMLInputElement).value).toBe("");
  });
});
