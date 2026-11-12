// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Assignment, Persona, Run } from "@/api";
import { RunTimeline } from "@/components/timeline";
import { timelineGroups } from "@/lib/derive";

/** skipped Unblocker cadence wakes show collapsed as "Unblocker: nothing new". */
afterEach(() => cleanup());

const left: Run["checks"] = [{ code: "T0-A11", decision: "left", why: "QR scan needs Sam's phone" }];
const run = (id: string, hour: number, extra: Partial<Run> = {}): Run => ({
  id,
  assignmentId: "as_u",
  milestoneId: "ms_1",
  startedAt: `2026-10-24T${String(hour).padStart(2, "0")}:00:00Z`,
  endedAt: `2026-10-24T${String(hour).padStart(2, "0")}:00:01Z`,
  outcome: "idle",
  summary: `skipped: nothing new since run_real (T0-A11 still left: QR scan needs Sam's phone) ${id}`,
  checks: left!.map((c) => ({ ...c, skipped: true })),
  ...extra,
});
const assignments: Assignment[] = [{ id: "as_u", milestoneId: "ms_1", personaId: "pe_u", cadence: { type: "interval", everyMinutes: 60 }, enabled: true }];
const personas = [{ id: "pe_u", name: "Unblocker" }] as Persona[];

describe("T8-S15 nothing new in Activity", () => {
  it("collapses consecutive skipped wakes into one row; Show expands them; real wakes stay as they are", () => {
    const runs = [
      run("s5", 9),
      run("s4", 8),
      run("real2", 7, { summary: "answered 1 · left 1", checks: [{ code: "T0-A12", decision: "answered", answer: "key found", confidence: 90 }, left![0]] }),
      run("s2", 6),
      run("s1", 5),
      run("real", 4, { summary: "answered 0 · left 1", checks: left }),
    ];
    render(<RunTimeline groups={timelineGroups(runs, assignments)} personas={personas} />);
    const u = screen.getByRole("region", { name: "runs of Unblocker" });
    const rows = within(u).getAllByTestId("nothing-new");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Unblocker: nothing new");
    expect(rows[0].textContent).toContain("2 wakes skipped");
    expect(rows[0].textContent).toContain("s5"); // newest summary
    expect(within(u).queryByText(/summary s4|skipped: nothing new since run_real .* s4/)).toBeNull();
    expect(within(u).getByText("answered 1 · left 1")).toBeTruthy();
    expect(within(u).getAllByTestId("unblocker-chip")).toHaveLength(2); // only the two real wakes
    fireEvent.click(within(rows[0]).getByText("Show"));
    expect(within(u).getAllByTestId("unblocker-chip")).toHaveLength(4);
    expect(within(u).getAllByText(/not re-checked \(nothing new\)/).length).toBe(2);
  });
});
