/**
 * E948-S172 (the owner, 22 Nov 18:08Z, vn_106f5727, on the dad script card and the kernel card: "why you make me make an
 * effort to figure out what ... the topic? ... can you not just put ... somewhere there that says what's the topic, what is
 * this related to ... I keep saying this, can you please do it"): every card in his inbox opens with one plain line,
 * `About: <topic>`, above the line that names the project.
 *
 *   ask line  `— about: your reply to Dad`  ─┐
 *   card file `about: one kernel for every product` ─┼─▶ given      ─┐
 *   (none)  → leading link label, task name, title, goal ─▶ derived ─┴─▶ item.about  ─▶ "About: …" first on the card
 *
 * The derived words are plain: no row codes, paths, links or brackets, 8 words or fewer. A NEW ask (raised from
 * ABOUT_FROM) or review card without its own about is held as "card needs rewriting: no About line" (askGate rule 15,
 * review/card.ts gateProblems); older ones show the derived line.
 */

/** the day the About line became required on a new ask (asks raised before keep a derived one). */
export const ABOUT_FROM = "2026-11-23";
/** the About line's word limit. */
export const ABOUT_MAX_WORDS = 8;
/** what the gate says when a new card has no About line. */
export const NO_ABOUT = "card needs rewriting: no About line";
export const NO_ABOUT_FIX = "add `— about: <topic in his words, 8 words or fewer>` to the ask line (a card file: `about:`), e.g. about: your reply to Dad";

/** `— about: <topic>` anywhere on an ask line or glued to a field by spines.py. */
export const ABOUT_ON_LINE = /\s+(?:—|--)\s+about\s*:\s*([^—]*?)\s*(?=\s+(?:—|--)\s+|$)/i;

const CODE = /\b(?:EPIC-\d+(?:-A\d+)?|[A-Z][A-Z0-9]{0,5}-(?:[A-Z]{1,2}\d+[\w.-]*|A\d+|\d+(?:\.\d+)?))\b|\bvn_[0-9a-f]{6,}\b|\^e-[0-9a-f]+/g;
const URL = /\bhttps?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)+(?::\d+)?\/\S*/g;
const PATH = /(?:\.{0,2}\/)?\b[\w.-]+\/[\w./-]+\.\w{1,5}\b|\b[\w-]+\.(?:md|json|ts|tsx|py|sh|mjs|html)\b/g;
/** words a cut topic never ends on. */
const TAIL = /^(?:and|or|but|the|a|an|to|of|for|with|in|on|by|from|at|his|her|your|our|its|their|that|which|is|are|was|were|so|as|into|onto|now|then)$/i;

/** the words of a text a card shows, with links' own labels kept. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(URL, " ")
    .replace(PATH, " ")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(CODE, " ")
    .replace(/[;|()[\]{}<>"“”«»·]/g, " ")
    // checkout names and slugs (acme_web, tax-alpha-audit-facturas-2026) are not words
    .replace(/(?<!\S)(?:\w+_[\w_]+|[a-z0-9]+(?:-[a-z0-9]+){2,})(?!\S)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;—–-]+/, "")
    .trim();
}

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);

/** the first clause of a text, in plain words: up to the first `Core:`, sentence end, colon, dash or "e.g.". */
function firstClause(text: string): string {
  const p = plain(text)
    .replace(/^(?:urgent\.?\s+|one-off:\s*)/i, "")
    .replace(/\s+Core:.*$/i, "");
  const cut = p.split(/(?<=[.?!])\s+|\s*:\s+|\s+[—–-]\s+|,?\s+e\.g\.\s+/)[0] ?? p;
  return cut.replace(/^[\s,.:—–-]+|[\s,.:;—–-]+$/g, "").trim();
}

/** a topic cut to 8 words at a word that can end it ("your reply to Dad", never "your reply to"). */
function cutWords(text: string, max = ABOUT_MAX_WORDS): string {
  const w = wordsOf(text).slice(0, max);
  while (w.length > 1 && TAIL.test(w[w.length - 1]!.replace(/[,.]+$/, ""))) w.pop();
  return w.join(" ").replace(/[,.:;]+$/, "");
}

