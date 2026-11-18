import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, mountVoiceNotesRec, SEND_SLOW_MS, voiceSendHealth, type Transcriber } from "../src/voice/notes.js";

// (the owner, 2026-11-18: "why is it so slow to send a message? I am always afraid, will it be
// sent?"): his note took 11 s from stop to Sent because a part's upload waited for OpenAI to write its words and Send
// waited for them and for the chat. Now a part is answered once its audio is stored, a chat note is Sent (accepted) once
// every part is stored, its words and post run after, a failed post or a restart is finished by the sweeper, and tap
// stop to Sent over 3 s is an alert.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(o: { slowWordsMs?: number; deskFails?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s136-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let t = Date.parse("2026-11-18T18:00:00Z");
  const sent: string[] = [];
  let fails = o.deskFails ?? 0;
  const desk: DeskPort = {
    send: vi.fn(async (text: string) => {
      if (fails-- > 0) throw new Error("desk down");
      sent.push(text);
      return { threadId: "thread_desk", pending: false };
    }),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now: () => t });
  let release!: () => void;
  const wordsGate = new Promise<void>((ok) => (release = ok));
  const transcribe = vi.fn<Transcriber>(async () => {
    if (o.slowWordsMs) await wordsGate;
    return { text: "hello desk" };
  });
  const slow: { kind: string; ms: number; parts?: Record<string, number> }[] = [];
  const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(dir, "notes"), now: () => t, onSlow: (x) => slow.push({ kind: x.kind, ms: x.ms, ...(x.parts ? { parts: x.parts } : {}) }) });
  return { db, notes, sent, transcribe, release, slow, desk, tick: (ms: number) => (t += ms), now: () => t };
}
const audio = () => new Uint8Array(1500).fill(7);

