/**
 * (the owner, Team desk 2026-11-16 08:04Z: "problem is email showed in the drafts but i was hping for an email
 * or somethingi nmy epicteam inbox notifying - came in too subtly"): a card for something he is waiting on is "ready for
 * you". It leads the inbox section it belongs to, never a section of its own, with the one action and where the thing is
 * (web components/readyFirst.tsx), and
 * the console tells him once per ready event by WhatsApp, or by mail when WhatsApp cannot (hosted notify/readyNotice.ts).
 *
 * He is waiting on it when:
 * - its card says where the thing is (`ready:`), the worker's own word that it is ready for him;
 * - its card has a `deadline:`;
 * - its card's `source:` (his own words) says urgent (his "mark it as urgent"); a row title that only describes an urgent
 *   card does not count (a title saying "marked urgent" about another card);
 * - his own words on the row or in its source ask for it: "get me…", "send me…", "email me…", "give it back to me";
 * - it is an output he asked for, a result he reads (a list, a shortlist, an analysis, a report): his
 *   "if I'm asking for an output ... it needs to have a review card ... like a high priority green" (28 Nov, e-6765db).
 */
export type ReadyWhy = "ready" | "deadline" | "urgent" | "output" | "asked";

export interface CardReady {
  why: ReadyWhy;
  /** why he is waiting, in plain words ("You asked for it", "It has a deadline"). */
  whyText: string;
  /** where the thing is, in plain words. */
  where: string;
  /** the one place to open it ("" when the card names no link). */
  url: string;
}

/** his words asking for something to be made and handed to him. */
export const ASKED_FOR = /\b(get|send|email|e-mail|mail|give|bring|hand)\s+(it\s+|that\s+|this\s+|them\s+)?(back\s+)?(to\s+)?me\b/i;
/**
 * an output he asked for, a result he has to read ("a result, a list, a short list or a competitive analysis",
 * 28 Nov, e-6765db). Matched on the row's title and the card's source, title and goal.
 */
export const OUTPUT = /\b(short[- ]?list|competitive analysis|(?:an?|competitor|market|cost|price|gap)\s+analysis|an? list of|(?:make|give|send|get|build|write)\s+(?:me\s+)?(?:a|the)\s+list|comparison of|report on|research on)\b/i;
export function askedOutput(words: string[]): boolean {
  return OUTPUT.test(words.filter(Boolean).join(" \n "));
}
/** the reason words a small sure change closes itself with (`done (no confirm: small sure change: <why>)`). */
export const SMALL_SURE = "small sure change";
export const URGENT = /\burgent(ly)?\b|\bas a matter of urgency\b/i;
/**
 * E948-S168 (the owner, 22 Nov 05:09Z, on the Adeje card titled "Urgent."): "If something is being marked urgent, why is it
 * not actually labeled urgent properly?". A title that opens with the word Urgent (`Urgent.`, `URGENT:`, `**Urgent** -`)
 * is the team's label for his urgent note, never the card's title: the card goes in Urgent and the word is cut off.
 */
export const URGENT_LEAD = /^\s*(?:\*\*|__)?\s*urgent\s*(?:\*\*|__)?\s*(?:[.:!]+|\s[—–-])\s*(?:\*\*|__)?\s*/i;
/** the title without its leading Urgent label, and whether it had one ("Urgent." alone keeps nothing, so the rest stays). */
export function cutUrgentLead(title: string): { title: string; urgent: boolean } {
  const m = URGENT_LEAD.exec(title ?? "");
  if (!m) return { title: title ?? "", urgent: false };
  const rest = title.slice(m[0].length).trim();
  return { title: rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : title, urgent: true };
}

const WHY_TEXT: Record<ReadyWhy, string> = {
  ready: "You were waiting on this",
  deadline: "It has a deadline",
  urgent: "You marked it urgent",
  output: "A result you asked for",
  asked: "You asked for it",
};

export function readyOf(o: {
  ready?: { where: string; url?: string };
  deadline?: { at: string };
  /** the row's title cell and the card's source: his words among them. */
  words: string[];
  /** the card's `source:` alone (his words: urgent counts there). */
  source?: string;
  /** E948-S168: the card or its row is labelled urgent (an `Urgent.` title, the card's `label: urgent`). */
  labelled?: boolean;
  evidence: { url: string; label?: string };
}): CardReady | undefined {
  const text = o.words.filter(Boolean).join(" \n ");
  // E948-S168: urgent wins over a deadline (the Adeje card had both and sat under Done as "It has a deadline").
  const why: ReadyWhy | undefined = o.labelled || URGENT.test(o.source ?? "") ? "urgent" : o.deadline ? "deadline" : OUTPUT.test(text) ? "output" : ASKED_FOR.test(text) ? "asked" : o.ready ? "ready" : undefined;
  if (!why) return undefined;
  const url = o.ready?.url ?? o.evidence.url ?? "";
  const where = o.ready?.where || o.evidence.label || url;
  return { why, whyText: WHY_TEXT[why], where, url };
}
