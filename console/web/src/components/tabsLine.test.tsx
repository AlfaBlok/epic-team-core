// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { tabsToFold } from "@/components/tabFold";
import { DefectFold } from "@/components/status";
import { EmptyState } from "@/components/common";
import { decidedByName, onceTitle } from "@/components/waiting";
import { callHead } from "@/pages/Chat";

// the approved polish (round 1 + round 2), built into the console for both skins.

afterEach(cleanup);

describe("T65-S4 tabs on one line", () => {
  const W = [80, 120, 90, 60, 70, 80, 90];
  it("nothing folds while everything fits", () => {
    expect([...tabsToFold(W, 600, 70, 0)]).toEqual([]);
  });
  it("from the right: the first tab that does not fit beside More and every tab after it", () => {
    expect([...tabsToFold(W, 400, 70, 0)].sort()).toEqual([3, 4, 5, 6]);
  });
  it("the open tab never folds, and the strip keeps its order around it", () => {
    const f = tabsToFold(W, 400, 70, 6);
    expect(f.has(6)).toBe(false);
    expect([...f].sort()).toEqual([2, 3, 4, 5]);
  });
  it("reserve keeps room for a More that shows anyway (a campaign's Approvals, Backlog, Definitions)", () => {
    expect([...tabsToFold([100, 100], 220, 60, 0)]).toEqual([]);
    expect([...tabsToFold([100, 100], 220, 60, 0, true)]).toEqual([1]);
  });
});

describe("T65-S4 screen edits", () => {
  it("decided-by names one spelling of the Delivery Manager; a title written twice says it once", () => {
    expect(decidedByName("Delivery-Manager")).toBe("Delivery Manager");
    expect(decidedByName("delivery manager")).toBe("Delivery Manager");
    expect(decidedByName("DeliveryManager")).toBe("Delivery Manager"); // seen live on the production site
    expect(decidedByName("Unblocker")).toBe("Unblocker");
    expect(onceTitle("home_repo · home_repo")).toBe("home_repo");
    expect(onceTitle("Memo launch · PLAN-7")).toBe("Memo launch · PLAN-7");
  });

  it("a call note's head becomes 'Call question' without the emoji and the raw call id", () => {
    expect(callHead("📞 Call question (call_ab12cd-q10)\nWhat is open?")).toEqual({ head: "Call question", rest: "What is open?" });
    expect(callHead("📞 Call feedback (call_x-q2) the tone is off")).toEqual({ head: "Call feedback", rest: "the tone is off" });
    expect(callHead("Call question about pricing")).toBeUndefined();
    expect(callHead("📞 Call with the desk\nRecord only")).toBeUndefined();
  });

  it("a long list of notes for the Delivery Manager shows two, then opens the rest; nothing leaves the page", () => {
    render(<DefectFold>{["a", "b", "c", "d"].map((x) => <div key={x} data-testid="note">{x}</div>)}</DefectFold>);
    const notes = screen.getAllByTestId("note");
    expect(notes).toHaveLength(4);
    expect(notes.map((n) => !!n.closest("[hidden]"))).toEqual([false, false, true, true]);
    const more = screen.getByTestId("defect-more");
    expect(more.textContent).toBe("and 2 more notes for the Delivery Manager");
    fireEvent.click(more);
    expect(screen.getAllByTestId("note").map((n) => !!n.closest("[hidden]"))).toEqual([false, false, false, false]);
    expect(screen.getByTestId("defect-more").textContent).toBe("Show fewer notes");
  });

  it("two notes or fewer show as they are, with no fold", () => {
    render(<DefectFold>{["a", "b"].map((x) => <div key={x}>{x}</div>)}</DefectFold>);
    expect(screen.queryByTestId("defect-more")).toBeNull();
  });

  it("an empty state says its news in a title and one line, with a tick or a clock", () => {
    render(<EmptyState title="Nothing waiting on you" detail="You're clear." />);
    const e = screen.getByTestId("empty-state");
    expect(e.getAttribute("data-tone")).toBe("clear");
    expect(e.textContent).toBe("Nothing waiting on youYou're clear.");
  });
});
