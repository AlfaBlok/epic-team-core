import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, NOTE_MAX_MIN, NOTE_MAX_PARTS, NOTE_SEGMENT_S, NOTE_WARN_BEFORE_MIN, type Transcriber } from "../src/voice/notes.js";

// The owner (2026-11-12): "the recorder says max 30 minutes; allow up to 2 hours, and never stop without
// telling him (a warning before any limit, the part so far always saved)". The note stays two-minute parts, so a 2-hour
// note is 60 uploads and 60 transcriptions; a part that cannot be turned into words never holds back the rest.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(transcribe: Transcriber) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s65-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const clock = { t: Date.parse("2026-11-12T22:00:00Z") };
  const sent: string[] = [];
  const desk: DeskPort = {
    send: vi.fn(async (text: string) => {
      sent.push(text);
      return { threadId: "thread_desk", pending: false };
    }),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now: () => clock.t });
  const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(dir, "notes"), now: () => clock.t });
  return { db, notes, sent };
}

const audio = () => new Uint8Array(2000).fill(7);
const USAGE = { type: "tokens", input_tokens: 1200, output_tokens: 400 };

describe("long-note voice notes up to 2 hours", () => {
  it("the console offers 2 hours, warns at 1 h 50 min and takes enough parts for locks on top of 60 two-minute parts", () => {
    const s = setup(async () => ({ text: "x" }));
    const st = s.notes.start();
    expect(st.maxMin).toBe(120);
    expect(st.warnMin).toBe(110);
    expect(NOTE_MAX_MIN - NOTE_WARN_BEFORE_MIN).toBe(110);
    expect(NOTE_MAX_PARTS).toBeGreaterThanOrEqual(3 * ((NOTE_MAX_MIN * 60) / NOTE_SEGMENT_S));
  });

  it("a whole 2-hour note (60 parts) is posted once, every part's words in order", async () => {
    const s = setup(async (_a, o) => ({ text: `words of ${o.filename.split("-").pop()!.split(".")[0]}`, usage: USAGE }));
    const id = s.notes.start().note.id;
    for (let n = 0; n < 60; n++) await s.notes.segment(id, n, audio(), "audio/webm", 120);
    const r = await s.notes.finish(id, { segments: 60, audioBase: "https://console/api/voice/notes" });
    expect(r.note).toMatchObject({ state: "posted", seconds: 7200, segments: 60 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain("120 min 00 s");
    expect(s.sent[0]).toContain("(60 parts)");
    const words = s.sent[0].split("\n\n").slice(1);
    expect(words[0]).toContain("words of 0");
    expect(words.at(-1)).toBe("words of 59");
  });

  it("a part that cannot be turned into words is kept, tried again at Send, and named with its audio link; the rest is posted", async () => {
    let tries = 0;
    const s = setup(async (_a, o) => {
      if (o.filename.endsWith("-1.webm")) {
        tries++;
        throw new Error("OpenAI 500");
      }
      return { text: `said in ${o.filename.split("-").pop()}`, usage: USAGE };
    });
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm", 120);
    await expect(s.notes.segment(id, 1, audio(), "audio/webm", 120)).rejects.toMatchObject({ status: 502, code: "transcribe_failed" });
    await s.notes.segment(id, 2, audio(), "audio/webm", 60);
    const r = await s.notes.finish(id, { segments: 3, audioBase: "https://console/api/voice/notes" });
    expect(tries).toBe(2); // once on upload, once more at Send
    expect(r.note.state).toBe("posted");
    expect(s.sent[0]).toContain("said in 0.webm");
    expect(s.sent[0]).toContain(`[Part 2, from 2 min 00 s, could not be turned into words. Its audio is kept: https://console/api/voice/notes/${id}/audio?part=1]`);
    expect(s.sent[0]).toContain("said in 2.webm");
    expect(s.sent[0]).toContain("5 min 00 s"); // the untranscribed part still counts in the note's length
  });

  it("a part that failed on upload but is heard at Send goes in with its words", async () => {
    let first = true;
    const s = setup(async (_a, o) => {
      if (o.filename.endsWith("-0.webm") && first) {
        first = false;
        throw new Error("timeout");
      }
      return { text: "heard on the second try" };
    });
    const id = s.notes.start().note.id;
    await expect(s.notes.segment(id, 0, audio(), "audio/webm", 30)).rejects.toMatchObject({ code: "transcribe_failed" });
    const r = await s.notes.finish(id, { segments: 1, audioBase: "x" });
    expect(r.note.state).toBe("posted");
    expect(s.sent[0]).toContain("heard on the second try");
    expect(s.sent[0]).not.toContain("could not be turned into words");
  });
});
