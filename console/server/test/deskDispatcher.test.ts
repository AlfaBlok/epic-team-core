import { describe, expect, it } from "vitest";
import { deskSeed, SEED_VERSION, updateMessage } from "../src/desk/desk.js";
import { DESK_ANSWER_RULE } from "../src/voice/voice.js";
import { spillLine } from "../src/voice/spill.js";

// The owner, voice note vn_3e39996d, 2026-11-18 02:28Z: "I would rather you say, I have dispatched this ... the
// answers come formally through the inbox because the chat is hit and miss ... You ask me questions and I never answer, and
// then it falls into the void ... you are a dispatcher, not a handler."
describe("the Team desk is a dispatcher: its reply lists what it dispatched, every question goes to his inbox", () => {
  const seed = deskSeed({ persona: { name: "Team desk", remit: "r" }, publicUrl: "https://c.test", reposRoot: "/r" });
  const update = updateMessage("https://c.test");

  it("the seed and the update carry the dispatcher rule, quoting his note", () => {
    for (const s of [seed, update]) expect(s).toContain("dispatcher, not a handler");
    expect(seed).toContain("vn_3e39996d");
    expect(seed).toContain("Got your <n> points, all dispatched:");
    expect(seed).toContain("questions for clarification are on your inbox");
  });

  it("its advice goes into what it dispatches, never to him; a question is an inbox ask", () => {
    expect(seed).toContain("go INTO what you dispatch");
    expect(seed).toContain("never a question in your reply");
    expect(seed).toContain("POST /api/needs-owner");
  });

  it("it checks each reply before sending with the same check the Delivery Manager runs", () => {
    expect(seed).toContain("scripts/desk_reply_check.py --text");
  });

  it("on a call, no yes/no question back and the voice never asks the desk's question", () => {
    expect(seed).not.toContain("any question for him after it, as one short yes/no question");
    expect(seed).not.toContain("ask one short yes/no question back");
    expect(DESK_ANSWER_RULE).not.toContain("then ask its question");
    expect(DESK_ANSWER_RULE).toContain("never ask him the desk's question on the call");
  });

  it("the voice-note relay line never tells the desk to ask him in the chat", () => {
    const line = spillLine(
      { id: "vn_x", where: "card E907-S3", words: "w", across: { there: "Other", thereIs: "posts", here: "Here", hereIs: "builds", passUrl: "https://c.test/api/desk/pass", passHeader: "X-Console-Run: team-desk" } } as never,
      "rest",
    );
    expect(line).not.toContain("ask him in one line");
    expect(line).toContain("never ask him in the chat");
  });

  it("the live desk gets it at once: the version moved", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(44);
    expect(update).toContain(`v${SEED_VERSION}`);
  });
});
