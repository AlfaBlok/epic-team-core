import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
import { createVoiceNotes, DELIVER_CHECK_MS, DELIVER_TRIES, ensureVoiceNoteRecTables, NOT_DELIVERED_RETRYING, noteRequestId, REID_AFTER, type Transcriber } from "../src/voice/notes.js";
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

  it("while it keeps failing the chat shows it plainly, re-sent each minute; after DELIVER_TRIES the DM is told and it is never given up", async () => {
    const s = setup({ pending: Array(DELIVER_TRIES + 3).fill(true) });
    const id = await postNote(s);
    s.tick(DELIVER_CHECK_MS + 1000);
    await s.notes.deliverCheck();
    expect(s.notes.undelivered().map((n) => [n.id, n.delivery, n.deliverError])).toEqual([[id, "retrying", `${NOT_DELIVERED_RETRYING} (T3 is busy and has not taken it yet)`]]);
    for (let i = 1; i < DELIVER_TRIES; i++) {
      s.tick(60_000);
      await s.notes.deliverCheck();
    }
    expect(s.notes.get(id)?.delivery).toBe("retrying"); // 22 Nov: never "failed", his words are never given up
    expect(s.lines.map((l) => l.gaveUp)).toEqual([false, true]); // first miss and the stuck line, nothing in between
    s.tick(60_000);
    expect(await s.notes.deliverCheck()).toMatchObject({ checked: 1, resent: 1 }); // still re-sent, under its one request id
    expect(new Set(s.crids)).toEqual(new Set([noteRequestId(id)]));
    expect(s.lines.map((l) => l.gaveUp)).toEqual([false, true]);
  });

  it("a note still waiting to go in (held by the console, or in T3's queue) is never re-sent: no copies (22 Nov: 13 of one note)", async () => {
    const s = setup({ pending: Array(DELIVER_TRIES + 5).fill(true), inChat: () => "queued" });
    const id = await postNote(s);
    const before = s.crids.length;
    for (let i = 0; i < DELIVER_TRIES + 3; i++) {
      s.tick(DELIVER_CHECK_MS + 60_000);
      expect(await s.notes.deliverCheck()).toMatchObject({ checked: 1, resent: 0 });
    }
    expect(s.crids.length).toBe(before);
    expect(s.notes.get(id)?.deliveredAt).toBeFalsy();
    expect(s.lines).toEqual([]);
  });

  // (22 Nov vn_59852983, 06:50Z): T3 was stopped and then slow to start for 0.1.12 (06:08-07:34Z); every re-send it
  // could not answer carried a fresh id past 10 tries, T3 kept each one, and 23 copies reached the desk at 07:35Z.
  it("T3 down for 90 min: every re-send carries the note's one request id, so T3 keeps one copy", async () => {
    // a T3 that takes each id once (its receipts), whether it answers in time or not, and runs them when it is back
    const t3 = new Map<string, string>();
    let up = false;
    const s = setup({ inChat: () => undefined }); // down or slow: the thread cannot be read, so "cannot tell"
    (s.desk.send as any).mockImplementation(async (text: string, _p?: string, crid?: string) => {
      s.crids.push(crid);
      if (!t3.has(crid!)) t3.set(crid!, text); // a slow T3 still takes the send; the answer never comes back in time
      return { threadId: "thread_desk", pending: !up };
    });
    const id = await postNote(s);
    for (let m = 0; m < 90; m++) {
      s.tick(60_000);
      await s.notes.deliverCheck();
    }
    up = true;
    s.tick(60_000);
    await s.notes.deliverCheck();
    expect(s.crids.length).toBeGreaterThan(80); // it never stopped trying
    expect(new Set(s.crids)).toEqual(new Set([noteRequestId(id)]));
    expect([...t3.values()].filter((t) => t.includes(id))).toHaveLength(1); // one copy in the desk
    expect(s.notes.get(id)?.deliveredAt).toBeTruthy();
  });

  it("a new request id only when the note is proved absent after REID_AFTER tries, checked again just before", async () => {
    let absent: boolean | undefined = undefined;
    const s = setup({ pending: Array(REID_AFTER * 3).fill(true), inChat: () => (absent ? false : undefined) });
    const id = await postNote(s);
    for (let m = 0; m < REID_AFTER + 5; m++) {
      s.tick(60_000);
      await s.notes.deliverCheck();
    }
    expect(new Set(s.crids)).toEqual(new Set([noteRequestId(id)])); // never re-ided while it cannot be told
    absent = true; // T3 answers: not in the thread, not in its queue, not held
    s.tick(60_000);
    await s.notes.deliverCheck();
    expect(s.crids.at(-1)).toBe(noteRequestId(id, 1));
    s.tick(60_000);
    await s.notes.deliverCheck();
    expect(s.crids.at(-1)).toBe(noteRequestId(id, 1)); // the new id is kept, never one per minute
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
