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
