import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, mountVoiceNotesRec, type Transcriber } from "../src/voice/notes.js";
import { createFeedback, feedbackPage } from "../src/voiceFeedback.js";
import { stepVoicePage } from "../src/steps/stepVoice.js";
import { KEEP_JS } from "../src/voice/keepJs.js";

// the browser
// keeps each note until the console confirms it and resends it with the same client id. The console opens one note per
// client id, takes each part once (never transcribed or billed twice) and posts each note once, across a restart too.

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** One console process on `dir` (a second call on the same dir is the console after a restart). */
function consoleOn(dir: string) {
  const db: DB = openDb(path.join(dir, "console.db"));
  dbs.push(db);
  const sent: { text: string; crid?: string }[] = [];
  const desk: DeskPort = {
    send: vi.fn(async (text: string, _page?: string, crid?: string) => {
      await new Promise((r) => setTimeout(r, 20));
      sent.push({ text, crid });
      return { threadId: "thread_desk", pending: false };
    }),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }) });
  const transcribe = vi.fn<Transcriber>(async () => ({ text: "Keep this note, it is precious." }));
  const notes = createVoiceNotes({ db, voice, desk, transcribe, dir: path.join(dir, "notes") });
  const api = new Hono();
  mountVoiceNotesRec(api, "/voice", () => notes);
  return { db, notes, api, sent, transcribe, desk };
}
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s51-"));
  dirs.push(dir);
  return dir;
};
const page = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
const audio = () => new Uint8Array(2000).fill(7);
const cid = "6b1f3c1e-8f0a-4c55-9d3e-2a7f0b9c1d22";

describe("T42-S51 the console stores a resent voice note once", () => {
  it("a start with the same client id opens the same note, across a restart; a bad client id is refused", async () => {
    const dir = fresh();
    const a = consoleOn(dir);
    const r1 = await a.api.request("/voice/notes", { method: "POST", headers: page, body: JSON.stringify({ page: "on /", clientId: cid }) });
    expect(r1.status).toBe(201);
    const id = ((await r1.json()) as any).note.id;
    const again = (await (await a.api.request("/voice/notes", { method: "POST", headers: page, body: JSON.stringify({ clientId: cid }) })).json()) as any;
    expect(again.note.id).toBe(id);
    const b = consoleOn(dir); // the restart
    const after = (await (await b.api.request("/voice/notes", { method: "POST", headers: page, body: JSON.stringify({ clientId: cid }) })).json()) as any;
    expect(after.note.id).toBe(id);
    expect((b.db.prepare("SELECT COUNT(*) n FROM voice_notes").get() as { n: number }).n).toBe(1);
    expect((await b.api.request("/voice/notes", { method: "POST", headers: page, body: JSON.stringify({ clientId: "x y" }) })).status).toBe(400);
    // No client id (an older page): a new note each time, as before.
    const n1 = (await (await b.api.request("/voice/notes", { method: "POST", headers: page, body: "{}" })).json()) as any;
    const n2 = (await (await b.api.request("/voice/notes", { method: "POST", headers: page, body: "{}" })).json()) as any;
    expect(n1.note.id).not.toBe(n2.note.id);
  });

  it("killed mid-upload: the resent part is taken once, the note posts once, and a resend after the post gets the posted note back", async () => {
    const dir = fresh();
    const a = consoleOn(dir);
    const id = ((await (await a.api.request("/voice/notes", { method: "POST", headers: page, body: JSON.stringify({ clientId: cid }) })).json()) as any).note.id;
    const seg = (c: ReturnType<typeof consoleOn>) => c.api.request(`/voice/notes/${id}/segments/0`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "audio/webm", "x-seconds": "30" }, body: audio() });
    expect((await seg(a)).status).toBe(200); // stored, but the answer never reached the phone: the console went down
    const b = consoleOn(dir);
    const s2 = await seg(b); // the browser resends from its outbox after the restart
    expect(s2.status).toBe(200);
    expect(a.transcribe.mock.calls.length + b.transcribe.mock.calls.length).toBe(1);
    // The tab and the outbox both send it at once: one post.
    const fin = () => b.api.request(`/voice/notes/${id}/finish`, { method: "POST", headers: page, body: JSON.stringify({ segments: 1 }) });
    const [f1, f2] = await Promise.all([fin(), fin()]);
    expect([f1.status, f2.status]).toEqual([200, 200]);
    expect(b.sent).toHaveLength(1);
    // A resend after the post (its answer lost): the posted note again, nothing more.
    const f3 = await fin();
    expect(((await f3.json()) as any).note.state).toBe("posted");
    expect((await seg(b)).status).toBe(200);
    expect(b.sent).toHaveLength(1);
    expect(a.transcribe.mock.calls.length + b.transcribe.mock.calls.length).toBe(1);
    expect((b.db.prepare("SELECT seconds FROM voice_notes WHERE id = ?").get(id) as { seconds: number }).seconds).toBe(30);
  });

  it("a part the console never had, sent after the note closed, is refused plainly (the browser stops resending it)", async () => {
    const dir = fresh();
    const a = consoleOn(dir);
    const id = ((await (await a.api.request("/voice/notes", { method: "POST", headers: page, body: JSON.stringify({ clientId: cid }) })).json()) as any).note.id;
    await a.api.request(`/voice/notes/${id}/discard`, { method: "POST", headers: page, body: "{}" });
    const r = await a.api.request(`/voice/notes/${id}/segments/0`, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "audio/webm", "x-seconds": "3" }, body: audio() });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.message).toMatch(/is discarded/);
  });
});

describe("T42-S51 the plain recorder pages keep their notes too", () => {
  const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  it("the steps page's and the feedback link's recorders carry the keeper, send kept notes on load, and parse", () => {
    for (const html of [stepVoicePage({ page: { title: "Tax steps" }, step: "s1", stepTitle: "Open the app" }), feedbackPage({ who: "Ana", product: "SocialApp" })]) {
      const js = scripts(html).join("\n");
      expect(js).toContain(KEEP_JS.trim().slice(0, 40));
      expect(js).toMatch(/clientId/);
      expect(js).toMatch(/KEEP\.part\(cid, n, blob, secs\)/);
      expect(js).toMatch(/void sendKept\(\);/);
      expect(js).toMatch(/Saved on this phone/);
      expect(() => new Function(js)).not.toThrow();
    }
  });

  it("a customer's resent feedback note opens the same note and its parts are taken once", async () => {
    const dir = fresh();
    const db: DB = openDb(path.join(dir, "console.db"));
    dbs.push(db);
    const transcribe = vi.fn<Transcriber>(async () => ({ text: "I like it." }));
    const f = createFeedback({ db, transcribe, budget: () => ({ monthUsd: 0, monthCapUsd: 25, enabled: true }), repoOf: () => undefined, pageBase: "https://team.example.com" });
    const link = f.createLink({ world: "acme", who: "Ana", product: "SocialApp", campaign: "c1", by: "test" });
    const a = f.start(link.token, cid);
    expect(f.start(link.token, cid).note.id).toBe(a.note.id);
    await f.segment(link.token, a.note.id, 0, audio(), "audio/webm", 10);
    await f.segment(link.token, a.note.id, 0, audio(), "audio/webm", 10);
    f.finish(link.token, a.note.id, { parts: 1 });
    expect((await f.segment(link.token, a.note.id, 0, audio(), "audio/webm", 10)).text).toBe("I like it.");
    expect(f.finish(link.token, a.note.id, { parts: 1 }).note.state).not.toBe("recording");
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect((db.prepare("SELECT COUNT(*) n FROM feedback_notes").get() as { n: number }).n).toBe(1);
  });
});
