import { describe, expect, it } from "vitest";
import { byMilestonePriority } from "../src/inbox/priority.js";
import { lookupOf, objectiveOf, parseObjectives, parsePressing, parsePriorities, parseRedLines } from "../src/inbox/jordiPriority.js";

/**
 * the owner: the inbox order follows his priorities by itself, no hand-set rule. His objectives in his order
 * (the objectives file) and the words that tell a note is about each (the words file) rank every card and ask;
 * the first objective's items lead, his order breaks ties inside every tier, and each card says why.
 */
const pursuits = JSON.stringify({
  pursuits: [
    { id: "acme-live", name: "Acme commercially live", numbers: { campaign: "acme-social" }, epics: [{ repo: "acme", spine: "docs/EPIC-907.md" }], watch: [{ repo: "repo1", paths: ["docs/launch/acme.md"] }] },
    { id: "beta-testers", name: "5 testers using Beta", epics: [{ repo: "repo1", spine: "docs/spines/epic-46.md" }] },
    { id: "vault", name: "All secrets in the vault", watch: [{ repo: "repo1", paths: ["docs/spines/accounts.md"] }] },
  ],
});
const words = JSON.stringify({
  objectives: [
    { id: "acme-live", name: "Five testers use Acme", match: [["acm[ey]"]] },
    { id: "beta-testers", name: "5 testers using Beta", match: [["beta", "tester"]] },
    { id: "vault", name: "Every password lives in your vault", match: [["vault"], ["password"]] },
    { id: "house", name: "The house", match: [["house"]] },
  ],
});
const levels = JSON.stringify({
  items: [{ repo: "repo1", ref: "E907-S1", level: "high", why: "High." }],
  pressing: [{ repo: "repo1", ref: "E907-S2", kind: "frustrated", why: "Frustrated." }],
});
const lines = JSON.stringify({ redLines: [{ name: "Acme's first tester", objective: "acme-live", sentence: "First tester.", state: "agreed", items: [{ repo: "repo1", ref: "E907-S16" }] }] });
const defs = parseObjectives(pursuits, words);
const lookup = lookupOf(parsePriorities(levels, "repo1"), parseRedLines(lines, "repo1"), parsePressing(levels, "repo1"), defs);

describe("the inbox order comes from his objectives by itself", () => {
  it("reads his objectives in his order, with the names he uses, and never one that is not in the objectives file", () => {
    expect(defs.map((d) => [d.n, d.id, d.name])).toEqual([
      [0, "acme-live", "Five testers use Acme"],
      [1, "beta-testers", "5 testers using Beta"],
      [2, "vault", "Every password lives in your vault"],
    ]);
    // the code repo serves every objective, so it is nobody's own; the product and campaign repos are
    expect(defs[0].repos.sort()).toEqual(["acme", "acme-social"]);
    expect(parseObjectives("nope", words)).toEqual([]);
    expect(parseObjectives(pursuits, "nope").map((d) => d.match.length)).toEqual([0, 0, 0]);
  });

  it("finds an item's objective by its red line, its epic, its repo or his words, the first in his order", () => {
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S16" }, "acme-live")?.n).toBe(0);
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S31", path: "docs/spines/epic-46.md", title: "Fix the pricing page" })?.n).toBe(1);
    // the first of his objectives it touches: a Beta epic's row about Acme testers moves his first objective
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S32", path: "docs/spines/epic-46.md", title: "Each morning of Acme week one talk" })?.n).toBe(0);
    expect(objectiveOf(defs, { repo: "acme-social", ref: "E907-S33", title: "Post the launch thread" })?.n).toBe(0);
    expect(objectiveOf(defs, { repo: "repo1", code: "E907-A1", question: "Can we post the Acmy testers call today?" })?.n).toBe(0);
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S21", title: "Five Beta testers sign up" })?.n).toBe(1);
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S22", title: "Beta pricing page" })).toBeUndefined();
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S23", title: "Move every password" })?.n).toBe(2);
    // a citation of where his words are kept is not what the item is about
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S24", title: "Alerts drop the label. Voice note (Acme Log/2026-11-14.md#^e-1)" })).toBeUndefined();

    // E948-S160 (E995-A10 read "Bitwarden" for an Exa ask): an ask is read in its own words, never its row's side words
    const exa = { repo: "repo1", code: "E907-A10", row: "E907-S18", path: "docs/spines/startup-programs.md", title: "E907-S18 Exa startup form; password item updated", question: "You give: your Exa team ID. Why: the form needs it." };
    expect(objectiveOf(defs, exa)).toBeUndefined();
    // an ask on no row carries its epic's title, which says what the epic is about
    expect(objectiveOf(defs, { ...exa, row: undefined, title: "EPIC-907: Move every password" })?.n).toBe(2);
    expect(objectiveOf(defs, { ...exa, question: "You give: the new password for the vault." })?.n).toBe(2);
    expect(objectiveOf(defs, { ...exa, path: "docs/spines/accounts.md" })?.n).toBe(2);
  });

  it("puts his first objective first, then what is pressing, the red line and levels, each in his objectives' order", () => {
    const items = [
      { id: "plain", repo: "repo1", ref: "E907-S29", title: "Tidy the logs" },
      { id: "vault", repo: "repo1", ref: "E907-S23", title: "Move every password" },
      { id: "high", repo: "repo1", ref: "E907-S1", title: "High work" },
      { id: "frustrated", repo: "repo1", ref: "E907-S2", title: "Frustrated work" },
      { id: "beta", repo: "repo1", ref: "E907-S21", title: "Five Beta testers sign up" },
      { id: "acme", repo: "repo1", ref: "E907-S15", title: "Acme tester welcome email" },
    ];
    const out = byMilestonePriority(items, new Map(), lookup);
    expect(out.map((i) => i.id)).toEqual(["acme", "frustrated", "high", "beta", "vault", "plain"]);
    const pr = out.map((i) => i.priority!);
    expect([...pr].sort((a, b) => a - b)).toEqual(pr);
    // each card carries why it ranks there
    expect(out[0].ownerPriority?.objective).toEqual({ n: 0, id: "acme-live", name: "Five testers use Acme" });
    expect(out[3].ownerPriority?.why).toBe("It moves your objective 2: 5 testers using Beta.");
    expect(out[5].ownerPriority).toBeUndefined();
  });

  it("follows his order when he changes it: a new first objective leads with no rule to edit", () => {
    const p = JSON.parse(pursuits) as { pursuits: unknown[] };
    const swapped = parseObjectives(JSON.stringify({ pursuits: [p.pursuits[1], p.pursuits[0], p.pursuits[2]] }), words);
    const l = lookupOf([], [], [], swapped);
    const out = byMilestonePriority(
      [
        { id: "acme", repo: "repo1", ref: "E907-S15", title: "Acme tester welcome email" },
        { id: "beta", repo: "repo1", ref: "E907-S21", title: "Five Beta testers sign up" },
      ],
      new Map(),
      l,
    );
    expect(out.map((i) => i.id)).toEqual(["beta", "acme"]);
  });
});
