import { describe, expect, it } from "vitest";
import { objectiveOf, parseObjectives } from "../src/inbox/jordiPriority.js";

/**
 * A card names the objective of its own key result, and a folded copy of a shared objective names the one it is shown
 * inside (the owner, on a vault-keys card labelled with the second product's copy of a shared objective).
 */
const pursuits = JSON.stringify({
  pursuits: [
    { id: "house", name: "House: Buy a house", epics: [{ repo: "house", spine: "EPIC.md" }] },
    { id: "beta-shared", name: "Beta: Get multi-tenant working", epics: [{ repo: "repo1", spine: "docs/spines/shared.md" }] },
    { id: "acme-shared", name: "Acme: Get multi-tenant working", epics: [{ repo: "repo1", spine: "docs/spines/shared.md" }] },
    { id: "vault", name: "Acme: Finish the vault migration", epics: [{ repo: "repo1", spine: "docs/spines/vault.md" }] },
  ],
});
const cards = {
  "beta-shared": JSON.stringify({ foldedInto: "acme-shared", keyResults: [] }),
  "acme-shared": JSON.stringify({ keyResults: [{ label: "Wakes", work: ["E907-S1"] }] }),
  vault: JSON.stringify({ keyResults: [{ label: "Keys in the vault", work: ["E907-S37", "other:E908-S2"] }] }),
};
const defs = parseObjectives(pursuits, undefined, cards);

describe("a card names its own key result's objective", () => {
  it("numbers objectives as every list shows them: a folded copy takes no place", () => {
    expect(defs.map((d) => [d.id, d.n])).toEqual([["house", 0], ["beta-shared", 1], ["acme-shared", 1], ["vault", 2]]);
  });

  it("an ask on a row its key result lists names that objective, though it lives in a shared epic", () => {
    const card = { repo: "repo1", code: "E907-A13", row: "E907-S37", path: "docs/spines/shared.md", question: "Delete the old store's copies?" };
    expect(objectiveOf(defs, card)).toEqual({ n: 2, id: "vault", name: "Acme: Finish the vault migration" });
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S37", path: "docs/spines/shared.md" })?.id).toBe("vault");
    expect(objectiveOf(defs, { repo: "other", ref: "E908-S2" })?.id).toBe("vault");
    expect(objectiveOf(defs, { repo: "repo2", ref: "E907-S37" })).toBeUndefined();
  });

  it("an item in a shared epic no key result lists names the shared objective itself, never its folded copy", () => {
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S9", path: "docs/spines/shared.md" })).toEqual({ n: 1, id: "acme-shared", name: "Acme: Get multi-tenant working" });
    expect(objectiveOf(defs, { repo: "repo1", ref: "E907-S1", path: "docs/spines/shared.md" })?.id).toBe("acme-shared");
  });
});
