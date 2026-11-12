// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type StatusBatch, type WaitingItem } from "@/api";
import { mergeByPriority, WaitingOnYou } from "@/components/waiting";

// "Blocked, waiting on you" follows milestone priority: the server sends both lists sorted with each
// item's `priority`; the Team home merges status-only rows and cards so a priority-1 card never sits under a priority-9 row.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

const ask = (id: string, code: string, priority: number): WaitingItem =>
  ({
    id,
    source: "ask",
    state: "open",
    repo: "home_repo",
    code,
    milestoneId: `ms_${priority}`,
    priority,
    milestoneTitle: `M${priority}`,
    path: "docs/spines/epic-9.md",
    line: 12,
    title: `row of ${code}`,
    ask: "decide",
    question: `Question ${code}?`,
    contextLinks: [],
    owner: { label: "Delivery Manager" },
    decidable: false,
  }) as unknown as WaitingItem;
const pending = (id: string, priority: number, extra: Partial<PendingItem> = {}): PendingItem => ({ id, kind: "ask", state: "open", milestoneId: `ms_${priority}`, priority, title: id, ...extra });
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-01T16:00:00Z" });

describe("T48-S5 mergeByPriority", () => {
  it("merges two sorted lists; status rows lead on a tie; no priority sorts last", () => {
    const rows = mergeByPriority([pending("s2", 2), pending("s5", 5), { ...pending("sx", 1), priority: undefined }], [ask("c1", "A1", 1), ask("c2", "A2", 2), ask("c9", "A9", 9)]);
    expect(rows.map((r) => r.status?.id ?? r.card!.id)).toEqual(["c1", "s2", "c2", "s5", "c9", "sx"]);
  });
});

describe("T48-S5 Team home order", () => {
  it("a status-only row (Ready to mark, priority 3) sits between the top milestone's card and a priority-9 card", async () => {
    const top = ask("wj_top", "T46-A4", 1);
    const low = ask("wj_low", "T9-A1", 9);
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([top, low]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([pending("wj_top", 1), pending("rm_x", 3, { kind: "ready_to_mark", title: "Ready to mark X" }), pending("wj_low", 9)]));
    const { container } = render(
      <MemoryRouter>
        <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("waiting-card");
    await waitFor(() => expect(container.querySelectorAll("[data-testid=status-item]")).toHaveLength(1));
    const order = [...container.querySelectorAll("[data-testid=waiting-card], [data-testid=status-item]")].map((el) => el.getAttribute("data-pending-id") ?? el.textContent?.match(/E\d+-A\d+/)?.[0]);
    expect(order).toEqual(["wj_top", "rm_x", "wj_low"]);
  });
});
