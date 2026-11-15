import { describe, expect, it } from "vitest";
import { hisViewRecipe, workerBriefRules } from "../src/cycle/prompts.js";

// every worker brief carries the recipe for the owner's whole view on a topic from the memory service in one step.
describe("his view recipe", () => {
  it("rides in the worker brief rules and names the script, the search and the store step", () => {
    const r = hisViewRecipe();
    expect(workerBriefRules().some((x) => x.includes(r))).toBe(true);
    expect(r).toContain("scripts/his_view.py <topic words>");
    expect(r).toContain("`view <topic>`");
    expect(r).toContain("store_memory");
    expect(r).toMatch(/'s view: <topic>/);
  });
});
