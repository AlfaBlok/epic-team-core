import { describe, expect, it } from "vitest";
import { deskSeed, SEED_VERSION, UNDERSTOOD_LEAD, updateMessage } from "../src/desk/desk.js";

// root L-66. The owner, 2026-11-14 04:43Z: "ask me questions so that I
// answer with a voice note ... Not ask me to make a choice ... Ask me questions until you can tell me I actually think I know
// what you mean ... a sentence that we can make sure that all agents read moving forward."
describe("the desk asks open questions until it understands him", () => {
  const seed = deskSeed({ persona: { name: "Team desk", remit: "r" }, publicUrl: "https://c.test", reposRoot: "/r" });

  it("the seed carries the Understanding him rule: one open voice-note question, never a choice", () => {
    expect(seed).toContain("- Understanding him (root L-66");
    expect(seed).toContain("Tell me how you think about <the unclear part>. Talk for a few minutes in a voice note.");
    expect(seed).toContain("never offer him a choice");
    expect(seed).toContain("understood.py check");
    expect(seed).toContain("Don't abuse it");
  });

  it("it keeps asking until it can restate him in one sentence, then writes it where every agent reads it", () => {
    expect(UNDERSTOOD_LEAD).toBe("I think I know what you mean:");
    expect(seed).toContain(`${UNDERSTOOD_LEAD} <one sentence>. Is that it?`);
    expect(seed).toContain("restate it in ONE sentence, never a paragraph");
    expect(seed).toContain('understood.py restate "<the sentence>"');
    expect(seed).toContain("understood.py write --sentence");
    expect(seed).toContain("root Operating Learning");
    expect(seed).toContain("--objective <objective id>");
  });

  it("decisions keep their buttons; the objectives and points-back rules point to the open question", () => {
    expect(seed).toContain("stays a coded ask with its buttons");
    expect(seed).toContain("ask him one open question (the Understanding him rule below)");
    expect(seed).not.toContain("ask him one short line naming the candidates");
    expect(seed).toContain("never as options to pick");
  });

  it("the live desk gets it: the version moved and the update names it", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(37);
    expect(updateMessage("https://c.test")).toContain("never a choice");
    expect(updateMessage("https://c.test")).toContain(UNDERSTOOD_LEAD);
  });
});
