import { createHash } from "node:crypto";
import type { DB } from "../db.js";
import { anthropicJson } from "../textModel.js";
import type { MarkInput, NoteMarkKind } from "../review/noteMarks.js";
import { SPILL_HEAD, SPILL_MODEL } from "./spill.js";
import { memoryName, memoryPattern, ownerName } from "../identity.js";

/**
 * "you prepared something two
 * hours ago. And then I send a voice note. I wonder if in addition to dispatching the new iteration, you could also mark a
 * ticket stale … I'm going to notify these two agents that were working on this ticket. That this voice note just came …
 * every time I'm talking like at these long voice notes, if you can extract the relevant parts for the relevant people so
 * that even if you now need to launch long things, my inbox responds pretty quickly. So that if I go into my inbox, I'm
 * just not going to find things that are stale."
 *
 * A long note from any source (WhatsApp through the memory service, the Team desk's Chat, a card's or ask's box, a milestone chat) is read
 * once by a small model next to the cards in his inbox (rows in review, open asks). For each card it touches:
 *   - the card's spine gets one `## Decisions` line (`stale` or `updated`, his words, a key of the card as it is: L-45,
 *     review/noteMarks.ts), so his inbox shows "Updated by your note of 23:08" or "Stale: your note changed this" until
 *     its owner moves the row or rewrites the ask;
 *   - the card's owner, its milestone's Delivery manager, is woken once per note with his words for each of its cards;
 *   - the Team desk gets one line saying which cards it marked, so the desk's own placement of the note builds on it.
 * Once per note (its id, else the hash of his words); never a note shorter than TOUCH_MIN_WORDS (a short note is an answer
 * the desk places itself); never a console line (heads below).
 */

/** The OpenAI model (CONSOLE_NOTE_TOUCH_MODEL overrides); Haiku on the anthropic provider. */
export const TOUCH_MODEL = process.env.CONSOLE_NOTE_TOUCH_MODEL || SPILL_MODEL;
export const TOUCH_HEAD = "🗂 Your note touched";
/** About two minutes of speech: shorter notes are answers or single asks, placed by the desk as before. */
export const TOUCH_MIN_WORDS = 250;
/**
 * A typed Team desk message is read at this length: the owner types what he means, so a typed line about a card makes
 * it stale as surely as a long voice note. Shorter is an answer ("yes go ahead").
 * CONSOLE_NOTE_TOUCH_TYPED_MIN overrides.
 */
export const TOUCH_MIN_TYPED_WORDS = Number(process.env.CONSOLE_NOTE_TOUCH_TYPED_MIN) || 15;
/** A desk message he typed (not a voice note, not a console or persona line). */
export const isTyped = (text: string) => !/^\s*🎙/u.test(text);
/** The characters the model reads (a 40-minute note is about 50,000). */
const CHARS_MAX = 90_000;
/** Cards the model is shown at most (newest first is the caller's order). */
export const TOUCH_MAX_CARDS = 80;
/**
 * E942-S174: a typed or spoken desk message waits this long before it is read, so a message he takes back right after
 * ("I actually just saw them, you can ignore my last message.", 22 Nov 20:01Z, one minute after his 20:00Z message
 * the console had already put on the family card) marks nothing. CONSOLE_NOTE_TOUCH_GRACE_MS overrides.
 */
export const TOUCH_GRACE_MS = Number(process.env.CONSOLE_NOTE_TOUCH_GRACE_MS) || 120_000;
/** Candidates the confirm pass reads one by one, at most (a note that touches more than this is rare). */
const CONFIRM_MAX = 8;
/** Words of the note on each side of his quote the confirm pass reads. */
const PASSAGE_WORDS = 160;
/**
 * A short message that takes back the one before it. Only a short message (a withdrawal is a line, not a new note), and
 * only words about a message or note, never "ignore that table" (a point about the work itself).
 */
const WITHDRAW =
  /\b(ignore|disregard|forget(?: about)?|scratch|drop)\b[^.?!]{0,40}?\b(last|previous|earlier|above|that|this|my)\b[^.?!]{0,25}?\b(message|messages|note|msg|remark|comment|question|voice ?note)\b|\bnever ?mind\b|\b(?:take|taking) (?:that|it) back\b|^\s*(?:please\s+)?(?:ignore|disregard|forget)\s+(?:that|this|it)\s*[.!]?\s*$/i;
