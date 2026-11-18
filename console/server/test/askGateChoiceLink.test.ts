import { describe, expect, it } from "vitest";
import { askGateProblem, choiceLinkProblem } from "../src/inbox/askGate.js";
import { parseAsks } from "../src/inbox/asks.js";

// E948-S151 (the owner on E940-A10, 2026-11-18, vn_b2c9395c): "If you don't give me a link, how the fuck do you expect me to
// choose?" A decide ask that picks among named things links the page or picture of its options.
const ask = (rest: string, since = "2026-11-18") => {
  const a = parseAsks(`## Waiting on\n\n- [ask E940-A10: decide @Sam since ${since}] ${rest}`)[0];
  expect(a).toBeDefined();
  return a;
};
const WHY = "— context: your voice note vn_40ab2ea9 asked for mockups";

describe("rule 13: a choice shows its options (E948-S151)", () => {
  it("holds A, B or C with no link anywhere", () => {
    const a = ask(`You decide: which sidebar, A, B or C? ${WHY} — options: Pick A: build A | Pick B: build B | Pick C: build C`);
    expect(choiceLinkProblem(a)).toMatch(/shows none of them/);
    expect(askGateProblem(a)).toMatch(/vn_b2c9395c/);
  });
  it("passes E940-A10 as written: its mockups link in context prose (the card now shows it on its face)", () => {
    const a = ask(`You decide: which sidebar, A, B or C? ${WHY}. Mockups: http://worker.tail-example.ts.net:9680/ — options: Pick A: build A | Pick B: build B | Pick C: build C`);
    expect(choiceLinkProblem(a)).toBeUndefined();
  });
  it("passes a picture path in context", () => {
    const a = ask(`You decide: which logo, A or B? — context: docs/status/logos.webp — why Sam: "pick the logo yourself", vn_40ab2ea9 — options: A: the round one | B: the badge`);
    expect(choiceLinkProblem(a)).toBeUndefined();
  });
  it("a spine on GitHub does not count", () => {
    const a = ask(`You decide: which sidebar, A or B? ${WHY} https://github.com/example/team/blob/main/docs/spines/root.md — options: A: one | B: two`);
    expect(choiceLinkProblem(a)).toMatch(/shows none of them/);
  });
  it("leaves a yes or no question alone", () => {
    const a = ask(`Should we build the sidebar now? ${WHY} — options: Yes, build it | No: drop it`);
    expect(choiceLinkProblem(a)).toBeUndefined();
  });
  it("leaves lines from before 18 November alone", () => {
    const a = ask(`You decide: which sidebar, A, B or C? ${WHY} — options: A: one | B: two | C: three`, "2026-11-17");
    expect(choiceLinkProblem(a)).toBeUndefined();
  });
  it("holds a new ask raised through the API (no since)", () => {
    const { since: _s, ...a } = ask(`You decide: which sidebar, A, B or C? ${WHY} — options: A: one | B: two | C: three`);
    expect(choiceLinkProblem(a)).toMatch(/shows none of them/);
  });
});

describe("rule 13 leaves a choice said wholly in words alone (its buttons are its options)", () => {
  it("start them or keep waiting", () => {
    const a = ask(`You decide: start the waiting rows now? ${WHY} — options: Start them: 10 at a time, your objectives first | Keep waiting: only what you name`);
    expect(choiceLinkProblem(a)).toBeUndefined();
  });
  it("but holds a choice of layouts named in words", () => {
    const a = ask(`You decide: which layout for the inbox? ${WHY} — options: Two columns: cards beside the list | One column: cards under the list`);
    expect(choiceLinkProblem(a)).toMatch(/shows none of them/);
  });
});

describe("rule 13: letters", () => {
  it("holds bare letters", () => {
    const a = ask(`You decide: A, B or C? ${WHY} — options: A | B | C`);
    expect(choiceLinkProblem(a)).toMatch(/shows none of them/);
  });
  it("leaves letters that say what they are (E946-A50)", () => {
    const a = ask(`You decide: how does it reach 5 posts a day? ${WHY} — options: A: thread plus replies · B: own account · Neither: 1 a day`);
    expect(choiceLinkProblem(a)).toBeUndefined();
  });
});
