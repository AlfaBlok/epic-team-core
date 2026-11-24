import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { ensureVoiceNoteRecTables, noteCost, type Transcriber } from "../src/voice/notes.js";
import { ensureVoiceTables } from "../src/voice/voice.js";
import { elevenlabsTranscriber, localTranscriber, partModel, pickedTranscriber, setTranscriptionSettings, transcriptionSettings, transcriptionView } from "../src/voice/transcription.js";

// The owner 24 Nov 20:37Z: "ElevenLabs for all transcription", with our Whisper kept as the fallback.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});
function db(): DB {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-scribe-"));
  const d = openDb(path.join(dir, "console.db"));
  ensureVoiceTables(d);
  ensureVoiceNoteRecTables(d);
  cleanup = () => {
    d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return d;
}
const audio = () => new Uint8Array(1500).fill(7);
const scribe = (text: string, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(status === 200 ? { text, language_code: "eng" } : { detail: { message: "quota_exceeded" } }), { status, headers: { "character-cost": "41", "fiat-cost-before-overages": "0.0049" } })) as unknown as typeof fetch;
const ours = (text: string) => vi.fn(async () => new Response(JSON.stringify({ text, model: "small", audio_s: 60, ms: 9000 }), { status: 200 })) as unknown as typeof fetch;
const gemini: Transcriber = async () => ({ text: "gemini words", provider: "gemini", model: "gemini-flash-latest" });

describe("ElevenLabs Scribe for every voice note", () => {
  it("is the default model", () => {
    expect(transcriptionSettings(db()).model).toBe("elevenlabs");
  });

  it("sends the audio to Scribe with the key and keeps the credits it spent", async () => {
    const f = scribe(" Hello from the grant. ");
    const t = elevenlabsTranscriber(async () => "sk_test", "scribe_v1", f);
    const r = await t(audio(), { mime: "audio/webm", filename: "a.webm" });
    expect(r).toMatchObject({ text: "Hello from the grant.", provider: "elevenlabs", model: "scribe_v1", usage: { provider: "elevenlabs", credits: 41, list_usd: 0.0049, language: "eng" } });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.headers["xi-api-key"]).toBe("sk_test");
    expect((init.body as FormData).get("model_id")).toBe("scribe_v1");
    expect(noteCost(r.usage, 60)).toBe(0);
  });

  it("no key or a refusal: our Whisper takes the part, no paid backup", async () => {
    const d = db();
    const w = ours("whisper words");
    const logs: string[] = [];
    const backups: string[] = [];
    for (const eleven of [elevenlabsTranscriber(async () => undefined), elevenlabsTranscriber(async () => "k", "scribe_v1", scribe("", 402))]) {
      const t = pickedTranscriber({ db: d, eleven, ours: (m) => localTranscriber("http://host1:18946", () => m, w), paid: gemini, onBackup: (why) => backups.push(why), log: (m) => logs.push(m) });
      const r = await t(audio(), { mime: "audio/webm", filename: "a.webm" });
      expect(r.text).toBe("whisper words");
      expect(r.model).toBe("whisper-small");
    }
    expect(logs.join("\n")).toMatch(/ELEVENLABS_API_KEY[\s\S]*402/);
    expect(backups).toEqual([]);
  });

  it("a Whisper pick skips Scribe", async () => {
    const d = db();
    setTranscriptionSettings(d, { model: "small" });
    const f = scribe("never");
    const t = pickedTranscriber({ db: d, eleven: elevenlabsTranscriber(async () => "k", "scribe_v1", f), ours: (m) => localTranscriber("http://host1:18946", () => m, ours("w")), paid: gemini });
    expect((await t(audio(), { mime: "audio/webm", filename: "a.webm" })).text).toBe("w");
    expect((f as any).mock.calls).toHaveLength(0);
  });

  it("Settings counts Scribe's minutes and credits against the grant", () => {
    const d = db();
    const now = Date.parse("2026-11-24T23:00:00Z");
    const ins = d.prepare("INSERT INTO voice_note_segments (note_id, n, at, mime, file, bytes, seconds, text, provider, usage, cost_usd) VALUES ('n1', ?, ?, 'audio/webm', 'f', 1, ?, 'x', ?, ?, 0)");
    ins.run(0, new Date(now - 60_000).toISOString(), 120, "elevenlabs", JSON.stringify({ provider: "elevenlabs", model: "scribe_v1", credits: 80 }));
    ins.run(1, new Date(now - 30_000).toISOString(), 60, "elevenlabs", JSON.stringify({ provider: "elevenlabs", model: "scribe_v1", credits: 40 }));
    const v = transcriptionView(d, { now });
    expect(v.last30.lines[0]).toMatchObject({ provider: "elevenlabs", model: "scribe_v1", parts: 2, minutes: 3, usd: 0, credits: 120 });
    expect(v.last30.credits).toBe(120);
    expect(v.last30.grantCredits).toBe(33_010_000);
    expect(v.inUse).toMatchObject({ provider: "elevenlabs", model: "scribe_v1" });
    expect(partModel("elevenlabs", null)).toBe("scribe_v1");
  });
});
