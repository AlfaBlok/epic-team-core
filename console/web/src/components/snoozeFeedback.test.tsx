// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type StatusBatch, type WaitingItem } from "@/api";
import { WaitingOnYou } from "@/components/waiting";
import { invalidate, useQuery } from "@/lib/data";
import { resetSnoozes, snoozeUntil, SNOOZED_SHOW_MS, withSnoozes } from "@/lib/snooze";

// after a Snooze pick nothing happened for seconds, then the card went. Now the card hides
// at once with a "Snoozing … until …" spinner line, comes back with the error if the write fails; Unsnooze shows a spinner.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetSnoozes();
});
beforeEach(() => localStorage.clear());

const ask = (id: string, code: string, extra: Partial<WaitingItem> = {}): WaitingItem =>
  ({
    id,
    source: "ask",
    state: "open",
    repo: "home_repo",
    code,
    milestoneId: "ms_x",
    milestoneTitle: "home_repo",
    path: "docs/spines/epic-9.md",
    line: 12,
    title: `row of ${code}`,
    ask: "decide",
    question: `Question ${code}?`,
    contextLinks: [],
    owner: { label: "Delivery Manager" },
    decidable: false,
    ...extra,
  }) as WaitingItem;
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-01T16:00:00Z" });
const pending = (w: WaitingItem): PendingItem => ({ id: w.id, kind: "ask", state: "open", milestoneId: "ms_x", title: w.title });
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const page = () =>
  render(
    <MemoryRouter>
      <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
    </MemoryRouter>,
  );
const pick = (card: HTMLElement, label: string) => {
  fireEvent.click(within(card).getByRole("button", { name: /Snooze/ }));
  fireEvent.click(within(card).getByText(label));
};

