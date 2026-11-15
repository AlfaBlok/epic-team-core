import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { audioExt, createVoiceNotes, mountVoiceNotesRec, NOTE_MAX_MIN, NOTE_MODEL, NOTE_SEGMENT_S, noteCost, startTimings, type Transcriber } from "../src/voice/notes.js";
import { endpointLines, SEED_VERSION } from "../src/desk/desk.js";
import { MILESTONE_SEED_VERSION } from "../src/desk/milestoneChat.js";

// rework (the owner's review, 2026-11-02): voice notes in Chat. Tap to start, tap to finish; the page uploads self-contained
// segments while he talks, the console transcribes each once (gpt-4o-mini-transcribe), keeps the audio, and posts the transcript
// into the chat as his own message headed `🎙 Voice note (Chat)`; the cost counts in the voice month budget.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** OpenAI's real answer for the 29.6 s synthetic note (2026-11-02, gpt-4o-mini-transcribe). */
const REAL_USAGE = { type: "tokens", total_tokens: 399, input_tokens: 295, input_token_details: { text_tokens: 0, audio_tokens: 295 }, output_tokens: 104 };

function setup(o: { cap?: number; deskFails?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s12r-"));
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

describe("T42-S12 voice notes: cost and model", () => {
  it("prices a note from OpenAI's usage at $3/M audio in and $5/M out (about $0.003 a minute), else by length", () => {
    expect(NOTE_MODEL).toBe("gpt-4o-mini-transcribe");
    // 295 * 3 + 104 * 5 = 1405 per 1M
    expect(noteCost(REAL_USAGE, 29.6)).toBeCloseTo(0.001405, 6);
    expect(noteCost(undefined, 60)).toBeCloseTo(0.003, 6);
    expect(noteCost({ type: "duration", seconds: 120 }, 120)).toBeCloseTo(0.006, 6);
  });
  it("takes the browsers' recording formats, nothing else", () => {
    expect(audioExt("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExt("audio/mp4")).toBe("mp4");
    expect(audioExt("audio/ogg; codecs=opus")).toBe("ogg");
    expect(audioExt("text/plain")).toBeUndefined();
    expect(audioExt("video/webm")).toBeUndefined();
  });
});

describe("T42-S12 voice notes: record, transcribe, post", () => {
  it("two segments → one message in the chat, as Sam's voice note with the audio link, cost in the voice budget", async () => {
    const s = setup();
    const st = s.notes.start("T42-S12 · voice notes");
    expect(st).toMatchObject({ segmentS: NOTE_SEGMENT_S, maxMin: NOTE_MAX_MIN, usdPerMin: 0.003, model: NOTE_MODEL, monthUsd: 0, monthCapUsd: 25 });
    const id = st.note.id;
    expect(id).toMatch(/^vn_[0-9a-f]{8}$/);
    const a = await s.notes.segment(id, 0, audio(), "audio/webm;codecs=opus", 120);
    expect(a.segment.text).toBe("First part of the note about the release.");
    const b = await s.notes.segment(id, 1, audio(), "audio/webm;codecs=opus", 31);
    // The second segment is transcribed with the end of the first as context (words cut at the seam).
    expect(s.transcribe.mock.calls[1][1]).toMatchObject({ mime: "audio/webm", filename: `${id}-1.webm`, prompt: "First part of the note about the release." });
    expect(b.note).toMatchObject({ seconds: 151, segments: 2, costUsd: 0.00281 });
    s.clock.t += 5_000;
    const f = await s.notes.finish(id, { segments: 2, audioBase: "https://team.example.com/api/voice/notes" });
    expect(f.note.state).toBe("posted");
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].page).toBe("T42-S12 · voice notes");
    expect(s.sent[0].crid).toBe(`voice-note-chat-${id}`);
    expect(s.sent[0].text).toBe(
      [
        `🎙 Voice note (Chat), 2026-11-02 10:00Z · 2 min 31 s · $0.0028 (gpt-4o-mini-transcribe) · ${id}`,
        `Audio: https://team.example.com/api/voice/notes/${id}/audio (2 parts)`,
        "",
        "First part of the note about the release.\n\nSecond part: please ship it today.",
      ].join("\n"),
    );
    // Counted against the voice month budget, with the calls.
    const v = s.voice.state();
    expect(v.monthUsd).toBeCloseTo(0.00281, 6);
    expect(v.monthNotes).toBe(1);
    expect(v.monthNotesMinutes).toBe(2.5);
    // The audio is kept, each part as recorded.
    expect(fs.readFileSync(s.notes.audio(id, 1).file)).toEqual(Buffer.from(audio()));
    // A second finish (the page retried) posts nothing more.
    await s.notes.finish(id, { segments: 2, audioBase: "x" });
    expect(s.sent).toHaveLength(1);
  });

  it("a segment sent twice is transcribed once; finish waits for every segment", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/mp4", 120);
    await s.notes.segment(id, 0, audio(), "audio/mp4", 120);
    expect(s.transcribe).toHaveBeenCalledTimes(1);
    await expect(s.notes.finish(id, { segments: 2, audioBase: "x" })).rejects.toMatchObject({ status: 409, code: "segments_missing" });
    expect(s.sent).toHaveLength(0);
  });

  it("silence posts nothing; a failed post keeps the transcript and Send again posts it", async () => {
    const s = setup();
    s.transcribe.mockImplementationOnce(async () => ({ text: "  " }));
    const quiet = s.notes.start().note.id;
    await s.notes.segment(quiet, 0, audio(), "audio/webm", 4);
    expect((await s.notes.finish(quiet, { segments: 1, audioBase: "x" })).note.state).toBe("empty");
    expect(s.sent).toHaveLength(0);

    const f = setup({ deskFails: true });
    const id = f.notes.start().note.id;
    await f.notes.segment(id, 0, audio(), "audio/webm", 10);
    await expect(f.notes.finish(id, { segments: 1, audioBase: "x" })).rejects.toMatchObject({ status: 502, code: "desk_send_failed" });
    expect(f.notes.get(id)).toMatchObject({ state: "failed", transcript: "First part of the note about the release." });
  });

  it("caps: the switch off and the month cap refuse a note; a note stops at 2 hours, the part over the line still kept; only audio is taken", async () => {
    const s = setup();
    s.voice.setEnabled(false);
    expect(() => s.notes.start()).toThrow(expect.objectContaining({ code: "voice_off" }));
    s.voice.setEnabled(true);
    const id = s.notes.start().note.id;
    await expect(s.notes.segment(id, 0, audio(), "text/plain", 10)).rejects.toMatchObject({ status: 400 });
    expect(NOTE_MAX_MIN).toBe(120);
    // 60 two-minute parts are the 2 hours; the 61st (a late tick past the cap) is still kept; nothing past it.
    for (let n = 0; n < 61; n++) await s.notes.segment(id, n, audio(), "audio/webm", 120);
    await expect(s.notes.segment(id, 61, audio(), "audio/webm", 120)).rejects.toMatchObject({ code: "note_cap" });

    const c = setup({ cap: 1 });
    // A month that already spent its cap (calls and notes together).
    c.db.prepare("INSERT INTO voice_calls (id, started_at, last_beat_at, ended_at, model, cost_usd, tenant_id) VALUES ('call_x', ?, ?, ?, 'm', 1.2, 'home')").run("2026-11-02T09:00:00Z", "2026-11-02T09:00:00Z", "2026-11-02T09:01:00Z");
    expect(() => c.notes.start()).toThrow(expect.objectContaining({ code: "month_cap" }));
  });
});

describe("T42-S12 voice notes: routes", () => {
  const page = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const app = () => {
    const s = setup();
    const api = new Hono();
    mountVoiceNotesRec(api, "/voice", () => s.notes);
    return { ...s, api };
  };

  it("only Sam's page records; segments are raw audio; finish posts; the audio link plays the note", async () => {
    const s = app();
    expect((await s.api.request("/voice/notes", { method: "POST", headers: { ...page, "x-console-run": "team-desk" } })).status).toBe(403);
    expect((await s.api.request("/voice/notes", { method: "POST", headers: { ...page, authorization: "Bearer at_x" } })).status).toBe(403);
    const r = await s.api.request("/voice/notes", { method: "POST", headers: page, body: "{}" });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as any).note.id as string;
    const seg = await s.api.request(`/voice/notes/${id}/segments/0`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "audio/webm;codecs=opus", "x-seconds": "29.6" }, body: audio(3000) });
    expect(seg.status, await seg.clone().text()).toBe(200);
    expect(((await seg.json()) as any).segment.costUsd).toBeCloseTo(0.001405, 6);
    const fin = await s.api.request(`http://team.example.com/voice/notes/${id}/finish`, { method: "POST", headers: { ...page, host: "team.example.com", "x-forwarded-proto": "https" }, body: JSON.stringify({ segments: 1 }) });
    expect(fin.status, await fin.clone().text()).toBe(200);
    expect(s.sent[0].text.split("\n")[1]).toBe(`Audio: https://team.example.com/voice/notes/${id}/audio`);
    const play = await s.api.request(`/voice/notes/${id}/audio`);
    expect(play.status).toBe(200);
    expect(play.headers.get("content-type")).toBe("audio/webm");
    expect(new Uint8Array(await play.arrayBuffer()).byteLength).toBe(3000);
    const list = (await (await s.api.request("/voice/notes")).json()) as any;
    expect(list.notes[0]).toMatchObject({ id, state: "posted", segments: 1 });
  });
});

