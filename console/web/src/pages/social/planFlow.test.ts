import { describe, expect, it } from "vitest";
import type { MarketingPlan, MarketingPlanSection } from "@/api/campaign-types";
import { flowNodes, wrapWords } from "./PlanTab";

// The campaign Plan tab opens with the plan drawn (who → message → channels → offer → goal), built from its sections.
const sec = (key: MarketingPlanSection["key"], lead: string | null, boxes: [string, string][]): MarketingPlanSection => ({
  key, title: key, written: true, lead, boxes: boxes.map(([label, text]) => ({ label, text, note: null })), table: null, quotes: [],
});
const plan: MarketingPlan = {
  source: "spine", path: "docs/spines/x.md", repo: "w", line: "Bring your context home",
  missing: [],
  sections: [
    sec("goal", "Two goals", [["Goal 1", "10 testers signed up"], ["Goal 2", "5 use it weekly"]]),
    sec("who", "Voice memo people first.", [["First", "The voice memo person"]]),
    sec("messages", "One frame", [["Message 1", "a"], ["Message 2", "b"], ["Message 3", "c"]]),
    sec("channels", null, [["YouTube Shorts", "1 a day"], ["Reddit, as Sam", "2 a day"], ["X @ExampleMemory", "12"]]),
    sec("offer", "Your first 30 memories free.", [["Sees", "a post"]]),
    { ...sec("test", null, []), written: false },
  ],
};

describe("plan flow", () => {
  it("draws five stops from the plan's own sections", () => {
    const n = flowNodes(plan);
    expect(n.map((x) => x.label)).toEqual(["Who", "Message", "Channels", "Offer", "Goal"]);
    expect(n.map((x) => x.text)).toEqual([
      "The voice memo person", "3 messages", "YouTube, Reddit, X", "Your first 30 memories free.", "10 testers signed up, then 5 use it weekly",
    ]);
    expect(n.every((x) => x.written)).toBe(true);
  });
  it("shows a section not written yet as such", () => {
    const n = flowNodes({ ...plan, sections: plan.sections.filter((s) => s.key !== "offer") });
    expect(n[3]).toMatchObject({ key: "offer", text: "not written yet", written: false });
  });
  it("wraps words into short lines and cuts the rest", () => {
    expect(wrapWords("10 testers signed up, then 5 use it weekly", 20, 3)).toEqual(["10 testers signed", "up, then 5 use it", "weekly"]);
    const cut = wrapWords("one two three four five six seven eight nine ten", 10, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1].endsWith("…")).toBe(true);
  });
});
