import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, mountVoiceNotesRec, type Transcriber } from "../src/voice/notes.js";

// a voice note as his answer on any card. The same note routes as Chat's voice note, with `fill`: the
// words come back for the card's text box (he edits, then presses the card's own button) and nothing is posted to the chat; the
// answer keeps the note's id and the link to its recording.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** OpenAI's real answer for the 29.6 s synthetic note (2026-11-02, gpt-4o-mini-transcribe). */
const REAL_USAGE = { type: "tokens", total_tokens: 399, input_tokens: 295, input_token_details: { text_tokens: 0, audio_tokens: 295 }, output_tokens: 104 };

function setup(o: { cap?: number; deskFails?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s8-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const clock = { t: Date.parse("2026-11-02T10:00:00Z") };
  const sent: { text: string; page?: string; crid?: string }[] = [];
  const desk: DeskPort = {
    send: vi.fn(async (text: string, page?: string, crid?: string) => {
      if (o.deskFails) throw new Error("T3 is down");
      sent.push({ text, page, crid });
      return { threadId: "thread_desk", pending: false };
    }),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now: () => clock.t });
  if (o.cap) voice.setMonthCap(o.cap);
  const said = ["First part of the note about the release.", "Second part: please ship it today."];
  const transcribe = vi.fn<Transcriber>(async (_audio, _o) => ({ text: said.shift() ?? "", usage: REAL_USAGE }));
  const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(dir, "notes"), now: () => clock.t });
  return { db, dir, voice, notes, sent, desk, transcribe, clock };
}

const audio = (n = 2000) => new Uint8Array(n).fill(7);

describe("T72-S8 a voice note as an answer on a card", () => {
  const page = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const app = () => {
    const s = setup();
    const api = new Hono();
    mountVoiceNotesRec(api, "/api/voice", () => s.notes);
    return { ...s, api };
  };
  const record = async (s: ReturnType<typeof app>, parts = 1) => {
    const r = await s.api.request("/api/voice/notes", { method: "POST", headers: page, body: JSON.stringify({ page: "card T72-A9" }) });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as any).note.id as string;
    for (let n = 0; n < parts; n++) {
      const seg = await s.api.request(`/api/voice/notes/${id}/segments/${n}`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "audio/webm;codecs=opus", "x-seconds": "12" }, body: audio() });
      expect(seg.status, await seg.clone().text()).toBe(200);
    }
    return id;
  };
  const finish = (s: ReturnType<typeof app>, id: string, body: object) =>
    s.api.request(`http://team.example.com/api/voice/notes/${id}/finish`, { method: "POST", headers: { ...page, host: "team.example.com", "x-forwarded-proto": "https" }, body: JSON.stringify(body) });

  it("fill: the words and the recording's link come back, nothing goes to the chat, the note is kept as transcribed", async () => {
    const s = app();
    const id = await record(s, 2);
    const r = await finish(s, id, { segments: 2, fill: true });
    expect(r.status, await r.clone().text()).toBe(200);
    const j = (await r.json()) as any;
    expect(j.note).toMatchObject({ id, state: "transcribed", segments: 2, transcript: "First part of the note about the release.\n\nSecond part: please ship it today." });
    expect(j.audio).toBe(`https://team.example.com/api/voice/notes/${id}/audio`);
    expect(s.desk.send).not.toHaveBeenCalled();
    expect(s.sent).toHaveLength(0);
    // A retry answers the same words (the page lost the answer), still nothing posted.
    const again = (await (await finish(s, id, { segments: 2, fill: true })).json()) as any;
    expect(again).toMatchObject({ note: { id, state: "transcribed" }, audio: j.audio });
    expect(s.transcribe).toHaveBeenCalledTimes(2);
    expect(s.desk.send).not.toHaveBeenCalled();
    // The recording plays from the link, and the note counts in the voice month budget like any other.
    expect((await s.api.request(`/api/voice/notes/${id}/audio`)).status).toBe(200);
    const list = (await (await s.api.request("/api/voice/notes")).json()) as any;
    expect(list.notes[0]).toMatchObject({ id, state: "transcribed" });
    expect(list.notes[0].costUsd).toBeGreaterThan(0);
    expect((s.db.prepare("SELECT page FROM voice_notes WHERE id = ?").get(id) as any).page).toBe("card T72-A9");
  });

  it("silence fills nothing; only Sam's page records; without fill the note still posts to the chat as before", async () => {
    const s = app();
    expect((await s.api.request("/api/voice/notes", { method: "POST", headers: { ...page, authorization: "Bearer at_x" }, body: "{}" })).status).toBe(403);
    s.transcribe.mockImplementationOnce(async () => ({ text: "  " }));
    const quiet = await record(s);
    expect(((await (await finish(s, quiet, { segments: 1, fill: true })).json()) as any).note).toMatchObject({ state: "empty" });
    const chat = await record(s);
    const r = (await (await finish(s, chat, { segments: 1 })).json()) as any;
    expect(r.note.state).toBe("posted");
    expect(r.audio).toBeUndefined();
    expect(s.sent).toHaveLength(1);
    expect((await finish(s, chat, { segments: 1, fill: "yes" })).status).toBe(400);
  });
});
