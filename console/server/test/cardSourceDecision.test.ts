import { describe, expect, it, vi } from "vitest";
import { CARD_FIELDS_RULE } from "../src/review/cardRule.js";
import { ROW_CLOSE_RULE } from "../src/cycle/prompts.js";
import { gateProblems, parseCard, sourceProblem } from "../src/review/card.js";
import { cardText } from "./reviewFixture.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/**
 * the owner's ask: "where is this coming from? … what is the ask for me? What is the decision here?" Every card opens
 * with where it came from and ends with the one decision asked; a card with neither is held back (card needs rewriting).
 */
const G = { project: "The team console", goalSentence: "Give the team desk a home.", screenshotFound: true };
const without = (key: string) => cardText("E941-S2").split("\n").filter((l) => !l.startsWith(`${key}:`)).join("\n");

describe("E948-S58 source and decision on every card", () => {
  it("parses source and decision, with their synonyms", () => {
    const c = parseCard(cardText("E941-S2"))!;
    expect(c.source).toBe('Your voice note of 12 Nov: "keep the test page".');
    expect(c.decision).toBe("Is the test page good enough to keep? The team recommends keeping it.");
    const s = parseCard(without("source").replace("decision:", "You decide:").replace("---\nrow:", "---\nWhere it came from: Sam said \"do it\" on 12 Nov.\nrow:"))!;
    expect(s.source).toBe('Sam said "do it" on 12 Nov.');
    expect(s.decision).toMatch(/^Is the test page/);
    expect(gateProblems({ card: parseCard(cardText("E941-S2"))!, ...G })).toEqual([]);
  });

  it("a card missing either is held back: card needs rewriting, with what to write", () => {
    expect(gateProblems({ card: parseCard(without("source"))!, ...G }).join(" ")).toMatch(/the source is missing/);
    expect(gateProblems({ card: parseCard(without("decision"))!, ...G }).join(" ")).toMatch(/the decision is missing/);
  });

  it("a persona's own card counts its from line as the source; the decision is still required", () => {
    const c = parseCard(without("source").replace("confirm: yes", "from: Gap finder\nconfirm: yes"))!;
    expect(gateProblems({ card: c, ...G })).toEqual([]);
  });

  it("the source may quote his words with a slash, never a row code or a file; the decision is plain words", () => {
    expect(sourceProblem('You said on 12 Nov: "make it clear on laptop/phone" in [your note](https://team.example/notes/vn_1).')).toBeUndefined();
    expect(sourceProblem("Raised on E962-S8.")).toMatch(/row code/);
    expect(sourceProblem("See docs/status/x.md.")).toMatch(/file/);
    const c = parseCard(cardText("E941-S2").replace(/^decision: .*$/m, "decision: Keep it (or not); we suggest keep."))!;
    expect(gateProblems({ card: c, ...G }).join(" ")).toMatch(/the decision has a semicolon/);
  });

  it("every worker brief names both fields", () => {
    expect(CARD_FIELDS_RULE).toMatch(/`source` \(where it came from/);
    expect(CARD_FIELDS_RULE).toMatch(/`decision` \(the one decision or ask/);
    expect(ROW_CLOSE_RULE).toContain(CARD_FIELDS_RULE);
  });
});

// E948-S85: the owner's voice note of 12 Nov: "if I need to do an action, I expect a link. I need to see a link."
describe("E948-S85 a card's decision links the place it sends him to", () => {
  it("holds a decision that sends him to sign in, install or open something with no link", async () => {
    const { decisionLinkProblem } = await import("../src/review/card.js");
    expect(decisionLinkProblem("Sign in with Google and check it is your world. The team recommends keeping it on.")).toMatch(/to sign in somewhere but does not link the place/);
    expect(decisionLinkProblem("Install the app on your phone. We recommend yes.")).toMatch(/to install somewhere/);
    expect(decisionLinkProblem("Sign in with Google at cloud.epicteam.app and check it is your world. The team recommends Keep it on.")).toBeUndefined();
    expect(decisionLinkProblem("Upload [the form](https://team.example/steps/1) and press Done. We recommend yes.")).toBeUndefined();
    // "Open …" points at the card's own evidence link
    expect(decisionLinkProblem("Open Browser auth and check both X rows. We recommend yes.")).toBeUndefined();
    expect(decisionLinkProblem("Does the mic now record in place for you? The team recommends yes once you try it on your phone.")).toBeUndefined();
    const card = cardText("E941-S2").replace(/^decision:.*$/m, "decision: Log in to the console and press Save. The team recommends yes.");
    expect(gateProblems({ card: parseCard(card)!, ...G }).join(" ")).toMatch(/does not link the place/);
  });
});

// E948-S102: the owner, vn_b19ddf2d: cards ask him things he cannot place. The source says where it came from in his words,
// and the decision says plainly what it asks, one question.
describe("E948-S102 every card says where it came from and what it asks, plainly", async () => {
  const { decisionAskProblem, sourceWordsProblem } = await import("../src/review/card.js");
  it("holds a decision that is not one question", () => {
    expect(decisionAskProblem("Try one car on your phone. We recommend sending it an ad.")).toMatch(/does not ask a question/);
    expect(decisionAskProblem("Does this explain the second pass, and are these checks enough? We recommend yes.")).toMatch(/more than one thing/);
    expect(decisionAskProblem("Is this right? Should we also post it? We recommend yes.")).toMatch(/more than one thing/);
    expect(decisionAskProblem("Which cluster first? We recommend Tenerife south-west.")).toBeUndefined();
    expect(decisionAskProblem("Is this the forecast you wanted? We recommend keeping it.")).toBeUndefined();
  });
  it("holds a source with neither his words nor who raised it", () => {
    expect(sourceWordsProblem("Your voice note, 14 Nov: what we spend a day.")).toMatch(/in his words/);
    expect(sourceWordsProblem('Your voice note, 14 Nov: "will we run out before the reset".')).toBeUndefined();
    expect(sourceWordsProblem("The Gap finder raised it: two goals had no owner.")).toBeUndefined();
  });
  it("the gate holds such a card as card needs rewriting", () => {
    const c = parseCard(cardText("E941-S2").replace(/^decision: .*$/m, "decision: Try it on your phone. We recommend yes.").replace(/^source: .*$/m, "source: Your voice note of 12 Nov."))!;
    const p = gateProblems({ card: c, ...G }).join(" ");
    expect(p).toMatch(/does not ask a question/);
    expect(p).toMatch(/in his words/);
  });
});