/** He takes back what he said just before. */
export const takesBack = (words: string) => wordCount(words) <= 40 && WITHDRAW.test(words);
/** Console and persona heads: never his words. */
const SKIP_HEADS = ["↔", SPILL_HEAD, TOUCH_HEAD, "📎", "[", "📞", "🗂"];

/** One card in his inbox, as the model and the writers need it. */
export interface TouchCard {
  kind: "row" | "ask";
  /** The row or ask code. */
  ref: string;
  /** Its title, plain words. */
  title: string;
  /** What it delivered or asks, a line or two. */
  about: string;
  /** Checkout name and repo-relative spine. */
  repo: string;
  path: string;
  milestoneId?: string;
  /** The text the mark is keyed to: the row's status cell, the ask's question. */
  current: string;
  /** Its words as the spine has them (row title, status, evidence; ask line): a card that cites the note was made from it. */
  text?: string;
  /** E942-S174: what the card is about, in plain words (its `About:` line: the house, the family, the inbox), so a note about one topic is never put on a card of another. */
  topic?: string;
}

export interface TouchNote {
  /** The note's id (`vn_…`), else the desk request id; else his words are hashed. */
  id?: string;
  world: string;
  words: string;
  /** Where he said it (`WhatsApp`, `Chat`, `card`). */
  where: string;
  /** When he started speaking (ISO); else now. */
  at?: string;
  /** Where the note lives (the memory service ref, `vn_…`). */
  ref?: string;
  /** He typed it in the Team desk Chat: read from TOUCH_MIN_TYPED_WORDS words, not only long voice notes. */
  typed?: boolean;
}

export interface Touched {
  ref: string;
  how: NoteMarkKind;
  /** His words about that card, as he said them. */
  quote: string;
  /** Why it is stale or updated, a few plain words. */
  why: string;
}
export interface TouchJudgeInput {
  words: string;
  cards: Pick<TouchCard, "kind" | "ref" | "title" | "about" | "topic">[];
  /** What he said right after, in the grace window (it may take the note back or correct it). */
  after?: string;
}
export type TouchJudge = (n: TouchJudgeInput) => Promise<Touched[]>;
/**
 * E942-S174 the second look: one card and the part of his note around his quote. The first pass reads up to 80 cards
 * against a whole note and matched on a shared word (22 Nov 16:12Z: "a table that had five key results", said about the
 * house criteria, put on the key-results card; 16:50Z: "he wants me to ... leave a fiction", said about his dad, marked
 * the script card stale). This pass says first what his words are about, then whether that is this card's work.
 */
export interface TouchConfirmInput {
  card: Pick<TouchCard, "kind" | "ref" | "title" | "about" | "topic">;
  how: NoteMarkKind;
  quote: string;
  /** The note around his quote. */
  passage: string;
}
export interface TouchConfirmed {
  /** What his words here are about, in his terms. */
  subject: string;
  /** His words are about this card's own work and its owner must act. */
  same: boolean;
  how: NoteMarkKind;
  why: string;
}
export type TouchConfirm = (x: TouchConfirmInput) => Promise<TouchConfirmed>;
export type TouchState = "judging" | "none" | "done" | "failed" | "withdrawn";

export interface TouchDeps {
  db: DB;
  /** The model check; absent = off. */
  judge?: TouchJudge;
  /** E942-S174 the second look at each card the first pass named; absent = the first pass alone decides. */
  confirm?: TouchConfirm;
  /** Waits this long (the grace window); a test passes its own clock. */
  sleep?: (ms: number) => Promise<void>;
  /** The open cards of a world's inbox. */
  cards: (world: string) => Promise<TouchCard[]>;
  /** Write these marks into one spine (one commit): true, else why not. */
  mark: (repo: string, path: string, marks: MarkInput[]) => Promise<true | string>;
  /** Wake a milestone's Delivery manager with these instructions (deduped by key): true, else why not. */
  wake?: (milestoneId: string, text: string, key: string) => Promise<true | string>;
  /** One line into the world's Team desk. */
  tell?: (world: string, text: string, id: string) => Promise<true | string>;
  now?: () => number;
  log?: (m: string) => void;
}

