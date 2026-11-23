import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, DELIVER_CHECK_MS, mountVoiceNotesRec, NOT_DELIVERED_RETRYING, UNDELIVERED_ALERT_MS, voiceSendHealth, type Transcriber } from "../src/voice/notes.js";

// (his 22 Nov 03:22Z desk chat: "screenshots and imafges i paste but dont seem to be sent"): his 03:07Z voice note
// vn_0000aaaa was re-sent for 76 min while T3 restarted, the chat said only "retrying" and nothing alerted past the first
// line. Now the note says why, he can Send again at once, and /api/health voiceSend alerts on a note or a held message
// the desk's chat still lacks after UNDELIVERED_ALERT_MS.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(o: { pending?: boolean[]; inChat?: (sent: string[]) => boolean | "queued" | undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s135-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let t = Date.parse("2026-11-18T03:43:31Z");
  const sent: string[] = [];
  const crids: (string | undefined)[] = [];
  const pending = [...(o.pending ?? [])];
  const desk: DeskPort = {
    send: vi.fn(async (text: string, _page?: string, crid?: string) => {
      crids.push(crid);
      const p = pending.length ? pending.shift()! : false;
      if (!p) sent.push(text); // a pending send is the one a restart lost
      return { threadId: "thread_desk", pending: p };
    }),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as any,
  };
  const voice = createVoice({ db, mint: async () => ({ value: "ek", expires_at: 0 }), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now: () => t });
  const transcribe = vi.fn<Transcriber>(async () => ({ text: "are these requests landing somewhere" }));
  const lines: { id: string; tries: number; gaveUp: boolean }[] = [];
  const notes = createVoiceNotes({
    db,
    voice,
    desk,
    transcribe,
    dir: path.join(dir, "notes"),
    now: () => t,
    seen: async (id) => (o.inChat ? o.inChat(sent) : sent.some((s) => s.includes(id))),
    onUndelivered: (u) => lines.push({ id: u.id, tries: u.tries, gaveUp: u.gaveUp }),
  });
  return { db, notes, sent, crids, lines, desk, tick: (ms: number) => (t += ms) };
}
const PAGE = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
const audio = () => new Uint8Array(1500).fill(7);
async function postNote(s: ReturnType<typeof setup>) {
  const id = s.notes.start().note.id;
  await s.notes.segment(id, 0, audio(), "audio/webm", 24, undefined, true);
  await s.notes.finish(id, { segments: 1, audioBase: "https://team/api/voice/notes" });
  return id;
}

describe("a stuck note says why, can be sent again now, and alerts after 10 min", () => {
  it("a send T3 holds names the reason on the note", async () => {
    const s = setup({ pending: [true, true] });
    const id = await postNote(s);
    s.tick(DELIVER_CHECK_MS + 1000);
    await s.notes.deliverCheck();
    const n = s.notes.get(id)!;
    expect(n.delivery).toBe("retrying");
    expect(n.deliverError).toBe(`${NOT_DELIVERED_RETRYING} (T3 is busy and has not taken it yet)`);
  });

  it("redeliver re-sends one note at once (no 2-minute wait) under its one request id and marks it delivered", async () => {
    const s = setup({ pending: [true] });
    const id = await postNote(s);
    expect(s.notes.get(id)?.deliveredAt).toBeUndefined();
    const r = await s.notes.redeliver(id);
    expect(r.delivered).toBe(true);
    expect(s.crids.every((c) => c === s.crids[0])).toBe(true);
    // a second press on a delivered note sends nothing more
    const before = s.crids.length;
    expect((await s.notes.redeliver(id)).delivered).toBe(true);
    expect(s.crids.length).toBe(before);
  });

  it("POST /voice/notes/:id/redeliver answers {delivered}", async () => {
    const s = setup({ pending: [true] });
    const id = await postNote(s);
    const api = new Hono();
    mountVoiceNotesRec(api, "/voice", () => s.notes);
    const res = await api.request(`/voice/notes/${id}/redeliver`, { method: "POST", headers: PAGE, body: "{}" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(true);
  });

  it("voiceSendHealth alerts on a note the chat lacks after 10 min, not before", async () => {
    const s = setup({ pending: Array(20).fill(true) });
    const id = await postNote(s);
    const posted = Date.parse(s.notes.get(id)!.postedAt!);
    expect(voiceSendHealth(s.db, posted + UNDELIVERED_ALERT_MS - 1000).undelivered).toEqual([]);
    const h = voiceSendHealth(s.db, posted + UNDELIVERED_ALERT_MS + 1000);
    expect(h.state).toBe("alert");
    expect(h.undelivered).toEqual([id]);
  });

  it("voiceSendHealth alerts on a typed message (his pasted images) the console still holds after 10 min", () => {
    const s = setup();
    s.db.exec("CREATE TABLE IF NOT EXISTS desk_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, desk_key TEXT NOT NULL, client_request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, page TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, thread_id TEXT, failed_at TEXT, error TEXT)");
    s.db.prepare("INSERT INTO desk_outbox (desk_key, client_request_id, text, message, created_at) VALUES ('team-desk', 'chat-af3f7306', 'screenshots', 'screenshots', '2026-11-22T03:22:00Z')").run();
    expect(voiceSendHealth(s.db, Date.parse("2026-11-22T03:25:00Z")).held).toEqual([]);
    const h = voiceSendHealth(s.db, Date.parse("2026-11-22T03:33:00Z"));
    expect(h).toMatchObject({ state: "alert", held: ["chat-af3f7306"] });
  });
});
