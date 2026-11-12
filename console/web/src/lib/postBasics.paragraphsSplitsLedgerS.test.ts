import { describe, expect, it } from "vitest";
import { paragraphs } from "./postBasics";

// P-0062's text uses `<br>` between paragraphs (the Writer's workaround for the link rule); it showed as is.
describe("paragraphs", () => {
  it("splits on the ledger's ' · ', on blank lines and on <br> (one or more), never shows a <br>", () => {
    expect(paragraphs("I built Memo.<br>Clip: https://a.b/c.mp4 It works.<br>How do you?")).toEqual(["I built Memo.", "Clip: https://a.b/c.mp4 It works.", "How do you?"]);
    expect(paragraphs("a <br><br> b<BR/>c · d\n\ne")).toEqual(["a", "b", "c", "d", "e"]);
    expect(paragraphs("one·word stays")).toEqual(["one·word stays"]);
  });
});

describe("T46-S4 round 2: the waits line speaks to you in plain grammar", () => {
  it("turns Sam and his verb into you and the base verb", async () => {
    const { toYou } = await import("./postBasics");
    expect(toYou("held by R1 (Kind: post): Sam approves every post")).toBe("held by R1 (Kind: post): you approve every post");
    expect(toYou("Sam watches it, Sam has it, Sam carries it, Sam's note")).toBe("you watch it, you have it, you carry it, your note");
    expect(toYou("waits for Sam")).toBe("waits for you");
  });
});
