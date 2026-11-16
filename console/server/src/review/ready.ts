/**
 * (the owner, Team desk 2026-11-16 08:04Z: "problem is email showed in the drafts but i was hping for an email
 * or somethingi nmy epicteam inbox notifying - came in too subtly"): a card for something he is waiting on is "ready for
 * you". It leads his inbox, set apart, with the one action and where the thing is (web components/readyFirst.tsx), and
 * the console tells him once per ready event by WhatsApp, or by mail when WhatsApp cannot (hosted notify/readyNotice.ts).
 *
 * He is waiting on it when:
 * - its card says where the thing is (`ready:`), the worker's own word that it is ready for him;
 * - its card has a `deadline:`;
 * - its card's `source:` (his own words) says urgent (his "mark it as urgent"); a row title that only describes an urgent
 *   card does not count (a title saying "marked urgent" about another card);
 * - his own words on the row or in its source ask for it: "get me…", "send me…", "email me…", "give it back to me".
 */
export type ReadyWhy = "ready" | "deadline" | "urgent" | "asked";

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
export const URGENT = /\burgent(ly)?\b|\bas a matter of urgency\b/i;

const WHY_TEXT: Record<ReadyWhy, string> = {
  ready: "You were waiting on this",
  deadline: "It has a deadline",
  urgent: "You marked it urgent",
  asked: "You asked for it",
};

export function readyOf(o: {
  ready?: { where: string; url?: string };
  deadline?: { at: string };
  /** the row's title cell and the card's source: his words among them. */
  words: string[];
  /** the card's `source:` alone (urgent counts only there). */
  source?: string;
  evidence: { url: string; label?: string };
}): CardReady | undefined {
  const text = o.words.filter(Boolean).join(" \n ");
  const why: ReadyWhy | undefined = o.deadline ? "deadline" : URGENT.test(o.source ?? "") ? "urgent" : ASKED_FOR.test(text) ? "asked" : o.ready ? "ready" : undefined;
  if (!why) return undefined;
  const url = o.ready?.url ?? o.evidence.url ?? "";
  const where = o.ready?.where || o.evidence.label || url;
  return { why, whyText: WHY_TEXT[why], where, url };
}
