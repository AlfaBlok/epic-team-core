import { describe, expect, it } from "vitest";
import { fromSpinesEntry, lettered, missingFields, parseAsks } from "../src/inbox/asks.js";

// `options: (a) …; (b) …` read as one option gave `missing: options` and a one-button card.
const A43 = "(a) yes, done (S15 AC-5 ticked); (b) no, something looks wrong (say what)";

describe("lettered options", () => {
  it("splits a lettered list into one option per marker", () => {
    expect(lettered([A43])).toEqual(["(a) yes, done (S15 AC-5 ticked)", "(b) no, something looks wrong (say what)"]);
    expect(lettered(["(1) keep, (2) drop (3) park"])).toEqual(["(1) keep", "(2) drop", "(3) park"]);
    // the bare form without the opening bracket.
    expect(lettered(["A) you click Enable on each domain; B) add Zone Settings: Edit to the token"])).toEqual([
      "A) you click Enable on each domain",
      "B) add Zone Settings: Edit to the token",
    ]);
  });

  it("leaves pipes, single options and out-of-order markers alone", () => {
    expect(lettered(["A", "B"])).toEqual(["A", "B"]);
    expect(lettered(["just one (a) thing"])).toEqual(["just one (a) thing"]);
    expect(lettered(["(b) x; (a) y"])).toEqual(["(b) x; (a) y"]);
    expect(lettered(["plan b) later; a) now"])).toEqual(["plan b) later; a) now"]);
  });

  it("an open decide ask from spines.py with a lettered list is not missing options", () => {
    const a = fromSpinesEntry({ code: "PLAN-2-A43", ask: "decide", question: "Count it done?", options: [A43], recommend: "yes", unblocks: "S15", context: "x", state: "open" })!;
    expect(a.options).toHaveLength(2);
    expect(missingFields(a)).toEqual([]);
  });

  it("the markdown parser splits it too", () => {
    const md = `## Waiting on\n- [ask PLAN-2-A43: decide @Sam since 2026-11-08 row S15] Count it done? — options: ${A43} — recommend: yes — unblocks: S15\n`;
    expect(parseAsks(md, "docs/E.md")[0].options).toHaveLength(2);
  });
});

// airbnb-observatory: a note after the done date left the card "still open until the owner cleans it up".
describe("done marker with a note", () => {
  it("closes the line like the skill does, sha kept when there is one", () => {
    const md = (tail: string) => `## Waiting on\n- [answered T9-A1 2026-11-09 @Sam] Q? — answer: A ${tail}\n`;
    expect(parseAsks(md("· done 2026-11-09 905b4fe round 2 PLAN-5-A2"))[0]).toMatchObject({ doneAt: "2026-11-09", doneSha: "905b4fe" });
    expect(parseAsks(md("· done 2026-11-09 T83-S3 (applied: x)"))[0]).toMatchObject({ doneAt: "2026-11-09", answer: "A" });
    expect(parseAsks(md("; done with it"))[0].doneAt).toBeUndefined();
  });
});
