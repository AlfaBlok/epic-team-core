// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type LaptopView, type MacTask, type PendingItem, type StatusBatch } from "@/api";
import { WaitingOnYou } from "@/components/waiting";
import { blockedItems } from "@/lib/inbox";
import { markSent, resetSent } from "@/lib/sentRows";

// The owner, 16 Nov, on his Team home: "why showing one, none left???". Blocked on you said 1 while inside were
// only 4 green Sent rows (asks he had just answered, still listed by a status batch that had not caught up) and the
// "I'm on my laptop for" box with 2 Mac tasks. The red count is the open asks he still has to act on, 0 when none;
// the laptop box says its own count; a Sent row counts nothing. One component and one count function for every skin.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSent();
});

const open = (n: number): PendingItem => ({ id: `ms_x:${n}`, kind: "ask", state: "open", milestoneId: "ms_x", title: `Ask number ${n}` }) as PendingItem;
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.filter((i) => i.state === "open").length, at: new Date().toISOString() });
const task = (row: string): MacTask => ({ key: `home_repo#${row}`, repo: "home_repo", row, title: `Ticket ${row}`, minutes: 15, order: 1, url: `http://h/t/${row}/`, command: `claude --chrome '${row}'` });
const show = (items: PendingItem[], laptop?: LaptopView) => {
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch(items));
  if (laptop) vi.spyOn(api, "laptop").mockResolvedValue(laptop);
  render(
    <MemoryRouter>
      <WaitingOnYou title="Blocked on you" fold="blocked" part="blocked" laptop={!!laptop} />
    </MemoryRouter>,
  );
};
const count = () => screen.getByTestId("waiting-on-you-count").textContent;

describe("Blocked on you counts only what is still open for him", () => {
  it("his screen of 16 Nov: four answered asks the status still lists and two Mac tasks read 0, not 1", async () => {
    const asks = [1, 2, 3, 4].map(open);
    show(asks, { session: null, tasks: [task("T1-S1"), task("T2-S2")], listUrl: "http://h/mac/" });
    await waitFor(() => expect(count()).toBe("4"));
    // he answers all four; the status batch has not caught up and still lists them open
    act(() => asks.forEach((a) => markSent(`status:${a.id}`, { said: "Answered", title: a.title })));
    await waitFor(() => expect(count()).toBe("0"));
    // the four green Sent rows stay where they were, counted nowhere
    expect(screen.getAllByTestId("sent-row")).toHaveLength(4);
    // the laptop box says its own count, apart from the red one
    expect((await screen.findByTestId("laptop-summary")).textContent).toContain("2 tasks for Claude on your Mac");
  });

  it("the count drops the moment he answers one, and the rest still count", async () => {
    show([open(1), open(2)]);
    await waitFor(() => expect(count()).toBe("2"));
    act(() => void markSent("status:ms_x:1", { said: "Answered", title: "Ask number 1" }));
    await waitFor(() => expect(count()).toBe("1"));
    expect(document.body.textContent).toContain("Ask number 2");
  });

  it("every red pill reads the same rule: blockedItems leaves out an ask answered here, card or status row", () => {
    const items = [open(1), open(2), open(3)];
    markSent("ask:ms_x:1", { said: "Approved", title: "Ask number 1" });
    markSent("status:ms_x:2", { said: "Answered", title: "Ask number 2" });
    expect(blockedItems(batch(items)).map((i) => i.id)).toEqual(["ms_x:3"]);
    expect(blockedItems(batch(items), { answered: () => false })).toHaveLength(3);
  });
});
