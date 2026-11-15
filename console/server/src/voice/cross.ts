import { createHash } from "node:crypto";
import type { DB } from "../db.js";
import { anthropicJson } from "../textModel.js";
import { SOCIAL_HEAD, TEAM_HEAD } from "../brand.js";
import { SPILL_HEAD, SPILL_MODEL, wholeWords } from "./spill.js";
import { TRANSCRIPT_MAX } from "../desk/voiceNotes.js";
import { homeWorld, ownerName, socialProduct, socialWorld } from "../identity.js";

/**
 * EpicTeam's Team desk
 * (world the home world) and the social product's desk (its own world, a social world repo) are two chats on one console. Before this the owner was the
 * router: a line about a post said to the EpicTeam desk stayed there, and the desk-to-desk inbox crossed only on the
 * other side's next wake.'s spill (spill.ts) hands the rest of a card note on, but only inside one world.
 *
 * Now every message the owner sends to either desk (typed, or a voice note recorded in that Chat) is read once by a small model
 * that knows both products and the other world's campaigns. When part of it belongs to the other desk, that part goes there
 * at once as ONE message, `↔ From the EpicTeam desk (dx_…)`, quoting his words with a link back to the desk he said it in,
 * and the desk he spoke to gets one `↔ Passed to the social product desk` line so it tells him where it went.
 *
 * Never twice: the message key (his send's request id, else his words' hash) is claimed before the model runs. Never a loop:
 * only his own sends from the chat page are read (a desk's replies and the console's notes never come here), and anything
 * starting with a console head (↔, 📎, `[`) is skipped as well, so a passed message is never passed back. Only between the two
 * worlds of one pair (CONSOLE_DESK_PAIRS, default the home world and a social world repo) and only when both are the same owner's and
 * internal: never into a customer's world.
 *
 * the model router above is OFF unless `auto` is set (CONSOLE_DESK_CROSS=1, only on the owner's word): it had sent
 * EpicTeam work (browser-use research, a voice-infra post) to the social product desk just because it named X or a post. Every
 * message now reaches the desk he spoke to whole; that desk decides what belongs to the other one and passes it itself with
 * `pass` (POST /api/desk/pass, the relay), quoting him, and tells him in one line. The same delivery, retries and table.
 */

export const CROSS_MODEL = SPILL_MODEL;
export const CROSS_HEAD = "↔ From the";
export const CROSS_PASSED_HEAD = "↔ Passed to the";
/** A desk that refused the line (busy seat, no live thread) is tried again this often, for at most CROSS_MAX_TRIES. */
export const CROSS_RETRY_MS = 2 * 60_000;
export const CROSS_MAX_TRIES = 30;
/**
 * The line back goes only once his message is in the desk's thread (its turn started), so it never lands before his message:
 * in the live checks (dx_b2e50f3e, dx_a4cb5e9b) a desk busy launching or updating read the line first, answered his message
 * as if nothing had crossed. Not in yet: looked at again this soon, and sent anyway after CROSS_NOTE_MAX_WAIT_MS.
 */
export const CROSS_NOTE_WAIT_MS = 30_000;
export const CROSS_NOTE_MAX_WAIT_MS = 10 * 60_000;
/** The default pair: the owner's two desks. `a:b` pairs, `,` between pairs; `CONSOLE_DESK_PAIRS=` (empty) turns crossing off. */
export const defaultDeskPairs = (): string => `${homeWorld()}:${socialWorld()}`;
const WORDS_MAX = 12_000;
/** A message this short ("ok", "yes go") is an answer in the chat, never a part for the other desk. */
const WORDS_MIN = 4;
/** Console and persona heads: never his words to judge (and never passed back). */
const SKIP_HEADS = ["↔", SPILL_HEAD, "📎", "[", "📞"];

