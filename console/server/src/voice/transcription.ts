import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "../db.js";
import { ownerName, sites as siteConfig } from "../identity.js";
import { VoiceError } from "./voice.js";
import { GEMINI_NOTE_MODEL, NOTE_MODEL, type Transcriber, type Transcript } from "./notes.js";

/**
 * (the owner's answer on, vn_7d8521fb, 22 Nov: "could we not run our own transcription for free, like on a
 * Whisper or something?... a central service... so that we don't need to keep paying OpenAI... a settings section...
 * what is the model that is being used for transcription and what's the cost in the last 30 days").
 *
 * Every voice note and card answer is turned into words by our own Whisper on the worker server (hosted/console/scripts/transcribe-server.py,
 * open-source, free; the console reaches it over the tailnet). A paid provider (Gemini) only when ours fails and only when
 * his paid backup is on, and each such part raises an alarm. He picks the model in Settings, Transcription; the same section
 * shows the model in use and what the last 30 days cost.
 *
 * (the owner, 24 Nov 20:37Z: "ElevenLabs for all transcription"; Log/2026-11-24.md#^e-798779): ElevenLabs Scribe is
 * now the default, paid from his grant's credits (33,010,000). Our Whisper takes any part Scribe cannot (no key, refusal,
 * timeout), and Gemini only when both fail and the paid backup is on. Each Scribe part keeps the credits it spent.
 */

/** voice_settings keys (the platform's, every world). */
const MODEL_KEY = "transcribe_model";
const BACKUP_KEY = "transcribe_paid_backup";

export interface TranscribeModel {
  id: string;
  label: string;
  /** ours: our own server, free. paid: a provider billed per minute. */
  kind: "ours" | "paid" | "grant";
  /** one short line beside the pick. */
  note: string;
}

/**
 * The models he can pick, ours first. Accuracy and speed measured on 19 of his own notes (50 min of speech) against the
 * OpenAI transcripts on the worker server (22 Nov; the owner kept small): the page is the site's transcribeResultsUrl.
 */
export const TRANSCRIBE_MODELS: TranscribeModel[] = [
  { id: "elevenlabs", label: "ElevenLabs Scribe", kind: "grant", note: "ElevenLabs, paid from your grant's credits. Our Whisper takes any note it cannot." },
  { id: "small", label: "Whisper small", kind: "ours", note: "On our server, free. 6.4% of words differ from OpenAI's on 19 of your notes. About 11 s per audio minute." },
  { id: "large-v3-turbo", label: "Whisper large-v3-turbo", kind: "ours", note: "On our server, free. 3.4% of words differ, on 5 of your notes. About 84 s per audio minute." },
  { id: "gemini", label: "Gemini Flash", kind: "paid", note: "Google, paid: about 0.4 cents a minute." },
];
/**
 * small by default: on the shared the worker server at the lowest priority it writes out a 2-minute part in about half a minute,
 * where large-v3-turbo took 2 to 4 minutes at the day's load (the Delivery Manager: agents first).
 */
export const DEFAULT_TRANSCRIBE_MODEL = "elevenlabs";
/** our own Whisper model that takes a part ElevenLabs cannot. */
export const OWN_FALLBACK_MODEL = "small";
/** ElevenLabs' speech-to-text model and the grant it is paid from (his billing page, 24 Nov). */
export const SCRIBE_MODEL = "scribe_v1";
export const ELEVENLABS_GRANT_CREDITS = 33_010_000;

/** The model test behind the lines above, with the one model measured there that is not offered. */
export const TRANSCRIBE_BENCHMARK_SUMMARY = "Measured on 19 of your notes, 50 min of speech. Whisper medium: 6.3% of words differ, about 26 s per audio minute.";

export interface TranscriptionSettings {
  model: string;
  /** a paid provider (Gemini) takes a part only when ours fails. */
  paidBackup: boolean;
}

