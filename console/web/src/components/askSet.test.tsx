// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api, type WaitingItem } from "@/api";
import { AskSet, askSets, setLine, setWhy } from "@/components/askSet";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// a persona's set of recommendations: Accept all, or accept one, ask a question back, say no.
const rec = (code: string, over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: `wj_${code}`,
  code,
  source: "ask",
  state: "open",
  who: "Sam",
  milestoneId: "ms_1",
  milestoneTitle: "home_repo",
  nodeKey: "ms_1",
  path: "docs/spines/root.md",
  title: code,
  ask: "approve",
  question: `You approve: thing ${code}?`,
  contextText: `Why: it helps ${code}. More words follow here.`,
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager" },
  asker: { assignmentId: "as_2", personaId: "p_2", personaName: "Advisor", via: "ask" },
  since: "2026-11-11T02:30:00Z",
  decidable: false,
  ...over,
} as WaitingItem);

describe("askSets", () => {
  it("groups two or more open approve asks one persona wrote; leaves the rest", () => {
    const a = rec("ROOT-A1");
    const b = rec("ROOT-A2");
    const lone = rec("T9-A1", { asker: { assignmentId: "as_3", personaName: "Publisher", via: "ask" } });
    const owner = rec("T9-A2", { asker: { assignmentId: "as_1", personaName: "Delivery Manager", via: "owner" } });
    const decide = rec("T9-A3", { ask: "decide" });
    const answered = rec("T9-A4", { response: { id: "jr_1", kind: "approve" } as WaitingItem["response"] });
    const sets = askSets([a, lone, owner, b, decide]);
    expect(sets).toEqual([{ persona: "Advisor", items: [a, b] }]);
    // one he just answered here stays in its set (the list refreshed under his presses), its row says what he pressed
    expect(askSets([a, answered, b])).toEqual([{ persona: "Advisor", items: [a, answered, b] }]);
    // an answer typed as words (not one of the set's buttons) takes it out
    expect(askSets([a, rec("T9-A5", { response: { id: "jr_2", kind: "answer" } as WaitingItem["response"] })])).toEqual([]);
  });
  it("one line: what he approves, then why", () => {
    expect(setLine(rec("ROOT-A1"))).toBe("Thing ROOT-A1");
    expect(setWhy(rec("ROOT-A1", { question: "You approve: a weekly tester mail — Why: testers come back each week." }))).toBe("Testers come back each week.");
  });
});

