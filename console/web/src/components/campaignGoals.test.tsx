import { describe, expect, it } from "vitest";
import type { WorldInbox } from "@/api/company-types";
import { campaignRows, changeText, countText, goalTalk, keyResultPct, keyResultText, plainLine, reached, sinceYesterday } from "./campaignGoals";

// the owner (22:19Z): each campaign as one line with its goal's number, the one he counts first.
const W = (campaigns: WorldInbox["campaigns"]): WorldInbox => ({ tenantId: "w1", tenantName: "Social", app: "SocialApp", appUrl: "https://app.example", items: [], campaigns });
const m = (now: number | null, target: number, extra: Partial<{ was: number; proposed: boolean; by: string }> = {}) => ({ label: "testers signed up", target, now, proposed: false, ...extra });

describe("campaignRows", () => {
  it("puts a number he set first, then a proposed number, then none, once each", () => {
    const rows = campaignRows([
      W([
        { name: "Reddit awareness", milestoneId: "a", openUrl: "u/a" },
        { name: "Day in the life", milestoneId: "b", openUrl: "u/b", metric: m(0, 100, { proposed: true }) },
        { name: "Memo testers", milestoneId: "c", openUrl: "u/c", metric: m(1, 10, { was: 0 }) },
      ]),
      W([{ name: "Memo testers", milestoneId: "c", openUrl: "u/c" }]),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Memo testers", "Day in the life", "Reddit awareness"]);
  });
  it("reads nothing from no worlds", () => expect(campaignRows(undefined)).toEqual([]));
});

describe("the number and today's change", () => {
  it("says 1 of 10, +1 today, 10%", () => {
    expect(countText(m(1, 10))).toBe("1 of 10");
    expect(changeText(m(1, 10, { was: 0 }))).toBe("+1 today");
    expect(changeText(m(1, 10, { was: 1 }))).toBe("no change today");
    expect(reached(m(1, 10))).toBe(10);
  });
  it("never shows a fake zero: an unread number is ?, with no change", () => {
    expect(countText(m(null, 10))).toBe("? of 10");
    expect(changeText(m(null, 10, { was: 0 }))).toBeUndefined();
    expect(changeText(m(3, 10))).toBeUndefined();
    expect(reached(m(null, 10))).toBe(0);
  });
});

describe("goal talk", () => {
  it("asks for each campaign whose number is not his", () => {
    const rows = campaignRows([
      W([
        { name: "Set", milestoneId: "s", openUrl: "u/s", metric: m(1, 10) },
        { name: "Proposed", milestoneId: "p", openUrl: "u/p", metric: m(0, 100, { proposed: true, by: "2026-12-10" }) },
        { name: "Bare", milestoneId: "n", openUrl: "u/n" },
        { name: "Worded", milestoneId: "w", openUrl: "u/w", sentence: "We want people to know us." },
      ]),
    ]);
    const t = goalTalk(rows);
    expect(t.map((x) => x.name)).toEqual(["Proposed", "Bare", "Worded"]);
    expect(t[0].text).toBe("The team proposes 100 testers signed up by 10 Dec. Is that the goal?");
    expect(t[1].text).toMatch(/no goal yet/);
    expect(t[2].text).toMatch(/no number yet/);
  });
});

describe("since yesterday", () => {
  it("lists each number that moved, then each recent report once", () => {
    const rows = campaignRows([
      W([
        { name: "Memo testers", milestoneId: "c", openUrl: "u/c", metric: m(1, 10, { was: 0 }), digest: { date: "2026-11-12", line: "1 of 10 signed up." } },
        { name: "Other", milestoneId: "d", openUrl: "u/d", metric: m(5, 10, { was: 5 }), digest: { date: "2026-11-12", line: "1 of 10 signed up." } },
        { name: "Old", milestoneId: "e", openUrl: "u/e", digest: { date: "2026-11-01", line: "old news" } },
      ]),
    ]);
    expect(sinceYesterday(rows, new Date("2026-11-12T23:00:00Z")).map((l) => l.text)).toEqual(["Memo testers went from 0 to 1 testers signed up.", "12 Nov report: 1 of 10 signed up."]);
  });
});

describe("the experiment's key results", () => {
  const k = (kind: "total" | "gain", now: number | null, gained: number | null) => ({ id: "x", label: "x", goal: 30, kind, baseline: 0, now, gained, onTrack: false });
  it("shows a count against its goal, or what was added since the start", () => {
    expect(keyResultText(k("total", 1, 0))).toBe("1 of 30");
    expect(keyResultText(k("gain", 140, 9))).toBe("+9 of 30");
    expect(keyResultText(k("gain", 131, 0))).toBe("0 of 30");
    expect(keyResultText(k("total", null, null))).toBe("? of 30");
    expect(keyResultPct(k("gain", 140, 15))).toBe(50);
  });
  it("reads a report line in plain words", () => {
    expect(plainLine("### Scorecard (day 0)")).toBe("Scorecard (day 0)");
    expect(plainLine("**1** of 10 [counts](https://x)")).toBe("1 of 10 counts");
  });
});

describe("the goal lines on a touch screen", () => {
  it("are left out of the finger-sized link rule, which made them inline (production, 13 Nov)", async () => {
    const css = (await import("node:fs")).readFileSync(new URL("../polish.css", import.meta.url), "utf8");
    expect(css).toMatch(/li > a:only-child:not\(\[data-line\]\)/);
    const src = (await import("node:fs")).readFileSync(new URL("./campaignGoals.tsx", import.meta.url), "utf8");
    // E948-S110: the goal questions are cards now, not lines (3 lines left: campaign, pursuit, since yesterday)
    expect(src.match(/data-line=""/g)?.length).toBe(3);
  });
});
