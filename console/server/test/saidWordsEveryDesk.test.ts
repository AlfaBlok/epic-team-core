import { describe, expect, it } from "vitest";
import { deskCaller } from "../src/inbox/routes.js";
import { quoteParts, saidIn, saidInAny, saidWords } from "../src/desk/said.js";

// the not_in_chat check once refused the owner's voice-note yes in the social product's desk. A voice-note transcript
// is his message like typed text, in every desk; and a world's own desk checks its OWN thread, never the home Team desk.

const VOICE = [
  "🎙 Voice note (Chat), 2026-11-12 23:03Z · 1 min 23 s · $0.0035 (gpt-4o-mini-transcribe) · vn_1",
  "Audio: https://example.test/api/tenants/social-world/desk/voice/notes/vn_1/audio",
  "",
  "I mean, for me, if you, yes, for me, and if you want me to give you a yes, the way you do it is you actually dispatch the thing. But generally, just go for it. I'll take a look and then I'll give feedback through the feedback cycle, you know, and I think if we can Just implement it, bro.",
].join("\n");
const WHATSAPP = "🎙 Voice note (WhatsApp → Memory), 22:58Z\nMemory: Log/2026-11-12.md#^e-1 · https://github.com/x/y\n\nYes — go ahead with the testers’ scorecard.";

describe("his words: typed or spoken, every desk", () => {
  it("words only: case, punctuation, dashes and curly quotes aside", () => {
    expect(saidWords("Yes — go ahead, with the testers’ SCORECARD!")).toBe("yes go ahead with the testers scorecard");
    expect(quoteParts("a b [...] c d … e ... f")).toEqual(["a b", "c d", "e", "f"]);
  });

  it("the exact quote a social desk once sent (with [...]) is in his voice note", () => {
    const quote =
      "I mean, for me, if you, yes, for me, and if you want me to give you a yes, the way you do it is you actually dispatch the thing [...] but generally, just go for it. I'll take a look and then I'll give feedback through the feedback cycle, you know, and I think if we can Just implement it, bro.";
    expect(saidIn(VOICE, quote)).toBe(true);
    expect(saidIn(VOICE, "but generally, just go for it. I'll take a look")).toBe(true);
  });

  it("a WhatsApp voice note in the Team desk counts too, its curly quotes and dashes aside", () => {
    expect(saidInAny([{ text: "hi" }, { text: WHATSAPP }], "yes - go ahead with the testers' scorecard")).toBe(true);
  });

  it("never words he did not say: another word, a word cut in half, the wrong order, nothing", () => {
    expect(saidIn(VOICE, "just go for it now")).toBe(false);
    expect(saidIn(VOICE, "just go fo")).toBe(false);
    expect(saidIn(VOICE, "just go for it [...] the way you do it")).toBe(false);
    expect(saidIn(VOICE, "...")).toBe(false);
    expect(saidIn(VOICE, "a")).toBe(false);
    expect(saidInAny([], "yes")).toBe(false);
  });

  it("which desk calls: team-desk is its own world's Team desk; world-desk:<w> only with w's own token", () => {
    expect(deskCaller("team-desk", undefined, "home")).toEqual({ world: "home" });
    expect(deskCaller("Team-Desk", "home", "home")).toEqual({ world: "home" });
    expect(deskCaller("team-desk", "social-world", "home")).toEqual({ world: "social-world" }); // its own thread, never the home one
    expect(deskCaller("world-desk:social-world", "social-world", "home")).toEqual({ world: "social-world" });
    expect(deskCaller("world-desk:social-world", undefined, "home")).toEqual({ world: "social-world" });
    expect(deskCaller("world-desk:social-world", "other-world", "home")).toMatch(/only for world social-world/);
    expect(deskCaller("milestone-chat:ms_1", "home", "home")).toBeUndefined();
    expect(deskCaller(undefined, undefined, "home")).toBeUndefined();
  });
});
