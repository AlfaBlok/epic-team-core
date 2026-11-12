import type { DB } from "../db.js";
import { anthropicJson } from "../textModel.js";
import { ownerName } from "../identity.js";
import { TRANSCRIPT_MAX } from "../desk/voiceNotes.js";

/**
 * A voice note he records on one item (an ask or review card's box, a slide's note, a milestone chat) goes to
 * that item, and before this nothing looked at the rest of what he said: his note reached five rows only because the
 * Delivery Manager split it by hand.
 *
 * Now, once a note is filed on an item, a small model reads it with the item's name and says whether it speaks of anything
 * beyond that item. If it does, the world's Team desk gets ONE line, `📎 Also in this note`, with the other parts in a few
 * words, where he said it and the link to his recording, so the desk's Delivery Manager places the rest (other rows, asks,
 * epics). Once per note (the note id is the key); a desk that is busy or down is tried again for an hour. A note recorded in
 * the Team desk's own Chat never comes here: the desk already reads all of it.
 *
 * The model is the console's OpenAI key (gpt-4o-mini, the same check as's settles) until the console holds an
 * Anthropic key, then Haiku; the judge is passed in, so the swap is one line in app.ts.
 */

export const SPILL_MODEL = "gpt-4o-mini";
export const SPILL_HEAD = "📎 Also in this note";
/** A desk that refused the line (busy seat, no live thread) is tried again this often, for at most SPILL_MAX_TRIES. */
export const SPILL_RETRY_MS = 2 * 60_000;
export const SPILL_MAX_TRIES = 30;
/** The words the model reads (a 30-minute note is about 4,500 words; the rest is rarely about the item). */
const WORDS_MAX = 12_000;

export interface SpillNote {
  /** The note's id (`vn_…`), the key. */
  id: string;
  world: string;
  milestoneId?: string;
  /** Where he said it, as the page named it: `card: <question>`, `product slide 3`, `Chat` (a milestone chat). */
  where: string;
  /** His words. */
  words: string;
  /** The link to his recording. */
  audio?: string;
  /** this world's desk has a desk across (EpicTeam ↔ the social product); filled by the spill from `deps.across`. */
  across?: SpillAcross;
}

/**
 * a note he answers on a card in a paired world. The check counts the other product's work as beyond the card, and the
 * `📎` line tells the card's own desk to pass that part itself through its relay (root L-55: no router; the desk decides), keyed
 * on the note id so it crosses once, and to tell him in one line.
 */
export interface SpillAcross {
  /** The product this world's desk is (the card's). */
  here: string;
  hereIs: string;
  /** The other desk's product, and what it does. */
  there: string;
  thereIs: string;
  /** The relay route this desk calls (absolute URL) and the header it sends. */
  passUrl: string;
  passHeader: string;
  /** A world desk's token header (`-H "Authorization: Bearer $(cat <its token file>)"`); none on the home world's Team desk. */
  auth?: string;
}

export interface SpillVerdict {
  /** True when the note speaks of anything beyond the item it was recorded on. */
  beyond: boolean;
  /** The other parts in a few plain words each, `;` between them (empty when none). */
  rest: string;
}
export type SpillJudge = (n: SpillNote) => Promise<SpillVerdict>;
export type SpillState = "judging" | "none" | "pending" | "told" | "failed";

