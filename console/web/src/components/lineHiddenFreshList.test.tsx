// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type StatusBatch } from "@/api";
import { WaitingOnYou, staleAsOf } from "@/components/waiting";

// Waiting on you is served from the console's stored view; its "as of" time shows, quietly, only when it is
// older than ~2 minutes (a fresh list says nothing).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const open: PendingItem[] = [{ id: "ms_x:1", kind: "ask", state: "open", milestoneId: "ms_x", title: "ask" }];
const batch = (asOf?: string): StatusBatch => ({ milestones: [], items: open, needsYou: 1, at: new Date().toISOString(), ...(asOf ? { asOf } : {}) });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe("T33-S7 as-of line", () => {
  it("is hidden for a fresh list and when the server sends no asOf", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch(ago(0.5)));
    render(
      <MemoryRouter>
        <WaitingOnYou fold="blocked" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1"));
    expect(screen.queryByTestId("waiting-as-of")).toBeNull();
    expect(staleAsOf(ago(1))).toBe(false);
  });

  it("shows how old the list is once it is older than two minutes", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listStatus").mockResolvedValue(batch(ago(7)));
    render(
      <MemoryRouter>
        <WaitingOnYou fold="blocked" />
      </MemoryRouter>,
    );
    const line = await screen.findByTestId("waiting-as-of");
    expect(line.textContent).toMatch(/^as of 7 min/);
  });
});
