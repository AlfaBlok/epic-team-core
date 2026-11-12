// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RunChecks } from "@/components/runChecks";

/** each assessed check shows the rubric score it was judged by (and the floor items it touches). */
afterEach(() => cleanup());

const weights = { reversal: 3, options: 1.5, impact: 2, evidence: 3.5 };
describe("T8-S26 rubric scores in Activity", () => {
  it("shows score/threshold and the four factors on answered and left checks; nothing for older checks", () => {
    render(
      <RunChecks
        checks={[
          { code: "T0-A13", decision: "answered", answer: "use the fleet key", confidence: 85, scores: { reversal: 4, options: 3, impact: 3, evidence: 4 }, rubric: { score: 91, threshold: 75, minFactor: 1, weights, clears: true, from: "default" } },
          { code: "T0-A11", decision: "left", why: "QR scan", scores: { reversal: 4, options: 4, impact: 4, evidence: 4 }, floor: ["jordi_hands"], rubric: { score: 100, threshold: 75, minFactor: 1, weights, clears: false, from: "milestone" } },
          { code: "T0-A9", decision: "left", why: "before the rubric" },
        ]}
      />,
    );
    const rows = screen.getAllByTestId("run-check");
    expect(rows[0].textContent).toContain("score 91/75 (reversal 4 · options 3 · impact 3 · evidence 4)");
    expect(rows[1].textContent).toContain("score 100/75");
    expect(rows[1].textContent).toContain("floor: jordi_hands");
    expect(screen.getAllByTestId("rubric-score")[1].getAttribute("title")).toContain("settings: milestone");
    expect(rows[2].textContent).not.toContain("score");
  });
});
