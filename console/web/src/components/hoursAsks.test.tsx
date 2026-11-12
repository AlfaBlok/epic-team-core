// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch, type WaitingItem } from "@/api";
import { SnoozeDate, WaitingOnYou, snoozeDay } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
import { resetSnoozes, snoozeActive, snoozeMinute, snoozeUntilFor } from "@/lib/snooze";

// Snooze gains 3 hours (3 hours / 3 days / 1 week / 1 month); every review card gets the
// same Snooze (out of the list and its count, under "Snoozed reviews" with Unsnooze); a review summary is never cut
// for good: show more / show less reads it in full; the card names its row code, age, milestone and Epic Book.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSnoozes();
});
beforeEach(() => localStorage.clear());

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

const ask = (id: string, code: string): WaitingItem =>
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
  }) as unknown as WaitingItem;
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-01T16:00:00Z" });
const pending = (w: WaitingItem): PendingItem => ({ id: w.id, kind: "ask", state: "open", milestoneId: "ms_x", title: w.title });

const LONG = `First line of a long summary. ${"More detail about what went live and how it was checked. ".repeat(20)}THE LAST WORDS.`;
const rv = (id: string, ref: string, extra: Partial<ReviewItem> = {}): ReviewItem & { milestoneTitle?: string } => ({
  id,
  title: `Done ${ref}`,
  liveUrl: `https://team.example.com/${id}`,
  ref,
  state: "review",
  liveStatus: 200,
  checkedAt: "2026-11-02T15:00:00Z",
  createdAt: "2026-11-02T14:00:00Z",
  milestoneId: "ms_x",
  milestoneTitle: "PLAN-48 Review inbox",
  summary: LONG,
  // every listed card carries its face
  verdict: { kind: "card" },
  face: {
    project: { name: "The team console", url: "https://team.example.com/" },
    goal: { text: "Show you finished work in one clear list to check", code: "PLAN-48" },
    tasks: { done: 13, total: 27 },
    title: `The ${ref} page was built so you can check it.`,
    taskGoal: "You can open it and check it.",
    delivered: [
      { ok: true, text: "It opens on a laptop." },
      { ok: true, text: "It opens on a phone." },
    ],
    evidence: { url: `https://team.example.com/${id}`, label: "Open Team home" },
    tree: [{ mark: "this", text: "This task: the page" }],
    next: [],
    closesGoal: false,
    openInGoal: [],
  },
  ...extra,
});
const reviews = (open: ReviewItem[], snoozed: ReviewItem[] = []) =>
  vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: "snoozed" | "pending" | "backlog" }) => (q?.state === "snoozed" ? snoozed : open));
const home = () =>
  render(
    <MemoryRouter>
      <WaitingForReview fold="review" />
    </MemoryRouter>,
  );
const pick = (card: HTMLElement, label: string) => {
  fireEvent.click(within(card).getByRole("button", { name: /Snooze/ }));
  fireEvent.click(within(card).getByText(label));
};

describe("T48-S21 3 hours on the asks", () => {
  it("the dropdown reads 3 hours / 3 days / 1 week / 1 month; 3 hours posts hours: 3 and hides the card at once", async () => {
    const a = ask("wj_a", "T9-A1");
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([a]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending(a)]));
    const d = deferred<{ id: string; snoozedUntil: string | null }>();
    const post = vi.spyOn(api, "snoozeWaiting").mockReturnValue(d.promise);
    render(
      <MemoryRouter>
        <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
      </MemoryRouter>,
    );
    const card = await screen.findByTestId("waiting-card");
    fireEvent.click(within(card).getByRole("button", { name: /Snooze/ }));
    expect(within(card).getAllByTestId("snooze-option").map((o) => o.textContent)).toEqual(["3 hours", "3 days", "1 week", "1 month"]);
    fireEvent.click(within(card).getByText("3 hours"));
    expect(post).toHaveBeenCalledWith("wj_a", { hours: 3, milestoneId: "ms_x" });
    expect(screen.queryByTestId("waiting-card")).toBeNull();
    expect(screen.getByTestId("working-line").textContent).toMatch(/Snoozing T9-A1 until .*\d:\d{2}/);
    await act(async () => d.resolve({ id: a.id, snoozedUntil: snoozeMinute(3) }));
  });

  it("snooze values: hours are a UTC minute, days a day; a minute is active until it passes; the label has the hour", () => {
    const now = Date.parse("2026-11-02T15:20:10Z");
    expect(snoozeUntilFor({ hours: 3 }, now)).toBe("2026-11-02T18:21Z");
    expect(snoozeUntilFor({ days: 3 }, now)).toBe("2026-11-05");
    expect(snoozeUntilFor(7, now)).toBe("2026-11-09");
    expect(snoozeActive("2026-11-02T18:21Z", now)).toBe(true);
    expect(snoozeActive("2026-11-02T15:20Z", now)).toBe(false);
    expect(snoozeActive("2026-11-03", now)).toBe(true);
    expect(snoozeDay("2026-11-02T18:21Z")).toMatch(/\d{1,2}:\d{2}/);
    expect(snoozeDay("2026-11-05")).not.toMatch(/:/);
  });
});

