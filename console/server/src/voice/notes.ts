import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "../db.js";
import { VOICE_NOTE_HEAD } from "../desk/voiceNotes.js";
import { notJordi } from "../status/mark.js";
import { VoiceError, type DeskPort, type Voice } from "./voice.js";
import { ownerName } from "../identity.js";

/**
 * rework (the owner's review, 2026-11-02): voice notes in Chat. One button: tap to start, tap to finish. The page records
 * in self-contained segments (a new MediaRecorder every NOTE_SEGMENT_S on the same microphone, so no gap) and uploads each one
 * while he keeps talking; the console transcribes each segment once (gpt-4o-mini-transcribe, the cheaper of the two good
 * OpenAI models: $0.003 a minute against whisper-1's $0.006) with the previous segment's last words as context, keeps the
 * audio, and on finish posts the whole transcript into the chat as the owner's own message, headed like a WhatsApp voice note
 * (`🎙 Voice note (Chat)`), so the desk acts on it like typed text. No realtime session, nothing re-read per turn. Every
 * segment's cost counts against the voice month budget (the same cap as calls, per world).
 */

export const NOTE_MODEL = "gpt-4o-mini-transcribe";
/** OpenAI's gpt-4o-mini-transcribe prices, US$ per 1M tokens (checked 2026-11-02); about $0.003 a minute of speech. */
export const NOTE_PRICES = { audioIn: 3, textIn: 1.25, out: 5 };
export const NOTE_USD_PER_MIN = 0.003;
/** The page starts a new segment this often: each is a whole file, uploaded and transcribed while he keeps talking. */
export const NOTE_SEGMENT_S = 120;
/** The cap of one note: the page sends it by itself at this length. */
export const NOTE_MAX_MIN = 30;
/** One segment's upload at most (two minutes of 32 kbit/s opus is about 0.5 MB; AAC from an iPhone about 1-2 MB). */
export const NOTE_SEGMENT_MAX_BYTES = 12 * 1024 * 1024;
/** Page hint of a Chat voice note when he had none: the desk's seed reads the head, not the hint. */
export const NOTE_SOURCE = "Chat";
/**
 * the most parts a note may have. Parts are cut every NOTE_SEGMENT_S and also each time the phone locks or the
 * note picks up again after a lock (so what was said is uploaded at once); the 30-minute cap still bounds the length.
 */
export const NOTE_MAX_PARTS = 100;
/** Context for the next segment: the last words of the previous one (OpenAI's `prompt`). */
const PROMPT_TAIL = 300;

export interface Transcript {
  text: string;
  usage?: unknown;
}
/** Transcribe one audio file (tests fake it). */
export type Transcriber = (audio: Uint8Array, o: { mime: string; filename: string; prompt?: string }) => Promise<Transcript>;

export function ensureVoiceNoteRecTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_notes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      milestone_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      state TEXT NOT NULL,
      seconds REAL NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      page TEXT,
      transcript TEXT,
      posted_at TEXT,
      post_error TEXT
    );
    CREATE INDEX IF NOT EXISTS voice_notes_started ON voice_notes (started_at);
    CREATE TABLE IF NOT EXISTS voice_note_segments (
      note_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      at TEXT NOT NULL,
      mime TEXT NOT NULL,
      file TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      seconds REAL NOT NULL,
      text TEXT,
      usage TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT,
      PRIMARY KEY (note_id, n)
    );
  `);
  // how long the browser took from the press to the note open, the microphone open and recording (JSON, ms), sent
  // with the first part, so a slow start shows which stage held it.
  const cols = new Set((db.prepare("PRAGMA table_info(voice_notes)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("start_ms")) db.exec("ALTER TABLE voice_notes ADD COLUMN start_ms TEXT");
  // the browser's id for the note (its outbox key): a start with the same id opens the same note, never a second.
  if (!cols.has("client_id")) db.exec("ALTER TABLE voice_notes ADD COLUMN client_id TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS voice_notes_client ON voice_notes (tenant_id, client_id) WHERE client_id IS NOT NULL");
}

/** the browser's start timings (`x-start-ms`: press to note, mic, recording; ms), kept only as small numbers. */
export function startTimings(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 300) return undefined;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const k of ["note", "mic", "rec", "tries"]) {
      const v = j[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 3_600_000) out[k] = Math.round(v);
    }
    return Object.keys(out).length ? JSON.stringify(out) : undefined;
  } catch {
    return undefined;
  }
}

/** US$ of one transcription: from OpenAI's usage (audio and text tokens in, text out), else by length. */
export function noteCost(usage: unknown, seconds: number): number {
  const u = (usage ?? {}) as Record<string, any>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  let usd: number;
  if (u.type === "tokens" && (num(u.input_tokens) || num(u.output_tokens))) {
    const d = u.input_token_details ?? {};
    const audio = num(d.audio_tokens) || (d.text_tokens === undefined ? num(u.input_tokens) : 0);
    const text = num(d.text_tokens);
    usd = (audio * NOTE_PRICES.audioIn + text * NOTE_PRICES.textIn + num(u.output_tokens) * NOTE_PRICES.out) / 1_000_000;
  } else usd = (Math.max(0, seconds) / 60) * NOTE_USD_PER_MIN;
  return Math.round(usd * 1e6) / 1e6;
}

const EXT: Record<string, string> = { webm: "webm", ogg: "ogg", mp4: "mp4", m4a: "m4a", "x-m4a": "m4a", aac: "m4a", mpeg: "mp3", mp3: "mp3", wav: "wav", "x-wav": "wav", flac: "flac" };
/** The file extension OpenAI needs for this content type, or undefined (not audio we take). */
export function audioExt(mime: string): string | undefined {
  const m = /^audio\/([\w.+-]+)/i.exec(mime.trim());
  return m ? EXT[m[1].toLowerCase()] : undefined;
}

/** The default transcriber: OpenAI's /v1/audio/transcriptions with the console's own key. */
export function openAiTranscriber(key: () => Promise<string | undefined>, f: typeof fetch = fetch): Transcriber {
  return async (audio, o) => {
    const k = await key();
    if (!k) throw new VoiceError(503, "no_key", "the console has no OPENAI_API_KEY (secret store agent-team-console/OPENAI_API_KEY)");
    const form = new FormData();
    form.append("file", new Blob([audio.slice()], { type: o.mime }), o.filename);
    form.append("model", NOTE_MODEL);
    form.append("response_format", "json");
    if (o.prompt) form.append("prompt", o.prompt);
    const r = await f("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${k}` }, body: form, signal: AbortSignal.timeout(120_000) });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || typeof j.text !== "string") throw new VoiceError(502, "openai_refused", `OpenAI did not transcribe the note (${r.status}): ${String(j?.error?.message ?? "no message").slice(0, 200)}`);
    return { text: j.text, ...(j.usage ? { usage: j.usage } : {}) };
  };
}

export interface VoiceNote {
  id: string;
  startedAt: string;
  finishedAt?: string;
  /** `transcribed`: an answer on a card: the words went back to the page's text box, nothing was posted to the chat. */
  state: "recording" | "posted" | "transcribed" | "empty" | "failed" | "discarded";
  seconds: number;
  segments: number;
  costUsd: number;
  transcript?: string;
  postedAt?: string;
  postError?: string;
  /** the browser's start timings, ms after the press (note open, microphone open, recording; tries to open the note). */
  startMs?: Record<string, number>;
}

export interface NoteStart {
  note: VoiceNote;
  segmentS: number;
  maxMin: number;
  usdPerMin: number;
  model: string;
  monthUsd: number;
  monthCapUsd: number;
}

export interface NotesDeps {
  db: DB;
  /** The Voice of this chat (its world, its milestone, its switch and month budget). */
  voice: Voice;
  desk?: Pick<DeskPort, "send">;
  transcribe: Transcriber;
  /** Where the audio is kept: <dir>/<note id>/<n>.<ext>. */
  dir: string;
  now?: () => number;
  /**
   * a Chat note is on the chat: forward it to the owner's the memory service in the background (a hosted services module); never awaited.
   * a card answer (finish with `fill`) too, once transcribed: every note he records lands in the memory service once.
   */
  onPosted?: (noteId: string) => void;
  /**
   * a note was filed (posted to its chat, or `fill`: its words went to a card's box and its press), with where and
   * his words, so the rest of what he said reaches the Team desk (spill.ts); never awaited.
   */
  onFiled?: (f: { id: string; world: string; milestoneId?: string; fill: boolean; page?: string; words: string; audio: string }) => void;
}

