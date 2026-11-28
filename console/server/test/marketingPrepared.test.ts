import { describe, expect, it } from "vitest";
import { greetingOf } from "../src/voice/voice.js";
import { briefOpening, MARKETING_GREETING, marketingInstructions, marketingKnows } from "../src/voice/marketing.js";

/** a prepared briefer call opens with the status and our first proposal, never a question. */
const PREPARED = [
  "# What the call knows",
  "## Prepared call: the topics, one by one",
  'Opening line: Hi Sam. In one line: 14 of 42 posts went out yesterday. First topic, Reddit: I propose you press "Verify you\'re human" today.',
  "Settled, never ask again:",
  "- Who it is for: the solo builder and the small outfit.",
].join("\n");

describe("the prepared briefer call", () => {
  it("takes its opening line from the brief, quotes stripped, so the page can say it", () => {
    const g = MARKETING_GREETING(PREPARED);
    expect(g).toMatch(/^Hi Sam\. In one line: 14 of 42/);
    expect(g).not.toContain('"');
    expect(briefOpening("# x\nOpening line: not under a prepared call section at all")).toBeUndefined();
    expect(MARKETING_GREETING()).toMatch(/numbers first/);
  });

  it("the instructions carry that greeting (the call's first words) and the prepared rule", () => {
    const i = marketingInstructions(PREPARED);
    expect(greetingOf(i)).toBe(MARKETING_GREETING(PREPARED));
    expect(i).toMatch(/phase two from the first second/);
    expect(i).toMatch(/never ask it again/);
    expect(marketingInstructions()).not.toMatch(/Prepared call/);
  });

  it("a long brief reaches the call whole up to 16000 characters", () => {
    const k = marketingKnows({ brief: PREPARED + "\n" + "x".repeat(12000) + "\nEND-MARK", objectives: [] });
    expect(k).toContain("END-MARK");
    expect(k).toContain("Settled, never ask again");
  });
});
