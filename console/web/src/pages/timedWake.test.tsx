// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Assignment } from "@/api";
import { NextWake } from "@/pages/Milestone";
import { OutcomeBadge, outcomeLabel } from "@/components/common";
import { milestoneTiming, nextWake } from "@/lib/derive";

afterEach(() => cleanup());

const inMin = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const asg = (over: Partial<Assignment>) =>
  ({ id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 240 }, enabled: true, ...over }) as Assignment;

describe("M2-42 ended without report + timed wake", () => {
  it("blank_report reads as an attention state, never green", () => {
    expect(outcomeLabel("blank_report")).toBe("Ended without report");
    render(<OutcomeBadge outcome="blank_report" />);
    const b = screen.getByText("Ended without report");
    expect(b.className).not.toMatch(/green|emerald/);
    expect(b.getAttribute("title")).toContain("not progress");
  });

  it("the earlier of cadence and retryAt wins; retryAt fires even when the assignment is off", () => {
    const retry = inMin(15);
    expect(nextWake(asg({ nextRunAt: inMin(240), retryAt: retry, retryRunId: "run_t5" }))).toEqual({ at: retry, retry: { runId: "run_t5" } });
    const cad = inMin(5);
    expect(nextWake(asg({ nextRunAt: cad, retryAt: retry }))).toEqual({ at: cad });
    expect(nextWake(asg({ enabled: false, nextRunAt: cad, retryAt: retry })).at).toBe(retry);
    expect(milestoneTiming("ms_1", [asg({ nextRunAt: inMin(240), retryAt: retry })], []).nextRunAt).toBe(retry);
  });

  it("the Personas card shows the timed wake and the run that asked for it", () => {
    const retry = "2099-10-22T06:10:00.000Z";
    render(<NextWake a={asg({ nextRunAt: "2099-10-22T10:00:00.000Z", retryAt: retry, retryRunId: "run_03ebb35a" })} paused={false} />);
    expect(screen.getByTestId("timed-wake").textContent).toMatch(/^next in \d+ years \(requested by run run_03ebb35a\)$/);
    expect(screen.getByTestId("timed-wake").getAttribute("title")).toMatch(/^Timed wake at Oct 22, 2099/);
    cleanup();
    render(<NextWake a={asg({ retryAt: retry })} paused />);
    expect(screen.getByText("next —")).toBeTruthy();
  });
});
