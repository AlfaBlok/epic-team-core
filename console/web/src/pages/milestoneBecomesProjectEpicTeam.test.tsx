import { describe, expect, it } from "vitest";
import { SKINS, cap, focusHeading } from "@/lib/skin";
import { remitHint } from "@/components/dialogs";

// EpicTeam's screens say project;
// routes, API and table names keep milestone, and the social skin keeps its own words.
describe("T101-S9 milestone becomes project on EpicTeam's screens", () => {
  it("the console skin's words say project", () => {
    const w = SKINS.console.words;
    expect([w.milestones, w.milestone, w.milestonesWord, w.addMilestone]).toEqual(["Projects", "project", "projects", "Add project"]);
    expect(focusHeading(w)).toBe("Focus projects");
    expect(cap(w.milestone)).toBe("Project");
    expect(remitHint(w.milestone)).toBe("Write the job, not the project. At each wake the persona is told which project, repo and spine it is working on.");
  });

  it("the social skin says campaign where EpicTeam says project", () => {
    const w = SKINS.social.words;
    expect([w.milestones, w.milestone, w.milestonesWord, w.addMilestone]).toEqual(["Campaigns", "campaign", "campaigns", "Add campaign"]);
    expect(focusHeading(w)).toBe("Campaigns");
  });
});
