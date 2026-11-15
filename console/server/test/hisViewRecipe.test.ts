import { describe, expect, it } from "vitest";
import { HIS_VIEW_POINTER, hisViewRecipe, hisViewsFor, workerBriefRules, X_LINKS_RULE, type HisView } from "../src/cycle/prompts.js";

// the owner's view rides only in the brief of a row on its topic, never in every brief.
const views: HisView[] = [
  { id: "weather-place-house", title: "Sam's view: weather and place for the house", topic: "weather house", worlds: ["home_search"], tags: ["weather", "climate", "humid"],
    three: [
      { line: "Weather first", words: '"I care that it\'s too hot"', refs: ["Log/2026-11-15.md#^e-ca35fc"] },
      { line: "A place that excites him", words: '"closer to the sea or water"', refs: ["Log/2026-11-15.md#^e-5b0e92"] },
      { line: "Affordable and for good", words: '"at an affordable price"', refs: ["Log/2026-11-14.md#^e-b4c48e"] },
    ] },
];

describe("his view recipe, scoped to the row's topic", () => {
  it("a house row gets the view in its brief", () => {
    const m = hisViewsFor({ repo: "home_search", title: "Shortlist three towns by school run" }, views);
    expect(m.map((v) => v.id)).toEqual(["weather-place-house"]);
    const rules = workerBriefRules(undefined, m);
    const r = hisViewRecipe(m);
    expect(rules).toContain(r);
    expect(r).toContain("scripts/his_view.py weather house");
    expect(r).toContain("weather and place for the house");
    expect(r).toContain("store_memory");
    // his three bullets ride whole in the brief, before the pointer to the full view
    expect(r).toContain('- Weather first: "I care that it\'s too hot" (Log/2026-11-15.md#^e-ca35fc)');
    expect(r).toContain("- Affordable and for good");
    expect(r.indexOf("Affordable and for good")).toBeLessThan(r.indexOf("The full view"));
    expect(rules[rules.length - 1]).toBe(X_LINKS_RULE);
  });

  it("a console row does not", () => {
    const m = hisViewsFor({ repo: "console_repo", title: "Console release parks inside the hour and ships at the top" }, views);
    expect(m).toEqual([]);
    expect(hisViewRecipe(m)).toBe("");
    const rules = workerBriefRules(undefined, m);
    expect(rules.some((x) => x.includes("weather and place"))).toBe(false);
    expect(rules).toEqual(workerBriefRules());
  });

  it("a row elsewhere on the topic matches by tag, word for word", () => {
    expect(hisViewsFor({ repo: "console_repo", title: "Weather check for the house page" }, views)).toHaveLength(1);
    expect(hisViewsFor({ repo: "console_repo", title: "Weatherproof the deploy" }, views)).toEqual([]);
  });

  it("every brief carries only the pointer that says whether a view is on its topic", () => {
    expect(X_LINKS_RULE).toContain(HIS_VIEW_POINTER);
    expect(HIS_VIEW_POINTER).toContain("scripts/his_view.py for <your row>");
    expect(X_LINKS_RULE).not.toContain("store_memory");
  });
});
