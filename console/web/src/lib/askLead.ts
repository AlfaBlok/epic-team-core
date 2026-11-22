/**
 * every card in his inbox opens with ONE big line by kind, then `Why:` in one
 * line; the rest is folded. The ask's own lead line wins when it starts that way ("You approve: …"); otherwise the line is
 * derived from its kind and its first sentence.
 */
import type { AskKind } from "@/api";

export type LeadKind = "approve" | "decide" | "do" | "give" | "check" | "answer";

export interface Lead {
  kind: LeadKind;
  /** "You approve", "You decide", … */
  verb: string;
  /** The one thing, short. */
  what: string;
  /** One line, or undefined when nothing says why. */
  why?: string;
  /** true when the ask itself opened with the lead line (the persona wrote it the L-56 way). */
  own: boolean;
}

export const LEAD_VERB: Record<LeadKind, string> = {
  approve: "You approve",
  decide: "You decide",
  do: "You do",
  give: "You give",
  check: "You check",
  answer: "You answer",
};

const FROM_ASK: Record<AskKind, LeadKind> = { approve: "approve", decide: "decide", do: "do", provide: "give", unknown: "answer" };

// E948-S160: "You give, urgent: …" is the ask's own lead too (E995-A10 opened that way and lost its lead line).
const OWN = /^\s*(?:\*\*)?you\s+(approve|decide|do|give|provide|check|answer)(?:\s*,\s*urgent)?\s*(?:\*\*)?\s*:\s*/i;
const WHY = /(?:^|[\s.;—–-])\s*why\s*:\s*/i;
/** Openers that only say the kind again ("Approve:", "Decision:", "Please …"), dropped from a derived line. */
const KIND_OPENER = /^\s*(?:approve|approval|decide|decision|do|action|provide|answer|respond|please)\s*[:\-–—]\s*/i;
const MAX = 160;
/** The kind's own verb at the start of a derived line, said already by "You approve:" etc. */
const SAME_VERB: Partial<Record<LeadKind, RegExp>> = {
  approve: /^\s*(?:can you |could you |please |do you |will you )?approve\s+/i,
  decide: /^\s*(?:please )?decide\s+(?:on\s+|whether\s+|between\s+)?/i,
  do: /^\s*(?:please )?do\s+(?!you\b|we\b)/i,
  give: /^\s*(?:please )?(?:provide|give|send|paste)\s+(?:us\s+|me\s+)?/i,
};

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The first sentence (or the part before an em-dash field), trimmed to about one line. */
export function firstSentence(text: string | undefined, max = MAX): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  // a sentence ends at. ? ! followed by a space and a capital, or at " — " (the ask line's field separator)
  const m = /^(.+?[.?!])(?=\s+["“(]?[A-Z])|^(.+?)\s+[—–]\s+/.exec(flat);
  const one = (m ? (m[1] ?? m[2]) : flat).trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "")}…`;
}

const strip = (s: string) => s.replace(/^[\s:,;—–-]+/, "").replace(/[\s;,—–-]+$/, "");

/** Splits "<lead> Why: <why>" in the ask's own words. */
function splitWhy(text: string): { head: string; why?: string } {
  const m = WHY.exec(text);
  if (!m) return { head: text };
  return { head: text.slice(0, m.index), why: strip(text.slice(m.index + m[0].length)) };
}

export function askLead(item: {
  ask: AskKind;
  question?: string;
  title?: string;
  options?: string[];
  impact?: string;
  whyYou?: string;
  contextText?: string;
  recommendation?: string;
}): Lead {
  const full = (item.question || item.title || "").replace(/\s+/g, " ").trim();
  // E948-S129: the page link an ask opens with is the card's own link (askLeadUrl), never the start of its line
  const text = full.replace(LEAD_MD, "").replace(LEAD_URL, "").trim() || full;
  const own = OWN.exec(text);
  if (own) {
    const raw = own[1].toLowerCase();
    const kind: LeadKind = raw === "provide" ? "give" : (raw as LeadKind);
    const { head, why } = splitWhy(text.slice(own[0].length));
    const what = firstSentence(strip(head)) || text;
    return { kind, verb: LEAD_VERB[kind], what: what[0].toUpperCase() + what.slice(1), why: why ? cap(firstSentence(why)) : derivedWhy(item), own: true };
  }
  const kind = FROM_ASK[item.ask] ?? "answer";
  const { head, why } = splitWhy(text);
  let what = firstSentence(strip(head.replace(KIND_OPENER, "").replace(SAME_VERB[kind] ?? /^$/, "")));
  // "Approve X?" reads "You approve: X"; a decision keeps its question mark
  if (kind !== "decide" && kind !== "answer") what = what.replace(/\?$/, "");
  if (what) what = what[0].toUpperCase() + what.slice(1);
  // a decision between a few short options reads "A or B"
  const opts = (item.options ?? []).map((o) => o.trim()).filter(Boolean);
  if (kind === "decide" && opts.length >= 2 && opts.length <= 3 && opts.every((o) => o.length <= 40)) {
    const ab = opts.join(" or ");
    if (!what || what.length > 90) what = ab;
    else if (!opts.every((o) => what.toLowerCase().includes(o.toLowerCase()))) what = `${what.replace(/[?.]$/, "")}: ${ab}`;
  }
  return { kind, verb: LEAD_VERB[kind], what: what || text, why: why ? cap(firstSentence(why)) : derivedWhy(item), own: false };
}

/** Why it matters: the ask's impact first, then why him, then its context. */
function derivedWhy(item: { impact?: string; whyYou?: string; contextText?: string }): string | undefined {
  const w = item.impact || item.whyYou || item.contextText;
  // one plain line: stop at the first ";" so the why never runs on into a second clause
  return w ? cap(firstSentence(w.split(/;\s/)[0])) : undefined;
}

/** A finished row for him to judge: "You check: <what is live>", with its goal as the why. */
export function reviewLead(face: { title: string; taskGoal?: string }): Lead {
  const { head, why } = splitWhy(face.title.replace(OWN, ""));
  return {
    kind: "check",
    verb: LEAD_VERB.check,
    what: firstSentence(strip(head), 200),
    why: why ? firstSentence(why) : face.taskGoal ? firstSentence(face.taskGoal) : undefined,
    own: OWN.test(face.title),
  };
}

/**
 * the card's
 * parts in the round 2 mockup's order. The kind is one plain word in the meta line.
 */
export const KIND_WORD: Record<LeadKind, string> = { approve: "Decision", decide: "Decision", do: "Do", give: "Answer", check: "Review", answer: "Answer" };

/** a page link the ask opens with ("http://…: record four videos", "Mac page: http://… (Copy button) — …"), or the same
 * link written as markdown ("[dashboard.exa.ai/team-settings](https://…) : You give …", E948-S160). */
const LEAD_MD = /^\s*\[[^\]]*\]\(https?:\/\/[^)\s]+\)\s*(?:[:—–-]\s+|:)?\s*/i;
const LEAD_URL = /^\s*(?:mac page\s*:\s*)?https?:\/\/\S+(?:\s*\([^)]*\))?(?:\s+and\s+https?:\/\/\S+(?:\s*\([^)]*\))?)*?(?:\s+[:—–-]\s+|:\s+|\s*[—–]\s*)/i;

/** the ask's text without the page link it opens with, its own "You do:" and its Why. */
function askText(item: { question?: string; title?: string }): string {
  let text = (item.question || item.title || "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i++) text = text.replace(LEAD_MD, "").replace(LEAD_URL, "").replace(OWN, "");
  return strip(splitWhy(text).head);
}

/** the page link an ask opens with, for the card's one green link. */
export function askLeadUrl(item: { question?: string; title?: string }): string | undefined {
  const md = /^\s*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i.exec(item.question || item.title || "");
  if (md) return md[1];
  const m = /^\s*(?:mac page\s*:\s*)?(https?:\/\/[^\s)]+?)[.,;:]?(?=\s|$)/i.exec(item.question || item.title || "");
  return m?.[1];
}

/** the heading: one short line, a few words (about 70 characters at most), never the Why. */
/** E948-S160: a heading is plain words: a markdown link reads as its label, emphasis and code marks go (never raw on his card). */
export function plainMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, (_, label: string) => label)
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#+\s+/, "");
}

export function cardHeading(item: { question?: string; title?: string }, max = 72): string {
  const t = plainMarkdown(askText(item) || (item.title ?? "").trim());
  const one = firstSentence(t, 400);
  if (one.length <= max) return cap(one);
  // a long sentence: its first clause when that reads alone (a comma, a colon, a dash), else cut at a word
  const m = /^(.{24,72}?)(?:,\s|;\s|:\s|\s[—–-]\s|\s\()/.exec(one);
  return cap(m ? m[1].trim() : firstSentence(one, 72));
}

/** the body: the full ask in plain text under the heading, or nothing when the heading already says all of it. */
export function cardBody(item: { question?: string; title?: string }, heading: string): string | undefined {
  const t = cap(askText(item));
  if (!t) return undefined;
  const h = heading.replace(/…$/, "");
  if (t === h || t === `${h}.`) return undefined;
  // the heading is the body's whole first sentence: the body starts after it; a heading cut short keeps the full body
  if (!heading.endsWith("…") && t.startsWith(h) && /^[\s.?!]/.test(t.slice(h.length) || " ")) {
    const rest = strip(t.slice(h.length));
    return rest ? cap(rest) : undefined;
  }
  return t;
}

/** a Do card's steps: "1) … 2) … — done looks like: …" read as numbered lines and one grey Done looks like line. */
export function splitSteps(steps: string | undefined): { list: string[]; done?: string } | undefined {
  if (!steps?.trim()) return undefined;
  const flat = steps.replace(/\r/g, "").trim();
  const dm = /\s*(?:[—–-]\s*)?done looks like\s*:\s*/i.exec(flat);
  const head = dm ? flat.slice(0, dm.index) : flat;
  const done = dm ? cap(flat.slice(dm.index + dm[0].length).trim()) : undefined;
  const parts = head
    .split(/(?:^|\s|\n)(?=\(?\d{1,2}[).]\s)/)
    .map((s) => s.replace(/^\(?\d{1,2}[).]\s*/, "").trim())
    .filter(Boolean);
  // "1 open … · 2 copy … · 3 paste …" (the spine ask line's own way) reads as numbered lines too
  const dotted = head.split(/\s+·\s+(?=\d{1,2}\s)/).map((s) => s.replace(/^\d{1,2}\s+/, "").trim()).filter(Boolean);
  const list = parts.length > 1 ? parts : dotted.length > 1 ? dotted : head.split(/\n+/).map((s) => s.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
  return { list, done };
}

/** "the code repo · the code repo" reads "the code repo": the project once. */
export function projectLabel(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const parts = title.split(" · ").map((s) => s.trim());
  return parts.every((p) => p === parts[0]) ? parts[0] : title;
}
