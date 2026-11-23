import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, noteCost, type Transcriber } from "../src/voice/notes.js";
import { localTranscriber, mountTranscription, pickedTranscriber, setTranscriptionSettings, transcriptionSettings, transcriptionView } from "../src/voice/transcription.js";

// The owner: "I don't want to have phone calls anymore... could we not run our own transcription for free, like on a
// Whisper... a settings section... what is the model that is being used for transcription and what's the cost in the
// last 30 days".

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});
const T = Date.parse("2026-11-22T20:00:00Z");
function setup(transcribe: Transcriber, callsDefault?: "on" | "off") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-own-transcription-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const sent: string[] = [];
  const desk: DeskPort = {
    send: vi.fn(async (text: string) => (sent.push(text), { threadId: "t", pending: false })),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now: () => T, ...(callsDefault ? { callsDefault } : {}) });
  const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(dir, "notes"), now: () => T });
  return { db, voice, notes, sent };
}
const audio = () => new Uint8Array(1500).fill(7);
const ourServer = (text: string, model = "small") =>
  vi.fn(async () => new Response(JSON.stringify({ text, model, language: "en", audio_s: 108, ms: 41000 }), { status: 200 })) as unknown as typeof fetch;
const gemini = (text: string): Transcriber => async () => ({ text, provider: "gemini", model: "gemini-flash-latest", usage: { provider: "gemini", audio_tokens: 3456, text_tokens: 40, output_tokens: 300 } });
const down: typeof fetch = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe("our own transcription", () => {
  it("a voice note is written out by our Whisper, costs nothing and names the model in its head", async () => {
    const f = ourServer("We should run our own transcription.");
    let s!: ReturnType<typeof setup>;
    s = setup(async (a, o) => pickedTranscriber({ db: s.db, ours: (m) => localTranscriber("http://host1:18946", () => m, f), paid: gemini("never") })(a, o));
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm;codecs=opus", 108);
    const r = await s.notes.finish(id, { segments: 1, audioBase: "https://c/api/voice/notes" });
    expect(r.note.state).toBe("posted");
    expect(s.sent[0]).toContain("We should run our own transcription.");
    expect(s.sent[0]).toContain("(whisper-small)");
    const seg = s.db.prepare("SELECT provider, cost_usd, usage FROM voice_note_segments WHERE note_id = ?").get(id) as any;
    expect(seg.provider).toBe("local");
    expect(seg.cost_usd).toBe(0);
    expect(JSON.parse(seg.usage).ms).toBe(41000);
    const call = (f as any).mock.calls[0];
    expect(call[0]).toContain("http://host1:18946/transcribe?model=small&caller=console");
    expect(call[1].headers["content-type"]).toBe("audio/webm");
  });

  it("his model pick goes to our server; Gemini picked is used directly", async () => {
    const f = ourServer("turbo words", "large-v3-turbo");
    const s = setup(async () => ({ text: "" }));
    setTranscriptionSettings(s.db, { model: "large-v3-turbo" });
    const t = pickedTranscriber({ db: s.db, ours: (m) => localTranscriber("http://host1:18946", () => m, f), paid: gemini("paid words") });
    expect((await t(audio(), { mime: "audio/webm", filename: "a.webm" })).model).toBe("whisper-large-v3-turbo");
    expect((f as any).mock.calls[0][0]).toContain("model=large-v3-turbo");
    setTranscriptionSettings(s.db, { model: "gemini" });
    expect((await t(audio(), { mime: "audio/webm", filename: "a.webm" })).text).toBe("paid words");
    expect(() => setTranscriptionSettings(s.db, { model: "whisper-1" })).toThrow(/unknown model/);
  });

  it("ours down: the paid backup takes the part, marked, and the alarm fires; backup off: the part is unheard", async () => {
    const s = setup(async () => ({ text: "" }));
    const alarms: string[] = [];
    const t = pickedTranscriber({ db: s.db, ours: (m) => localTranscriber("http://host1:18946", () => m, down), paid: gemini("backup words"), onBackup: (why) => alarms.push(why), log: () => {} });
    const r = await t(audio(), { mime: "audio/webm", filename: "vn_x-0.webm" });
    expect(r.text).toBe("backup words");
    expect((r.usage as any).backup).toBe(true);
    expect(noteCost(r.usage, 108)).toBeGreaterThan(0);
    expect(alarms[0]).toMatch(/did not answer/);
    setTranscriptionSettings(s.db, { paidBackup: false });
    await expect(t(audio(), { mime: "audio/webm", filename: "vn_x-0.webm" })).rejects.toThrow(/paid backup is off/);
    expect(alarms).toHaveLength(1);
  });

  it("our parts cost nothing", () => {
    expect(noteCost({ provider: "local", model: "whisper-small", audio_s: 120, ms: 30000 }, 120)).toBe(0);
  });
});

