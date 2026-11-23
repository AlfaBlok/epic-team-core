/**
 * E948-S172 (the owner, 22 Nov, vn_106f5727: "can you not just put ... somewhere there that says what's the topic, what
 * is this related to ... I keep saying this, can you please do it"): every card opens with `About: <topic>`.
 * The server sends `about` on asks and review cards (server/src/inbox/about.ts: the card's own words, else derived).
 * A card the server words no topic for (a team card, a Mac ticket, an older release) gets one here, the same way:
 * the first clause of its title in plain words, no codes, links or brackets, 8 words or fewer.
 */
const CODE = /\b(?:EPIC-\d+(?:-A\d+)?|[A-Z][A-Z0-9]{0,5}-(?:[A-Z]{1,2}\d+[\w.-]*|A\d+|\d+(?:\.\d+)?))\b|\bvn_[0-9a-f]{6,}\b/g;
const TAIL = /^(?:and|or|but|the|a|an|to|of|for|with|in|on|by|from|at|his|her|your|our|its|their|that|which|is|are|was|were|so|as)$/i;

export function aboutFrom(...texts: (string | null | undefined)[]): string | undefined {
  for (const t of texts) {
    if (!t?.trim()) continue;
    const p = t
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\bhttps?:\/\/\S+/g, " ")
      .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
      .replace(CODE, " ")
      .replace(/[*_`;|"“”·]/g, " ")
      .replace(/\s+Core:.*$/i, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s,.:—–-]+/, "")
      // a card's label is not its topic: "You decide:", "You do:", "Answer on this card:", "Urgent."
      .replace(/^(?:urgent\.?\s+)?(?:you\s+(?:decide|do|answer|approve|give|pick|choose)|answer on this card)\s*:\s*/i, "")
      .trim();
    let clause = (p.split(/(?<=[.?!])\s+|\s*:\s+|\s+[—–-]\s+/)[0] ?? p).replace(/[\s,.:;—–-]+$/, "");
    if (clause.split(/\s+/).length > 8) clause = clause.split(/,\s+/)[0] ?? clause;
    const w = clause.split(/\s+/).filter(Boolean).slice(0, 8);
    while (w.length > 1 && TAIL.test(w[w.length - 1]!)) w.pop();
    const out = w.join(" ").replace(/[,.:;]+$/, "");
    if (out) return out;
  }
  return undefined;
}
