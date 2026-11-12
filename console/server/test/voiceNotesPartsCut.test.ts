import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, mountVoiceNotesRec, NOTE_MAX_PARTS, type Transcriber } from "../src/voice/notes.js";

// a voice note survives the phone locking. The page cuts a part at every lock and pick-up, so a
// note may have many short parts; a part with no audio (empty, or lost when the phone threw the page away) is named in `skip`
// on Send, and the note posts what is in.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s35-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const sent: string[] = [];
  const desk: DeskPort = {
    send: vi.fn(async (text: string) => (sent.push(text), { threadId: "thread_desk", pending: false })),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now: () => Date.parse("2026-11-07T22:00:00Z") });
  let k = 0;
  const transcribe = vi.fn<Transcriber>(async () => ({ text: `words ${k++}` }));
  const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(dir, "notes"), now: () => Date.parse("2026-11-07T22:00:00Z") });
  return { notes, sent };
}
const audio = () => new Uint8Array(1500).fill(7);

describe("T42-S35 voice notes with parts cut by the phone locking", () => {
  it("a lost or empty part named in skip does not block Send; the rest posts in order", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/mp4", 30);
    await s.notes.segment(id, 2, audio(), "audio/mp4", 12);
    await expect(s.notes.finish(id, { segments: 3, audioBase: "x" })).rejects.toMatchObject({ code: "segments_missing" });
    const r = await s.notes.finish(id, { segments: 3, audioBase: "x", skip: [1] });
    expect(r.note.state).toBe("posted");
    expect(s.sent[0]).toContain("words 0\n\nwords 1");
  });

  it("many short parts (a phone locked often) are taken up to NOTE_MAX_PARTS", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 40, audio(), "audio/webm", 5);
    await expect(s.notes.segment(id, NOTE_MAX_PARTS, audio(), "audio/webm", 5)).rejects.toMatchObject({ status: 400 });
  });

  it("the finish route takes skip", async () => {
    const s = setup();
    const api = new Hono();
    mountVoiceNotesRec(api, "/voice", () => s.notes);
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 1, audio(), "audio/webm", 8);
    const h = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const r = await api.request(`/voice/notes/${id}/finish`, { method: "POST", headers: h, body: JSON.stringify({ segments: 2, skip: [0] }) });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await api.request(`/voice/notes/${id}/finish`, { method: "POST", headers: h, body: JSON.stringify({ segments: 2, skip: ["x"] }) })).status).toBe(400);
  });
});
