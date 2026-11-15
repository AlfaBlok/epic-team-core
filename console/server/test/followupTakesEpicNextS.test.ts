import { describe, expect, it } from "vitest";
import { followupBase, writeFollowups } from "../src/review/followups.js";

/** A follow-up row takes its epic's next S number, whatever the parent row's code looks like. */
const SPINE = `# EPIC-979: x

## Issue Ledger

| Issue | Role | Owner | Title | Status | Depends on | Next action | Evidence |
|---|---|---|---|---|---|---|---|
| E979-S7 | Ticket worker | unassigned | Older row | done | none | none | x |
| E979-G20261112 | Gap finder | unassigned | Daily card 12 Nov | done | none | none | x |
| E979-G20261113 | Gap finder | unassigned | Daily card 13 Nov | review | none | followups: start Fix it; confirm: yes | x |
`;

describe("follow-up rows take the epic next S", () => {
  it("a daily-card parent like E979-G20261113 gets E979-S8 and E979-S9, never E979-G20261114", () => {
    const f = writeFollowups(SPINE, "E979-G20261113", [{ title: "Fix it", start: true }, { title: "Later thing", start: false }], "2026-11-15", "Sam");
    if ("skip" in f) throw new Error(f.skip);
    expect(f.rows.map((r) => r.ref)).toEqual(["E979-S8", "E979-S9"]);
    expect(f.text).not.toContain("E979-G20261114");
    expect(f.text).toContain("| E979-S8 | Ticket worker | unassigned | Fix it: follow-up of E979-G20261113 | ready | E979-G20261113 |");
    expect(f.text).toContain("followups: started E979-S8, E979-S9");
    // existing rows keep their codes
    expect(f.text).toContain("| E979-G20261112 |");
    expect(f.text).toContain("| E979-S7 |");
  });

  it("an S parent still takes the next S; other codes keep their prefix", () => {
    const f = writeFollowups(SPINE, "E979-S7", [{ title: "More", start: true }], "2026-11-15", "Sam");
    if ("skip" in f) throw new Error(f.skip);
    expect(f.rows[0].ref).toBe("E979-S8");
    expect(followupBase("E906-S5a")).toBe("E906-S0");
    expect(followupBase("E907-G20261113")).toBe("E907-S0");
    expect(followupBase("T13")).toBe("T13");
  });
});
