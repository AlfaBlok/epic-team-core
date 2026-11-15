// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch, type WaitingItem } from "@/api";
import { WaitingOnYou } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
import { sortSection } from "@/components/homeSection";

// each Team home section has its own sort: highest priority (default, the server's
// milestone order), most recent, longest standing; each section remembers its choice.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

const ask = (id: string, code: string, since: string): WaitingItem =>
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
    since,
  }) as unknown as WaitingItem;
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-01T16:00:00Z" });
const pending = (w: WaitingItem): PendingItem => ({ id: w.id, kind: "ask", state: "open", milestoneId: "ms_x", title: w.title, since: w.since });
const review = (id: string, createdAt: string): ReviewItem => ({ id, title: `Review ${id}`, liveUrl: "https://team.example.com/", state: "review", liveStatus: 200, checkedAt: createdAt, createdAt });

// Server (priority) order: middle-aged, oldest, newest.
const asks = [ask("wj_b", "E909-A2", "2026-10-20T00:00:00Z"), ask("wj_a", "E909-A1", "2026-10-01T00:00:00Z"), ask("wj_c", "E909-A3", "2026-10-30T00:00:00Z")];
const reviews = [review("rv_b", "2026-10-20T00:00:00Z"), review("rv_a", "2026-10-01T00:00:00Z"), review("rv_c", "2026-10-30T00:00:00Z")];
const questions = () => screen.getAllByTestId("waiting-card").map((c) => c.textContent!.match(/Question (E909-A\d)\?/)![1]);
const reviewTitles = () => screen.getAllByTestId("review-card").map((c) => c.textContent!.match(/Review (rv_\w)/)![1]);

function home() {
  return render(
    <MemoryRouter>
      <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
      <WaitingForReview fold="review" />
    </MemoryRouter>,
  );
}

describe("E948-S8 per-section sort", () => {
  beforeEach(() => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue(asks);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch(asks.map(pending)));
    vi.spyOn(api, "listReviewItems").mockResolvedValue(reviews);
  });

  it("defaults to highest priority (the server's order) in both sections", async () => {
    home();
    await waitFor(() => expect(questions()).toEqual(["E909-A2", "E909-A1", "E909-A3"]));
    await waitFor(() => expect(reviewTitles()).toEqual(["rv_b", "rv_a", "rv_c"]));
    expect((screen.getByTestId("waiting-on-you-sort") as HTMLSelectElement).value).toBe("priority");
    // the review list has the same Sort back, default the server's order
    expect((screen.getByTestId("waiting-for-review-sort") as HTMLSelectElement).value).toBe("priority");
  });

  it("each section sorts on its own: most recent, longest standing", async () => {
    home();
    await waitFor(() => expect(questions()).toHaveLength(3));
    await waitFor(() => expect(reviewTitles()).toHaveLength(3));
    fireEvent.change(screen.getByTestId("waiting-on-you-sort"), { target: { value: "recent" } });
    expect(questions()).toEqual(["E909-A3", "E909-A2", "E909-A1"]);
    expect(reviewTitles()).toEqual(["rv_b", "rv_a", "rv_c"]); // the other section is untouched
    fireEvent.change(screen.getByTestId("waiting-on-you-sort"), { target: { value: "oldest" } });
    expect(questions()).toEqual(["E909-A1", "E909-A2", "E909-A3"]);
    // the review section sorts on its own; Blocked keeps its choice
    fireEvent.change(screen.getByTestId("waiting-for-review-sort"), { target: { value: "oldest" } });
    expect(reviewTitles()).toEqual(["rv_a", "rv_b", "rv_c"]);
    fireEvent.change(screen.getByTestId("waiting-for-review-sort"), { target: { value: "recent" } });
    expect(reviewTitles()).toEqual(["rv_c", "rv_b", "rv_a"]);
    expect(questions()).toEqual(["E909-A1", "E909-A2", "E909-A3"]);
  });

  it("each section remembers its choice after a reload", async () => {
    const first = home();
    await waitFor(() => expect(reviewTitles()).toHaveLength(3));
    fireEvent.change(screen.getByTestId("waiting-on-you-sort"), { target: { value: "oldest" } });
    fireEvent.change(screen.getByTestId("waiting-for-review-sort"), { target: { value: "recent" } });
    first.unmount();
    home();
    await waitFor(() => expect(questions()).toEqual(["E909-A1", "E909-A2", "E909-A3"]));
    await waitFor(() => expect(reviewTitles()).toEqual(["rv_c", "rv_b", "rv_a"]));
    expect(localStorage.getItem("teamHome.sort.blocked")).toBe("oldest");
    expect(localStorage.getItem("teamHome.sort.review")).toBe("recent");
  });

  it("no sort control off the Team home (a milestone's list keeps the server order)", async () => {
    render(
      <MemoryRouter>
        <WaitingOnYou milestoneId="ms_x" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(questions()).toHaveLength(3));
    expect(screen.queryByTestId("waiting-on-you-sort")).toBeNull();
  });

  it("sortSection: stable, undated items last", () => {
    const xs = [{ id: 1 }, { id: 2, d: "2026-01-02" }, { id: 3, d: "2026-01-01" }, { id: 4, d: "2026-01-02" }];
    expect(sortSection(xs, "priority", (x) => x.d).map((x) => x.id)).toEqual([1, 2, 3, 4]);
    expect(sortSection(xs, "recent", (x) => x.d).map((x) => x.id)).toEqual([2, 4, 3, 1]);
    expect(sortSection(xs, "oldest", (x) => x.d).map((x) => x.id)).toEqual([3, 2, 4, 1]);
  });
});
