import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, fallbackTranscriber, geminiTranscriber, noteCost, noteRequestId, UNHEARD_LINE, voiceSendHealth, type Transcriber } from "../src/voice/notes.js";

// 22 Nov, OpenAI answered 429 "no credits remaining" and two of his voice notes reached the desk with no
// words. OpenAI failing now falls back to Gemini; both failing is a desk line with the audio and one alert to him; a
// note that went out wordless is heard again and re-posted under its next request id.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});
const T = Date.parse("2026-11-22T09:04:00Z");
function setup(transcribe: Transcriber) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s149-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const sent: { text: string; crid?: string }[] = [];
  const desk: DeskPort = {
    send: vi.fn(async (text: string, _page?: string, crid?: string) => (sent.push({ text, crid }), { threadId: "t", pending: false })),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now: () => T });
  const unheard: any[] = [];
  const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(dir, "notes"), now: () => T, onUnheard: (u) => unheard.push(u) });
  return { db, notes, sent, unheard };
}
const audio = () => new Uint8Array(1500).fill(7);
const no429: Transcriber = async () => {
  throw new Error("OpenAI did not transcribe the note (429): You have no credits remaining.");
};
const gem = (f: typeof fetch) => geminiTranscriber(async () => "gk", "gemini-flash-latest", f);
const gemOk = (text: string) =>
  vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 3456 }, { modality: "TEXT", tokenCount: 40 }], candidatesTokenCount: 300 } }), { status: 200 })) as unknown as typeof fetch;

describe("a voice note never arrives empty", () => {
  it("OpenAI 429: the part is transcribed by Gemini, which is named on the part and in the head, with its cost", async () => {
    const f = gemOk("It's nice that we have the briefings.");
    const s = setup(fallbackTranscriber(no429, gem(f), () => {}));
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm;codecs=opus", 108);
    const r = await s.notes.finish(id, { segments: 1, audioBase: "https://c/api/voice/notes" });
    expect(r.note.state).toBe("posted");
    expect(s.sent[0].text).toContain("It's nice that we have the briefings.");
    expect(s.sent[0].text).toContain("(gemini-flash-latest)");
    const seg = s.db.prepare("SELECT provider, cost_usd FROM voice_note_segments WHERE note_id = ?").get(id) as any;
    expect(seg.provider).toBe("gemini");
    expect(seg.cost_usd).toBeCloseTo((3456 * 1 + 40 * 0.3 + 300 * 2.5) / 1e6, 8);
    const call = (f as any).mock.calls[0];
    expect(call[0]).toContain("models/gemini-flash-latest:generateContent");
    expect(call[1].headers["x-goog-api-key"]).toBe("gk");
    expect(JSON.parse(call[1].body).contents[0].parts[1].inline_data.mime_type).toBe("audio/webm");
    expect(s.unheard).toHaveLength(0);
  });

  it("both fail: the desk gets his note's could-not-be-transcribed line with the audio, and the owner one alert, once", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })) as unknown as typeof fetch;
    const s = setup(fallbackTranscriber(no429, gem(bad), () => {}));
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm", 108).catch(() => undefined);
    await s.notes.segment(id, 1, audio(), "audio/webm", 112).catch(() => undefined);
    await s.notes.finish(id, { segments: 2, audioBase: "https://c/api/voice/notes" });
    expect(s.sent[0].text).toContain(`${UNHEARD_LINE}; audio: https://c/api/voice/notes/${id}/audio`);
    expect(s.unheard).toHaveLength(1);
    expect(s.unheard[0]).toMatchObject({ id, parts: [0, 1], of: 2, audio: `https://c/api/voice/notes/${id}/audio` });
    expect(s.unheard[0].error).toContain("429");
    expect(voiceSendHealth(s.db, T + 60_000)).toMatchObject({ state: "alert", unheard: [id] });
  });

  it("redo: a wordless note is heard again and re-posted as his message under its next request id; a second redo posts nothing", async () => {
    let up = false;
    const t: Transcriber = async (a, o) => (up ? { text: `heard ${o.filename}`, provider: "gemini", model: "gemini-flash-latest" } : no429(a, o));
    const s = setup(t);
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm", 108).catch(() => undefined);
    await s.notes.finish(id, { segments: 1, audioBase: "https://c/api/voice/notes" });
    expect(s.sent).toHaveLength(1);
    up = true;
    const r = await s.notes.redo(id, { audioBase: "https://c/api/voice/notes" });
    expect(r).toMatchObject({ heard: [0], still: [], reposted: true });
    expect(s.sent[1].crid).toBe(noteRequestId(id, 1));
    expect(s.sent[1].text).toContain(`heard ${id}-0.webm`);
    expect(s.sent[1].text).not.toContain(UNHEARD_LINE);
    expect(r.note.transcript).toBe(`heard ${id}-0.webm`);
    const again = await s.notes.redo(id, { audioBase: "https://c/api/voice/notes" });
    expect(again.reposted).toBe(false);
    expect(s.sent).toHaveLength(2);
  });

  it("noteCost reads Gemini's usage; by length when it has none", () => {
    expect(noteCost({ provider: "gemini", audio_tokens: 1_000_000, text_tokens: 0, output_tokens: 0 }, 60)).toBe(1);
    expect(noteCost({ provider: "gemini" }, 100)).toBeCloseTo(0.0032, 6);
  });
});