export function ensureTouchTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_note_touches (
      note_key TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      at TEXT NOT NULL,
      spoken_at TEXT,
      words INTEGER NOT NULL,
      state TEXT NOT NULL,
      touched TEXT,
      error TEXT
    );
  `);
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** `YYYY-MM-DD HH:MMZ` of an ISO time. */
export const minuteOf = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

/** When he spoke: the note's own time, else the first `YYYY-MM-DD HH:MM` in its header line, else now. */
export function spokenAt(n: Pick<TouchNote, "at" | "words">, now: number): string {
  if (n.at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(n.at)) return minuteOf(n.at);
  const head = n.words.split("\n", 1)[0] ?? "";
  const m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(head);
  return m ? `${m[1]} ${m[2]}Z` : minuteOf(new Date(now).toISOString());
}

/** The note's key: its `vn_…` id when it has one (a chat note reaches here twice), else the given id, else its words. */
export function noteKey(n: Pick<TouchNote, "id" | "words">): string {
  const vn = /\bvn_[a-z0-9]+\b/i.exec(n.id ?? "")?.[0] ?? /\bvn_[a-z0-9]+\b/i.exec(n.words.split("\n", 1)[0] ?? "")?.[0];
  if (vn) return vn;
  const cited = new RegExp(`${memoryPattern()}:\\s*(Log\\/[\\w.-]+#\\^[\\w-]+)`).exec(n.words)?.[1];
  if (cited) return cited;
  return n.id || `h_${createHash("sha1").update(oneLine(n.words)).digest("hex").slice(0, 20)}`;
}

/** Words only, lower case, one space: how a quote is matched against the note (speech to text punctuates freely). */
export const flat = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The quote is his: at least 4 words, and (ellipses split it) every part of 3+ words is in the note as he said it. */
export function saidIn(note: string, quote: string): boolean {
  const q = flat(quote);
  if (q.split(" ").length < 4) return false;
  const parts = quote
    .split(/\.{3}|…/)
    .map(flat)
    .filter((x) => x.split(" ").length >= 3);
  return parts.length > 0 && parts.every((x) => note.includes(x));
}

/** How a card's words would cite the note: its `vn_…` id, its the memory service anchor (`e-449504`). */
export function citesOf(key: string, ref?: string): string[] {
  const out = new Set<string>();
  for (const k of [key, ref ?? ""]) {
    if (/^vn_/.test(k)) out.add(k);
    const anchor = /#\^([\w-]+)$/.exec(k)?.[1];
    if (anchor) out.add(anchor);
  }
  return [...out];
}

/** What the Delivery manager is told for its cards. */
export function wakeText(n: { at: string; where: string; ref: string; typed?: boolean }, list: { card: TouchCard; t: Touched }[]): string {
  return [
    `${ownerName()}'s ${n.typed ? "typed message" : "voice note"} of ${n.at} (${n.where}${n.ref ? `, ${n.ref}` : ""}) touches ${list.length} card(s) of yours in his inbox. Each card now shows the mark below until you act on it:`,
    ...list.map(
      ({ card, t }) =>
        `- ${card.ref} (${card.repo} ${card.path}), ${t.how === "stale" ? "STALE: his note changed what it is about" : "UPDATED: his note adds to it"}. He said: "${oneLine(t.quote).slice(0, 600)}"${t.why ? ` (${oneLine(t.why).slice(0, 200)})` : ""}`,
    ),
    "Act on each one now (L-37: his words are his ready stamp): a stale row gets a new iteration with his words (status `active (iteration n, …)`), or back to review once its card says what changed; an updated row folds his words into its card or next steps; a stale ask is rewritten or closed. The mark clears by itself the moment the row's status or the ask's question changes. Read the whole note in " + memoryName() + " before acting; place the rest of it as you place his voice notes.",
  ]
    .join("\n")
    .slice(0, 6000);
}

/** The note around his quote: PASSAGE_WORDS words on each side of where it starts (speech to text punctuates freely). */
export function passageOf(note: string, quote: string, span = PASSAGE_WORDS): string {
  const words = note.split(/\s+/).filter(Boolean);
  const flatWords = words.map(flat);
  const q = flat(quote.split(/\.{3}|…/)[0] ?? quote).split(" ").filter(Boolean).slice(0, 4);
  let at = -1;
  if (q.length)
    for (let i = 0; i < flatWords.length && at < 0; i++) {
      // a word of the note may flatten to two ("it's" -> "it s"): compare on the joined run
      const run = flatWords.slice(i, i + q.length + 2).join(" ");
      if (flatWords[i] && run.startsWith(q.join(" "))) at = i;
    }
  if (at < 0) return words.slice(0, span * 2).join(" ");
  return words.slice(Math.max(0, at - span), at + span).join(" ");
}

