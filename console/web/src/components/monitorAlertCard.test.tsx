// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PendingItem } from "@/api";
import { asksPhrase } from "@/components/status";
import { MonitorAlertCard } from "@/components/waiting";
import { groupPending } from "@/lib/pending";

/** a stopped monitor item is an alert card in Waiting on you, linking the ask that unblocks it. */

afterEach(cleanup);

const ALERT: PendingItem = {
  id: "mon_1", kind: "monitor_alert", state: "open", milestoneId: "ms_zs", since: "2026-10-27T15:39:00.000Z",
  title: "Monitor alert: Reddit always-on writing stopped: waits on home_repo/T46-A4",
  detail: "since 2026-10-27 15:39Z (6 days)",
  monitor: {
    why: ["stop"], since: "2026-10-27T15:39:00.000Z", next: "Unblocked by home_repo/T46-A4 (snoozed until 2026-11-04)",
    asks: [{ code: "T46-A4", repo: "home_repo", state: "open", snoozedUntil: "2026-11-04", question: "Approve about $11/month for a Mexico proxy?", milestoneId: "ms_e46", href: "https://team.example.com/milestones/ms_e46?tab=waiting" }],
  },
};

describe("T8-S35 monitor alert card", () => {
  it("shows the item, its age and the snoozed ask with its link (another world: absolute)", () => {
    render(<MemoryRouter><MonitorAlertCard item={ALERT} /></MemoryRouter>);
    const card = screen.getByTestId("monitor-alert");
    expect(within(card).getByText("Stopped")).toBeTruthy();
    expect(within(card).getByText("Reddit always-on writing stopped: waits on home_repo/T46-A4")).toBeTruthy();
    expect(within(card).getByTestId("monitor-alert-detail").textContent).toBe("since 2026-10-27 15:39Z (6 days)");
    const link = within(card).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://team.example.com/milestones/ms_e46?tab=waiting");
    expect(link.textContent).toContain("home_repo/T46-A4");
    expect(within(card).getByTestId("monitor-alert-ask-state").textContent).toBe("snoozed until 2026-11-04");
    expect(within(card).queryByTestId("monitor-alert-next")).toBeNull();
  });

  it("with no ask, says the Delivery Manager writes one or clears the item", () => {
    const none = { ...ALERT, monitor: { ...ALERT.monitor!, why: ["stop", "overdue"] as ("stop" | "overdue")[], asks: [], next: "No ask named: the Delivery Manager writes a coded ask for what unblocks it, or clears the item if it is stale, at its next wake" } };
    render(<MemoryRouter><MonitorAlertCard item={none} /></MemoryRouter>);
    expect(screen.getByTestId("monitor-alert-next").textContent).toMatch(/^No ask named/);
  });

  it("is its own first group in the Pending selector and the header counts it", () => {
    expect(groupPending([ALERT])[0]).toMatchObject({ key: "alerts", label: "Monitor alerts" });
    expect(asksPhrase([ALERT])).toBe("1 monitor alert");
  });
});
