import { describe, expect, it } from "vitest";
import { deskSeed, SEED_VERSION, updateMessage } from "../src/desk/desk.js";

// root L-68, L-70. The owner, voice note vn_78d629fb, 2026-11-15 03:52Z: "If I'm asking for something on the voice
// note, don't make me reconfirm it ... If it's not clear ... you get to me with like a clarification on the inbox. But don't
// make me, don't expect me to answer on the chat ... I may miss them ... and then shit gets lost."
describe("the desk acts on his voice note and never waits on a yes in the chat", () => {
  const seed = deskSeed({ persona: { name: "Team desk", remit: "r" }, publicUrl: "https://c.test", reposRoot: "/r" });
  const update = updateMessage("https://c.test");

  it("the seed carries the rule: his ask is his go-ahead, acted on in the same turn", () => {
    expect(seed).toContain("- His voice note is his yes (root L-68, L-70");
    expect(seed).toContain("Act on it in the same turn");
    expect(seed).toContain("Never end a reply waiting on him in this chat");
  });

  it("a question only he can answer becomes one inbox card through the spine ask route, citing his note", () => {
    expect(seed).toContain("goes to his inbox as ONE card, never as a chat question");
    expect(seed).toContain("curl -sS -X POST https://c.test/api/needs-owner");
    expect(seed).toContain('Why: your voice note <vn id> said \\"<his words>\\".');
  });

  it("its own ideas go to the Delivery Manager, not to him for a yes", () => {
    expect(seed).toContain("An idea of your own that he did not ask for is not his to confirm");
    expect(seed).toContain("desk_note.py send");
  });

  it("no rule left asks him to confirm or answer in the chat", () => {
    for (const s of [seed, update]) {
      expect(s).not.toContain("Add it as a milestone?");
      expect(s).not.toContain("Create nothing until");
      expect(s).not.toContain("ask him to say it here");
      expect(s).not.toContain('offer it in one line ("Move X to the top?")');
      expect(s).not.toContain("pass only on his yes");
      expect(s).not.toContain("His yes in the chat is the go-ahead");
      expect(s).not.toContain("after his yes that sentence");
      expect(s).not.toContain("Is that it? …");
      expect(s).not.toContain("yes/no offer");
      expect(s).not.toContain("offer to add it");
    }
  });

  it("the live desk gets it at once: the version moved and the update names it", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(40);
    expect(update).toContain(`v${SEED_VERSION}`);
    expect(update).toContain("his voice note is his yes (root L-68)");
    expect(update).toContain("POST /api/needs-owner");
  });
});
