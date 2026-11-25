import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAsks } from "../src/inbox/asks.js";
import { repeatOf, repeatProblem, type PriorAnswer } from "../src/inbox/askRepeat.js";
import { sameQuestion } from "../src/inbox/duplicate.js";
import {
  borderlinePairs,
  callOf,
  judgePairs,
  judgeWanted,
  meaningCall,
  MEANING_BORDER,
  MEANING_SURE,
  mergedPairs,
  nearest,
  resetSameMeaning,
  type PairJudge,
} from "../src/inbox/sameMeaning.js";
import { oneQuestionOneCard, type ReviewRow } from "../src/review/rows.js";

/**
 * E948-S206: cards that ask the same thing in different words are merged like near-identical ones, only when the judge is
 * sure; a borderline pair is listed, never merged; look-alikes that ask something different stay apart. The pairs below
 * are shaped on real repeats the owner called out (the X sign-in asked twice, the Cloudflare plan asked twice, the social
 * accounts asked again) and on look-alikes that were different asks (another account, another server).
 */

// the same ask in other words
const SIGN_IN_A = "Please log the agent account back in to x.com in your Chrome and press Sync for x.com in the console's Browser auth.";
const SIGN_IN_B = "The team's browser lost its X session since 05:48. You sign in as the agent account in Chrome, then press Sync on the auth page.";
const PLAN_A = "Turn on Cloudflare Workers Paid (5 USD a month) and let the team have a Cloudflare key that can deploy Workers.";
const PLAN_B = "You give: one Cloudflare key so the app sends its own email, after switching on Cloudflare's 5 dollar a month Workers Paid plan.";
// a look-alike: the same site, another account
const OTHER_ACCOUNT = "After you rename the agent account to the memory account yourself, sign in to X as the memory account on your Mac and do one sync.";
// borderline: a token, but for another server
const TOKEN_A = "You give: a new GitHub token for the build server, because GitHub refuses its saved token since this morning.";
const TOKEN_B = "You do: renew the GitHub sign-in of your account on the web server, because its token leaked into a process list today.";

// what a judge says of each pair (either way round, the card's title around it or not)
const TRUTH: [string, string, { same: boolean; confidence: number }][] = [
  [SIGN_IN_A, SIGN_IN_B, { same: true, confidence: 95 }],
  [PLAN_A, PLAN_B, { same: true, confidence: 90 }],
  [SIGN_IN_B, OTHER_ACCOUNT, { same: false, confidence: 85 }],
  [SIGN_IN_A, OTHER_ACCOUNT, { same: false, confidence: 80 }],
  [TOKEN_A, TOKEN_B, { same: true, confidence: 60 }],
];
const low = (s: string) => s.toLowerCase().replace(/\s+/g, " ").slice(0, 200);
let calls = 0;
const fake: PairJudge = async (pairs) => {
  calls += pairs.length;
  const has = (t: string, x: string) => t.includes(low(x).slice(0, 60));
  return pairs.map((p) => TRUTH.find(([x, y]) => (has(p.a, x) && has(p.b, y)) || (has(p.a, y) && has(p.b, x)))?.[2] ?? { same: false, confidence: 90 });
};

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "same-meaning-"));
  process.env.CONSOLE_SAME_MEANING_FILE = path.join(dir, "same-meaning.json");
  resetSameMeaning();
  calls = 0;
});
afterEach(() => {
  delete process.env.CONSOLE_SAME_MEANING_FILE;
  resetSameMeaning();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the meaning check: judged once, sure merges, borderline listed", () => {
  it("the word rule misses these pairs; the meaning check catches them once judged", async () => {
    expect(sameQuestion(SIGN_IN_A, SIGN_IN_B)).toBe(false);
    expect(sameQuestion(PLAN_A, PLAN_B)).toBe(false);
    // not judged yet: no call, the pair is queued
    expect(meaningCall(SIGN_IN_A, SIGN_IN_B)).toBeUndefined();
    expect(meaningCall(PLAN_A, PLAN_B)).toBeUndefined();
    expect(await judgeWanted(fake)).toBe(2);
    expect(meaningCall(SIGN_IN_A, SIGN_IN_B)).toBe("same");
    expect(meaningCall(PLAN_B, PLAN_A)).toBe("same");
    // judged once: asking again costs nothing
    expect(await judgeWanted(fake)).toBe(0);
    expect(calls).toBe(2);
  });

  it("a look-alike on another account stays apart; a not-sure pair is borderline, listed, never merged", async () => {
    await judgePairs(fake, [
      { a: SIGN_IN_B, b: OTHER_ACCOUNT },
      { a: TOKEN_A, b: TOKEN_B, refA: "acme X1-A5", refB: "acme X2-A59" },
      { a: SIGN_IN_A, b: SIGN_IN_B },
    ]);
    expect(meaningCall(SIGN_IN_B, OTHER_ACCOUNT)).toBe("different");
    expect(meaningCall(TOKEN_A, TOKEN_B)).toBe("border");
    expect(borderlinePairs().map((p) => [p.refA, p.refB])).toEqual([["acme X1-A5", "acme X2-A59"]]);
    expect(mergedPairs()).toHaveLength(1);
    expect(callOf({ same: true, confidence: MEANING_SURE })).toBe("same");
    expect(callOf({ same: true, confidence: MEANING_BORDER })).toBe("border");
    expect(callOf({ same: true, confidence: MEANING_BORDER - 1 })).toBe("different");
    expect(callOf({ same: false, confidence: 99 })).toBe("different");
  });

  it("only cards sharing a word are judged, the closest first", () => {
    const got = nearest(SIGN_IN_A, ["Which hotel in Frankfurt?", OTHER_ACCOUNT, SIGN_IN_B], (s) => s);
    expect(got).toEqual([SIGN_IN_B, OTHER_ACCOUNT]);
  });

  it("with the check off nothing is queued or judged", async () => {
    process.env.CONSOLE_SAME_MEANING = "off";
    try {
      expect(meaningCall(SIGN_IN_A, SIGN_IN_B)).toBeUndefined();
      expect(await judgeWanted(fake)).toBe(0);
    } finally {
      delete process.env.CONSOLE_SAME_MEANING;
    }
  });
});

