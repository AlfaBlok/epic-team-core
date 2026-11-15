import { describe, expect, it } from "vitest";
import { HIS_NOTES_RULE, workerBriefRules, X_LINKS_RULE } from "../src/cycle/prompts.js";

// every worker reads all the owner's notes on its row and its sibling rows, whatever its brief quoted
describe("his notes rule", () => {
  it("rides in every worker brief, before the X links rule that stays last", () => {
    const rules = workerBriefRules();
    expect(rules).toContain(HIS_NOTES_RULE);
    expect(rules[rules.length - 1]).toBe(X_LINKS_RULE);
  });
  it("names the tool, the sibling rows and the repeat rule", () => {
    expect(HIS_NOTES_RULE).toContain("scripts/card_notes.py words <your row>");
    expect(HIS_NOTES_RULE).toContain("rows the same ask sits on");
    expect(HIS_NOTES_RULE).toContain("L-73");
    expect(HIS_NOTES_RULE).not.toMatch(/\bJordi\b/);
  });
});
