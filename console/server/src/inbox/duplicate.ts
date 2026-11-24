import { contentWords } from "./askRepeat.js";

/**
 * E948-S139 (the owner's WhatsApp voice note, 24 Nov 20:37Z, Log/2026-11-24.md#^e-798779): "today I had the experience that
 * you were asking me for the same thing several times ... Give me a button. That's it Duplicate or already answered ...
 * I will be marking to you and then hopefully you will be able to trace back which was the two".
 *
 * One button on every card in his inbox (asks and review cards). One tap closes the card as answered with these words, and
 * the console traces which earlier card it repeats by its words, so the owner is told which one and the ask gate's repeat
 * memory (askRepeat.ts: the `[answered …]` lines and the asks log) holds the next card like it. No second memory: the
 * answer line itself, and for a review card one asks-log entry, are what the gate reads.
 */
export const DUPLICATE_ANSWER = "duplicate or already answered";
export const DUPLICATE_LABEL = "Duplicate or already answered";

/** his words start with the button's words (the console writes them first; a note may follow). */
export const isDuplicate = (text: string | null | undefined): boolean => (text ?? "").trim().toLowerCase().startsWith(DUPLICATE_ANSWER);

/** the answer the button sends: its words, then his note when he wrote one. */
export const duplicateWords = (note?: string | null): string => (note?.trim() ? `${DUPLICATE_ANSWER}. ${note.trim()}` : DUPLICATE_ANSWER);

/** an earlier card it may repeat: an answered ask (repeat memory), an open ask, or another card in review. */
export interface DupCandidate {
  /** the ask code or row code. */
  ref: string;
  question: string;
  repo?: string | null;
  row?: string | null;
  /** answered on (YYYY-MM-DD), for an answered one. */
  on?: string | null;
  answer?: string | null;
  /** still waiting on him (an open ask or a card in review). */
  open?: boolean;
}

export interface DupTarget {
  question: string;
  ref?: string | null;
  repo?: string | null;
  row?: string | null;
}

/** the least overlap that names a card as the earlier one: he said it repeats one, so the closest that shares this much. */
const MIN_SHARED = 2;
const MIN_SCORE = 0.15;

/**
 * The earlier card the tapped one repeats: the candidate sharing the most content words with it (Jaccard), a candidate on
 * the same row counting a little more; never itself. Undefined when none shares at least two words.
 */
export function traceDuplicate(t: DupTarget, cands: DupCandidate[]): { cand: DupCandidate; score: number } | undefined {
  const mine = contentWords(t.question);
  if (!mine.size) return undefined;
  const self = (t.ref ?? "").toUpperCase();
  let best: { cand: DupCandidate; score: number } | undefined;
  for (const c of cands) {
    if (!c.question || (self && c.ref.toUpperCase() === self && (!t.repo || !c.repo || t.repo === c.repo))) continue;
    const theirs = contentWords(c.question);
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared++;
    if (shared < MIN_SHARED) continue;
    const union = mine.size + theirs.size - shared;
    let score = union ? shared / union : 0;
    if (t.row && c.row && t.row.toUpperCase() === c.row.toUpperCase()) score += 0.1;
    if (score < MIN_SCORE) continue;
    // an answered one wins a tie: "already answered" points at the answer
    if (!best || score > best.score || (score === best.score && !c.open && best.cand.open)) best = { cand: c, score };
  }
  return best;
}

/** One plain line for the answer and the owner: which card it repeats, or that the owner traces it. */
export function traceLine(hit: { cand: DupCandidate } | undefined): string {
  if (!hit) return "repeats: not found by its words, its owner traces the earlier card";
  const c = hit.cand;
  const where = c.repo ? ` in ${c.repo}` : "";
  const q = c.question.replace(/\s+/g, " ").trim().slice(0, 90);
  if (c.open) return `repeats: ${c.ref}${where}, still open ("${q}")`;
  const said = c.answer?.replace(/\s+/g, " ").trim().slice(0, 80);
  return `repeats: ${c.ref}${where}, answered ${c.on ?? "earlier"}${said ? ` "${said}"` : ""} ("${q}")`;
}

/** the answer written for a tap: the button's words, his note, then the trace. Already traced words are left alone. */
export function withTrace(text: string, hit: { cand: DupCandidate } | undefined): string {
  if (/(?:^|\s)—\s*repeats:/.test(text)) return text;
  return `${text.trim()} — ${traceLine(hit)}`;
}

/**
 * Merged before he sees it: a newer card in nearly the same words as an older one still open is held back to its owner
 * to fold into the older (his words from both kept), never shown twice. The bar is strict, so a different question in
 * the same topic still reaches him: at least SAME_SHARED content words shared and SAME_SCORE of all of them (Jaccard).
 * scripts/inbox_dupes.py names looser pairs (by meaning) for the Delivery Manager; it never merges them.
 */
export const SAME_SHARED = 4;
export const SAME_SCORE = 0.6;

export function sameQuestion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const union = x.size + y.size - shared;
  return shared >= SAME_SHARED && union > 0 && shared / union >= SAME_SCORE;
}

/** the hold's words: which open card it repeats, and what its owner does. */
export const sameOpenProblem = (ref: string, since?: string | null): string =>
  `it asks the same as ${ref}, still open${since ? ` since ${since.slice(0, 10)}` : ""}: one question, one card. Fold it into ${ref} with the owner's words from both, then drop this one`;