describe("review cards: the newer one asking the same in other words goes back to fold", () => {
  const row = (ref: string, verifiedAt: string, title: string, decision: string) =>
    ({ id: ref, ref, title, repo: "acme", path: "docs/spines/x.md", status: "review", links: [], closes: {}, verifiedAt, verdict: { kind: "card" }, face: { title, decision } }) as unknown as ReviewRow;

  it("merges a true pair once judged, keeps the look-alike", async () => {
    const a = row("X1-S1", "2026-11-20", "The X sign-in", SIGN_IN_A);
    const b = row("X1-S2", "2026-11-21", "The X sign-in", SIGN_IN_B);
    const c = row("X1-S3", "2026-11-22", "The X sign-in", OTHER_ACCOUNT);
    oneQuestionOneCard([a, b, c]);
    // first pass: queued, nothing merged yet
    expect([a, b, c].map((x) => x.verdict.kind)).toEqual(["card", "card", "card"]);
    await judgeWanted(fake);
    for (const x of [a, b, c]) x.verdict = { kind: "card" } as ReviewRow["verdict"];
    oneQuestionOneCard([a, b, c]);
    expect(a.verdict.kind).toBe("card");
    expect(b.verdict).toMatchObject({ kind: "needs-rewriting", reason: "card needs rewriting" });
    expect(b.verdict.problems?.[0]).toMatch(/^it asks the same as X1-S1's card in other words, still open: one question, one card\. Fold it into X1-S1's card with the owner's words from both, tell the owners of both rows/);
    expect(c.verdict.kind).toBe("card");
  });
});

describe("rule 9: the same ask he already answered, in other words, is held", () => {
  const ask = (rest: string, head: string) => parseAsks(`## Waiting on\n\n- [${head}] ${rest}`)[0];
  const plan: PriorAnswer = { code: "T9-A9", repo: "acme", row: "T9-S1", question: PLAN_A, answer: "We already have a paid account", on: "2026-11-10" };

  it("held once judged sure, with his answer and the meaning named", async () => {
    const a = ask(PLAN_B, "ask Z6-A10: give @Sam since 2026-11-12 row Z6-S11");
    expect(repeatProblem({ ...a, repo: "acme" }, [plan])).toBeUndefined();
    await judgeWanted(fake);
    expect(repeatOf({ ...a, repo: "acme" }, [plan])?.how).toBe("meaning");
    expect(repeatProblem({ ...a, repo: "acme" }, [plan])).toMatch(/^already answered on 2026-11-10: "We already have a paid account" \(T9-A9 in acme, the same ask in other words\)/);
  });

  it("a follow-up citing the earlier ask passes, and a look-alike with a different ask passes", async () => {
    const f = ask(`${PLAN_B} After T9-A9 the plan is on.`, "ask Z6-A11: give @Sam since 2026-11-12 row Z6-S11");
    const other = ask(OTHER_ACCOUNT, "ask Z6-A12: do @Sam since 2026-11-12 row Z6-S12");
    const signedIn: PriorAnswer = { code: "T9-A2", repo: "acme", question: SIGN_IN_B, answer: "done", on: "2026-11-09" };
    repeatProblem({ ...f, repo: "acme" }, [plan]);
    repeatProblem({ ...other, repo: "acme" }, [signedIn]);
    await judgeWanted(fake);
    expect(repeatProblem({ ...f, repo: "acme" }, [plan])).toBeUndefined();
    expect(repeatProblem({ ...other, repo: "acme" }, [signedIn])).toBeUndefined();
  });
});
