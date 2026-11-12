// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Run } from "@/api";
import { OutcomeBadge, heldLabel } from "@/components/common";

/** a run held on an offline Team Browser egress shows "held: laptop offline", never "Needs you". */
afterEach(cleanup);

const run = (o: Partial<Run>): Run => ({ id: "run_1", assignmentId: "as_1", startedAt: "2026-10-24T22:00:00Z", outcome: "monitoring", summary: "inmuebles24 held", ...o });

describe("M5-B4 held chip", () => {
  it("a held monitoring run renders the held chip with the fallback check on hover", () => {
    render(<OutcomeBadge outcome="monitoring" run={run({ heldOn: "egress:laptop", nextCheckAt: "2026-10-25T04:00:00Z" })} />);
    const chip = screen.getByTestId("held-chip");
    expect(chip.textContent).toBe("held: laptop offline");
    expect(chip.getAttribute("data-word")).toBe("monitoring");
    expect(chip.getAttribute("title")).toContain("Fallback check");
  });

  it("a plain monitoring run and a held run that moved on keep the normal badge", () => {
    render(<OutcomeBadge outcome="monitoring" run={run({ nextCheckAt: "2026-10-25T04:00:00Z" })} />);
    render(<OutcomeBadge outcome="progressed" run={run({ outcome: "progressed", heldOn: "egress:laptop" })} />);
    expect(screen.queryByTestId("held-chip")).toBeNull();
    expect(heldLabel("egress:mx2")).toBe("held: mx2 offline");
  });
});
