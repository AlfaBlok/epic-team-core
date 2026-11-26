import { describe, expect, it } from "vitest";
import { asksChoice, countsRed, isDecisionCard } from "@/lib/cardKind";
import { decisionChoices } from "@/components/review";

// (the owner 26 Nov: "this came as review but was a question??"): a review card that asks him a real choice is a
// Decision he must answer; a card that only asks him to judge finished work stays a Review.
const face = (decision: string, options?: string[]) => ({ decision, options, next: [] });

describe("a card that asks a real choice shows as a question", () => {
  it("the tester-names card of 26 Nov is a question, with Yes: go ahead and No: park it", () => {
    const f = face("Greet Ana by name and the other two without one? We think yes.");
    expect(isDecisionCard(f)).toBe(true);
    expect(countsRed({ face: f })).toBe(true);
    expect(decisionChoices(f)?.map((c) => c.label)).toEqual(["Yes: go ahead", "No: park it"]);
  });
  it("what the team does, which one, the step to take, or two ways", () => {
    for (const d of [
      "Do we keep buying for cash only? We recommend cash.",
      "Should only briefings, alarms and replies reach you one by one? We recommend yes.",
      "Which mortgage should the page assume? We recommend the Spanish offer.",
      "When do we make the Discord? The team recommends later.",
      "Buy the Honor Magic8 Pro at 844 euros? We recommend yes.",
      "Greet testers by the name they typed or the Google one? We think typed.",
    ])
      expect(asksChoice(d), d).toBe(true);
  });
  it("a question that only judges finished work stays a Review", () => {
    for (const d of [
      "Are these placements right? We recommend yes.",
      "Does the top bar read cleanly on your phone now? We recommend yes.",
      "Is this the note you sent at 16:33? We recommend yes.",
      "Do these bars show where your subscription goes? We recommend yes.",
      "Is one numbered list, one profile at a time, what you wanted? We think yes.",
      "Keep it as it is? We recommend yes.",
      "Start the six next steps? We recommend all six.",
      "Does the desk now answer the way you asked or not? We recommend yes.",
    ]) {
      expect(asksChoice(d), d).toBe(false);
      expect(isDecisionCard(face(d)), d).toBe(false);
    }
  });
  it("its own buttons still decide: keep or change stays a Review, two next steps a Decision", () => {
    expect(isDecisionCard(face("Make the box ours? We recommend yes.", ["Yes: keep it", "No: say what to change"]))).toBe(false);
    expect(isDecisionCard(face("Is one refresh a day enough? We recommend yes.", ["Yes: keep it daily", "No: refresh at every wake"]))).toBe(true);
  });
  it("a which-question with no buttons of its own gets no made-up Yes or No", () => expect(decisionChoices(face("Which city first? We recommend Salta."))).toBeUndefined());
});
