import { describe, expect, it } from "vitest";
import { SEED_VERSION, endpointLines } from "../src/desk/desk.js";
import { DESK_ANSWER_RULE, HANDOFF_RULE, MINIMAL_RULE, STYLE_BLOCK, VOICE_TOOLS, voiceInstructions } from "../src/voice/voice.js";

// since the voice withheld the desk's answers ("Noted.", "Want the link?", "I don't
// know" while three answers waited) and turned curt to rude ("It's locked. Next?"). An answer is said as soon as it lands;
// short but warm, never cold; one warm line when it hands over; never "I don't know" while the desk is on it.

describe("E942-S33 the voice line: says the desk's answer at once, short but warm", () => {
  const ins = voiceInstructions();

  it("the style block asks for short but warm turns, not a word cap", () => {
    expect(ins.startsWith(STYLE_BLOCK)).toBe(true);
    expect(STYLE_BLOCK).toMatch(/Short but warm/);
    expect(STYLE_BLOCK).toMatch(/Never curt, never cold/);
    expect(ins).not.toMatch(/at most eight words/);
    expect(ins).not.toMatch(/Two words beat ten/);
    expect(MINIMAL_RULE).toMatch(/a bare word can sound cold/);
  });

  it("tone examples are warm: each bad turn from call_37f96758 has a friendly good one", () => {
    expect(STYLE_BLOCK).toMatch(/Bad: 'Noted\.' Good: 'Sure, Sam\. On it\.'/);
    expect(STYLE_BLOCK).toMatch(/Bad: 'I don't know\.' Good: 'It's coming\. I'll tell you as soon as it lands\.'/);
    expect(STYLE_BLOCK).toMatch(/Bad: 'It's locked\. Next\?' Good: 'Sorry, Sam, the desk can't post there\. You can add it at social\.example\.com\.'/);
    // Every good example is a whole, friendly sentence: no bare one-word reply.
    for (const good of STYLE_BLOCK.matchAll(/Good: '([^']+(?:'[a-z][^']*)*)'/g)) expect(good[1].split(/\s+/).length).toBeGreaterThanOrEqual(3);
  });

  it("an arriving desk answer is said at once, the answer first, simply", () => {
    expect(STYLE_BLOCK).toMatch(/When the desk's answer arrives, tell him right away/);
    expect(ins).toContain(DESK_ANSWER_RULE);
    expect(DESK_ANSWER_RULE).toMatch(/As soon as it arrives, tell him: the answer first/);
    expect(DESK_ANSWER_RULE).toMatch(/never ask him the desk.s question on the call/);
    expect(ins).not.toMatch(/Do not read it out/);
    expect(ins).not.toMatch(/mention it only when he asks/);
  });

  it("no 'I don't know' while an answer is pending, and no talk about its own limits", () => {
    expect(STYLE_BLOCK).toMatch(/never say 'I don't know' while the desk is on it: say it's coming/);
    expect(STYLE_BLOCK).toMatch(/Never talk about your own limits/);
    expect(DESK_ANSWER_RULE).toMatch(/If he asks while it is still working, say it's on its way/);
    expect(ins).toMatch(/while one is with the desk, say it is coming, never 'I don't know'/);
    expect(ins).not.toMatch(/If you do not know, say so in a few words/);
  });

  it("replay fixes (call_ac5cda50, call_93987f49): no talk about its own style, no echo, a repeat question answered from the answer in hand", () => {
    expect(STYLE_BLOCK).toMatch(/Never describe how you talk .* never repeat back what he said/);
    expect(STYLE_BLOCK).toMatch(/Bad: 'Here's a warm, brief update: .*' Good: 'Sure, Sam\. Let's just talk\.'/);
    expect(STYLE_BLOCK).toMatch(/If the desk already answered it on this call, answer again from that at once, kindly, without asking the desk again/);
    expect(HANDOFF_RULE).toMatch(/at most one short warm line/);
  });

  it("one short warm line when it hands over, no progress chatter, no 'Noted.'", () => {
    expect(ins).toContain(HANDOFF_RULE);
    expect(HANDOFF_RULE).toMatch(/never that you pass it to the desk/);
    expect(HANDOFF_RULE).toMatch(/No progress updates while it works/);
    expect(ins).not.toMatch(/at most one word \('Noted\.'\)/);
    const ask = VOICE_TOOLS.find((t) => t.name === "ask_the_desk")!;
    expect(ask.description).toMatch(/its answer is yours to tell him the moment it arrives/);
    expect(ask.description).not.toMatch(/never say you are sending/);
  });

  it("the desk's seed (v24) knows its reply is said aloud at once: what it dispatched first, its questions on his inbox", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(24);
    const line = endpointLines("https://team.example.com").find((l) => l.includes("Voice call"))!;
    expect(line).toMatch(/tells him your reply aloud as soon as it lands: say what you dispatched and where, plainly, first; a question for him is on his inbox/);
    expect(line).not.toMatch(/does not read your reply out/);
  });
});
