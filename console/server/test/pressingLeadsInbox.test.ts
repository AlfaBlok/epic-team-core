import { describe, expect, it } from "vitest";
import { byMilestonePriority, TIER_SPAN } from "../src/inbox/priority.js";
import { lookupOf, parsePressing, parsePriorities, parseRedLines, PRESSING_MAX, PRESSING_TIER, tierOf } from "../src/inbox/jordiPriority.js";

/**
 * a general rule, no section of its own: an item tied to something the owner said with frustration or said again
 * (the levels file's `pressing`) leads every inbox list, above the red line, until it is answered or closed.
 */
const file = JSON.stringify({
  items: [
    { repo: "repo1", ref: "E907-S1", level: "high", why: "High." },
    { repo: "repo1", ref: "E907-S3", level: "low", why: "Low." },
  ],
  redLines: [{ sentence: "Ship it.", state: "agreed", items: [{ repo: "repo1", ref: "E907-S2" }] }],
  pressing: [
    { repo: "repo1", ref: "E907-S3", kind: "frustrated", why: "You said it frustrates you.", words: "this is extremely frustrating", said: "2026-11-15", source: "vn_0001" },
    { repo: "repo1", ref: "E907-A9", kind: "repeated", why: "You asked for it again." },
    { repo: "repo1", ref: "EPIC-907", path: "docs/spines/e7.md", kind: "repeated", why: "Epic." },
    { repo: "repo1", ref: "E907-S4", kind: "angry", why: "Broken kind is skipped." },
    { repo: "repo1", ref: "E907-S5", kind: "repeated" },
  ],
});

describe("pressing: frustration and repeats lead the inbox", () => {
  const lookup = lookupOf(parsePriorities(file, "repo1"), parseRedLines(file, "repo1"), parsePressing(file, "repo1"));

  it("reads only well-formed entries, at most PRESSING_MAX", () => {
    expect(parsePressing(file, "repo1").map((e) => e.ref)).toEqual(["E907-S3", "E907-A9", "EPIC-907"]);
    const many = JSON.stringify({ pressing: Array.from({ length: 12 }, (_, n) => ({ ref: `E907-S${n + 10}`, kind: "repeated", why: "x" })) });
    expect(parsePressing(many, "repo1")).toHaveLength(PRESSING_MAX);
    expect(parsePressing("not json", "repo1")).toEqual([]);
  });

  it("marks a row, an ask and an epic's own status item; keeps the level it had", () => {
    const row = lookup({ repo: "repo1", ref: "E907-S3" });
    expect(row?.pressing?.kind).toBe("frustrated");
    expect(row?.level).toBe("low");
    expect(row?.pressing?.words).toBe("this is extremely frustrating");
    expect(lookup({ repo: "repo1", code: "E907-A9", row: "E907-S8" })?.pressing?.kind).toBe("repeated");
    expect(lookup({ repo: "repo1", path: "docs/spines/e7.md" })?.pressing).toBeTruthy();
    // an ask in that epic is not pulled up by the epic entry, and another repo never matches
    expect(lookup({ repo: "repo1", path: "docs/spines/e7.md", code: "E907-A1" })?.pressing).toBeUndefined();
    expect(lookup({ repo: "repo2", ref: "E907-S3" })?.pressing).toBeUndefined();
  });

  it("sorts above the red line and every level", () => {
    const items = [
      { repo: "repo1", ref: "E907-S1", milestoneId: "m1" },
      { repo: "repo1", ref: "E907-S2", milestoneId: "m1" },
      { repo: "repo1", ref: "E907-S9", milestoneId: "m1" },
      { repo: "repo1", ref: "E907-S3", milestoneId: "m2" },
    ];
    const out = byMilestonePriority(items, new Map([["m1", 0], ["m2", 1]]), lookup);
    expect(out.map((i) => i.ref)).toEqual(["E907-S3", "E907-S2", "E907-S1", "E907-S9"]);
    expect(out[0].priority!).toBeLessThan(0);
    expect(out[0].priority!).toBeGreaterThan(-TIER_SPAN);
    expect(tierOf(out[0].ownerPriority)).toBe(PRESSING_TIER);
  });

  it("no pressing entries: the order is exactly as before", () => {
    const plain = lookupOf(parsePriorities(file, "repo1"), parseRedLines(file, "repo1"));
    expect(plain({ repo: "repo1", ref: "E907-S3" })?.pressing).toBeUndefined();
    expect(plain({ repo: "repo1", ref: "E907-S3" })?.level).toBe("low");
  });
});