describe("AskSet", () => {
  it("rows answered already (the list refreshed, or another device) show what was pressed; Accept all counts the rest", () => {
    const items = [rec("ROOT-A1", { response: { id: "jr_1", kind: "approve" } as WaitingItem["response"] }), rec("ROOT-A2", { response: { id: "jr_2", kind: "deny" } as WaitingItem["response"] }), rec("ROOT-A3")];
    render(<AskSet group={{ persona: "Advisor", items }} />);
    expect(screen.getAllByTestId("ask-set-done").map((d) => d.textContent)).toEqual(["✓ Accepted: it becomes a ready row", "✗ Said no"]);
    expect(screen.getByTestId("accept-all").textContent).toMatch(/Yes to all 1: make them tasks$/);
  });
  it("Accept all approves every one with asRow, in order, and says each becomes a ready row", async () => {
    const calls: unknown[] = [];
    vi.spyOn(api, "respondToWaiting").mockImplementation(async (id, input) => (calls.push([id, input]), { id: `jr_${id}` }) as never);
    const items = [rec("ROOT-A1"), rec("ROOT-A2"), rec("ROOT-A3")];
    render(<AskSet group={{ persona: "Advisor", items }} />);
    expect(screen.getByRole("heading").textContent).toBe("The Advisor's 3 recommendations"); // E948-S52: the card family
    expect(screen.getAllByTestId("ask-set-row").map((r) => r.querySelector("p")!.textContent)).toEqual(["Thing ROOT-A1", "Thing ROOT-A2", "Thing ROOT-A3"]);
    fireEvent.click(screen.getByTestId("accept-all"));
    // vn_e00f1134: every one taken, the set collapses in place to one green Sent row with Add comment
    await waitFor(() => expect(screen.getByTestId("sent-row-said").textContent).toBe("Yes to all 3"));
    expect(calls).toEqual(items.map((i) => [i.id, expect.objectContaining({ kind: "approve", asRow: true, wake: true, milestoneId: "ms_1" })]));
    expect(screen.getByTestId("sent-row-title").textContent).toBe("The Advisor's 3 recommendations");
    expect(screen.getByTestId("sent-row-comment")).toBeTruthy();
    expect(screen.queryByTestId("accept-all")).toBeNull();
  });
  it("one row: Accept, Ask a question (feedback, needs words), No (deny); a failed one says so and stays in Accept all", async () => {
    const calls: [string, { kind: string; text?: string; asRow?: boolean }][] = [];
    vi.spyOn(api, "respondToWaiting").mockImplementation(async (id, input) => {
      if (id === "wj_ROOT-A3") throw new Error("the spine changed");
      calls.push([id, input]);
      return { id: "jr" } as never;
    });
    render(<AskSet group={{ persona: "Advisor", items: [rec("ROOT-A1"), rec("ROOT-A2"), rec("ROOT-A3")] }} />);
    const rows = () => screen.getAllByTestId("ask-set-row");
    fireEvent.click(within(rows()[0]).getByTestId("ask-set-accept"));
    await waitFor(() => expect(within(rows()[0]).getByTestId("ask-set-done")).toBeTruthy());
    fireEvent.click(within(rows()[1]).getByTestId("ask-set-ask"));
    expect((within(rows()[1]).getByTestId("ask-set-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(rows()[1]).getByTestId("ask-set-words"), { target: { value: "for which product?" } });
    fireEvent.click(within(rows()[1]).getByTestId("ask-set-send"));
    await waitFor(() => expect(within(rows()[1]).getByTestId("ask-set-done").textContent).toBe("? Question sent to Advisor"));
    fireEvent.click(within(rows()[2]).getByTestId("ask-set-no"));
    fireEvent.click(within(rows()[2]).getByTestId("ask-set-send"));
    await waitFor(() => expect(within(rows()[2]).getByTestId("ask-set-error").textContent).toBe("Not sent: the spine changed"));
    expect(calls).toEqual([
      ["wj_ROOT-A1", expect.objectContaining({ kind: "approve", asRow: true })],
      ["wj_ROOT-A2", expect.objectContaining({ kind: "feedback", text: "for which product?" })],
    ]);
    expect(screen.getByTestId("accept-all").textContent).toMatch(/Yes to all 1: make them tasks$/);
  });

  // E948-S127: his 20:29Z note (vn_7f478843) on this card was saved as feedback only and the card came back open.
  const NOTE = "So the first one, OK, the second one, no, I don't want to raise the limit. The third one, yes. Did you apply to OVH without my consent?";
  const say = (words: string) => {
    const box = screen.getByTestId("card-feedback-box");
    fireEvent.change(within(box).getByLabelText("Feedback"), { target: { value: words } });
    fireEvent.click(screen.getByTestId("card-feedback-send"));
  };
  it("his words in the box answer each ask, pressed as its button; the card collapses to one Sent row; the rest goes to the desk", async () => {
    const calls: [string, { kind: string; text?: string; asRow?: boolean }][] = [];
    vi.spyOn(api, "respondToWaiting").mockImplementation(async (id, input) => (calls.push([id, input as never]), { id: `jr_${id}` }) as never);
    const read = vi.spyOn(api, "readSpokenAnswers").mockResolvedValue({
      reads: [
        { id: "wj_ROOT-A1", kind: "approve", quote: "the first one, OK,", how: "order" },
        { id: "wj_ROOT-A2", kind: "deny", quote: "the second one, no, I don't want to raise the limit.", how: "order" },
        { id: "wj_ROOT-A3", kind: "approve", quote: "The third one, yes.", how: "order" },
      ],
    });
    const desk = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "t", pending: false });
    render(<AskSet group={{ persona: "Delivery Manager", items: [rec("ROOT-A1"), rec("ROOT-A2"), rec("ROOT-A3")] }} />);
    say(NOTE);
    await waitFor(() => expect(screen.getByTestId("sent-row-said").textContent).toBe("Yes, no, yes"));
    expect(read).toHaveBeenCalledWith(NOTE, [expect.objectContaining({ id: "wj_ROOT-A1", code: "ROOT-A1", line: "Thing ROOT-A1" }), expect.anything(), expect.anything()]);
    expect(calls.map(([id, i]) => [id, i.kind, i.asRow ?? false])).toEqual([
      ["wj_ROOT-A1", "approve", true],
      ["wj_ROOT-A2", "deny", false],
      ["wj_ROOT-A3", "approve", true],
    ]);
    expect(calls[1][1].text).toBe("the second one, no, I don't want to raise the limit.");
    const [text] = desk.mock.calls[0];
    expect(text).toContain(NOTE);
    expect(text).toContain("The card took these as his answers (pressed as its buttons): ROOT-A1 yes, ROOT-A2 no, ROOT-A3 yes.");
  });
  it("a part that is not plain is never pressed and never dropped: the desk asks him one open question", async () => {
    const calls: string[] = [];
    vi.spyOn(api, "respondToWaiting").mockImplementation(async (id) => (calls.push(id), { id: `jr_${id}` }) as never);
    vi.spyOn(api, "readSpokenAnswers").mockResolvedValue({
      reads: [
        { id: "wj_ROOT-A1", kind: "approve", quote: "the first one, yes", how: "order" },
        { id: "wj_ROOT-A2", kind: "unclear", quote: "the second one, maybe later", how: "order" },
      ],
    });
    const desk = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "t", pending: false });
    render(<AskSet group={{ persona: "Advisor", items: [rec("ROOT-A1"), rec("ROOT-A2")] }} />);
    say("the first one, yes, the second one, maybe later");
    await waitFor(() => expect(screen.getByTestId("ask-set-said").textContent).toBe("Took 1 of 2 as your answers. The desk asks you about the rest."));
    expect(calls).toEqual(["wj_ROOT-A1"]);
    expect(desk.mock.calls[0][0]).toContain('Not plain which answer he gave on ROOT-A2 "Thing ROOT-A2": ask him one open question, never guess.');
    // the answered row says so; the unclear one keeps its buttons
    expect(screen.getAllByTestId("ask-set-done").map((d) => d.textContent)).toEqual(["✓ Accepted: it becomes a ready row"]);
    expect(screen.getByTestId("ask-set").textContent).toContain("Yes to all 1");
  });
  it("words that answer nothing still reach the desk, and the card says the asks stay open", async () => {
    const respond = vi.spyOn(api, "respondToWaiting");
    vi.spyOn(api, "readSpokenAnswers").mockResolvedValue({ reads: [{ id: "wj_ROOT-A1", kind: "none" }, { id: "wj_ROOT-A2", kind: "none" }] });
    const desk = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "t", pending: false });
    render(<AskSet group={{ persona: "Advisor", items: [rec("ROOT-A1"), rec("ROOT-A2")] }} />);
    say("what does the second one cost?");
    await waitFor(() => expect(screen.getByTestId("ask-set-said").textContent).toMatch(/stay open/));
    expect(respond).not.toHaveBeenCalled();
    expect(desk.mock.calls[0][0]).toMatch(/what does the second one cost\?$/);
  });
});

