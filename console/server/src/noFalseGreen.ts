/**
 * No false green (the owner: "we turned green, all channels are active. How many postings ... yesterday? Zero.
 * Measurements? Zero."): a key result that counts its posts and their readings (a channel line) is never green with
 * 0 posts (red) or 0 readings (not measured), whatever colour its file says. Every screen, picture and alert reads it.
 */
export function noFalseGreen<S extends string>(colour: S, k: { posts?: unknown; readings?: unknown }): S | "red" | "unknown" {
  if (colour !== "green") return colour;
  if (k.posts === 0) return "red";
  if (k.readings === 0) return "unknown";
  return colour;
}
