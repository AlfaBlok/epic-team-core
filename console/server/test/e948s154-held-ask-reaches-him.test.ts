import { describe, expect, it } from "vitest";
import { HOLD_LIMIT_MS, NOT_CHECKED_NOTE, dryRunOverdue, dryRunProblem, lineHash, parseDryRuns } from "../src/inbox/askDryRun.js";

/**
 * E948-S154 (the owner, vn_c4ac0561, 20 Nov: "an ask written in a spine never reaches his inbox ... fix it so a held ask
 * always reaches him plainly"): a dry-run hold lasts 2 hours at most, then the ask reaches him marked by one line.
 */
const RAW = "- [ask E907-A3: do @Sam since 2026-11-20] Open airbnb.com/hosting and tap Accept";
const WROTE = "2026-11-20T10:00:00.000Z";
const at = (h: number) => Date.parse(WROTE) + h * 3_600_000;
const verdicts = (verdict: "pass" | "fail", raw = RAW) =>
  parseDryRuns(JSON.stringify({ items: { a: { repo: "w", path: "s.md", code: "E907-A3", lineHash: lineHash(raw), verdict, reason: "step 1: which listing" } } }));
const none = parseDryRuns(JSON.stringify({ items: {} }));

describe("E948-S154 a held ask always reaches him plainly", () => {
  it("the gate says the real wait: 5 min sweeps, and 2 hours at most", () => {
    expect(dryRunProblem(RAW, "2026-11-20", none)).toMatch(/every 5 min.*past 2 hours/);
    expect(dryRunProblem(RAW, "2026-11-20", none)).not.toMatch(/15 min/);
  });

  it("a new ask with no verdict is held under 2 hours and says when it turns overdue", () => {
    const o = dryRunOverdue(RAW, "2026-11-20", none, WROTE, at(1.5));
    expect(o.note).toBeUndefined();
    expect(o.releaseAt).toBe(Date.parse(WROTE) + HOLD_LIMIT_MS);
  });

  it("past 2 hours with no verdict it reaches him marked not checked yet", () => {
    expect(dryRunOverdue(RAW, "2026-11-20", none, WROTE, at(2.01))).toEqual({ note: NOT_CHECKED_NOTE, kind: "not-checked" });
    expect(NOT_CHECKED_NOTE).toMatch(/^Not checked yet/);
  });

  it("past 2 hours after a failed dry run it reaches him with what the fresh reader found unclear", () => {
    const o = dryRunOverdue(RAW, "2026-11-20", verdicts("fail"), WROTE, at(3));
    expect(o.kind).toBe("unclear");
    expect(o.note).toBe("A fresh reader found this unclear: step 1: which listing");
    // an old ask whose words failed days ago reaches him at once
    expect(dryRunOverdue(RAW, "2026-11-16", verdicts("fail"), "2026-11-16T09:00:00Z", at(0)).kind).toBe("unclear");
  });

  it("a passed or ungated ask has nothing to mark, and uncommitted words are never timed out", () => {
    expect(dryRunOverdue(RAW, "2026-11-20", verdicts("pass"), WROTE, at(5))).toEqual({});
    expect(dryRunOverdue(RAW, "2026-11-10", none, WROTE, at(5))).toEqual({});
    expect(dryRunOverdue(RAW, "2026-11-20", none, undefined, at(5))).toEqual({});
    expect(dryRunOverdue(RAW, "2026-11-20", undefined, WROTE, at(5))).toEqual({});
  });

  it("new words restart the clock from when they were committed", () => {
    const reworded = RAW + " on the Today tab";
    expect(dryRunOverdue(reworded, "2026-11-20", verdicts("fail"), new Date(at(4)).toISOString(), at(5)).note).toBeUndefined();
    expect(dryRunOverdue(reworded, "2026-11-20", verdicts("fail"), new Date(at(4)).toISOString(), at(6.5)).kind).toBe("not-checked");
  });
});