/** what is not plain in an About line, or undefined (the gate's words). */
export function aboutProblem(about: string | undefined | null): string | undefined {
  const a = (about ?? "").trim();
  if (!a) return NO_ABOUT;
  if (wordsOf(a).length > ABOUT_MAX_WORDS) return `the About line is longer than ${ABOUT_MAX_WORDS} words`;
  if (/[;()|[\]]/.test(a)) return "the About line has a semicolon, a bracket or a pipe";
  if (new RegExp(URL.source).test(a) || new RegExp(PATH.source).test(a)) return "the About line names a link or a file";
  if (new RegExp(CODE.source).test(a)) return "the About line names a code";
  return undefined;
}

/** the leading link's own words on an ask (`[a short script to read to your dad](…) : You decide …`), when they are words (never a bare address). */
function leadLabel(question: string): string | undefined {
  const m = /^\s*(?:urgent\.?\s*)?\[([^\]]{3,})\]\([^)]*\)/i.exec(question);
  const l = m?.[1]?.trim();
  return l && wordsOf(l).length >= 2 && wordsOf(l).length <= ABOUT_MAX_WORDS && !/\w\.\w{2,}/.test(l) ? l : undefined;
}

export interface AboutInput {
  /** given by the writer: the ask's `about:` or the card file's `about:`. */
  about?: string | null;
  /** the card file's short task name. */
  name?: string | null;
  /** the ask's question (its leading link label is a topic). */
  question?: string | null;
  /** the row's title or the card's title. */
  title?: string | null;
  /** the epic's goal sentence or the milestone title. */
  goal?: string | null;
}

/**
 * the card's topic: the given about when it is plain, else the first candidate that reads as a topic in 8 words or
 * fewer (the leading link label, the task name, the title's first clause, the goal's), else the title cut to 8 words.
 */
export function aboutOf(i: AboutInput): { about: string; given: boolean } | undefined {
  const given = i.about ? plain(i.about) : "";
  if (given && !aboutProblem(given)) return { about: given, given: true };
  const cands = [i.question ? leadLabel(i.question) : undefined, i.name, i.title, i.goal]
    .filter((x): x is string => !!x?.trim())
    .map(firstClause)
    .filter((x) => wordsOf(x).length >= 1);
  // the first that is there, cut to 8 words at a word that can end it (a long title at its comma first)
  for (const c of cands) {
    const short = wordsOf(c).length > ABOUT_MAX_WORDS ? (c.split(/,\s+/)[0] ?? c) : c;
    const cut = cutWords(short);
    if (wordsOf(cut).length >= 2 || cands.length === 1) return { about: cut, given: false };
  }
  // none reads as two words or more: the first there is, even one word, else the question's own first clause
  const one = cands.map((c) => cutWords(c)).find(Boolean) ?? cutWords(firstClause(i.question ?? "")) ?? cutWords(given);
  return one ? { about: one, given: false } : undefined;
}

/** take `— about: …` off any field spines.py glued it to; returns the about and the cleaned value. */
export function unglueAboutText(v: string): { text: string; about?: string } {
  const m = ABOUT_ON_LINE.exec(v);
  if (!m) return { text: v };
  return { text: (v.slice(0, m.index) + v.slice(m.index + m[0].length)).trim(), about: m[1]!.trim() };
}

/**
 * aboutOf kept per input. The inbox list works it out for every item (400) on every read, the same texts each
 * time; its regular expressions were a tenth of the list's time. Bounded: a full map starts over.
 */
const aboutMemo = new Map<string, { about: string; given: boolean } | undefined>();
const ABOUT_MEMO_MAX = 5_000;
function aboutKept(i: AboutInput): { about: string; given: boolean } | undefined {
  const k = `${i.about ?? ""}\u0000${i.question ?? ""}\u0000${i.title ?? ""}\u0000${i.goal ?? ""}\u0000${i.name ?? ""}`;
  if (aboutMemo.has(k)) return aboutMemo.get(k);
  const t = aboutOf(i);
  if (aboutMemo.size >= ABOUT_MEMO_MAX) aboutMemo.clear();
  aboutMemo.set(k, t);
  return t;
}

/** an inbox item with its About line: the ask's own, else derived (every card, every kind, old stored views too). */
export function withAbout<T extends { about?: string; aboutGiven?: true; question?: string; title?: string; milestoneTitle?: string; spine?: { title: string } }>(it: T): T {
  const t = aboutKept({ about: it.aboutGiven ? it.about : undefined, question: it.question, title: it.title, goal: it.spine?.title ?? it.milestoneTitle });
  if (!t) return it;
  return { ...it, about: t.about, ...(t.given ? { aboutGiven: true as const } : {}) };
}
