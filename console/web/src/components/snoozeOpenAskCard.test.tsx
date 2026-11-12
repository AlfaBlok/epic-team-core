// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type StatusBatch, type WaitingItem } from "@/api";
import { WaitingOnYou } from "@/components/waiting";
import { resetSnoozes } from "@/lib/snooze";

// Snooze (3 days / 1 week / 1 month) on every waiting card; the date goes on the ask's spine
// line; a snoozed ask is hidden and uncounted until then; the section shows "n snoozed" with Unsnooze.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSnoozes(); // snoozes in flight are module state
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

describe("T48-S3 snooze", () => {
  it("every open ask card has Snooze with 3 days / 1 week / 1 month; a choice posts the days", async () => {
    const a = ask("wj_a", "T9-A1");
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([a]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending(a)]));
    const post = vi.spyOn(api, "snoozeWaiting").mockResolvedValue({ id: a.id, snoozedUntil: "2026-11-08" });
    render(
      <MemoryRouter>
        <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
      </MemoryRouter>,
    );
    const card = await screen.findByTestId("waiting-card");
    fireEvent.click(within(card).getByRole("button", { name: /Snooze/ }));
    const options = within(card).getAllByTestId("snooze-option").map((o) => o.textContent);
    expect(options).toEqual(["3 hours", "3 days", "1 week", "1 month"]); // 3 hours first
    fireEvent.click(within(card).getByText("1 week"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("wj_a", { days: 7, milestoneId: "ms_x" }));
  });

  it("a snoozed ask: no card, not counted; 'n snoozed' opens the list with Unsnooze", async () => {
    const a = ask("wj_a", "T9-A1");
    const b = ask("wj_b", "T9-A2", { snoozedUntil: "2099-01-08" });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([a, b]);
    // The server's status batch leaves a snoozed ask out (status/compute pendingItems). The count and the cards are
    // the batch's open items (one source, the pills' too); a snooze picked here is out of both at once (lib/snooze).
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending(a)]));
    const post = vi.spyOn(api, "snoozeWaiting").mockResolvedValue({ id: b.id, snoozedUntil: null });
    render(
      <MemoryRouter>
        <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(1));
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1");
    expect(screen.queryByText("Question T9-A2?")).toBeNull();
    expect(screen.queryByText("row of T9-A2")).toBeNull();
    expect(screen.queryByTestId("answered-section")).toBeNull(); // not mistaken for an answered ask
    const chip = screen.getByTestId("snoozed-count");
    expect(chip.textContent).toBe("1");
    fireEvent.click(chip);
    const row = within(screen.getByTestId("snoozed-section")).getByTestId("snoozed-row");
    expect(row.textContent).toContain("T9-A2");
    expect(row.textContent).toContain("Question T9-A2?");
    expect(row.textContent).toMatch(/until .*(Jan\D*8|8\D*Jan)/);
    fireEvent.click(within(row).getByTestId("unsnooze"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("wj_b", { until: null, milestoneId: "ms_x" }));
  });

  it("no Snooze on answered asks, persona requests or read-only spines", async () => {
    const answered = ask("wj_c", "T9-A3", { state: "answered", answer: "yes" });
    const nj = ask("wj_d", "", { source: "needs_jordi", code: undefined, path: undefined });
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([answered, nj]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending(nj)]));
    render(
      <MemoryRouter>
        <WaitingOnYou />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByTestId("waiting-card").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("snooze")).toBeNull();
    expect(screen.queryByTestId("snoozed-count")).toBeNull();
  });
});
