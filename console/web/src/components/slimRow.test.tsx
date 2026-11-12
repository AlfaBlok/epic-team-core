// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { api, type RedLine, type ReviewItem, type WaitingItem } from "@/api";
import { RedLineBand, splitVoiceReply } from "@/components/ownerPriority";
import { resetReviewGone } from "@/lib/inbox";

// (the owner 2026-11-10 20:45Z, vn_ffa4783d: "they should be like more like one row each, and I should have a button
// to edit … I can also delete it"): one slim row per red line, a pencil that unfolds a box to type or speak the change,
// a bin that deletes after one confirm, and Undo.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetReviewGone();
});

const inRouter = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const line: RedLine = {
  name: "Data-product flywheel",
  target: "2026-11-30",
  sentence: "By 30 November, two or three data products run on their own.",
  state: "agreed",
  at: "2026-11-10T17:55:00Z",
  items: [
    { repo: "deal-funnels", ref: "PLAN-5-A1", why: "Create the Towerwatch bot in Telegram." },
    { repo: "deal-funnels", ref: "T5-S1" },
  ],
};

describe("T48-S39 the slim row", () => {
  it("is one row: name, day and item count; a tap unfolds its cards and nothing else", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: line, redLines: [line] });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listReviewItems").mockResolvedValue([]);
    inRouter(<RedLineBand />);
    await waitFor(() => expect(screen.getByTestId("red-line-name").textContent).toBe("Data-product flywheel"));
    expect(screen.getByTestId("red-line-count").textContent).toBe("2");
    expect(screen.getByTestId("red-line-target").textContent).toBe("by 30 Nov");
    expect(screen.queryByTestId("red-line-cards")).toBeNull();
    fireEvent.click(screen.getByTestId("red-line-row"));
    await waitFor(() => screen.getByTestId("red-line-cards-none"));
    // iteration 2: no sentence, state or item list unfolds any more
    expect(screen.queryByText(line.sentence)).toBeNull();
    expect(screen.queryByText("Create the Towerwatch bot in Telegram.")).toBeNull();
  });

  it("the pencil unfolds a box; his typed words change the line", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: line, redLines: [line] });
    const edit = vi.spyOn(api, "editRedLine").mockResolvedValue({ ok: true, line: { ...line, target: "2026-12-15", state: "changed" } });
    render(<RedLineBand />);
    await waitFor(() => screen.getByTestId("red-line-edit"));
    fireEvent.click(screen.getByTestId("red-line-edit"));
    const box = screen.getByTestId("red-line-edit-box").querySelector("textarea")!;
    fireEvent.change(box, { target: { value: "Move it to 15 December." } });
    fireEvent.click(screen.getByTestId("red-line-save"));
    await waitFor(() => expect(edit).toHaveBeenCalledWith({ name: "Data-product flywheel", words: "Move it to 15 December." }));
    await waitFor(() => expect(screen.queryByTestId("red-line-edit-box")).toBeNull());
  });

  it("a failed change says why and keeps the box", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: line, redLines: [line] });
    vi.spyOn(api, "editRedLine").mockRejectedValue(new Error("the model did not answer"));
    render(<RedLineBand />);
    await waitFor(() => screen.getByTestId("red-line-edit"));
    fireEvent.click(screen.getByTestId("red-line-edit"));
    fireEvent.change(screen.getByTestId("red-line-edit-box").querySelector("textarea")!, { target: { value: "Rename it." } });
    fireEvent.click(screen.getByTestId("red-line-save"));
    await waitFor(() => expect(screen.getByTestId("red-line-failed").textContent).toContain("the model did not answer"));
    expect(screen.getByTestId("red-line-edit-box")).toBeTruthy();
  });

  it("the bin asks once, deletes, and Undo brings it back", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: line, redLines: [line] });
    const del = vi.spyOn(api, "deleteRedLine").mockResolvedValue({ ok: true });
    const undo = vi.spyOn(api, "undoRedLine").mockResolvedValue({ ok: true });
    render(<RedLineBand />);
    await waitFor(() => screen.getByTestId("red-line-delete"));
    fireEvent.click(screen.getByTestId("red-line-delete"));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByTestId("red-line-delete-confirm").textContent).toContain("Delete the red line “Data-product flywheel”? Only the line goes. Its cards stay in your inbox");
    expect(screen.getByTestId("red-line-delete-yes").textContent).toBe("Delete the line");
    expect(screen.getByTestId("red-line-delete").getAttribute("aria-label")).toBe("Delete the red line Data-product flywheel only, its cards stay");
    fireEvent.click(screen.getByTestId("red-line-delete-yes"));
    await waitFor(() => expect(del).toHaveBeenCalledWith({ name: "Data-product flywheel" }));
    await waitFor(() => expect(screen.getByTestId("red-line-deleted").textContent).toContain("Deleted the red line “Data-product flywheel”. Its cards are still in your inbox."));
    fireEvent.click(screen.getByTestId("red-line-undo"));
    await waitFor(() => expect(undo).toHaveBeenCalledWith({ name: "Data-product flywheel" }));
  });
});