describe("T48-S21 SnoozeDate for a minute", () => {
  it("plain text: 'until <weekday, day, time>' on wide screens; on a phone the time alone when it is today", () => {
    const until = "2026-11-02T18:41:00Z";
    const sameDay = Date.parse(until) - 60_000;
    const { container } = render(<SnoozeDate until={until} now={sameDay} />);
    const [wide, phone] = [...container.querySelectorAll("span")];
    expect(wide.className).toBe("max-sm:hidden");
    expect(wide.textContent).toMatch(/^until .+\d:\d{2}/);
    expect(phone.className).toBe("sm:hidden");
    expect(phone.textContent).toBe(new Date(until).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" }));
    cleanup();
    const other = render(<SnoozeDate until={until} now={Date.parse(until) - 3 * 86_400_000} />);
    expect(other.container.querySelectorAll("span")[1].textContent).toBe(new Date(until).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }));
  });
});

describe("T48-S21 Snooze on review cards", () => {
  it("a pick hides the card and drops the count at once, posts the choice, and lists it under Snoozed reviews with Unsnooze", async () => {
    const a = rv("rv_a", "T48-S21");
    const b = rv("rv_b", "T48-S20");
    const list = reviews([a, b]);
    const d = deferred<ReviewItem & { snoozedUntil: string | null }>();
    const post = vi.spyOn(api, "snoozeReviewItem").mockReturnValue(d.promise as never);
    home();
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("2");
    const card = screen.getAllByTestId("review-card")[0];
    fireEvent.click(within(card).getByRole("button", { name: /Snooze/ }));
    expect(within(card).getAllByTestId("snooze-option").map((o) => o.textContent)).toEqual(["3 hours", "3 days", "1 week", "1 month"]);
    fireEvent.click(within(card).getByText("3 hours"));
    expect(post).toHaveBeenCalledWith("rv_a", { hours: 3 });
    // Before the server answers: one card, count 1, the spinner line names the row.
    expect(screen.getAllByTestId("review-card")).toHaveLength(1);
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1");
    expect(screen.getByTestId("working-line").textContent).toMatch(/Snoozing The T48-S21 page was built so you can check it\. until/);
    expect(screen.getByTestId("review-snoozed-count").textContent).toBe("1");

    const until = snoozeMinute(3);
    list.mockImplementation(async (q?: { state?: "snoozed" | "pending" | "backlog" }) => (q?.state === "snoozed" ? [{ ...a, snoozedUntil: until }] : [b]));
    await act(async () => d.resolve({ ...a, snoozedUntil: until }));
    await waitFor(() => expect(screen.getByTestId("snoozed-line").textContent).toMatch(/Snoozed The T48-S21 page was built so you can check it\. until/));
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1");

    fireEvent.click(screen.getByTestId("review-snoozed-count"));
    const row = within(screen.getByTestId("review-snoozed-section")).getByTestId("review-snoozed-row");
    expect(row.textContent).toContain("T48-S21");
    const un = vi.spyOn(api, "snoozeReviewItem").mockResolvedValue({ ...a, snoozedUntil: null } as never);
    list.mockImplementation(async (q?: { state?: "snoozed" | "pending" | "backlog" }) => (q?.state === "snoozed" ? [] : [a, b]));
    fireEvent.click(within(row).getByTestId("review-unsnooze"));
    expect(un).toHaveBeenCalledWith("rv_a", { until: null });
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("2");
  });

  it("a failed write brings the card back with the reason under its Snooze button", async () => {
    reviews([rv("rv_a", "T48-S21")]);
    vi.spyOn(api, "snoozeReviewItem").mockRejectedValue(new Error("no such review item"));
    home();
    pick(await screen.findByTestId("review-card"), "1 week");
    const card = await screen.findByTestId("review-card");
    expect(within(card).getByTestId("snooze-error").textContent).toMatch(/Snooze failed, the card is back: no such review item/);
  });

  it("snoozed reviews from the server show folded with their count, not as cards", async () => {
    reviews([rv("rv_b", "T48-S20")], [rv("rv_a", "T48-S21", { snoozedUntil: "2099-01-01T10:00Z" })]);
    home();
    await waitFor(() => expect(screen.getByTestId("review-snoozed-count").textContent).toBe("1"));
    expect(screen.getAllByTestId("review-card")).toHaveLength(1);
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1");
  });
});

// "review cards are complete" (row code, age, Epic Book line, clamped summary) is superseded by the approved card
// face: components/review.test.tsx.
