import fs from "node:fs";

/**
 * per-model prices in USD per million tokens, used for the `costUsd` ESTIMATE on a run's usage. Seats are
 * subscriptions, so this is what the same tokens would cost at API list price, not a bill. Cache write = the 5-minute
 * rate (1.25x input); Claude Code also writes 1-hour cache (2x input), so writes are a lower bound.
 * Override with CONSOLE_USAGE_PRICES=<path to a JSON file of the same shape>; keys are exact model ids or a family
 * word (`opus`, `sonnet`, `haiku`, `fable`) matched inside the model id.
 */
export interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
export type PriceTable = Record<string, Price>;

export const DEFAULT_PRICES: PriceTable = {
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  // Families (older or newer ids of the same tier) fall back to the current tier's price.
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  haiku: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

export function pricesFromEnv(env: NodeJS.ProcessEnv = process.env): PriceTable {
  const file = env.CONSOLE_USAGE_PRICES;
  if (!file) return DEFAULT_PRICES;
  try {
    return { ...DEFAULT_PRICES, ...(JSON.parse(fs.readFileSync(file, "utf8")) as PriceTable) };
  } catch (e) {
    console.warn(`usage prices ${file}: ${(e as Error).message}; using defaults`);
    return DEFAULT_PRICES;
  }
}

export function priceFor(model: string, table: PriceTable = DEFAULT_PRICES): Price | undefined {
  if (table[model]) return table[model];
  const family = ["fable", "opus", "sonnet", "haiku"].find((f) => model.includes(f));
  return family ? table[family] : undefined;
}

export interface TokenCounts {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** USD for these tokens at the model's price; undefined when the model has no price (unknown model). */
export function costUsd(model: string, t: TokenCounts, table: PriceTable = DEFAULT_PRICES): number | undefined {
  const p = priceFor(model, table);
  if (!p) return undefined;
  return (t.input * p.input + t.output * p.output + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1_000_000;
}
