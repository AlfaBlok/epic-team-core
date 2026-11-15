import { describe, expect, it } from "vitest";
import { deskSeed, SEED_VERSION, updateMessage } from "../src/desk/desk.js";

// Links, not codes. The owner, voice note vn_68f10aed, 2026-11-15 07:20Z: "Give me links that I can follow if I want ... If there
// is a list, can you do bullets? Don't do lists in commas, long paragraphs of commas."
describe("the desk gives him links, not codes, and bullets, not comma lists", () => {
  const seed = deskSeed({ persona: { name: "Team desk", remit: "r" }, publicUrl: "https://c.test", reposRoot: "/r" });
  const update = updateMessage("https://c.test");

  it("the seed and every update carry the rule and the check", () => {
    for (const s of [seed, update]) {
      expect(s).toContain("- Links, not codes; bullets, not comma lists (his voice note");
      expect(s).toContain("never a bare code (a post number, a row code, an ask code)");
      expect(s).toContain("any list of more than three items is bullets");
      expect(s).toContain("scripts/plain_message.py check -");
    }
    expect(update).toContain("links, not codes");
  });

  it("live desks get it: the seed version moved", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(42);
  });
});
