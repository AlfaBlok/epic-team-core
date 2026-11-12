import { describe, expect, it } from "vitest";
import { askGateProblem, ASK_GATE_FROM, ASK_GATE_RULE, heldAsksSection } from "../src/inbox/askGate.js";
import { ASK_TYPE_RULES, parseAsks } from "../src/inbox/asks.js";

// no card reaches the owner for something he did
// not ask for. The Advisor's ten asks of 2026-11-11 (ROOT-A1..A11, root spine), as open lines, are the fixtures.
const open = (kind: string, rest: string, since = "2026-11-11") => {
  const a = parseAsks(`## Waiting on\n\n- [ask ROOT-A1: ${kind} @Sam since ${since}] ${rest}`)[0];
  expect(a).toBeDefined();
  return askGateProblem(a);
};

const A1 = "Your hands this week: eight small things in this order, and the other twelve Mac tickets wait until 17 November — context: the Mac list holds 20 tickets — recommend: do the eight in the order on the page — why Sam: only your Mac and your accounts can do these — unblocks: T92-A3";
const A3 = "Posts go out on their own inside a campaign you approved — context: you said it on 7 November and again on 11 November after cards for 20 December posts reached you — recommend: switch every approved campaign to publish on its own from 12 November — why Sam: it changes what reaches your inbox and what goes public in your name — unblocks: social PLAN-6";
const A6 = "Clear the 15 old epic outcomes in one go, and from now on an outcome you have not answered in 14 days counts as accepted — context: 22 items sit in review — recommend: one page with the 15 and one Accept all — why Sam: today only you may mark an outcome — unblocks: PLAN-9";
const A7 = "Name the Mexico City house watch as the third flywheel product and close the two Idealista asks with your 10 November decision — context: the flywheel line wants two or three products — recommend: house watch as product three — why Sam: it is the goal of a red line — unblocks: deal-funnels PLAN-5-A3";
const A8 = "One scoreboard on your home with five live numbers — context: you asked for a readiness traffic light — recommend: five numbers above the red lines — why Sam: it adds to the first screen you see every day — unblocks: PLAN-48";
const A9 = "Memo opens to strangers on 12 November: the tester page is the door — context: Memo's own spine says it is ready — recommend: declare Memo live for testers on 12 November — why Sam: it is a launch and it is Memo's world — unblocks: memo E23";
const A10 = "One strategy page, approved once, read by every persona at wake — context: you asked three times this week how the three fit — recommend: one page in the house style — why Sam: only you approve the story — unblocks: PLAN-73";
const A11 = "You approve: SocialApp is free for its first 10 testers for 60 days — context: you already decided free testers on 8 November — recommend: yes — why Sam: it is a price and a promise to strangers — unblocks: T46-S5";

