import { describe, expect, it } from "vitest";
import { byMilestonePriority } from "../src/inbox/priority.js";
import { activeFirst, firstCountValue, firstIsOn, lookupOf, parseFirst, parsePressing, parsePriorities, parseRedLines, resetFirstCounts } from "../src/inbox/jordiPriority.js";

/**
 * the owner: every card and ask about a product's testers ranks first in the inbox, above all other work,
 * until five testers use it. A standing `first` rule in the levels file; it switches off by itself at the count.
 */
const rule = {
  name: "Acme testers",
  why: "You asked that Acme tester work comes first.",
  match: { words: ["tester"], products: ["Acme", "Acmy"], repos: ["acme"], redLines: ["Acme's first tester"] },
  until: { source: "acme-counts#active_testers", reaches: 5 },
};
const file = JSON.stringify({
  items: [{ repo: "repo1", ref: "E907-S1", level: "high", why: "High." }],
  redLines: [{ name: "Acme's first tester", sentence: "First tester.", state: "agreed", items: [{ repo: "acme", ref: "E907-S16" }] }],
  pressing: [{ repo: "repo1", ref: "E907-S2", kind: "frustrated", why: "Frustrated." }],
  first: [rule, { name: "broken", why: "no match" }],
});
const at = (value: number | null) => parseFirst(file).map((r) => ({ ...r, count: { value, reaches: 5 } }));
const lookupWith = (value: number | null) => lookupOf(parsePriorities(file, "repo1"), parseRedLines(file, "repo1"), parsePressing(file, "repo1"), at(value));

describe("a standing first rule leads until its count is reached", () => {
  it("reads only well-formed rules", () => {
    expect(parseFirst(file).map((r) => r.name)).toEqual(["Acme testers"]);
    expect(parseFirst("nope")).toEqual([]);
  });

  it("matches by words naming Acme and testers, by the Acme repo, or by the Acme red line", () => {
    const l = lookupWith(2);
    expect(l({ repo: "repo1", ref: "E907-S11", title: "Five Acme testers get the welcome video" })?.pressing?.kind).toBe("first");
    expect(l({ repo: "repo1", code: "E907-A1", question: "Can we post the Acmy testers call today?" })?.pressing?.rule).toBe("Acme testers");
    expect(l({ repo: "acme", ref: "E907-S12", title: "Watch the first tester sign up" })?.pressing?.kind).toBe("first");
    expect(l({ repo: "acme", ref: "E907-S16" })?.pressing?.kind).toBe("first");
    // testers of another product, or Acme work with no testers: not this rule
    expect(l({ repo: "repo1", ref: "E907-S13", title: "Five Beta app testers sign up" })?.pressing).toBeUndefined();
    expect(l({ repo: "repo1", ref: "E907-S14", title: "Acme pricing page" })?.pressing).toBeUndefined();
    // a citation of where his words are kept is not what the item is about
    expect(l({ repo: "repo1", ref: "E907-S17", title: "Alerts drop the label (tester alerts too). Voice note (Acme Log/2026-11-14.md#^e-1)" })?.pressing).toBeUndefined();
  });

  it("ranks above what is pressing and the red line, carrying its count", () => {
    const items = [
      { id: "a", repo: "repo1", ref: "E907-S1", title: "High work" },
      { id: "b", repo: "repo1", ref: "E907-S2", title: "Frustrated work" },
      { id: "c", repo: "repo1", ref: "E907-S15", title: "Acme tester welcome email" },
    ];
    const out = byMilestonePriority(items, new Map(), lookupWith(2));
    expect(out.map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(out[0].ownerPriority?.pressing?.count).toEqual({ value: 2, reaches: 5 });
    expect(out[0].priority!).toBeLessThan(out[1].priority!);
  });

  it("switches off by itself at five testers; an unread count keeps it on", () => {
    expect(firstIsOn(at(4)[0])).toBe(true);
    expect(firstIsOn(at(null)[0])).toBe(true);
    expect(firstIsOn(at(5)[0])).toBe(false);
    expect(lookupWith(5)({ repo: "repo1", ref: "E907-S15", title: "Acme tester welcome email" })?.pressing).toBeUndefined();
  });

  it("reads the live count in the background and uses the last value", async () => {
    resetFirstCounts();
    let calls = 0;
    const read = async () => (calls++, [{ label: "x", source: "acme-counts#active_testers", value: 3 }]);
    expect(firstCountValue("acme-counts#active_testers", 0, read)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(firstCountValue("acme-counts#active_testers", 1, read)).toBe(3);
    expect(calls).toBe(1);
    expect(activeFirst(parseFirst(file))[0].count?.reaches).toBe(5);
  });
});
