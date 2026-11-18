import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, DELIVER_CHECK_MS, DELIVER_TRIES, ensureVoiceNoteRecTables, NOT_DELIVERED_RETRYING, type Transcriber } from "../src/voice/notes.js";
import { mountDesk } from "../src/desk/routes.js";
import { undeliveredNote } from "../src/voice/undeliveredNote.js";

// (the owner, 2026-11-18 03:43Z, vn_341120fc: "are these requests that I'm sending about this landing somewhere?
// Because it feels like they're landing on a bottomless pit"): vn_e423bce7 (03:06Z) and vn_341120fc (03:43Z) were
// marked posted when the desk's send answered `pending` (T3 busy retries still running); vn_341120fc's send died with the
// console restart at 03:44:27Z and neither reached the Team desk chat. Now a note is delivered only when the chat took
// it; 2 min on, one not in the chat is re-sent each minute, named on the chat ("not delivered yet, retrying") and its
// world's Delivery Manager gets a line.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(o: { pending?: boolean[]; inChat?: (sent: string[]) => boolean | undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s135-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let t = Date.parse("2026-11-18T03:43:31Z");
  const sent: string[] = [];
  const pending = [...(o.pending ?? [])];
  const desk: DeskPort = {
    send: vi.fn(async (text: string) => {
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
  return { db, notes, sent, lines, desk, tick: (ms: number) => (t += ms) };
}
const audio = () => new Uint8Array(1500).fill(7);
async function postNote(s: ReturnType<typeof setup>) {
  const id = s.notes.start().note.id;
  await s.notes.segment(id, 0, audio(), "audio/webm", 24, undefined, true);
  await s.notes.finish(id, { segments: 1, audioBase: "https://team/api/voice/notes" });
  return id;
}

describe("every Chat voice note reaches the desk, or he is told it did not", () => {
  it("a send the chat took is delivered at once; nothing is re-sent", async () => {
    const s = setup();
    const id = await postNote(s);
    expect(s.notes.get(id)).toMatchObject({ state: "posted" });
    expect(s.notes.get(id)?.deliveredAt).toBeTruthy();
    s.tick(DELIVER_CHECK_MS + 1000);
    expect((await s.notes.deliverCheck()).checked).toBe(0);
    expect(s.sent).toHaveLength(1);
  });

  it("vn_341120fc's case: a pending send lost to a restart is re-sent after 2 min, once in the chat it is delivered", async () => {
    const s = setup({ pending: [true] });
    const id = await postNote(s);
    expect(s.notes.get(id)?.state).toBe("posted");
    expect(s.notes.get(id)?.deliveredAt).toBeUndefined();
    expect(s.sent).toHaveLength(0);
    // not before 2 min: the pending send may still land
    expect((await s.notes.deliverCheck()).checked).toBe(0);
    s.tick(DELIVER_CHECK_MS + 1000);
    const r = await s.notes.deliverCheck();
    expect(r).toMatchObject({ checked: 1, resent: 1, delivered: 1 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain(id);
    expect(s.sent[0]).toContain("are these requests landing somewhere");
    expect(s.notes.get(id)?.deliveredAt).toBeTruthy();
    expect(s.lines).toEqual([{ id, tries: 1, gaveUp: false }]); // the Delivery Manager is told
    expect(s.notes.undelivered()).toEqual([]);
  });

  it("a pending send that did land is found in the chat and not sent twice", async () => {
    let landed = false;
    const s = setup({ pending: [true], inChat: () => landed });
    const id = await postNote(s);
    landed = true;
    s.tick(DELIVER_CHECK_MS + 1000);
    expect(await s.notes.deliverCheck()).toMatchObject({ checked: 1, delivered: 1, resent: 0 });
    expect(s.notes.get(id)?.deliveredAt).toBeTruthy();
    expect(s.lines).toEqual([]);
  });

  it("while it keeps failing the chat shows it plainly, re-sent each minute; when tries run out it says not delivered", async () => {
    const s = setup({ pending: Array(DELIVER_TRIES + 1).fill(true) });
    const id = await postNote(s);
    s.tick(DELIVER_CHECK_MS + 1000);
    await s.notes.deliverCheck();
    expect(s.notes.undelivered().map((n) => [n.id, n.delivery, n.deliverError])).toEqual([[id, "retrying", NOT_DELIVERED_RETRYING]]);
    for (let i = 1; i < DELIVER_TRIES; i++) {
      s.tick(60_000);
      await s.notes.deliverCheck();
    }
    expect(s.notes.get(id)?.delivery).toBe("failed");
    expect(s.notes.get(id)?.deliverError).toMatch(/not delivered: 10 tries failed/);
    expect(s.lines.map((l) => l.gaveUp)).toEqual([false, true]); // first miss and the last try, nothing in between
    s.tick(60_000);
    expect((await s.notes.deliverCheck()).checked).toBe(0);
  });

  it("notes posted before the check existed count as delivered (never re-sent on the release)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s135-old-"));
    const db = openDb(path.join(dir, "console.db"));
    try {
      db.exec("CREATE TABLE voice_notes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, milestone_id TEXT, started_at TEXT NOT NULL, finished_at TEXT, state TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, page TEXT, transcript TEXT, posted_at TEXT, post_error TEXT)");
      db.prepare("INSERT INTO voice_notes (id, tenant_id, started_at, state, posted_at) VALUES ('vn_old', 'home', '2026-11-18T03:00:00Z', 'posted', '2026-11-18T03:01:00Z')").run();
      ensureVoiceNoteRecTables(db);
      expect(db.prepare("SELECT delivered_at FROM voice_notes WHERE id = 'vn_old'").get()).toEqual({ delivered_at: "2026-11-18T03:01:00Z" });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the desk's chat read carries each undelivered note, so his Chat shows it", async () => {
    const api = new Hono();
    const desk = { view: async () => ({ available: true, threadId: "t", sending: 0, hasEarlier: false, messages: [], working: false }), earlier: async () => ({ messages: [], hasEarlier: false }) } as any;
    mountDesk(api, desk, undefined, undefined, undefined, undefined, () => [{ id: "vn_341120fc", startedAt: "2026-11-18T03:43:31Z", transcript: "bottomless pit", delivery: "retrying", deliverError: NOT_DELIVERED_RETRYING }]);
    const v = await (await api.request("/desk/messages")).json();
    expect(v.undeliveredNotes).toEqual([{ id: "vn_341120fc", at: "2026-11-18T03:43:31Z", text: "bottomless pit", state: "retrying", error: NOT_DELIVERED_RETRYING }]);
  });

  it("the Delivery Manager's desk note names the note, his words and what to do", () => {
    const n = undeliveredNote({ id: "vn_341120fc", world: "home", replyTo: "acme/team", postedAt: "2026-11-18T03:44:01Z", tries: 1, gaveUp: false, words: "landing on a bottomless pit", day: "2026-11-18" });
    expect(n.rel).toBe("desk/inbox/2026-11-18-console-voice-vn_341120fc.md");
    expect(n.text).toContain("kind: voice-undelivered");
    expect(n.text).toContain("alert: voice-vn_341120fc");
    expect(n.text).toContain('His words: "landing on a bottomless pit"');
  });
});
