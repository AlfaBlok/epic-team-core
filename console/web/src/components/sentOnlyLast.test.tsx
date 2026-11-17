// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SentOr } from "@/components/sentRow";
import { FoldSection } from "@/components/homeSection";
import { answeredHere, dismissSent, markSent, resetSent, sentOf, useKeepSent } from "@/lib/sentRows";

/**
 * E948-S140 (the owner 17 Nov 21:39Z: "I just want to see the last one that was done. I don't want to see 20 cards
 * parked."): only the newest answered card keeps its green Sent row; answering the next takes the earlier row off the
 * page, its card stays answered. E948-S145 (vn_a95bfbab): a Sent row closes with its x (swipe on the phone), and an open
 * section's heading sticks under the top bar.
 */
// jsdom has no PointerEvent: a MouseEvent that carries the pointer's id and kind
if (typeof window !== "undefined" && !("PointerEvent" in window)) {
  class PE extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  (window as unknown as { PointerEvent: typeof PE }).PointerEvent = PE;
}

afterEach(() => {
  cleanup();
  resetSent();
});

const three = () => (
  <MemoryRouter>
    {["ask:a", "ask:b", "ask:c"].map((s) => (
      <SentOr key={s} slot={s}>
        <div data-testid={`card-${s}`}>card {s}</div>
      </SentOr>
    ))}
  </MemoryRouter>
);

describe("only the last answered card stays as a Sent row", () => {
  it("answering the next card takes the earlier Sent row away, and the earlier card stays answered", () => {
    render(three());
    act(() => void markSent("ask:a", { said: "Approved", title: "First" }));
    expect(screen.getAllByTestId("sent-row")).toHaveLength(1);
    act(() => void markSent("ask:b", { said: "Parked", title: "Second" }));
    const rows = screen.getAllByTestId("sent-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Second");
    // the first card does not come back as a card: it is still answered, only its row left
    expect(screen.queryByTestId("card-ask:a")).toBeNull();
    expect(answeredHere("a")).toBe(true);
    expect(screen.getByTestId("card-ask:c")).toBeTruthy();
  });

  it("50 answers leave one Sent row", () => {
    const slots = Array.from({ length: 50 }, (_, i) => `ask:n${i}`);
    render(
      <MemoryRouter>
        {slots.map((s) => (
          <SentOr key={s} slot={s}>
            <div>card</div>
          </SentOr>
        ))}
      </MemoryRouter>,
    );
    act(() => slots.forEach((s, i) => markSent(s, { said: "Done", title: `Card ${i}` })));
    const rows = screen.getAllByTestId("sent-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Card 49");
  });

  it("a list drops the earlier Sent row and never shows its card again", () => {
    const { result, rerender } = renderHook(({ items }) => useKeepSent(items, (s: string) => s, "t-list"), { initialProps: { items: ["x", "y", "z"] } });
    act(() => void markSent("x", { said: "Done", title: "X" }));
    rerender({ items: ["y", "z"] });
    expect(result.current.map((r) => r.slot)).toEqual(["x", "y", "z"]);
    act(() => void markSent("y", { said: "Done", title: "Y" }));
    // the server still lists y for a moment: y is its Sent row, x is gone
    rerender({ items: ["y", "z"] });
    expect(result.current.map((r) => [r.slot, !!r.sent])).toEqual([
      ["y", true],
      ["z", false],
    ]);
  });
});

describe("a Sent row closes with its x", () => {
  it("the x takes the row away and the card stays answered", () => {
    render(three());
    act(() => void markSent("ask:a", { said: "Approved", title: "First" }));
    fireEvent.click(screen.getByTestId("sent-row-close"));
    expect(screen.queryByTestId("sent-row")).toBeNull();
    expect(screen.queryByTestId("card-ask:a")).toBeNull();
    expect(sentOf("ask:a")?.gone).toBe(true);
  });

  it("a set answered by one press goes as one", () => {
    act(() => void markSent(["ask:a", "ask:b"], { said: "Yes to all 2", title: "Set" }));
    act(() => dismissSent("ask:b"));
    expect(sentOf("ask:a")?.gone).toBe(true);
  });

  it("a sideways swipe takes the row away on the phone", async () => {
    render(three());
    act(() => void markSent("ask:a", { said: "Approved", title: "First" }));
    const row = screen.getByTestId("sent-row");
    const p = { pointerId: 1, pointerType: "touch" };
    fireEvent.pointerDown(row, { ...p, clientX: 20, clientY: 100 });
    fireEvent.pointerMove(row, { ...p, clientX: 60, clientY: 102 });
    fireEvent.pointerMove(row, { ...p, clientX: 200, clientY: 103 });
    fireEvent.pointerUp(row, p);
    await act(() => new Promise((r) => setTimeout(r, 250)));
    expect(screen.queryByTestId("sent-row")).toBeNull();
  });
});

describe("an open section's heading sticks", () => {
  it("is sticky on every inbox section (a folded one is its header line alone, so it never moves), plain on a fixed list", () => {
    const { rerender } = render(
      <FoldSection title="Blocked on you" count={3} testId="s" open onToggle={() => {}}>
        <div />
      </FoldSection>,
    );
    const head = () => screen.getByTestId("s").querySelector("[data-fold-header]")!;
    expect(head().className).toContain("sticky");
    expect(head().hasAttribute("data-sticky")).toBe(true);
    rerender(
      <FoldSection title="A list" count={3} testId="s">
        <div />
      </FoldSection>,
    );
    expect(head().className).not.toContain("sticky");
  });
});
