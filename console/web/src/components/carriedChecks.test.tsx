// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RunChecks } from "@/components/runChecks";

/** a carried verdict (the Unblocker's per-ask memory) reads `left (unchanged since <run>)`. */
afterEach(() => cleanup());

describe("T8-S24 carried checks", () => {
  it("shows carried asks as left (unchanged since <run>) with the remembered why; assessed ones as before", () => {
    render(
      <RunChecks
        checks={[
          { code: "T0-A13", decision: "answered", answer: "use the fleet key", confidence: 85 },
          { code: "T0-A11", decision: "left", why: "QR scan needs Sam's phone", carriedFrom: "run_abc" },
          { code: "T0-A12", decision: "left", why: "key not found", carriedFrom: "run_abc", skipped: true },
        ]}
      />,
    );
    const rows = screen.getAllByTestId("run-check");
    expect(rows[0].textContent).toContain("answered");
    expect(rows[1].textContent).toContain("left (unchanged since run_abc)");
    expect(rows[1].textContent).toContain("QR scan needs Sam's phone");
    expect(rows[2].textContent).toContain("left (unchanged since run_abc)");
    expect(rows[2].textContent).not.toContain("not re-checked");
  });
});
