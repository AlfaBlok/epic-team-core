/**
 * E948-S151 (the owner on E940-A10, 2026-11-18, vn_b2c9395c: "If you don't give me a link, how the fuck do you expect me to
 * choose? ... why is it that you give me a choice without showing me the choice"): the page or picture an ask points at
 * sits on the card's face, above its buttons, wherever the ask wrote it. E940-A10 put its mockups link in its `context:`
 * prose, which the card showed only inside its collapsed "more" part, so the card he saw had the A, B and C buttons and
 * nothing to look at. The server's gate (inbox/askGate.ts choiceLinkProblem) reads the same fields.
 */

/** The fields of an ask the face link is read from, in the order a link is picked. */
export interface FaceLinkAsk {
  question?: string;
  contextText?: string;
  impact?: string;
  recommendation?: string;
  whyYou?: string;
  risk?: string;
  steps?: string;
  options?: string[];
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
/** A link to a spine line on GitHub: where the team writes, never what he looks at. */
const GITHUB_BLOB = /github\.com\/.+\/blob\//;
/** A picture he can look at on the card itself. */
export const IMAGE_URL = /\.(?:png|webp|jpe?g|gif|avif|svg)(?:[?#]\S*)?$/i;

/** Every web link in a text, markdown targets included, its trailing punctuation dropped. */
export function linksIn(text: string | undefined): string[] {
  if (!text) return [];
  const t = text.replace(/!?\[[^\]]*\]\(([^)\s]+)\)/g, " $1 ");
  return [...t.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, "")).filter((u) => !GITHUB_BLOB.test(u));
}

/** The links the ask's words carry, question first, no repeats. */
export function faceLinks(a: FaceLinkAsk): string[] {
  const all = [a.question, a.contextText, ...(a.options ?? []), a.recommendation, a.impact, a.steps, a.whyYou, a.risk].flatMap(linksIn);
  return [...new Set(all)];
}

/** A choice among named things (A, B or C; two layouts), never a bare yes or no. */
export function isChoice(a: { ask?: string; options?: string[] }): boolean {
  const opts = (a.options ?? []).filter((o) => !/^(?:yes|no)\b/i.test(o.trim()));
  return a.ask === "decide" && opts.length >= 2;
}

/** The label of the card's face link: a choice says what the link is for. */
export function faceLabel(a: { ask?: string; options?: string[] }, url: string): string {
  if (isChoice(a)) return IMAGE_URL.test(url) ? "See the options (picture)" : "See the options";
  const host = url.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  return /:\d+$|\.ts\.net$|^\d+\.\d+\.\d+\.\d+|^localhost/i.test(host) ? "Open the page" : `Open ${host}`;
}
