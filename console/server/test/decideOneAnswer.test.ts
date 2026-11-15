import { describe, expect, it } from "vitest";
import { parseAsks } from "../src/inbox/asks.js";
import { decideChoices } from "../src/inbox/decideChoices.js";
import { flipAskLine } from "../src/inbox/spineWrite.js";

/**
 * E948-S70 (deal-funnels desk note 2026-11-12): a three-option decide ask answered on the console came back with the
 * whole options line as its answer, "500 Stars a month · 250 Stars a month · keep it closed for now". A press writes
 * only the option picked.
 */
const LINE =
  "- [ask E905-A11: decide @Sam since 2026-11-12 row E905-S23] You decide: the weekly digest costs 500 Stars a month, or 250 Stars. " +
  "Why: you asked for one email a week — impact: once priced, anyone can subscribe — recommend: 500 Stars, about 20 deep analyses a month " +
  "— options: 500 Stars a month · 250 Stars a month · keep it closed for now — unblocks: E905-S23 — details: https://example.com/digest/";

describe("E948-S70: a decide answer is the one option picked", () => {
  const [ask] = parseAsks(`## Waiting on\n${LINE}\n`);
  it("the three options are three buttons, never one", () => {
    expect(decideChoices(ask!).options).toEqual(["500 Stars a month", "250 Stars a month", "keep it closed for now"]);
  });
  it.each(["500 Stars a month", "250 Stars a month", "keep it closed for now"])("pressing %s writes only that option", (pick) => {
    const flipped = flipAskLine(LINE, pick, "2026-11-13", "Sam")!;
    expect(flipped.endsWith(`— answer: ${pick}`)).toBe(true);
    const [back] = parseAsks(`## Waiting on\n${flipped}\n`);
    expect(back!.answer).toBe(pick);
    expect(back!.answer).not.toContain("·");
  });
});
