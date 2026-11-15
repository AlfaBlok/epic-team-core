import { describe, expect, it } from "vitest";
import { DRY_RUN_FROM, dryRunProblem, lineHash, parseDryRuns } from "../src/inbox/askDryRun.js";
import { JUDGE_SCHEMAS } from "../src/review/qc.js";

/**
 * E996-S43 (the owner, Team desk 2026-11-13 20:52Z, after T9-A10: "had to beg for details, and in the end had to look
 * up myself where to paste the key"): no ask reaches him until a fresh agent completes it from the card alone.
 */
const RAW = "  - [ask T9-A10: provide @Sam since 2026-11-14]   Paste the key  ";
const verdicts = (verdict: "pass" | "fail", raw = RAW) =>
  parseDryRuns(JSON.stringify({ items: { "acme:T9-A10": { repo: "acme", path: "docs/x.md", code: "T9-A10", lineHash: lineHash(raw), verdict, reason: "step 2: it says the box but the card has none" } } }));

describe("E996-S43 the ask dry-run gate", () => {
  it("hashes the raw ask line the same way as scripts/ask_dryrun.py line_hash", () => {
    expect(lineHash(RAW)).toBe("884b704fde98295e");
    expect(lineHash("- [ask T9-A10: provide @Sam since 2026-11-14] Paste the key")).toBe(lineHash(RAW));
  });

  it("holds an ask whose current words failed the dry run, naming the step, whatever its date", () => {
    expect(dryRunProblem(RAW, "2026-11-01", verdicts("fail"))).toMatch(/^ask needs rewriting: step 2: it says the box but the card has none/);
    expect(dryRunProblem(RAW, "2026-11-20", verdicts("pass"))).toBeUndefined();
  });

  it("holds a new ask until its words are dry-run; an older ask with no verdict passes until the sweep reaches it", () => {
    const other = verdicts("fail", "- [ask T9-A11: do @Sam] something else");
    expect(dryRunProblem(RAW, DRY_RUN_FROM, other)).toMatch(/^waiting for its dry run/);
    expect(dryRunProblem(RAW, "2026-11-10", other)).toBeUndefined();
    expect(dryRunProblem(RAW, null, other)).toBeUndefined();
  });

  it("re-judges changed words: a fail on the old words does not hold the rewritten ask", () => {
    const rewritten = "- [ask T9-A10: provide @Sam since 2026-11-10] Paste the key in the box Paste the key here on this card";
    expect(dryRunProblem(rewritten, "2026-11-10", verdicts("fail"))).toBeUndefined();
  });

  it("never holds anything when the verdicts file is missing or the line is unknown", () => {
    expect(dryRunProblem(RAW, DRY_RUN_FROM, undefined)).toBeUndefined();
    expect(dryRunProblem(undefined, DRY_RUN_FROM, verdicts("fail"))).toBeUndefined();
  });

  it("offers the judge route a dryrun answer shape", () => {
    expect(JUDGE_SCHEMAS.dryrun.required).toEqual(["steps", "verdict", "firstProblem"]);
  });
});
