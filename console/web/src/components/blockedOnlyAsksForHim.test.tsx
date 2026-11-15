// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type StatusBatch } from "@/api";
import { WaitingOnYou } from "@/components/waiting";

// The owner, on a yellow Monitoring line in Blocked on you (its check a day overdue, no ask in it): "I can't take action
// on it so what's it doing there?". Blocked on you lists only what carries an ask for him; a Monitoring item with no
// ask is the team's (the console hands it back to its desk).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const botsLine: PendingItem = {
  id: "mon_5dc5ae23b4fa3507", kind: "monitor_alert", state: "alarm", milestoneId: "ms_bots",
  title: "Monitor alert: E907-S3: sample buyer bot built and ready (bots/sample-agent), results pending",
  detail: "next check was due 2026-11-14 15:00Z, 28 hours overdue",
  monitor: { nextCheckAt: "2026-11-14T15:00:00.000Z", why: ["overdue"], asks: [], next: "No ask named: the Delivery Manager writes a coded ask for what unblocks it, or clears the item if it is stale, at its next wake" },
} as PendingItem;
const snoozedAlert: PendingItem = {
  id: "mon_snz", kind: "monitor_alert", state: "snoozed", milestoneId: "ms_zs", title: "Monitor alert: always-on Reddit stopped",
  monitor: { why: ["stop"], next: "Waits on home_repo/T46-A4, snoozed by you until 2026-11-20", asks: [{ code: "T46-A4", repo: "home_repo", state: "open", snoozedUntil: "2026-11-20", milestoneId: "ms_e46", id: "wj_1" }] },
} as unknown as PendingItem;
const ask: PendingItem = { id: "ms_x:1", kind: "ask", state: "open", milestoneId: "ms_x", title: "Approve the proxy?" };
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.filter((i) => i.state === "open").length, at: new Date().toISOString() });
const show = (items: PendingItem[]) => {
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch(items));
  render(
    <MemoryRouter>
      <WaitingOnYou title="Blocked on you" fold="blocked" part="blocked" />
    </MemoryRouter>,
  );
};

describe("Blocked on you holds only what the owner can act on", () => {
  it("the bots monitoring line with no ask is not in Blocked on you; the real ask is", async () => {
    show([botsLine, ask]);
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1"));
    expect(screen.queryByTestId("monitor-alert-lines")).toBeNull();
    expect(screen.queryByText(/sample buyer bot/)).toBeNull();
    expect(document.body.textContent).toContain("Approve the proxy?");
  });

  it("with only the bots line, he reads Nothing waiting on you", async () => {
    show([botsLine]);
    await screen.findByTestId("nothing-waiting");
    expect(screen.queryByText(/sample buyer bot/)).toBeNull();
  });

  it("an alert whose ask he snoozed keeps its quiet line with Unsnooze (his own action)", async () => {
    show([snoozedAlert, botsLine]);
    const lines = await screen.findAllByTestId("monitor-alert-line");
    expect(lines.map((l) => l.getAttribute("data-alert-id"))).toEqual(["mon_snz"]);
  });
});
