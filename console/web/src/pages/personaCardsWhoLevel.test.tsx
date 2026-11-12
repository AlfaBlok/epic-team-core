// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type Milestone, type Persona } from "@/api";
import { PersonasPage, levelOf, whoOf } from "@/pages/Personas";

// a persona's card says who it is, the level it runs at and how often.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("T76-S2 persona cards: who, level, cadence", () => {
  it("whoOf takes the remit's first sentence and skips headings", () => {
    expect(whoOf("You are the Gap finder. Once a day you find gaps.")).toBe("You are the Gap finder.");
    expect(whoOf("# Team desk persona: remit\n\nOne full T3 persona. More.")).toBe("One full T3 persona.");
  });

  it("levelOf names the root or one epic", () => {
    expect(levelOf({ repo: "Acme/home_repo", path: "docs/spines/root.md" })).toBe("home_repo root, every epic");
    expect(levelOf({ repo: "Acme/home_repo", path: "docs/spines/epic-76.md" })).toBe("one epic of home_repo");
  });

  it("the card shows who, level and cadence", async () => {
    vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "pe_p", name: "Prioritizer", remit: "You are the Prioritizer. Each day you propose.", skills: [], model: "opus", mayWrite: true, createdAt: "" } as Persona]);
    vi.spyOn(api, "listAssignments").mockResolvedValue([
      { id: "as_1", milestoneId: "ms_r", personaId: "pe_p", cadence: { type: "fixed_time", timeOfDay: "13:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, enabled: true } as unknown as Assignment,
    ]);
    vi.spyOn(api, "listMilestones").mockResolvedValue([{ id: "ms_r", title: "home_repo", repo: "Acme/home_repo", path: "docs/spines/root.md" } as unknown as Milestone]);
    vi.spyOn(api, "listRuns").mockResolvedValue([]);
    render(
      <MemoryRouter>
        <PersonasPage />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("persona-who")).textContent).toBe("You are the Prioritizer.");
    const runs = await screen.findByTestId("persona-runs");
    expect(runs.textContent).toContain("home_repo root, every epic");
    expect(runs.textContent).toContain("daily at 13:00");
  });
});
