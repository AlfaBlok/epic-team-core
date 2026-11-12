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
