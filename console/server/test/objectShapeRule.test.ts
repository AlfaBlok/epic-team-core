import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OBJECT_SHAPE_RULE, chaptersLine, objectivesBlock, objectivesRule, readChapters } from "../src/objectives.js";

/** Root L-100 (his vn_cdef45cd, 24 Nov: "I've explained it more than 20 times ... this is the last time"):
 * what an objective is reaches every wake prompt and every worker brief, with the screen that shows it. */
describe("what an objective is, in every wake and worker brief", () => {
  it("says class, object, chapter, enforced to exist, never ask again, and points at /made-of", () => {
    for (const w of ["root L-100", "never ask him again", "object of one class", "chapters", "Chapter is his word", "enforced to exist", "/made-of"]) expect(OBJECT_SHAPE_RULE).toContain(w);
  });
  it("every wake prompt's objectives block and every worker rule carry it", () => {
    const block = objectivesBlock({ nodes: [{ id: "a", kind: "pursuit", name: "Acme: Get 5 testers", headline: "Acme: Get 5 testers", rank: 1, greens: 0, total: 1 }] });
    expect(block).toContain(OBJECT_SHAPE_RULE);
    expect(objectivesRule("1. Acme: Get 5 testers")).toContain(OBJECT_SHAPE_RULE);
    expect(objectivesRule()).toContain(OBJECT_SHAPE_RULE);
  });
});

/**(his 24 Nov 20:37Z: "When you are born as an agent, you are told about these chapters" and "if that makes this
 * engine have 11 chapters and the other one has 10, it's not the end of the world"): the chapters come from each product's
 * graph file, any count, the shared ones named, and ride in every wake block and worker rule. */
describe("every agent is told its chapters at birth, read from the graph files", () => {
  it("a made-up product with any count is read the same way", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chapters-"));
    fs.mkdirSync(path.join(dir, "docs/totems"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/totems/every-product.json"), JSON.stringify({ chapters: { shared: ["Key results"] } }));
    fs.writeFileSync(path.join(dir, "docs/totems/acme.json"), JSON.stringify({ name: "Acme", wheel: { class: { name: "Campaign" }, tabs: ["Key results", "Product", "A", "B", "C", "D", "E", "F", "G", "H", "I"].map((label) => ({ label })) } }));
    const line = chaptersLine(readChapters(dir));
    expect(line).toContain("Acme campaign, 11:");
    expect(line).toContain("its own: Product, A, B");
    expect(line).toContain("Shared by every product: Key results.");
  });
  it("the wake block and the worker rule carry the line; the rule names no fixed list", () => {
    const line = "Your chapters, told at birth: Acme campaign, 11: Key results, Product.";
    const block = objectivesBlock({ nodes: [{ id: "a", kind: "pursuit", name: "Acme: Get 5 testers", headline: "Acme: Get 5 testers", rank: 1, greens: 0, total: 1 }] }, undefined, undefined, line);
    expect(block).toContain(line);
    expect(objectivesRule("1. Acme: Get 5 testers", line)).toContain(line);
    expect(OBJECT_SHAPE_RULE).not.toMatch(/key results, plan, context, trackers/);
    expect(OBJECT_SHAPE_RULE).toContain("its own count");
  });
});
