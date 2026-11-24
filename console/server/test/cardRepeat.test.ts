import { describe, expect, it } from "vitest";
import { askGateProblem, hisWordsAlreadyAsk } from "../src/inbox/askGate.js";
import { parseAsks } from "../src/inbox/asks.js";
import { cardRepeatProblem, gateProblems, type CardFields } from "../src/review/card.js";
import type { PriorAnswer } from "../src/inbox/askRepeat.js";

// E907-S76, follow-up of E907-S65 (his E907-A2 feedback, 24 Nov: "I think it's the third time I get this question and
// answer it"): the gaps E907-S66 left. The fixtures are the real lines.

// E901-A8 (the deals world), 24 Nov: it quoted him naming the objective and its key results after "Why: you said", inside the
// question, so the gate took his quote for the asked thing's own words and the card reached him.
const A8 =
  'You approve: a new objective, Cars: Launch the campervan and 911 bots, measured by 4 key results. Why: you said (vn_aa652071): "Maybe that is like an objective and the objective is launching the car chatbots and then these are the key results from it. Ingestion for campervan is working, ingestion for 911 is working, pricing model for campervan is working ... opportunity detection ... example posts ... all of these things need to be green ... We need to have the key results for these products." — his words, 24 Nov 13:56Z (Log/2026-11-24.md#^e-a68ba3): "for the car products man I just feel like we\'re spinning wheels ... We\'re getting 6,000 cars but we don\'t even know which cars it was like totally pointless", which this objective answers by measuring each product from its own full read — impact: on your yes the objective goes on your list and the team builds the checks that count them. — recommend: yes, or tell us by voice note what to change. — why Sam: a new goal on your list, only you set your objectives. — about: car products objective';
const open = (rest: string, kind = "approve") => parseAsks(`## Waiting on\n\n- [ask E901-A9: ${kind} @Delivery-Manager since 2026-11-24] ${rest}`)[0];

describe("E907-S76 the ask gate holds a quote of his placed after Why:", () => {
  it("holds E901-A8: his words already name the Cars objective it asks him to approve", () => {
    expect(hisWordsAlreadyAsk(open(A8))).toMatch(/launching the car chatbots/);
    expect(askGateProblem(open(A8))).toMatch(/its own quote of .* already asks for this/);
  });
  it("still lets a new objective through when his quote is about something else", () => {
    const other = A8.replace(/Why: you said \(vn_aa652071\): "[^"]+"/, 'Why: you said (vn_aa652071): "we need a better house search in Mexico City"').replace(/— his words[^—]+—/, "—");
    expect(hisWordsAlreadyAsk(open(other))).toBeUndefined();
  });
});

const card = (decision: string, source: string, row = "E947-S99"): CardFields => ({ row, decision, source, delivered: [], next: [] }) as unknown as CardFields;

describe("E907-S76 a review card that asks what he already said or answered is held", () => {
  it("holds a card asking leave to add a key result his quoted words already name", () => {
    const c = card("Do we add the key result Testers record memories? We recommend yes.", 'Your voice note, 22 Nov: "maybe the key result is testers record memories, target an average of five"');
    expect(cardRepeatProblem(c)).toMatch(/already ask for .* do it from his words/);
    expect(gateProblems({ card: c }).join("\n")).toMatch(/E907-S76/);
  });

  it("passes a card that asks him to judge a result, even on the thing he asked for", () => {
    expect(cardRepeatProblem(card("Does this stop the repeated key result cards? We recommend yes.", 'Your note on the efficiency card, 24 Nov: "I think it\'s the third time I get this question"'))).toBeUndefined();
    expect(cardRepeatProblem(card("Is the scatter plot clear for each model? We recommend yes.", 'Your card answer, 24 Nov: "I want to see the scatterplot for each of the models"'))).toBeUndefined();
  });

  const prior: PriorAnswer[] = [{ code: "E946-A9", row: "E946-S10", question: "Do we post the Acme launch thread on X this Friday?", answer: "Yes: post it Friday", on: "2026-11-20" }];
  it("holds a card whose decision repeats an ask he answered on another row", () => {
    const c = card("Do we post the Acme launch thread on X this Friday? We recommend yes.", "The launch plan, raised by the posts persona", "E946-S30");
    expect(cardRepeatProblem(c, prior)).toMatch(/already answered on 2026-11-20: "Yes: post it Friday" \(E946-A9\)/);
    expect(gateProblems({ card: c, answered: prior }).join("\n")).toMatch(/already answered/);
  });
  it("lets the same row ask again on its next round (he sent it back) and a new question through", () => {
    expect(cardRepeatProblem(card("Do we post the Acme launch thread on X this Friday? We recommend yes.", "The launch plan", "E946-S10"), prior)).toBeUndefined();
    expect(cardRepeatProblem(card("Do we pause posting on Reddit for a week? We recommend yes.", "The posts persona", "E946-S30"), prior)).toBeUndefined();
  });
});