/** The one Team desk line. */
export function touchLine(n: { at: string; key: string }, list: { card: TouchCard; t: Touched }[]): string {
  return [
    `${TOUCH_HEAD} ${list.length} card(s) in your inbox (note of ${n.at}, ${n.key}):`,
    ...list.map(({ card, t }) => `- ${card.ref} ${t.how === "stale" ? "stale" : "updated"}: ${oneLine(t.why || card.title).slice(0, 160)}`),
    "Their owners have your words; each card shows it until its owner acts. Delivery Manager: place the rest of the note as usual; these cards are already handed on.",
  ].join("\n");
}

export function createNoteTouch(d: TouchDeps) {
  const { db } = d;
  ensureTouchTables(db);
  const now = () => (d.now ? d.now() : Date.now());
  const iso = (t = now()) => new Date(t).toISOString();
  const set = (key: string, state: TouchState, extra: { touched?: unknown; error?: string } = {}) =>
    db
      .prepare("UPDATE voice_note_touches SET state = ?, touched = COALESCE(?, touched), error = ? WHERE note_key = ?")
      .run(state, extra.touched === undefined ? null : JSON.stringify(extra.touched), extra.error ?? null, key);

  // E942-S174 what he said lately, per world, in order: a note read after its grace window sees what came right after it
  let seq = 0;
  const said = new Map<string, { seq: number; words: string }[]>();
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));

  return {
    /**
     * He said something to a desk or a card: if it is a long note, mark the cards it touches and tell their owners.
     * `graceMs` (the desk passes TOUCH_GRACE_MS): wait that long first, and mark nothing when he takes it back meanwhile.
     */
    async heard(n: TouchNote, o: { graceMs?: number } = {}): Promise<TouchState | undefined> {
      if (!d.judge) return undefined;
      const words = n.words.trim();
      if (!words || SKIP_HEADS.some((h) => words.startsWith(h))) return undefined;
      const mine = ++seq;
      const lately = [...(said.get(n.world) ?? []).filter((x) => x.seq > mine - 50), { seq: mine, words }];
      said.set(n.world, lately);
      const count = wordCount(words);
      if (count < (n.typed ? TOUCH_MIN_TYPED_WORDS : TOUCH_MIN_WORDS)) return undefined;
      const key = noteKey(n);
      const at = spokenAt(n, now());
      // claim the note first: a second arrival (chat note + its filing, a retry) never judges twice
      const claimed = db.prepare("INSERT OR IGNORE INTO voice_note_touches (note_key, tenant_id, at, spoken_at, words, state) VALUES (?, ?, ?, ?, ?, 'judging')").run(key, n.world, iso(), at, count);
      if (!claimed.changes) return (db.prepare("SELECT state FROM voice_note_touches WHERE note_key = ?").get(key) as { state: TouchState }).state;
      let afterText = "";
      if (o.graceMs && o.graceMs > 0) {
        await sleep(o.graceMs);
        const after = (said.get(n.world) ?? []).filter((x) => x.seq > mine);
        const back = after.find((x) => takesBack(x.words));
        if (back) {
          set(key, "withdrawn", { touched: [], error: `he took it back: ${oneLine(back.words).slice(0, 200)}` });
          return "withdrawn";
        }
        afterText = after.map((x) => oneLine(x.words).slice(0, 600)).join("\n").slice(0, 3000);
      }
      let cards: TouchCard[];
      let verdict: Touched[];
      // a card whose spine words already cite this note was made from it (the desk placed it before this pass ran)
      const cites = citesOf(key, n.ref);
      try {
        cards = (await d.cards(n.world)).filter((c) => !cites.some((x) => (c.text ?? "").includes(x))).slice(0, TOUCH_MAX_CARDS);
        if (!cards.length) {
          set(key, "none");
          return "none";
        }
        verdict = await d.judge({ words: words.slice(0, CHARS_MAX), cards: cards.map(({ kind, ref, title, about, topic }) => ({ kind, ref, title, about, ...(topic ? { topic } : {}) })), ...(afterText ? { after: afterText } : {}) });
      } catch (e) {
        set(key, "failed", { error: `model: ${(e as Error).message}`.slice(0, 300) });
        return "failed";
      }
      const byRef = new Map(cards.map((c) => [c.ref, c]));
      const seen = new Set<string>();
      // his words only: a quote the note does not hold (the model copied the card's words, live 2026-11-11) marks nothing
      const flatNote = flat(words);
      const named = verdict
        .filter((t) => (t.how === "stale" || t.how === "updated") && byRef.has(t.ref) && saidIn(flatNote, t.quote) && !seen.has(t.ref) && seen.add(t.ref))
        .map((t) => ({ card: byRef.get(t.ref)!, t }));
      // E942-S174 the second look, card by card: only a card his words are about keeps its mark; a doubt, or a failed look, marks nothing
      const dropped: { ref: string; subject: string }[] = [];
      let list = named;
      if (d.confirm && named.length) {
        list = [];
        for (const x of named.slice(0, CONFIRM_MAX)) {
          const { kind, ref: cardRef, title, about, topic } = x.card;
          const c = await d
            .confirm({ card: { kind, ref: cardRef, title, about, ...(topic ? { topic } : {}) }, how: x.t.how, quote: x.t.quote, passage: passageOf(words, x.t.quote) })
            .catch((e: Error) => ({ subject: `look failed: ${e.message}`.slice(0, 200), same: false, how: x.t.how, why: "" }));
          if (!c.same) {
            dropped.push({ ref: cardRef, subject: oneLine(c.subject).slice(0, 200) });
            continue;
          }
          // the milder mark wins: a card both looks call stale is stale, else updated
          list.push({ card: x.card, t: { ...x.t, how: x.t.how === "stale" && c.how === "stale" ? "stale" : "updated", why: c.why || x.t.why } });
        }
      }
      if (!list.length) {
        set(key, "none", { touched: dropped.map((x) => ({ ...x, dropped: true })) });
        return "none";
      }
      const date = iso().slice(0, 10);
      const ref = n.ref || key;
      const errors: string[] = [];
      // one commit per spine
      const bySpine = new Map<string, { card: TouchCard; t: Touched }[]>();
      for (const x of list) bySpine.set(`${x.card.repo}\0${x.card.path}`, [...(bySpine.get(`${x.card.repo}\0${x.card.path}`) ?? []), x]);
      const marked = new Set<string>();
      for (const group of bySpine.values()) {
        const { repo, path } = group[0].card;
        const r = await d
          .mark(
            repo,
            path,
            group.map(({ card, t }) => ({ ref: card.ref, kind: t.how, at, quote: t.quote, why: t.why, note: `${n.where}, ${ref}`, current: card.current, date })),
          )
          .catch((e: Error) => e.message);
        if (r === true) for (const x of group) marked.add(x.card.ref);
        else errors.push(`${repo} ${path}: ${String(r).slice(0, 160)}`);
      }
      const done = list.filter((x) => marked.has(x.card.ref));
      // each milestone's Delivery manager, once per note, with his words for each of its cards
      const byMs = new Map<string, { card: TouchCard; t: Touched }[]>();
      for (const x of done) if (x.card.milestoneId) byMs.set(x.card.milestoneId, [...(byMs.get(x.card.milestoneId) ?? []), x]);
      const woken: string[] = [];
      if (d.wake)
        for (const [mid, group] of byMs) {
          const r = await d.wake(mid, wakeText({ at, where: n.where, ref, typed: n.typed }, group), `note-touch:${key}:${mid}`).catch((e: Error) => e.message);
          if (r === true) woken.push(mid);
          else errors.push(`wake ${mid}: ${String(r).slice(0, 160)}`);
        }
      if (done.length && d.tell) {
        const r = await d.tell(n.world, touchLine({ at, key }, done), `note-touch-${key}`).catch((e: Error) => e.message);
        if (r !== true) errors.push(`desk: ${String(r).slice(0, 160)}`);
      }
      const touched = [
        ...list.map(({ card, t }) => ({ ref: card.ref, repo: card.repo, path: card.path, how: t.how, marked: marked.has(card.ref), woken: !!card.milestoneId && woken.includes(card.milestoneId) })),
        ...dropped.map((x) => ({ ...x, dropped: true })),
      ];
      if (errors.length) d.log?.(`note touch ${key}: ${errors.join("; ")}`);
      set(key, done.length ? "done" : "failed", { touched, ...(errors.length ? { error: errors.join("; ").slice(0, 600) } : {}) });
      return done.length ? "done" : "failed";
    },
    /** One note's pass, for the status route and tests. */
    get(key: string) {
      const r = db.prepare("SELECT * FROM voice_note_touches WHERE note_key = ?").get(key) as Record<string, unknown> | undefined;
      return r ? { ...r, touched: r.touched ? JSON.parse(String(r.touched)) : [] } : undefined;
    },
    /** The latest passes, newest first. */
    recent(limit = 20) {
      return (db.prepare("SELECT * FROM voice_note_touches ORDER BY at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({ ...r, touched: r.touched ? JSON.parse(String(r.touched)) : [] }));
    },
  };
}
export type NoteTouch = ReturnType<typeof createNoteTouch>;

const TOUCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["touched"],
  properties: {
    touched: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "speaks", "how", "quote", "why"],
        properties: {
          ref: { type: "string", description: "The card's code exactly as listed." },
          speaks: { type: "boolean", description: "true only when his words are about this very card's work and its owner must act on them. false = leave it out." },
          how: { type: "string", enum: ["stale", "updated"], description: "stale: his words change, undo or redirect what the card delivered or asks, so judging it as it stands would be wrong. updated: his words add to it or comment on it, and the card still holds." },
          quote: { type: "string", description: "His own words about this card, copied character for character from the note (one to three sentences). Never the card's words." },
          why: { type: "string", description: "Why, in at most 15 plain words." },
        },
      },
    },
  },
};

