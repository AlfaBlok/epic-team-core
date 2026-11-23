import { describe, expect, it } from "vitest";
import { parseAsks } from "../src/inbox/asks.js";
import { fyiRepeatOf, isFyi, parseAskLog, repeatProblem, topicsIn, type PriorAnswer } from "../src/inbox/askRepeat.js";

// E907-S8: the owner, 23 Nov, on E907-A4: "Didn't i answer this several times already?". He said yes to the FYI E907-A3 (his
// personal LinkedIn); the E907-S3 worker then raised E907-A4, another FYI on the same topic citing E907-A3, and the gate let it pass.
const A3_LINE = "- [answered E907-A3 2026-11-23 @Sam \u00b7 done 2026-11-23] FYI: nothing can post from your personal LinkedIn now; every LinkedIn write is stopped until each product posts only from its own page. Why: your red line, \"Under no circumstances use my LinkedIn account to post. It has to post from its own account!\" (Shop desk note dx_000) \u2014 context: the last LinkedIn post went out as the Acme page, not as you. One worker (E907-S3, first in the queue) removes your profile from every posting path and lists anything that ever went out as you, with links; the old card asking whether to keep that posting rule is answered: the rule goes \u2014 impact: no LinkedIn posts until that fix is live \u2014 risk: none to your profile; nothing is deleted without your yes \u2014 recommend: nothing to do \u2014 why Sam: your red line - about: your personal LinkedIn \u2014 unblocks: E907-S3 \u2014 options: Got it \u2014 recommend: None: FYI \u2014 context: raised by Delivery Manager (run run_000) through the console API; the console wrote this line \u2014 about: FYI \u2014 answer: APPROVED";
const A4_OPEN = "- [ask E907-A4: approve @Sam since 2026-11-23] FYI, new since E907-A3 (you said approved): the fix is now live, so nothing can post on LinkedIn as you; every post and reply goes out only as the product's own page. Why: your red line, \"Under no circumstances use my LinkedIn account to post. It has to post from its own account!\" \u2014 context: a post or reply that would show your profile is refused before it is sent; in the last 14 days nothing went out as you (the one reply shows as Acme); LinkedIn posting is back on for the Acme page only \u2014 impact: Acme posts on its page again; Shop and Desk post nothing on LinkedIn until they have pages \u2014 risk: none to your profile; nothing was deleted \u2014 recommend: nothing to do \u2014 why Sam: your red line \u2014 about: your personal LinkedIn \u2014 unblocks: none \u2014 options: Got it \u2014 recommend: None: FYI \u2014 context: raised by the E907-S3 worker (run run_000) \u2014 about: FYI";

const parse = (line: string) => {
  const a = parseAsks(`## Waiting on\n\n${line}`)[0];
  expect(a).toBeDefined();
  return a;
};
const prior = (line: string): PriorAnswer => {
  const a = parse(line);
  const topics = topicsIn(...[...(a.aboutAll ?? []), ...(a.about ? [a.about] : [])].map((t) => `about: ${t}`), a.question, a.why, a.recommend, a.contextText, a.impact, a.risk, a.unblocks);
  return { code: a.code, repo: "home_repo", row: a.row, question: a.question, answer: a.answer, on: a.since!, unblocks: a.unblocks, topics };
};

describe("E907-S8 rule 9b: an FYI on a topic he already answered stays off his inbox", () => {
  it("holds the E907-A4 line: already answered on 2026-11-23 with his answer", () => {
    const a3 = prior(A3_LINE);
    expect(a3.topics).toContain("your personal linkedin");
    const a4 = parse(A4_OPEN);
    expect(a4.state).toBe("open");
    expect(isFyi(a4)).toBe(true);
    expect(fyiRepeatOf({ ...a4, repo: "home_repo" }, [a3])?.how).toBe("topic");
    const why = repeatProblem({ ...a4, repo: "home_repo" }, [a3]);
    expect(why).toMatch(/^already answered on 2026-11-23: "APPROVED" \(E907-A3 in home_repo\)/);
  });

  it("holds it from the asks log too (his yes logged, the about glued into why)", () => {
    const log = [
      { ev: "open", id: "E907-A3", at: "2026-11-23T12:00:00.000Z", what: "FYI: nothing can post from your personal LinkedIn now", why: "your red line - about: your personal LinkedIn", repo: "home_repo" },
      { ev: "try", id: "E907-A3", at: "2026-11-23T03:30:40.439Z", how: "approve" },
      { ev: "close", id: "E907-A3", at: "2026-11-23T03:30:40.439Z", how: "done" },
    ].map((e) => JSON.stringify(e)).join("\n");
    const answered = parseAskLog(log);
    expect(answered[0].topics).toEqual(["your personal linkedin"]);
    expect(repeatProblem({ ...parse(A4_OPEN), repo: "home_repo" }, answered)).toMatch(/^already answered on 2026-11-23: "approved" \(E907-A3/);
  });

  it("holds an FYI on a row he answered, by what it unblocks", () => {
    const fyi = parse("- [ask X7-A20: approve @Sam since 2026-11-20] FYI: the new header is live — options: Got it — recommend: None: FYI — unblocks: X7-S4");
    const p: PriorAnswer = { code: "X7-A12", row: null, unblocks: "X7-S4", question: "Pick the header colour", answer: "green", on: "2026-11-18" };
    expect(fyiRepeatOf(fyi, [p])?.how).toBe("row");
  });

  it("lets a genuine new decide ask on another topic through", () => {
    const decide = parse("- [ask E907-A9: decide @Sam since 2026-11-23] Which X account should Shop post from first? — options: @ShopHQ: post there first · Wait: post nowhere yet — recommend: @ShopHQ — why Sam: only he picks the brand voice — about: Shop's first X account");
    expect(isFyi(decide)).toBe(false);
    expect(repeatProblem({ ...decide, repo: "home_repo" }, [prior(A3_LINE)])).toBeUndefined();
  });

  it("lets a real new decision on the same topic through (options to choose from)", () => {
    const decide = parse("- [ask E907-A10: decide @Sam since 2026-11-23] Should Desk get its own LinkedIn page? — options: Yes: make the page · No: no LinkedIn for Desk — recommend: Yes — why Sam: a new public account — about: your personal LinkedIn");
    expect(repeatProblem({ ...decide, repo: "home_repo" }, [prior(A3_LINE)])).toBeUndefined();
  });

  it("lets an FYI on the same topic through after 14 days", () => {
    const later = parse(A4_OPEN.replace("since 2026-11-23", "since 2026-12-09"));
    expect(fyiRepeatOf(later, [prior(A3_LINE)])).toBeUndefined();
  });

  it("lets an FYI on a new topic through", () => {
    const fyi = parse("- [ask E907-A11: approve @Sam since 2026-11-23] FYI: the Reddit queue is clear — options: Got it — recommend: None: FYI — about: the Reddit queue");
    expect(repeatProblem({ ...fyi, repo: "home_repo" }, [prior(A3_LINE)])).toBeUndefined();
  });
});