/** a desk's product name: the team product (TEAM_HEAD.name) or the social product (socialProduct()) */
export type Product = string;
/** each desk's work in a few words, the same split as the desks' own rule: who gets which part. */
export const productWork = (p: Product): string =>
  p === socialProduct()
    ? "promoting: campaigns, posts and replies to write, schedule or change, DMs, followers, the social tone and targets"
    : "building and fixing his products: software, the console, pages, sites, servers, tools, product and infra research";
export interface DeskSide {
  world: string;
  product: Product;
  /** The desk's chat page, the link back. */
  url: string;
}
export interface CrossSaid {
  /** The desk he spoke to. */
  world: string;
  words: string;
  /** His send's request id (the chat page's clientRequestId, a voice note's id). */
  requestId?: string;
  /** His message was not in the desk's thread yet when this was called (T3 still sending it, or queued). */
  pending?: boolean;
}
export interface CrossVerdict {
  /** True when part of what he said belongs to the other desk. */
  other: boolean;
  /** That part in his own words, as he said it (empty when none). */
  quote: string;
  /** The same part in a few plain words. */
  about: string;
}
export interface CrossJudgeInput {
  from: DeskSide;
  to: DeskSide;
  /** The other world's campaigns and jobs, by title. */
  toMilestones: string[];
  words: string;
}
export type CrossJudge = (n: CrossJudgeInput) => Promise<CrossVerdict>;
export type CrossState = "judging" | "none" | "pending" | "passed" | "failed";

export function ensureCrossTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_crossings (
      id TEXT PRIMARY KEY,
      msg_key TEXT NOT NULL UNIQUE,
      from_world TEXT NOT NULL,
      to_world TEXT NOT NULL,
      at TEXT NOT NULL,
      state TEXT NOT NULL,
      about TEXT,
      quote TEXT,
      line TEXT,
      note TEXT,
      tries INTEGER NOT NULL DEFAULT 0,
      next_at TEXT,
      passed_at TEXT,
      note_at TEXT,
      noted_at TEXT,
      said_head TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS desk_crossings_due ON desk_crossings (state, next_at);
  `);
  const cols = (db.prepare("PRAGMA table_info(desk_crossings)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("note_at")) db.exec("ALTER TABLE desk_crossings ADD COLUMN note_at TEXT");
  if (!cols.includes("said_head")) db.exec("ALTER TABLE desk_crossings ADD COLUMN said_head TEXT");
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const stop = (s: string) => oneLine(s).replace(/[.\s]+$/, "");

/** `a:b,c:d` → both directions; a world in two pairs keeps its first. */
export function parsePairs(spec: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of (spec ?? defaultDeskPairs()).split(",")) {
    const [a, b] = p.split(":").map((s) => s.trim());
    if (!a || !b || a === b || out.has(a) || out.has(b)) continue;
    out.set(a, b).set(b, a);
  }
  return out;
}

/** The message the other desk gets: who said it where, his words quoted, the link back. */
export function crossLine(id: string, from: DeskSide, to: DeskSide, about: string, quote: string): string {
  return [
    `${CROSS_HEAD} ${from.product} desk (${id}): ${stop(about)}.`,
    `${ownerName()} said this to his ${from.product} desk (${from.url}); the console passed this part to you, the ${to.product} desk, because it belongs here. The rest stayed there.`,
    `Act on it as on his own words in this chat (his ask is ready), then reply in one line with what you did, links first. Never pass it back and never drop a desk note for it: it already crossed.`,
    "",
    `His words: "${wholeWords(quote, id)}"`,
  ].join("\n");
}

/** the message the other desk gets when the desk he spoke to passed a part itself (the relay). */
export function relayLine(id: string, from: DeskSide, to: DeskSide, about: string, quote: string): string {
  return [
    `${CROSS_HEAD} ${from.product} desk (${id}): ${stop(about)}.`,
    `${ownerName()} said this to his ${from.product} desk (${from.url}); that desk decided this part belongs to you, the ${to.product} desk, and passed it. The rest stayed there.`,
    `Act on it as on his own words in this chat (his ask is ready), then reply in one line with what you did, links first. Never pass it back and never drop a desk note for it: it already crossed.`,
    "",
    `His words: "${wholeWords(quote, id)}"`,
  ].join("\n");
}

/** The one line the desk he spoke to gets, so it tells him where the part went. */
export function passedLine(id: string, _from: DeskSide, to: DeskSide, about: string): string {
  return [
    `${CROSS_PASSED_HEAD} ${to.product} desk (${id}): ${stop(about)}.`,
    `The console passed this part of ${ownerName()}'s newest message (it may reach you just before or after it) to his ${to.product} desk (${to.url}), quoting him; it acts on it there. Do not act on that part here and do not drop a desk note for it. Tell him in one line: "Passed to the ${to.product} desk: ${stop(about)} (${to.url})".`,
  ].join("\n");
}

