// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type OwnerResponse, type WaitingItem } from "@/api";
import { OwnerActivityList, WaitingCard } from "@/components/waiting";

/** the owner changes an answer before the owner acts on it. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const resp = (over: Partial<OwnerResponse> = {}): OwnerResponse => ({
  id: "jr_1",
  itemId: "wj_1",
  milestoneId: "ms_1",
  kind: "answer",
  text: "one",
  delivery: "sent",
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  spine: { status: "written", sha: "abc1234", path: "docs/E904.md" },
  ...over,
});

const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_2",
  source: "ask",
  state: "answered",
  who: "Sam",
  code: "T4-A1",
  milestoneId: "ms_1",
  milestoneTitle: "E904",
  nodeKey: "ms_1/T4",
  path: "docs/E904.md",
  title: "Ship with one logger or two?",
  ask: "decide",
  question: "Ship with one logger or two?",
  options: ["one", "two"],
  recommendation: "one",
  answer: "one",
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  decidable: false,
  response: resp(),
  ...over,
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("WaitingCard: Change answer", () => {
  it("answered card: Change answer reopens the controls with the current answer marked; Cancel restores the read view", () => {
    wrap(<WaitingCard item={item()} />);
    expect(screen.getByTestId("answer-state").textContent).toMatch(/Answered, pending work: one/);
    expect(screen.queryByTestId("answer-buttons")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change answer" }));
    expect(screen.queryByTestId("answer-state")).toBeNull();
    expect(screen.getByTestId("changing-answer").textContent).toMatch(/now: “one”.*rewritten in place/);
    // E948-S69: the options are the buttons (the current answer marked), then Cancel
    const buttons = [...screen.getByTestId("answer-buttons").querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["one (current)", "two", "Cancel"]);
    expect(screen.queryByRole("button", { name: "Send to…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("answer-buttons")).toBeNull();
    expect(screen.getByTestId("answer-state").textContent).toMatch(/Answered, pending work: one/);
  });

  it("picking another option calls change on the response (not respond); free text pre-filled for a typed answer", async () => {
    const change = vi.spyOn(api, "changeResponse").mockResolvedValue(resp({ id: "jr_2", text: "two", replacesId: "jr_1", replacedAnswer: "one" }));
    const respond = vi.spyOn(api, "respondToWaiting");
    wrap(<WaitingCard item={item()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change answer" }));
    fireEvent.click(screen.getByRole("button", { name: "two" }));
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith("jr_1", { kind: "answer", text: "two", wake: true }));
    expect(respond).not.toHaveBeenCalled();
    cleanup();

    wrap(<WaitingCard item={item({ answer: "neither, wait", response: resp({ text: "neither, wait" }) })} />);
    fireEvent.click(screen.getByRole("button", { name: "Change answer" }));
    // the typed answer is pre-filled in the note, which travels with the picked option
    const box = screen.getByLabelText("Feedback") as HTMLTextAreaElement;
    expect(box.value).toBe("neither, wait");
    fireEvent.change(box, { target: { value: "after the audit" } });
    fireEvent.click(screen.getByRole("button", { name: "two" }));
    await vi.waitFor(() => expect(change).toHaveBeenLastCalledWith("jr_1", { kind: "answer", text: "two. after the audit", wake: true }));
  });

  it("a refusal (owner already acted) shows the plain reason on the card", async () => {
    vi.spyOn(api, "changeResponse").mockRejectedValue(new Error("the answered line in docs/E904.md is marked done: the owner already acted on the answer; nothing changed"));
    wrap(<WaitingCard item={item()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change answer" }));
    fireEvent.click(screen.getByRole("button", { name: "two" }));
    expect(await screen.findByText(/owner already acted on the answer/)).toBeTruthy();
  });

  it("persona request answered via the thread: Approve / No with the current one marked; warns when the owner ran since", async () => {
    const change = vi.spyOn(api, "changeResponse").mockResolvedValue(resp({ id: "jr_2", kind: "deny", spine: undefined }));
    const nj = item({
      id: "nj_1",
      source: "needs_jordi",
      code: undefined,
      ask: "approve",
      options: undefined,
      recommendation: undefined,
      decidable: true,
      needsJordiId: "nj_1",
      answer: "APPROVED",
      response: resp({ kind: "approve", text: "", spine: undefined, threadId: "th_run", ownerRunSince: new Date(Date.now() - 600_000).toISOString() }),
    });
    wrap(<WaitingCard item={nj} />);
    expect(screen.getByTestId("answer-state").textContent).toMatch(/Sent to the owner's thread/);
    expect(screen.getByTestId("owner-ran").textContent).toMatch(/may already have read the old answer.*written as a correction/);
    fireEvent.click(screen.getByRole("button", { name: "Change answer" }));
    expect(screen.getByRole("button", { name: /Yes: go ahead \(current\)/ })).toBeTruthy();
    expect(screen.getByTestId("changing-answer").textContent).toMatch(/thread gets a correction/);
    // No's first press opens the note (the reason is optional), the next changes the answer to a no
    fireEvent.click(screen.getByTestId("decline"));
    expect(screen.getByLabelText("Feedback")).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("decline"));
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith("jr_1", { kind: "deny", text: "", wake: true }));
  });

  it("no Change answer on done items, in read-only views, or on a persona's decision", () => {
    wrap(<WaitingCard item={item({ state: "done" })} />);
    expect(screen.queryByRole("button", { name: "Change answer" })).toBeNull();
    cleanup();
    wrap(<WaitingCard item={item()} readOnly="Not tracked" />);
    expect(screen.queryByRole("button", { name: "Change answer" })).toBeNull();
    cleanup();
    wrap(<WaitingCard item={item({ decidedBy: "Unblocker" })} />);
    expect(screen.queryByRole("button", { name: "Change answer" })).toBeNull();
  });
});

describe("Activity: a changed answer reads old → new", () => {
  it("shows Changed answer: <old> → <new>", async () => {
    vi.spyOn(api, "listOwnerActivity").mockResolvedValue([
      { type: "response", id: "jr_2", at: new Date().toISOString(), kind: "answer", text: "two", itemTitle: "T4-A1 Decide: Ship?", replacesId: "jr_1", replacedAnswer: "one", delivery: "sent", spine: { status: "written", sha: "def5678" } },
    ]);
    wrap(<OwnerActivityList milestoneId="ms_1" />);
    fireEvent.click(await screen.findByRole("button", { name: /From you/ }));
    expect(screen.getByText("Changed answer: T4-A1 Decide: Ship? — “one” → “two”")).toBeTruthy();
  });
});
