// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type PriorityModeView } from "@/api";
import { LONG_PRESS_MS, PriorityLongPress, PriorityModeChip, PriorityModePage, rowAt } from "@/components/priorityShortcut";

// jsdom has no PointerEvent: a MouseEvent carries the coordinates the drag check reads.
if (!("PointerEvent" in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {};

/** priority mode one tap away on the phone: the /priority page and a long-press on a card with a row code. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const OFF: PriorityModeView = { on: false, parked: [], log: [], focusRunning: [] };

function Board() {
  return (
    <>
      <PriorityLongPress />
      <a href="#open" data-row="E907-S3" data-testid="card">
        <span data-testid="card-text">a card</span>
        <button data-testid="card-button">Approve</button>
      </a>
      <div data-row="ms_1/root/E907-S4" data-testid="node-card">node</div>
      <div data-testid="plain">no code</div>
      <div data-row="EPIC-907" data-testid="epic-card">an epic</div>
    </>
  );
}

/** a real tap: the finger goes down and up, then the click. */
const tap = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { button: 0 });
  fireEvent.pointerUp(el);
  fireEvent.click(el);
};

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Board />} />
        <Route path="/priority" element={<p data-testid="priority-route">priority page</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe("rowAt", () => {
  it("reads the row code of the nearest data-row, a node key's last part, never an epic or no code", () => {
    renderAt("/");
    expect(rowAt(screen.getByTestId("card-text"))).toBe("E907-S3");
    expect(rowAt(screen.getByTestId("node-card"))).toBe("E907-S4");
    expect(rowAt(screen.getByTestId("plain"))).toBeUndefined();
    expect(rowAt(screen.getByTestId("epic-card"))).toBeUndefined();
  });
});

describe("PriorityLongPress", () => {
  it("a held press on a card opens the sheet; Give this the machine starts it for that row and opens /priority", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const start = vi.spyOn(api, "startPriorityMode").mockResolvedValue({ ...OFF, on: true });
    renderAt("/");
    fireEvent.pointerDown(screen.getByTestId("card-text"), { button: 0, clientX: 10, clientY: 10 });
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    fireEvent.pointerUp(screen.getByTestId("card-text"));
    expect(screen.getByRole("dialog").textContent).toContain("E907-S3");
    tap(screen.getByTestId("priority-sheet-give"));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ rows: ["E907-S3"], reason: "long-press on its card" }));
    expect(await screen.findByTestId("priority-route")).toBeTruthy();
  });

  it("a short tap, a scroll-drag, a press on a button or Cancel never starts it", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const start = vi.spyOn(api, "startPriorityMode").mockResolvedValue(OFF);
    renderAt("/");
    const card = screen.getByTestId("card-text");
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(card);
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(card, { clientX: 10, clientY: 60 });
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("card-button"), { button: 0 });
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    tap(screen.getByTestId("priority-sheet-cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("the click that ends a long-press does not also open the card's link", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt("/");
    const card = screen.getByTestId("card-text");
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    card.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("PriorityModePage", () => {
  it("fills the box from ?rows= so one press starts it", async () => {
    vi.spyOn(api, "getPriorityMode").mockResolvedValue(OFF);
    render(
      <MemoryRouter initialEntries={["/priority?rows=E907-S3"]}>
        <Routes>
          <Route path="/priority" element={<PriorityModePage />} />
        </Routes>
      </MemoryRouter>,
    );
    const box = (await screen.findByTestId("priority-rows")) as HTMLInputElement;
    expect(box.value).toBe("E907-S3");
    expect((screen.getByTestId("priority-start") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the Priority mode chip in the menu", () => {
  const ON: PriorityModeView = {
    on: true,
    session: { id: "pm_1", rows: ["E907-S3", "E907-S4"], by: "owner", reason: "", startedAt: "2026-11-14T20:00:00Z", assignments: [] },
    parked: [],
    log: [],
    focusRunning: [],
  };
  const menu = () =>
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<PriorityModeChip />} />
          <Route path="/priority" element={<div data-testid="at-priority">priority page</div>} />
        </Routes>
      </MemoryRouter>,
    );

  it("shows nothing while priority mode is off", async () => {
    const read = vi.spyOn(api, "getPriorityMode").mockResolvedValue(OFF);
    menu();
    await waitFor(() => expect(read).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId("priority-chip")).toBeNull();
  });

  it("says it is on, names its tickets and opens the page where it is switched off", async () => {
    vi.spyOn(api, "getPriorityMode").mockResolvedValue(ON);
    menu();
    const chip = await screen.findByTestId("priority-chip");
    expect(chip.textContent).toContain("Priority mode on");
    expect(chip.textContent).toContain("Only your priority tickets run: E907-S3, E907-S4");
    expect(chip.getAttribute("href")).toBe("/priority");
    fireEvent.click(chip);
    expect(await screen.findByTestId("at-priority")).toBeTruthy();
  });
});
