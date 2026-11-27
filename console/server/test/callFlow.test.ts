import { describe, expect, it } from "vitest";
import { CALL_FLOW_RULE, STILL_WITH_ME_RULE, VOICE_TOOLS, voiceInstructions } from "../src/voice/voice.js";
import { briefingInstructions, briefingWalkRule, BRIEFING_TOOLS } from "../src/voice/briefing.js";
import { coachInstructions } from "../src/voice/coach.js";
import { marketingInstructions } from "../src/voice/marketing.js";
import { objectiveCallInstructions } from "../src/voice/levelCall.js";
import { strategyInstructions } from "../src/voice/teamStrategy.js";

// His calls of 27 Nov: "I wish you didn't ask me so much ... you're kind of interrupting the flow" (call_8c535b1a),
// "You don't need to tell me that so much" (call_910685a3), "espero a que reacciones tú" (call_065c7b6e). One rule for
// every call voice: phase one he talks, phase two the voice proposes and leads; no permission ask after a point, no desk talk.
const KINDS: [string, string][] = [
  ["Team desk line", voiceInstructions()],
  ["objectives review", briefingInstructions() + "\n" + briefingWalkRule(5)],
  ["Team desk partner", coachInstructions()],
  ["social partner", marketingInstructions()],
  ["objective manager", objectiveCallInstructions("Get 5 testers")],
  ["launch strategist", strategyInstructions()],
];

describe("every call voice keeps his flow", () => {
  it("the one rule: phase two leads, no permission asks, no desk talk, time left said, quick check-in merged in", () => {
    expect(CALL_FLOW_RULE).toMatch(/Phase one, he gives you his context: let him talk\. Short acknowledgements only/);
    expect(CALL_FLOW_RULE).toMatch(/Phase two.*you lead.*'Here is what I propose: …'.*Never wait for his yes before going on/);
    expect(CALL_FLOW_RULE).toMatch(/Never ask permission after a point: no 'Pass it\?'/);
    expect(CALL_FLOW_RULE).toMatch(/Never talk about passing things on: no 'I'll pass this to the desk'.*The whole call reaches his team by itself/);
    expect(CALL_FLOW_RULE).toMatch(/note from the call's clock comes, say its line out loud at once/);
    expect(CALL_FLOW_RULE).toContain(STILL_WITH_ME_RULE);
    expect(CALL_FLOW_RULE).toMatch(/never that the call is saved or sent anywhere/);
  });

  it.each(KINDS)("%s: no read-back-and-yes before passing, no 'File it?', no 'ask what he thinks', no 'recap of what you passed'", (_k, ins) => {
    expect(ins).not.toMatch(/said back in one line what you will pass and he agreed/);
    expect(ins).not.toMatch(/on his yes call (relay_to_desk|file_objective_words)/);
    expect(ins).not.toMatch(/File it\?"\) and/);
    expect(ins).not.toMatch(/and ask what he thinks/);
    expect(ins).not.toMatch(/recap of what you passed on/);
    expect(ins).not.toMatch(/offer to pass the question on/);
    expect(ins).not.toMatch(/I'll get the desk on that/);
  });

  it("the pass and file tools say: at once, no read-back", () => {
    const relay = BRIEFING_TOOLS.find((t) => t.name === "relay_to_desk")!;
    expect(relay.description).toMatch(/as soon as he says it, without reading it back or asking him/);
    const file = [...BRIEFING_TOOLS, ...VOICE_TOOLS].find((t) => t.name === "file_objective_words");
    if (file) expect(file.description).not.toMatch(/ONLY after you said back/);
  });

});
