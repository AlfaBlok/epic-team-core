import { describe, expect, it } from "vitest";
import { parseAsks } from "../src/inbox/asks.js";
import { askMinutes, parseAskLog, repeatOf, repeatProblem, sizeProblem, stepCount, type PriorAnswer } from "../src/inbox/askRepeat.js";
import { ASK_GATE_RULE } from "../src/inbox/askGate.js";

// E996-S48: the asks page found 14 asks repeating one Sam had already answered and 6 too long for one sitting.
const ask = (rest: string, head = "ask X7-A9: do @Sam since 2026-11-14 row X7-S4") => {
  const a = parseAsks(`## Waiting on\n\n- [${head}] ${rest}`)[0];
  expect(a).toBeDefined();
  return a;
};

const signIn: PriorAnswer = {
  code: "X7-A18",
  repo: "home_repo",
  row: "X7-S4",
  question: "Let Claude on your Mac sign the team account the ops account into the agents' browser once (about 2 minutes, you only start it)",
  answer: "Done, it is signed in now and the browser shows the inbox",
  on: "2026-11-10",
};

describe("E996-S48 rule 9: an ask repeating one Sam already answered is held", () => {
  it("holds the same question on the same row, naming his answer and its date", () => {
    const a = ask("Let Claude on your Mac sign the ops account into the agents' browser once (you type only the password and the phone code) — why Sam: only his phone gets the code, the Team Browser cannot");
    const why = repeatProblem({ ...a, repo: "home_repo" }, [signIn]);
    expect(why).toMatch(/^already answered on 2026-11-10: "Done, it is signed in now and the browser shows the inbox" \(X7-A18 in home_repo\)/);
  });

  it("holds nearly the same words on another row too", () => {
    const a = ask("Let Claude on your Mac sign the team account the ops account into the agents' browser once, you only start it", "ask X7-A30: do @Sam since 2026-11-14 row X7-S9");
    expect(repeatOf(a, [signIn])?.how).toBe("words");
  });

  it("holds the same code asked again on a later day", () => {
    const a = ask("Pick the colour for the cards", "ask X7-A18: decide @Sam since 2026-11-14 row X7-S4");
    expect(repeatOf({ ...a, repo: "home_repo" }, [signIn])?.how).toBe("code");
  });

  it("lets a genuinely new re-ask on the same row through (a different question)", () => {
    const a = ask("Paste the new Stripe test key for the checkout into its card's box — why Sam: only he can open the Stripe account — secret: shop STRIPE_KEY");
    expect(repeatProblem(a, [signIn])).toBeUndefined();
  });

  it("lets a follow-up that cites the earlier ask or his answer through", () => {
    const a = ask("Let Claude on your Mac sign the ops account into the agents' browser once more: after X7-A18 the sign-in expired on 13 November");
    expect(repeatProblem(a, [signIn])).toBeUndefined();
  });

  it("never counts an answer given after the ask was raised, nor the ask's own line", () => {
    const a = ask("Let Claude on your Mac sign the ops account into the agents' browser once", "ask X7-A9: do @Sam since 2026-11-09 row X7-S4");
    expect(repeatProblem(a, [signIn])).toBeUndefined();
    const b = ask("Let Claude on your Mac sign the team account the ops account into the agents' browser once (about 2 minutes, you only start it)");
    expect(repeatProblem({ ...b, at: "r:p:1" }, [{ ...signIn, at: "r:p:1" }])).toBeUndefined();
  });

  it("reads his answers from the asks log: his words, else what he pressed; stuck and feedback are not answers", () => {
    const log = [
      { ev: "open", id: "X7-A18", at: "2026-11-09T10:00:00Z", what: signIn.question, row: "X7-S4", repo: "home_repo" },
      { ev: "try", id: "X7-A18", at: "2026-11-10T09:00:00Z", how: "stuck", words: "where is the button?" },
      { ev: "try", id: "X7-A18", at: "2026-11-10T10:00:00Z", how: "answer", words: "Done, it is signed in" },
      { ev: "close", id: "X7-A18", at: "2026-11-10T10:00:00Z", how: "done" },
      { ev: "open", id: "X7-A19", at: "2026-11-09T10:00:00Z", what: "Approve the spend", repo: "home_repo" },
      { ev: "try", id: "X7-A19", at: "2026-11-11T10:00:00Z", how: "approve" },
      { ev: "close", id: "X7-A19", at: "2026-11-11T10:00:00Z", how: "done" },
      { ev: "open", id: "X7-A20", at: "2026-11-09T10:00:00Z", what: "Still open" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(parseAskLog(`${log}\nnot json\n`)).toEqual([
      { code: "X7-A18", repo: "home_repo", row: "X7-S4", question: signIn.question, answer: "Done, it is signed in", on: "2026-11-10" },
      { code: "X7-A19", repo: "home_repo", row: null, question: "Approve the spend", answer: "approved", on: "2026-11-11" },
    ]);
  });
});

describe("E996-S48 rule 10: an ask longer than 20 minutes is held as too long for one sitting", () => {
  it("reads its effort first", () => {
    expect(sizeProblem(ask("Record the four videos — effort: ~75 min over four runs"))).toMatch(/^too long for one sitting: split it \(its effort says ~75 min over four runs, over 20 minutes\)/);
    expect(sizeProblem(ask("Record one video — effort: ~10 min"))).toBeUndefined();
    expect(sizeProblem(ask("Move the domain — effort: about an hour"))).toMatch(/too long for one sitting/);
  });

  it("else the time its words give as its own length, never a deadline", () => {
    expect(sizeProblem(ask("Set up the store on your phone, about 30 to 45 minutes"))).toMatch(/it says about 45 minutes/);
    expect(sizeProblem(ask("Answer within 24 hours so the post goes out"))).toBeUndefined();
    expect(sizeProblem(ask("Sign in once, about 5 minutes"))).toBeUndefined();
  });

  it("else 3 minutes a numbered step", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `${i + 1}) press button ${i + 1}`).join(" ");
    expect(sizeProblem(ask(`Set up the phone — steps: ${eight}`))).toMatch(/8 steps, about 24 minutes/);
    expect(sizeProblem(ask("Set up the phone — steps: 1) open the page 2) press Sync 3) say done"))).toBeUndefined();
    // a stray number is not a step list
    expect(stepCount("it costs 49. Then 12) things")).toBe(0);
    expect(askMinutes(ask("Read the page"))).toBeUndefined();
  });

  it("every persona reads both rules", () => {
    expect(ASK_GATE_RULE).toMatch(/already answered on <date>: <his answer>/);
    expect(ASK_GATE_RULE).toMatch(/too long for one sitting: split it/);
  });
});
