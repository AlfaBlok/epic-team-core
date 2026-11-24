import { describe, expect, it } from "vitest";
import { OBJECT_SHAPE_RULE, objectivesBlock, objectivesRule } from "../src/objectives.js";

/** Root L-100 (his vn_cdef45cd, 24 Nov: "I've explained it more than 20 times ... this is the last time"):
 * what an objective is reaches every wake prompt and every worker brief, with the screen that shows it. */
describe("what an objective is, in every wake and worker brief", () => {
  it("says class, object, property, enforced to exist, never ask again, and points at /made-of", () => {
    for (const w of ["root L-100", "never ask him again", "object of one class", "properties", "enforced to exist", "/made-of"]) expect(OBJECT_SHAPE_RULE).toContain(w);
  });
  it("every wake prompt's objectives block and every worker rule carry it", () => {
    const block = objectivesBlock({ nodes: [{ id: "a", kind: "pursuit", name: "Acme: Get 5 testers", headline: "Acme: Get 5 testers", rank: 1, greens: 0, total: 1 }] });
    expect(block).toContain(OBJECT_SHAPE_RULE);
    expect(objectivesRule("1. Acme: Get 5 testers")).toContain(OBJECT_SHAPE_RULE);
    expect(objectivesRule()).toContain(OBJECT_SHAPE_RULE);
  });
});
