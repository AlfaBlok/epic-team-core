import { describe, expect, it } from "vitest";
import { voiceReplyIds } from "@/pages/Chat";
import type { DeskMessage } from "@/api";

const at = (min: number) => new Date(Date.UTC(2026, 10, 25, 12, min)).toISOString();
const msg = (id: string, role: "user" | "assistant", text: string, min: number): DeskMessage => ({ id, role, kind: "message", text, status: "completed", at: at(min) });
const NOTE = "🎙 Voice note (Chat), 2026-11-25 11:57Z · 1 min · vn_x\nAudio: https://x/a\n\nCould I get a voice note back?";

describe("which desk answers come back as a voice note", () => {
  it("the last answer before his next message, only after his voice note; the newest one under a day is ready", () => {
    const msgs = [msg("u1", "user", "typed question", 0), msg("a1", "assistant", "typed answer", 1), msg("u2", "user", NOTE, 2), msg("a2", "assistant", "working on it", 3), msg("a3", "assistant", "Yes, calls are back on.", 4), msg("u3", "user", NOTE, 5), msg("a4", "assistant", "Done.", 6)];
    const m = voiceReplyIds(msgs, false, Date.parse(at(10)));
    expect([...m.entries()]).toEqual([
      ["a3", "tap"],
      ["a4", "ready"],
    ]);
  });
  it("while the desk is still writing, its last finished line is not yet the answer", () => {
    const m = voiceReplyIds([msg("u2", "user", NOTE, 2), msg("a2", "assistant", "working on it", 3)], true, Date.parse(at(10)));
    expect(m.size).toBe(0);
  });
});
