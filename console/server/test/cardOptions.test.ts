import { describe, expect, it } from "vitest";
import { gateProblems, parseCard } from "../src/review/card.js";

/** E948-S69: a card's `options:` are a decision card's buttons, each `<answer>: <what happens next>`. */
const card = (options: string) =>
  [
    "---",
    "row: E900-S1",
    "title: The used-car page was redrawn with diagrams first.",
    "goal: Pick one proven business our agents could copy.",
    "delivered:",
    "  - ✓ The first screen is one chart.",
    "  - ✓ The car idea fills most of the page.",
    "evidence: [Open the page](https://example.com/boring/)",
    "screenshot: shot.png",
    "source: Your voice note of 12 November, \"which business\" [log](https://example.com/log)",
    "decision: Which way do we go? The team recommends Spain.",
    options,
    "---",
    "",
  ].join("\n");
const G = { project: "Mini businesses", goalSentence: "Find a business to copy.", screenshotFound: true };

describe("E948-S69 card options", () => {
  it("reads options as a list or on one line", () => {
    expect(parseCard(card("options:\n  - Spain: plan the Spain lookup\n  - \"No: park it\""))!.options).toEqual(["Spain: plan the Spain lookup", "No: park it"]);
    expect(parseCard(card("options: Yes: plan it · No: park it"))!.options).toEqual(["Yes: plan it", "No: park it"]);
    expect(parseCard(card(""))!.options).toBeUndefined();
  });

  it("the gate holds options that do not name their next step, or too few", () => {
    expect(gateProblems({ card: parseCard(card("options: Yes: plan it · No: park it"))!, ...G })).toEqual([]);
    expect(gateProblems({ card: parseCard(card("options: Yes · No"))!, ...G }).join(" ")).toMatch(/option 1 does not name its next step/);
    expect(gateProblems({ card: parseCard(card("options: Yes: plan it"))!, ...G }).join(" ")).toMatch(/it has 1 options, a decision needs 2 to 4/);
    expect(gateProblems({ card: parseCard(card("options: Yes: approve it · No: park it"))!, ...G }).join(" ")).toMatch(/option 1 says approve/);
  });
});
