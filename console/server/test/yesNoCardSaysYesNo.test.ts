import { describe, expect, it } from "vitest";
import { isYesNoQuestion } from "../src/inbox/decideChoices.js";
import { askButtons } from "../src/voice/inbox.js";

/**
 * E948-S200 (the owner closed E948-S109 24 Nov and started this): a yes-or-no card's buttons say Yes and No, not Answer.
 * The voice call's buttons on an ask are the page's: a yes-or-no question gets Yes and No, never only Answer in words.
 */
describe("a yes-or-no ask offers Yes and No (E948-S200)", () => {
  it("tells a yes or no question from a pick, a list of choices or no question", () => {
    expect(isYesNoQuestion("You decide: should builder credit be 2x the ticket's price fixed before work? Why: it is simple.")).toBe(true);
    expect(isYesNoQuestion("http://x.example/#a : You check: does the page read clearly now? Why: you asked.")).toBe(true);
    expect(isYesNoQuestion("Is this short reply the one you send?")).toBe(true);
    expect(isYesNoQuestion("http://x.example/#pick : You decide: how do the two desks get their own WhatsApp numbers? Why: one each.")).toBe(false);
    expect(isYesNoQuestion("Which phone do you buy?")).toBe(false);
    expect(isYesNoQuestion("Offer both ways, or AI included only?")).toBe(false);
    expect(isYesNoQuestion("You give: the most you would spend in total. Why: we plan the trip.")).toBe(false);
    // a "?" in a later sentence is not the card's question
    expect(isYesNoQuestion("You do: post one video. Did it work?")).toBe(false);
  });

  it("the voice's buttons on a yes-or-no ask are Yes, No and his words", () => {
    expect(askButtons("approve")).toEqual(["Yes: go ahead", "No: drop it", "Answer in words…"]);
    expect(askButtons("decide", "You decide: should we sell own AI at 49 euros? Why: margin.")).toEqual(["Yes", "No", "Answer in words…"]);
    expect(askButtons("check", "You check: does the page read clearly now?")).toEqual(["Yes", "No", "Answer in words…"]);
    expect(askButtons("decide", "You decide: how do the two desks get their numbers?")).toEqual(["Answer in words…"]);
    expect(askButtons("provide", "Can you give us the shop's VAT number?")).toEqual(["Answer in words…"]);
    expect(askButtons("do", "You do: post one video.")).toEqual(["Answer in words…"]);
  });
});
