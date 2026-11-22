// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api, type LaptopStep, type LaptopView, type MacTask, type WaitingItem } from "@/api";
import { LaptopSwitch, laptopRows, MacCards } from "@/components/laptopSwitch";
import { openText } from "@/test/openText";

// (the owner on the Team desk: "at the end of the day this has to be a card. I have to be able to provide feedback,
// click done, click feedback, the voice notes, as with a regular card"): every Mac task is a full card; a task with a
// ticket page writes that page's step, so a Done on the card ticks the page and a Done on the page clears the card.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const step = (state: LaptopStep["state"], over: Partial<LaptopStep> = {}): LaptopStep => ({ pageId: "sp_64272444", step: "laptop-run", state, notes: [], ...over });
const task = (row: string, ask: string | undefined, order: number, over: Partial<MacTask> = {}): MacTask => ({
  key: `home_repo#${row}`,
  repo: "home_repo",
  row,
  ...(ask ? { ask } : {}),
  title: `Ticket ${row}`,
  minutes: 15,
  order,
  url: `http://h/t/${row}/`,
  command: `Open the Claude app and paste ${row}`,
  ...over,
});
const ask = (code: string, priority: number, over: Partial<WaitingItem> = {}) =>
  ({ id: `ask:${code}`, code, repo: "home_repo", priority, state: "open", macAgent: true, question: `Ask ${code}`, title: code, contextLinks: [], ...over }) as unknown as WaitingItem;

const e5s9 = task("T5-S9", "PLAN-5-A3", 5, {
  key: "airbnb-observatory#T5-S9",
  repo: "airbnb-observatory",
  title: "Set up the two X accounts",
  step: step("stuck", { words: "nothing was signed up", notes: [{ at: "2026-11-10", words: "both accounts made by Sam" }] }),
});
const e81s8 = task("T81-S8", "T81-A6", 10, { step: { ...step("todo"), pageId: "sp_81" } });

describe("T96-S12 the rows carry their step and their ask", () => {
  it("a ticket's row has its step, row and ask; a done task's ask is no row of its own", () => {
    const mac = [ask("PLAN-5-A3", 1, { repo: "airbnb-observatory", row: "T5-S9" }), ask("T81-A6", 2)];
    const open = laptopRows([e5s9, e81s8], mac);
    expect(open.map((r) => [r.code, r.row, r.step?.state, r.item?.code, r.done])).toEqual([
      ["T5-S9", "T5-S9", "stuck", "PLAN-5-A3", undefined],
      ["T81-S8", "T81-S8", "todo", "T81-A6", undefined],
    ]);
    const after = laptopRows([e81s8], mac, [{ ...e5s9, step: step("done") }]);
    expect(after.map((r) => [r.code, !!r.done])).toEqual([
      ["T5-S9", true],
      ["T81-S8", false],
    ]);
  });
});