/**
 * the receipt the desk that passed a part (the relay) gets once the line is in the other desk's chat, so the owner
 * sees in the chat he used that it landed. `{at}` is filled at delivery.
 */
export function relayReceiptLine(id: string, to: DeskSide, about: string): string {
  return [
    `${CROSS_PASSED_HEAD} ${to.product} desk (${id}): landed in its chat, {at}, ${stop(about)}.`,
    `The part of ${ownerName()}'s words this desk passed by the relay is now in his ${to.product} desk's chat (${to.url}), which acts on it there. Do nothing else. Reply in one line: "Landed at the ${to.product} desk: ${stop(about)}, {at}".`,
  ].join("\n");
}

export interface CrossDeps {
  db: DB;
  /** The model check; absent = off. */
  judge?: CrossJudge;
  /** the automatic router (`said`) runs only when true; absent = off. `pass`, the desk's own relay, always works. */
  auto?: boolean;
  /** One message into a world's desk chat: true once it took it, else why not. */
  tell?: (world: string, text: string, id: string) => Promise<true | string>;
  /** Whether his message (its first words) is in that desk's thread yet; absent = assume it is. */
  landed?: (world: string, head: string) => Promise<boolean>;
  /** CONSOLE_DESK_PAIRS (default the home world:a social world repo). */
  pairs?: string;
  now?: () => number;
}

interface TenantRow {
  id: string;
  skin: string;
  plan: string;
  owner_handle: string;
  paused: number;
}