export function transcriptionSettings(db: DB): TranscriptionSettings {
  const get = (k: string) => (db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const m = get(MODEL_KEY);
  return { model: m && TRANSCRIBE_MODELS.some((x) => x.id === m) ? m : DEFAULT_TRANSCRIBE_MODEL, paidBackup: get(BACKUP_KEY) !== "off" };
}

export function setTranscriptionSettings(db: DB, s: Partial<TranscriptionSettings>): void {
  const put = (k: string, v: string) => db.prepare("INSERT INTO voice_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
  if (s.model !== undefined) {
    if (!TRANSCRIBE_MODELS.some((x) => x.id === s.model)) throw new VoiceError(400, "validation_error", `unknown model ${s.model}`);
    put(MODEL_KEY, s.model);
  }
  if (s.paidBackup !== undefined) put(BACKUP_KEY, s.paidBackup ? "on" : "off");
}

/**
 * Our own Whisper on the worker server: POST <url>/transcribe?model=&prompt=&caller= with the audio as the body. Its usage comes back
 * as `{provider: "local", model, audio_s, ms}`: no money, only server time.
 */
export function localTranscriber(url: string, model: () => string, f: typeof fetch = fetch, timeoutMs = 300_000): Transcriber {
  const base = url.replace(/\/+$/, "");
  return async (audio, o) => {
    if (!base || base === "off") throw new VoiceError(503, "local_off", "our transcription server is not set on this console");
    // scribe=0: the console asks ElevenLabs itself first, so the central server goes straight to Whisper.
    const q = new URLSearchParams({ model: model(), caller: "console", scribe: "0" });
    if (o.prompt) q.set("prompt", o.prompt.slice(-300));
    let r: Response;
    try {
      r = await f(`${base}/transcribe?${q}`, { method: "POST", headers: { "content-type": o.mime || "application/octet-stream", "x-filename": o.filename }, body: audio.slice(), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new VoiceError(502, "local_down", `our transcription server did not answer (${(e as Error).name === "TimeoutError" ? "too slow" : (e as Error).message.slice(0, 120)})`);
    }
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || typeof j.text !== "string") throw new VoiceError(502, "local_refused", `our transcription server did not transcribe the note (${r.status}): ${String(j?.error ?? "no message").slice(0, 200)}`);
    const m = String(j.model ?? model());
    return { text: j.text, provider: "local", model: `whisper-${m}`, usage: { provider: "local", model: `whisper-${m}`, audio_s: Number(j.audio_s) || 0, ms: Number(j.ms) || 0, ...(j.language ? { language: j.language } : {}) } };
  };
}

/**
 * ElevenLabs Scribe (POST /v1/speech-to-text, multipart) with the console's own key (agent-team-console/ELEVENLABS_API_KEY,
 * read from the store per call, held in memory only). Its usage comes back as `{provider: "elevenlabs", model, credits,
 * list_usd, language}`: credits from ElevenLabs' `character-cost` answer header (spent from the grant), list_usd what the
 * same part would cost at list price (`fiat-cost-before-overages`), kept for the record, not billed.
 */
export function elevenlabsTranscriber(key: () => Promise<string | undefined>, model = SCRIBE_MODEL, f: typeof fetch = fetch, timeoutMs = 180_000): Transcriber {
  return async (audio, o) => {
    const k = await key();
    if (!k) throw new VoiceError(503, "no_key", "the console has no ELEVENLABS_API_KEY (secret store agent-team-console/ELEVENLABS_API_KEY)");
    const form = new FormData();
    form.append("model_id", model);
    form.append("tag_audio_events", "false");
    form.append("file", new Blob([audio.slice()], { type: o.mime || "application/octet-stream" }), o.filename);
    let r: Response;
    try {
      r = await f("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": k }, body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new VoiceError(502, "elevenlabs_down", `ElevenLabs did not answer (${(e as Error).name === "TimeoutError" ? "too slow" : (e as Error).message.slice(0, 120)})`);
    }
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || typeof j.text !== "string") throw new VoiceError(502, "elevenlabs_refused", `ElevenLabs did not transcribe the note (${r.status}): ${String(j?.detail?.message ?? j?.detail ?? "no message").slice(0, 200)}`);
    const num = (h: string) => {
      const v = Number(r.headers.get(h));
      return Number.isFinite(v) ? v : 0;
    };
    const usage = { provider: "elevenlabs", model, credits: num("character-cost"), list_usd: num("fiat-cost-before-overages"), ...(j.language_code ? { language: j.language_code } : {}) };
    return { text: j.text.trim(), provider: "elevenlabs", model, usage };
  };
}

/**
 * The transcriber every note uses: his pick, read on each part. Ours first; when ours fails and his paid backup is on,
 * the part goes to Gemini and `onBackup` raises the alarm; both failing (or the backup off) is one error naming both,
 * so the part is named unheard and he is told.
 */
export function pickedTranscriber(o: { db: DB; ours: (model: string) => Transcriber; paid: Transcriber; eleven?: Transcriber; onBackup?: (why: string, filename: string) => void; log?: (m: string) => void }): Transcriber {
  const log = o.log ?? ((m: string) => console.warn(m));
  return async (audio, opt): Promise<Transcript> => {
    const s = transcriptionSettings(o.db);
    if (s.model === "gemini") return o.paid(audio, opt);
    let own = s.model;
    if (s.model === "elevenlabs") {
      own = OWN_FALLBACK_MODEL;
      if (o.eleven) {
        try {
          return await o.eleven(audio, opt);
        } catch (e0) {
          log(`[voice] ${opt.filename}: ${(e0 as Error).message.slice(0, 200)}; our Whisper takes this part`);
        }
      }
    }
    try {
      return await o.ours(own)(audio, opt);
    } catch (e1) {
      const why = (e1 as Error).message.slice(0, 200);
      if (!s.paidBackup) throw new VoiceError(502, "transcribe_failed", `${why} | the paid backup is off`);
      log(`[voice] ${opt.filename}: ${why}; the paid backup (Gemini) takes this part`);
      try {
        o.onBackup?.(why, opt.filename);
      } catch (e) {
        console.error("transcription onBackup:", e);
      }
      try {
        const t = await o.paid(audio, opt);
        // marked, so Settings counts the parts the backup took (and what they cost).
        return { ...t, usage: { ...((t.usage as Record<string, unknown> | undefined) ?? {}), backup: true } };
      } catch (e2) {
        throw new VoiceError(502, "transcribe_failed", `${why.slice(0, 150)} | ${(e2 as Error).message.slice(0, 150)}`);
      }
    }
  };
}

/** the model a part was turned into words with, from its provider and usage. */
export function partModel(provider: string | null, usage: string | null): string {
  if (provider === "gemini") return GEMINI_NOTE_MODEL;
  if (provider === "elevenlabs") {
    try {
      return (JSON.parse(usage ?? "{}") as { model?: string }).model ?? SCRIBE_MODEL;
    } catch {
      return SCRIBE_MODEL;
    }
  }
  if (provider === "local") {
    try {
      const m = (JSON.parse(usage ?? "{}") as { model?: string }).model;
      if (m) return m;
    } catch {
      /* fall through */
    }
    return "whisper";
  }
  return NOTE_MODEL;
}

export interface TranscriptionCostLine {
  provider: "local" | "gemini" | "openai" | "elevenlabs";
  model: string;
  parts: number;
  minutes: number;
  usd: number;
  /** ElevenLabs credits spent from the grant (0 for every other provider). */
  credits: number;
}

export interface TranscriptionView {
  settings: TranscriptionSettings;
  models: TranscribeModel[];
  /** the model test behind the accuracy and speed lines, and its page when the site has one. */
  benchmark: { summary: string; url?: string };
  /** the model of the newest part turned into words, and when. */
  inUse?: { model: string; provider: string; at: string };
  last30: {
    usd: number;
    minutes: number;
    lines: TranscriptionCostLine[];
    /** our server's working time for its parts (it costs no money). */
    serverMinutes: number;
    /** paid parts that went to the backup because ours failed (the alarm's count). */
    backupParts: number;
    /** ElevenLabs credits spent in the window, and the grant they come from. */
    credits: number;
    grantCredits: number;
  };
  /** the voice calls in the same 30 days (now off), so the whole voice bill shows. */
  calls: { on: boolean; count: number; usd: number };
}

const r2 = (v: number, d = 1e4) => Math.round(v * d) / d;

/** What transcription cost in the last `days` days, by provider and model (every world's notes and card answers). */
export function transcriptionView(db: DB, o: { now?: number; days?: number; callsOn?: boolean } = {}): TranscriptionView {
  const since = new Date((o.now ?? Date.now()) - (o.days ?? 30) * 86_400_000).toISOString();
  const rows = db.prepare("SELECT provider, usage, seconds, cost_usd FROM voice_note_segments WHERE at >= ? AND text IS NOT NULL").all(since) as { provider: string | null; usage: string | null; seconds: number; cost_usd: number }[];
  const by = new Map<string, TranscriptionCostLine>();
  let serverMs = 0;
  let backupParts = 0;
  for (const r of rows) {
    const provider = (r.provider === "local" || r.provider === "gemini" || r.provider === "elevenlabs" ? r.provider : "openai") as TranscriptionCostLine["provider"];
    const model = partModel(r.provider, r.usage);
    if (provider === "local") {
      try {
        serverMs += Number((JSON.parse(r.usage ?? "{}") as { ms?: number }).ms) || 0;
      } catch {
        /* no usage */
      }
    }
    if (provider === "gemini" && r.usage?.includes('"backup":true')) backupParts++;
    const k = `${provider}|${model}`;
    const l = by.get(k) ?? { provider, model, parts: 0, minutes: 0, usd: 0, credits: 0 };
    l.parts++;
    if (provider === "elevenlabs") {
      try {
        l.credits += Number((JSON.parse(r.usage ?? "{}") as { credits?: number }).credits) || 0;
      } catch {
        /* no usage */
      }
    }
    l.minutes += (r.seconds || 0) / 60;
    l.usd += r.cost_usd || 0;
    by.set(k, l);
  }
  const rank = (p: string) => (p === "elevenlabs" ? 0 : p === "local" ? 1 : 2);
  const lines = [...by.values()].map((l) => ({ ...l, minutes: r2(l.minutes, 10), usd: r2(l.usd) })).sort((a, b) => rank(a.provider) - rank(b.provider) || b.usd - a.usd);
  const newest = db.prepare("SELECT provider, usage, at FROM voice_note_segments WHERE text IS NOT NULL ORDER BY at DESC LIMIT 1").get() as { provider: string | null; usage: string | null; at: string } | undefined;
  const calls = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(cost_usd), 0) usd FROM voice_calls WHERE started_at >= ?").get(since) as { n: number; usd: number } | undefined;
  return {
    settings: transcriptionSettings(db),
    models: TRANSCRIBE_MODELS,
    benchmark: { summary: TRANSCRIBE_BENCHMARK_SUMMARY, ...(siteConfig().transcribeResultsUrl ? { url: siteConfig().transcribeResultsUrl } : {}) },
    ...(newest ? { inUse: { model: partModel(newest.provider, newest.usage), provider: newest.provider ?? "openai", at: newest.at } } : {}),
    last30: {
      usd: r2(lines.reduce((a, l) => a + l.usd, 0)),
      minutes: r2(lines.reduce((a, l) => a + l.minutes, 0), 10),
      lines,
      serverMinutes: r2(serverMs / 60_000, 10),
      backupParts,
      credits: lines.reduce((a, l) => a + l.credits, 0),
      grantCredits: ELEVENLABS_GRANT_CREDITS,
    },
    calls: { on: !!o.callsOn, count: calls?.n ?? 0, usd: r2(calls?.usd ?? 0) },
  };
}

const putIn = z.object({ model: z.string().trim().min(1).max(40).optional(), paidBackup: z.boolean().optional() });

/** GET/PUT /api/voice/transcription: the Settings section (the owner changes it; anyone of his may read it). */
export function mountTranscription(api: Hono, o: { db: DB; callsOn: () => boolean; world: () => string | undefined; home: string; now?: () => number; refuse: (c: Context) => string | undefined }) {
  const mine = (c: Context) => (o.world() ?? o.home) === o.home || c.json({ error: { code: "world_scope", message: `transcription settings are ${ownerName()}'s` } }, 403);
  api.get("/voice/transcription", (c) => {
    const ok = mine(c);
    if (ok !== true) return ok;
    return c.json(transcriptionView(o.db, { callsOn: o.callsOn(), ...(o.now ? { now: o.now() } : {}) }));
  });
  api.put("/voice/transcription", async (c) => {
    const ok = mine(c);
    if (ok !== true) return ok;
    const why = o.refuse(c);
    if (why) return c.json({ error: { code: "owner_only", message: `the transcription model is ${ownerName()}'s pick (${why})` } }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined;
    }
    const p = putIn.safeParse(raw);
    if (!p.success || (p.data.model === undefined && p.data.paidBackup === undefined)) return c.json({ error: { code: "validation_error", message: "model (one of the listed ids) or paidBackup (boolean)" } }, 400);
    try {
      setTranscriptionSettings(o.db, p.data);
    } catch (e) {
      if (e instanceof VoiceError) return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
      throw e;
    }
    return c.json(transcriptionView(o.db, { callsOn: o.callsOn(), ...(o.now ? { now: o.now() } : {}) }));
  });
}