const TOUCH_SYSTEM =
  "A product owner recorded a long voice note. His team's work waits for him as cards in his inbox: rows in review (finished work he judges) and asks (questions to him). " +
  "Find the cards his note clearly speaks about: it names the work, its feature or its topic directly, and says something about it that its owner must act on. " +
  "Mark a card stale when what he says changes, reverses or redirects what the card delivered or asks (judging it as it stands would be wrong); updated when he adds a request, a detail or a comment and the card still holds. " +
  "Leave out cards he does not speak about, and cards his words only brush past in general talk; never list a card to say it is not about it. Fewer, sure matches beat many guesses: when unsure, leave it out. Quote his words exactly, never the card's words. " +
  "Each card says what it is About: a note about one subject (his house search, his family, a product) never goes on a card about another, even when they share a word like 'key results', 'table' or 'script'. " +
  "A private remark about a person is not a verdict on a card made for that person. If what he said right after takes the note back or corrects it, follow what he said after.";
const cardLine = (c: TouchJudgeInput["cards"][number]) =>
  `- ${c.ref} (${c.kind === "row" ? "review" : "ask"})${c.topic ? ` [About: ${oneLine(c.topic).slice(0, 80)}]` : ""}: ${oneLine(c.title).slice(0, 200)}${c.about ? ` — ${oneLine(c.about).slice(0, 300)}` : ""}`;
