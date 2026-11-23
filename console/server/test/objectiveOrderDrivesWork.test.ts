import { describe, expect, it } from "vitest";
import { byMilestonePriority, byObjective } from "../src/inbox/priority.js";
import { lookupOf, objectiveOf, parseObjectives, parsePressing, parsePriorities, parseRedLines } from "../src/inbox/jordiPriority.js";
import { dispatchOrderSection, DISPATCH_ORDER_MAX } from "../src/wakePrompt.js";

/**
 * the owner: is the order of his objectives used at all? Make it so: cards and
 * asks of a higher objective come first in his inbox, and ready rows of a higher objective get worker slots first.
 */
const ids = Array.from({ length: 14 }, (_, i) => `obj-${i + 1}`);
const pursuits = JSON.stringify({ pursuits: ids.map((id, i) => ({ id, name: `Objective ${i + 1}`, epics: [{ repo: "repo1", spine: `docs/spines/epic-${i + 1}.md` }] })) });
// each objective's key result lists its own tickets (the row's own key result names its objective, kr_tickets.py)
const cards = Object.fromEntries(ids.map((id, i) => [id, JSON.stringify({ keyResults: [{ id: "kr", work: [`E907-S${100 + i}`] }] })]));
const defs = parseObjectives(pursuits, undefined, cards);
const item = (id: string, n: number, extra: Record<string, unknown> = {}) => ({ id, repo: "repo1", ref: `E907-S${100 + n - 1}`, path: "docs/spines/epic-907.md", title: id, ...extra });

describe("his inbox: a higher objective's cards and asks come first", () => {
  const levels = JSON.stringify({
    items: [{ repo: "repo1", ref: "E907-S112", level: "high", why: "High." }],
    pressing: [{ repo: "repo1", ref: "E907-S111", kind: "frustrated", why: "Frustrated." }],
  });
  const lines = JSON.stringify({ redLines: [{ name: "Line", objective: "obj-12", sentence: "A line.", state: "agreed", items: [{ repo: "repo1", ref: "E907-S50" }] }] });
  const lookup = lookupOf(parsePriorities(levels, "repo1"), parseRedLines(lines, "repo1"), parsePressing(levels, "repo1"), defs);

  it("objective 2 before 12 even when 12's card is high, pressing or on the red line; none last", () => {
    const items = [
      { id: "none", repo: "repo1", ref: "E907-S1", title: "Tidy logs" },
      item("twelve-pressing", 12),
      item("thirteen-high", 13),
      { id: "red-line-12", repo: "repo1", ref: "E907-S50", title: "On the line" },
      item("two", 2),
      item("fourteen", 14),
    ];
    const out = byMilestonePriority(items, new Map(), lookup);
    expect(out.map((i) => i.id)).toEqual(["two", "twelve-pressing", "red-line-12", "thirteen-high", "fourteen", "none"]);
    const pr = out.map((i) => i.priority!);
    expect([...pr].sort((a, b) => a - b)).toEqual(pr);
  });

  it("objectives past the ninth stay apart (the old order counted only nine)", () => {
    const out = byMilestonePriority([item("fourteen", 14), item("ten", 10), item("eleven", 11)], new Map(), lookup);
    expect(out.map((i) => i.id)).toEqual(["ten", "eleven", "fourteen"]);
  });

  it("an item he asked by name to be first, or urgent, still leads every objective", () => {
    const first = lookupOf([], [], parsePressing(JSON.stringify({ pressing: [{ repo: "repo1", ref: "E907-S1", kind: "first", why: "First." }] }), "repo1"), defs);
    const out = byMilestonePriority([item("one", 1), { id: "asked-first", repo: "repo1", ref: "E907-S1", title: "x" }, { ...item("urgent", 14), urgent: true }], new Map(), first);
    expect(out.map((i) => i.id).slice(-1)).toEqual(["one"]);
  });
});

describe("dispatch: a higher objective's ready rows get worker slots first", () => {
  const rows = [
    { id: "E907-S1", title: "Tidy logs", path: "docs/spines/epic-907.md" },
    { id: "E907-S112", title: "Thirteenth", path: "docs/spines/epic-907.md" },
    { id: "E907-S101", title: "Second", path: "docs/spines/epic-907.md" },
    { id: "E908-S3", title: "In objective 5's epic", path: "docs/spines/epic-5.md" },
  ].map((r) => ({ ...r, repo: "repo1", ref: r.id }));

  it("orders the ready rows by his objectives, the ledger's order breaking ties, none last", () => {
    const out = byObjective(rows, (r) => objectiveOf(defs, r));
    expect(out.map((r) => r.id)).toEqual(["E907-S101", "E908-S3", "E907-S112", "E907-S1"]);
    expect(out[0].objective).toEqual({ n: 1, id: "obj-2", name: "Objective 2" });
  });

  it("the wake prompt lists them in that order, said plainly", () => {
    const text = dispatchOrderSection(byObjective(rows, (r) => objectiveOf(defs, r)));
    expect(text).toContain("## Dispatch order (his objectives)");
    expect(text).toContain("gets a worker slot before a lower one");
    const lines = text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines).toEqual(["1. E907-S101: objective 2, Objective 2", "2. E908-S3: objective 5, Objective 5", "3. E907-S112: objective 13, Objective 13", "4. E907-S1: on none of his objectives"]);
  });

  it("says nothing when no ready row moves an objective, and caps a long list", () => {
    expect(dispatchOrderSection([{ id: "E907-S1" }])).toBe("");
    const many = Array.from({ length: DISPATCH_ORDER_MAX + 5 }, (_, i) => ({ id: `E907-S${i}`, objective: { n: 0, name: "One" } }));
    expect(dispatchOrderSection(many)).toContain("… 5 more ready rows");
  });
});
