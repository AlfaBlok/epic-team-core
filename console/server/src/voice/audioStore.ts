import fs from "node:fs";
import type { Hono } from "hono";
import type { DB } from "../db.js";
import { ensureVoiceNoteRecTables } from "./notes.js";

/**
 * every voice note recording of the owner keeps its audio, findable by its note id (vn_…), so a snippet can go
 * into a video later. The one store is the console's voice-notes folder (`<notesDir>/<vn id>/<part>.<ext>`, one row per
 * part in voice_note_segments), written by every recorder the console has: the Team desk Chat, a card's or ask's box, a
 * milestone or campaign chat, a steps page's note box, and every other world's desk and boxes. Nothing here deletes a
 * file; the worker server mirrors the folder every hour, files only ever added (the home repo's scripts/voice_audio.py).
 * Message-app notes go to the memory service's own number and their audio is archived there, not here.
 *
 * Owner-only routes (the home world's session; not in routeScope's world list):
 *   GET /api/voice/audio            → totals and the newest notes with their parts and sizes
 *   GET /api/voice/audio/:nid/info  → one note: world, when, where it was recorded, its parts (mime, bytes, seconds)
 *   GET /api/voice/audio/:nid?part=n → the audio of part n (default 0) as it was recorded
 */

export interface AudioPart {
  n: number;
  mime: string;
  bytes: number;
  seconds: number;
  kept: boolean;
}
export interface AudioInfo {
  id: string;
  world: string;
  milestoneId: string | null;
  startedAt: string;
  state: string;
  page: string | null;
  seconds: number;
  bytes: number;
  parts: AudioPart[];
}

const NOTE_ID = /^vn_[a-f0-9]{8}$/;

export function createAudioStore(db: DB) {
  ensureVoiceNoteRecTables(db);
  const partsOf = (id: string): (AudioPart & { file: string })[] =>
    (db.prepare("SELECT n, mime, file, bytes, seconds FROM voice_note_segments WHERE note_id = ? ORDER BY n").all(id) as any[]).map((r) => ({
      n: r.n,
      mime: String(r.mime).split(";")[0],
      bytes: r.bytes,
      seconds: r.seconds,
      kept: fs.existsSync(r.file),
      file: r.file,
    }));

  function info(id: string): AudioInfo | undefined {
    if (!NOTE_ID.test(id)) return undefined;
    const n = db.prepare("SELECT id, tenant_id, milestone_id, started_at, state, page, seconds FROM voice_notes WHERE id = ?").get(id) as any;
    if (!n) return undefined;
    const parts = partsOf(id).map(({ file: _f, ...p }) => p);
    return {
      id: n.id,
      world: n.tenant_id,
      milestoneId: n.milestone_id ?? null,
      startedAt: n.started_at,
      state: n.state,
      page: n.page ?? null,
      seconds: n.seconds,
      bytes: parts.reduce((s, p) => s + p.bytes, 0),
      parts,
    };
  }

  function file(id: string, part: number): { file: string; mime: string } | undefined {
    if (!NOTE_ID.test(id)) return undefined;
    const p = partsOf(id).find((x) => x.n === part);
    return p?.kept ? { file: p.file, mime: p.mime } : undefined;
  }

  function list(limit = 50) {
    const t = db.prepare("SELECT COUNT(DISTINCT note_id) notes, COUNT(*) parts, COALESCE(SUM(bytes), 0) bytes FROM voice_note_segments").get() as { notes: number; parts: number; bytes: number };
    const ids = (db.prepare("SELECT DISTINCT s.note_id id, n.started_at FROM voice_note_segments s JOIN voice_notes n ON n.id = s.note_id ORDER BY n.started_at DESC LIMIT ?").all(Math.min(500, Math.max(1, limit))) as { id: string }[]).map((r) => r.id);
    return { notes: t.notes, parts: t.parts, bytes: t.bytes, newest: ids.map((i) => info(i)!).filter(Boolean) };
  }

  return { info, file, list };
}

export function mountAudioStore(api: Hono, db: DB) {
  const s = createAudioStore(db);
  const nf = (id: string) => ({ error: { code: "not_found", message: `no kept audio for ${id.slice(0, 40)}` } });
  api.get("/voice/audio", (c) => c.json(s.list(Number(c.req.query("limit")) || 50)));
  api.get("/voice/audio/:nid/info", (c) => {
    const i = s.info(c.req.param("nid") ?? "");
    return i ? c.json(i) : c.json(nf(c.req.param("nid") ?? ""), 404);
  });
  api.get("/voice/audio/:nid", (c) => {
    const id = c.req.param("nid") ?? "";
    const f = s.file(id, Number(c.req.query("part")) || 0);
    if (!f) return c.json(nf(id), 404);
    const body = fs.readFileSync(f.file);
    return new Response(body, { headers: { "content-type": f.mime, "content-length": String(body.byteLength), "content-disposition": `inline; filename="${id}-${Number(c.req.query("part")) || 0}.${f.file.split(".").pop()}"`, "cache-control": "private, max-age=86400" } });
  });
  return s;
}
