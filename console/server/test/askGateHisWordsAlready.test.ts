import { describe, expect, it } from "vitest";
import { askGateProblem, ASK_GATE_RULE, hisWordsAlreadyAsk } from "../src/inbox/askGate.js";
import { ASK_WRITING_RULE, parseAsks } from "../src/inbox/asks.js";
import { objectiveSection } from "../src/wakePrompt.js";

// E907-S66: four cards in 36 hours (E907-A1..A4) quoted his own voice note naming a key result and still asked him to
// approve it. His E907-A2 feedback, 24 Nov: "Haven't o replied to this several times already??? Is this a repeat?"
// The real lines from the alignment spine, re-opened, are the fixtures.
const parse = (kind: string, rest: string, since = "2026-11-24") => {
  const a = parseAsks(`## Waiting on\n\n- [ask E907-A9: ${kind} @Delivery-Manager since ${since}] ${rest}`)[0];
  expect(a).toBeDefined();
  return a;
};
const gate = (kind: string, rest: string) => askGateProblem(parse(kind, rest));

const A1 = "New: three measures of knowledge compounding now run, and only 45% of your notes this week deepen a topic we already have (your Frankfurt notes made 5 new files, 1 went into the house file). Make \"Most of my notes deepen a topic we already have\" a key result of Get the team to understand me, 80% over 7 days? — why: your voice note of 23 Nov 17:15Z (vn_8e8b0693): \"I want to measure knowledge compounding. Is knowledge incremental? … Can you propose some measures and start implementing them?\" — context: three measures are live on [Does what we learn compound?](http://host1.example.com:9882/#measures): notes that deepen a topic 45% this week, growth that goes deeper 29%, new scattered files 436 a week; your Frankfurt notes today made 5 new files and 1 went into the house file — impact: on yes it joins your objective's key results with a daily number; nothing else is built before your answer — risk: none, a key result can be dropped later — recommend: yes, it reads your own Frankfurt example straight — why Sam: only you set your key results — options: Yes: topic depth becomes the key result at 80% | Growth: use deeper growth instead, 29% now | Files: use fewer new files instead, 436 now — about: knowledge compounding — unblocks: E907-S249";
const A2 = "You approve: \"Team efficiency is measured the same way for every persona\" becomes a key result of Get the team to understand me, target for now: we can measure it. Why: you asked for one standard way to measure each persona's efficiency, and it now runs. — his words: your voice note of 24 Nov 05:11Z (Log/2026-11-24.md#^e-0a42dd): \"another key result is team efficiency is measured and capped ... for now the key result is we are able to measure team efficiency ... we have a standard way of measuring the efficiency of a persona\" — context: the measure runs on [How well each persona spends](http://host1.example.com:9888/#chart): the share of each persona's spend in runs that made something true, last 7 days; the team is at 67% ($3,429 of $5,083), the worst three are Unblocker 5%, Delivery Manager 28%, Gap finder 45%, each with one fix on the page — impact: on yes it joins your objective's key results, green while every persona is read each day; the Unblocker fix is a separate draft ticket and every later fix is judged by this number; a number to cap waste at comes after a week of readings — risk: none, a key result can be dropped later — recommend: yes, it is the standard way you asked for and it already names where the money goes — why Sam: only you set your key results — options: Yes: add the key result | No: keep the page only — about: team efficiency — unblocks: E907-S254, E907-S258";
const A3 = "You approve: \"Correct automated actions\" becomes a key result of Get the team to understand me: the steps nobody asked for that you label correct, 10 a week and more correct than not. Why: you asked to count the necessary things that happened without you, and the log that lists them now runs. — his words: your voice note of 24 Nov 05:11Z (Log/2026-11-24.md#^e-0a42dd): \"one key result is what is the number of... Correct automated actions ... how many things happened that I didn't trigger and that were necessary\" — context: every wheel has a Log tab now ([the one for this objective](https://console.example.com/sets/alignment?tab=log)); last 7 days: 1,430 steps on 22 wheels, 330 the team chose; you tap Correct or Not correct on each; page [Persona log](http://host1.example.com:9889/) — impact: on yes it joins your objective's key results, read four times a day, red until you have labelled 10 correct in a week; nothing else waits on it — risk: none, a key result can be dropped later — recommend: yes, it is your measure and it already has the list behind it — why Sam: only you set your key results and only you can say a step was correct — options: Yes: add the key result | No: keep the Log tab only — about: correct automated actions — unblocks: E907-S253";
const A4 = "Make \"Understanding both ways: every week the team tells me what is unclear, and I answer\" a key result of Get the team to understand me? — why: your voice note of 24 Nov 06:11Z (Log/2026-11-24.md#^e-122de2): \"I want the key results under the objective the team gets me, that we have this understanding of both ways, you know, that I feel that you understand me, but I also understand you a little bit, so that you can express what you need from me\" — context: since today the desk and each objective manager send you one card a week on your inbox: what is unclear to them in your notes, feedback on your notes, and what would help them; the first one, from the desk, waits on your inbox now. How it works and how it joins the kernel: [Understanding both ways](http://host1.example.com:9890/#kr). The measure: of the desk and the managers that worked this week, how many told you, and how many of their cards you answered; today 1 of 13 — impact: on yes it joins your objective's key results, green when all of them told you in the last 7 days and you answered at least half of their cards — risk: up to one more card a week per objective on your inbox; a key result can be dropped later — recommend: yes, it is the two-way measure you asked for and the cards already go out — why Sam: only you set your key results — options: Yes: add the key result | No: keep the weekly cards, no key result — about: understanding both ways — unblocks: E907-S260";

