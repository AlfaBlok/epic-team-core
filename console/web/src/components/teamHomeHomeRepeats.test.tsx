// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch } from "@/api";
import { TeamPage } from "@/pages/Team";
import { WaitingOnYou } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";

// one home, no repeats. No Pending summary list; two full-width sections fold on their
// headings, each with its own count; while the cards load, skeleton cards (as many as the known count, else a few).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

const ITEM: ReviewItem = { id: "rv_1", title: "Epic Book", liveUrl: "https://team.example.com/book", ref: "T40-S2", state: "review", liveStatus: 200, checkedAt: "2026-11-01T15:00:00Z", createdAt: "2026-11-01T15:00:00Z" };
const open = (n: number): PendingItem[] => Array.from({ length: n }, (_, k) => ({ id: `ms_x:${k}`, kind: "ask", state: "open", milestoneId: "ms_x", title: `ask ${k}` }));
const batch = (items: PendingItem[], loading = false): StatusBatch => ({ milestones: [], items, needsYou: loading ? null : items.length, loading, at: "2026-11-01T16:00:00Z" });
const never = <T,>() => new Promise<T>(() => {});

describe("T48-S2 Team home: one home, no repeats", () => {
  it("has no Pending list; Blocked and Done sections each fold with a count", async () => {
    vi.spyOn(api, "listReviewItems").mockResolvedValue([ITEM]);
    render(
      <MemoryRouter>
        <TeamPage />
      </MemoryRouter>,
    );
    const blocked = await screen.findByTestId("waiting-on-you-toggle");
    expect(blocked.textContent).toContain("Blocked on you"); // (round 2 mockup)
    await waitFor(() => expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1"));
    expect(screen.queryByTestId("pending-selector")).toBeNull();
    expect(screen.queryByText(/^Pending$/i)).toBeNull();
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-count")).toBeTruthy());

    // Independent folds, remembered.
    const review = screen.getByTestId("waiting-for-review-toggle");
    expect(review.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(review);
    expect(review.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("review-card")).toBeNull();
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1");
    expect(blocked.getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem("teamHome.section.review")).toBe("closed");
  });

  it("a folded section stays folded on the next visit", async () => {
    localStorage.setItem("teamHome.section.blocked", "closed");
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch(open(2)));
    render(
      <MemoryRouter>
        <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("2"));
    expect(screen.getByTestId("waiting-on-you-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Nothing waiting on you/)).toBeNull();
  });
});

describe("T48-S2 skeleton cards while the cards load", () => {
  it("count known from the status batch: that many skeletons, the badge shows it", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockReturnValue(never());
    vi.spyOn(api, "listStatus").mockResolvedValue(batch(open(4)));
    render(
      <MemoryRouter>
        <WaitingOnYou fold="blocked" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("4"));
    expect(within(screen.getByTestId("waiting-on-you-loading")).getAllByTestId("skeleton-card")).toHaveLength(4);
  });

  it("count unknown (status still counting): a few skeletons and a '…' badge", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockReturnValue(never());
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([], true));
    render(
      <MemoryRouter>
        <WaitingOnYou fold="blocked" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.listStatus).toHaveBeenCalled());
    expect(screen.getByTestId("waiting-on-you-count-loading")).toBeTruthy();
    expect(within(screen.getByTestId("waiting-on-you-loading")).getAllByTestId("skeleton-card")).toHaveLength(3);
  });

  it("review list loading: skeletons, then its cards", async () => {
    let done!: (v: ReviewItem[]) => void;
    vi.spyOn(api, "listReviewItems").mockReturnValue(new Promise((r) => (done = r)));
    render(
      <MemoryRouter>
        <WaitingForReview fold="review" />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId("skeleton-card").length).toBeGreaterThan(0);
    expect(screen.getByTestId("waiting-for-review-count-loading")).toBeTruthy();
    done([ITEM]);
    await screen.findByTestId("review-card");
    expect(screen.queryByTestId("skeleton-card")).toBeNull();
  });
});