describe("a voice note is Sent the moment its audio is safe", () => {
  it("a quick part is answered once stored, before its words; accept answers before the words and the post", async () => {
    const s = setup({ slowWordsMs: 1 });
    const id = s.notes.start().note.id;
    const seg = await s.notes.segment(id, 0, audio(), "audio/webm", 43, undefined, true);
    expect(seg.segment).toMatchObject({ n: 0, stored: true });
    expect(s.notes.get(id)?.seconds).toBe(43);
    const a = s.notes.accept(id, { segments: 1, audioBase: "https://team/api/voice/notes" });
    expect(a.accepted).toBe(true);
    expect(a.note.acceptedAt).toBeTruthy();
    expect(s.sent).toHaveLength(0); // nothing waited on OpenAI or the chat
    s.release();
    await vi.waitFor(() => expect(s.notes.get(id)?.state).toBe("posted"));
    expect(s.sent[0]).toContain("hello desk");
    expect(s.transcribe).toHaveBeenCalledTimes(1); // the background words were used, not written twice
  });

  it("accept refuses while a part's audio is not in, so Sent never shows for audio the console lacks", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm", 30, undefined, true);
    expect(() => s.notes.accept(id, { segments: 2, audioBase: "x" })).toThrow(/segments not in yet: 1/);
  });

  it("a failed post after Sent is finished by the sweeper, once, and an accepted note left too long is an alert", async () => {
    const s = setup({ deskFails: 1 });
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm", 30, undefined, true);
    s.notes.accept(id, { segments: 1, audioBase: "x" });
    await vi.waitFor(() => expect(s.notes.get(id)?.state).toBe("failed"));
    expect(await s.notes.resume()).toBe(0); // too fresh: the first try owns it
    s.tick(4 * 60_000);
    expect(await s.notes.resume()).toBe(1);
    expect(s.notes.get(id)?.state).toBe("posted");
    expect(s.sent).toHaveLength(1);
    expect(s.slow.map((x) => x.kind)).toEqual(["stuck"]);
    expect(await s.notes.resume()).toBe(0);
  });

  it("a restart between Sent and the words: the part has no words and no error, the sweeper writes and posts it", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm", 30, undefined, true);
    await vi.waitFor(() => expect(s.transcribe).toHaveBeenCalledTimes(1));
    // as after a restart: the words never landed, the note was accepted, nothing is finishing it
    s.db.prepare("UPDATE voice_note_segments SET text = NULL, error = NULL WHERE note_id = ?").run(id);
    s.db.prepare("UPDATE voice_notes SET accepted_at = ?, accept_json = ? WHERE id = ?").run(new Date(s.now()).toISOString(), JSON.stringify({ segments: 1, audioBase: "x" }), id);
    s.tick(60_000);
    expect(await s.notes.resume()).toBe(1);
    expect(s.notes.get(id)?.state).toBe("posted");
    expect(s.sent[0]).toContain("hello desk");
  });

  it("tap stop to Sent is kept once; over 3 s it is an alert and shows in the health line", async () => {
    const s = setup();
    const quick = s.notes.start().note.id;
    await s.notes.segment(quick, 0, audio(), "audio/webm", 10, undefined, true);
    s.notes.accept(quick, { segments: 1, audioBase: "x" });
    await vi.waitFor(() => expect(s.notes.get(quick)?.state).toBe("posted"));
    s.notes.timing(quick, 900);
    const slowId = s.notes.start().note.id;
    await s.notes.segment(slowId, 0, audio(), "audio/webm", 10, undefined, true);
    s.notes.accept(slowId, { segments: 1, audioBase: "x" });
    s.notes.timing(slowId, SEND_SLOW_MS + 1200, { stopMs: 40, earlyWaitMs: 0, uploadMs: 4100.4, tailBytes: 9000, earlyBytes: 60000, junk: 5 } as never);
    s.notes.timing(slowId, 100); // a second report never rewrites it
    expect(s.notes.get(slowId)?.sendMs).toEqual({ sent: SEND_SLOW_MS + 1200, stopMs: 40, earlyWaitMs: 0, uploadMs: 4100, tailBytes: 9000, earlyBytes: 60000 });
    // the alert names where the time went
    expect(s.slow).toEqual([{ kind: "slow", ms: SEND_SLOW_MS + 1200, parts: { stopMs: 40, earlyWaitMs: 0, uploadMs: 4100, tailBytes: 9000, earlyBytes: 60000 } }]);
    const h = voiceSendHealth(s.db, s.now());
    expect(h).toMatchObject({ state: "alert", limitMs: 3000, notes: 2, slow: 1, medianMs: 900, slowestMs: 4200 });
    expect(h.last?.id).toBe(slowId);
    expect(h.slowNotes?.[0]).toContain("uploadMs 4100");
  });

  it("routes: the finish with quick accepts a chat note; a card's answer (fill) still waits for its words; timing is checked", async () => {
    const s = setup();
    const api = new Hono();
    mountVoiceNotesRec(api, "/voice", () => s.notes);
    const h = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const id = s.notes.start().note.id;
    const up = await api.request(`/voice/notes/${id}/segments/0`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "audio/webm", "x-seconds": "5", "x-quick": "1" }, body: audio() });
    expect(up.status, await up.clone().text()).toBe(200);
    expect((await up.json()).segment.stored).toBe(true);
    const r = await api.request(`/voice/notes/${id}/finish`, { method: "POST", headers: h, body: JSON.stringify({ segments: 1, quick: true }) });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await r.json()).accepted).toBe(true);
    const t = await api.request(`/voice/notes/${id}/timing`, { method: "POST", headers: h, body: JSON.stringify({ sentMs: 640 }) });
    expect(t.status).toBe(200);
    expect((await api.request(`/voice/notes/${id}/timing`, { method: "POST", headers: h, body: JSON.stringify({}) })).status).toBe(400);
    const card = s.notes.start().note.id;
    await s.notes.segment(card, 0, audio(), "audio/webm", 5, undefined, true);
    const f = await api.request(`/voice/notes/${card}/finish`, { method: "POST", headers: h, body: JSON.stringify({ segments: 1, fill: true, quick: true }) });
    const fj = await f.json();
    expect(fj.accepted).toBeUndefined();
    expect(fj.note.state).toBe("transcribed");
    expect(fj.note.transcript).toBe("hello desk");
  });

  it("the part's start goes up while he talks: early bytes plus the tail at stop are the whole part, stored once", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    const whole = new Uint8Array(3000).map((_, i) => i % 251);
    expect(s.notes.early(id, 0, 0, whole.slice(0, 1000), "audio/webm")).toEqual({ have: 1000 });
    expect(s.notes.early(id, 0, 1000, whole.slice(1000, 2000), "audio/webm")).toEqual({ have: 2000 });
    // a resend from an earlier offset rewrites from there; a gap is refused
    expect(s.notes.early(id, 0, 1000, whole.slice(1000, 2000), "audio/webm")).toEqual({ have: 2000 });
    expect(() => s.notes.early(id, 0, 2500, whole.slice(0, 10), "audio/webm")).toThrow(/2000 bytes/);
    await s.notes.segment(id, 0, whole.slice(2000), "audio/webm", 12, undefined, true, 2000);
    const a = s.notes.audio(id, 0);
    expect(new Uint8Array(fs.readFileSync(a.file))).toEqual(whole);
    expect(fs.existsSync(path.join(path.dirname(a.file), "0.early"))).toBe(false);
    // a part already in takes no more early bytes
    expect(() => s.notes.early(id, 0, 0, whole.slice(0, 10), "audio/webm")).toThrow(/already in/);
  });

  it("a tail whose start the console lost (a restart) is refused, so the page sends the whole part", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    await expect(s.notes.segment(id, 0, audio(), "audio/webm", 5, undefined, true, 900)).rejects.toMatchObject({ code: "early_missing" });
    await s.notes.segment(id, 0, audio(), "audio/webm", 5, undefined, true);
    expect(s.notes.get(id)?.segments).toBe(1);
  });

  it("route: the last part's upload with x-accept answers Sent in the same request", async () => {
    const s = setup();
    const api = new Hono();
    mountVoiceNotesRec(api, "/voice", () => s.notes);
    const id = s.notes.start().note.id;
    const h = { "sec-fetch-site": "same-origin", "content-type": "audio/webm" };
    const e = await api.request(`/voice/notes/${id}/segments/0/early`, { method: "POST", headers: { ...h, "x-offset": "0" }, body: audio().slice(0, 1000) });
    expect(await e.json()).toEqual({ have: 1000 });
    const r = await api.request(`/voice/notes/${id}/segments/0`, { method: "POST", headers: { ...h, "x-seconds": "5", "x-quick": "1", "x-early-bytes": "1000", "x-accept": JSON.stringify({ segments: 1, skip: [] }) }, body: audio().slice(1000) });
    expect(r.status, await r.clone().text()).toBe(200);
    const j = await r.json();
    expect(j.accepted).toBe(true);
    expect(j.note.acceptedAt).toBeTruthy();
    await vi.waitFor(() => expect(s.notes.get(id)?.state).toBe("posted"));
    const bad = await api.request(`/voice/notes/${s.notes.start().note.id}/segments/0`, { method: "POST", headers: { ...h, "x-seconds": "5", "x-quick": "1", "x-accept": "{nope" }, body: audio() });
    expect(bad.status).toBe(400);
  });
});
