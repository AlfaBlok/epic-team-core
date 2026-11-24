import { askWords, plainMarkdown } from "@/lib/askLead";

/**
 * E948-S200 (the owner closed E948-S109 24 Nov and started this: a yes-or-no card's buttons say Yes and No, not Answer; the
 * E907-S32 card asked "Do you approve one private test notes repo …?" and offered only Answer): the one test of whether a
 * card's question is answered by a yes or a no. A pick question (which, what, how …) or a list of choices (", or …") is
 * not: it takes his words or its options.
 */
const PICK = /^(?:which|what|who|whom|whose|when|where|how|why)\b/i;
const CHOICES = /,\s*or\s+\S/i;

/** the card's own yes-or-no question (its first sentence, ending in "?"), else undefined. */
export function yesNoQuestion(text: string | undefined): string | undefined {
  const t = plainMarkdown(askWords({ question: text ?? "" })).replace(/\s+/g, " ").trim();
  // the first sentence only: a "?" after a full stop belongs to a later sentence, never the card's own question
  const q = /^[^?]*?\?/.exec(t)?.[0]?.trim();
  if (!q || /[.!]\s+\S/.test(q.slice(0, -1)) || q.length < 4) return undefined;
  if (PICK.test(q) || CHOICES.test(q)) return undefined;
  return q;
}

/** true when the question is answered by Yes or No. */
export const isYesNo = (text: string | undefined) => !!yesNoQuestion(text);
