import { describe, expect, it } from "vitest";
import { aboutOf, ABOUT_FROM, withAbout } from "../src/inbox/about.js";
import { aboutLineProblem, askGateProblem } from "../src/inbox/askGate.js";
import { parseAsks, fromSpinesEntry, unglueAbout } from "../src/inbox/asks.js";
import { askLine } from "../src/inbox/raise.js";
import { gateProblems, parseCard } from "../src/review/card.js";

/**
 * E948-S172 (the owner, 22 Nov 18:08Z, vn_106f5727, on the dad script card and the kernel card: "can you not just put ...
 * somewhere there that says what's the topic, what is this related to ... I keep saying this, can you please do it"):
 * every card opens with `About: <topic>`; a new card without one is held as "card needs rewriting: no About line".
 */
describe("E948-S172 every card says what it is about", () => {
  it("an ask line's `about:` is the card's topic, read by the markdown parser and taken off a field spines.py glued it to", () => {
    const [a] = parseAsks(
      "## Waiting on\n- [ask E901-A1: decide @Sam since 2026-11-23 row E901-S1] [a short script](https://x.example/) : You decide: read it? — options: Yes: read it | No: change it — recommend: yes — about: your reply to Dad",
    );
    expect(a.about).toBe("your reply to Dad");
    expect(a.question).not.toMatch(/about/);
    const glued = unglueAbout(fromSpinesEntry({ code: "E901-A1", ask: "decide", question: "read it?", why: "only you can speak to him — about: your reply to Dad" })!);
    expect(glued.about).toBe("your reply to Dad");
    expect(glued.why).toBe("only you can speak to him");
  });

  it("an ask with no about gets a plain one derived: its link's own words, else its row title's first clause, 8 words or fewer, no codes", () => {
    expect(aboutOf({ question: "[a short script to read to your dad](http://h:9547/) : You decide: read it?", title: "E948-S156 A back-and-forth card on his inbox" })).toEqual({ about: "a short script to read to your dad", given: false });
    expect(aboutOf({ question: "http://h/t/E988-S67/ : You do: pay", title: "E988-S67 Pay €1 with his own card on the private pay page, so a real card works" })?.about).toBe("Pay €1 with his own card");
    expect(aboutOf({ title: "E907-S23 The email to the 19 Nov tester, describing Acme fairly: Sam asked" })?.about).toBe("The email to the 19 Nov tester");
    expect(aboutOf({ title: "EPIC-940: Lanes and radar: Sam sees his big lanes" })?.about).toBe("Lanes and radar");
    // a title whose first clause is one word still gives the card a topic
    expect(aboutOf({ title: "EPIC-902: FLOP: mechanics, how to take part", goal: "EPIC-902: FLOP: mechanics" })?.about).toBe("FLOP");
    // a checkout name is never a topic
    expect(aboutOf({ title: "tax-alpha-audit-facturas-2026 Auditoría de facturas y IVA 2026 (Alpha)" })?.about).toBe("Auditoría de facturas y IVA 2026");
    for (const t of ["E906-S190 one kernel. Core: changes x", "EPIC-907: Real-user production test — 5 testers on free passes"]) {
      const a = aboutOf({ title: t })!.about;
      expect(a.split(/\s+/).length).toBeLessThanOrEqual(8);
      expect(a).not.toMatch(/E\d+-S\d+|EPIC-\d+|Core:/);
    }
  });

  it("every item the inbox API sends carries an about; one written on the ask wins over the derived one", () => {
    const derived = withAbout<{ about?: string; aboutGiven?: true; title: string; question: string; milestoneTitle: string }>({ title: "E907-S26 A first-note nudge on WhatsApp: a tester", question: "You approve: one message", milestoneTitle: "Five testers use Acme" });
    expect(derived.about).toBe("A first-note nudge on WhatsApp");
    expect(derived.aboutGiven).toBeUndefined();
    const given = withAbout({ about: "your reply to Dad", aboutGiven: true as const, title: "E948-S156 A back-and-forth card", question: "q" });
    expect(given).toMatchObject({ about: "your reply to Dad", aboutGiven: true });
  });

  it("the gate holds a NEW ask (raised from ABOUT_FROM) with no plain about line: card needs rewriting: no About line", () => {
    const base = { ask: "decide", question: "Pick one? Open https://x.example/", options: ["Yes: go", "No: stop"], recommend: "yes", why: "you asked for it, vn_abcdef12", state: "open" };
    expect(aboutLineProblem({ ...base, since: ABOUT_FROM })).toMatch(/^card needs rewriting: no About line/);
    expect(askGateProblem({ ...base, since: ABOUT_FROM })).toMatch(/no About line/);
    expect(aboutLineProblem({ ...base, since: ABOUT_FROM, about: "E948-S156 the dad card" })).toMatch(/names a code/);
    expect(aboutLineProblem({ ...base, since: ABOUT_FROM, about: "one two three four five six seven eight nine" })).toMatch(/longer than 8 words/);
    expect(aboutLineProblem({ ...base, since: ABOUT_FROM, about: "your reply to Dad" })).toBeUndefined();
    // an older ask keeps its derived line and is never held for it
    expect(aboutLineProblem({ ...base, since: "2026-11-22" })).toBeUndefined();
  });

  it("an ask the console writes for a persona always carries its about line", () => {
    const line = askLine("E901-A9", { question: "[the startup forms](https://x.example/) : send these four forms as written?", askedBy: "the Tax persona" }, "2026-11-23");
    expect(line).toMatch(/ — about: the startup forms$/);
    expect(parseAsks(`## Waiting on\n${line}`)[0].about).toBe("the startup forms");
    const own = askLine("E901-A9", { question: "send these?", askedBy: "x", about: "your company forms" }, "2026-11-23");
    expect(own).toMatch(/ — about: your company forms$/);
  });

  it("a review card's `about:` is read and must be plain (the quality check holds a new card with neither about nor name)", () => {
    const card = (extra: string) =>
      parseCard(`---\nrow: E901-S1\ntitle: The kernel page was drawn.\ngoal: Every product keeps your requests moving.\ndelivered:\n  - ✓ The page is live.\nevidence: https://x.example/\nscreenshot: a.webp\nsource: 'Your note: "what is the problem"'\ndecision: Do we build it? We recommend yes.\n${extra}---\n`)!;
    const gate = (extra: string) => gateProblems({ card: card(extra), project: "The team console", goalSentence: "Every product runs itself.", screenshotFound: true });
    expect(gate("")).toEqual([]);
    expect(gate("about: one kernel for every product\n")).toEqual([]);
    expect(card("about: one kernel for every product\n").about).toBe("one kernel for every product");
    expect(gate("name: One kernel\n")).toEqual([]);
    expect(gate("about: E906-S190 kernel\n").join(" | ")).toMatch(/About line is not plain/);
  });
});

describe("E948-S172 an about line added to a checked card keeps its quality check", () => {
  it("the card's fingerprint without its about line still matches the check", async () => {
    const { qcVerdict, cardSha } = await import("../src/review/qc.js");
    const before = "---\nrow: E901-S1\ntitle: x\nname: One kernel\n---\n";
    const qc = { row: "E901-S1", cardSha: cardSha(before), checkedAt: "2026-11-22", words: [], visual: { pass: true, problems: [] }, pass: true } as never;
    expect(qcVerdict({ row: "E901-S1", required: true, qc, cardText: before.replace("name: One kernel\n", "name: One kernel\nabout: one kernel for every product\n") })).toBeUndefined();
    expect(qcVerdict({ row: "E901-S1", required: true, qc, cardText: before.replace("title: x", "title: y") })?.reason).toBe("changed since its check");
  });
});
