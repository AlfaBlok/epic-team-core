// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem } from "@/api";
import type { CardFace, ClosedCard } from "@/api/review-types";
import { WaitingForReview } from "@/components/review";
import { AfterCloseNote, RecentlyClosed } from "@/components/afterClose";
import { resetReviewGone } from "@/lib/inbox";
import { landed, UNDO_MS } from "@/lib/press";
import { closeNote, NOTE_MS, resetClosedNote, showClosed } from "@/lib/afterClose";

/**
 * after a card closes, a floating note says it was saved and offers Add a last
 * thought (his words to the same row's owner) and Bring it back (the press taken back inside its window, else the row
 * reopened); every closed card is findable under Recently closed with Add comment.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetReviewGone();
  resetClosedNote();
});

const FACE: CardFace = {
  project: { name: "TEST Epic Team", url: "https://team.example.com/" },
  goal: { text: "We want a last thought after a card closes.", code: "PLAN-991" },
  tasks: { done: 0, total: 1 },
  title: "A test card was put up to try Bring it back.",
  taskGoal: "We want a last thought after a card closes.",
  delivered: [{ ok: true, text: "The test card is there to press." }],
  evidence: { url: "https://team.example.com/", label: "Open the test page" },
  screenshot: "docs/status/test.png",
  tree: [],
  after: "",
  next: [],
  closesGoal: false,
  openInGoal: [],
};
const ITEM: ReviewItem = {
  id: "rv_t18",
  title: "TEST card",
  liveUrl: "https://team.example.com/",
  ref: "T991-C1",
  repo: "e72-close-test",
  path: "docs/spines/close-test.md",
  github: "Acme/e72-close-test",
  cardPath: "docs/cards/T991-C1.md",
  milestoneId: "ms_t",
  state: "review",
  status: "review",
  liveStatus: 200,
  checkedAt: "2026-11-10T17:00:00Z",
  createdAt: "2026-11-10",
  verdict: { kind: "card" },
  face: FACE,
};
const ROW = { kind: "review", repo: ITEM.repo, path: ITEM.path, ref: ITEM.ref, milestoneId: "ms_t" };
const mount = () => {
  vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
  return render(
    <MemoryRouter>
      <WaitingForReview fold="review" />
      <AfterCloseNote />
    </MemoryRouter>,
  );
};
/** A press the console saved and holds for its undo window (it never lands in these tests). */
const held = () =>
  vi.spyOn(api, "completeReviewItem").mockImplementation(() =>
    landed<ReviewItem>({ press: { id: "pr_18", state: "landing", undoMs: UNDO_MS } }, `/review-items/${ITEM.id}/complete`, () => new Promise(() => {}), (m) => new Error(m)),
  );
// the main button reads "Mark complete" (was "✓ Mark this task complete")
const MARK = "Mark complete";
/** vn_e00f1134: the press collapses the card in place to its green Sent row (the floating note stays away). */
const press = async () => {
  const c = await screen.findByTestId("review-card");
  fireEvent.click(within(c).getByRole("button", { name: MARK }));
  return screen.findByTestId("sent-row");
};

