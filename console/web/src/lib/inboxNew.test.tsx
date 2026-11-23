// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import { invalidate, useQuery, useSharedQuery } from "@/lib/data";
import { holdInbox, resetInboxHold } from "@/lib/inboxHold";
import { cardIds, gateAnswer, gateNewCards, newCardCount, resetNewCards, showNewCards, withoutCards } from "@/lib/inboxNew";
import { InboxNewLine } from "@/components/InboxNewLine";

/**
 * The owner, vn_a63d5805: "when I close it, the page has moved under me because maybe new cards showed up"):
 * while the Inbox is open, cards that arrive (a poll, a push) wait behind a quiet "N new" line; the cards he reads, his
 * typed answer stay as they are until he taps it. The menu's pill (outside the page) may already count it.
 */
afterEach(() => {
  cleanup();
  resetInboxHold();
  resetNewCards();
  sessionStorage.clear();
});
beforeEach(() => resetNewCards());

let server: { id: string; t: string }[] = [];
let counts = { review: 0 };
const order = () => screen.queryAllByTestId("item").map((e) => e.textContent);

function SharedList() {
  const { data } = useSharedQuery<{ id: string; t: string }[]>("new-list", () => Promise.resolve(server.map((x) => ({ ...x }))), { tag: "inbox" });
  return <ul>{data?.map((x) => <li key={x.id} data-testid="item">{x.t}</li>)}</ul>;
}
function OwnList() {
  // a list one level down ({cards: [...]}) read by useQuery, as Ideas and digests is
  const { data } = useQuery(() => Promise.resolve({ cards: server.map((x) => ({ ...x })) }), [], { tag: "inbox" });
  return <ol>{data?.cards.map((x) => <li key={x.id} data-testid="own">{x.t}</li>)}</ol>;
}
/** the menu's pill: outside the page, so it may count the new card at once */
function Count() {
  const { data } = useQuery(() => Promise.resolve({ ...counts }), [], { tag: "counts" });
  return <span data-testid="count">{data?.review}</span>;
}
function Box() {
  const [typed, setTyped] = useState("");
  return <textarea aria-label="answer" value={typed} onChange={(e) => setTyped(e.target.value)} />;
}
const page = (visit = "v1", entries: { pathname: string; key?: string }[] = [{ pathname: "/inbox" }]) =>
  render(
    <MemoryRouter initialEntries={entries}>
      <InboxNewLine visit={visit} />
      <SharedList />
      <OwnList />
      <Count />
      <Box />
    </MemoryRouter>,
  );
const arrive = async () => {
  await act(async () => {
    invalidate("inbox", "background");
    await new Promise((r) => setTimeout(r, 5));
  });
};

