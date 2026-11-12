/**
 * the one place the voice call's prices live, in US$ per 1M tokens, read from the OpenAI pricing page
 * (developers.openai.com/api/docs/pricing) on 2026-11-01. Re-check it when OpenAI changes a price, then edit only here.
 * Cached input is billed at its own (much lower) price; `text_tokens` / `audio_tokens` in the API's usage include the
 * cached ones, so the uncached part is the total minus the cached part.
 */
export interface Prices {
  textIn: number;
  textCachedIn: number;
  textOut: number;
  audioIn: number;
  audioCachedIn: number;
  audioOut: number;
}

export const PRICES_CHECKED = "2026-11-01";
export const PRICES: Record<string, Prices> = {
  "gpt-realtime-2.1-mini": { textIn: 0.6, textCachedIn: 0.06, textOut: 2.4, audioIn: 10, audioCachedIn: 0.3, audioOut: 20 },
  "gpt-realtime-2.1": { textIn: 4, textCachedIn: 0.4, textOut: 24, audioIn: 32, audioCachedIn: 0.4, audioOut: 64 },
};
/** the owner's words are transcribed for the captions and the Chat transcript by this model, billed apart. */
export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const TRANSCRIBE_PRICES = { in: 1.25, out: 5 };
/** A model missing from the table is priced as the bigger one, so the meter never reads low. */
const FALLBACK = PRICES["gpt-realtime-2.1"];
export const pricesFor = (model: string): Prices => PRICES[model] ?? FALLBACK;

/** Token counts of one call (or one response), by kind. */
export interface Tokens {
  textIn: number;
  textCachedIn: number;
  audioIn: number;
  audioCachedIn: number;
  textOut: number;
  audioOut: number;
  /** Transcription of the owner's audio (gpt-4o-mini-transcribe): input and output tokens. */
  trIn: number;
  trOut: number;
}
export const zeroTokens = (): Tokens => ({ textIn: 0, textCachedIn: 0, audioIn: 0, audioCachedIn: 0, textOut: 0, audioOut: 0, trIn: 0, trOut: 0 });
export const addTokens = (a: Tokens, b: Tokens): Tokens => {
  const out = zeroTokens();
  for (const k of Object.keys(out) as (keyof Tokens)[]) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
};

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * The Realtime API's `usage` of a `response.done` event, as token counts. `textIn` / `audioIn` are the uncached input
 * tokens; the cached ones are counted apart.
 */
export function tokensOfResponse(usage: unknown): Tokens {
  const u = (usage ?? {}) as Record<string, any>;
  const inD = u.input_token_details ?? {};
  const outD = u.output_token_details ?? {};
  const cachedD = inD.cached_tokens_details ?? {};
  const cachedText = n(cachedD.text_tokens);
  const cachedAudio = n(cachedD.audio_tokens);
  // Older payloads give only cached_tokens: put them on text (the cheaper rate is applied either way to fewer tokens).
  const cachedOther = cachedText + cachedAudio === 0 ? n(inD.cached_tokens) : 0;
  const t = zeroTokens();
  t.textCachedIn = cachedText + cachedOther;
  t.audioCachedIn = cachedAudio;
  t.textIn = Math.max(0, n(inD.text_tokens) - t.textCachedIn);
  t.audioIn = Math.max(0, n(inD.audio_tokens) - cachedAudio);
  t.textOut = n(outD.text_tokens);
  t.audioOut = n(outD.audio_tokens);
  // No per-kind detail at all: the totals count as text (cheapest wrong answer would be audio-free: say so in the row).
  if (!u.input_token_details && n(u.input_tokens)) t.textIn = n(u.input_tokens);
  if (!u.output_token_details && n(u.output_tokens)) t.textOut = n(u.output_tokens);
  return t;
}

/** The `usage` of a `conversation.item.input_audio_transcription.completed` event (type `tokens`). */
export function tokensOfTranscription(usage: unknown): Tokens {
  const u = (usage ?? {}) as Record<string, any>;
  const t = zeroTokens();
  t.trIn = n(u.input_tokens);
  t.trOut = n(u.output_tokens);
  return t;
}

/** US$ for these tokens on this model (six decimals). */
export function costOf(model: string, t: Tokens): number {
  const p = pricesFor(model);
  const usd =
    (t.textIn * p.textIn +
      t.textCachedIn * p.textCachedIn +
      t.audioIn * p.audioIn +
      t.audioCachedIn * p.audioCachedIn +
      t.textOut * p.textOut +
      t.audioOut * p.audioOut +
      t.trIn * TRANSCRIBE_PRICES.in +
      t.trOut * TRANSCRIBE_PRICES.out) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
