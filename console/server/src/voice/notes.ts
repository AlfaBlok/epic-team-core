import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "../db.js";
import { VOICE_NOTE_HEAD, pointsBackLine } from "../desk/voiceNotes.js";
import { notJordi } from "../status/mark.js";
import { VoiceError, type DeskPort, type Voice } from "./voice.js";
import { ownerName, sites } from "../identity.js";
import { partModel } from "./transcription.js";

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
/**
 * The cap of one note: the page sends it by itself at this length, everything up to it kept (the owner, 2026-11-12:
 * "allow up to 2 hours, and never stop without telling him"). Parts stay two minutes each, so no upload or transcription
 * grows with the note's length.
 */
export const NOTE_MAX_MIN = 120;
/** The page warns this many minutes before the cap (1 h 50 min into a 2-hour note). */
export const NOTE_WARN_BEFORE_MIN = 10;
/** One segment's upload at most (two minutes of 32 kbit/s opus is about 0.5 MB; AAC from an iPhone about 1-2 MB). */
export const NOTE_SEGMENT_MAX_BYTES = 12 * 1024 * 1024;
/** Page hint of a Chat voice note when he had none: the desk's seed reads the head, not the hint. */
export const NOTE_SOURCE = "Chat";
/**
 * the most parts a note may have. Parts are cut every NOTE_SEGMENT_S and also each time the phone locks or the
 * note picks up again after a lock (so what was said is uploaded at once); the 2-hour cap still bounds the length
 * (60 two-minute parts, the rest room for locks).
 */
export const NOTE_MAX_PARTS = 300;
/** the desk's line for a note no transcriber could turn into words (its audio link follows). */
export const UNHEARD_LINE = "His voice note could not be transcribed (our Whisper and the paid backup both failed)";
/** Context for the next segment: the last words of the previous one (OpenAI's `prompt`). */
const PROMPT_TAIL = 300;

