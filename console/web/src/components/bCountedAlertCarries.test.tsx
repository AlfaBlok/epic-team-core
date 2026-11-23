// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type OwnerResponse, type MilestoneStatusView, type PendingItem } from "@/api";
import { createRealClient } from "@/api/real";
import { MilestoneStrip } from "@/components/status";
import { alertAskItem, MonitorAlertCard, MonitorAlertLine } from "@/components/waiting";

/**
 * a social world repo's red "Stopped" card (always-on Reddit, unblocked by the code repo/) had no
 * button, and "answer →" led nowhere, while he had snoozed until 2026-11-04.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const E46A4 = {
  code: "T46-A4", repo: "home_repo", state: "open" as const, question: "Approve about $11/month for a Mexico proxy?", milestoneId: "ms_e46", milestoneTitle: "PLAN-46",
  href: "https://team.example.com/milestones/ms_e46?tab=waiting", id: "wj_e46a4", world: "acme",
  card: { ask: "approve" as const, question: "Approve about $11/month for a Mexico proxy?", path: "docs/spines/epic-46.md", line: 40, risk: "$11/month; cancel any time" },
};
const alert = (over: Partial<PendingItem> = {}, ask: Partial<typeof E46A4> & { snoozedUntil?: string } = {}): PendingItem => ({
  id: "mon_1", kind: "monitor_alert", state: "open", milestoneId: "ms_zs", since: "2026-10-27T15:39:00.000Z",
  title: "Monitor alert: always-on Reddit stopped: waits on home_repo/T46-A4, the Mexico proxy",
  monitor: { why: ["stop"], next: "Unblocked by home_repo/T46-A4", asks: [{ ...E46A4, ...ask }] },
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
const ok = (over: Partial<OwnerResponse> = {}): OwnerResponse => ({ id: "jr_1", itemId: "wj_e46a4", milestoneId: "ms_e46", kind: "approve", text: "", delivery: "sent", createdAt: new Date().toISOString(), spine: { status: "written", sha: "abc1234" }, ...over });

describe("T8-S36 (b) a counted alert carries the ask's own card and buttons", () => {
  it("the alert shows T46-A4's card with Approve / No / Snooze (No was Decline); Approve goes through the alert's milestone, spinner at the button", async () => {
    let resolve!: (r: OwnerResponse) => void;
    const spy = vi.spyOn(api, "respondToWaiting").mockReturnValue(new Promise((r) => (resolve = r)));
    wrap(<MonitorAlertCard item={alert()} />);
    const card = within(screen.getByTestId("monitor-alert-ask-card"));
    expect(card.getByTestId("ask-lead").textContent).toContain("Approve about $11/month for a Mexico proxy?");
    expect(card.getByRole("button", { name: /^No: drop it$/ })).toBeTruthy();
    expect(card.getByRole("button", { name: /Snooze/ })).toBeTruthy();
    const approve = card.getByRole("button", { name: /^Yes: go ahead$/ }) as HTMLButtonElement;
    fireEvent.click(approve);
    expect(spy).toHaveBeenCalledWith("wj_e46a4", expect.objectContaining({ kind: "approve", milestoneId: "ms_e46", relay: { milestoneId: "ms_zs", code: "T46-A4" } }));
    expect(approve.getAttribute("aria-busy")).toBe("true");
    expect(approve.textContent).toBe("Sending…");
    await act(async () => resolve(ok()));
  });

  it("the card item: the ask's own milestone and fields, relayed through the alert; none for a snoozed or answered ask", () => {
    const a = alert();
    expect(alertAskItem(a, a.monitor!.asks[0])).toMatchObject({ id: "wj_e46a4", source: "ask", code: "T46-A4", milestoneId: "ms_e46", ask: "approve", risk: "$11/month; cancel any time", relay: { milestoneId: "ms_zs", code: "T46-A4" } });
    expect(alertAskItem(a, { ...E46A4, snoozedUntil: "2026-11-04" })).toBeUndefined();
    expect(alertAskItem(a, { ...E46A4, state: "answered" })).toBeUndefined();
  });

  it("the real client posts a relayed answer, snooze and key to /milestones/<alert's>/alert-asks/<code>/…", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const c = createRealClient();
    const relay = { milestoneId: "ms_zs", code: "T46-A4" };
    await c.respondToWaiting("wj_e46a4", { kind: "approve", milestoneId: "ms_e46", relay });
    await c.snoozeWaiting("wj_e46a4", { days: 3, milestoneId: "ms_e46", relay });
    await c.saveKey("wj_e46a4", { value: "k", milestoneId: "ms_e46", relay });
    await c.snoozeWaiting("wj_x", { days: 3 });
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((x) => x[0])).toEqual(["/api/milestones/ms_zs/alert-asks/T46-A4/respond", "/api/milestones/ms_zs/alert-asks/T46-A4/snooze", "/api/milestones/ms_zs/alert-asks/T46-A4/secret", "/api/waiting-on-owner/wj_x/snooze"]);
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ days: 3, milestoneId: "ms_e46" });
  });
});

describe("T8-S36 (a) a snoozed alert is one quiet line with Unsnooze", () => {
  const snoozed = alert({ state: "snoozed", snoozedUntil: "2026-11-04", monitor: { why: ["stop"], next: "Waits on home_repo/T46-A4, snoozed by you until 2026-11-04", asks: [{ ...E46A4, snoozedUntil: "2026-11-04" }] } });

  it("reads 'waits on T46-A4, snoozed by you until 2026-11-04'; Unsnooze unsnoozes the ask through the alert, result at the button", async () => {
    let resolve!: (r: { id: string; snoozedUntil: string | null }) => void;
    const spy = vi.spyOn(api, "snoozeWaiting").mockReturnValue(new Promise((r) => (resolve = r)));
    wrap(<MonitorAlertLine item={snoozed} />);
    const line = screen.getByTestId("monitor-alert-line");
    expect(line.getAttribute("data-state")).toBe("snoozed");
    expect(line.hasAttribute("data-pending-id")).toBe(false); // never counted (count proof)
    expect(screen.getByTestId("monitor-alert-line-why").textContent).toBe("waits on T46-A4, snoozed by you until 2026-11-04");
    expect(line.textContent).toContain("· always-on Reddit stopped: waits on home_repo/T46-A4, the Mexico proxy");
    fireEvent.click(screen.getByTestId("alert-unsnooze"));
    expect(spy).toHaveBeenCalledWith("wj_e46a4", { until: null, milestoneId: "ms_e46", relay: { milestoneId: "ms_zs", code: "T46-A4" } });
    expect(screen.getByTestId("alert-unsnooze").textContent).toBe("Unsnoozing…");
    await act(async () => resolve({ id: "wj_e46a4", snoozedUntil: null }));
    expect(screen.getByTestId("alert-unsnooze-note").textContent).toBe("T46-A4 unsnoozed: the alert is back");
  });

  it("a failed Unsnooze says so next to the button", async () => {
    vi.spyOn(api, "snoozeWaiting").mockRejectedValue(new Error("not_member"));
    wrap(<MonitorAlertLine item={snoozed} />);
    await act(async () => fireEvent.click(screen.getByTestId("alert-unsnooze")));
    expect(screen.getByTestId("alert-unsnooze-note").textContent).toBe("Unsnooze failed: not_member");
  });
});

describe("T8-S36 (c)(d) the header", () => {
  it("a needs_you flow whose last open item was just snoozed or answered reads '…' until the refresh, never 'Needs you · 0'", () => {
    const st = { milestoneId: "ms_zs", outcome: { word: "not_yet", source: "derived" }, flow: { word: "needs_you", reason: "1 monitor alert" }, items: [alert({ state: "alarm" })], needsYou: 0, reasons: [] } as unknown as MilestoneStatusView;
    wrap(<MilestoneStrip status={st} />);
    expect(screen.getByTestId("state-strip").textContent).not.toContain("Needs you");
  });

  const view = (items: PendingItem[], over: Partial<MilestoneStatusView> = {}): MilestoneStatusView =>
    ({ milestoneId: "ms_zs", outcome: { word: "not_yet", source: "derived" }, flow: { word: "needs_you", reason: "1 monitor alert" }, items, needsYou: items.filter((i) => i.state === "open").length, reasons: [], ...over }) as MilestoneStatusView;

  it("answer → lands on the counted alert (the page scrolls to it and rings it)", () => {
    wrap(<MilestoneStrip status={view([alert()])} waitingHref="?tab=waiting" />);
    expect(screen.getByTestId("answer-link").getAttribute("href")).toBe("/?tab=waiting&item=mon_1");
    expect(screen.getByTestId("state-strip").textContent).toContain("Needs you· 1 · 1 monitor alert");
  });

  it("an alert with no open ask: no Needs you, no answer link, a 'Delivery Manager to fix' line", () => {
    const dm = alert({ state: "alarm", monitor: { why: ["stop"], next: "No ask named: the Delivery Manager writes a coded ask", asks: [] } });
    wrap(<MilestoneStrip status={view([dm], { flow: { word: "queued", reason: "1 step ready" }, needsYou: 0 })} />);
    expect(screen.queryByTestId("answer-link")).toBeNull();
    const line = screen.getAllByTestId("defect-line").find((x) => x.getAttribute("data-kind") === "monitor_alert")!;
    expect(line.textContent).toBe("Delivery Manager to fix: always-on Reddit stopped: waits on home_repo/T46-A4, the Mexico proxy — No ask named: the Delivery Manager writes a coded ask");
  });
});