describe("Settings, Transcription: model in use and the last 30 days", () => {
  it("sums each provider's parts, our server time, the backup parts and the calls", () => {
    const s = setup(async () => ({ text: "" }));
    const at = (d: number) => new Date(T - d * 86_400_000).toISOString();
    const seg = s.db.prepare("INSERT INTO voice_note_segments (note_id, n, at, mime, file, bytes, seconds, text, usage, cost_usd, provider) VALUES (?, ?, ?, 'audio/webm', 'f', 1, ?, 'w', ?, ?, ?)");
    seg.run("a", 0, at(20), 120, null, 0.006, null); // OpenAI, 20 days ago
    seg.run("a", 1, at(40), 120, null, 0.006, null); // older than 30 days: left out
    seg.run("b", 0, at(1), 60, JSON.stringify({ provider: "gemini", backup: true }), 0.004, "gemini");
    seg.run("c", 0, at(0.01), 90, JSON.stringify({ provider: "local", model: "whisper-large-v3-turbo", ms: 60000 }), 0, "local");
    s.db.prepare("INSERT INTO voice_calls (id, started_at, last_beat_at, model, cost_usd) VALUES ('call_1', ?, ?, 'gpt-realtime-2.1-mini', 2.29)").run(at(10), at(10));
    const v = transcriptionView(s.db, { now: T });
    expect(v.settings).toEqual({ model: "small", paidBackup: true });
    expect(v.inUse).toMatchObject({ model: "whisper-large-v3-turbo", provider: "local" });
    expect(v.last30.usd).toBeCloseTo(0.01, 6);
    expect(v.last30.minutes).toBe(4.5);
    expect(v.last30.lines[0]).toMatchObject({ provider: "local", usd: 0, parts: 1 });
    expect(v.last30.serverMinutes).toBe(1);
    expect(v.last30.backupParts).toBe(1);
    expect(v.calls).toEqual({ on: false, count: 1, usd: 2.29 });
  });

  it("GET for anyone of his, PUT only for him", async () => {
    const s = setup(async () => ({ text: "" }));
    const api = new Hono();
    mountTranscription(api, { db: s.db, callsOn: () => false, world: () => undefined, home: "home", now: () => T, refuse: (c) => (c.req.header("x-owner") ? undefined : "not the owner") });
    const g = await api.request("/voice/transcription");
    expect(g.status).toBe(200);
    expect(((await g.json()) as any).models.map((m: any) => m.id)).toEqual(["small", "large-v3-turbo", "gemini"]);
    const notHim = await api.request("/voice/transcription", { method: "PUT", body: JSON.stringify({ model: "gemini" }), headers: { "content-type": "application/json" } });
    expect(notHim.status).toBe(403);
    expect(transcriptionSettings(s.db).model).toBe("small");
    const him = await api.request("/voice/transcription", { method: "PUT", body: JSON.stringify({ model: "large-v3-turbo", paidBackup: false }), headers: { "content-type": "application/json", "x-owner": "1" } });
    expect(him.status).toBe(200);
    expect(((await him.json()) as any).settings).toEqual({ model: "large-v3-turbo", paidBackup: false });
  });
});

describe("voice calls are off, voice notes stay on", () => {
  it("off: no call starts, the state says so, notes still work", async () => {
    const s = setup(async () => ({ text: "still heard", provider: "local", model: "whisper-small", usage: { provider: "local" } }), "off");
    const st = s.voice.state();
    expect(st.available).toBe(false);
    expect(st.enabled).toBe(true);
    expect(st.callsOff).toBe(true);
    expect(st.reason).toMatch(/Calls are off/);
    await expect(s.voice.start()).rejects.toMatchObject({ code: "calls_off" });
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm", 30);
    expect((await s.notes.finish(id, { segments: 1, audioBase: "https://c/api/voice/notes" })).note.state).toBe("posted");
    s.voice.setCalls(true);
    expect(s.voice.state().callsOff).toBeUndefined();
  });
});