describe("E907-S66 an ask whose own quote of his already asks for the thing is held", () => {
  it("holds E907-A2, A3 and A4: each quotes him naming the key result it asks him to approve", () => {
    for (const [kind, line] of [["approve", A2], ["approve", A3], ["decide", A4]] as const) {
      // A4 also cites "you approved" style words (rule 2 holds it first); either way it never reaches him
      expect(gate(kind, line)).toMatch(/its own quote of .* already asks for this .* do it from his words and close the ask|re-states something/);
      expect(hisWordsAlreadyAsk(parse(kind, line))).toBeTruthy();
    }
    expect(hisWordsAlreadyAsk(parse("approve", A2))).toMatch(/key result is/);
  });

  it("lets a real choice through: E907-A1 quotes him asking for measures, not the one it names", () => {
    expect(hisWordsAlreadyAsk(parse("decide", A1))).toBeUndefined();
  });

  it("never counts the asked thing's own quote, a negated wish, or a quote on another topic", () => {
    expect(hisWordsAlreadyAsk(parse("approve", 'You approve: "Every persona logs what it did and why" becomes a key result — why Sam: only you set your key results'))).toBeUndefined();
    expect(hisWordsAlreadyAsk(parse("approve", 'You approve: "Team efficiency is measured for every persona" becomes a key result — why: your voice note vn_0a42dd11: "I don\'t want team efficiency measured per persona yet" — why Sam: only you set your key results'))).toBeUndefined();
    expect(hisWordsAlreadyAsk(parse("approve", 'You approve: "Team efficiency is measured for every persona" becomes a key result — why: your voice note vn_0a42dd11: "we need a better house search in Mexico City" — why Sam: only you set your key results'))).toBeUndefined();
    expect(hisWordsAlreadyAsk(parse("decide", 'Four lists or one? — context: you said "those are the lists, Memo, Epic Team, Epic Social" — options: A four; B one — recommend: A'))).toBeUndefined();
  });

  it("does not hold his own hands or answered lines", () => {
    expect(hisWordsAlreadyAsk(parse("do", A2))).toBeUndefined();
    expect(askGateProblem(parseAsks(`## Waiting on\n\n- [answered E907-A2 2026-11-24 @Sam] ${A2} — answer: yes`)[0])).toBeUndefined();
  });

  it("every persona reads it in the ask gate rule", () => {
    expect(ASK_GATE_RULE).toMatch(/own quote of his words already tells the team to do the asked thing/);
  });

  it("the objective manager owns its key result list; a worker never asks for one alone", () => {
    const s = objectiveSection("alignment", { name: "EpicTeam: Get the team to understand me", epics: ["home_repo: docs/spines/alignment.md"] });
    expect(s).toMatch(/You own its key result list: workers hand you a proposed key result .* never their own ask/);
    expect(s).toMatch(/his own words already name .* you add the same wake .* never an ask/);
    expect(ASK_WRITING_RULE).toMatch(/Key results go to the objective's manager, not an ask/);
  });
});
