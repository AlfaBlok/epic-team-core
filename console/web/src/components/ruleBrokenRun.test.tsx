// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Run } from "@/api";
import { OutcomeBadge, RuleBrokenLines } from "@/components/common";

/** a run whose commits broke its pack's rules shows "rule broken" (Activity) and the validator's lines (run detail). */

afterEach(cleanup);

const ISSUE = "bb9f4a3 pack social: data/posts-ledger.md P-0001: illegal status change scheduled -> posted by Writer (kind post)";
const run = (over: Partial<Run> = {}) =>
  ({ id: "r1", assignmentId: "a1", startedAt: "2026-10-27T00:00:00Z", outcome: "progressed", summary: "x", kind: "wake", ...over }) as Run;

describe("rule-broken run", () => {
  it("a red rule broken chip beside the outcome, the issue lines on hover", () => {
    render(<OutcomeBadge outcome="progressed" run={run({ ruleBroken: { at: "2026-10-27T01:00:00Z", roles: ["Writer"], issues: [ISSUE] } })} />);
    const chip = screen.getByTestId("rule-broken");
    expect(chip.textContent).toBe("rule broken");
    expect(chip.getAttribute("title")).toContain("(as Writer)");
    expect(chip.getAttribute("title")).toContain(ISSUE);
    expect(screen.getByText("Progressed")).toBeTruthy();
  });

  it("run detail lists the lines; nothing for a clean run", () => {
    const { container } = render(<RuleBrokenLines run={run({ ruleBroken: { at: "2026-10-27T01:00:00Z", roles: ["Writer"], issues: [ISSUE] } })} />);
    expect(screen.getByTestId("rule-broken-lines").textContent).toContain("Rule broken as Writer");
    expect(screen.getByText(ISSUE)).toBeTruthy();
    cleanup();
    const clean = render(<RuleBrokenLines run={run()} />);
    expect(clean.container.textContent).toBe("");
    expect(container).toBeTruthy();
  });
});