export interface Transcript {
  text: string;
  usage?: unknown;
  /** who turned it into words (`openai`, `gemini`) and with which model; kept on the part. */
  provider?: string;
  model?: string;
}
/** the fallback transcriber (the team's shared Gemini key) when OpenAI fails (429 no credits, 5xx, timeout). */
export const GEMINI_NOTE_MODEL = "gemini-flash-latest";
/** US$ per million tokens (gemini-2.5-flash list prices, checked 2026-11-22): audio in, text in, out (thinking counts as out). */
export const GEMINI_PRICES = { audioIn: 1, textIn: 0.3, out: 2.5 };
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
  // who transcribed the part (`openai`, `gemini`), so the head names it and its cost is read right.
  const segCols = new Set((db.prepare("PRAGMA table_info(voice_note_segments)").all() as { name: string }[]).map((c) => c.name));
  if (!segCols.has("provider")) db.exec("ALTER TABLE voice_note_segments ADD COLUMN provider TEXT");
  // how long the browser took from the press to the note open, the microphone open and recording (JSON, ms), sent
  // with the first part, so a slow start shows which stage held it.
  const cols = new Set((db.prepare("PRAGMA table_info(voice_notes)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("start_ms")) db.exec("ALTER TABLE voice_notes ADD COLUMN start_ms TEXT");
  // the browser's id for the note (its outbox key): a start with the same id opens the same note, never a second.
  if (!cols.has("client_id")) db.exec("ALTER TABLE voice_notes ADD COLUMN client_id TEXT");
  // Sent the moment every part's audio is safe here (accepted_at; what the finish needs kept in accept_json, so
  // a restart or a failed post finishes it by itself), the page's stop-to-Sent time (send_ms, JSON) and the sweeper's tries.
  if (!cols.has("accepted_at")) db.exec("ALTER TABLE voice_notes ADD COLUMN accepted_at TEXT");
  if (!cols.has("accept_json")) db.exec("ALTER TABLE voice_notes ADD COLUMN accept_json TEXT");
  if (!cols.has("send_ms")) db.exec("ALTER TABLE voice_notes ADD COLUMN send_ms TEXT");
  if (!cols.has("finish_tries")) db.exec("ALTER TABLE voice_notes ADD COLUMN finish_tries INTEGER NOT NULL DEFAULT 0");
  // `posted` meant the chat's send answered, even while it was still pending (T3 busy retries running on);
  // a restart then lost it (vn_341120fc, 2026-11-18 03:44Z). delivered_at = the desk's thread took it; post_json = what
  // a re-send needs; deliver_tries / deliver_error = the delivery check's tries. Notes posted before this column are
  // taken as delivered (nothing to check them against).
  if (!cols.has("delivered_at")) {
    db.exec("ALTER TABLE voice_notes ADD COLUMN delivered_at TEXT");
    db.exec("UPDATE voice_notes SET delivered_at = posted_at WHERE state = 'posted'");
  }
  if (!cols.has("post_json")) db.exec("ALTER TABLE voice_notes ADD COLUMN post_json TEXT");
  if (!cols.has("deliver_tries")) db.exec("ALTER TABLE voice_notes ADD COLUMN deliver_tries INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("deliver_error")) db.exec("ALTER TABLE voice_notes ADD COLUMN deliver_error TEXT");
  // the request id a note goes out under, kept for its whole life (`voice-note-chat-<id>`, or `-g<n>` after a
  // checked re-id); and the tries made under it. 22 Nov vn_59852983: a fresh id each minute past 10 tries put 23 copies in.
  if (!cols.has("deliver_gen")) db.exec("ALTER TABLE voice_notes ADD COLUMN deliver_gen INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("gen_tries")) db.exec("ALTER TABLE voice_notes ADD COLUMN gen_tries INTEGER NOT NULL DEFAULT 0");
  // when the owner was told a note (or a part) could not be turned into words by either transcriber (once a note).
  if (!cols.has("unheard_at")) db.exec("ALTER TABLE voice_notes ADD COLUMN unheard_at TEXT");
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
  // our own Whisper on the worker server costs no money (its server time is shown in Settings, Transcription).
  if (u.provider === "local") return 0;
  if (u.provider === "gemini") {
    usd = (num(u.audio_tokens) * GEMINI_PRICES.audioIn + num(u.text_tokens) * GEMINI_PRICES.textIn + num(u.output_tokens) * GEMINI_PRICES.out) / 1_000_000;
    if (!usd) usd = (Math.max(0, seconds) * 32 * GEMINI_PRICES.audioIn) / 1_000_000; // 32 audio tokens a second
  } else if (u.type === "tokens" && (num(u.input_tokens) || num(u.output_tokens))) {
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
    return { text: j.text, provider: "openai", model: NOTE_MODEL, ...(j.usage ? { usage: j.usage } : {}) };
  };
}

/**
 * Gemini as a transcriber (generateContent with the audio inline), the team's shared GEMINI_API_KEY read
 * from the console's key store. Its usage comes back as `{provider: "gemini", audio_tokens, text_tokens, output_tokens}`.
 */
export function geminiTranscriber(key: () => Promise<string | undefined>, model = GEMINI_NOTE_MODEL, f: typeof fetch = fetch): Transcriber {
  return async (audio, o) => {
    const k = await key();
    if (!k) throw new VoiceError(503, "no_key", "the console has no GEMINI_API_KEY (secret store agent-team-console/GEMINI_API_KEY)");
    const ask = [
      "Transcribe this voice note word for word, in the language spoken. Output only the transcript: no title, no notes, no timestamps, no speaker labels.",
      "If nothing is said, output nothing.",
      ...(o.prompt ? [`The words just before this part were: "${o.prompt}"`] : []),
    ].join(" ");
    const body = { contents: [{ parts: [{ text: ask }, { inline_data: { mime_type: o.mime, data: Buffer.from(audio).toString("base64") } }] }], generationConfig: { temperature: 0 } };
    const r = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": k },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    const parts = j?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("").trim() : undefined;
    if (!r.ok || text === undefined) throw new VoiceError(502, "gemini_refused", `Gemini did not transcribe the note (${r.status}): ${String(j?.error?.message ?? j?.candidates?.[0]?.finishReason ?? "no message").slice(0, 200)}`);
    const m = j.usageMetadata ?? {};
    const det = (Array.isArray(m.promptTokensDetails) ? m.promptTokensDetails : []) as { modality?: string; tokenCount?: number }[];
    const of = (mod: string) => det.filter((x) => x.modality === mod).reduce((a, x) => a + (x.tokenCount ?? 0), 0);
    const usage = { provider: "gemini", model, audio_tokens: of("AUDIO"), text_tokens: of("TEXT"), output_tokens: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0) };
    return { text, provider: "gemini", model, usage };
  };
}

/**
 * OpenAI first; when it fails (429 no credits, a 5xx, a timeout, no key) the same part goes to the backup.
 * Both failing is one error naming both, so the part is named unheard and the owner is told.
 */
export function fallbackTranscriber(primary: Transcriber, backup: Transcriber, log: (m: string) => void = (m) => console.warn(m)): Transcriber {
  return async (audio, o) => {
    try {
      return await primary(audio, o);
    } catch (e1) {
      log(`[voice] ${o.filename}: ${(e1 as Error).message.slice(0, 200)}; trying the backup transcriber`);
      try {
        return await backup(audio, o);
      } catch (e2) {
        throw new VoiceError(502, "transcribe_failed", `${(e1 as Error).message.slice(0, 150)} | ${(e2 as Error).message.slice(0, 150)}`);
      }
    }
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
  /** every part's audio was safe on the console at this time: the page showed Sent; words and post follow by themselves. */
  acceptedAt?: string;
  /** tap stop to Sent on the page (`sent`), and to his words in the chat (`words`), ms. */
  sendMs?: Record<string, number>;
  /** the chat's thread took the note (a send that answered `pending` is posted, not yet delivered). */
  deliveredAt?: string;
  /** posted but not in the chat after DELIVER_CHECK_MS: `retrying` (re-sent each minute) or `failed` (tries used up). */
  delivery?: "retrying" | "failed";
  deliverError?: string;
}

/** tap stop to Sent over this is slow: an alert (the owner: "why is it so slow to send"). */
export const SEND_SLOW_MS = 3000;
/** an accepted note not posted after this long is stuck: the sweeper retries it each minute and it is an alert. */
export const SEND_STUCK_MS = 3 * 60_000;
/** the sweeper's most tries of one accepted note (one a minute). */
const FINISH_TRIES = 30;
/** a posted note not seen in the chat this long after its post is re-sent (one try a minute). */
export const DELIVER_CHECK_MS = 2 * 60_000;
/** after this many tries the Delivery Manager is told the note is stuck; the console keeps re-sending it (never gives his words up) for the whole window (22 Nov: two notes were dropped as "failed" after 10 min while T3 was slow). */
export const DELIVER_TRIES = 10;
/** notes older than this are not checked again (a note that old in the chat's tail cannot be told from one missing). */
export const DELIVER_WINDOW_MS = 6 * 3600_000;
/** a note or message he sent that the desk's chat still lacks this long after: /api/health `voiceSend` alerts. */
export const UNDELIVERED_ALERT_MS = 10 * 60_000;
export const NOT_DELIVERED_RETRYING = "not delivered yet, retrying";
/**
 * Exactly once: a note's request id never changes while it may still be in flight. T3 and the console's held
 * sends both drop a repeat of an id they hold, so a re-send under the same id adds no copy, however long T3 is down or
 * slow. Only a note proved absent (`seen` = false: a fresh read of the thread, T3's queue listed, nothing held) after
 * REID_AFTER sends under one id gets a new id (one generation more), and is checked again just before that send.
 */
export const REID_AFTER = 30;
/** the one request id of a note at generation `gen`. */
export const noteRequestId = (id: string, gen = 0) => (gen > 0 ? `voice-note-chat-${id}-g${gen}` : `voice-note-chat-${id}`);

export interface NoteStart {
  note: VoiceNote;
  segmentS: number;
  maxMin: number;
  warnMin: number;
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
  /** a note took over SEND_SLOW_MS from tap stop to Sent, or an accepted note is still not posted (alert). */
  onSlow?: (s: { id: string; world: string; kind: "slow" | "stuck"; ms: number; parts?: Record<string, number> }) => void;
  /**
   * is the note in its chat's thread now (its head line carries the note id)? undefined = cannot tell. A
   * posted note it does not find DELIVER_CHECK_MS after the post is re-sent.
   */
  /**
   * true: in the chat; "queued": waiting to go in (never re-sent then); false: proved absent (a fresh thread read, T3's
   * queue listed, nothing held), the only answer that may give a note a new request id; undefined: cannot tell now.
   */
  seen?: (id: string) => Promise<boolean | "queued" | undefined>;
  /** a posted note was not in the chat at its check (first miss), or its tries ran out (`gaveUp`); never awaited. */
  /** parts of a note neither transcriber turned into words (once a note): the owner's WhatsApp alert. */
  onUnheard?: (u: { id: string; world: string; milestoneId?: string; parts: number[]; of: number; audio: string; page?: string; error?: string }) => void;
  onUndelivered?: (u: { id: string; world: string; milestoneId?: string; tries: number; ms: number; gaveUp: boolean; postedAt: string; words: string }) => void;
}

const clock = (s: number) => `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
const usd = (v: number) => `$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`;

/** one finish per note at a time (the tab and its outbox may both send it): a second waits for the first's answer. */
const finishing = new Map<string, Promise<{ note: VoiceNote; audio?: string }>>();
/** parts being turned into words after their audio was stored and answered (`<note>:<n>`). */
const inflight = new Map<string, Promise<unknown>>();

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
      ...(r.accepted_at ? { acceptedAt: r.accepted_at } : {}),
      ...(r.send_ms ? { sendMs: JSON.parse(r.send_ms) as Record<string, number> } : {}),
      ...(r.delivered_at ? { deliveredAt: r.delivered_at } : {}),
      ...(r.state === "posted" && !r.delivered_at && r.deliver_tries > 0 ? { delivery: "retrying" as const } : {}),
      ...(r.deliver_error ? { deliverError: r.deliver_error } : {}),
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
      if (had) return { note: must(had.id), segmentS: NOTE_SEGMENT_S, maxMin: NOTE_MAX_MIN, warnMin: NOTE_MAX_MIN - NOTE_WARN_BEFORE_MIN, usdPerMin: NOTE_USD_PER_MIN, model: NOTE_MODEL, ...budget() };
    }
    if (!d.voice.enabled()) throw new VoiceError(409, "voice_off", `${d.voice.state().reason ?? "Voice is switched off in the console."} Type instead.`);
    const b = budget();
    if (b.monthUsd >= b.monthCapUsd) throw new VoiceError(409, "month_cap", `Voice is paused until the 1st: this month reached its ${usd(b.monthCapUsd)} cap. Type instead.`);
    if (!d.desk) throw new VoiceError(503, "desk_unavailable", "this chat has no desk to post the note to");
    const id = `vn_${crypto.randomBytes(4).toString("hex")}`;
    db.prepare("INSERT INTO voice_notes (id, tenant_id, milestone_id, started_at, state, page, client_id) VALUES (?, ?, ?, ?, 'recording', ?, ?)").run(id, world, ms, iso(), page?.slice(0, 200) ?? null, clientId ?? null);
    return { note: must(id), segmentS: NOTE_SEGMENT_S, maxMin: NOTE_MAX_MIN, warnMin: NOTE_MAX_MIN - NOTE_WARN_BEFORE_MIN, usdPerMin: NOTE_USD_PER_MIN, model: NOTE_MODEL, ...b };
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
  /**
   * the part being recorded goes up while he talks (`<n>.early` beside its parts, appended at `offset`; a resend
   * from an earlier offset rewrites from there), so at stop only its last seconds are left to send.
   */
  function early(id: string, n: number, offset: number, bytes: Uint8Array, mime: string): { have: number } {
    recording(id);
    if (!Number.isInteger(n) || n < 0 || n >= NOTE_MAX_PARTS) throw new VoiceError(400, "validation_error", `segment number ${n} is out of range`);
    if (!audioExt(mime)) throw new VoiceError(400, "validation_error", `not audio this console takes: ${mime.slice(0, 60)}`);
    if (segRow(id, n)) throw new VoiceError(409, "segment_in", `part ${n} is already in`);
    const folder = path.join(d.dir, id);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${n}.early`);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > size) throw new VoiceError(409, "early_gap", `the console has ${size} bytes of part ${n}, not ${offset}`);
    if (offset + bytes.byteLength > NOTE_SEGMENT_MAX_BYTES) throw new VoiceError(400, "too_big", `a segment is at most ${NOTE_SEGMENT_MAX_BYTES / 1024 / 1024} MB`);
    if (offset < size) fs.truncateSync(file, offset);
    fs.appendFileSync(file, bytes);
    return { have: offset + bytes.byteLength };
  }

  async function segment(id: string, n: number, audio: Uint8Array, mime: string, seconds: number, startMs?: string, quick = false, earlyBytes = 0) {
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
    // the part's start went up while he talked: this request carries only its tail.
    const earlyFile = path.join(d.dir, id, `${n}.early`);
    if (earlyBytes > 0) {
      const size = fs.existsSync(earlyFile) ? fs.statSync(earlyFile).size : 0;
      if (!Number.isInteger(earlyBytes) || size < earlyBytes) throw new VoiceError(409, "early_missing", `the console has ${size} bytes of part ${n}, not ${earlyBytes}: send the whole part`);
      const head = new Uint8Array(earlyBytes);
      const fd = fs.openSync(earlyFile, "r");
      try {
        fs.readSync(fd, head, 0, earlyBytes, 0);
      } finally {
        fs.closeSync(fd);
      }
      const all = new Uint8Array(earlyBytes + audio.byteLength);
      all.set(head, 0);
      all.set(audio, earlyBytes);
      audio = all;
    }
    if (!audio.byteLength) throw new VoiceError(400, "validation_error", "the segment is empty");
    if (audio.byteLength > NOTE_SEGMENT_MAX_BYTES) throw new VoiceError(400, "too_big", `a segment is at most ${NOTE_SEGMENT_MAX_BYTES / 1024 / 1024} MB`);
    const done = segRow(id, n);
    if (done?.text != null) return { segment: { n, text: done.text as string, costUsd: done.cost_usd as number }, note: must(id) };
    const sec = Math.max(0, Math.min(NOTE_SEGMENT_S * 2, Number.isFinite(seconds) ? seconds : 0));
    const sofar = (db.prepare("SELECT COALESCE(SUM(seconds), 0) s FROM voice_note_segments WHERE note_id = ? AND n != ?").get(id, n) as { s: number }).s;
    // the part that crosses the line is still kept (the page stops at the cap, a late tick may overshoot by a part).
    if (sofar + sec > NOTE_MAX_MIN * 60 + NOTE_SEGMENT_S) throw new VoiceError(409, "note_cap", `a voice note is at most ${NOTE_MAX_MIN / 60} hours`);
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
    fs.rmSync(earlyFile, { force: true });
    // `quick`: the audio is safe on disk and in its row, so the page hears so now; its words come in the
    // background (finish waits for them), never holding the upload, and so Sent, for the seconds OpenAI takes.
    if (quick) {
      retotal(id);
      const key = `${id}:${n}`;
      const p = transcribePart(id, n, audio, mime, sec)
        .catch(() => undefined)
        .finally(() => inflight.get(key) === p && inflight.delete(key));
      inflight.set(key, p);
      return { segment: { n, stored: true, costUsd: 0 }, note: must(id) };
    }
    try {
      const text = await transcribePart(id, n, audio, mime, sec);
      return { segment: { n, text, costUsd: segRow(id, n)?.cost_usd as number }, note: must(id) };
    } catch (e) {
      if (e instanceof VoiceError) throw e;
      throw new VoiceError(502, "transcribe_failed", `the segment was kept but not transcribed: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  /** Transcribe one kept part (its audio already on disk and in its row); its words and cost go into the row. */
  async function transcribePart(id: string, n: number, audio: Uint8Array, mime: string, sec: number): Promise<string> {
    const prev = n > 0 ? (segRow(id, n - 1)?.text as string | undefined) : undefined;
    try {
      const t = await d.transcribe(audio, { mime: mime.split(";")[0], filename: `${id}-${n}.${audioExt(mime) ?? "webm"}`, ...(prev ? { prompt: prev.slice(-PROMPT_TAIL) } : {}) });
      const cost = noteCost(t.usage, sec);
      db.prepare("UPDATE voice_note_segments SET text = ?, usage = ?, cost_usd = ?, provider = ?, error = NULL WHERE note_id = ? AND n = ?").run(t.text.trim(), t.usage ? JSON.stringify(t.usage).slice(0, 2000) : null, cost, t.provider ?? "openai", id, n);
      retotal(id);
      return t.text.trim();
    } catch (e) {
      db.prepare("UPDATE voice_note_segments SET error = ? WHERE note_id = ? AND n = ?").run((e as Error).message.slice(0, 300) || "failed", id, n);
      retotal(id);
      throw e;
    }
  }

  /**
   * The note's words, part by part. A part neither transcriber could turn into words is one line with its audio link
   * (never an empty arrival); every part unheard is one line for the whole note.
   */
  function wordsOf(rows: { n: number; text: string | null; seconds: number }[], segments: number, unheard: Set<number>, audioUrl: string): string {
    const parts = rows.filter((r) => r.n < segments);
    if (parts.length && parts.every((r) => unheard.has(r.n))) return `${UNHEARD_LINE}; audio: ${audioUrl}${parts.length > 1 ? ` (${parts.length} parts: ${parts.map((r) => `${audioUrl}?part=${r.n}`).join(" , ")})` : ""}`;
    let at = 0;
    const said: string[] = [];
    for (const r of parts) {
      if (unheard.has(r.n)) said.push(`[Part ${r.n + 1}, from ${clock(at)}, could not be turned into words. Its audio is kept: ${audioUrl}?part=${r.n}]`);
      else if (r.text?.trim()) said.push(r.text.trim());
      at += r.seconds;
    }
    return said.join("\n\n");
  }

  /** the owner hears once per note that some of it could not be turned into words (one WhatsApp, outside the alert caps). */
  function tellUnheard(id: string, parts: number[], of: number, audioUrl: string, page?: string) {
    const r = db.prepare("UPDATE voice_notes SET unheard_at = ? WHERE id = ? AND unheard_at IS NULL").run(iso(), id);
    if (!r.changes) return;
    const errs = (db.prepare("SELECT error FROM voice_note_segments WHERE note_id = ? AND text IS NULL AND error IS NOT NULL ORDER BY n").all(id) as { error: string }[]).map((x) => x.error);
    try {
      d.onUnheard?.({ id, world, ...(ms ? { milestoneId: ms } : {}), parts, of, audio: audioUrl, ...(page ? { page } : {}), ...(errs[0] ? { error: errs[0] } : {}) });
    } catch (e) {
      console.error("voice note onUnheard:", e);
    }
  }

  /** The chat message: the head (source, time, length, cost, id), the audio link, then his words. */
  function message(n: VoiceNote, words: string, audioUrl: string, parts: number): string {
    const when = `${n.startedAt.slice(0, 10)} ${n.startedAt.slice(11, 16)}Z`;
    const back = pointsBackLine(words);
    // who turned it into words: the model of each part (OpenAI's, or Gemini's when OpenAI failed)
    const used = [...new Set((db.prepare("SELECT provider, usage FROM voice_note_segments WHERE note_id = ? AND text IS NOT NULL ORDER BY n").all(n.id) as { provider: string | null; usage: string | null }[]).map((r) => partModel(r.provider, r.usage)))];
    return [
      `${VOICE_NOTE_HEAD} (${NOTE_SOURCE}), ${when} · ${clock(n.seconds)} · ${usd(n.costUsd)} (${used.length ? used.join(" + ") : NOTE_MODEL}) · ${n.id}`,
      ...(back ? [back] : []),
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
    // parts still being turned into words (quick uploads) are waited for, then read.
    await Promise.all([...inflight].filter(([k]) => k.startsWith(`${id}:`)).map(([, p]) => p));
    const rows = db.prepare("SELECT n, text, error, file, mime, seconds FROM voice_note_segments WHERE note_id = ? ORDER BY n").all(id) as { n: number; text: string | null; error: string | null; file: string; mime: string; seconds: number }[];
    // a part whose audio is in but whose words failed gets one more try now; one that still fails is named in the
    // note with its audio link, so the rest of what he said is never held back by it.
    const unheard = new Set<number>();
    for (const r of rows) {
      // (no words and no error: its background transcription was cut by a restart; tried now the same way.)
      if (r.n >= o.segments || r.text != null || !fs.existsSync(r.file)) continue;
      const t = await transcribePart(id, r.n, new Uint8Array(fs.readFileSync(r.file)), r.mime, r.seconds).catch(() => undefined);
      if (t != null) r.text = t;
      else unheard.add(r.n);
    }
    const missing: number[] = [];
    // `skip` are parts the page has no audio for (an empty part, or one lost when the phone closed the page).
    const skip = new Set(o.skip ?? []);
    for (let i = 0; i < o.segments; i++) if (!skip.has(i) && !unheard.has(i) && rows.find((r) => r.n === i)?.text == null) missing.push(i);
    if (missing.length) throw new VoiceError(409, "segments_missing", `segments not in yet: ${missing.join(", ")}`);
    const words = wordsOf(rows, o.segments, unheard, audioUrl);
    const page = o.page?.trim() || (db.prepare("SELECT page FROM voice_notes WHERE id = ?").get(id) as { page: string | null } | undefined)?.page || undefined;
    if (unheard.size) tellUnheard(id, [...unheard], rows.filter((r) => r.n < o.segments && !skip.has(r.n)).length, audioUrl, page);
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
      db.prepare("UPDATE voice_notes SET post_json = ? WHERE id = ?").run(JSON.stringify({ audioUrl, segments: o.segments, ...(page ? { page } : {}) }), id);
      const r = await d.desk.send(message(n, words, audioUrl, o.segments), page, noteRequestId(id));
      // only a send T3 took is delivered; a pending or queued one is checked in the chat after DELIVER_CHECK_MS.
      const at = iso();
      db.prepare("UPDATE voice_notes SET state = 'posted', posted_at = ?, post_error = NULL, delivered_at = ? WHERE id = ?").run(at, r && r.pending === false ? at : null, id);
    } catch (e) {
      db.prepare("UPDATE voice_notes SET state = 'failed', post_error = ? WHERE id = ?").run((e as Error).message.slice(0, 300), id);
      throw new VoiceError(502, "desk_send_failed", `the chat did not take the note (its transcript is kept; press Send again): ${(e as Error).message.slice(0, 200)}`);
    }
    forward(id);
    filed(false);
    return { note: must(id) };
  }

  /**
   * a note that went out (or was filed on a card) with parts no transcriber heard is heard again: its kept
   * audio goes to the transcriber once more (OpenAI, then the backup), and when every part now has words the note is
   * posted to its chat as his message once more, under its next request id (the first copy, with no words, already
   * holds the first one, so T3 would drop a same-id copy). `force`: re-post even when no part was unheard.
   */
  async function redo(id: string, o: { audioBase: string; force?: boolean }): Promise<{ note: VoiceNote; heard: number[]; still: number[]; reposted: boolean }> {
    const n0 = must(id);
    if (n0.state === "recording" || n0.state === "discarded") throw new VoiceError(409, "note_open", `voice note ${id} is ${n0.state}; it finishes by itself`);
    const row = db.prepare("SELECT * FROM voice_notes WHERE id = ?").get(id) as any;
    const prev = row.post_json ? (JSON.parse(row.post_json) as { audioUrl: string; segments: number; page?: string }) : undefined;
    const acc = row.accept_json ? (JSON.parse(row.accept_json) as { segments: number; skip?: number[]; audioBase?: string }) : undefined;
    // the link the note went out with (his public one), never the address this redo was called on
    const audioUrl = prev?.audioUrl ?? `${acc?.audioBase ?? o.audioBase}/${id}/audio`;
    const rows = db.prepare("SELECT n, text, error, file, mime, seconds FROM voice_note_segments WHERE note_id = ? ORDER BY n").all(id) as { n: number; text: string | null; error: string | null; file: string; mime: string; seconds: number }[];
    const segments = prev?.segments ?? acc?.segments ?? (rows.length ? Math.max(...rows.map((r) => r.n)) + 1 : 0);
    const heard: number[] = [];
    const still = new Set<number>();
    for (const r of rows) {
      if (r.n >= segments || r.text != null) continue;
      if (!fs.existsSync(r.file)) {
        still.add(r.n);
        continue;
      }
      const t = await transcribePart(id, r.n, new Uint8Array(fs.readFileSync(r.file)), r.mime, r.seconds).catch(() => undefined);
      if (t != null) {
        r.text = t;
        heard.push(r.n);
      } else still.add(r.n);
    }
    if (!heard.length && !o.force) return { note: must(id), heard, still: [...still], reposted: false };
    if (still.size && !o.force) return { note: must(id), heard, still: [...still], reposted: false };
    const words = wordsOf(rows, segments, still, audioUrl);
    if (!words) return { note: must(id), heard, still: [...still], reposted: false };
    if (!d.desk) throw new VoiceError(503, "desk_unavailable", "this chat has no desk to post the note to");
    const page = prev?.page ?? (row.page as string | null) ?? undefined;
    const gen = (row.deliver_gen as number) + 1;
    db.prepare("UPDATE voice_notes SET transcript = ?, finished_at = COALESCE(finished_at, ?), post_json = ?, deliver_gen = ?, gen_tries = 0, deliver_tries = 0, deliver_error = NULL WHERE id = ?").run(
      words.slice(0, 200_000),
      iso(),
      JSON.stringify({ audioUrl, segments, ...(page ? { page } : {}) }),
      gen,
      id,
    );
    const n = must(id);
    const s = await d.desk.send(message(n, words, audioUrl, segments), page, noteRequestId(id, gen));
    const at = iso();
    db.prepare("UPDATE voice_notes SET state = 'posted', posted_at = ?, post_error = NULL, delivered_at = ? WHERE id = ?").run(at, s && s.pending === false ? at : null, id);
    forward(id);
    console.log(`[voice] ${id}: heard again (parts ${heard.map((x) => x + 1).join(", ") || "none"}), re-posted under ${noteRequestId(id, gen)}`);
    return { note: must(id), heard, still: [...still], reposted: true };
  }

  /**
   * Sent as soon as his audio is safe. Every part 0..segments-1 (bar `skip`) must be stored here; then the
   * note is accepted (what the finish needs is kept with it) and its words and post run in the background: the page
   * shows Sent now, not after OpenAI and the chat. A finish that fails or a restart is picked up by `resume`.
   */
  function accept(id: string, o: { segments: number; page?: string; audioBase: string; skip?: number[] }): { note: VoiceNote; accepted: true } {
    const n0 = must(id);
    if (n0.state === "posted") return { note: n0, accepted: true };
    if (n0.state !== "recording" && n0.state !== "failed") throw new VoiceError(409, "note_closed", `voice note ${id} is ${n0.state}`);
    const have = new Set((db.prepare("SELECT n, file FROM voice_note_segments WHERE note_id = ?").all(id) as { n: number; file: string }[]).filter((r) => fs.existsSync(r.file)).map((r) => r.n));
    const skip = new Set(o.skip ?? []);
    const missing: number[] = [];
    for (let i = 0; i < o.segments; i++) if (!skip.has(i) && !have.has(i)) missing.push(i);
    if (missing.length) throw new VoiceError(409, "segments_missing", `segments not in yet: ${missing.join(", ")}`);
    db.prepare("UPDATE voice_notes SET accepted_at = COALESCE(accepted_at, ?), accept_json = ? WHERE id = ?").run(iso(), JSON.stringify({ segments: o.segments, page: o.page, audioBase: o.audioBase, skip: o.skip }), id);
    void finish(id, o).catch((e) => console.error(`voice note ${id}: accepted, its post waits for the sweeper:`, (e as Error).message));
    return { note: must(id), accepted: true };
  }

  /** accepted notes not posted yet (a failed post, a restart) are finished again, one try a minute each. */
  async function resume(o: { minAgeMs?: number } = {}): Promise<number> {
    const cut = iso(now() - (o.minAgeMs ?? 20_000));
    const rows = db
      .prepare("SELECT id, accepted_at, accept_json, finish_tries FROM voice_notes WHERE tenant_id = @w AND milestone_id IS @m AND accepted_at IS NOT NULL AND accepted_at <= @cut AND state IN ('recording', 'failed') AND finish_tries < @max")
      .all({ ...sc, cut, max: FINISH_TRIES }) as { id: string; accepted_at: string; accept_json: string; finish_tries: number }[];
    let n = 0;
    for (const r of rows) {
      if (finishing.has(r.id)) continue;
      db.prepare("UPDATE voice_notes SET finish_tries = finish_tries + 1 WHERE id = ?").run(r.id);
      const age = now() - Date.parse(r.accepted_at);
      if (age >= SEND_STUCK_MS) d.onSlow?.({ id: r.id, world, kind: "stuck", ms: age });
      n++;
      await finish(r.id, JSON.parse(r.accept_json)).catch((e) => console.error(`voice note ${r.id}: retry ${r.finish_tries + 1} failed:`, (e as Error).message));
    }
    return n;
  }

  /** one delivery check per note at a time. */
  const delivering = new Set<string>();
  /**
   * every posted note not delivered yet, DELIVER_CHECK_MS after its post: in the chat (`seen`) = delivered;
   * else re-sent under its one request id (T3 and the held sends drop a copy they already hold) and named: the chat shows
   * NOT_DELIVERED_RETRYING on it, the first miss and the last try go to `onUndelivered` (the Delivery Manager's line).
   */
  async function deliverCheck(only?: string): Promise<{ checked: number; delivered: number; resent: number; failed: number }> {
    const out = { checked: 0, delivered: 0, resent: 0, failed: 0 };
    const t = now();
    // `only`: his Send again on one note in the chat, at once (no 2-minute wait), within the same window.
    const rows = db
      .prepare(
        `SELECT * FROM voice_notes WHERE tenant_id = @w AND milestone_id IS @m AND state = 'posted' AND delivered_at IS NULL AND post_json IS NOT NULL AND posted_at >= @since ${only ? "AND id = @only" : "AND posted_at <= @cut"} ORDER BY posted_at`,
      )
      .all({ ...sc, since: iso(t - DELIVER_WINDOW_MS), ...(only ? { only } : { cut: iso(t - DELIVER_CHECK_MS) }) }) as any[];
    for (const r of rows) {
      if (delivering.has(r.id)) continue;
      delivering.add(r.id);
      out.checked++;
      try {
        const there = d.seen ? await d.seen(r.id).catch(() => undefined) : undefined;
        if (there === "queued") continue; // it waits to go in: a re-send would only add a copy
        if (there) {
          db.prepare("UPDATE voice_notes SET delivered_at = ?, deliver_error = NULL WHERE id = ?").run(iso(), r.id);
          out.delivered++;
          continue;
        }
        const tries = r.deliver_tries + 1;
        const n = rowTo(r);
        const post = JSON.parse(r.post_json) as { audioUrl: string; segments: number; page?: string };
        let error: string = NOT_DELIVERED_RETRYING;
        let took = false;
        // the same request id every try: a copy T3 or the console already holds is dropped, never doubled.
        // A new id only when the note is proved absent (`there === false`, read just now) after REID_AFTER tries under this one.
        let gen = r.deliver_gen as number;
        let genTries = (r.gen_tries as number) + 1;
        if (there === false && genTries > REID_AFTER) {
          gen++;
          genTries = 1;
          console.warn(`[voice] ${r.id}: not in the desk thread, its queue or the held sends after ${REID_AFTER} tries under one id; sent once under ${noteRequestId(r.id, gen)}`);
        }
        db.prepare("UPDATE voice_notes SET deliver_gen = ?, gen_tries = ? WHERE id = ?").run(gen, genTries, r.id);
        try {
          const s = await d.desk!.send(message(n, r.transcript ?? "", post.audioUrl, post.segments), post.page, noteRequestId(r.id, gen));
          took = !!s && s.pending === false;
          // the reason the chat shows on the note (a stuck note says why, never only "retrying")
          if (!took) error = `${NOT_DELIVERED_RETRYING} (${(s as { queued?: boolean } | undefined)?.queued ? "T3 is down: the console holds it and sends it once T3 is back" : "T3 is busy and has not taken it yet"})`;
        } catch (e) {
          error = `${NOT_DELIVERED_RETRYING} (${(e as Error).message.slice(0, 200)})`;
        }
        out.resent++;
        // at DELIVER_TRIES the Delivery Manager hears it is stuck (once); the re-sends go on
        const gaveUp = !took && tries === DELIVER_TRIES;
        if (gaveUp) out.failed++;
        // a re-send T3 took is delivered unless the chat still lacks it at the next check
        db.prepare("UPDATE voice_notes SET deliver_tries = ?, deliver_error = ?, delivered_at = ? WHERE id = ?").run(tries, took ? null : error, took ? iso() : null, r.id);
        if (took) out.delivered++;
        if (tries === 1 || gaveUp)
          try {
            d.onUndelivered?.({ id: r.id, world, ...(ms ? { milestoneId: ms } : {}), tries, ms: t - Date.parse(r.posted_at), gaveUp, postedAt: r.posted_at, words: r.transcript ?? "" });
          } catch (e) {
            console.error("voice note onUndelivered:", e);
          }
      } finally {
        delivering.delete(r.id);
      }
    }
    return out;
  }

  /**
   * his Send again on a note the chat shows not delivered ("screenshots and images i paste but dont seem to be
   * sent"): one check and re-send now, under the note's one request id (a copy T3 already holds is dropped, never doubled).
   */
  async function redeliver(id: string): Promise<{ note: VoiceNote; delivered: boolean }> {
    const n = must(id);
    if (n.state !== "posted") throw new VoiceError(409, "not_posted", `voice note ${id} is ${n.state}: nothing to send again`);
    if (n.deliveredAt) return { note: n, delivered: true };
    await deliverCheck(id);
    const after = must(id);
    return { note: after, delivered: !!after.deliveredAt };
  }

  /** posted notes the chat does not hold yet (retrying, or failed in the last day): the chat shows each plainly. */
  function undelivered(): VoiceNote[] {
    return (
      db
        .prepare("SELECT * FROM voice_notes WHERE tenant_id = @w AND milestone_id IS @m AND state = 'posted' AND delivered_at IS NULL AND deliver_tries > 0 AND posted_at >= @since ORDER BY posted_at")
        .all({ ...sc, since: iso(now() - 24 * 3600_000) }) as any[]
    ).map(rowTo);
  }

  /** the page's tap stop to Sent (ms); a slow one is an alert. Words: Sent plus the console's accept to post. */
  function timing(id: string, sentMs: number, parts: Partial<Record<(typeof SEND_PARTS)[number], number>> = {}) {
    const n = must(id);
    if (!Number.isFinite(sentMs) || sentMs < 0 || sentMs > 3_600_000) throw new VoiceError(400, "validation_error", "sentMs is the ms from tap stop to Sent");
    const had = n.sendMs ?? {};
    if (had.sent === undefined) {
      // where the time went on the page, so a slow one names its step: the recorder's stop, a part still going up, the last upload
      const p: Record<string, number> = {};
      for (const k of SEND_PARTS) {
        const v = parts[k];
        if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9) p[k] = Math.round(v);
      }
      db.prepare("UPDATE voice_notes SET send_ms = ? WHERE id = ?").run(JSON.stringify({ ...had, sent: Math.round(sentMs), ...p }), id);
      if (sentMs > SEND_SLOW_MS) d.onSlow?.({ id, world, kind: "slow", ms: Math.round(sentMs), ...(Object.keys(p).length ? { parts: p } : {}) });
    }
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

  return { start, early, segment, finish, accept, redo, resume, deliverCheck, redeliver, undelivered, timing, discard, audio, list, get };
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

const finishIn = z.object({ segments: z.number().int().min(1).max(NOTE_MAX_PARTS), page: z.string().max(200).optional(), skip: z.array(z.number().int().min(0).max(NOTE_MAX_PARTS)).max(NOTE_MAX_PARTS).optional(), fill: z.boolean().optional(), quick: z.boolean().optional() });
/** the steps of tap stop to Sent the page reports (ms, and the bytes of the last upload). */
export const SEND_PARTS = ["stopMs", "earlyWaitMs", "uploadMs", "tailBytes", "earlyBytes"] as const;
const timingIn = z.object({ sentMs: z.number().min(0).max(3_600_000), parts: z.record(z.string(), z.number()).optional() });
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
      const nid = c.req.param("nid") ?? "";
      const r = await n.segment(nid, Number(c.req.param("n")), buf, c.req.header("content-type") ?? "", Number(c.req.header("x-seconds")), c.req.header("x-start-ms"), c.req.header("x-quick") === "1", Number(c.req.header("x-early-bytes")) || 0);
      // the last part of a chat note asks for Sent in the same request (`x-accept`: segments, skip, page), saving a round trip.
      const acc = c.req.header("x-accept");
      if (acc && !open) {
        let a: unknown;
        try {
          a = JSON.parse(acc);
        } catch {
          return bad(c, "x-accept is JSON: segments, skip and page");
        }
        const p = finishIn.safeParse(a);
        if (!p.success || p.data.fill) return bad(c, "x-accept is JSON: segments (1..300), skip and page");
        const { quick: _q, fill: _f, ...o } = p.data;
        return c.json({ ...r, ...n.accept(nid, { ...o, audioBase: base(c) }) });
      }
      return c.json(r);
    }),
  );
  api.post(
    `${prefix}/notes/:nid/finish`,
    guard(async (c, n) => {
      const p = finishIn.safeParse(await json(c));
      if (!p.success) return bad(c, "segments (how many were recorded, 1..300) is required; page (string), skip (part numbers with no audio) and fill (true: the words come back for a card's text box, nothing is posted) are optional");
      const { quick, ...o } = p.data;
      const fill = open ? true : o.fill;
      // a chat note (not a card's answer, whose words must come back) is Sent once its audio is safe here.
      if (quick && !fill) return c.json(n.accept(c.req.param("nid") ?? "", { ...o, audioBase: base(c) }));
      return c.json(await n.finish(c.req.param("nid") ?? "", { ...o, ...(fill ? { fill: true } : {}), audioBase: base(c) }));
    }),
  );
  api.post(
    `${prefix}/notes/:nid/timing`,
    guard(async (c, n) => {
      const p = timingIn.safeParse(await json(c));
      if (!p.success) return bad(c, "sentMs (ms from tap stop to Sent) is required");
      return c.json(n.timing(c.req.param("nid") ?? "", p.data.sentMs, p.data.parts ?? {}));
    }),
  );
  api.post(
    `${prefix}/notes/:nid/segments/:n/early`,
    guard(async (c, n) => {
      const buf = new Uint8Array(await c.req.arrayBuffer());
      return c.json(n.early(c.req.param("nid") ?? "", Number(c.req.param("n")), Number(c.req.header("x-offset")), buf, c.req.header("content-type") ?? ""));
    }),
  );
  // hear a note's unheard parts again (OpenAI, then Gemini) and, once every part has words, post it again as his message.
  if (!open)
    api.post(
      `${prefix}/notes/:nid/redo`,
      guard(async (c, n) => {
        const b = (await json(c)) as { force?: unknown };
        // a note with no kept link (a card answer) gets the console's public address, not the caller's
        const pub = sites().teamUrl.replace(/\/$/, "");
        const audioBase = /^https?:\/\/(localhost|127\.|100\.)/.test(base(c)) && !/example\.com/.test(pub) ? `${pub}${c.req.path.replace(/\/notes\/.*$/, "")}/notes` : base(c);
        return c.json(await n.redo(c.req.param("nid") ?? "", { audioBase, force: b.force === true }));
      }, false),
    );
  // his Send again on a voice note the chat shows not delivered yet: one re-send now.
  if (!open) api.post(`${prefix}/notes/:nid/redeliver`, guard(async (c, n) => c.json(await n.redeliver(c.req.param("nid") ?? ""))));
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

/**
 * how fast his voice notes were Sent (tap stop to Sent, from the page) in the last day, every world: count,
 * median, slowest, how many over SEND_SLOW_MS, and accepted notes not posted after SEND_STUCK_MS. /api/health `voiceSend`.
 */
export function voiceSendHealth(db: DB, nowMs = Date.now()) {
  ensureVoiceNoteRecTables(db);
  const since = new Date(nowMs - 24 * 3600_000).toISOString();
  const rows = db.prepare("SELECT id, send_ms, accepted_at, posted_at FROM voice_notes WHERE started_at >= ? AND send_ms IS NOT NULL ORDER BY started_at").all(since) as { id: string; send_ms: string; accepted_at: string | null; posted_at: string | null }[];
  const sent: { id: string; ms: number; words?: number; parts?: string }[] = [];
  for (const r of rows) {
    const j = JSON.parse(r.send_ms) as Record<string, number>;
    if (typeof j.sent !== "number") continue;
    const parts = SEND_PARTS.filter((k) => typeof j[k] === "number").map((k) => `${k} ${j[k]}`).join(", ");
    sent.push({ id: r.id, ms: j.sent, ...(parts ? { parts } : {}), ...(r.accepted_at && r.posted_at ? { words: j.sent + Date.parse(r.posted_at) - Date.parse(r.accepted_at) } : {}) });
  }
  const ms = sent.map((x) => x.ms).sort((a, b) => a - b);
  const slow = sent.filter((x) => x.ms > SEND_SLOW_MS);
  const stuck = (db.prepare("SELECT id FROM voice_notes WHERE accepted_at IS NOT NULL AND accepted_at < ? AND state IN ('recording', 'failed')").all(new Date(nowMs - SEND_STUCK_MS).toISOString()) as { id: string }[]).map((r) => r.id);
  const last = sent.at(-1);
  // merged here (one in, one out): notes of the last day with a part neither transcriber turned into words.
  const unheard = (db.prepare("SELECT DISTINCT v.id FROM voice_notes v JOIN voice_note_segments s ON s.note_id = v.id WHERE v.started_at >= ? AND v.state != 'discarded' AND s.text IS NULL AND s.error IS NOT NULL AND v.state != 'recording' ORDER BY v.id").all(since) as { id: string }[]).map((r) => r.id);
  // merged here (one in, one out): what he sent that the desk's chat still lacks after UNDELIVERED_ALERT_MS:
  // a voice note re-sent each minute, or a typed message (his pasted images ride on it) the console holds while T3 is down.
  const late = new Date(nowMs - UNDELIVERED_ALERT_MS).toISOString();
  const undelivered = (
    db.prepare("SELECT id FROM voice_notes WHERE state = 'posted' AND delivered_at IS NULL AND post_json IS NOT NULL AND posted_at < ? AND posted_at >= ? ORDER BY posted_at").all(late, new Date(nowMs - DELIVER_WINDOW_MS).toISOString()) as { id: string }[]
  ).map((r) => r.id);
  const hasOutbox = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'desk_outbox'").get();
  const held = hasOutbox
    ? (db.prepare("SELECT client_request_id id FROM desk_outbox WHERE sent_at IS NULL AND failed_at IS NULL AND created_at < ? ORDER BY seq").all(late) as { id: string }[]).map((r) => r.id)
    : [];
  return {
    state: stuck.length || slow.length || unheard.length || undelivered.length || held.length ? "alert" : sent.length ? "ok" : "idle",
    unheard,
    undelivered,
    held,
    undeliveredAfterMs: UNDELIVERED_ALERT_MS,
    limitMs: SEND_SLOW_MS,
    notes: sent.length,
    ...(ms.length ? { medianMs: ms[Math.floor((ms.length - 1) / 2)], slowestMs: ms.at(-1) } : {}),
    slow: slow.length,
    ...(slow.length ? { slowNotes: slow.slice(-5).map((x) => `${x.id} ${x.ms} ms${x.parts ? ` (${x.parts})` : ""}`) } : {}),
    stuck,
    ...(last ? { last: { id: last.id, sentMs: last.ms, ...(last.words !== undefined ? { wordsMs: last.words } : {}) } } : {}),
  };
}
