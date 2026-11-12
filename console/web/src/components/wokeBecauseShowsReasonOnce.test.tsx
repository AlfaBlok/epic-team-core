// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WokeBecause } from "@/components/common";

afterEach(cleanup);

// a real cadence wake shows why it woke, kept after the persona's report replaces the summary.
describe("WokeBecause", () => {
  it("shows the reason once the report replaced the summary", () => {
    render(<WokeBecause run={{ wokeBecause: "spines changed", summary: "progressed: S2 merged" }} />);
    expect(screen.getByTestId("woke-because").textContent).toBe("Woke because: spines changed");
  });
  it("hidden while the summary still says it, and on runs without one", () => {
    render(<WokeBecause run={{ wokeBecause: "spines changed", summary: "Woke on cadence · woke: spines changed" }} />);
    render(<WokeBecause run={{ summary: "Run now: woke" }} />);
    expect(screen.queryByTestId("woke-because")).toBeNull();
  });
});
