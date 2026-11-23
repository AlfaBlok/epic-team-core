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

describe("an item files under the objective that owns its epic before any title word", () => {
  // the owner asked why a card titled with the first objective's product sat there when its epic is the second's.
  // the code repo serves both objectives, so it is neither one's own: only the spine tells.
  const two = parseObjectives(
    JSON.stringify({
      pursuits: [
        { id: "acme-live", name: "Acme live", epics: [{ repo: "acme", spine: "docs/acme.md" }, { repo: "repo1", spine: "docs/spines/epic-40.md" }] },
        { id: "beta-channels", name: "Beta: every channel working", epics: [{ repo: "repo1", spine: "docs/spines/epic-46.md" }] },
      ],
    }),
    JSON.stringify({ objectives: [{ id: "acme-live", name: "Acme live", match: [["acme"]] }, { id: "beta-channels", name: "Beta: every channel working", match: [["channel"]] }] }),
  );

  it("a card titled with Acme on the Beta epic's row files under beta-channels", () => {
    const card = { repo: "repo1", ref: "E907-S41", path: "docs/spines/epic-46.md", title: "Acme social picture: a last-6-hours button" };
    expect(objectiveOf(two, card)?.id).toBe("beta-channels");
  });

  it("an item no objective's spine or repo owns still files by its words", () => {
    expect(objectiveOf(two, { repo: "repo1", ref: "E907-S42", path: "docs/spines/epic-6.md", title: "Acme memory search is slow" })?.id).toBe("acme-live");
    expect(objectiveOf(two, { repo: "repo1", ref: "E907-S43", path: "docs/spines/epic-6.md", title: "Fix the deploy script" })).toBeUndefined();
  });

  it("the red line still comes first", () => {
    const card = { repo: "repo1", ref: "E907-S41", path: "docs/spines/epic-46.md", title: "Social picture" };
    expect(objectiveOf(two, card, "acme-live")?.id).toBe("acme-live");
  });
});

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
    // the epic's own objective comes before title words, so a Beta epic's row about Acme stays with Beta
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S32", path: "docs/spines/epic-46.md", title: "Each morning of Acme week one talk" })?.n).toBe(1);
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

  it("puts his objectives in his order first; pressing, the red line and levels order only inside one objective", () => {
    const items = [
      { id: "plain", repo: "repo1", ref: "E907-S29", title: "Tidy the logs" },
      { id: "vault", repo: "repo1", ref: "E907-S23", title: "Move every password" },
      { id: "high", repo: "repo1", ref: "E907-S1", title: "High work" },
      { id: "frustrated", repo: "repo1", ref: "E907-S2", title: "Frustrated work" },
      { id: "beta", repo: "repo1", ref: "E907-S21", title: "Five Beta testers sign up" },
      { id: "acme", repo: "repo1", ref: "E907-S15", title: "Acme tester welcome email" },
    ];
    const out = byMilestonePriority(items, new Map(), lookup);
    // the owner asked: a higher objective's card comes first; frustrated and high move none of his objectives
    expect(out.map((i) => i.id)).toEqual(["acme", "beta", "vault", "frustrated", "high", "plain"]);
    const pr = out.map((i) => i.priority!);
    expect([...pr].sort((a, b) => a - b)).toEqual(pr);
    // each card carries why it ranks there
    expect(out[0].ownerPriority?.objective).toEqual({ n: 0, id: "acme-live", name: "Five testers use Acme" });
    expect(out[1].ownerPriority?.why).toBe("It moves your objective 2: 5 testers using Beta.");
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
