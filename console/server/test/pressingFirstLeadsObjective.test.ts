import { describe, expect, it } from "vitest";
import { FIRST_TIER, OBJECTIVE_TIER, PRESSING_TIER, parsePressing, tierOf } from "../src/inbox/jordiPriority.js";

/**
 * an item the owner asked by name to be first leads every tier, his first objective too.
 * A plain pressing item (frustrated, said again) stays below his first objective, as before.
 */
describe("pressing kind first", () => {
  it("is read from the levels file", () => {
    const file = JSON.stringify({ pressing: [{ repo: "repo1", ref: "E907-A1", kind: "first", why: "He asked for it first." }] });
    expect(parsePressing(file, "repo1").map((e) => e.kind)).toEqual(["first"]);
  });
  it("leads his first objective; plain pressing does not", () => {
    const objective = { n: 0, id: "o1", name: "Acme: 5 testers" };
    expect(tierOf({ level: "normal", pressing: { kind: "first", why: "x" }, objective })).toBe(FIRST_TIER);
    expect(FIRST_TIER).toBeLessThan(OBJECTIVE_TIER);
    expect(tierOf({ level: "normal", pressing: { kind: "repeated", why: "x" }, objective })).toBe(OBJECTIVE_TIER);
    expect(tierOf({ level: "normal", pressing: { kind: "repeated", why: "x" } })).toBe(PRESSING_TIER);
  });
});
