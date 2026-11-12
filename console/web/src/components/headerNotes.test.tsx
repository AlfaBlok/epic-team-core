// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MilestoneStatusView, Run } from "@/api";
import { MilestoneStrip, wakeNoteLine } from "@/components/status";
import { OutcomeBadge } from "@/components/common";
import { wakesDidSomething } from "@/lib/derive";
import { wakesDidSomething as serverWakesDidSomething } from "../../../server/src/runStats";
import { WakesDidSomething } from "@/pages/Team";

/** an idle wake stays idle (ignored ready steps shown); repeated reports read "same report ×n since <time>". */

afterEach(cleanup);

const NOW = Date.parse("2026-10-25T12:00:00Z");
const run = (id: string, over: Partial<Run> = {}): Run => ({ id, assignmentId: "a1", startedAt: "2026-10-25T10:00:00Z", endedAt: "2026-10-25T10:05:00Z", outcome: "progressed", summary: id, kind: "wake", ...over });

const STATUS: MilestoneStatusView = {
  milestoneId: "ms_1",
  outcome: { word: "not_yet", source: "derived" },
  flow: { word: "queued", reason: "2 steps ready; next wake of steward", nextWakeAt: "2026-10-25T14:00:00Z", personas: ["steward"] },
  items: [],
  needsYou: 0,
  reasons: [],
  wakeNotes: [
    { kind: "ready_ignored", persona: "steward", runId: "r1", steps: ["VH-T16", "VH-T6"], text: "steward says nothing is runnable, but 2 steps read ready: VH-T16, VH-T6: fix the step status or work them" },
    { kind: "repeating", persona: "unblocker", runId: "r2", n: 12, since: "2026-10-25T06:00:00Z", text: "unblocker: same report ×12 since 2026-10-25 06:00Z" },
  ],
};

describe("T13-S11 header notes", () => {
  it("the strip names the ignored ready steps and the repeat, never as pending items", () => {
    render(
      <MemoryRouter>
        <MilestoneStrip status={STATUS} now={NOW} timeZone="UTC" />
      </MemoryRouter>,
    );
    const notes = screen.getAllByTestId("wake-note");
    expect(notes.map((n) => n.getAttribute("data-kind"))).toEqual(["ready_ignored", "repeating"]);
    expect(notes[0].textContent).toBe("steward says nothing is runnable, but 2 steps read ready: VH-T16, VH-T6: fix the step status or work them");
    expect(notes[1].textContent).toMatch(/^unblocker: same report ×12 since 6 h ago$/);
    expect(wakeNoteLine(STATUS.wakeNotes![1], NOW)).toBe(notes[1].textContent);
  });
});

describe("T13-S11 Activity badges", () => {
  it("an idle run with ready steps shows Idle + 'ignored N ready'; a repeat shows 'same report ×n since'", () => {
    render(<OutcomeBadge outcome="idle" run={run("r1", { outcome: "idle", readyIgnored: ["T2", "T3"] })} />);
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByTestId("ready-ignored").textContent).toBe("ignored 2 ready");
    cleanup();
    render(<OutcomeBadge outcome="blocked" run={run("r2", { outcome: "blocked", summary: "blocked: waits on T0-A11", repeating: 5, repeatSince: new Date(Date.now() - 3 * 3_600_000).toISOString() })} />);
    expect(screen.getByTestId("repeating").textContent).toMatch(/^same report ×5 since 3 h ago$/);
  });
});

describe("T13-S11 wakes that did something (24 h)", () => {
  const now = new Date(NOW);
  const runs = [
    run("p1"),
    run("p2", { repeating: 4, repeatSince: "2026-10-25T04:00:00Z" }), // a repeat is not progress
    run("i1", { outcome: "idle", readyIgnored: ["T2"] }), // an idle with ready steps stays idle
    run("b1", { outcome: "blocked" }),
    run("c1", { parentRunId: "p1" }), // a worker, not a wake
    run("live", { outcome: "running", endedAt: undefined }),
    run("old", { startedAt: "2026-10-23T10:00:00Z", endedAt: "2026-10-23T10:05:00Z" }),
  ];
  it("counts progressed, non-repeating ended wakes of the last 24 h", () => {
    expect(wakesDidSomething(runs, now)).toEqual({ did: 1, total: 4 });
  });
  // the server counts (/api/runs/stats `wakes24h`, every run since now − 24 h, no 500 cap: server
  // test/getApiRunsStats.test.ts); its rule is this one (runsPageLinePer.test.tsx), and the footer says it.
  it("the server's count is this rule", () => {
    expect(serverWakesDidSomething(runs, now)).toEqual(wakesDidSomething(runs, now));
  });
  it("the Team footer says the server's count, and nothing when no wake ended", () => {
    const { unmount } = render(<WakesDidSomething counts={{ did: 1, total: 4 }} />);
    expect(screen.getByTestId("wakes-did-something").textContent).toBe("1 of 4 wakes in 24 h did something");
    unmount();
    render(<WakesDidSomething counts={{ did: 0, total: 0 }} />);
    expect(screen.queryByTestId("wakes-did-something")).toBeNull();
  });
});
