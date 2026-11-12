import { socialProduct } from "@/lib/identity";
/**
 * the console and the other desk pass the owner's words into a desk's thread as
 * user-role messages, so the desk Chat drew them as his own (right side, his colour). This reads the console's heads so the
 * Chat can show them apart:
 *
 * - `↔ From the social product desk (dx_…): <about>.` (cross.ts crossLine / relayLine, and's card voice notes, which
 *   cross with the same head): his words, passed in from his other desk. `from`.
 * - `↔ Passed to the social product desk (dx_…): <about>.` (cross.ts passedLine): the console telling this desk where a part
 *   went. `to`.
 * - `📎 Also in this note (vn_…): <rest>.` (spill.ts spillLine): the rest of a voice note he filed on a card. `spill`.
 *
 * Anything else: undefined, shown as written (his own message).
 */
export type PassedKind = "from" | "to" | "spill";
export interface Passed {
  kind: PassedKind;
  /** The other desk's product (`from` / `to`); absent for a spill (same desk). */
  desk?: string;
  /** The crossing id (`dx_…`) or the voice note id (`vn_…`). */
  id: string;
  /** What the part is about, in a few plain words. */
  about: string;
  /** His words, as quoted (empty when the line carries none). */
  quote: string;
  /** Where he said it: the desk's chat page (`from`), the desk it went to (`to`). */
  url?: string;
  /** A spill: the item he recorded the note on (`card: …`). */
  where?: string;
  /** The console's instructions to the desk, kept folded. */
  brief: string;
}

// the two desks' product names: EpicTeam and the social product's (identity)
const desks = () => `(EpicTeam|${socialProduct().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`;
const headFrom = () => new RegExp(String.raw`^\s*↔ From the ${desks()} desk \(([^)]+)\):[ \t]*([^\n]*)`, "u");
const headTo = () => new RegExp(String.raw`^\s*↔ Passed to the ${desks()} desk \(([^)]+)\):[ \t]*([^\n]*)`, "u");
const HEAD_SPILL = /^\s*📎 Also in this note \(([^)]+)\):[ \t]*([^\n]*)/u;

const stop = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** `His words: "…"` (cross) or `His words: …` (spill), the last part of the message. */
function quoted(text: string): { quote: string; before: string } {
  const i = text.lastIndexOf("His words:");
  if (i < 0) return { quote: "", before: text };
  let q = text.slice(i + "His words:".length).trim();
  if (q.startsWith('"') && q.endsWith('"') && q.length >= 2) q = q.slice(1, -1);
  return { quote: q.trim(), before: text.slice(0, i) };
}

const firstUrl = (s: string) => s.match(/https?:\/\/[^\s)]+/)?.[0];

export function passedHead(text: string): Passed | undefined {
  if (!text) return undefined;
  let m = text.match(headFrom());
  if (m) {
    const rest = text.slice(m[0].length);
    const { quote, before } = quoted(rest);
    return { kind: "from", desk: m[1] as Passed["desk"], id: m[2], about: stop(m[3]), quote, url: firstUrl(before), brief: before.trim() };
  }
  m = text.match(headTo());
  if (m) {
    const rest = text.slice(m[0].length);
    return { kind: "to", desk: m[1] as Passed["desk"], id: m[2], about: stop(m[3]), quote: "", url: firstUrl(rest), brief: rest.trim() };
  }
  m = text.match(HEAD_SPILL);
  if (m) {
    const rest = text.slice(m[0].length);
    const { quote, before } = quoted(rest);
    const where = before.match(/recorded this voice note on (.+?); that part went there/)?.[1];
    return { kind: "spill", id: m[1], about: stop(m[2]), quote, where, brief: before.trim() };
  }
  return undefined;
}

/** The label over the card, in his words: who passed it in. */
export function passedLabel(p: Passed): string {
  if (p.kind === "from") return `Passed from your ${p.desk} desk`;
  if (p.kind === "to") return `Passed on to your ${p.desk} desk`;
  return "The rest of your voice note";
}
