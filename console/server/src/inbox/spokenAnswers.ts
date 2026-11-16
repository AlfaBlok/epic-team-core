import type { Hono } from "hono";
import { anthropicJson } from "../textModel.js";

/**
 * E948-S127 (the owner 16 Nov 20:31Z, vn_02c8f518: "I think I answered this point several times. Now it doesn't show even that
 * it was responded. It's as if I had not responded."; 20:30Z vn_8966c7a8: "it says sent, but it's still showing ... why
 * do we regress? It was working"): his words on a card that holds asks (a persona's set of recommendations, or one approve
 * ask) answer them. vn_7f478843 on "The Delivery Manager's 3 recommendations": "So the first one, OK, the second one, no, I
 * don't want to raise the limit. The third one, yes." went to the Team desk as feedback only, so the card came back open.
 *
 * This reads his words against the card's asks and says, for each ask, what he answered: approve, deny, unclear (he
 * speaks about it but which answer is not plain) or none. Read only: the card then presses each answer through the same
 * route as its button (POST /waiting-on-owner/:id/respond), so an answer from words is stored, written and woken exactly
 * like a press, and the card stays answered after a reload.
 *
 * Two readers, the plain one first:
 * 1. By order and by name, no model: "the first one, OK", "the second one, no", "number three: yes", "E988-A10 no",
 *    "yes to all". The first yes or no word after the mention, before the next mention, is its answer.
 * 2. Then a model (Haiku, the console's text provider) for the asks the plain reader left open, strict JSON, and only
 *    when it quotes words that are really in his note. A model answer whose quote is not in his words counts for nothing.
 * Two different answers for one ask make it unclear: the card asks him one open question instead of guessing.
 */

export type SpokenKind = "approve" | "deny";
export interface SpokenAsk {
  id: string;
  /** The ask's code (E988-A10), when it has one: "E988-A10, no" answers it by name. */
  code?: string;
  /** The one line he reads for it on the card. */
  line: string;
}
export interface SpokenRead {
  id: string;
  kind: SpokenKind | "unclear" | "none";
  /** His words for it, as he said them (the note's own text). */
  quote?: string;
  /** order = "the second one", name = its code, all = "yes to all", only = the card's one ask, model = the model check. */
  how?: "order" | "name" | "all" | "only" | "model";
}
/** The model check: for each ask, what his words answer, with his words for it. */
export type SpokenJudge = (words: string, asks: SpokenAsk[]) => Promise<{ id: string; kind: string; quote?: string }[]>;