const clock = (s: number) => `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
const usd = (v: number) => `$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`;

/** one finish per note at a time (the tab and its outbox may both send it): a second waits for the first's answer. */
const finishing = new Map<string, Promise<{ note: VoiceNote; audio?: string }>>();

export function createVoiceNotes(d: NotesDeps) {
  const { db } = d;
  ensureVoiceNoteRecTables(db);
  const now = d.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  const world = d.voice.scope.world;
  const ms = d.voice.scope.milestoneId ?? null;
  const sc = { w: world, m: ms };

  const rowTo = (r: any): VoiceNote => {
    const segs = db.prepare("SELECT COUNT(*) n FROM voice_note_segments WHERE note_id = ?").get(r.id) as { n: number };
    return {
      id: r.id,
      startedAt: r.started_at,
      ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
      state: r.state,
      seconds: Math.round(r.seconds),
      segments: segs.n,
      costUsd: r.cost_usd,
      ...(r.transcript ? { transcript: r.transcript } : {}),
      ...(r.posted_at ? { postedAt: r.posted_at } : {}),
      ...(r.post_error ? { postError: r.post_error } : {}),
      ...(r.start_ms ? { startMs: JSON.parse(r.start_ms) as Record<string, number> } : {}),
    };
  };
  const get = (id: string): VoiceNote | undefined => {
    const r = db.prepare("SELECT * FROM voice_notes WHERE id = @id AND tenant_id = @w AND milestone_id IS @m").get({ id, ...sc });
    return r ? rowTo(r) : undefined;
  };
  const must = (id: string) => {
    const n = get(id);
    if (!n) throw new VoiceError(404, "not_found", `no voice note ${id}`);
    return n;
  };
  const budget = () => {
    const st = d.voice.state();
    return { monthUsd: st.monthUsd, monthCapUsd: st.limits.monthCapUsd };
  };

  function start(page?: string, clientId?: string): NoteStart {
    // a resend from the browser's outbox (a retry, a reload, after a restart) gets the note it opened before.
    if (clientId) {
      const had = db.prepare("SELECT id FROM voice_notes WHERE tenant_id = ? AND client_id = ?").get(world, clientId) as { id: string } | undefined;
      if (had) return { note: must(had.id), segmentS: NOTE_SEGMENT_S, maxMin: NOTE_MAX_MIN, usdPerMin: NOTE_USD_PER_MIN, model: NOTE_MODEL, ...budget() };
    }
    if (!d.voice.enabled()) throw new VoiceError(409, "voice_off", `${d.voice.state().reason ?? "Voice is switched off in the console."} Type instead.`);
    const b = budget();
    if (b.monthUsd >= b.monthCapUsd) throw new VoiceError(409, "month_cap", `Voice is paused until the 1st: this month reached its ${usd(b.monthCapUsd)} cap. Type instead.`);
    if (!d.desk) throw new VoiceError(503, "desk_unavailable", "this chat has no desk to post the note to");
    const id = `vn_${crypto.randomBytes(4).toString("hex")}`;
    db.prepare("INSERT INTO voice_notes (id, tenant_id, milestone_id, started_at, state, page, client_id) VALUES (?, ?, ?, ?, 'recording', ?, ?)").run(id, world, ms, iso(), page?.slice(0, 200) ?? null, clientId ?? null);
    return { note: must(id), segmentS: NOTE_SEGMENT_S, maxMin: NOTE_MAX_MIN, usdPerMin: NOTE_USD_PER_MIN, model: NOTE_MODEL, ...b };
  }

  const recording = (id: string) => {
    const n = must(id);
    if (n.state !== "recording") throw new VoiceError(409, "note_closed", `voice note ${id} is ${n.state}`);
    return n;
  };
  const retotal = (id: string) => {
    const t = db.prepare("SELECT COALESCE(SUM(seconds), 0) s, COALESCE(SUM(cost_usd), 0) c FROM voice_note_segments WHERE note_id = ?").get(id) as { s: number; c: number };
    db.prepare("UPDATE voice_notes SET seconds = ?, cost_usd = ? WHERE id = ?").run(t.s, Math.round(t.c * 1e6) / 1e6, id);
  };
  const segRow = (id: string, n: number) => db.prepare("SELECT * FROM voice_note_segments WHERE note_id = ? AND n = ?").get(id, n) as any;

  /** One segment: kept on disk, transcribed once (a retry of a transcribed segment answers from the row). */
  async function segment(id: string, n: number, audio: Uint8Array, mime: string, seconds: number, startMs?: string) {
    // a part the console already has answers from its row, even once the note is closed (a resend whose first
    // answer was lost in a restart): taken once, never transcribed or billed twice.
    const had = Number.isInteger(n) ? segRow(id, n) : undefined;
    if (had?.text != null && must(id)) return { segment: { n, text: had.text as string, costUsd: had.cost_usd as number }, note: must(id) };
    recording(id);
    const sm = startTimings(startMs);
    if (sm) db.prepare("UPDATE voice_notes SET start_ms = COALESCE(start_ms, ?) WHERE id = ?").run(sm, id);
    if (!Number.isInteger(n) || n < 0 || n >= NOTE_MAX_PARTS) throw new VoiceError(400, "validation_error", `segment number ${n} is out of range`);
    const ext = audioExt(mime);
    if (!ext) throw new VoiceError(400, "validation_error", `not audio this console takes: ${mime.slice(0, 60)}`);
    if (!audio.byteLength) throw new VoiceError(400, "validation_error", "the segment is empty");
    if (audio.byteLength > NOTE_SEGMENT_MAX_BYTES) throw new VoiceError(400, "too_big", `a segment is at most ${NOTE_SEGMENT_MAX_BYTES / 1024 / 1024} MB`);
    const done = segRow(id, n);
    if (done?.text != null) return { segment: { n, text: done.text as string, costUsd: done.cost_usd as number }, note: must(id) };
    const sec = Math.max(0, Math.min(NOTE_SEGMENT_S * 2, Number.isFinite(seconds) ? seconds : 0));
    const sofar = (db.prepare("SELECT COALESCE(SUM(seconds), 0) s FROM voice_note_segments WHERE note_id = ? AND n != ?").get(id, n) as { s: number }).s;
    if (sofar + sec > NOTE_MAX_MIN * 60 + 30) throw new VoiceError(409, "note_cap", `a voice note is at most ${NOTE_MAX_MIN} minutes`);
    const b = budget();
    if (b.monthUsd >= b.monthCapUsd) throw new VoiceError(409, "month_cap", `Voice is paused until the 1st: this month reached its ${usd(b.monthCapUsd)} cap.`);
    const folder = path.join(d.dir, id);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${n}.${ext}`);
    fs.writeFileSync(file, audio);
    db.prepare(
      `INSERT INTO voice_note_segments (note_id, n, at, mime, file, bytes, seconds) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (note_id, n) DO UPDATE SET at = excluded.at, mime = excluded.mime, file = excluded.file, bytes = excluded.bytes, seconds = excluded.seconds, error = NULL`,
    ).run(id, n, iso(), mime.slice(0, 80), file, audio.byteLength, sec);
    const prev = n > 0 ? (segRow(id, n - 1)?.text as string | undefined) : undefined;
    try {
      const t = await d.transcribe(audio, { mime: mime.split(";")[0], filename: `${id}-${n}.${ext}`, ...(prev ? { prompt: prev.slice(-PROMPT_TAIL) } : {}) });
      const cost = noteCost(t.usage, sec);
      db.prepare("UPDATE voice_note_segments SET text = ?, usage = ?, cost_usd = ?, error = NULL WHERE note_id = ? AND n = ?").run(t.text.trim(), t.usage ? JSON.stringify(t.usage).slice(0, 2000) : null, cost, id, n);
      retotal(id);
      return { segment: { n, text: t.text.trim(), costUsd: cost }, note: must(id) };
    } catch (e) {
      db.prepare("UPDATE voice_note_segments SET error = ? WHERE note_id = ? AND n = ?").run((e as Error).message.slice(0, 300), id, n);
      retotal(id);
      if (e instanceof VoiceError) throw e;
      throw new VoiceError(502, "transcribe_failed", `the segment was kept but not transcribed: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  /** The chat message: the head (source, time, length, cost, id), the audio link, then his words. */
  function message(n: VoiceNote, words: string, audioUrl: string, parts: number): string {
    const when = `${n.startedAt.slice(0, 10)} ${n.startedAt.slice(11, 16)}Z`;
    return [
      `${VOICE_NOTE_HEAD} (${NOTE_SOURCE}), ${when} · ${clock(n.seconds)} · ${usd(n.costUsd)} (${NOTE_MODEL}) · ${n.id}`,
      `Audio: ${audioUrl}${parts > 1 ? ` (${parts} parts)` : ""}`,
      "",
      words,
    ].join("\n");
  }

  /**
   * Finish: every segment 0..segments-1 must be in and transcribed (the page uploads in order and waits for its queue), then
   * the transcript goes to the chat once (a stable client request id per note, so a retry never posts twice).
   * `fill`: a voice note as an answer on a card. The words go back to the page (it fills the card's text box, the owner
   * edits and presses the card's own button), nothing is posted to the chat; `audio` is the link the answer keeps.
   */
  function finish(id: string, o: { segments: number; page?: string; audioBase: string; skip?: number[]; fill?: boolean }) {
    const had = finishing.get(id);
    if (had) return had;
    const p = finishOnce(id, o).finally(() => finishing.delete(id));
    finishing.set(id, p);
    return p;
  }
  async function finishOnce(id: string, o: { segments: number; page?: string; audioBase: string; skip?: number[]; fill?: boolean }): Promise<{ note: VoiceNote; audio?: string }> {
    const n0 = must(id);
    const audioUrl = `${o.audioBase}/${id}/audio`;
    if (n0.state === "posted") return { note: n0 };
    if (n0.state === "transcribed") return { note: n0, audio: audioUrl };
    if (n0.state !== "recording" && n0.state !== "failed") throw new VoiceError(409, "note_closed", `voice note ${id} is ${n0.state}`);
    const rows = db.prepare("SELECT n, text, error FROM voice_note_segments WHERE note_id = ? ORDER BY n").all(id) as { n: number; text: string | null; error: string | null }[];
    const missing: number[] = [];
    // `skip` are parts the page has no audio for (an empty part, or one lost when the phone closed the page).
    const skip = new Set(o.skip ?? []);
    for (let i = 0; i < o.segments; i++) if (!skip.has(i) && rows.find((r) => r.n === i)?.text == null) missing.push(i);
    if (missing.length) throw new VoiceError(409, "segments_missing", `segments not in yet: ${missing.join(", ")}`);
    const words = rows.filter((r) => r.n < o.segments && r.text != null).map((r) => r.text!.trim()).filter(Boolean).join("\n\n");
    const page = o.page?.trim() || (db.prepare("SELECT page FROM voice_notes WHERE id = ?").get(id) as { page: string | null } | undefined)?.page || undefined;
    if (!words) {
      db.prepare("UPDATE voice_notes SET state = 'empty', finished_at = ? WHERE id = ?").run(iso(), id);
      return { note: must(id) };
    }
    db.prepare("UPDATE voice_notes SET finished_at = COALESCE(finished_at, ?), transcript = ? WHERE id = ?").run(iso(), words.slice(0, 200_000), id);
    const filed = (fill: boolean) => {
      try {
        d.onFiled?.({ id, world, ...(ms ? { milestoneId: ms } : {}), fill, ...(page ? { page } : {}), words, audio: audioUrl });
      } catch (e) {
        console.error("voice note onFiled:", e);
      }
    };
    if (o.fill) {
      db.prepare("UPDATE voice_notes SET state = 'transcribed', post_error = NULL WHERE id = ?").run(id);
      forward(id);
      filed(true);
      return { note: must(id), audio: audioUrl };
    }
    const n = must(id);
    if (!d.desk) throw new VoiceError(503, "desk_unavailable", "this chat has no desk to post the note to");
    try {
      await d.desk.send(message(n, words, audioUrl, o.segments), page, `voice-note-chat-${id}`);
      db.prepare("UPDATE voice_notes SET state = 'posted', posted_at = ?, post_error = NULL WHERE id = ?").run(iso(), id);
    } catch (e) {
      db.prepare("UPDATE voice_notes SET state = 'failed', post_error = ? WHERE id = ?").run((e as Error).message.slice(0, 300), id);
      throw new VoiceError(502, "desk_send_failed", `the chat did not take the note (its transcript is kept; press Send again): ${(e as Error).message.slice(0, 200)}`);
    }
    forward(id);
    filed(false);
    return { note: must(id) };
  }

  /** hand a finished note (posted to the chat, or transcribed for a card) to the memory service outbox; never throws. */
  function forward(id: string) {
    try {
      d.onPosted?.(id);
    } catch (e) {
      console.error("voice note onPosted:", e);
    }
  }

  function discard(id: string) {
    const n = must(id);
    if (n.state === "recording" || n.state === "failed") db.prepare("UPDATE voice_notes SET state = 'discarded', finished_at = ? WHERE id = ?").run(iso(), id);
    return { note: must(id) };
  }

  /** A note's audio: one part (`part`, default 0) as it was recorded. */
  function audio(id: string, part = 0): { file: string; mime: string } {
    must(id);
    const r = segRow(id, part);
    if (!r || !fs.existsSync(r.file)) throw new VoiceError(404, "not_found", `no audio part ${part} for ${id}`);
    return { file: r.file, mime: r.mime };
  }

  function list(limit = 20): VoiceNote[] {
    return (db.prepare("SELECT * FROM voice_notes WHERE tenant_id = @w AND milestone_id IS @m ORDER BY started_at DESC LIMIT @n").all({ ...sc, n: Math.min(200, Math.max(1, limit)) }) as any[]).map(rowTo);
  }

  return { start, segment, finish, discard, audio, list, get };
}
export type VoiceNotes = ReturnType<typeof createVoiceNotes>;

/** The month's voice-note spend of a world (counted in the voice budget with its calls). */
export function notesMonthUsd(db: DB, world: string, since: string): { usd: number; notes: number; seconds: number } {
  ensureVoiceNoteRecTables(db);
  const r = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) usd, COUNT(*) n, COALESCE(SUM(seconds), 0) s FROM voice_notes WHERE started_at >= ? AND tenant_id = ?").get(since, world) as { usd: number; n: number; s: number };
  // customers' voice feedback (voiceFeedback.ts) counts in the same month budget.
  const fb = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feedback_notes'").get()
    ? (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) usd, COUNT(*) n, COALESCE(SUM(seconds), 0) s FROM feedback_notes WHERE started_at >= ? AND world = ?").get(since, world) as { usd: number; n: number; s: number })
    : { usd: 0, n: 0, s: 0 };
  return { usd: r.usd + fb.usd, notes: r.n + fb.n, seconds: r.s + fb.s };
}

const finishIn = z.object({ segments: z.number().int().min(1).max(NOTE_MAX_PARTS), page: z.string().max(200).optional(), skip: z.array(z.number().int().min(0).max(NOTE_MAX_PARTS)).max(NOTE_MAX_PARTS).optional(), fill: z.boolean().optional() });
const startIn = z.object({ page: z.string().max(200).optional(), clientId: z.string().regex(/^[\w-]{8,64}$/).optional() });

/** Where the page reached the console (the link in the chat message opens the audio there). */
function origin(c: Context): string {
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (!host) return "";
  const proto = c.req.header("x-forwarded-proto") ?? (/^(localhost|127\.|100\.)/.test(host) ? "http" : "https");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

/**
 * The note routes under `prefix` (`/voice` for the Team desk, `/milestones/:id/voice` for a milestone or campaign chat):
 * POST notes (start), POST notes/:nid/segments/:n (raw audio body; header x-seconds), POST notes/:nid/finish {segments, page, fill},
 * POST notes/:nid/discard, GET notes (recent), GET notes/:nid/audio?part=n. Recording is the owner's own, from his page.
 */
/**
 * the open form, for a steps page's note box (the owner 2026-11-10: "why don't I have a voice note icon in this very
 * place that I'm typing into"): the token in the path is the credential (`pick` checks it), so there is no list and no
 * audio route, and every finish is `fill` (the words come back to the page, which files them as the step's note; the note
 * still lands in the memory service once). `audioBase`: where the recording's link points (the Team desk's own, the owner's session).
 */
export interface OpenRec {
  audioBase: string;
}

export function mountVoiceNotesRec(api: Hono, prefix: string, pick: (c: Context) => VoiceNotes | Response, open?: OpenRec) {
  const guard = (fn: (c: Context, n: VoiceNotes) => Promise<Response> | Response, jordiOnly = true) => async (c: Context) => {
    try {
      const n = pick(c);
      if (n instanceof Response) return n;
      if (jordiOnly && !open) {
        const why = notJordi((h) => c.req.header(h));
        if (why) return c.json({ error: { code: "jordi_only", message: `only ${ownerName()} records a voice note, from the console page in his browser (${why})` } }, 403);
      }
      return await fn(c, n);
    } catch (e) {
      if (e instanceof VoiceError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
      throw e;
    }
  };
  const bad = (c: Context, m: string) => c.json({ error: { code: "validation_error", message: m } }, 400);
  const json = async (c: Context) => c.req.json().catch(() => ({}));
  const base = (c: Context) => (open ? `${origin(c)}${open.audioBase}` : `${origin(c)}${c.req.path.replace(/\/notes\/.*$/, "")}/notes`);

  if (!open) api.get(`${prefix}/notes`, guard((c, n) => c.json({ notes: n.list(Number(c.req.query("limit")) || 20) }), false));
  api.post(
    `${prefix}/notes`,
    guard(async (c, n) => {
      const p = startIn.safeParse(await json(c));
      if (!p.success) return bad(c, "page (string) and clientId (the browser's id for the note, 8 to 64 letters, digits, - or _) are optional, nothing else");
      return c.json(n.start(p.data.page, p.data.clientId), 201);
    }),
  );
  api.post(
    `${prefix}/notes/:nid/segments/:n`,
    guard(async (c, n) => {
      const buf = new Uint8Array(await c.req.arrayBuffer());
      const r = await n.segment(c.req.param("nid") ?? "", Number(c.req.param("n")), buf, c.req.header("content-type") ?? "", Number(c.req.header("x-seconds")), c.req.header("x-start-ms"));
      return c.json(r);
    }),
  );
  api.post(
    `${prefix}/notes/:nid/finish`,
    guard(async (c, n) => {
      const p = finishIn.safeParse(await json(c));
      if (!p.success) return bad(c, "segments (how many were recorded, 1..100) is required; page (string), skip (part numbers with no audio) and fill (true: the words come back for a card's text box, nothing is posted) are optional");
      return c.json(await n.finish(c.req.param("nid") ?? "", { ...p.data, ...(open ? { fill: true } : {}), audioBase: base(c) }));
    }),
  );
  api.post(`${prefix}/notes/:nid/discard`, guard((c, n) => c.json(n.discard(c.req.param("nid") ?? ""))));
  if (open) return;
  api.get(
    `${prefix}/notes/:nid/audio`,
    guard((c, n) => {
      const a = n.audio(c.req.param("nid") ?? "", Number(c.req.query("part")) || 0);
      const body = fs.readFileSync(a.file);
      return new Response(body, { headers: { "content-type": a.mime.split(";")[0], "content-length": String(body.byteLength), "cache-control": "private, max-age=86400" } });
    }, false),
  );
}