describe("T96-S12 the card", () => {
  it("shows the normal controls: Copy the text, Done, Stuck or changes wanted, a note box with no limit, Send the note", () => {
    render(<MacCards rows={laptopRows([e5s9], [])} />);
    const card = screen.getByTestId("laptop-card");
    expect(within(card).getByTestId("laptop-state").textContent).toBe("Stuck");
    expect(within(card).getByTestId("laptop-stuck-words").textContent).toContain("nothing was signed up");
    expect(within(card).getByTestId("laptop-notes").textContent).toContain("both accounts made by Sam");
    expect(within(card).getByTestId("laptop-copy").textContent).toContain("Copy the text");
    expect(within(card).getByTestId("laptop-done").textContent).toContain("Done");
    expect(within(card).getByTestId("laptop-stuck").textContent).toContain("Stuck or changes wanted");
    openText();
    const box = card.querySelector("textarea")!;
    expect(box.getAttribute("maxlength")).toBeNull();
    expect((within(card).getByTestId("laptop-send-note") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Done writes the ticket page's step with his words; the card becomes its green Sent row and Bring it back sets it not done (E948-S130)", async () => {
    const tick = vi.spyOn(api, "stepTick").mockResolvedValue({ state: "done", spine: "saved" });
    const { rerender } = render(<MacCards rows={laptopRows([e5s9], [])} />);
    openText();
    fireEvent.change(screen.getByTestId("laptop-card").querySelector("textarea")!, { target: { value: "both made: @TowerwatchHQ and @YieldDesk_data" } });
    fireEvent.click(screen.getByTestId("laptop-done"));
    await waitFor(() =>
      expect(tick).toHaveBeenCalledWith("sp_64272444", { step: "laptop-run", title: "Set up the two X accounts", row: "T5-S9", state: "done", comment: "both made: @TowerwatchHQ and @YieldDesk_data" }),
    );
    // the refresh: the task is done (out of the list), the card he pressed stays as its Sent row
    rerender(<MacCards rows={laptopRows([], [], [{ ...e5s9, step: step("done", { change: { status: "saved", at: "x", wake: "none" } }) }])} />);
    await waitFor(() => expect(screen.getByTestId("sent-row-said").textContent).toBe("Done"));
    expect(screen.getByTestId("sent-row-comment")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sent-row-back"));
    await waitFor(() => expect(tick).toHaveBeenLastCalledWith("sp_64272444", expect.objectContaining({ state: "todo" })));
  });

  it("a Done on the page (not pressed here) clears the card", () => {
    render(<MacCards rows={laptopRows([e81s8], [], [{ ...e5s9, step: step("done") }])} />);
    expect(screen.getAllByTestId("laptop-task").map((x) => x.dataset.state)).toEqual(["todo"]);
  });

  it("Stuck and a note: the state and his words; a note alone changes no state; each collapses the card (E948-S130)", async () => {
    const tick = vi.spyOn(api, "stepTick").mockResolvedValue({ state: "stuck", spine: "saved" });
    render(<MacCards rows={laptopRows([e81s8], [])} />);
    openText();
    fireEvent.change(screen.getByTestId("laptop-card").querySelector("textarea")!, { target: { value: "Stripe asked for a phone code" } });
    fireEvent.click(screen.getByTestId("laptop-stuck"));
    await waitFor(() => expect(tick).toHaveBeenCalledWith("sp_81", expect.objectContaining({ state: "stuck", comment: "Stripe asked for a phone code", row: "T81-S8" })));
    await waitFor(() => expect(screen.getByTestId("sent-row-said").textContent).toBe("Stuck sent to the team"));
    // Bring it back: the card again, its box empty, and a note alone changes no state
    fireEvent.click(screen.getByTestId("sent-row-back"));
    openText(await screen.findByTestId("laptop-card"));
    const box = (await screen.findByTestId("laptop-card")).querySelector("textarea")!;
    expect(box.value).toBe("");
    fireEvent.change(box, { target: { value: "x".repeat(5000) } });
    await waitFor(() => expect((screen.getByTestId("laptop-send-note") as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
    fireEvent.click(screen.getByTestId("laptop-send-note"));
    await waitFor(() => expect(tick).toHaveBeenCalledTimes(2));
    expect(tick.mock.calls[1][1]).not.toHaveProperty("state");
    expect(tick.mock.calls[1][1].comment).toHaveLength(5000);
    await waitFor(() => expect(screen.getByTestId("sent-row-said").textContent).toBe("Your words went to the team"));
  });

  it("Stuck or changes wanted is never greyed out, even on a step already stuck; a bare press wakes the team", async () => {
    const tick = vi.spyOn(api, "stepTick").mockResolvedValue({ state: "stuck", spine: "saved" });
    render(<MacCards rows={laptopRows([e5s9], [])} />);
    const btn = screen.getByTestId("laptop-stuck") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect((screen.getByTestId("laptop-done") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(tick).toHaveBeenCalledWith("sp_64272444", expect.objectContaining({ state: "stuck", row: "T5-S9", comment: expect.stringContaining("Pressed Stuck again") })));
  });

  it("a refused press says why at the buttons", async () => {
    vi.spyOn(api, "stepTick").mockRejectedValue(new Error("too many ticks on this page in a minute: wait a moment"));
    render(<MacCards rows={laptopRows([e81s8], [])} />);
    fireEvent.click(screen.getByTestId("laptop-done"));
    await waitFor(() => expect(screen.getByTestId("laptop-error").textContent).toContain("too many ticks"));
  });

  it("a task with no ticket page is its ask's own card; with neither, a row with its text", () => {
    const mac = [ask("T92-A3", 1, { question: "Switch on one Google admin setting" })];
    render(<MacCards rows={laptopRows([task("T94-S5", undefined, 3)], mac)} askCard={(i) => <div data-testid="ask-card">{i.code}</div>} />);
    expect(screen.getByTestId("ask-card").textContent).toBe("T92-A3");
    expect(screen.getAllByTestId("laptop-task").map((x) => x.dataset.state)).toEqual(["none", "none"]);
  });
});

describe("T96-S12 the laptop list counts what is still open", () => {
  it("on: a done task is out of the count and the list", () => {
    const view: LaptopView = { session: { id: "l", since: "x", until: null, by: "Sam" }, tasks: [e81s8], done: [{ ...e5s9, step: step("done") }], listUrl: "http://h/mac/" };
    render(<LaptopSwitch view={view} mac={[]} listUrl="http://h/mac/" />);
    expect(screen.getByTestId("laptop-summary").textContent).toContain("1 task for Claude on your Mac");
    expect(screen.getAllByTestId("laptop-card")).toHaveLength(1);
  });
});
