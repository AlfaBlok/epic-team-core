import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "./db.js";
import type { SpineWrite, SpineWriter } from "./inbox/spineWrite.js";
import { clientAddress } from "./clientAddress.js";
import { KEEP_JS } from "./voice/keepJs.js";
import { audioExt, noteCost, type Transcriber } from "./voice/notes.js";
import { VoiceError } from "./voice/voice.js";
import { anthropicJson } from "./textModel.js";
import { ownerName, socialProduct } from "./identity.js";

/**
 * Customer and tester feedback by voice note link:
 *  - A link per recipient (`feedback_links`: who, product, campaign, an unguessable token). the owner or an agent of his world
 *    makes it on the console's Voice feedback page (POST /api/feedback/links) and sends it.
 *  - The link opens a plain page (GET /api/public/feedback/<token>): one button, tap to start and tap to send, on phone and
 *    desktop. It records in FEEDBACK_SEGMENT_S parts (a new MediaRecorder on the same microphone, no gap) and uploads each
 *    while they keep talking; the browser keeps a part until the console confirms its text, so a failed upload is retried.
 *  - Transcribed only: each part is transcribed in memory (gpt-4o-mini-transcribe, the console's key, the voice notes'
 *    model and price) and its audio is dropped at once; it is never written to disk and nobody can play it back. OpenAI
 *    keeps API inputs up to 30 days for abuse checks and does not train on them (its API data policy).
 *  - On Send the transcript is kept here (state `transcribed`), then structured once (gpt-4o-mini: summary, sentiment, asks,
 *    bugs, praise, quotes) and filed as one Markdown file in the world's repo, `feedback/voice/<day>-<id>.md` (root L-45:
 *    the repo is the source the personas read), committed and pushed through the one spine writer; then one note on the
 *    desk tells the owner. A note that could not be structured is filed with its transcript and `structure: pending`; one that
 *    could not be filed stays `transcribed` and the tick files it again (never lost).
 *  - Cost: transcription and structuring count against the world's voice month budget (voice notes and calls share it);
 *    a link takes at most FEEDBACK_NOTES_PER_DAY notes a day, a note at most FEEDBACK_MAX_MIN minutes.
 * The token in the URL is the only credential (like the auth-sync links); the routes are OPEN in auth/routeScope.ts.
 * From the internet only once a Traefik router lets them through on our site, which is the owner's call.
 */

export const FEEDBACK_DIR = "feedback/voice";
export const FEEDBACK_SEGMENT_S = 60;
export const FEEDBACK_MAX_MIN = 10;
export const FEEDBACK_MAX_PARTS = 20;
export const FEEDBACK_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
export const FEEDBACK_NOTES_PER_DAY = 6;
export const FEEDBACK_ALL_PER_DAY = 60;
export const STRUCTURE_MODEL = "gpt-4o-mini";
/** gpt-4o-mini, US$ per 1M tokens (checked 2026-11-08). */
export const STRUCTURE_PRICES = { in: 0.15, out: 0.6 };
export const FEEDBACK_MARKER = "[voice feedback]";
const PROMPT_TAIL = 300;

export interface Structure {
  summary: string;
  sentiment: "positive" | "mixed" | "negative" | "neutral";
  asks: string[];
  bugs: string[];
  praise: string[];
  quotes: string[];
}
/** Structure one transcript (tests fake it). */
export type Structurer = (transcript: string, ctx: { who: string; product: string; campaign: string }) => Promise<{ structure: Structure; costUsd: number }>;

export interface FeedbackLink {
  id: string;
  token: string;
  world: string;
  who: string;
  product: string;
  campaign: string;
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
  notes: number;
  lastNoteAt?: string;
}

export interface FeedbackNote {
  id: string;
  linkId: string;
  world: string;
  who: string;
  product: string;
  campaign: string;
  startedAt: string;
  finishedAt?: string;
  state: "recording" | "transcribed" | "filed" | "empty" | "discarded";
  seconds: number;
  costUsd: number;
  transcript?: string;
  structure?: Structure;
  file?: string;
  sha?: string;
  repo?: string;
  fileError?: string;
  toldAt?: string;
}

