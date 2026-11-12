// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Assignment, Persona, Run } from "@/api";
import { RunTimeline } from "@/components/timeline";
import { timelineGroups } from "@/lib/derive";

/** steer notes come from run.steers (kept apart from the summary), one note per steer. */
afterEach(() => cleanup());

describe("T6-S4 steer notes in Activity", () => {
  it("shows each steer as its own note beside the persona's summary", () => {
    const assignments: Assignment[] = [{ id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true }];
    const personas = [{ id: "pe_1", name: "Delivery Manager" }] as Persona[];
    const r: Run = {
      id: "r1",
      assignmentId: "as_1",
      milestoneId: "ms_1",
      startedAt: "2026-10-24T01:00:00Z",
      endedAt: "2026-10-24T01:05:00Z",
      outcome: "progressed",
      summary: "persona rewrote this",
      steers: [
        { at: "2026-10-24T01:01:00Z", mode: "steer", message: "focus on E904 first" },
        { at: "2026-10-24T01:02:00Z", mode: "auto", message: "then ship" },
      ],
    };
    render(<RunTimeline groups={timelineGroups([r], assignments)} personas={personas} />);
    const g = screen.getByRole("region", { name: "runs of Delivery Manager" });
    const notes = within(g).getAllByTestId("run-note").map((n) => n.querySelector("summary")!.textContent);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^Sam steered .*: focus on E904 first$/);
    expect(notes[1]).toMatch(/^Sam steered \(queued\) .*: then ship$/);
    expect(within(g).getByText("persona rewrote this")).toBeTruthy();
  });
});