describe("vn_e00f1134 an answered card shrinks to one green Sent row in place (was T72-S18's floating note)", () => {
  it("says Sent with what was done and the card's title, offers Add comment and Bring it back; no floating note", async () => {
    mount();
    held();
    const row = await press();
    expect(within(row).getByTestId("sent-row-word").textContent).toContain("Sent");
    expect(within(row).getByTestId("sent-row-said").textContent).toBe("Closed");
    expect(within(row).getByTestId("sent-row-title").textContent).toBe(FACE.title);
    expect(within(row).getByTestId("sent-row-comment").textContent).toContain("Add comment");
    expect(within(row).getByTestId("sent-row-back").textContent).toContain("Bring it back");
    expect(screen.queryByTestId("review-card")).toBeNull();
    expect(screen.queryByTestId("after-close-note")).toBeNull();
    // it stays in place past the old note's time
    await new Promise((r) => setTimeout(r, 1200));
    expect(screen.getByTestId("sent-row")).toBeTruthy();
  });

  it("Bring it back inside the window takes the press back: the card is in the list again with its buttons", async () => {
    mount();
    held();
    const undo = vi.spyOn(api, "undoPress").mockResolvedValue({ undone: true });
    const reopen = vi.spyOn(api, "reopenReviewRow");
    const row = await press();
    fireEvent.click(within(row).getByTestId("sent-row-back"));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("pr_18"));
    expect(reopen).not.toHaveBeenCalled();
    const c = await screen.findByTestId("review-card");
    expect((within(c).getByRole("button", { name: MARK }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(c).queryByTestId("review-error")).toBeNull();
    expect(screen.queryByTestId("sent-row")).toBeNull();
  });

  it("once the press is being written or landed (409), Bring it back reopens the row through the console", async () => {
    mount();
    held();
    vi.spyOn(api, "undoPress").mockRejectedValue(Object.assign(new Error("it is in the project already"), { status: 409 }));
    const reopen = vi.spyOn(api, "reopenReviewRow").mockResolvedValue({ status: "review" });
    const row = await press();
    fireEvent.click(within(row).getByTestId("sent-row-back"));
    await waitFor(() => expect(reopen).toHaveBeenCalledWith({ ...ROW, title: FACE.title, id: ITEM.id }));
    expect(await screen.findByTestId("review-card")).toBeTruthy();
  });

  it("Add comment opens a note box on the same card and sends his words to the same row", async () => {
    mount();
    held();
    const comment = vi.spyOn(api, "commentClosedCard").mockResolvedValue({ sha: "abc1234" });
    const row = await press();
    fireEvent.click(within(row).getByTestId("sent-row-comment"));
    const box = within(row).getByTestId("sent-row-box");
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "Also check the phone view" } });
    fireEvent.click(within(box).getByTestId("sent-row-box-send"));
    await waitFor(() => expect(comment).toHaveBeenCalledWith({ ...ROW, title: FACE.title, text: "Also check the phone view", via: "text" }));
    expect(await within(row).findByTestId("sent-row-commented")).toBeTruthy();
    // the row stays, Add comment again for one more
    expect(within(row).getByTestId("sent-row-comment")).toBeTruthy();
  });

  it("the comment says sent on the console's reply (saved), not when it is written to the project", async () => {
    mount();
    held();
    vi.spyOn(api, "commentClosedCard").mockImplementation(() =>
      landed({ press: { id: "pr_c", state: "landing" } }, "/closed-cards/comment", () => new Promise(() => {}), (m) => new Error(m)),
    );
    const row = await press();
    fireEvent.click(within(row).getByTestId("sent-row-comment"));
    const box = within(row).getByTestId("sent-row-box");
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "one more thing" } });
    fireEvent.click(within(box).getByTestId("sent-row-box-send"));
    expect(await within(row).findByTestId("sent-row-commented")).toBeTruthy();
  });

  it("goes by itself after NOTE_MS; a newer close replaces it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<AfterCloseNote />);
    act(() => void showClosed({ said: "Approved", title: "one" }));
    expect(screen.getByTestId("after-close-note").textContent).toContain("one");
    act(() => void showClosed({ said: "Answered", title: "two" }));
    expect(screen.getByTestId("after-close-note").textContent).toContain("two");
    await act(async () => void (await vi.advanceTimersByTimeAsync(NOTE_MS + 300)));
    expect(screen.queryByTestId("after-close-note")).toBeNull();
    expect(NOTE_MS).toBeLessThan(UNDO_MS);
    closeNote();
  });
});

describe("T72-S18 Recently closed on Team home", () => {
  const CLOSED: ClosedCard[] = [
    { key: "review:e72-close-test:docs/spines/close-test.md#T991-C1", kind: "review", repo: ITEM.repo!, path: ITEM.path!, ref: ITEM.ref!, title: FACE.title, outcome: "approved", at: "2026-11-10T17:05:00Z", milestoneId: "ms_t", comments: 1 },
    { key: "ask:e72-close-test:docs/spines/close-test.md#T991-A1", kind: "ask", repo: ITEM.repo!, path: ITEM.path!, ref: "T991-A1", title: "Which colour?", outcome: "answered", answer: "green", at: "2026-11-10T17:01:00Z", responseId: "jr_1", comments: 0 },
  ];
  it("lists every closed card folded with its count; Add comment sends to that row or ask", async () => {
    vi.spyOn(api, "listClosedCards").mockResolvedValue(CLOSED);
    const comment = vi.spyOn(api, "commentClosedCard").mockResolvedValue({});
    render(
      <MemoryRouter>
        <RecentlyClosed />
      </MemoryRouter>,
    );
    const sec = await screen.findByTestId("recently-closed");
    expect(sec.textContent).toContain("Recently closed");
    fireEvent.click(within(sec).getByText("Recently closed"));
    const rows = await screen.findAllByTestId("recently-closed-item");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Approved:");
    expect(rows[0].textContent).toContain("1 comment");
    expect(rows[1].textContent).toContain("“green”");
    fireEvent.click(within(rows[1]).getByTestId("recently-closed-comment"));
    const box = within(rows[1]).getByTestId("recently-closed-box");
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "Make it blue instead" } });
    fireEvent.click(within(box).getByTestId("recently-closed-box-send"));
    await waitFor(() => expect(comment).toHaveBeenCalledWith(expect.objectContaining({ kind: "ask", ref: "T991-A1", repo: ITEM.repo, path: ITEM.path, text: "Make it blue instead" })));
  });
});
