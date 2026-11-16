import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, type Transcriber } from "../src/voice/notes.js";
import { mountAudioStore } from "../src/voice/audioStore.js";

// every recording of his keeps its audio, findable by note id in any world, never deleted (a snippet for a video later).

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-audio-kept-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const desk: DeskPort = {
    send: vi.fn(async () => ({ threadId: "thread_desk", pending: false })),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const now = () => Date.parse("2026-11-16T08:00:00Z");
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now });
  const transcribe = vi.fn<Transcriber>(async () => ({ text: "words" }));
  const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(dir, "notes"), now });
  const app = new Hono();
  const api = new Hono();
  mountAudioStore(api, db);
  app.route("/api", api);
  return { db, notes, app };
}
const bytes = (n: number, v: number) => new Uint8Array(n).fill(v);

describe("the audio of every voice note is kept and found by its id", () => {
  it("returns each part's audio byte for byte, with its info and the totals", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, bytes(1500, 7), "audio/webm;codecs=opus", 30);
    await s.notes.segment(id, 1, bytes(900, 9), "audio/webm;codecs=opus", 12);
    await s.notes.finish(id, { segments: 2, audioBase: "x" });

    const info = await (await s.app.request(`/api/voice/audio/${id}/info`)).json();
    expect(info).toMatchObject({ id, bytes: 2400, parts: [{ n: 0, mime: "audio/webm", bytes: 1500, kept: true }, { n: 1, bytes: 900, kept: true }] });

    const r0 = await s.app.request(`/api/voice/audio/${id}`);
    expect(r0.status).toBe(200);
    expect(r0.headers.get("content-type")).toBe("audio/webm");
    expect(new Uint8Array(await r0.arrayBuffer())).toEqual(bytes(1500, 7));
    const r1 = await s.app.request(`/api/voice/audio/${id}?part=1`);
    expect(new Uint8Array(await r1.arrayBuffer())).toEqual(bytes(900, 9));

    const all = await (await s.app.request(`/api/voice/audio`)).json();
    expect(all).toMatchObject({ notes: 1, parts: 2, bytes: 2400 });
    expect(all.newest[0].id).toBe(id);
  });

  it("a discarded note keeps its audio (nothing he recorded is thrown away)", async () => {
    const s = setup();
    const id = s.notes.start().note.id;
    await s.notes.segment(id, 0, bytes(800, 3), "audio/mp4", 4);
    s.notes.discard(id);
    expect((await s.app.request(`/api/voice/audio/${id}`)).status).toBe(200);
  });

  it("an unknown or malformed id is a 404, never a path outside the store", async () => {
    const s = setup();
    expect((await s.app.request(`/api/voice/audio/vn_00000000`)).status).toBe(404);
    expect((await s.app.request(`/api/voice/audio/..%2F..%2Fconsole.db`)).status).toBe(404);
    expect((await s.app.request(`/api/voice/audio/vn_00000000/info`)).status).toBe(404);
  });
});
