import { describe, expect, it } from "vitest";
import { objectiveOf, parseObjectives } from "../src/inbox/jordiPriority.js";

// The owner: a card named the wrong objective number. The number a card shows is the one his sidebar shows: a parked
// objective has no place in the sidebar, so it takes no number.

const p = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, ...over });
const file = (ps: Record<string, unknown>[]) => JSON.stringify({ pursuits: ps });

describe("a card's objective number is his sidebar's", () => {
  it("a parked objective takes no number, so the ones after it keep his sidebar's", () => {
    const defs = parseObjectives(
      file([p("one", "Acme: Get one"), p("parked", "Acme: Get parked", { private: true, parked: true }), p("two", "Acme: Get two", { private: true }), p("three", "Acme: Get three")]),
    );
    expect(defs.map((d) => [d.n + 1, d.id])).toEqual([
      [1, "one"],
      [2, "two"],
      [3, "three"],
    ]);
  });

  it("a private objective that is not parked keeps its place", () => {
    const defs = parseObjectives(file([p("a", "Acme: Get a"), p("two", "Acme: Get two", { private: true }), p("b", "Acme: Get b")]));
    expect(defs.map((d) => d.id)).toEqual(["a", "two", "b"]);
  });

  it("an item in a parked objective's epic names no number of another's", () => {
    const defs = parseObjectives(
      file([
        p("parked", "Acme: Get parked", { parked: true, epics: [{ repo: "acme", spine: "docs/spines/parked.md" }] }),
        p("two", "Acme: Get two", { epics: [{ repo: "acme-two", spine: "EPIC.md" }] }),
      ]),
    );
    expect(objectiveOf(defs, { repo: "acme-two", path: "EPIC.md", title: "a step" })).toEqual({ n: 0, id: "two", name: "Acme: Get two" });
    expect(objectiveOf(defs, { repo: "acme", path: "docs/spines/parked.md", title: "a note" })).toBeUndefined();
  });
});
