// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BlueprintView } from "@/components/blueprint";
import { OBJECTIVE_TABS } from "@/components/goalSets";

// EpicTeam's Blueprint chapter (his 28 Nov 12:47Z words, ^e-497258), right after Key results.
describe("Blueprint chapter", () => {
  afterEach(cleanup);
  it("is EpicTeam's chapter after Key results", () => {
    expect(OBJECTIVE_TABS.map((t) => t.label).slice(0, 3)).toEqual(["Key results", "Blueprint", "Plan"]);
  });
  it("shows what is built, its hard truths beside its parts", () => {
    render(<BlueprintView data={{ path: "p", present: true, what: "One console.", truths: ["One engine."], parts: ["Console: screens."] }} />);
    expect(screen.getByTestId("blueprint-what").textContent).toBe("One console.");
    expect(screen.getByTestId("blueprint-truths").textContent).toContain("One engine.");
    expect(screen.getByTestId("blueprint-parts").textContent).toContain("Console: screens.");
  });
  it("says where it goes when none is written", () => {
    render(<BlueprintView data={{ path: "docs/scorecards/blueprints/x.md", present: false, truths: [], parts: [] }} />);
    expect(screen.getByTestId("blueprint").textContent).toContain("docs/scorecards/blueprints/x.md");
  });
});