export function createDeskCross(d: CrossDeps) {
  const { db } = d;
  ensureCrossTables(db);
  const pairs = parsePairs(d.pairs);
  const now = () => (d.now ? d.now() : Date.now());
  const iso = (t = now()) => new Date(t).toISOString();
  let sweeping: Promise<number> | undefined;

  const tenant = (id: string) => db.prepare("SELECT id, skin, plan, owner_handle, paused FROM tenants WHERE id = ?").get(id) as TenantRow | undefined;
  const side = (t: TenantRow): DeskSide =>
    t.skin === "social" ? { world: t.id, product: socialProduct(), url: `${SOCIAL_HEAD.origin}/chat` } : { world: t.id, product: TEAM_HEAD.name, url: `${TEAM_HEAD.origin}/chat` };

  /** The desk across from `world`, only when both worlds are one owner's own (internal, live) and of two products. */
  const across = (world: string): { from: DeskSide; to: DeskSide } | undefined => {
    const other = pairs.get(world);
    if (!other) return undefined;
    const a = tenant(world);
    const b = tenant(other);
    if (!a || !b || a.paused || b.paused) return undefined;
    if (a.plan !== "internal" || b.plan !== "internal" || a.owner_handle !== b.owner_handle) return undefined;
    const from = side(a);
    const to = side(b);
    return from.product === to.product ? undefined : { from, to };
  };

  /** The line back to the desk he spoke to: once, best effort (the part already crossed), only after his message is in. */
  const noteBack = async (id: string): Promise<void> => {
    const r = db.prepare("SELECT from_world, note, note_at, noted_at, said_head, at FROM desk_crossings WHERE id = ? AND state = 'passed'").get(id) as
      | { from_world: string; note: string; note_at: string | null; noted_at: string | null; said_head: string | null; at: string }
      | undefined;
    if (!r || r.noted_at || !r.note || !d.tell || (r.note_at && r.note_at > iso())) return;
    const late = now() - Date.parse(r.at) >= CROSS_NOTE_MAX_WAIT_MS;
    if (!late && d.landed && r.said_head && !(await d.landed(r.from_world, r.said_head).catch(() => false))) {
      db.prepare("UPDATE desk_crossings SET note_at = ? WHERE id = ?").run(iso(now() + CROSS_NOTE_WAIT_MS), id);
      return;
    }
    const told = await d.tell(r.from_world, r.note.replaceAll("{at}", `${iso().slice(11, 16)}Z`), `desk-cross-${id}-passed`).catch((e: Error) => e.message);
    if (told === true) db.prepare("UPDATE desk_crossings SET noted_at = ?, error = NULL WHERE id = ?").run(iso(), id);
    else db.prepare("UPDATE desk_crossings SET noted_at = ?, error = ? WHERE id = ?").run(iso(), `passed; the note back: ${String(told)}`.slice(0, 300), id);
  };

  const deliver = async (id: string): Promise<void> => {
    const r = db.prepare("SELECT from_world, to_world, line, note, tries, passed_at FROM desk_crossings WHERE id = ?").get(id) as
      | { from_world: string; to_world: string; line: string; note: string; tries: number; passed_at: string | null }
      | undefined;
    if (!r || !d.tell) return;
    const ok = r.passed_at ? true : await d.tell(r.to_world, r.line, `desk-cross-${id}`).catch((e: Error) => e.message);
    const tries = r.tries + 1;
    if (ok !== true) {
      db.prepare("UPDATE desk_crossings SET state = ?, tries = ?, next_at = ?, error = ? WHERE id = ?").run(
        tries >= CROSS_MAX_TRIES ? "failed" : "pending",
        tries,
        tries >= CROSS_MAX_TRIES ? null : iso(now() + CROSS_RETRY_MS),
        String(ok).slice(0, 300),
        id,
      );
      return;
    }
    db.prepare("UPDATE desk_crossings SET state = 'passed', tries = ?, passed_at = COALESCE(passed_at, ?), next_at = NULL, error = NULL WHERE id = ?").run(tries, iso(), id);
    // the desk he spoke to says where it went (now, or on the sweep once his own message has surely landed)
    await noteBack(id);
  };

  return {
    /** The desk across from this one, when it has one (for routes and tests). */
    across,
    /** the owner sent a message to a desk: judge it once and pass the other desk's part across. Never throws. */
    async said(s: CrossSaid): Promise<CrossState | undefined> {
      if (!d.auto || !d.judge) return undefined;
      const words = s.words.trim();
      if (!words || SKIP_HEADS.some((h) => words.startsWith(h))) return undefined;
      if (words.split(/\s+/).length < WORDS_MIN) return undefined;
      const pair = across(s.world);
      if (!pair) return undefined;
      const msgKey = `${s.world}:${s.requestId?.trim() || createHash("sha256").update(words).digest("hex").slice(0, 32)}`;
      const id = `dx_${createHash("sha256").update(msgKey).digest("hex").slice(0, 8)}`;
      // claim the message first, so a retried send never judges or passes twice
      const claimed = db
        .prepare("INSERT OR IGNORE INTO desk_crossings (id, msg_key, from_world, to_world, at, state) VALUES (?, ?, ?, ?, ?, 'judging')")
        .run(id, msgKey, pair.from.world, pair.to.world, iso()).changes;
      if (!claimed) return (db.prepare("SELECT state FROM desk_crossings WHERE msg_key = ?").get(msgKey) as { state: CrossState }).state;
      const toMilestones = (db.prepare("SELECT title FROM milestones WHERE tenant_id = ? ORDER BY title LIMIT 40").all(pair.to.world) as { title: string }[]).map((m) => m.title);
      let v: CrossVerdict;
      try {
        v = await d.judge({ from: pair.from, to: pair.to, toMilestones, words: words.slice(0, WORDS_MAX) });
      } catch (e) {
        db.prepare("UPDATE desk_crossings SET state = 'failed', error = ? WHERE id = ?").run(`model: ${(e as Error).message}`.slice(0, 300), id);
        return "failed";
      }
      const quote = oneLine(v.quote ?? "");
      const about = oneLine(v.about ?? "") || quote.slice(0, 120);
      if (!v.other || !quote) {
        db.prepare("UPDATE desk_crossings SET state = 'none' WHERE id = ?").run(id);
        return "none";
      }
      db.prepare("UPDATE desk_crossings SET state = 'pending', about = ?, quote = ?, line = ?, note = ?, next_at = ?, note_at = ? WHERE id = ?").run(
        about.slice(0, 300),
        quote.slice(0, TRANSCRIPT_MAX),
        crossLine(id, pair.from, pair.to, about, quote),
        passedLine(id, pair.from, pair.to, about),
        iso(),
        s.pending ? iso(now() + CROSS_NOTE_WAIT_MS) : null,
        id,
      );
      db.prepare("UPDATE desk_crossings SET said_head = ? WHERE id = ?").run(oneLine(words).slice(0, 80), id);
      await deliver(id);
      return (db.prepare("SELECT state FROM desk_crossings WHERE id = ?").get(id) as { state: CrossState }).state;
    },
    /**
     * the desk he spoke to passes a part of his words itself (it judged it the other desk's work). No model; the same
     * delivery and retries; once the line is in, the desk that passed it gets a receipt line. Never twice for one requestId. undefined = no desk across.
     */
    async pass(p: { world: string; about: string; quote: string; requestId?: string }): Promise<{ id: string; state: CrossState; to: DeskSide } | undefined> {
      const pair = across(p.world);
      const quote = oneLine(p.quote);
      if (!pair || !quote) return undefined;
      const about = oneLine(p.about) || quote.slice(0, 120);
      const msgKey = `pass:${p.world}:${p.requestId?.trim() || createHash("sha256").update(quote).digest("hex").slice(0, 32)}`;
      const id = `dx_${createHash("sha256").update(msgKey).digest("hex").slice(0, 8)}`;
      const claimed = db
        .prepare(
          "INSERT OR IGNORE INTO desk_crossings (id, msg_key, from_world, to_world, at, state, about, quote, line, note, next_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
        )
        .run(id, msgKey, pair.from.world, pair.to.world, iso(), about.slice(0, 300), quote.slice(0, TRANSCRIPT_MAX), relayLine(id, pair.from, pair.to, about, quote), relayReceiptLine(id, pair.to, about), iso()).changes;
      if (claimed) await deliver(id);
      const state = (db.prepare("SELECT state FROM desk_crossings WHERE msg_key = ?").get(msgKey) as { state: CrossState }).state;
      return { id, state, to: pair.to };
    },
    /** Lines a desk refused, tried again (the console's minute timer). */
    sweep(): Promise<number> {
      sweeping ??= (async () => {
        const due = db.prepare("SELECT id FROM desk_crossings WHERE state = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 20").all(iso()) as { id: string }[];
        for (const r of due) await deliver(r.id);
        const notes = db.prepare("SELECT id FROM desk_crossings WHERE state = 'passed' AND noted_at IS NULL AND note IS NOT NULL AND (note_at IS NULL OR note_at <= ?) ORDER BY at LIMIT 20").all(iso()) as { id: string }[];
        for (const r of notes) await noteBack(r.id);
        return due.length + notes.length;
      })().finally(() => {
        sweeping = undefined;
      });
      return sweeping;
    },
    get(id: string) {
      return db.prepare("SELECT * FROM desk_crossings WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    },
    /** The newest crossings, for the status route. */
    recent(limit = 20) {
      return db.prepare("SELECT id, from_world, to_world, at, state, about, tries, passed_at, note_at, noted_at, error FROM desk_crossings ORDER BY at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    },
  };
}
export type DeskCross = ReturnType<typeof createDeskCross>;

const productLines = (): string =>
  `${TEAM_HEAD.name}: the agent team that builds his products: software, features, bugs, the console, pages, sites, servers, keys, tickets, epics and reviews. ` +
  `${socialProduct()}: his social media team: campaigns, posts and drafts, threads, replies and DMs on X, Reddit, LinkedIn and the like, followers, accounts, tone of voice, what to post and when.`;

const CROSS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["other", "quote", "about"],
  properties: {
    other: { type: "boolean", description: "true when part of the message asks for, decides or reports something the OTHER desk's team should act on." },
    quote: { type: "string", description: "Only that part, in his own words exactly as written (whole sentences, joined with a space). Empty when other is false." },
    about: { type: "string", description: "That part in a few plain words naming what he wants. Empty when other is false." },
  },
};

/** The check's instructions and his message, the same words on either provider. */
const crossSystem = (n: CrossJudgeInput): string =>
  `A product owner runs two products, each with its own team and its own chat desk. ${productLines()} ` +
  `He wrote this message in the ${n.from.product} desk. Find the part that the ${n.to.product} team should act on: a request, decision, idea or report about its work ` +
  `(it may name ${n.to.product}, one of its campaigns, or plainly be its kind of work). Say other=true only for such a part he means to be acted on. ` +
  `Building or fixing the ${n.to.product} product itself (its screens, its code, its bugs) is ${TEAM_HEAD.name}'s work; promoting or posting about any product is ${socialProduct()}'s. ` +
  "Mentions that only give context to the rest are not a part. Quote his words exactly; never add words.";
const crossUser = (n: CrossJudgeInput): string =>
  `The ${n.to.product} team's campaigns and jobs: ${n.toMilestones.length ? n.toMilestones.map((t) => oneLine(t).slice(0, 80)).join("; ") : "(none listed)"}\n\nHis message to the ${n.from.product} desk:\n${n.words}`;

/** OpenAI's strict JSON check, the console's own key (the same key and model as the spill). */
export function openAiCrossJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch, model = CROSS_MODEL): CrossJudge {
  return async (n) => {
    const k = await key();
    if (!k) throw new Error("the console has no OPENAI_API_KEY");
    const body = {
      model,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "cross", strict: true, schema: CROSS_SCHEMA } },
      messages: [
        {
          role: "system",
          content: crossSystem(n),
        },
        {
          role: "user",
          content: crossUser(n),
        },
      ],
    };
    const r = await f("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    const text = j?.choices?.[0]?.message?.content;
    if (!r.ok || typeof text !== "string") throw new Error(`the model check failed (${r.status}): ${String(j?.error?.message ?? "no message").slice(0, 160)}`);
    const v = JSON.parse(text) as CrossVerdict;
    return { other: v.other === true, quote: String(v.quote ?? ""), about: String(v.about ?? "") };
  };
}

/** The same check on Claude Haiku 5.5, the credit account (`CONSOLE_TEXT_MODEL_PROVIDER=anthropic`). */
export function anthropicCrossJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch): CrossJudge {
  return async (n) => {
    const { value: v } = await anthropicJson<CrossVerdict>(key, f, { system: crossSystem(n), user: crossUser(n), schema: CROSS_SCHEMA, maxTokens: 2000, timeoutMs: 45_000 });
    return { other: v.other === true, quote: String(v.quote ?? ""), about: String(v.about ?? "") };
  };
}