const ORDINALS: [RegExp, number][] = [
  [/first|1st|one|1/, 1],
  [/second|2nd|two|2/, 2],
  [/third|3rd|three|3/, 3],
  [/fourth|4th|four|4/, 4],
  [/fifth|5th|five|5/, 5],
  [/sixth|6th|six|6/, 6],
];
/** "the first one", "the second", "first recommendation", "number two", "#3", "the last one". */
const MENTION =
  /\b(?:(?:the\s+)(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th|last)(?:\s+(?:one|recommendation|ask|item|point|question|card))?|(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th|last)\s+(?:one|recommendation|ask|item|point|question)|(?:number|#)\s*(one|two|three|four|five|six|[1-6]))\b/gi;
const YES = /\b(?:yes|yeah|yep|yup|ok|okay|sure|fine|approved?|accept(?:ed)?|agreed?|go ahead|do it|good|correct|sí|si|vale)\b/i;
const NO = /\b(?:no|nope|not|don'?t|do not|never|reject(?:ed)?|declined?|drop it|skip it|deny|denied)\b/i;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[“”"'`*_’]/g, (c) => (c === "’" ? "'" : ""))
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** True when `quote` is in `words` (case, punctuation and spacing aside): a model's answer must quote him. */
export function saidIn(words: string, quote: string | undefined): boolean {
  const q = norm(quote ?? "");
  return q.length >= 2 && norm(words).includes(q);
}

const UNSURE = /\b(?:not sure|don'?t know|do not know|maybe|perhaps|not yet|later|let me think|i'?m not clear)\b/i;

/** The first yes or no word in a stretch of his words; `unclear` when he hedges first; undefined when it has neither. */
export function yesOrNo(stretch: string): SpokenKind | "unclear" | undefined {
  const y = YES.exec(stretch);
  const n = NO.exec(stretch);
  if (!y && !n) return UNSURE.test(stretch) ? "unclear" : undefined;
  const first = y && (!n || y.index < n.index) ? y : n!;
  const u = UNSURE.exec(stretch);
  if (u && u.index <= first.index) return "unclear";
  return first === y ? "approve" : "deny";
}

const ordinalOf = (w: string, count: number): number | undefined => {
  const t = w.toLowerCase();
  if (t === "last") return count;
  for (const [re, n] of ORDINALS) if (new RegExp(`^(?:${re.source})$`).test(t)) return n;
  return undefined;
};

/** The words from a mention to the next mention, at most this many characters: "the second one, no, I don't want …". */
const WINDOW = 90;

/**
 * The plain reader: each ask's answer by order ("the second one, no"), by name ("E988-A10 no") or for all ("yes to all").
 * An ask he did not name stays `none`; one named with both answers is `unclear`.
 */
export function readByOrder(words: string, asks: SpokenAsk[]): SpokenRead[] {
  const found = new Map<string, { kind: SpokenKind | "unclear"; quote: string; how: SpokenRead["how"] }[]>();
  const add = (id: string, kind: SpokenKind | "unclear", quote: string, how: SpokenRead["how"]) => found.set(id, [...(found.get(id) ?? []), { kind, quote: quote.trim(), how }]);
  // every mention, by order or by code, in the order he said them
  const marks: { at: number; end: number; id: string; how: "order" | "name" }[] = [];
  for (const m of words.matchAll(MENTION)) {
    const n = ordinalOf(m[1] ?? m[2] ?? m[3] ?? "", asks.length);
    const a = n ? asks[n - 1] : undefined;
    if (a) marks.push({ at: m.index!, end: m.index! + m[0].length, id: a.id, how: "order" });
  }
  for (const a of asks) {
    if (!a.code) continue;
    const re = new RegExp(`\\b${a.code.replace(/[-.]/g, "[-. ]?")}\\b`, "gi");
    for (const m of words.matchAll(re)) marks.push({ at: m.index!, end: m.index! + m[0].length, id: a.id, how: "name" });
  }
  marks.sort((x, y) => x.at - y.at);
  marks.forEach((mk, i) => {
    const stop = Math.min(marks[i + 1]?.at ?? words.length, mk.end + WINDOW);
    const stretch = words.slice(mk.end, stop);
    const kind = yesOrNo(stretch);
    if (!kind) return;
    // his words for it: the mention up to the end of the clause that holds the answer
    const tail = stretch.split(/(?<=[.!?;])\s/)[0] ?? stretch;
    add(mk.id, kind, words.slice(mk.at, mk.end) + tail, mk.how);
  });
  // "yes to all", "accept all", "all of them, yes", "no to all"
  const all = /\b(?:(yes|ok|okay|approve|accept)\s+(?:to\s+)?(?:all|every one|them all|all of them)|(?:all|all of them|every one)[,:]?\s+(yes|ok|okay|approved|accepted)|(no)\s+to\s+(?:all|all of them|every one))\b/i.exec(words);
  if (all && asks.length > 1) for (const a of asks) if (!found.has(a.id)) add(a.id, all[3] ? "deny" : "approve", all[0], "all");
  return asks.map((a) => {
    const got = found.get(a.id) ?? [];
    if (!got.length) return { id: a.id, kind: "none" as const };
    const kinds = new Set(got.map((g) => g.kind));
    if (kinds.size > 1 || kinds.has("unclear")) return { id: a.id, kind: "unclear" as const, quote: got.map((g) => g.quote).join(" … "), how: got[0].how };
    return { id: a.id, kind: got[0].kind as SpokenKind, quote: got[0].quote, how: got[0].how };
  });
}

/**
 * A card with one ask: only a short plain yes or no is read without the model ("Yes, go ahead.", "No."); a yes with a
 * change ("yes, but …") is never an approval here (it is his feedback, as before).
 */
export function readOnly(words: string): SpokenKind | undefined {
  const t = norm(words);
  if (/^(?:yes|yeah|yep|ok|okay|sure|approved?|accept(?:ed)?|go ahead|do it|si|sí|vale)(?: (?:yes|ok|okay|please|go ahead|do it|thanks|thank you|approved|sure))*$/.test(t)) return "approve";
  if (/^(?:no|nope|don't|do not|never|no thanks|no thank you|declined?|reject(?:ed)?)(?: (?:no|thanks|thank you|thank you no))*$/.test(t)) return "deny";
  return undefined;
}

/**
 * What his words answer, for each ask of the card. The plain reader first; the model only for the asks it left
 * `none` (and only with a quote of his); nothing is guessed: a part that is not plain is `unclear`.
 */
export async function readSpokenAnswers(words: string, asks: SpokenAsk[], judge?: SpokenJudge): Promise<{ reads: SpokenRead[]; judgeError?: string }> {
  const w = words.trim();
  if (!w || !asks.length) return { reads: asks.map((a) => ({ id: a.id, kind: "none" as const })) };
  let reads: SpokenRead[];
  if (asks.length === 1) {
    const k = readOnly(w);
    reads = [k ? { id: asks[0].id, kind: k, quote: w, how: "only" } : { id: asks[0].id, kind: "none" }];
  } else reads = readByOrder(w, asks);
  const open = reads.filter((r) => r.kind === "none");
  if (!open.length || !judge) return { reads };
  try {
    const got = await judge(w, asks);
    const by = new Map(got.map((g) => [g.id, g]));
    reads = reads.map((r) => {
      if (r.kind !== "none") return r;
      const g = by.get(r.id);
      if (!g) return r;
      if ((g.kind === "approve" || g.kind === "deny") && saidIn(w, g.quote)) {
        // one ask: a yes with a change asked is his feedback, never an approval read by the model
        if (asks.length === 1 && g.kind === "approve" && /\bbut\b|\bchange\b|\binstead\b|\bfirst\b/i.test(g.quote ?? "")) return { ...r, kind: "unclear", quote: g.quote, how: "model" };
        return { id: r.id, kind: g.kind, quote: g.quote, how: "model" };
      }
      if (g.kind === "unclear" && saidIn(w, g.quote)) return { id: r.id, kind: "unclear", quote: g.quote, how: "model" };
      return r;
    });
    return { reads };
  } catch (e) {
    return { reads, judgeError: (e as Error).message };
  }
}

const SPOKEN_SYSTEM = [
  "You read what the owner said on a card in his inbox. The card holds numbered asks (recommendations he approves or not).",
  "For EACH ask say what his words answer: approve (he plainly says yes / ok / go ahead to that ask), deny (he plainly says no to it),",
  "unclear (he speaks about that ask but it is not plain whether it is yes or no, or it is not plain which ask a yes or no belongs to), or none (he does not speak about it).",
  "Match by order (the first one = ask 1), by its code, or by what it is about. Never guess: when unsure, unclear.",
  "quote: his exact words for that ask, copied character for character from his note (empty for none).",
].join(" ");
const SPOKEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "quote"],
        properties: { id: { type: "string" }, kind: { type: "string", enum: ["approve", "deny", "unclear", "none"] }, quote: { type: "string" } },
      },
    },
  },
};
const spokenUser = (words: string, asks: SpokenAsk[]) =>
  [`The card's asks, in order:`, ...asks.map((a, i) => `${i + 1}. id ${a.id}${a.code ? ` (${a.code})` : ""}: ${a.line.slice(0, 300)}`), "", `His words: ${words.slice(0, 6000)}`].join("\n");

/** The model check on Claude Haiku (the console's text provider, `CONSOLE_TEXT_MODEL_PROVIDER=anthropic`). */
export function anthropicSpokenJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch): SpokenJudge {
  return async (words, asks) => {
    const { value } = await anthropicJson<{ answers?: { id: string; kind: string; quote?: string }[] }>(key, f, {
      system: SPOKEN_SYSTEM,
      user: spokenUser(words, asks),
      schema: SPOKEN_SCHEMA,
      maxTokens: 1500,
      timeoutMs: 20_000,
    });
    return Array.isArray(value.answers) ? value.answers : [];
  };
}

/**
 * POST /spoken-answers {words, asks: [{id, code?, line}]}: what his words answer on each ask (read only, nothing written).
 * The card then presses each answer through the ask's own respond route.
 */
export function mountSpokenAnswers(api: Hono, o: { judge?: SpokenJudge }): void {
  api.post("/spoken-answers", async (c) => {
    const b = (await c.req.json().catch(() => undefined)) as { words?: unknown; asks?: unknown } | undefined;
    const words = typeof b?.words === "string" ? b.words.slice(0, 20_000) : "";
    const asks = Array.isArray(b?.asks)
      ? (b!.asks as Record<string, unknown>[])
          .filter((a) => a && typeof a.id === "string" && typeof a.line === "string")
          .slice(0, 12)
          .map((a) => ({ id: String(a.id), line: String(a.line), ...(typeof a.code === "string" && a.code ? { code: a.code } : {}) }))
      : [];
    if (!words.trim() || !asks.length) return c.json({ error: { code: "validation_error", message: "send his words and the card's asks" } }, 400);
    const r = await readSpokenAnswers(words, asks, o.judge);
    return c.json(r);
  });
}
