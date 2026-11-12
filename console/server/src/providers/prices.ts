import { DEFAULT_PRICES, priceFor, type Price, type PriceTable, type TokenCounts } from "../usage/prices.js";

/**
 * price per provider and model, data only (nothing is bought or spent here). A run's priceKey
 * (stamped from the dispatcher's pick) picks the table; seats are subscriptions, so `claude-seat` is the Anthropic API
 * list price marked notional: credits still measure seat work. USD per million tokens, as usage/prices.ts.
 * Rows for providers no world uses yet are list prices to check when a world first enables them (S10).
 */
export interface ProviderPrices {
  /** true: not a bill (seat subscription); the ledger marks the debit notional. */
  notional: boolean;
  models: PriceTable;
}

export const PROVIDER_PRICES: Record<string, ProviderPrices> = {
  "claude-seat": { notional: true, models: DEFAULT_PRICES },
  "anthropic-api": { notional: false, models: DEFAULT_PRICES },
  // OpenRouter passes Anthropic models through at the provider's list price (its own fee is on top-ups, not tokens).
  openrouter: { notional: false, models: DEFAULT_PRICES },
  // OpenCode / Codex bill through whatever key the instance carries; until their usage scanners exist (plan §4 cut)
  // the Anthropic list price is the estimate.
  opencode: { notional: false, models: DEFAULT_PRICES },
  codex: { notional: false, models: DEFAULT_PRICES },
};

/** Today's runs have no priceKey: they ran on the seat pool. */
export const DEFAULT_PRICE_KEY = "claude-seat";

export interface ProviderPrice extends Price {
  priceKey: string;
  notional: boolean;
}

/** The per-model price under a provider, or undefined (unknown provider or model). */
export function providerPrice(priceKey: string | undefined, model: string, table = PROVIDER_PRICES): ProviderPrice | undefined {
  const key = priceKey || DEFAULT_PRICE_KEY;
  const prov = table[key];
  const p = prov && priceFor(model, prov.models);
  return p ? { ...p, priceKey: key, notional: prov.notional } : undefined;
}

/** USD for these tokens at that provider's price for the model, with whether it is notional; undefined when unpriced. */
export function providerCostUsd(priceKey: string | undefined, model: string, t: TokenCounts, table = PROVIDER_PRICES) {
  const p = providerPrice(priceKey, model, table);
  if (!p) return undefined;
  const usd = (t.input * p.input + t.output * p.output + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1_000_000;
  return { usd, priceKey: p.priceKey, notional: p.notional };
}
