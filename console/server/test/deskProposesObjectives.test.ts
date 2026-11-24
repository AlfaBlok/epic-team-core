import { describe, expect, it } from "vitest";
import { deskSeed, SEED_VERSION, updateMessage } from "../src/desk/desk.js";
import { MILESTONE_SEED_VERSION, milestoneEndpointLines } from "../src/desk/milestoneChat.js";

// The owner, voice note of 2026-11-24 06:11Z: "you can push me to be good with the definitions of the objectives ...
// let's translate this into objectives and results that we will measure"; his card note of 07:15Z: "Extend this to epic social".
describe("a goal he talks about is proposed back as an objective with measured key results", () => {
  it("the Team desk's seed and every update carry the rule and the tool", () => {
    const seed = deskSeed({ persona: { name: "Team desk", remit: "r" }, publicUrl: "https://c.test", reposRoot: "/r" });
    const update = updateMessage("https://c.test");
    for (const s of [seed, update]) {
      expect(s).toContain("- A goal he talks about becomes an objective to measure (his voice note");
      expect(s).toContain("scripts/objective_proposal.py check");
      expect(s).toContain("never \"5 testers\"");
    }
    expect(update).toContain("objective_proposal.py check, then ask");
    expect(SEED_VERSION).toBeGreaterThanOrEqual(53);
  });

  it("every repo desk, the social world's too, carries it", () => {
    const lines = milestoneEndpointLines("https://c.test", { id: "ms_x" }, "world2").join("\n");
    expect(lines).toContain("Extend this to epic social");
    expect(lines).toContain("objective_proposal.py check");
    expect(lines).toContain("https://c.test/api/needs-owner");
    expect(MILESTONE_SEED_VERSION).toBeGreaterThanOrEqual(16);
  });
});