describe("T42-S12 voice notes: the desks act on them like typed text", () => {
  it("the Team desk's seed (v20) and the repo desks' (v8) say a Chat voice note is his chat message, spoken", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(20);
    expect(MILESTONE_SEED_VERSION).toBeGreaterThanOrEqual(8);
    const lines = endpointLines("http://x").join("\n");
    expect(lines).toContain("`🎙 Voice note (Chat)`");
    expect(lines).toMatch(/exactly his typed chat message, spoken: act on it as on his chat words/);
  });
});

describe("T42-S12 voice notes: every chat has them (the Team desk, a milestone's or campaign's chat)", () => {
  it("the console mounts the note routes on /api/voice and /api/milestones/:id/voice, counted in that chat's world", async () => {
    const { createApp } = await import("../src/app.js");
    const { createStore } = await import("../src/store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s12r-app-"));
    const db = openDb(path.join(dir, "c.db"));
    cleanup = () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    const transcribe = vi.fn<Transcriber>(async () => ({ text: "hello desk", usage: REAL_USAGE }));
    const app = createApp(db, {
      read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [], spines: async () => ({ root: "", orphans: [], mismatches: [], nodes: [] }) as any },
      browser: { browserUrl: "http://127.0.0.1:9" },
      voice: { mint: async () => ({ value: "ek", expires_at: 0 }), transcribe, notesDir: path.join(dir, "notes") },
    } as any);
    const m = createStore(db).createMilestone({ title: "PLAN-42", repo: "Acme/home_repo", path: "docs/spines/epic-42.md", owner: "", paused: false });
    const page = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
    for (const base of ["/api/voice", `/api/milestones/${m.id}/voice`]) {
      const r = await app.request(`${base}/notes`, { method: "POST", headers: page, body: "{}" });
      expect(r.status, `${base}: ${await r.clone().text()}`).toBe(201);
      const id = ((await r.json()) as any).note.id;
      const seg = await app.request(`${base}/notes/${id}/segments/0`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "audio/webm", "x-seconds": "30" }, body: audio() });
      expect(seg.status, await seg.clone().text()).toBe(200);
    }
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(path.join(dir, "notes"))).toHaveLength(2);
    // Both chats are the home world's: the month's voice budget holds both notes.
    const st = (await (await app.request("/api/voice/state")).json()) as any;
    expect(st.monthNotes).toBe(2);
    expect(st.monthUsd).toBeCloseTo(0.00281, 6);
    expect((await app.request("/api/milestones/nope/voice/notes", { method: "POST", headers: page, body: "{}" })).status).toBe(404);
  });
});