const onLine = { level: "high" as const, ref: "x", why: "On the line", redLine: { sentence: line.sentence, state: "agreed" as const, name: "Data-product flywheel" } };
const offLine = { level: "high" as const, ref: "y", why: "Another line", redLine: { sentence: "Other", state: "agreed" as const, name: "Memo's first tester" } };
const ask = (over: Partial<WaitingItem>): WaitingItem =>
  ({
    id: "wj_1",
    code: "PLAN-5-A1",
    repo: "deal-funnels",
    source: "ask",
    state: "open",
    who: "Sam",
    milestoneId: "ms_1",
    path: "docs/spines/flywheel.md",
    title: "Create the bot",
    ask: "provide",
    question: "Create the Towerwatch bot in Telegram?",
    options: [],
    contextLinks: [],
    owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager" },
    since: "2026-11-06T10:00:00Z",
    decidable: false,
    ...over,
  }) as WaitingItem;
const review = (over: Partial<ReviewItem>): ReviewItem =>
  ({
    id: "rv_1",
    title: "Products page",
    liveUrl: "https://team.example.com",
    ref: "T5-S1",
    repo: "deal-funnels",
    path: "docs/spines/flywheel.md",
    milestoneId: "ms_1",
    state: "review",
    status: "review",
    createdAt: "2026-11-08",
    verdict: { kind: "card" },
    face: {
      project: { name: "Deals", url: "https://team.example.com/" },
      goal: { text: "Two data products run on their own", code: "PLAN-5" },
      tasks: { done: 1, total: 2 },
      title: "One page was made to show each product's fresh data.",
      taskGoal: "See every product at a glance.",
      delivered: [{ ok: true, text: "The page is live." }],
      evidence: { url: "https://team.example.com", label: "Open the page" },
      screenshot: "docs/status/x.webp",
      tree: [],
      after: "",
      next: [],
      closesGoal: false,
      openInGoal: [],
    },
    ...over,
  }) as unknown as ReviewItem;

describe("T48-S39 iteration 2: unfolded, the line is its big cards", () => {
  it("shows the full ask and review cards on this line, in the line's order, and none from another line", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: line, redLines: [line] });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([ask({ ownerPriority: onLine }), ask({ id: "wj_2", code: "T23-A1", repo: "memo", question: "Name your tester?", ownerPriority: offLine })]);
    vi.spyOn(api, "listReviewItems").mockImplementation((async (q?: { state?: string }) => (q?.state ? [] : [review({ ownerPriority: onLine }), review({ id: "rv_2", ref: "T88-S23", repo: "home_repo", ownerPriority: offLine })])) as never);
    inRouter(<RedLineBand />);
    await waitFor(() => screen.getByTestId("red-line-row"));
    fireEvent.click(screen.getByTestId("red-line-row"));
    await waitFor(() => expect(screen.getAllByTestId("red-line-card")).toHaveLength(2));
    const box = screen.getByTestId("red-line-cards");
    expect(screen.getAllByTestId("red-line-card").map((e) => e.getAttribute("data-inbox-card"))).toEqual(["ask:wj_1", "review:rv_1"]);
    expect(box.textContent).toContain("Create the Towerwatch bot in Telegram?");
    expect(box.textContent).toContain("One page was made to show each product's fresh data.");
    expect(box.textContent).not.toContain("Name your tester?");
    // the same big review card as the review list, with its buttons
    expect(box.querySelector('[data-testid="review-card"]')).toBeTruthy();
    expect(box.querySelectorAll("button").length).toBeGreaterThan(3);
    expect(screen.queryByTestId("red-line-cards-rest")).toBeNull();
  });

  it("says how many items on the line have no card for him yet", async () => {
    const three = { ...line, items: [...line.items, { repo: "deal-funnels", ref: "T5-S3" }] };
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: three, redLines: [three] });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([ask({ ownerPriority: onLine })]);
    vi.spyOn(api, "listReviewItems").mockResolvedValue([]);
    inRouter(<RedLineBand />);
    await waitFor(() => screen.getByTestId("red-line-row"));
    fireEvent.click(screen.getByTestId("red-line-row"));
    await waitFor(() => expect(screen.getAllByTestId("red-line-card")).toHaveLength(1));
    expect(screen.getByTestId("red-line-cards-rest").textContent).toBe("2 more on this line are with the team, no card for you yet.");
  });
});

describe("T48-S39 a voice note's reply", () => {
  it("splits his words from the note's id", () => {
    expect(splitVoiceReply("Move it to 15 December (voice note vn_ab12cd34, audio https://x/y.webm)")).toEqual({ words: "Move it to 15 December", note: "vn_ab12cd34" });
    expect(splitVoiceReply("Rename it (voice note vn_ab12cd34)")).toEqual({ words: "Rename it", note: "vn_ab12cd34" });
    expect(splitVoiceReply("  just typed ")).toEqual({ words: "just typed" });
  });
});

describe("T48-S39 iteration 3: the live counts live in the one row", () => {
  it("puts the counts and the page icon inside the row, nothing in a strip under it; the icon's label carries the numbers", async () => {
    const zl: RedLine = {
      ...line,
      name: "Memo's first tester",
      links: [{ label: "Memo testers and counts", url: "https://cloud.memo.example.com/admin/testers" }],
      counts: [{ label: "Active testers", source: "memory-counts#active_testers", value: 0, sourceText: "Memo's public counts, active_testers" }],
    };
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: zl, redLines: [zl] });
    render(<RedLineBand />);
    await waitFor(() => screen.getByTestId("red-line-counts"));
    expect(screen.getByTestId("red-line-row").contains(screen.getByTestId("red-line-counts"))).toBe(true);
    const sec = screen.getByTestId("red-line");
    expect(sec.children).toHaveLength(1); // folded: the row and nothing else
    expect(screen.getByTestId("red-line-link").getAttribute("aria-label")).toBe("Memo testers and counts: 0 active testers");
  });
});