describe("T48-S10 snooze feedback", () => {
  it("a pick closes the menu, hides the card and drops the count at once; a spinner line says it is being snoozed", async () => {
    const a = ask("wj_a", "T9-A1");
    const b = ask("wj_b", "T9-A2");
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([a, b]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending(a), pending(b)]));
    const d = deferred<{ id: string; snoozedUntil: string | null }>();
    vi.spyOn(api, "snoozeWaiting").mockReturnValue(d.promise);
    page();
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(2));
    pick(screen.getAllByTestId("waiting-card")[0], "3 days");

    // Before the server answers: card gone, count 1, chip "1 snoozed", the working line names the ask and the day.
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(1);
    expect(screen.queryByText("Question T9-A1?")).toBeNull();
    expect(screen.queryByTestId("snooze-menu")).toBeNull();
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1");
    expect(screen.getByTestId("snoozed-count").textContent).toBe("1");
    const line = screen.getByTestId("working-line");
    expect(line.textContent).toMatch(/Snoozing T9-A1 until/);
    // The open snoozed list shows the spinner instead of Unsnooze while it is written.
    fireEvent.click(screen.getByTestId("snoozed-count"));
    const row = within(screen.getByTestId("snoozed-section")).getByTestId("snoozed-row");
    expect(within(row).queryByTestId("unsnooze")).toBeNull();
    expect(row.textContent).toContain("Snoozing…");

    await act(async () => d.resolve({ id: a.id, snoozedUntil: snoozeUntil(3) }));
    expect(screen.getByTestId("snoozed-line").textContent).toMatch(/Snoozed T9-A1 until/);
    // Written: Unsnooze is usable at once (not held for the "Snoozed" line) and brings the card straight back.
    const un = within(screen.getByTestId("snoozed-section")).getByTestId("unsnooze") as HTMLButtonElement;
    expect(un.disabled).toBe(false);
    vi.spyOn(api, "snoozeWaiting").mockResolvedValue({ id: a.id, snoozedUntil: null });
    fireEvent.click(un);
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(2));
    expect(screen.queryByTestId("snoozed-line")).toBeNull();
  });

  it("a failed write brings the card back with the reason on its Snooze button", async () => {
    const a = ask("wj_a", "T9-A1");
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([a]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending(a)]));
    const d = deferred<{ id: string; snoozedUntil: string | null }>();
    vi.spyOn(api, "snoozeWaiting").mockReturnValue(d.promise);
    page();
    pick(await screen.findByTestId("waiting-card"), "1 week");
    expect(screen.queryByTestId("waiting-card")).toBeNull();
    await act(async () => d.reject(new Error("nothing changed: git push failed: rejected")));
    const card = await screen.findByTestId("waiting-card");
    expect(within(card).getByTestId("snooze-error").textContent).toMatch(/Snooze failed, the card is back: .*git push failed/);
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1");
    expect(screen.queryByTestId("working-line")).toBeNull();
    // Opening the menu again clears the error.
    fireEvent.click(within(card).getByRole("button", { name: /Snooze/ }));
    expect(screen.queryByTestId("snooze-error")).toBeNull();
  });

  it("the 'Snoozed' line goes after a moment; the server list then carries the date", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const a = ask("wj_a", "T9-A1");
    const list = vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([a]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending(a)]));
    vi.spyOn(api, "snoozeWaiting").mockImplementation(async () => {
      list.mockResolvedValue([{ ...a, snoozedUntil: snoozeUntil(30) }]);
      return { id: a.id, snoozedUntil: snoozeUntil(30) };
    });
    page();
    pick(await screen.findByTestId("waiting-card"), "1 month");
    await screen.findByTestId("snoozed-line");
    await act(async () => vi.advanceTimersByTime(SNOOZED_SHOW_MS + 100));
    await waitFor(() => expect(screen.queryByTestId("snoozing")).toBeNull());
    expect(screen.queryByTestId("waiting-card")).toBeNull();
    expect(screen.getByTestId("snoozed-count").textContent).toBe("1");
  });

  it("Unsnooze shows a spinner and 'Unsnoozing…' until the refresh brings the card back; an error re-enables it", async () => {
    const b = ask("wj_b", "T9-A2", { snoozedUntil: "2099-01-08" });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([b]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([]));
    const d = deferred<{ id: string; snoozedUntil: string | null }>();
    vi.spyOn(api, "snoozeWaiting").mockReturnValueOnce(d.promise);
    page();
    fireEvent.click(await screen.findByTestId("snoozed-count"));
    const btn = within(screen.getByTestId("snoozed-section")).getByTestId("unsnooze");
    fireEvent.click(btn);
    expect(btn.textContent).toContain("Unsnoozing…");
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(within(btn).getByTestId("button-spinner")).toBeTruthy();
    await act(async () => d.reject(new Error("nothing changed: git fetch failed")));
    expect(btn.textContent).toBe("Unsnooze");
    expect(screen.getByTestId("snoozed-section").textContent).toContain("git fetch failed");
  });

  it("a written Unsnooze brings the card back and counts it at once, before the background refresh re-reads the spine", async () => {
    const b = ask("wj_b", "T9-A2", { snoozedUntil: "2099-01-08" });
    const list = vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([b]);
    const status = vi.spyOn(api, "listStatus").mockResolvedValue(batch([]));
    // the server puts an unsnoozed ask back into its stored status at once (readModel views patch), so the
    // refetch after the write lists it: the pills and this list count it from the same batch.
    vi.spyOn(api, "snoozeWaiting").mockImplementation(async () => {
      list.mockResolvedValue([{ ...b, snoozedUntil: undefined }]);
      status.mockResolvedValue(batch([pending({ ...b, snoozedUntil: undefined })]));
      return { id: b.id, snoozedUntil: null };
    });
    page();
    fireEvent.click(await screen.findByTestId("snoozed-count"));
    fireEvent.click(within(screen.getByTestId("snoozed-section")).getByTestId("unsnooze"));
    const card = await screen.findByTestId("waiting-card");
    expect(card.textContent).toContain("Question T9-A2?");
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1");
    expect(screen.queryByTestId("snoozed-count")).toBeNull();
  });

  it("withSnoozes: only open asks without a date take the pending one", () => {
    const m = new Map([["wj_a", { until: "2026-11-04", label: "T9-A1" }]]);
    const [open, answered, dated] = withSnoozes([ask("wj_a", "A"), ask("wj_a", "A", { state: "answered" }), ask("wj_a", "A", { snoozedUntil: "2026-12-01" })], m)!;
    expect(open.snoozedUntil).toBe("2026-11-04");
    expect(answered.snoozedUntil).toBeUndefined();
    expect(dated.snoozedUntil).toBe("2026-12-01");
  });

  it("a snooze refetches only the inbox queries; a plain invalidate still refetches all", async () => {
    const inbox = vi.fn(async () => 1);
    const other = vi.fn(async () => 2);
    const Probe = () => {
      useQuery(inbox, [], { tag: "inbox" });
      useQuery(other, []);
      return null;
    };
    render(<Probe />);
    await waitFor(() => expect(other).toHaveBeenCalledTimes(1));
    await act(async () => invalidate("inbox"));
    expect(inbox).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
    await act(async () => invalidate());
    expect(inbox).toHaveBeenCalledTimes(3);
    expect(other).toHaveBeenCalledTimes(2);
  });
});
