import { describe, expect, it } from "vitest";
import { parseAsks, unglueLabel, type HumanAsk } from "../src/inbox/asks.js";
import { dryRunOverdue, lineHash, parseDryRuns, URGENT_NOT_CHECKED_NOTE } from "../src/inbox/askDryRun.js";
import { byMilestonePriority, TIER_SPAN } from "../src/inbox/priority.js";
import { FIRST_TIER, lookupOf, OBJECTIVE_TIER } from "../src/inbox/jordiPriority.js";
import { phantomRefProblem } from "../src/inbox/phantomRefs.js";

/**
 * E948-S155 (the owner, 20 Nov 20:11Z: "Why is inbox failing? Why exactly? ... Do we have full diagnostic of the problem?").
 * Two causes still open that day:
 *  - his personal reply card E948-A19 carried `label: urgent` but the console read no such label, and the dry-run gate held it;
 *  - E948-A18 was a decide card (buttons, no box) whose words said "Say or write here what to change".
 */
const URGENT_LINE =
  "- [ask E907-A19: provide @Sam since 2026-11-20 row E907-S156] [four options](https://example.com/opts) : You answer: which option do you send? Write your pick in the box on this card and send it - why Sam: only you can send it - label: urgent — context: raised by Delivery Manager through the console API";

describe("E948-S155 an urgent card leads his inbox", () => {
  it("reads `label: urgent` from a console-written line whose fields are joined by ' - '", () => {
    const [a] = parseAsks(`## Waiting on\n${URGENT_LINE}\n`, "docs/spines/e.md");
    expect(a?.code).toBe("E907-A19");
    expect(a?.urgent).toBe(true);
    // the words stay: the card's id is made from its question
    expect(a?.question).toMatch(/label: urgent/);
  });

  it("reads it from its own field, and from a field spines.py glued it to", () => {
    const [a] = parseAsks("## Waiting on\n- [ask E907-A2: do @Sam since 2026-11-20] Tap Go on example.com — why Sam: his phone — label: urgent\n", "s.md");
    expect(a?.urgent).toBe(true);
    const glued = unglueLabel({ code: "E907-A3", who: "Sam", ask: "do", question: "Tap Go", why: "his phone — label: urgent" } as unknown as HumanAsk);
    expect(glued.urgent).toBe(true);
    const [plain] = parseAsks("## Waiting on\n- [ask E907-A4: do @Sam since 2026-11-20] Tap Go on example.com — why Sam: his phone\n", "s.md");
    expect(plain?.urgent).toBeUndefined();
  });

  it("an urgent ask is never held for its dry run: it shows at once, marked", () => {
    const none = parseDryRuns(JSON.stringify({ items: {} }));
    const justWritten = new Date().toISOString();
    // not urgent: held for up to 2 hours
    expect(dryRunOverdue(URGENT_LINE, "2026-11-20", none, justWritten).note).toBeUndefined();
    // urgent: at once, even with words not committed yet
    expect(dryRunOverdue(URGENT_LINE, "2026-11-20", none, justWritten, Date.now(), true)).toEqual({ note: URGENT_NOT_CHECKED_NOTE, kind: "not-checked" });
    expect(dryRunOverdue(URGENT_LINE, "2026-11-20", none, undefined, Date.now(), true).kind).toBe("not-checked");
    const failed = parseDryRuns(JSON.stringify({ items: { a: { repo: "w", path: "s.md", lineHash: lineHash(URGENT_LINE), verdict: "fail", reason: "step 4: which app" } } }));
    expect(dryRunOverdue(URGENT_LINE, "2026-11-20", failed, justWritten, Date.now(), true)).toEqual({ note: "A fresh reader found this unclear: step 4: which app", kind: "unclear" });
  });

  it("an urgent ask sorts above his first objective's items, which sit above what is pressing", () => {
    const lookup = lookupOf([], undefined, [], [{ n: 0, id: "first", name: "Acme: 5 testers", match: [], repos: ["repo1"], spines: [] }]);
    const items = [
      { id: "a", milestoneId: "m", repo: "repo1", code: "E907-A1" },
      { id: "b", milestoneId: "m", repo: "repo1", code: "E907-A2", urgent: true as const },
    ];
    const out = byMilestonePriority(items, new Map([["m", 0]]), lookup);
    expect(out.map((x) => x.id)).toEqual(["b", "a"]);
    expect(out[0]!.priority!).toBeLessThan(OBJECTIVE_TIER * TIER_SPAN - TIER_SPAN / 2);
    expect(out[0]!.priority!).toBeLessThan(FIRST_TIER * TIER_SPAN + TIER_SPAN / 2);
    expect(FIRST_TIER).toBeLessThan(OBJECTIVE_TIER);
  });
});

describe("E948-S155 a card's words name only the controls its kind shows", () => {
  const base = { who: "Sam", since: "2026-11-20", context: null, contextText: null, why: null, recommend: null, steps: null, options: [] };

  it("holds a decide card whose words ask for a written answer (E948-A18, 20 Nov)", () => {
    const e48a18 = { ...base, ask: "decide", question: "You answer: what should your reply say? Say or write here what to change, and the next version comes back on this card." };
    expect(phantomRefProblem(e48a18)).toMatch(/shows only its buttons and no answer box: make it a provide ask/);
    expect(phantomRefProblem({ ...e48a18, ask: "approve", question: "Approve the plan? Write your changes in the box." })).toMatch(/approve card shows only its buttons/);
  });

  it("the same words on a provide card pass: that card has the box and Send", () => {
    expect(phantomRefProblem({ ...base, ask: "provide", question: "Which option do you send? Write your pick in the box on this card and send it." })).toBeUndefined();
  });

  it("holds a provide card that tells him to press Done, Stuck, Yes or No", () => {
    expect(phantomRefProblem({ ...base, ask: "provide", question: "Send the file, then press Done." })).toMatch(/no Done, Stuck, Yes or No/);
    // a key card's own box is another rule's; a do card has Done
    expect(phantomRefProblem({ ...base, ask: "do", question: "Open example.com, tap Accept, then press Done." })).toBeUndefined();
  });

  it("a decide card that names its buttons passes", () => {
    expect(phantomRefProblem({ ...base, ask: "decide", question: "Do we ship it on Monday?", options: ["Yes: ship it", "No: park it"] })).toBeUndefined();
  });
});

describe("E948-S155 an ask raised through the console API keeps its fields apart", () => {
  it("turns ' - context:' and the like into the line's own fields, so the card and its label read them", async () => {
    const { askLine } = await import("../src/inbox/raise.js");
    const line = askLine(
      "E907-A20",
      { question: "You answer: which option do you send? Write your pick in the box on this card - context: four drafts - impact: the next turn comes back - why Sam: only you can send it - label: urgent", askedBy: "Delivery Manager", kind: "provide" },
      "2026-11-20",
      "Sam",
    );
    expect(line).toContain("on this card — context: four drafts — impact: the next turn comes back — why Sam: only you can send it — label: urgent — context: raised by");
    const [a] = parseAsks(`## Waiting on\n${line}\n`, "s.md");
    expect(a?.urgent).toBe(true);
    expect(a?.impact).toBe("the next turn comes back");
    expect(a?.question).toBe("You answer: which option do you send? Write your pick in the box on this card");
    // a dash inside words is left alone
    expect(askLine("E907-A21", { question: "Pick one - the cheaper - or wait?", askedBy: "x" }, "2026-11-20", "Sam")).toContain("Pick one - the cheaper - or wait?");
  });
});
