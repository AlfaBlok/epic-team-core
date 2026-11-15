import { describe, expect, it } from "vitest";
import { ROW_CLOSE_RULE } from "../src/cycle/prompts.js";
import { FEATURE_LIST_RULE } from "../src/review/cardRule.js";
import { REVIEW_RULE } from "../src/review/review.js";

// a row that ships something a user can see also names its hero journey in the catalog as planned.
describe("E84-4 hero journey habit", () => {
  it("the feature-list rule names the catalog and the planned status", () => {
    expect(FEATURE_LIST_RULE).toContain("docs/features/hero-journeys.json");
    expect(FEATURE_LIST_RULE).toContain("`planned`");
  });
  it("reaches the worker brief and the wake's review rule", () => {
    expect(ROW_CLOSE_RULE).toContain("Hero journey");
    expect(REVIEW_RULE).toContain("Hero journey");
  });
});

// No message of an approved plan and no ask of the owner, no clip.
describe("no message, no video", () => {
  it("the rule every worker and wake reads says when a clip is made", () => {
    expect(FEATURE_LIST_RULE).toContain("planned makes no clip");
    expect(FEATURE_LIST_RULE).toContain("only when it carries one of the messages");
    expect(FEATURE_LIST_RULE).toContain("never a branded clip");
    expect(FEATURE_LIST_RULE).not.toContain("so it is recorded as a short clip");
    expect(ROW_CLOSE_RULE).toContain("never a branded clip");
  });
});