describe("new cards never move the card he reads", () => {
  it("a card arriving on top waits behind 'N new'; the lists and his typed answer stay; his tap shows it", async () => {
    server = [
      { id: "a", t: "A" },
      { id: "b", t: "B" },
    ];
    counts = { review: 2 };
    page();
    await waitFor(() => expect(order()).toEqual(["A", "B"]));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    fireEvent.change(screen.getByLabelText("answer"), { target: { value: "half an answer" } });
    expect(screen.queryByTestId("inbox-new-line")).toBeNull();

    // a poll brings a new card above B, and B's text changed
    server = [
      { id: "new", t: "NEW" },
      { id: "a", t: "A" },
      { id: "b", t: "B" },
    ];
    counts = { review: 3 };
    await arrive();
    expect(order()).toEqual(["A", "B"]);
    expect(screen.queryAllByTestId("own").map((e) => e.textContent)).toEqual(["A", "B"]);
    expect(screen.getByTestId("count").textContent).toBe("3");
    expect(screen.getByTestId("inbox-new-show").textContent).toBe("1 new");
    expect((screen.getByLabelText("answer") as HTMLTextAreaElement).value).toBe("half an answer");

    // a second arrival: still nothing moves, the line counts both once
    server = [{ id: "new2", t: "NEW2" }, ...server];
    counts = { review: 4 };
    await arrive();
    expect(order()).toEqual(["A", "B"]);
    expect(screen.getByTestId("inbox-new-show").textContent).toBe("2 new");

    fireEvent.click(screen.getByTestId("inbox-new-show"));
    await waitFor(() => expect(order()).toEqual(["NEW2", "NEW", "A", "B"]));
    expect(screen.queryAllByTestId("own").map((e) => e.textContent)).toEqual(["NEW2", "NEW", "A", "B"]);
    expect(screen.getByTestId("count").textContent).toBe("4");
    expect(screen.queryByTestId("inbox-new-line")).toBeNull();
    expect((screen.getByLabelText("answer") as HTMLTextAreaElement).value).toBe("half an answer");
  });

  it("what he does himself shows at once, and a change to cards he already sees applies", async () => {
    server = [{ id: "a", t: "A" }];
    page();
    await waitFor(() => expect(order()).toEqual(["A"]));
    server = [{ id: "a", t: "A answered" }];
    await arrive();
    expect(order()).toEqual(["A answered"]);
    expect(newCardCount()).toBe(0);
    server = [{ id: "follow", t: "FOLLOW" }, ...server];
    await act(async () => {
      invalidate("inbox"); // his own answer or snooze
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(order()).toEqual(["FOLLOW", "A answered"]);
  });

  it("while a card box holds the inbox, a new card still gets the line, and waits for his tap after he sends", async () => {
    server = [{ id: "a", t: "A" }];
    page();
    await waitFor(() => expect(order()).toEqual(["A"]));
    const release = holdInbox("card:a");
    server = [{ id: "n", t: "N" }, ...server];
    await arrive();
    expect(order()).toEqual(["A"]);
    // the line shows while he still types; sending lets the hold go and the new card still waits for his tap
    expect(screen.getByTestId("inbox-new-show").textContent).toBe("1 new");
    act(() => release());
    expect(order()).toEqual(["A"]);
    expect(screen.getByTestId("inbox-new-show").textContent).toBe("1 new");
    fireEvent.click(screen.getByTestId("inbox-new-show"));
    await waitFor(() => expect(order()).toEqual(["N", "A"]));
  });

  it("Back to the same visit shows the cards he had seen; one that came meanwhile waits behind the line", async () => {
    server = [{ id: "a", t: "A" }];
    const first = page("visit-1", [{ pathname: "/inbox", key: "visit-1" }]);
    await waitFor(() => expect(order()).toEqual(["A"]));
    first.unmount();
    resetInboxHold();
    // away on a card's link; a card arrives
    server = [{ id: "n", t: "N" }, ...server];
    // MemoryRouter's first entry is a POP, as Back is
    page("visit-1", [{ pathname: "/inbox", key: "visit-1" }]);
    await waitFor(() => expect(screen.getByTestId("inbox-new-show").textContent).toBe("1 new"));
    expect(order()).toEqual(["A"]);
    fireEvent.click(screen.getByTestId("inbox-new-show"));
    await waitFor(() => expect(order()).toEqual(["N", "A"]));
  });

  it("a list the menu read before the Inbox opened counts only the cards that really arrived", async () => {
    server = [
      { id: "a", t: "A" },
      { id: "b", t: "B" },
    ];
    // the menu reads the list on another page first (no gate)
    render(<SharedList />);
    await waitFor(() => expect(order()).toEqual(["A", "B"]));
    // then he opens the Inbox: the same list, now gated
    render(
      <MemoryRouter>
        <InboxNewLine visit="v2" />
      </MemoryRouter>,
    );
    server = [{ id: "n", t: "N" }, ...server];
    await arrive();
    expect(screen.getByTestId("inbox-new-show").textContent).toBe("1 new");
    expect(order()).toEqual(["A", "B"]);
    fireEvent.click(screen.getByTestId("inbox-new-show"));
    await waitFor(() => expect(order()).toEqual(["N", "A", "B"]));
    await arrive();
    expect(screen.queryByTestId("inbox-new-line")).toBeNull();
  });

  it("his tap keeps the card at the top of his screen where it was, not the sticky heading", async () => {
    const off = gateNewCards("place", false);
    document.body.innerHTML = '<header data-testid="topbar"></header><section data-fold-section><div data-inbox-card="review:a"></div></section>';
    const card = document.querySelector("[data-inbox-card]")!;
    let top = 300;
    document.querySelector("header")!.getBoundingClientRect = () => ({ top: 0, bottom: 52, height: 52 }) as DOMRect;
    document.querySelector("section")!.getBoundingClientRect = () => ({ top: top - 40, bottom: top + 600, height: 640 }) as DOMRect;
    card.getBoundingClientRect = () => ({ top, bottom: top + 200, height: 200 }) as DOMRect;
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(((_x: number, y: number) => void (top -= y)) as never);
    gateAnswer({}, [{ id: "a" }], "first", "inbox", () => undefined);
    // a new card waits; showing it draws 380 px above the card he reads
    expect(gateAnswer({}, [{ id: "n" }, { id: "a" }], "background", "inbox", () => void (top += 380))).toBe("park");
    showNewCards();
    await new Promise((r) => setTimeout(r, 80));
    expect(scrollBy).toHaveBeenCalledWith(0, 380);
    expect(top).toBe(300);
    scrollBy.mockRestore();
    off();
  });

  it("leaving the Inbox lets go: nothing is held on other pages", async () => {
    const off = gateNewCards("x", false);
    off();
    server = [{ id: "a", t: "A" }];
    render(<SharedList />);
    await waitFor(() => expect(order()).toEqual(["A"]));
    server = [{ id: "n", t: "N" }, ...server];
    await arrive();
    expect(order()).toEqual(["N", "A"]);
  });

  it("reads card ids from a list or from lists one level down, and hides only the waiting ones", () => {
    expect(cardIds([{ id: "a" }, { x: 1 }])).toEqual(["a"]);
    expect(cardIds({ cards: [{ id: "a" }], goals: [{ id: "g" }], n: 2 })).toEqual(["a", "g"]);
    expect(cardIds({ review: 3 })).toEqual([]);
    expect(withoutCards({ cards: [{ id: "a" }, { id: "b" }], n: 2 }, new Set(["a"]))).toEqual({ cards: [{ id: "b" }], n: 2 });
  });
});
