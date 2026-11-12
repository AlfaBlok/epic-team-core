import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, type Transcriber } from "../src/voice/notes.js";

// the console's top bar has a microphone next to Chat. Its note is Chat's own note
// (the same /api/voice routes, web voice/TopBarVoice.tsx), sent with the page he was on as its hint. On the server that means:
// one message on the Team desk, with that hint, and one hand-off to his the memory service (onPosted), even if Send is tapped twice.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s20-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const clock = { t: Date.parse("2026-11-10T21:00:00Z") };
  const sent: { text: string; page?: string }[] = [];
  const desk: DeskPort = {
    send: vi.fn(async (text: string, page?: string) => (sent.push({ text, page }), { threadId: "thread_desk", pending: false })),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now: () => clock.t });
  const transcribe = vi.fn<Transcriber>(async () => ({ text: "Add a mic to the top bar, please." }));
  const forwarded: string[] = [];
  const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(dir, "notes"), now: () => clock.t, onPosted: (id) => void forwarded.push(id) });
  return { notes, sent, forwarded, clock };
}

describe("T18-S20 a voice note from the top bar lands on the Team desk once", () => {
  it("posts one desk message with the page hint, and hands it to Memo once, even when Send comes twice", async () => {
    const s = setup();
    const hint = "voice note from the top bar, on /milestones/ms_1?tab=deck";
    const id = s.notes.start(hint).note.id;
    await s.notes.segment(id, 0, new Uint8Array(1500).fill(3), "audio/mp4", 12);
    s.clock.t += 2_000;
    const a = await s.notes.finish(id, { segments: 1, audioBase: "https://team.example.com/api/voice/notes" });
    expect(a.note.state).toBe("posted");
    await s.notes.finish(id, { segments: 1, audioBase: "https://team.example.com/api/voice/notes" }).catch(() => undefined);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].page).toBe(hint);
    expect(s.sent[0].text).toContain("🎙 Voice note (Chat)");
    expect(s.sent[0].text).toContain("Add a mic to the top bar, please.");
    expect(s.forwarded).toEqual([id]);
  });
});
