// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type MilestoneStatusView, type Run } from "@/api";
import { MilestoneStrip } from "@/components/status";
import { RunTimeline } from "@/components/timeline";
import { RunNowDialog } from "@/components/dialogs";
import { timelineGroups } from "@/lib/derive";
import { scheduleLabel } from "@/lib/format";

/** the Stalled item's actions (orange, never red), and 'off' instead of the cadence of a switched-off persona. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = Date.parse("2026-10-24T17:00:00Z");
const STALLED: MilestoneStatusView = {
  milestoneId: "ms_15",
  outcome: { word: "not_yet", source: "derived" },
  flow: { word: "stalled", reason: "2 steps ready; 3 personas assigned, none enabled and scheduled: nobody will wake" },
  items: [
    {
      id: "stalled:ms_15",
      kind: "stalled",
      state: "alarm",
      milestoneId: "ms_15",
      title: "2 steps ready, nobody on. Switch on Diagnostician?",
      switchOn: [{ assignmentId: "as_d", persona: "Diagnostician" }],
    },
  ],
  needsYou: 0,
  reasons: [],
};
const asg = (over: Partial<Assignment> = {}) =>
  ({ id: "as_d", milestoneId: "ms_15", personaId: "p_d", cadence: { type: "interval", everyMinutes: 180 }, enabled: false, createdAt: "2026-10-20T00:00:00Z", ...over }) as Assignment;

describe("Stalled item", () => {
  it("the goal page's stalled line is the inbox card: his question, Switch on in one tap, Leave it off (E948-S204)", async () => {
    const update = vi.spyOn(api, "updateAssignment").mockResolvedValue(asg({ enabled: true }));
    render(
      <MemoryRouter>
        <MilestoneStrip status={STALLED} now={NOW} timeZone="UTC" />
      </MemoryRouter>,
    );
    const strip = screen.getByTestId("state-strip");
    expect(strip.className).not.toContain("orange"); // one grey frame
    expect(strip.className).not.toContain("red");
    expect(screen.getByTestId("status-item-question").textContent).toBe("Should a team member work on it?");
    expect(screen.getByTestId("stalled-leave-off").textContent).toContain("Leave it off");
    expect(screen.queryByRole("button", { name: /^(?:Yes|No|Answer)\b/ })).toBeNull();
    fireEvent.click(screen.getByTestId("stalled-switch-on"));
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith("as_d", { enabled: true }));
  });
});

describe("honest 'off'", () => {
  it("scheduleLabel: cadence while on, 'off' while off", () => {
    expect(scheduleLabel(asg({ enabled: true }))).toBe("every 3 h");
    expect(scheduleLabel(asg())).toBe("off");
  });

  it("Activity header shows 'off', not 'every 3 h', for a disabled assignment", () => {
    const run = { id: "r1", assignmentId: "as_d", milestoneId: "ms_15", startedAt: "2026-10-24T15:00:00Z", endedAt: "2026-10-24T15:20:00Z", outcome: "progressed", summary: "R3 done", kind: "wake" } as Run;
    render(
      <MemoryRouter>
        <RunTimeline groups={timelineGroups([run], [asg()])} personas={[]} now={NOW} />
      </MemoryRouter>,
    );
    const label = screen.getByTestId("schedule-label");
    expect(label.textContent).toBe("off");
    expect(label.getAttribute("title")).toContain("every 3 h");
  });

  it("Run now on an off assignment says the wake is one-off", () => {
    render(<RunNowDialog open onOpenChange={() => {}} assignment={asg()} personaName="Diagnostician" />);
    expect(screen.getByTestId("one-off-wake").textContent).toContain("Diagnostician is off: this is a one-off wake");
    cleanup();
    render(<RunNowDialog open onOpenChange={() => {}} assignment={asg({ enabled: true })} personaName="Diagnostician" />);
    expect(screen.queryByTestId("one-off-wake")).toBeNull();
  });
});
