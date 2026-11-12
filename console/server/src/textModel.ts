import Anthropic from "@anthropic-ai/sdk";
import { keyFile } from "./identity.js";

/**
 * The console's small text calls (voice feedback structurer, settle judge) on Anthropic's credit account.
 * `CONSOLE_TEXT_MODEL_PROVIDER` = `anthropic` picks the Claude path; unset or `openai` keeps the OpenAI path as it was.
 * Rollback: set it to `openai` (or remove it) and restart.
 */
export type TextModelProvider = "anthropic" | "openai";
export const textModelProvider = (env: NodeJS.ProcessEnv = process.env): TextModelProvider =>
  (env.CONSOLE_TEXT_MODEL_PROVIDER ?? "").trim().toLowerCase() === "anthropic" ? "anthropic" : "openai";

/** The credit account's key (the owner pasted it in the steps page's private box); read with `sudo -n` like the OpenAI key. */
export const anthropicStoreFile = (): string => keyFile("ANTHROPIC_API_KEY");
export const ANTHROPIC_TEXT_MODEL = "claude-haiku-5-5";
/** claude-haiku-5-5, US$ per 1M tokens, prompts up to 100K tokens (claude-api skill, cached 2026-10-06). */
export const ANTHROPIC_TEXT_PRICES = { in: 0.1, out: 0.5 };

export interface JsonCall {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  timeoutMs: number;
}

/** One strict-JSON Messages call on Haiku 5.5 (`output_config.format`, effort low); returns the parsed value and its cost. */
export async function anthropicJson<T>(key: () => Promise<string | undefined>, f: typeof fetch, call: JsonCall): Promise<{ value: T; costUsd: number }> {
  const k = await key();
  if (!k) throw new Error("the console has no ANTHROPIC_API_KEY");
  const client = new Anthropic({ apiKey: k, fetch: f, maxRetries: 1, timeout: call.timeoutMs });
  let msg: Anthropic.Message;
  try {
    msg = await client.messages.create({
      model: ANTHROPIC_TEXT_MODEL,
      max_tokens: call.maxTokens,
      system: call.system,
      messages: [{ role: "user", content: call.user }],
      output_config: { effort: "low", format: { type: "json_schema", schema: call.schema } },
    });
  } catch (e) {
    const status = e instanceof Anthropic.APIError ? e.status : undefined;
    throw new Error(`Claude did not answer (${status ?? "no status"}): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  if (msg.stop_reason === "refusal") throw new Error("Claude declined the request (refusal)");
  if (msg.stop_reason === "max_tokens") throw new Error("Claude ran out of tokens before the JSON was complete");
  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`Claude sent no text (${msg.stop_reason ?? "no stop reason"})`);
  const u = msg.usage;
  const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const costUsd = Math.round(((inTok * ANTHROPIC_TEXT_PRICES.in + (u.output_tokens ?? 0) * ANTHROPIC_TEXT_PRICES.out) / 1_000_000) * 1e6) / 1e6;
  return { value: JSON.parse(text) as T, costUsd };
}
