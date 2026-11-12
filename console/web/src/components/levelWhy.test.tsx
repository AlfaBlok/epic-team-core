// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type StatusBatch, type WaitingItem } from "@/api";
import { WaitingOnYou } from "@/components/waiting";
import { OwnerPriorityTag } from "@/components/ownerPriority";

// the server sends the lists sorted by the owner's level first (the Prioritizer's
// docs/priorities.json), each item with `owner`; the Team home keeps that order and every card shows its level, and a tap
// shows why, with his words.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

const high = { level: "high" as const, why: "You asked for it twice this week.", words: "It's time to fucking go", said: "2026-11-10", ref: "PLAN-2", at: "2026-11-10" };
const low = { level: "low" as const, why: "You have not spoken of it in two weeks.", ref: "PLAN-9" };
const ask = (id: string, code: string, priority: number, ownerPriority?: typeof high | typeof low): WaitingItem =>
  ({
    id,
    source: "ask",
    state: "open",
    repo: "home_repo",
    code,
    milestoneId: "ms_1",
    priority,
    ownerPriority,
    milestoneTitle: "M1",
    path: "docs/spines/epic-9.md",
    line: 12,
    title: `row of ${code}`,
    ask: "decide",
    question: `Question ${code}?`,
    contextLinks: [],
    owner: { label: "Delivery Manager" },
    decidable: false,
  }) as unknown as WaitingItem;
const pending = (id: string, priority: number, extra: Partial<PendingItem> = {}): PendingItem => ({ id, kind: "ask", state: "open", milestoneId: "ms_1", priority, title: id, ...extra });
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-10T05:00:00Z" });

describe("T48-S34 the level and its why", () => {
  it("shows the level; a tap shows why, his words and the day", () => {
    render(<OwnerPriorityTag p={high} />);
    const tag = screen.getByTestId("owner-priority");
    expect(tag.textContent).toBe("High priority");
    expect(screen.queryByTestId("owner-priority-why")).toBeNull();
    fireEvent.click(tag);
    const why = screen.getByTestId("owner-priority-why");
    expect(why.textContent).toContain("You asked for it twice this week.");
    expect(why.textContent).toContain("“It's time to fucking go” · you said this on 2026-11-10");
    fireEvent.click(tag);
    expect(screen.queryByTestId("owner-priority-why")).toBeNull();
  });
  it("nothing when the Prioritizer gave it no level", () => {
    const { container } = render(<OwnerPriorityTag />);
    expect(container.innerHTML).toBe("");
  });
});

describe("T48-S34 Team home order", () => {
  it("a high card leads, a low one comes last, a status row in between, each card with its level", async () => {
    const top = ask("wj_high", "T2-A1", 1, high);
    const bottom = ask("wj_low", "T9-A1", 2_000_001, low);
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([top, bottom]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending("wj_high", 1, { ownerPriority: high }), pending("rm_x", 1_000_001, { kind: "ready_to_mark", title: "Ready to mark X" }), pending("wj_low", 2_000_001, { ownerPriority: low })]));
    const { container } = render(
      <MemoryRouter>
        <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("waiting-card");
    await waitFor(() => expect(container.querySelectorAll("[data-testid=status-item]")).toHaveLength(1));
    const order = [...container.querySelectorAll("[data-testid=waiting-card], [data-testid=status-item]")].map((el) => el.getAttribute("data-pending-id"));
    expect(order).toEqual(["wj_high", "rm_x", "wj_low"]);
    expect([...container.querySelectorAll("[data-testid=owner-priority]")].map((el) => el.getAttribute("data-level"))).toEqual(["high", "low"]);
  });
});
