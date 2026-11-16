import { TEAM_HEAD } from "../brand.js";
import { memoryName, socialProduct } from "../identity.js";

/**
 * A relay names only the product his words name.
 *
 * 16 Nov: the owner told his social desk "It has customers. It has promotion ... It needs an accounting wheel" (he meant
 * his books product); that desk passed it with a summary naming the memory product, the Team desk trusted the summary
 * and sent the memory product's desk a note, and a plan was built for the wrong product. The summary (`about`) is the
 * desk's words, the quote is his: a product the summary names and his words do not is a guess, so the relay refuses it
 * and the desk asks him one open question instead (root L-66). "<Product> desk" is where he spoke, never the product.
 */
let names: Record<string, string[]> = {};

/** our product names and the other spellings his speech-to-text gives them (a hosted layer sets them; tests too) */
export function setProductNames(next: Record<string, string[]>): void {
  names = { ...next };
}

const words = (name: string): string => name.replace(/([a-z])([A-Z])/g, "$1 ?$2");
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function patterns(): [string, RegExp][] {
  const all = new Map<string, string[]>();
  for (const n of [TEAM_HEAD.name, socialProduct(), memoryName()]) if (n) all.set(n, []);
  for (const [n, alias] of Object.entries(names)) all.set(n, [...(all.get(n) ?? []), ...alias]);
  for (const n of (process.env.CONSOLE_PRODUCT_NAMES ?? "").split(",").map((x) => x.trim()).filter(Boolean)) if (!all.has(n)) all.set(n, []);
  return [...all].map(([n, alias]) => [n, new RegExp(`\\b(?:${[n, ...alias].map((x) => words(esc(x))).join("|")})\\b`, "i")]);
}

/** the products a text names */
export function productsIn(text: string): Set<string> {
  return new Set(patterns().filter(([, rx]) => rx.test(text)).map(([n]) => n));
}

/** the products a summary names that his words do not ("<Product> desk", where he said it, never counts) */
export function productsAdded(summary: string, his: string): string[] {
  const desks = new RegExp(`\\b(?:${patterns().map(([, rx]) => rx.source.replace(/^\\b|\\b$/g, "")).join("|")})\\s+desk\\b`, "gi");
  const named = productsIn(his);
  return [...productsIn(summary.replace(desks, " "))].filter((n) => !named.has(n));
}
