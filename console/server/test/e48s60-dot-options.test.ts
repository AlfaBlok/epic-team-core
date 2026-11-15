import { describe, expect, it } from "vitest";
import { fromSpinesEntry, lettered, parseAsks } from "../src/inbox/asks.js";

// E948-S60: E946-A29 rendered its three options (A, B, your own number) as ONE radio line: they were written with ` · `.
const A29 = "A posts out on time, 14 of 14 this week · B people talking to us about testing, 5 this week · your own number";
const LINE = `- [ask E946-A29: decide @the owner since 2026-11-12] You decide: this week's one number is A or B. — context: day 4 of 30 — options: ${A29} — recommend: B, because a tester only comes from a conversation — why the owner: it sets where the team spends the next five days`;

describe("options written with a middle dot", () => {
  it("the spine line gives one option per choice", () => {
    const [a] = parseAsks(`# EPIC-946\n\n## Waiting on\n\n${LINE}\n`, "docs/spines/epic-46.md");
    expect(a.options).toEqual(["A posts out on time, 14 of 14 this week", "B people talking to us about testing, 5 this week", "your own number"]);
  });

  it("spines.py's one-string list splits the same way", () => {
    const a = fromSpinesEntry({ code: "E946-A29", ask: "decide", question: "This week's one number?", options: [A29], recommend: "B", unblocks: "x", context: "x", state: "open" })!;
    expect(a.options).toHaveLength(3);
  });

  it("pipes still win, and a middle dot inside one option stays when a pipe splits", () => {
    expect(lettered(["a · b"])).toEqual(["a", "b"]);
    const [a] = parseAsks(`# X\n\n## Waiting on\n\n- [ask X-A1: decide @the owner since 2026-11-12] Pick one? — options: one · with a dot | two — recommend: two\n`, "docs/spines/x.md");
    expect(a.options).toEqual(["one · with a dot", "two"]);
  });
});
