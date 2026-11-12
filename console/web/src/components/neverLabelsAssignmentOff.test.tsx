// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NeverOnBadge } from "./neverOn";
import { assignmentRunStats } from "@/lib/derive";
import type { Run } from "@/api/types";

afterEach(cleanup);

describe("T6-S7 never on", () => {
  it("labels an assignment that is off and has never been on", () => {
    render(<NeverOnBadge a={{ enabled: false, neverOn: true }} />);
    expect(screen.getByText("never on")).toBeTruthy();
  });
  it("shows nothing once it has been on, or while on", () => {
    const { container: off } = render(<NeverOnBadge a={{ enabled: false, neverOn: false }} />);
    expect(off.textContent).toBe("");
    const { container: on } = render(<NeverOnBadge a={{ enabled: true, neverOn: false }} />);
    expect(on.textContent).toBe("");
  });
  it("a toggle line is not counted as a wake", () => {
    const runs: Run[] = [
      { id: "r1", assignmentId: "a1", startedAt: "2026-10-24T10:00:00Z", outcome: "idle", summary: "Woke on cadence", kind: "wake" },
      { id: "r2", assignmentId: "a1", startedAt: "2026-10-24T11:00:00Z", outcome: "idle", summary: "toggle on→off: switched off by Sam", kind: "toggle" },
    ];
    const s = assignmentRunStats("a1", runs);
    expect(s.count).toBe(1);
    expect(s.last?.id).toBe("r1");
  });
});