describe("T48-S43 the ask gate", () => {
  it("holds the Advisor asks Sam sent back on 2026-11-11, each with a plain reason", () => {
    expect(open("approve", A1)).toMatch(/does not name what of Sam's it answers.*his hands are a `do` ask/);
    expect(open("approve", A3)).toMatch(/go-live date Sam did not set/);
    expect(open("approve", A6)).toMatch(/does not name what of Sam's it answers/);
    expect(open("approve", A7)).toMatch(/re-states something Sam already decided/);
    expect(open("approve", A8)).toMatch(/does not name what of Sam's it answers/);
    expect(open("approve", A9)).toMatch(/go-live date Sam did not set/);
    expect(open("decide", A10)).toMatch(/does not name what of Sam's it answers/);
    expect(open("approve", A11)).toMatch(/re-states something Sam already decided/);
    // a dated batch of posts
    expect(open("approve", "Approve the batch of five posts for 20 December — why Sam: it publishes in your name")).toMatch(/go-live date/);
  });

  it("lets through what is his: money, publishing, access, his ask by id or in his quoted words, his own date", () => {
    expect(open("decide", "Buy socialapp.dev and epicteam.app, $16.40 the first year? — options: A buy both; B only one — recommend: A — why Sam: it is money on your card")).toBeUndefined();
    expect(open("approve", "Approve the rewritten call for testers on X and Reddit — recommend: yes — why Sam: it publishes in your name")).toBeUndefined();
    expect(open("approve", "Give the helper write on the billing repo — recommend: yes — why Sam: it widens access")).toBeUndefined();
    expect(open("decide", "Which of the two home layouts? — context: your voice note vn_e3e2455d — options: A; B — recommend: A")).toBeUndefined();
    expect(open("decide", 'Four lists or one? — context: you said "those are the lists, Memo, Epic Team, Epic Social" — options: A four; B one — recommend: A')).toBeUndefined();
    expect(open("approve", "Open Memo to testers on 12 November as you set the date — why Sam: it publishes in your name")).toBeUndefined();
  });

  it("never holds his own steps (do, provide), answered lines, or open lines older than the rule", () => {
    expect(open("do", "Sign in to x.com on your Mac by 12 November and press Sync — steps: one tap")).toBeUndefined();
    expect(open("provide", "The Stripe key for the 12 November launch — secret: memo STRIPE_SECRET_KEY")).toBeUndefined();
    expect(askGateProblem(parseAsks(`## Waiting on\n\n- [answered ROOT-A9 2026-11-11 @Sam] ${A9} — answer: no`)[0])).toBeUndefined();
    expect(open("approve", A9, "2026-11-10")).toBeUndefined();
    expect(ASK_GATE_FROM).toBe("2026-11-11");
  });

  it("every persona reads the rule; the Delivery Manager gets the held asks with what to do", () => {
    expect(ASK_TYPE_RULES).toContain(ASK_GATE_RULE);
    expect(heldAsksSection([])).toBeUndefined();
    const s = heldAsksSection([{ code: "ROOT-A9", repo: "home_repo", path: "docs/spines/root.md", line: 59, question: "Memo opens to strangers on 12 November", reason: "it carries a go-live date Sam did not set" }])!;
    expect(s).toContain("## Asks held back from Sam");
    expect(s).toContain("- ROOT-A9 home_repo/docs/spines/root.md:60: Memo opens to strangers on 12 November — held: it carries a go-live date Sam did not set");
    expect(s).toMatch(/decide it yourself .* or drop it/);
  });
});

describe("rule 5: every new ask for his hands says why the team cannot do it", () => {
  it("holds a do or provide ask from 2026-11-12 with no why", () => {
    expect(open("do", "Sign in to Google once in your Chrome — steps: type the password", "2026-11-12")).toMatch(/without a `why Sam:`.*Team Browser first/);
    expect(open("provide", "The Cloudflare key for Workers — recommend: now", "2026-11-12")).toMatch(/without a `why Sam:`/);
  });
  it("holds a why that rests on his Mac, Chrome or sign-in without naming our browsers", () => {
    expect(open("do", "Sync TikTok for the team — why Sam: only your Chrome holds the signed-in session", "2026-11-12")).toMatch(/Team Browser or the server browser cannot/);
    expect(open("do", "Make the Memory LinkedIn page — why Sam: your Mac, your Chrome, your sign-ins", "2026-11-12")).toMatch(/rests on his Mac/);
  });
  it("lets through a why that says what only he holds, or why our browsers cannot", () => {
    expect(open("do", "Record four short videos — why Sam: it is your face and your voice on camera", "2026-11-12")).toBeUndefined();
    expect(open("do", "Sync TikTok — why Sam: the server browser sign-in hit TikTok's phone check, and only your Chrome holds the session", "2026-11-12")).toBeUndefined();
    expect(open("provide", "A wider Cloudflare key — why Sam: only the account owner can make a key wider than ours", "2026-11-12")).toBeUndefined();
  });
  it("leaves older hands asks alone, and the persona rule says it", () => {
    expect(open("do", "Sign in to x.com on your Mac — steps: one tap", "2026-11-11")).toBeUndefined();
    expect(ASK_GATE_RULE).toMatch(/do or provide ask .*Team Browser or the server browser/);
  });
});

describe("rule 5 keeps the Team Browser's own re-sync ask", () => {
  it("lets through an ask that itself says what the team's browser hit", () => {
    expect(open("do", "The team's browser is signed out of x.com. Sign in to x.com in Chrome, then press Sync for *.x.com.", "2026-11-12")).toBeUndefined();
  });
});
