import { describe, expect, it } from "vitest";
import { asksChoice } from "../src/review/cardKind.js";
import { choiceOptionsProblem } from "../src/review/card.js";
import { reviewButtons } from "../src/voice/inbox.js";

//the server reads a question card the way the page does (web lib/cardKind.ts), and the card check says which is which.
describe("question cards on the server", () => {
  it("the voice presses the same buttons the page shows", () => {
    expect(reviewButtons({ decision: "Greet Ana by name and the other two without one? We think yes." })).toEqual(["Yes: go ahead", "No: park it", "Changes wanted…"]);
    expect(reviewButtons({ decision: "Do we start this plan? We recommend yes." })).toEqual(["Yes: plan it", "No: park it", "Changes wanted…"]);
    expect(reviewButtons({ decision: "Are these placements right? We recommend yes." })).toEqual(["Mark complete", "Changes wanted…"]);
  });
  it("the same rule as the page", () => {
    expect(asksChoice("Should only briefings reach you one by one? We recommend yes.")).toBe(true);
    expect(asksChoice("Does this read right? We recommend yes.")).toBe(false);
  });
  it("the card check holds a which-question with no answers to press", () => {
    expect(choiceOptionsProblem("Which city first? We recommend Salta.", undefined)).toMatch(/add options/);
    expect(choiceOptionsProblem("Which city first? We recommend Salta.", ["Salta: plan it", "Tenerife: plan it"])).toBeUndefined();
    expect(choiceOptionsProblem("Greet Ana by name? We think yes.", undefined)).toBeUndefined();
    expect(choiceOptionsProblem("Is it right? We recommend yes.", undefined)).toBeUndefined();
  });
});