export function ensureSpillTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_note_spills (
      note_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      milestone_id TEXT,
      at TEXT NOT NULL,
      page TEXT,
      state TEXT NOT NULL,
      rest TEXT,
      line TEXT,
      tries INTEGER NOT NULL DEFAULT 0,
      next_at TEXT,
      told_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS voice_note_spills_due ON voice_note_spills (state, next_at);
  `);
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * His words for one desk line, whole up to the desk's message size (TRANSCRIPT_MAX, the same as a WhatsApp note). They were cut
 * at 3,000 characters before; a note longer than a desk message says so and names the note, never ends silently.
 */
export function wholeWords(words: string, id: string): string {
  const w = oneLine(words);
  if (w.length <= TRANSCRIPT_MAX) return w;
  return `${w.slice(0, TRANSCRIPT_MAX)} [cut here: the first ${TRANSCRIPT_MAX.toLocaleString("en-US")} of ${w.length.toLocaleString("en-US")} characters; the whole note is ${id}]`;
}

/** The one Team desk line. */
export function spillLine(n: SpillNote, rest: string): string {
  const where = oneLine(n.where).slice(0, 160) || "an item";
  const x = n.across;
  return [
    `${SPILL_HEAD} (${n.id}): ${oneLine(rest).replace(/[.\s]+$/, "")}.`,
    `${ownerName()} recorded this voice note on ${where}; that part went there and its owner has it.`,
    `Delivery Manager: place each other part as you place his voice notes (an existing row or ask gets his words, a new ask becomes a row, L-37), then reply in one line with where each landed, links first. Note id ${n.id}${n.audio ? `, recording ${n.audio}` : ""}.`,
    ...(x
      ? [
          `A part that is the ${x.there} desk's work (${x.thereIs}) is not placed here: you pass it yourself, now, with the relay (root L-55, no router): \`curl ${x.auth ? `${x.auth} ` : ""}-sS -X POST ${x.passUrl} -H '${x.passHeader}' -H 'content-type: application/json' -d '{"about":"<a few plain words>","quote":"<his words for that part, exactly as he said them>","clientRequestId":"${n.id}"}'\` (once per note: the note id is its key), then tell him in one line: "Passed to the ${x.there} desk: <what> (from your note on ${where.replace(/["\\]/g, "")})". What is ${x.here}'s (${x.hereIs}) stays here. When unsure whose a part is, keep it here and ask him in one line; pass only on his yes.`,
        ]
      : []),
    "",
    `His words: ${wholeWords(n.words, n.id)}`,
  ].join("\n");
}

export interface SpillDeps {
  db: DB;
  /** The model check; absent = off (nothing is judged, nothing told). */
  judge?: SpillJudge;
  /** One line into the world's Team desk chat: true once it took it, else why not. */
  tell?: (world: string, text: string, id: string) => Promise<true | string>;
  /** the desk across from this world, when it has one (the relay's pair). */
  across?: (world: string) => SpillAcross | undefined;
  now?: () => number;
}

export function createVoiceSpill(d: SpillDeps) {
  const { db } = d;
  ensureSpillTables(db);
  const now = () => (d.now ? d.now() : Date.now());
  const iso = (t = now()) => new Date(t).toISOString();
  let sweeping: Promise<number> | undefined;

  const tellOne = async (id: string): Promise<void> => {
    const r = db.prepare("SELECT tenant_id, line, tries FROM voice_note_spills WHERE note_id = ?").get(id) as { tenant_id: string; line: string; tries: number } | undefined;
    if (!r || !d.tell) return;
    const ok = await d.tell(r.tenant_id, r.line, `voice-spill-${id}`).catch((e: Error) => e.message);
    const tries = r.tries + 1;
    if (ok === true) db.prepare("UPDATE voice_note_spills SET state = 'told', tries = ?, told_at = ?, next_at = NULL, error = NULL WHERE note_id = ?").run(tries, iso(), id);
    else
      db.prepare("UPDATE voice_note_spills SET state = ?, tries = ?, next_at = ?, error = ? WHERE note_id = ?").run(
        tries >= SPILL_MAX_TRIES ? "failed" : "pending",
        tries,
        tries >= SPILL_MAX_TRIES ? null : iso(now() + SPILL_RETRY_MS),
        String(ok).slice(0, 300),
        id,
      );
  };

  return {
    /** A note was filed on an item: judge it once, and tell the desk the rest. Never throws; resolves when done. */
    async filed(n: SpillNote): Promise<SpillState | undefined> {
      if (!d.judge || !n.words.trim()) return undefined;
      const had = db.prepare("SELECT state FROM voice_note_spills WHERE note_id = ?").get(n.id) as { state: SpillState } | undefined;
      if (had) return had.state;
      // claim the note first, so a second finish (a retry) never judges or tells twice
      db.prepare("INSERT INTO voice_note_spills (note_id, tenant_id, milestone_id, at, page, state) VALUES (?, ?, ?, ?, ?, 'judging')").run(n.id, n.world, n.milestoneId ?? null, iso(), n.where.slice(0, 200));
      const across = n.across ?? d.across?.(n.world);
      if (across) n = { ...n, across };
      let v: SpillVerdict;
      try {
        v = await d.judge({ ...n, words: n.words.slice(0, WORDS_MAX) });
      } catch (e) {
        db.prepare("UPDATE voice_note_spills SET state = 'failed', error = ? WHERE note_id = ?").run(`model: ${(e as Error).message}`.slice(0, 300), n.id);
        return "failed";
      }
      const rest = oneLine(v.rest ?? "");
      if (!v.beyond || !rest) {
        db.prepare("UPDATE voice_note_spills SET state = 'none', rest = NULL WHERE note_id = ?").run(n.id);
        return "none";
      }
      db.prepare("UPDATE voice_note_spills SET state = 'pending', rest = ?, line = ?, next_at = ? WHERE note_id = ?").run(rest.slice(0, 1000), spillLine(n, rest), iso(), n.id);
      await tellOne(n.id);
      return (db.prepare("SELECT state FROM voice_note_spills WHERE note_id = ?").get(n.id) as { state: SpillState }).state;
    },
    /** Lines the desk refused, tried again (the console's minute timer). */
    sweep(): Promise<number> {
      sweeping ??= (async () => {
        const due = db.prepare("SELECT note_id FROM voice_note_spills WHERE state = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 20").all(iso()) as { note_id: string }[];
        for (const r of due) await tellOne(r.note_id);
        return due.length;
      })().finally(() => {
        sweeping = undefined;
      });
      return sweeping;
    },
    /** One note's check, for the status route and tests. */
    get(id: string) {
      return db.prepare("SELECT * FROM voice_note_spills WHERE note_id = ?").get(id) as Record<string, unknown> | undefined;
    },
  };
}
export type VoiceSpill = ReturnType<typeof createVoiceSpill>;

const SPILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["beyond", "rest"],
  properties: {
    beyond: { type: "boolean", description: "true when the note also asks for, decides or reports something that is not about the item it was recorded on." },
    rest: { type: "string", description: "Only those other parts, each in a few plain words naming its topic and what he wants, separated by '; '. Empty when beyond is false." },
  },
};

/** The check's instructions and the note, the same words on either provider. */
const SPILL_SYSTEM =
  "A product owner recorded a voice note as his answer on one item of his team's work (a question card, a review card, a slide, a chat). " +
  "The item's owner will act on the part about that item. You find what else he said: requests, decisions, bugs, ideas or changes about OTHER things " +
  "(another feature, ticket, product, page, person or process). Say beyond=true only for such a part he means to be acted on; " +
  "context, examples or reasons that only support his answer on this item are not beyond. When in doubt about a clear separate request, say true. " +
  "List only the other parts, each in a few plain words.";
const spillUser = (n: SpillNote): string =>
  [
    `Recorded on: ${oneLine(n.where).slice(0, 300)}`,
    // the other product's work is always beyond an item of this one (it goes to the other desk).
    ...(n.across
      ? [
          `This item is ${n.across.here}'s (${n.across.hereIs}). He also runs ${n.across.there} (${n.across.thereIs}), on a separate desk: any request he means for ${n.across.there} is beyond this item, even when it is about this item's subject (say "for ${n.across.there}: <what>").`,
        ]
      : []),
    "",
    `His words (speech to text):\n${n.words}`,
  ].join("\n");

/** OpenAI's strict JSON check, the console's own key (the same key voice notes and settles use). */
export function openAiSpillJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch, model = SPILL_MODEL): SpillJudge {
  return async (n) => {
    const k = await key();
    if (!k) throw new Error("the console has no OPENAI_API_KEY");
    const body = {
      model,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "spill", strict: true, schema: SPILL_SCHEMA } },
      messages: [
        {
          role: "system",
          content: SPILL_SYSTEM,
        },
        { role: "user", content: spillUser(n) },
      ],
    };
    const r = await f("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    const text = j?.choices?.[0]?.message?.content;
    if (!r.ok || typeof text !== "string") throw new Error(`the model check failed (${r.status}): ${String(j?.error?.message ?? "no message").slice(0, 160)}`);
    const v = JSON.parse(text) as SpillVerdict;
    return { beyond: v.beyond === true, rest: String(v.rest ?? "") };
  };
}

/** The same check on Claude Haiku 5.5, the credit account (`CONSOLE_TEXT_MODEL_PROVIDER=anthropic`). */
export function anthropicSpillJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch): SpillJudge {
  return async (n) => {
    const { value: v } = await anthropicJson<SpillVerdict>(key, f, { system: SPILL_SYSTEM, user: spillUser(n), schema: SPILL_SCHEMA, maxTokens: 2000, timeoutMs: 45_000 });
    return { beyond: v.beyond === true, rest: String(v.rest ?? "") };
  };
}
