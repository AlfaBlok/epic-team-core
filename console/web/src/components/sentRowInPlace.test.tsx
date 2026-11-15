// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";
import { AfterCloseNote } from "@/components/afterClose";
import { keepPlaces, markSent, resetSent, unmarkSent, useKeepSent } from "@/lib/sentRows";
import { resetClosedNote } from "@/lib/afterClose";

/**
 * (the owner 2026-11-15 06:09Z, vn_e00f1134: "I pasted a key and then I think eventually it saved and then the card
 * disappeared ... I was left in some random place ... maybe the card shrinks into a row that says sent ... mark it as in
 * green ... it's one row ... add comment or something, it stays there"): every answer kind collapses the card in place
 * to one green Sent row with Add comment; the list keeps the row where the card was after the refetch drops the card.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSent();
  resetClosedNote();
});

const ask = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  code: "T9-A1",
  milestoneId: "ms_1",
  milestoneTitle: "Inbox",
  nodeKey: "ms_1/T4",
  repo: "memo",
  path: "docs/spines/root.md",
  title: "Ship it",
  ask: "decide",
  question: "Should the team post twice a day this week?",
  contextLinks: [],
  owner: { kind: "assignment", assignmentId: "as_b", personaName: "Builder", label: "Builder" },
  decidable: true,
  ...over,
});
const wrap = (ui: React.ReactNode) =>
  render(
    <MemoryRouter>
      {ui}
      <AfterCloseNote />
    </MemoryRouter>,
  );
const sentRes = { id: "jr_1", itemId: "wj_1", milestoneId: "ms_1", kind: "answer" as const, text: "Yes", delivery: "sent" as const, createdAt: new Date().toISOString(), spine: { status: "written" as const, sha: "abc1234" } };

describe("vn_e00f1134 keepPlaces: a sent card stays where it was", () => {
  const slot = (s: string) => s;
  it("a sent card the refetch dropped stays after the card that was before it", () => {
    const prev = ["a", "b", "c"].map((s) => ({ slot: s, item: s }));
    expect(keepPlaces(prev, ["a", "c"], slot, (s) => s === "b").map((r) => r.slot)).toEqual(["a", "b", "c"]);
    // the first card: it stays first
    expect(keepPlaces(prev, ["b", "c"], slot, (s) => s === "a").map((r) => r.slot)).toEqual(["a", "b", "c"]);
    // a card that left without being answered here (another device) simply goes
    expect(keepPlaces(prev, ["a", "c"], slot, () => false).map((r) => r.slot)).toEqual(["a", "c"]);
  });
  it("the kept row has no item (the list draws its Sent row), the others keep theirs", () => {
    const prev = ["a", "b"].map((s) => ({ slot: s, item: s }));
    expect(keepPlaces(prev, ["b"], slot, (s) => s === "a")).toEqual([{ slot: "a" }, { slot: "b", item: "b" }]);
  });
  it("useKeepSent: one press that closed several cards (a set) keeps one row; Bring it back drops it", () => {
    let items = ["x", "a", "b", "y"];
    const { result, rerender } = renderHook(() => useKeepSent(items, (s) => `ask:${s}`));
    act(() => void markSent(["ask:a", "ask:b"], { said: "Yes to all 2", title: "The set" }));
    items = ["x", "y"];
    rerender();
    expect(result.current.map((r) => [r.slot, r.sent?.said ?? r.item])).toEqual([
      ["ask:x", "x"],
      ["ask:a", "Yes to all 2"],
      ["ask:y", "y"],
    ]);
    act(() => unmarkSent(["ask:a", "ask:b"]));
    expect(result.current.map((r) => r.slot)).toEqual(["ask:x", "ask:y"]);
  });
});

describe("vn_e00f1134 every answer kind collapses its card to the Sent row", () => {
  it("Yes on a yes or no card: one green Sent row, its question, Add comment files to the same ask", async () => {
    vi.spyOn(api, "respondToWaiting").mockResolvedValue(sentRes);
    const comment = vi.spyOn(api, "commentClosedCard").mockResolvedValue({ sha: "abc1234" });
    wrap(<WaitingCard item={ask()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Yes/ }));
    const row = await screen.findByTestId("sent-row");
    expect(row.getAttribute("data-inbox-card")).toBe("ask:wj_1"); // the page keeps its place: the card never left
    expect(within(row).getByTestId("sent-row-word").className).toContain("text-emerald-700");
    expect(within(row).getByTestId("sent-row-title").textContent).toBe("Should the team post twice a day this week?");
    expect(screen.queryByTestId("waiting-card")).toBeNull();
    expect(screen.queryByTestId("after-close-note")).toBeNull();
    fireEvent.click(within(row).getByTestId("sent-row-comment"));
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "and on Sunday" } });
    fireEvent.click(within(row).getByTestId("sent-row-box-send"));
    await waitFor(() => expect(comment).toHaveBeenCalledWith(expect.objectContaining({ kind: "ask", repo: "memo", path: "docs/spines/root.md", ref: "T9-A1", text: "and on Sunday" })));
  });

  it("Park: the Sent row says Parked for a month; Bring it back shows the card again", async () => {
    vi.spyOn(api, "snoozeWaiting").mockResolvedValue({ id: "wj_1", snoozedUntil: null });
    wrap(<WaitingCard item={ask()} />);
    fireEvent.click(screen.getByTestId("card-park"));
    const row = await screen.findByTestId("sent-row");
    expect(within(row).getByTestId("sent-row-said").textContent).toBe("Parked for a month");
    fireEvent.click(within(row).getByTestId("sent-row-back"));
    expect(await screen.findByTestId("waiting-card")).toBeTruthy();
    expect(screen.queryByTestId("sent-row")).toBeNull();
  });

  it("an answer recorded but not delivered keeps the card, with the reason (never a false Sent)", async () => {
    vi.spyOn(api, "respondToWaiting").mockResolvedValue({ ...sentRes, delivery: "failed", deliveryError: "no one to deliver to", spine: undefined });
    wrap(<WaitingCard item={ask({ source: "needs_jordi", path: undefined })} />);
    fireEvent.click(screen.getByRole("button", { name: /^Yes/ }));
    await waitFor(() => expect(screen.getByText(/Recorded, not delivered: no one to deliver to/)).toBeTruthy());
    expect(screen.queryByTestId("sent-row")).toBeNull();
  });
});