describe("T42-S43 the browser's start timings are kept with the note", () => {
  it("keeps the first part's x-start-ms (numbers only), never overwritten by a later part", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, audio(), "audio/webm;codecs=opus", 120, JSON.stringify({ tries: 1, note: 180, mic: 61000, rec: 61010 }));
    await s.notes.segment(id, 1, audio(), "audio/webm;codecs=opus", 30, JSON.stringify({ tries: 1, note: 1, mic: 2, rec: 3 }));
    expect(s.notes.list(5).find((n) => n.id === id)?.startMs).toEqual({ tries: 1, note: 180, mic: 61000, rec: 61010 });
    const api = new Hono();
    mountVoiceNotesRec(api, "/api/voice", () => s.notes);
    const id2 = s.notes.start().note.id;
    const r = await api.request(`/api/voice/notes/${id2}/segments/0`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "audio/webm", "x-seconds": "5", "x-start-ms": '{"note":40,"mic":900,"rec":905}' }, body: audio() });
    expect(r.status).toBe(200);
    expect(s.notes.list(5).find((n) => n.id === id2)?.startMs).toEqual({ note: 40, mic: 900, rec: 905 });
  });
  it("drops anything that is not a small number", () => {
    expect(startTimings(undefined)).toBeUndefined();
    expect(startTimings("not json")).toBeUndefined();
    expect(startTimings(JSON.stringify({ mic: -1, rec: "x", ua: "Mozilla" }))).toBeUndefined();
    expect(startTimings(JSON.stringify({ mic: 812.4, evil: 1 }))).toBe('{"mic":812}');
    expect(startTimings("x".repeat(400))).toBeUndefined();
  });
});
