import { describe, expect, it } from "vitest";
import { faceLabel, faceLinks, isChoice } from "@/lib/faceLink";

// E948-S151: E940-A10's mockups link sat only in its context prose; the card's face link now reads it there.
describe("the face link of an ask (E948-S151)", () => {
  const e40a10 = {
    ask: "decide",
    question: "You decide: which sidebar for your objectives, A, B or C?",
    contextText: 'your voice note 18 Nov (vn_40ab2ea9): "give me some mockups". Mockups on your real objectives: http://worker.tail-example.ts.net:9680/',
    options: ["Pick A: build A, no numbers", "Pick B: build B, number in the ring", "Pick C: build C, number on the edge"],
  };
  it("finds the link in context prose", () => {
    expect(faceLinks(e40a10)).toEqual(["http://worker.tail-example.ts.net:9680/"]);
  });
  it("labels a choice's link See the options", () => {
    expect(isChoice(e40a10)).toBe(true);
    expect(faceLabel(e40a10, "http://worker.tail-example.ts.net:9680/")).toBe("See the options");
    expect(faceLabel(e40a10, "https://x.example.com/a.webp")).toBe("See the options (picture)");
  });
  it("reads markdown targets and drops spine lines on GitHub", () => {
    expect(faceLinks({ contextText: "see [the drafts](https://drafts.example.com/a). Row: https://github.com/o/r/blob/main/docs/spines/x.md#L3." })).toEqual(["https://drafts.example.com/a"]);
  });
  it("a yes or no is not a choice", () => {
    expect(isChoice({ ask: "decide", options: ["Yes, build it", "No"] })).toBe(false);
    expect(faceLabel({ ask: "decide", options: ["Yes", "No"] }, "https://team.example.com/x")).toBe("Open team.example.com");
  });
});
