/**
 * Is a quote really the owner's words in one of his chat messages? One rule for every chat (the Team desk, a
 * world's own desk such as the social product's, a milestone chat) and for typed and spoken words alike: a voice-note
 * transcript in the thread is his message, exactly like text he typed.
 *
 * Words are compared, never punctuation or case: speech-to-text puts in commas, dashes and curly quotes the quoting
 * agent may drop or retype. A quote may leave out a middle part (`[...]`, `…`, `...`): every part must then be in the
 * SAME message of his, in order. Every part still needs two characters of words, so nothing short slips through.
 */

/** His words only: lower case, letters and digits, one space between words. */
export const saidWords = (t: string): string =>
  t
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The parts of a quote split at an elision mark (`[...]`, `[…]`, `…`, `...`), as words. */
export const quoteParts = (quote: string): string[] =>
  quote
    .split(/\[\s*(?:\.{3}|…)\s*\]|…|\.{3,}/)
    .map(saidWords)
    .filter((p) => p.length > 0);

/** Is `quote` inside `message` (every part, in order)? */
export function saidIn(message: string, quote: string): boolean {
  const parts = quoteParts(quote);
  if (!parts.length || parts.some((p) => p.length < 2)) return false;
  const text = ` ${saidWords(message)} `;
  let from = 0;
  for (const p of parts) {
    const at = text.indexOf(` ${p} `, from);
    if (at < 0) return false;
    from = at + p.length + 1;
  }
  return true;
}

/** Is `quote` in one of these messages of his? */
export const saidInAny = (messages: { text: string }[], quote: string): boolean => messages.some((m) => saidIn(m.text, quote));

/**
 * The desk files rows from his words, and those rows are his ask (L-37,
 * L-68). The Add used the stamp's rule (his NEWEST desk message, under 15 minutes), so a row filed from a voice note he sent
 * before another message, or after the console posted a [delivered] note, or from a long note filed over more than 15
 * minutes, went in as a draft: 20 rows in two days sat as drafts for hours.
 * Now the quote counts when it is in ANY of his own messages (typed, a Chat or WhatsApp voice note, plumbing never) of the
 * last `maxMs`; the newest such message is returned. Needs at least MIN_ADD_WORDS characters of his words.
 */
export const ADD_WORDS_MAX_MS = 24 * 60 * 60_000;
export const MIN_ADD_WORDS = 8;
export function hisWordsIn(
  messages: { text: string; at?: string }[],
  quote: string,
  now: number,
  maxMs = ADD_WORDS_MAX_MS,
): { text: string; at: string } | string {
  if (saidWords(quote).length < MIN_ADD_WORDS) return `chat (his words, verbatim, at least ${MIN_ADD_WORDS} characters) is required`;
  const recent = messages.filter((m) => {
    const at = Date.parse(m.at ?? "");
    return Number.isFinite(at) && now - at <= maxMs;
  });
  if (!recent.length) return `he has written nothing in the desk chat in the last ${Math.round(maxMs / 3_600_000)} hours`;
  for (let i = recent.length - 1; i >= 0; i--) if (saidIn(recent[i].text, quote)) return { text: recent[i].text, at: recent[i].at! };
  return `chat is not in any of his desk messages of the last ${Math.round(maxMs / 3_600_000)} hours`;
}
