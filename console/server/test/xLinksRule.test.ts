import { describe, expect, it } from "vitest";
import { workerBriefRules, X_LINKS_RULE } from "../src/cycle/prompts.js";

// every worker brief points at the X links the owner sent that touch its row (tags and data-graph nodes).
describe("X links rule", () => {
  it("is the last worker brief rule and names the lookup by row and the search", () => {
    const rules = workerBriefRules();
    expect(rules[rules.length - 1]).toBe(X_LINKS_RULE);
    expect(X_LINKS_RULE).toContain("scripts/x_links.py for <your row>");
    expect(X_LINKS_RULE).toContain("x_links.py search");
  });
});