const touchUser = (n: TouchJudgeInput) =>
  `Cards in his inbox:\n${n.cards.map(cardLine).join("\n")}\n\nHis note (speech to text):\n${n.words}${n.after ? `\n\nWhat he said right after:\n${n.after}` : ""}`;

const CONFIRM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "work", "same", "how", "why"],
  properties: {
    subject: { type: "string", description: "First, before looking at the card: the area of his life or work this passage is in (his house search, his family, a product and its screen), a colon, then what he says about it. At most 20 words." },
    work: { type: "string", description: "The card's area (the same way), a colon, then the thing it delivered or the question it asks. At most 20 words." },
    same: { type: "boolean", description: "true only when his subject IS the card's work (he speaks about that very deliverable or question) and its owner must act. A shared word, the same person or the same wider topic is not enough." },
    how: { type: "string", enum: ["stale", "updated"], description: "stale only when he plainly rejects, reverses or redirects the card's deliverable itself; else updated." },
    why: { type: "string", description: "Why, in at most 15 plain words." },
  },
};
const CONFIRM_SYSTEM =
  "A product owner's note was matched to one card in his inbox by a quick first pass that often matches on a shared word. Check it. " +
  "Read the passage and say which area of his life or work it is in and what he says, before you read the card; the whole passage tells the area, not one sentence. Then say the card's area and its work. Two different areas are never the same. " +
  "The card's work is everything it delivered or links to (a page, a script, a table) and the question it asks about it. " +
  "They are the same when he speaks about that very thing: asking to change, shorten, translate, redo or drop part of what the card made is the same. " +
  "Not the same: a table in his house search versus a key-results table; a pretence his father asks of him versus a script written for him to read to his father; " +
  "a remark he then takes back. When his subject is another thing that only shares a word, a person or a wider topic with the card, they are not the same.";
