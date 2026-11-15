// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type MilestoneStatusView, type Run, type WaitingItem } from "@/api";
import { holdProgress, milestoneState, openAskCodes, recoveredAt, runWord, zoned } from "@/lib/status";
import { MilestoneStrip, OpenAsksContext, stripLines } from "@/components/status";
import { OutcomeBadge } from "@/components/common";
import { SidebarNav } from "@/components/Layout";
import { RunTimeline } from "@/components/timeline";
import { timelineGroups } from "@/lib/derive";

/**
 * one plain status per milestone; a clock wait never reads "blocked". The word comes from the server's
 * status object (GET /api/milestones/:id/status); the web only renders it.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The shape: 7-day hold from Oct 24 06:53 CEST, next check Oct 25 02:00 UTC, "now" = Oct 24 17:00 UTC.
const NOW = Date.parse("2026-10-24T17:00:00Z");
const HOLD = {
  what: "7-day hold, all 5 DoD green",
  since: "2026-10-24T04:53:00.000Z",
  until: "2026-10-31T05:53:00.000Z",
  nextCheckAt: "2026-10-25T02:00:00.000Z",
  nextCheck: "archiver delete proof (DOD-2)",
  then: "write Outcome, Status review",
};
const status = (flow: Partial<MilestoneStatusView["flow"]> & Pick<MilestoneStatusView["flow"], "word">, items: MilestoneStatusView["items"] = []): MilestoneStatusView => ({
  milestoneId: "ms_2",
  outcome: { word: "not_yet", source: "derived" },
  flow: { reason: "", ...flow },
  items,
  needsYou: items.filter((i) => i.state === "open").length,
  reasons: [],
});
const item = (code: string, state: "open" | "answered" = "open") => ({ id: `w_${code}`, kind: state === "open" ? ("ask" as const) : ("answered" as const), state, milestoneId: "ms_2", title: "Which?", ask: "decide" as const, code });
const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  assignmentId: "as_2",
  milestoneId: "ms_2",
  startedAt: "2026-10-24T15:00:00Z",
  outcome: "progressed",
  summary: "",
  ...over,
});
const asg = (over: Partial<Assignment> = {}) =>
  ({ id: "as_2", milestoneId: "ms_2", personaId: "p_dm", cadence: { type: "interval", everyMinutes: 120 }, enabled: true, createdAt: "2026-10-20T00:00:00Z", ...over }) as Assignment;
const ask = (code: string, over: Partial<WaitingItem> = {}) =>
  ({ id: `w_${code}`, source: "ask", state: "open", who: "Sam", code, milestoneId: "ms_2", ask: "decide", question: "Which?", title: "Which?", contextLinks: [], decidable: true, ...over }) as WaitingItem;

describe("milestone state = the server's flow", () => {
  it("every flow word renders as is; no status yet = loading", () => {
    for (const word of ["settled", "paused", "working", "monitoring", "queued", "stalled", "nothing_to_do"] as const)
      expect(milestoneState(status({ word })).word).toBe(word);
    expect(milestoneState(status({ word: "needs_you" }, [item("EPIC-902-A21")])).word).toBe("needs_you");
    expect(milestoneState(status({ word: "needs_you" })).word).toBe("loading"); // no open item left yet (a patch before the refresh)
    expect(milestoneState(undefined).word).toBe("loading");
  });
  it("needs_you carries the open items; answered items are their own lines, never asks", () => {
    const st = milestoneState(status({ word: "needs_you" }, [item("EPIC-902-A21"), item("EPIC-902-A2", "answered")]));
    expect(st.asks?.map((a) => a.code)).toEqual(["EPIC-902-A21"]);
    expect(st.answered?.map((a) => a.code)).toEqual(["EPIC-902-A2"]);
  });
});

describe("run words", () => {
  it("blocked with an open code → Needs you; with none or answered codes → Monitoring; unknown codes context → Needs you", () => {
    const open = openAskCodes([ask("E904-A3"), ask("E904-A4", { state: "answered" })]);
    expect(runWord({ outcome: "blocked", summary: "waits on poly-maker/E904-A3" }, open)).toBe("needs_you");
    expect(runWord({ outcome: "blocked", summary: "waits on E904-A4" }, open)).toBe("monitoring");
    expect(runWord({ outcome: "blocked", summary: "come back at 02:00" }, open)).toBe("monitoring");
    expect(runWord({ outcome: "blocked", summary: "x" })).toBe("needs_you");
    expect(runWord({ outcome: "running", summary: "" })).toBe("working");
    expect(runWord({ outcome: "monitoring", summary: "" })).toBe("monitoring");
  });

  it("badges: Working / Needs you / Monitoring · next check / Progressed / Failed / Idle", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    render(
      <OpenAsksContext.Provider value={new Set(["E904-A3"])}>
        <OutcomeBadge outcome="running" run={run("a", { outcome: "running" })} />
        <OutcomeBadge outcome="blocked" run={run("b", { outcome: "blocked", summary: "waits on E904-A3" })} />
        <OutcomeBadge outcome="blocked" run={run("c", { outcome: "blocked", summary: "come back at 02:00", retryAt: HOLD.nextCheckAt })} />
        <OutcomeBadge outcome="monitoring" run={run("d", { outcome: "monitoring", nextCheckAt: HOLD.nextCheckAt })} />
        <OutcomeBadge outcome="progressed" />
        <OutcomeBadge outcome="failed" />
        <OutcomeBadge outcome="idle" />
      </OpenAsksContext.Provider>,
    );
    const texts = [...document.querySelectorAll("[data-word]")].map((e) => e.textContent);
    vi.useRealTimers();
    expect(texts).toEqual(["Working", "Needs you", "Monitoring · next check in 9 h", "Monitoring · next check in 9 h", "Progressed", "Failed", "Idle"]);
    // the exact time stays on hover.
    expect(document.querySelector('[data-word="monitoring"]')!.getAttribute("title")).toMatch(/Next check Oct 25, 2026/);
    expect(document.querySelectorAll('[data-word="needs_you"]')[0].className).toContain("amber");
    expect(document.querySelectorAll('[data-word="monitoring"]')[0].className).toContain("sky");
    expect(document.querySelector('[data-word="failed"]')!.className).toContain("red");
    expect(document.querySelectorAll('[data-word="needs_you"]')[0].className).not.toContain("red");
  });
});

describe("header strip per state", () => {
  const strip = (st: MilestoneStatusView) =>
    render(
      <MemoryRouter>
        <MilestoneStrip status={st} now={NOW} timeZone="UTC" waitingHref="?tab=waiting" />
      </MemoryRouter>,
    );

  it("Monitoring: what, day N of M with a progress bar, next check (UTC shown), ready-if-green, then", () => {
    strip(status({ word: "monitoring", monitoring: [HOLD] }));
    const el = screen.getByTestId("state-strip");
    expect(el.getAttribute("data-state")).toBe("monitoring");
    expect(el.textContent).toContain("Monitoring· 7-day hold, all 5 DoD green, day 1 of 7");
    expect(el.textContent).toContain("next check in 9 h (archiver delete proof (DOD-2))");
    expect(el.textContent).toContain("ready in 6 days if it stays green");
    expect(el.querySelector("[title]")!.getAttribute("title")).toBe("next check Oct 25, 02:00 UTC · ready Oct 31, 05:53 UTC");
    expect(el.textContent).toContain("then: write Outcome, Status review");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-label")).toBe("day 1 of 7");
    expect(el.className).not.toMatch(/sky|amber|orange/); // one grey frame
  });

  it("Needs you: counts by kind with codes, links to Waiting on you, amber", () => {
    strip(status({ word: "needs_you" }, [item("EPIC-902-A21")]));
    const el = screen.getByTestId("state-strip");
    expect(el.getAttribute("data-state")).toBe("needs_you");
    expect(el.textContent).toContain("Needs you· 1 · 1 decision");
    expect(screen.getByRole("link", { name: "answer →" }).getAttribute("href")).toBe("/?tab=waiting&item=w_EPIC-902-A21"); // lands on the item
    expect(el.className).not.toMatch(/amber|red/); // one grey frame
  });

  it("Working: wake #N started <relative> (exact time on hover)", () => {
    strip(status({ word: "working", run: { id: "run_live", assignmentId: "as_2", startedAt: "2026-10-24T16:30:00Z", summary: "", wake: 2 } }));
    expect(screen.getByTestId("state-strip").textContent).toContain("Working· wake #2 started 30 min ago");
    expect(screen.getByTestId("state-strip").querySelector("[title]")!.getAttribute("title")).toBe("started Oct 24, 16:30 UTC");
  });

  it("Queued, Stalled, Nothing to do; an answered ask shows as its own line", () => {
    strip(status({ word: "queued", reason: "2 steps ready; next wake of DM", nextWakeAt: "2026-10-24T19:00:00Z", personas: ["DM"] }));
    expect(screen.getByTestId("state-strip").textContent).toContain("Queued· 2 steps ready · next wake of DM in 2 h");
    cleanup();
    strip(status({ word: "stalled", reason: "2 steps ready; no persona assigned: nobody will wake" }, [{ ...item("M5-A1", "answered"), title: "Answer received, waiting for nobody scheduled to act" }]));
    const el = screen.getByTestId("state-strip");
    expect(el.getAttribute("data-state")).toBe("stalled");
    expect(el.className).not.toContain("red");
    expect(screen.getByTestId("answered-line").textContent).toContain("Answer received, waiting for nobody scheduled to act");
    cleanup();
    strip(status({ word: "nothing_to_do" }));
    expect(screen.getByTestId("state-strip").textContent).toContain("Nothing to do");
  });

  it("stripLines: several Monitoring items give one sentence each", () => {
    const st = milestoneState(status({ word: "monitoring", monitoring: [HOLD, { what: "DNS propagation", nextCheckAt: "2026-10-25T08:00:00Z" }] }));
    expect(stripLines(st, { now: NOW, timeZone: "UTC" })).toEqual([
      "Monitoring · 7-day hold, all 5 DoD green, day 1 of 7 · next check in 9 h (archiver delete proof (DOD-2)) · ready in 6 days if it stays green",
      "Monitoring · DNS propagation · next check in 15 h",
    ]);
  });

  it("holdProgress: day N of M clamps; zoned shows the zone", () => {
    expect(holdProgress(HOLD, NOW)).toMatchObject({ day: 1, days: 7 });
    expect(holdProgress(HOLD, Date.parse("2026-10-28T12:00:00Z"))).toMatchObject({ day: 5, days: 7 });
    expect(holdProgress(HOLD, Date.parse("2026-12-01T00:00:00Z"))).toMatchObject({ day: 7, fraction: 1 });
    expect(holdProgress({ since: HOLD.since }, NOW)).toBeUndefined();
    expect(zoned("2026-10-25T02:00:00Z", "Europe/Madrid")).toBe("Oct 25, 03:00 GMT+1");
  });
});

describe("failed wake that recovered", () => {
  it("shows a muted 'recovered at' note instead of the failed badge", () => {
    const failed = run("run_f", { outcome: "failed", startedAt: "2026-10-24T13:00:00Z", summary: "Run now failed: t3_thread_send: fetch failed" });
    const next = run("run_n", { outcome: "progressed", startedAt: "2026-10-24T15:00:00Z" });
    expect(recoveredAt(failed, [next, failed])).toBe(next.startedAt);
    expect(recoveredAt(failed, [failed])).toBeUndefined();
    expect(recoveredAt(failed, [{ ...next, outcome: "failed" }, failed])).toBeUndefined();
    render(
      <MemoryRouter>
        <RunTimeline groups={timelineGroups([failed, next], [asg()])} personas={[]} now={NOW} />
      </MemoryRouter>,
    );
    const note = screen.getByTestId("recovered");
    expect(note.textContent).toMatch(/^failed · recovered (\d+ (min|h|days?|weeks?|months?|years?) ago|just now)$/);
    expect(note.getAttribute("title")).toMatch(/went on at Oct 24/);
    expect(note.className).toContain("zinc");
  });
});

describe("sidebar word and Team badge", () => {
  it("each goal row is its circle, name and pills (no state word); the Team badge is the batch's needsYou", async () => {
    const m = await api.createMilestone({ title: "Held epic", repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam" });
    vi.spyOn(api, "listStatus").mockResolvedValue({
      milestones: [{ ...status({ word: "monitoring", monitoring: [HOLD] }), milestoneId: m.id }],
      items: [item("X-A1"), item("X-A2")],
      needsYou: 2,
      at: new Date(NOW).toISOString(),
    });
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    const link = (await screen.findByText("Held epic")).closest("a")!;
    await vi.waitFor(() => expect(link.querySelector('[data-testid="sidebar-goal-wheel"]')).toBeTruthy());
    expect(link.querySelector('[data-testid="sidebar-state"]')).toBeNull();
    expect((await screen.findByTestId("waiting-count")).textContent).toBe("2");
  });
});
