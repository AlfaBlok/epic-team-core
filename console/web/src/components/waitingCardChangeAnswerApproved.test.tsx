// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type OwnerResponse, type WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";

/**
 * the owner pressed Change answer on an approve ask he had approved and every press was refused. Now the card offers
 * Approve (current) and No (the note goes with No as a deny); an older feedback answer still reads as changes.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const resp = (over: Partial<OwnerResponse> = {}): OwnerResponse => ({
  id: "jr_1",
  itemId: "wj_1",
  milestoneId: "ms_1",
  kind: "approve",
  text: "",
  delivery: "sent",
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  spine: { status: "written", sha: "abc1234", path: "docs/E911.md" },
  ...over,
});

const approved = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_2",
  source: "ask",
  state: "answered",
  who: "Sam",
  code: "PLAN-11-A6",
  milestoneId: "ms_1",
  milestoneTitle: "PLAN-11",
  nodeKey: "ms_1/PLAN-11",
  path: "docs/E911.md",
  title: "Approve the plan?",
  ask: "approve",
  question: "Approve the plan?",
  answer: "APPROVED",
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  decidable: false,
  response: resp(),
  ...over,
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("WaitingCard: Change answer on an approved ask", () => {
  // ask cards have no Changes wanted any more; an approval is changed to a "No" whose note carries his words.
  it("offers Approve (current) and No; No's note goes with the change as a deny", async () => {
    const change = vi.spyOn(api, "changeResponse").mockResolvedValue(
      resp({ id: "jr_2", kind: "deny", text: "smaller first step", replacesId: "jr_1", delivery: "queued", spine: undefined, job: { state: "pending", attempts: 0 } }),
    );
    wrap(<WaitingCard item={approved()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change answer" }));
    expect(screen.getByTestId("changing-answer").textContent).toMatch(/now: approved\).*rewritten in place/);
    expect(screen.getByRole("button", { name: /Yes: go ahead \(current\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Change to this/ })).toBeNull(); // no plain answer box
    expect(screen.queryByTestId("changes-wanted")).toBeNull();
    fireEvent.click(screen.getByTestId("decline"));
    fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "smaller first step" } });
    fireEvent.click(screen.getByTestId("decline"));
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith("jr_1", { kind: "deny", text: "smaller first step", wake: true }));
    // stored and written by its job: no "not delivered" error on the card
    expect(screen.queryByText(/not delivered/)).toBeNull();
  });

  it("an approval changed to Changes wanted reads as changes at once, before the spine view has the [feedback] line", () => {
    wrap(<WaitingCard item={approved({ response: resp({ id: "jr_2", kind: "feedback", text: "smaller first step", replacesId: "jr_1", replacedAnswer: "APPROVED" }) })} />);
    expect(screen.getByTestId("answer-state").textContent).toMatch(/^You asked for changes: smaller first step\. This is not an approval\./);
    expect(screen.queryByRole("button", { name: "Change answer" })).toBeNull();
  });

  it("an answer that was feedback cannot be changed: no Change answer button", () => {
    wrap(<WaitingCard item={approved({ feedback: true, answer: "simpler", response: resp({ kind: "feedback", text: "simpler" }) })} />);
    expect(screen.queryByRole("button", { name: "Change answer" })).toBeNull();
  });
});