export function ensureFeedbackTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_links (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      world TEXT NOT NULL,
      who TEXT NOT NULL,
      product TEXT NOT NULL,
      campaign TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS feedback_notes (
      id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL,
      world TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      state TEXT NOT NULL,
      seconds REAL NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      transcript TEXT,
      structure TEXT,
      file TEXT,
      sha TEXT,
      repo TEXT,
      file_error TEXT,
      told_at TEXT
    );
    CREATE INDEX IF NOT EXISTS feedback_notes_started ON feedback_notes (started_at);
    CREATE TABLE IF NOT EXISTS feedback_segments (
      note_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      at TEXT NOT NULL,
      seconds REAL NOT NULL,
      text TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (note_id, n)
    );
  `);
  // the browser's id for the note: a start with the same id opens the same note, never a second.
  const cols = new Set((db.prepare("PRAGMA table_info(feedback_notes)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("client_id")) db.exec("ALTER TABLE feedback_notes ADD COLUMN client_id TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS feedback_notes_client ON feedback_notes (link_id, client_id) WHERE client_id IS NOT NULL");
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "sentiment", "asks", "bugs", "praise", "quotes"],
  properties: {
    summary: { type: "string", description: "Two or three plain sentences: what this person told us." },
    sentiment: { type: "string", enum: ["positive", "mixed", "negative", "neutral"] },
    asks: { type: "array", items: { type: "string" }, description: "Each thing they want added or changed, one plain sentence each." },
    bugs: { type: "array", items: { type: "string" }, description: "Each thing that is broken or confusing, with where, one sentence each." },
    praise: { type: "array", items: { type: "string" }, description: "What they liked, one short sentence each." },
    quotes: { type: "array", items: { type: "string" }, description: "Up to three short quotes in their own words worth keeping." },
  },
};

const STRUCTURE_SYSTEM =
  "You turn one customer's spoken feedback into structured notes for a product team. Use only what they said; never invent. " +
  "Write in plain, short sentences in the language they spoke. Empty lists when there is nothing of that kind.";
const structureUser = (transcript: string, ctx: { who: string; product: string; campaign: string }) =>
  `Product: ${ctx.product}. Campaign: ${ctx.campaign}. Speaker: ${ctx.who}.\n\nTranscript:\n${transcript.slice(0, 40_000)}`;

/** The default structurer: OpenAI chat completions with a strict JSON schema, the console's key. */
export function openAiStructurer(key: () => Promise<string | undefined>, f: typeof fetch = fetch): Structurer {
  return async (transcript, ctx) => {
    const k = await key();
    if (!k) throw new Error("the console has no OPENAI_API_KEY");
    const body = {
      model: STRUCTURE_MODEL,
      temperature: 0.2,
      response_format: { type: "json_schema", json_schema: { name: "feedback", strict: true, schema: SCHEMA } },
      messages: [
        { role: "system", content: STRUCTURE_SYSTEM },
        { role: "user", content: structureUser(transcript, ctx) },
      ],
    };
    const r = await f("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    const j = (await r.json().catch(() => ({}))) as any;
    const text = j?.choices?.[0]?.message?.content;
    if (!r.ok || typeof text !== "string") throw new Error(`OpenAI did not structure the note (${r.status}): ${String(j?.error?.message ?? "no message").slice(0, 200)}`);
    const s = JSON.parse(text) as Structure;
    const u = j.usage ?? {};
    const costUsd = Math.round((((u.prompt_tokens ?? 0) * STRUCTURE_PRICES.in + (u.completion_tokens ?? 0) * STRUCTURE_PRICES.out) / 1_000_000) * 1e6) / 1e6;
    return { structure: s, costUsd };
  };
}

/** The same notes from Claude Haiku 5.5 on the credit account (`CONSOLE_TEXT_MODEL_PROVIDER=anthropic`). */
export function anthropicStructurer(key: () => Promise<string | undefined>, f: typeof fetch = fetch): Structurer {
  return async (transcript, ctx) => {
    const { value, costUsd } = await anthropicJson<Structure>(key, f, { system: STRUCTURE_SYSTEM, user: structureUser(transcript, ctx), schema: SCHEMA, maxTokens: 8000, timeoutMs: 90_000 });
    return { structure: value, costUsd };
  };
}

// ---------- the repo file ----------

const clock = (s: number) => `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
const yamlStr = (s: string) => JSON.stringify(s.replace(/[\r\n]+/g, " ").trim());
const bullet = (xs: string[] | undefined) => (xs?.length ? xs.map((x) => `- ${x.replace(/[\r\n]+/g, " ").trim()}`).join("\n") : "- none");

export const feedbackFileName = (n: Pick<FeedbackNote, "id" | "startedAt">) => `${FEEDBACK_DIR}/${n.startedAt.slice(0, 10)}-${n.id}.md`;

/** One feedback item as the personas read it: front matter for scripts, then plain sections. */
export function feedbackMarkdown(n: FeedbackNote, structureError?: string): string {
  const s = n.structure;
  const front = [
    "---",
    `id: ${n.id}`,
    "kind: voice-feedback",
    `received: ${n.finishedAt ?? n.startedAt}`,
    `from: ${yamlStr(n.who)}`,
    `product: ${yamlStr(n.product)}`,
    `campaign: ${yamlStr(n.campaign)}`,
    `world: ${n.world}`,
    `link: ${n.linkId}`,
    `length_s: ${Math.round(n.seconds)}`,
    `cost_usd: ${n.costUsd}`,
    `sentiment: ${s?.sentiment ?? "unknown"}`,
    `structure: ${s ? "done" : "pending"}`,
    "audio: not kept (transcribed only)",
    "status: new",
    "---",
  ];
  return [
    ...front,
    "",
    `# Voice feedback from ${n.who} · ${n.product} · ${n.startedAt.slice(0, 10)}`,
    "",
    `${clock(n.seconds)} spoken through their feedback link (${n.campaign}). The audio was transcribed and dropped; only this text is kept.`,
    "",
    "## Summary",
    "",
    s?.summary || `Not structured yet${structureError ? ` (${structureError})` : ""}: read the transcript below.`,
    "",
    "## Asks",
    "",
    bullet(s?.asks),
    "",
    "## Bugs",
    "",
    bullet(s?.bugs),
    "",
    "## Praise",
    "",
    bullet(s?.praise),
    "",
    "## Quotes",
    "",
    s?.quotes?.length ? s.quotes.map((q) => `> ${q.replace(/[\r\n]+/g, " ").trim()}`).join("\n>\n") : "- none",
    "",
    "## What they said",
    "",
    (n.transcript ?? "").trim(),
    "",
    "## Triage",
    "",
    "Set `status:` above to `triaged` once each ask and bug is a row (cite this file in the row) or is answered here in one line.",
    "",
  ].join("\n");
}

/** Read the items filed in a checkout (newest first): front matter fields and the summary. */
export function readFiledFeedback(repoDir: string | undefined, limit = 100): { file: string; fields: Record<string, string>; summary: string; asks: string[]; bugs: string[] }[] {
  if (!repoDir) return [];
  const dir = path.join(repoDir, FEEDBACK_DIR);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-fbn_[a-f0-9]+\.md$/.test(f));
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => {
      const t = fs.readFileSync(path.join(dir, f), "utf8");
      const fields: Record<string, string> = {};
      const fm = /^---\n([\s\S]*?)\n---/.exec(t)?.[1] ?? "";
      for (const l of fm.split("\n")) {
        const m = /^(\w+):\s*(.*)$/.exec(l);
        if (m) fields[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
      }
      const section = (h: string) => (new RegExp(`^## ${h}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, "m").exec(t)?.[1] ?? "").trim();
      const list = (h: string) => section(h).split("\n").map((l) => l.replace(/^- /, "").trim()).filter((l) => l && l !== "none");
      return { file: `${FEEDBACK_DIR}/${f}`, fields, summary: section("Summary"), asks: list("Asks"), bugs: list("Bugs") };
    });
}

// ---------- the engine ----------

export interface FeedbackDeps {
  db: DB;
  transcribe: Transcriber;
  structure?: Structurer;
  /** The world's voice budget (same cap as calls and voice notes). */
  budget: (world: string) => { monthUsd: number; monthCapUsd: number; enabled: boolean };
  /** The checkout feedback is filed in for a world. */
  repoOf: (world: string) => string | undefined;
  writer?: SpineWriter;
  /** One note on the world's desk (the home world: the Team desk). */
  tell?: (world: string, text: string, clientRequestId: string) => Promise<true | string>;
  /** Where the console shows the list (the desk note links it). */
  pageBase: string;
  now?: () => number;
}

const tok = () => crypto.randomBytes(12).toString("base64url");
const rid = (p: string) => `${p}_${crypto.randomBytes(4).toString("hex")}`;
const usd = (v: number) => `$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`;

export function createFeedback(d: FeedbackDeps) {
  const { db } = d;
  ensureFeedbackTables(db);
  const now = d.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();

  const linkRow = (r: any): FeedbackLink => {
    const c = db.prepare("SELECT COUNT(*) n, MAX(finished_at) last FROM feedback_notes WHERE link_id = ? AND state IN ('transcribed', 'filed')").get(r.id) as { n: number; last: string | null };
    return {
      id: r.id,
      token: r.token,
      world: r.world,
      who: r.who,
      product: r.product,
      campaign: r.campaign,
      createdAt: r.created_at,
      createdBy: r.created_by,
      ...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
      notes: c.n,
      ...(c.last ? { lastNoteAt: c.last } : {}),
    };
  };
  const noteRow = (r: any): FeedbackNote => {
    const l = db.prepare("SELECT who, product, campaign FROM feedback_links WHERE id = ?").get(r.link_id) as { who: string; product: string; campaign: string } | undefined;
    return {
      id: r.id,
      linkId: r.link_id,
      world: r.world,
      who: l?.who ?? "unknown",
      product: l?.product ?? "",
      campaign: l?.campaign ?? "",
      startedAt: r.started_at,
      ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
      state: r.state,
      seconds: Math.round(r.seconds),
      costUsd: r.cost_usd,
      ...(r.transcript ? { transcript: r.transcript } : {}),
      ...(r.structure ? { structure: JSON.parse(r.structure) as Structure } : {}),
      ...(r.file ? { file: r.file } : {}),
      ...(r.sha ? { sha: r.sha } : {}),
      ...(r.repo ? { repo: r.repo } : {}),
      ...(r.file_error ? { fileError: r.file_error } : {}),
      ...(r.told_at ? { toldAt: r.told_at } : {}),
    };
  };

  function createLink(o: { world: string; who: string; product: string; campaign: string; by: string }): FeedbackLink {
    const id = rid("fbl");
    db.prepare("INSERT INTO feedback_links (id, token, world, who, product, campaign, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, tok(), o.world, o.who, o.product, o.campaign, iso(), o.by);
    return linkRow(db.prepare("SELECT * FROM feedback_links WHERE id = ?").get(id));
  }
  function revokeLink(world: string, id: string): FeedbackLink {
    const r = db.prepare("SELECT * FROM feedback_links WHERE id = ? AND world = ?").get(id, world);
    if (!r) throw new VoiceError(404, "not_found", `no feedback link ${id}`);
    db.prepare("UPDATE feedback_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(iso(), id);
    return linkRow(db.prepare("SELECT * FROM feedback_links WHERE id = ?").get(id));
  }
  const links = (world: string) => (db.prepare("SELECT * FROM feedback_links WHERE world = ? ORDER BY created_at DESC").all(world) as any[]).map(linkRow);
  const notes = (world: string, limit = 100) => (db.prepare("SELECT * FROM feedback_notes WHERE world = ? AND state != 'discarded' ORDER BY started_at DESC LIMIT ?").all(world, limit) as any[]).map(noteRow);

  /** The live link of a token, or why not (a revoked or unknown token reads the same: not found). */
  function byToken(token: string): FeedbackLink {
    const r = /^[\w-]{10,40}$/.test(token) ? db.prepare("SELECT * FROM feedback_links WHERE token = ? AND revoked_at IS NULL").get(token) : undefined;
    if (!r) throw new VoiceError(404, "not_found", "This feedback link is not valid any more. Ask us for a new one.");
    return linkRow(r);
  }
  const noteOf = (link: FeedbackLink, id: string) => {
    const r = db.prepare("SELECT * FROM feedback_notes WHERE id = ? AND link_id = ?").get(id, link.id);
    if (!r) throw new VoiceError(404, "not_found", `no note ${id} on this link`);
    return noteRow(r);
  };
  const budgetOk = (world: string) => {
    const b = d.budget(world);
    if (!b.enabled) throw new VoiceError(409, "voice_off", "Voice feedback is paused right now. Please try again later.");
    if (b.monthUsd >= b.monthCapUsd) throw new VoiceError(409, "month_cap", "Voice feedback is paused until next month. Please write to us instead.");
  };

  function start(token: string, clientId?: string): { note: FeedbackNote; segmentS: number; maxMin: number } {
    const link = byToken(token);
    // a resend from the browser (a retry, a reload, after a restart) gets the note it opened before, never a second.
    if (clientId) {
      const had = db.prepare("SELECT id FROM feedback_notes WHERE link_id = ? AND client_id = ?").get(link.id, clientId) as { id: string } | undefined;
      if (had) return { note: noteOf(link, had.id), segmentS: FEEDBACK_SEGMENT_S, maxMin: FEEDBACK_MAX_MIN };
    }
    budgetOk(link.world);
    const day = iso().slice(0, 10);
    const mine = (db.prepare("SELECT COUNT(*) n FROM feedback_notes WHERE link_id = ? AND started_at >= ? AND state != 'discarded'").get(link.id, day) as { n: number }).n;
    if (mine >= FEEDBACK_NOTES_PER_DAY) throw new VoiceError(409, "too_many", `That is ${FEEDBACK_NOTES_PER_DAY} notes today, thank you! The link takes more tomorrow.`);
    const all = (db.prepare("SELECT COUNT(*) n FROM feedback_notes WHERE started_at >= ?").get(day) as { n: number }).n;
    if (all >= FEEDBACK_ALL_PER_DAY) throw new VoiceError(409, "too_many", "We got a lot of notes today. Please try again tomorrow.");
    const id = rid("fbn");
    db.prepare("INSERT INTO feedback_notes (id, link_id, world, started_at, state, client_id) VALUES (?, ?, ?, ?, 'recording', ?)").run(id, link.id, link.world, iso(), clientId ?? null);
    return { note: noteOf(link, id), segmentS: FEEDBACK_SEGMENT_S, maxMin: FEEDBACK_MAX_MIN };
  }

  const retotal = (id: string) => {
    const t = db.prepare("SELECT COALESCE(SUM(seconds), 0) s, COALESCE(SUM(cost_usd), 0) c FROM feedback_segments WHERE note_id = ?").get(id) as { s: number; c: number };
    const extra = (db.prepare("SELECT structure FROM feedback_notes WHERE id = ?").get(id) as { structure: string | null } | undefined)?.structure;
    const sc = extra ? (JSON.parse(extra) as { costUsd?: number }).costUsd ?? 0 : 0;
    db.prepare("UPDATE feedback_notes SET seconds = ?, cost_usd = ? WHERE id = ?").run(t.s, Math.round((t.c + sc) * 1e6) / 1e6, id);
  };

  /** One part: transcribed in memory, the audio dropped right after (never written anywhere). A retry of a done part answers from its text. */
  async function segment(token: string, id: string, n: number, audio: Uint8Array, mime: string, seconds: number) {
    const link = byToken(token);
    const note = noteOf(link, id);
    // a part already in answers from its text, even once the note is sent (a resend whose answer a restart lost).
    const had = Number.isInteger(n) ? (db.prepare("SELECT text FROM feedback_segments WHERE note_id = ? AND n = ?").get(id, n) as { text: string } | undefined) : undefined;
    if (had) return { n, text: had.text };
    if (note.state !== "recording") throw new VoiceError(409, "note_closed", "This note was already sent.");
    if (!Number.isInteger(n) || n < 0 || n >= FEEDBACK_MAX_PARTS) throw new VoiceError(400, "validation_error", `part ${n} is out of range`);
    const ext = audioExt(mime);
    if (!ext) throw new VoiceError(400, "validation_error", "that is not audio we take");
    if (!audio.byteLength) throw new VoiceError(400, "validation_error", "the part is empty");
    if (audio.byteLength > FEEDBACK_SEGMENT_MAX_BYTES) throw new VoiceError(400, "too_big", "that part is too big");
    const done = db.prepare("SELECT text FROM feedback_segments WHERE note_id = ? AND n = ?").get(id, n) as { text: string } | undefined;
    if (done) return { n, text: done.text };
    const sec = Math.max(0, Math.min(FEEDBACK_SEGMENT_S * 2, Number.isFinite(seconds) ? seconds : 0));
    const sofar = (db.prepare("SELECT COALESCE(SUM(seconds), 0) s FROM feedback_segments WHERE note_id = ?").get(id) as { s: number }).s;
    if (sofar + sec > FEEDBACK_MAX_MIN * 60 + 30) throw new VoiceError(409, "note_cap", `A note is at most ${FEEDBACK_MAX_MIN} minutes.`);
    budgetOk(link.world);
    const prev = n > 0 ? (db.prepare("SELECT text FROM feedback_segments WHERE note_id = ? AND n = ?").get(id, n - 1) as { text: string } | undefined)?.text : undefined;
    let t;
    try {
      t = await d.transcribe(audio, { mime: mime.split(";")[0], filename: `${id}-${n}.${ext}`, ...(prev ? { prompt: prev.slice(-PROMPT_TAIL) } : {}) });
    } catch (e) {
      if (e instanceof VoiceError) throw e;
      throw new VoiceError(502, "transcribe_failed", `could not turn this part into text, it will be sent again: ${(e as Error).message.slice(0, 160)}`);
    }
    const cost = noteCost(t.usage, sec);
    db.prepare("INSERT OR IGNORE INTO feedback_segments (note_id, n, at, seconds, text, cost_usd) VALUES (?, ?, ?, ?, ?, ?)").run(id, n, iso(), sec, t.text.trim(), cost);
    retotal(id);
    return { n, text: t.text.trim() };
  }

  /** Send: every part 0..parts-1 is in (or skipped), the transcript is kept, then it is structured and filed (in the background). */
  function finish(token: string, id: string, o: { parts: number; skip?: number[] }): { note: FeedbackNote } {
    const link = byToken(token);
    const n0 = noteOf(link, id);
    if (n0.state !== "recording") return { note: n0 };
    const rows = db.prepare("SELECT n, text FROM feedback_segments WHERE note_id = ? ORDER BY n").all(id) as { n: number; text: string }[];
    const skip = new Set(o.skip ?? []);
    const missing: number[] = [];
    for (let i = 0; i < o.parts; i++) if (!skip.has(i) && !rows.some((r) => r.n === i)) missing.push(i);
    if (missing.length) throw new VoiceError(409, "segments_missing", `parts not in yet: ${missing.join(", ")}`);
    const words = rows.filter((r) => r.n < o.parts).map((r) => r.text).filter(Boolean).join("\n\n");
    db.prepare("UPDATE feedback_notes SET state = ?, finished_at = ?, transcript = ? WHERE id = ?").run(words ? "transcribed" : "empty", iso(), words ? words.slice(0, 200_000) : null, id);
    if (words) void file(id).catch((e) => console.warn(`[feedback] ${id}: ${(e as Error).message}`));
    return { note: noteOf(link, id) };
  }

  function discard(token: string, id: string) {
    const link = byToken(token);
    const n = noteOf(link, id);
    if (n.state === "recording") {
      // Cancelled: nothing they said is kept (the cost stays on the note, for the budget).
      retotal(id);
      db.prepare("DELETE FROM feedback_segments WHERE note_id = ?").run(id);
      db.prepare("UPDATE feedback_notes SET state = 'discarded', finished_at = ?, transcript = NULL WHERE id = ?").run(iso(), id);
    }
    return { note: noteOf(link, id) };
  }

  const filing = new Set<string>();
  /** Structure (once), write the file to the world's repo, tell the desk (once). Safe to call again: each step is skipped when done. */
  async function file(id: string): Promise<FeedbackNote> {
    if (filing.has(id)) return noteRow(db.prepare("SELECT * FROM feedback_notes WHERE id = ?").get(id));
    filing.add(id);
    try {
      let n = noteRow(db.prepare("SELECT * FROM feedback_notes WHERE id = ?").get(id));
      let structureError: string | undefined;
      if (!n.structure && n.transcript && d.structure) {
        try {
          const r = await d.structure(n.transcript, { who: n.who, product: n.product, campaign: n.campaign });
          db.prepare("UPDATE feedback_notes SET structure = ? WHERE id = ?").run(JSON.stringify({ ...r.structure, costUsd: r.costUsd }), id);
          retotal(id);
        } catch (e) {
          structureError = (e as Error).message.slice(0, 160);
        }
        n = noteRow(db.prepare("SELECT * FROM feedback_notes WHERE id = ?").get(id));
      }
      if (n.state === "transcribed") {
        const repoDir = d.repoOf(n.world);
        const rel = feedbackFileName(n);
        let w: SpineWrite;
        if (!repoDir || !d.writer) w = { status: "skipped", reason: repoDir ? "no repo writer" : `no checkout for world ${n.world}` };
        else {
          const policyPath = fs.existsSync(path.join(repoDir, "docs/spines/root.md")) ? "docs/spines/root.md" : "AGENTS.md";
          w = await d.writer.scaffold({
            repoDir,
            path: policyPath,
            label: `voice feedback ${n.id}`,
            scaffold: async (dir) => {
              const abs = path.join(dir, rel);
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, feedbackMarkdown(n, structureError));
              return { ok: true, files: [rel] };
            },
            msg: `voice feedback from ${n.who.slice(0, 60)} (${n.product}) filed as ${rel} (console)`,
            body: `A recipient of a feedback link (${n.linkId}, ${n.campaign}) left a ${clock(n.seconds)} voice note. The console transcribed it (audio dropped), structured it and filed it here for the team.`,
          });
        }
        if (w.status === "written") db.prepare("UPDATE feedback_notes SET state = 'filed', file = ?, sha = ?, repo = ?, file_error = NULL WHERE id = ?").run(rel, w.sha ?? null, repoDir ? path.basename(repoDir) : null, id);
        else db.prepare("UPDATE feedback_notes SET file_error = ? WHERE id = ?").run(`${w.status}: ${w.reason ?? ""}`.slice(0, 300), id);
        n = noteRow(db.prepare("SELECT * FROM feedback_notes WHERE id = ?").get(id));
      }
      if (n.state === "filed" && !n.toldAt && d.tell) {
        const res = await d.tell(n.world, feedbackDeskNote(n, d.pageBase), `voice-feedback-${n.id}`).catch((e) => String(e));
        if (res === true) db.prepare("UPDATE feedback_notes SET told_at = ? WHERE id = ?").run(iso(), id);
        n = noteRow(db.prepare("SELECT * FROM feedback_notes WHERE id = ?").get(id));
      }
      return n;
    } finally {
      filing.delete(id);
    }
  }

  /** The retry: notes kept but not filed, or filed but not yet told (a desk that was busy). */
  async function tick(): Promise<number> {
    const ids = (db.prepare("SELECT id FROM feedback_notes WHERE state = 'transcribed' OR (state = 'filed' AND told_at IS NULL) ORDER BY started_at LIMIT 20").all() as { id: string }[]).map((r) => r.id);
    for (const id of ids) await file(id).catch(() => undefined);
    // A note left recording for a day (page closed, never sent) keeps what it has: send what was transcribed.
    const stale = db.prepare("SELECT n.id, l.token FROM feedback_notes n JOIN feedback_links l ON l.id = n.link_id WHERE n.state = 'recording' AND n.started_at < ?").all(iso(now() - 24 * 3600_000)) as { id: string; token: string }[];
    for (const s of stale) {
      const parts = (db.prepare("SELECT COALESCE(MAX(n) + 1, 0) p FROM feedback_segments WHERE note_id = ?").get(s.id) as { p: number }).p;
      const have = new Set((db.prepare("SELECT n FROM feedback_segments WHERE note_id = ?").all(s.id) as { n: number }[]).map((r) => r.n));
      const skip = Array.from({ length: parts }, (_, i) => i).filter((i) => !have.has(i));
      try {
        if (parts) finish(s.token, s.id, { parts, skip });
        else db.prepare("UPDATE feedback_notes SET state = 'empty', finished_at = ? WHERE id = ?").run(iso(), s.id);
      } catch {
        db.prepare("UPDATE feedback_notes SET state = 'empty', finished_at = ? WHERE id = ?").run(iso(), s.id);
      }
    }
    return ids.length;
  }

  return { createLink, revokeLink, links, notes, byToken, start, segment, finish, discard, file, tick };
}
export type Feedback = ReturnType<typeof createFeedback>;

export function feedbackDeskNote(n: FeedbackNote, pageBase: string): string {
  const s = n.structure;
  return [
    `${FEEDBACK_MARKER} ${n.who} · ${n.product}`,
    `A customer left voice feedback through their link; it is filed in ${n.repo ?? "the repo"} ${n.file}${n.sha ? ` (${n.sha})` : ""}. Send ${ownerName()} exactly the text below as ONE message (keep the link), then do nothing else (the Delivery Manager triages the file on its next wake):`,
    "",
    `New voice feedback from ${n.who} (${n.product}, ${n.campaign}), ${clock(n.seconds)}, ${s?.sentiment ?? "not structured yet"}:`,
    s?.summary ?? (n.transcript ?? "").slice(0, 400),
    ...(s?.asks.length ? [`Asks: ${s.asks.join(" · ")}`] : []),
    ...(s?.bugs.length ? [`Bugs: ${s.bugs.join(" · ")}`] : []),
    `All voice feedback: ${pageBase.replace(/\/+$/, "")}/feedback`,
  ].join("\n");
}

// ---------- routes ----------

const linkIn = z.object({ who: z.string().trim().min(1).max(120), product: z.string().trim().min(1).max(60).default(() => socialProduct()), campaign: z.string().trim().min(1).max(80).default("testers") });
const finishIn = z.object({ parts: z.number().int().min(1).max(FEEDBACK_MAX_PARTS), skip: z.array(z.number().int().min(0).max(FEEDBACK_MAX_PARTS)).max(FEEDBACK_MAX_PARTS).optional() });

/** Where the console is reached by this request (the link the owner copies opens there; on our site once public). */
function origin(c: Context): string {
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (!host) return "";
  const proto = c.req.header("x-forwarded-proto") ?? (/^(localhost|127\.|100\.)/.test(host) ? "http" : "https");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

const peerOf = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;

export interface FeedbackRouteOptions {
  /** The world of the caller (the owner's console: the home world). */
  world: () => string;
  /** Who made the link (the signed-in name, else "console"). */
  by: (c: Context) => string;
  /** The checkout a world files in (the console page lists those files). */
  repoOf: (world: string) => string | undefined;
  /** The base of the links the owner sends: the public host once opened (CONSOLE_FEEDBACK_URL), else this console. */
  linkBase?: string;
}

export const linkUrl = (base: string, token: string) => `${base.replace(/\/+$/, "")}/api/public/feedback/${token}`;

export function mountFeedback(api: Hono, f: Feedback, o: FeedbackRouteOptions) {
  const err = (c: Context, e: unknown) => {
    if (e instanceof VoiceError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
    throw e;
  };
  const withUrl = (c: Context, l: FeedbackLink) => ({ ...l, url: linkUrl(o.linkBase || origin(c), l.token) });
  // A soft per-address limit on the public routes (Traefik adds its own when the door opens).
  const hits = new Map<string, number[]>();
  const limited = (c: Context) => {
    const a = clientAddress(peerOf(c), (h) => c.req.header(h));
    const t = Date.now();
    const recent = (hits.get(a) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    hits.set(a, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > 30;
  };

  // the owner's side (signed in; the home world until the routes are world-scoped).
  api.get("/feedback", (c) => {
    const w = o.world();
    return c.json({
      links: f.links(w).map((l) => withUrl(c, l)),
      notes: f.notes(w).map(({ transcript, ...n }) => ({ ...n, words: (transcript ?? "").length })),
      filed: readFiledFeedback(o.repoOf(w)),
      repo: o.repoOf(w) ? path.basename(o.repoOf(w)!) : undefined,
      dir: FEEDBACK_DIR,
      public: !!o.linkBase,
    });
  });
  api.post("/feedback/links", async (c) => {
    const p = linkIn.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: { code: "validation_error", message: "who (their name or email) is required; product and campaign are optional" } }, 400);
    return c.json(withUrl(c, f.createLink({ world: o.world(), ...p.data, by: o.by(c) })), 201);
  });
  api.post("/feedback/links/:id/revoke", (c) => {
    try {
      return c.json(withUrl(c, f.revokeLink(o.world(), c.req.param("id") ?? "")));
    } catch (e) {
      return err(c, e);
    }
  });
  api.post("/feedback/notes/:id/file", async (c) => c.json({ note: await f.file(c.req.param("id") ?? "") }));

  // The recipient's side: the token is the credential.
  api.get("/public/feedback/:token", (c) => {
    let link: FeedbackLink | undefined;
    try {
      link = f.byToken(c.req.param("token") ?? "");
    } catch {
      link = undefined;
    }
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    c.header("referrer-policy", "no-referrer");
    return c.html(feedbackPage(link ? { who: link.who, product: link.product } : undefined), link ? 200 : 404);
  });
  const pub = (fn: (c: Context, token: string) => Promise<Response> | Response) => async (c: Context) => {
    if (limited(c)) return c.json({ error: { code: "too_many", message: "Too many requests, wait a minute." } }, 429);
    try {
      return await fn(c, c.req.param("token") ?? "");
    } catch (e) {
      return err(c, e);
    }
  };
  api.post(
    "/public/feedback/:token/notes",
    pub(async (c, t) => {
      const b = (await c.req.json().catch(() => ({}))) as { clientId?: unknown };
      const cid = typeof b?.clientId === "string" && /^[\w-]{8,64}$/.test(b.clientId) ? b.clientId : undefined;
      return c.json(f.start(t, cid), 201);
    }),
  );
  api.post(
    "/public/feedback/:token/notes/:nid/parts/:n",
    pub(async (c, t) => {
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > FEEDBACK_SEGMENT_MAX_BYTES) return c.json({ error: { code: "too_big", message: "that part is too big" } }, 400);
      const buf = new Uint8Array(await c.req.arrayBuffer());
      return c.json(await f.segment(t, c.req.param("nid") ?? "", Number(c.req.param("n")), buf, c.req.header("content-type") ?? "", Number(c.req.header("x-seconds"))));
    }),
  );
  api.post(
    "/public/feedback/:token/notes/:nid/finish",
    pub(async (c, t) => {
      const p = finishIn.safeParse(await c.req.json().catch(() => ({})));
      if (!p.success) return c.json({ error: { code: "validation_error", message: "parts (1..20) is required" } }, 400);
      const r = f.finish(t, c.req.param("nid") ?? "", p.data);
      return c.json({ state: r.note.state, seconds: r.note.seconds, transcript: r.note.transcript ?? "" });
    }),
  );
  api.post("/public/feedback/:token/notes/:nid/discard", pub((c, t) => c.json({ state: f.discard(t, c.req.param("nid") ?? "").note.state })));
}

// ---------- the page ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The recipient's page: one button, the promise in plain words, works on phone and desktop. No cookie, no third party. */
export function feedbackPage(link: { who: string; product: string } | undefined): string {
  const title = link ? `Tell us about ${esc(link.product)}` : "Link not valid";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${title}</title>
<style>
@font-face{font-family:"Inter";font-weight:400;font-display:swap;src:url(/fonts/inter-400.woff2) format("woff2")}
@font-face{font-family:"Inter";font-weight:500 700;font-display:swap;src:url(/fonts/inter-600.woff2) format("woff2")}
:root{color-scheme:light dark;--ground:#fff;--ink:#09090b;--muted:#71717a;--line:#e4e4e7;--soft:#f4f4f5;--green:hsl(142 72% 26%);--red:hsl(0 72% 51%)}
@media (prefers-color-scheme:dark){:root{--ground:#09090b;--ink:#fafafa;--muted:#a1a1aa;--line:#27272a;--soft:#18181b}}
*{box-sizing:border-box}html,body{margin:0;background:var(--ground);color:var(--ink);font:400 15px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:32rem;margin:0 auto;padding:max(3.5rem,env(safe-area-inset-top)) 1.5rem 4rem}
.brand{font-size:12px;font-weight:500;color:var(--muted);margin:0 0 2rem}
h1{font-size:26px;line-height:1.25;font-weight:650;letter-spacing:-.01em;margin:0 0 .75rem}
p{margin:.5rem 0}.muted{color:var(--muted)}.small{font-size:13px}
.card{margin:3rem 0;text-align:center}
#rec{display:flex;flex-direction:column;align-items:center;gap:1rem;margin:0 auto;padding:0;border:0;background:none;color:var(--ink);font:600 15px/1 Inter,system-ui,sans-serif;cursor:pointer;touch-action:manipulation}
.ring{display:grid;place-items:center;width:7.5rem;height:7.5rem;border-radius:50%;background:var(--green);transition:transform .1s}
#rec:active .ring{transform:scale(.97)}#rec:focus-visible .ring{outline:2px solid var(--ink);outline-offset:4px}#rec:focus{outline:none}
#rec.on .ring{background:var(--red)}#rec:disabled{opacity:.5;cursor:default}
.dot{width:1.5rem;height:1.5rem;border-radius:50%;background:#fff}#rec.on .dot{border-radius:5px;animation:b 1.2s infinite}@keyframes b{50%{opacity:.35}}
#time{font:500 15px/1 Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums;color:var(--muted);margin:1.5rem 0 .4rem}
#status{min-height:1.5rem}
#cancel{display:none;margin:.75rem auto 0;background:none;border:0;color:var(--muted);text-decoration:underline;font:inherit;font-size:13px;cursor:pointer}
#done{display:none;margin:2rem 0 3rem;border:1px solid var(--line);border-radius:12px;padding:1.25rem;text-align:left}
#done pre{white-space:pre-wrap;font:inherit;background:var(--soft);border-radius:8px;padding:1rem;margin:.75rem 0 0;max-height:18rem;overflow:auto}
#again{margin-top:1rem;font:500 14px/1 Inter,system-ui,sans-serif;padding:.7rem 1rem;border:1px solid var(--line);border-radius:8px;background:none;color:var(--ink);cursor:pointer}
.promise{border-top:1px solid var(--line);padding-top:1.5rem}.promise b{font-weight:600}
ul{padding-left:1.1rem;margin:.6rem 0 0;color:var(--muted)}li{margin:.4rem 0}.err{color:var(--red)}
.foot{margin-top:1.5rem}
</style></head><body><main>
${
  link
    ? `<p class="brand">${esc(link.product)} · voice feedback</p>
<h1>${title}</h1>
<p>Hi ${esc(link.who)}. Talk to us like you would leave a voice note to a friend: what works, what is confusing, what is broken, what you wish it did.</p>
<div class="card">
<button id="rec" type="button"><span class="ring"><span class="dot"></span></span><span id="label">Tap to start talking</span></button>
<div id="time">0:00</div><div id="status" class="muted small">Up to ${FEEDBACK_MAX_MIN} minutes. Tap again to send.</div>
<button id="cancel" type="button">Cancel, do not send</button>
</div>
<div id="done"><p><b>Thank you, we got it.</b> This is the text our team will read:</p><pre id="words"></pre><button id="again" type="button">Leave another note</button></div>
<div class="promise small"><b>Our promise</b><ul>
<li>Nobody listens to your voice. We turn it into text, then the audio is thrown away. We never store it.</li>
<li>Our agents read the text, sum it up, and the team acts on it.</li>
<li>To turn it into text, your voice goes to OpenAI, and the text goes there once more to be summed up. They keep it at most 30 days for abuse checks and never train on it.</li>
</ul></div>
<p class="muted small foot">Your microphone is used only while the button is red. This link is just for you.</p>`
    : `<h1>${title}</h1><p>This feedback link is not valid any more. Ask the person who sent it for a new one.</p>`
}
</main>
${link ? `<script>${KEEP_JS}${PAGE_JS.replace(/__SEG__/g, String(FEEDBACK_SEGMENT_S)).replace(/__MAX__/g, String(FEEDBACK_MAX_MIN))}</script>` : ""}
</body></html>`;
}

/** Plain browser JS (no build): parts every __SEG__ s on one microphone stream, each uploaded and retried until it has its text. */
const PAGE_JS = String.raw`
(() => {
  const base = location.pathname.replace(/\/+$/, "");
  const $ = (id) => document.getElementById(id);
  const rec = $("rec"), label = $("label"), time = $("time"), status = $("status"), cancel = $("cancel");
  const SEG = __SEG__ * 1000, MAX = __MAX__ * 60 * 1000;
  let stream, mr, note, t0, tick, segTimer, part = 0, parts = 0, queue = Promise.resolve(), failed = false, stopping = false, partStart = 0, cid, rec0;
  const skip = [], done = [];
  // the note is kept in this browser until we confirm it; a resend lands in the same note, once.
  const KEPT = "Saved on this phone. It is sent by itself as soon as your connection is back: keep this page open, or open the link again later.";
  const keepRec = (p) => (rec0 = Object.assign({}, rec0, p), KEEP.put(rec0));
  const say = (t, err) => { status.textContent = t; status.className = (err ? "err" : "muted") + " small"; };
  const mime = () => ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || "";
  const api = async (path, init) => {
    const r = await fetch(base + path, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || ("Error " + r.status)); e.status = r.status; e.code = j.error && j.error.code; throw e; }
    return j;
  };
  const upload = async (n, blob, seconds) => {
    for (let i = 0; i < 6; i++) {
      try {
        await api("/notes/" + note.id + "/parts/" + n, { method: "POST", headers: { "content-type": blob.type || "audio/webm", "x-seconds": String(seconds) }, body: blob });
        done.push(n); KEEP.dropPart(cid, n); keepRec({ done: done.slice() });
        return;
      } catch (e) {
        if (e.status && e.status < 500 && e.status !== 429) { failed = e.message; return; }
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    failed = "Your connection dropped. Please try again.";
  };
  const startPart = () => {
    const m = mime();
    const r = new MediaRecorder(stream, m ? { mimeType: m, audioBitsPerSecond: 32000 } : undefined);
    const n = part++; const chunks = []; partStart = Date.now();
    r.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    r.onstop = () => {
      const secs = (Date.now() - r._start) / 1000;
      const blob = new Blob(chunks, { type: (r.mimeType || m || "audio/webm").split(";")[0] });
      parts = Math.max(parts, n + 1);
      if (!blob.size) { skip.push(n); return; }
      KEEP.part(cid, n, blob, secs); keepRec({ parts });
      queue = queue.then(() => upload(n, blob, secs));
    };
    r._start = Date.now();
    r.start();
    mr = r;
  };
  const roll = () => { if (!stopping && mr && mr.state === "recording") { const old = mr; startPart(); old.stop(); } };
  const clockText = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const reset = () => { clearInterval(tick); clearInterval(segTimer); if (stream) stream.getTracks().forEach((t) => t.stop()); stream = mr = undefined; rec.classList.remove("on"); label.textContent = "Tap to start talking"; cancel.style.display = "none"; rec.disabled = false; };
  async function start() {
    if (!window.MediaRecorder || !navigator.mediaDevices) { say("This browser cannot record. Please open the link in Chrome or Safari.", true); return; }
    rec.disabled = true; say("Asking for your microphone…");
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { rec.disabled = false; say("We need your microphone to record. Allow it and tap again.", true); return; }
    cid = KEEP.cid(); KEEP.held.add(cid);
    try { note = (await api("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: cid }) })).note; }
    catch (e) { KEEP.held.delete(cid); reset(); say(e.message, true); return; }
    rec0 = { cid, base, id: note.id, parts: 0, done: [] }; KEEP.put(rec0);
    part = 0; parts = 0; skip.length = 0; done.length = 0; failed = false; stopping = false; queue = Promise.resolve();
    startPart();
    t0 = Date.now(); rec.disabled = false; rec.classList.add("on"); label.textContent = "Tap to send"; cancel.style.display = "block";
    say("Recording. Take your time.");
    tick = setInterval(() => { const el = Date.now() - t0; time.textContent = clockText(el); if (el >= MAX) stop(); }, 250);
    segTimer = setInterval(roll, SEG);
  }
  async function stop() {
    if (stopping) return; stopping = true;
    clearInterval(tick); clearInterval(segTimer);
    rec.disabled = true; cancel.style.display = "none"; label.textContent = "Sending…"; say("Turning your voice into text…");
    await new Promise((r) => { mr.addEventListener("stop", () => setTimeout(r, 0), { once: true }); mr.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    await queue;
    await keepRec({ parts, send: true });
    if (failed) { kept(); return; }
    try {
      say("Saved on this phone, sending…");
      const r = await api("/notes/" + note.id + "/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts, skip }) });
      await KEEP.drop(cid); KEEP.held.delete(cid);
      reset();
      if (r.state === "empty") { say("We could not hear anything. Please try again a bit closer to the microphone.", true); return; }
      shown(r.transcript);
    } catch (e) { kept(e.message); }
  }
  const shown = (words) => { $("words").textContent = words; $("done").style.display = "block"; document.querySelector(".card").style.display = "none"; };
  const kept = (why) => { KEEP.held.delete(cid); reset(); say(KEPT + (why ? " (" + why + ")" : "")); later(); };
  let timer;
  const later = () => { if (!timer) timer = setInterval(sendKept, 20000); };
  async function sendKept(force) {
    const n = await KEEP.drain({
      base,
      force: force === true,
      start: async (r) => (await api("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: r.cid }) })).note.id,
      segment: (id, p) => api("/notes/" + id + "/parts/" + p.n, { method: "POST", headers: { "content-type": p.blob.type || "audio/webm", "x-seconds": String(p.seconds) }, body: p.blob }),
      finish: (id, n, sk) => api("/notes/" + id + "/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: n, skip: sk }) }),
      after: async (r) => { if (r.transcript) shown(r.transcript); },
    });
    const left = (await KEEP.waiting(base)).length;
    if (n && !left) say("✓ Sent: your kept voice note reached us. Thank you!");
    else if (left) { say(left + " voice note" + (left > 1 ? "s" : "") + " saved on this phone, sending…"); later(); }
    if (!left && timer) { clearInterval(timer); timer = undefined; }
  }
  async function abort() {
    stopping = true; clearInterval(tick); clearInterval(segTimer);
    try { mr && mr.state === "recording" && (mr.onstop = null, mr.stop()); } catch (e) {}
    reset(); time.textContent = "0:00";
    if (cid) { KEEP.held.delete(cid); await KEEP.drop(cid); }
    if (note) await api("/notes/" + note.id + "/discard", { method: "POST" }).catch(() => {});
    say("Cancelled. Nothing was sent.");
  }
  rec.addEventListener("click", () => (rec.classList.contains("on") ? stop() : start()));
  cancel.addEventListener("click", abort);
  $("again").addEventListener("click", () => { $("done").style.display = "none"; document.querySelector(".card").style.display = "block"; time.textContent = "0:00"; say("Up to __MAX__ minutes. Tap again to send."); });
  // A locked phone may pause the page: cut the part on hide so what was said is uploaded at once.
  document.addEventListener("visibilitychange", () => { if (document.hidden) roll(); });
  window.addEventListener("online", () => void sendKept(true));
  void sendKept();
})();
`;
