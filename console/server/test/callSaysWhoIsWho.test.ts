import { describe, expect, it } from "vitest";
import { ROLE_LINE, STILL_WITH_ME_RULE, teamRoster, voiceInstructions } from "../src/voice/voice.js";
import { ELEVEN_TURN_TIMEOUT_S, agentBody } from "../src/voice/elevenAgent.js";
import { briefingInstructions } from "../src/voice/briefing.js";
import { STRATEGY_GREETING, strategyInstructions } from "../src/voice/teamStrategy.js";
import { spanishGreeting } from "../src/voice/spanish.js";

// His calls of 27 Nov: every call says plainly who it is and who else is on the team (the desk call had called itself
// "the voice line"), and the voice speaks up within seconds when he goes quiet or his microphone stops.
describe("a call says who is who, and checks in when he goes quiet", () => {
  it("the roster names every call by the name his call screen shows, and the desk call is the Team desk line", () => {
    const r = teamRoster("Acme Social", "Acme Team");
    for (const name of ["Team desk manager", "Team desk partner", "objective's manager", "campaign's manager", "Acme Social partner", "Acme Team launch strategist", "Team desk line"]) expect(r).toContain(name);
    expect(r).toMatch(/In your first reply on this call.*who you are and that the others exist/);
    expect(ROLE_LINE).toMatch(/^I'm your Team desk line\./);
    expect(voiceInstructions()).toMatch(/You are the Team desk line .*never call yourself the voice line/);
  });

  it("the check-in: once per silence, in English and Spanish, and the ElevenLabs agent re-engages after 7 s", () => {
    expect(STILL_WITH_ME_RULE).toMatch(/"Are you still with me\?".*"¿Sigues conmigo\?".*once/);
    expect(STILL_WITH_ME_RULE).toMatch(/microphone stopped.*"I can't hear you any more\. Are you still with me\?"/);
    expect(agentBody("p", "hi", []).conversation_config.turn).toEqual({ turn_timeout: ELEVEN_TURN_TIMEOUT_S });
    expect(ELEVEN_TURN_TIMEOUT_S).toBe(7);
    expect(briefingInstructions()).not.toMatch(/never ask whether he is still there/);
  });

  it("the strategy call names itself and its objective, one role, never re-asks what is settled, and passes quietly", () => {
    expect(STRATEGY_GREETING()).toMatch(/launch strategist here, on the Launch .+ objective\. Where do you want to pick up\?$/);
    expect(STRATEGY_GREETING()).not.toMatch(/who buys first/i);
    expect(spanishGreeting(STRATEGY_GREETING())).toMatch(/^Hola .+, aquí tu estratega de lanzamiento de .+, en el objetivo Launch .+\. ¿Por dónde seguimos\?$/);
    const ins = strategyInstructions();
    expect(ins).toMatch(/one role, said plainly.*Never say you wear two hats/);
    expect(ins).toMatch(/Settled is settled/);
    expect(ins).toMatch(/Pass it quietly as he says it: no read-back, no "Pass it\?"/);
    expect(ins).not.toMatch(/on his yes call relay_to_desk/);
    expect(ins).toMatch(/never announce it \("Passed", "That's passed"/);
  });
});