const confirmUser = (x: TouchConfirmInput) =>
  `The card: ${x.card.ref} (${x.card.kind === "row" ? "finished work in review" : "a question to him"})${x.card.topic ? `\nAbout: ${oneLine(x.card.topic).slice(0, 120)}` : ""}\nTitle: ${oneLine(x.card.title).slice(0, 300)}${x.card.about ? `\nWhat it is: ${oneLine(x.card.about).slice(0, 400)}` : ""}\n\nThe first pass marked it ${x.how}, quoting him: "${oneLine(x.quote).slice(0, 600)}"\n\nThe passage of his note around that quote (speech to text):\n${x.passage}`;
const cleanConfirm = (v: Partial<TouchConfirmed> & { work?: unknown }): TouchConfirmed => ({
  subject: String(v.subject ?? ""),
  same: v.same === true,
  how: v.how === "stale" ? "stale" : "updated",
  why: String(v.why ?? ""),
});
const clean = (v: { touched?: unknown }): Touched[] =>
  (Array.isArray(v.touched) ? v.touched : [])
    .filter((t): t is Touched => !!t && typeof t === "object" && typeof (t as Touched).ref === "string" && (t as { speaks?: unknown }).speaks !== false)
    // a "why" that says it is not about the card (live 2026-11-11: "Not about this card; omitted") is the model leaving it out
    .filter((t) => !/\b(not (directly )?(about|related)|unrelated|omitted|no relation)\b/i.test(String(t.why ?? "")))
    .map((t) => ({ ref: String(t.ref).trim(), how: t.how === "stale" ? "stale" : "updated", quote: String(t.quote ?? ""), why: String(t.why ?? "") }));

/** OpenAI's strict JSON check on the console's own key. */
export function openAiTouchJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch, model = TOUCH_MODEL): TouchJudge {
  return async (n) => {
    const k = await key();
    if (!k) throw new Error("the console has no OPENAI_API_KEY");
    const body = {
      model,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "touch", strict: true, schema: TOUCH_SCHEMA } },
      messages: [
        { role: "system", content: TOUCH_SYSTEM },
        { role: "user", content: touchUser(n) },
      ],
    };
    const r = await f("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    const text = j?.choices?.[0]?.message?.content;
    if (!r.ok || typeof text !== "string") throw new Error(`the model check failed (${r.status}): ${String(j?.error?.message ?? "no message").slice(0, 160)}`);
    return clean(JSON.parse(text) as { touched?: unknown });
  };
}

/** The same check on Claude Haiku (`CONSOLE_TEXT_MODEL_PROVIDER=anthropic`). */
export function anthropicTouchJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch): TouchJudge {
  return async (n) => {
    const { value } = await anthropicJson<{ touched?: unknown }>(key, f, { system: TOUCH_SYSTEM, user: touchUser(n), schema: TOUCH_SCHEMA, maxTokens: 4000, timeoutMs: 90_000 });
    return clean(value);
  };
}

/** E942-S174 the second look on OpenAI's strict JSON check. */
export function openAiTouchConfirm(key: () => Promise<string | undefined>, f: typeof fetch = fetch, model = TOUCH_MODEL): TouchConfirm {
  return async (x) => {
    const k = await key();
    if (!k) throw new Error("the console has no OPENAI_API_KEY");
    const body = {
      model,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "confirm", strict: true, schema: CONFIRM_SCHEMA } },
      messages: [
        { role: "system", content: CONFIRM_SYSTEM },
        { role: "user", content: confirmUser(x) },
      ],
    };
    const r = await f("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    const text = j?.choices?.[0]?.message?.content;
    if (!r.ok || typeof text !== "string") throw new Error(`the confirm check failed (${r.status}): ${String(j?.error?.message ?? "no message").slice(0, 160)}`);
    return cleanConfirm(JSON.parse(text) as Partial<TouchConfirmed>);
  };
}

/** The same second look on Claude Haiku. */
export function anthropicTouchConfirm(key: () => Promise<string | undefined>, f: typeof fetch = fetch): TouchConfirm {
  return async (x) => {
    const { value } = await anthropicJson<Partial<TouchConfirmed>>(key, f, { system: CONFIRM_SYSTEM, user: confirmUser(x), schema: CONFIRM_SCHEMA, maxTokens: 2000, timeoutMs: 60_000 });
    return cleanConfirm(value);
  };
}
