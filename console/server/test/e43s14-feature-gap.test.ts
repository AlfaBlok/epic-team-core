import { describe, expect, it } from "vitest";
import { FEATURE_LIST_RULE, REVIEW_RULE } from "../src/review/review.js";
import { ROW_CLOSE_RULE } from "../src/cycle/prompts.js";

/**
 * the feature-list rule every wake and worker carries
 * names the check that flags an approved row with no feature line (the code repo scripts/feature_gap.py, tested by
 * scripts/test_feature_gap.py) and where a deliberate skip is written.
 */
describe("T43-S14 the feature gap check", () => {
  it("the rule names the check and the skip file, and the wake and the row close carry it", () => {
    expect(FEATURE_LIST_RULE).toContain("python3 scripts/feature_gap.py");
    expect(FEATURE_LIST_RULE).toContain("docs/features/not-features.json");
    expect(REVIEW_RULE).toContain("scripts/feature_gap.py");
    expect(ROW_CLOSE_RULE).toContain("scripts/feature_gap.py");
  });
});
