import type { CardFace } from "@/api/review-types";
import type { OwnerPriority } from "@/api/inbox-types";
import { ownerName } from "@/lib/identity";

/** E948-S69: a decision that asks "Do we / Should we …?" gets Yes: plan it and No: park it by itself. */
export const DECIDE_QUESTION = /^(?:do|should|shall|will|can|would) (?:we|the team|i)\b[^?]*\?/i;

/**
 * E948-S103 (the owner 2026-11-15 06:51Z, vn_a8293638: "we have done waiting for your review. These are things that are
 * completed, and I just need to mark them as completed. But then we also have, like, these decision things ... it needs
 * to be on a different bucket ... It is a higher level of priority ... it's incredibly important that you are kind of
 * consistent with the language"): a review card is a Decision when its buttons choose between at least two next steps,
 * or its decision asks "Do we / Should we …?" (Yes: plan it, No: park it). An option that only asks for his words
 * ("No: tell us what to change") is the Give feedback every card has, so a card whose one other option is that stays a
 * Review: finished work he marks done. The one list of words is docs/review-cards.md, "One word for each kind of card".
 */
export const FEEDBACK_OPTION = /^[^:]*:\s*(?:say|tell|change|give|write|send)\b|^(?:change it|not quite|tell us)\b/i;
export function isDecisionCard(face: Pick<CardFace, "decision" | "options" | "next"> | undefined | null): boolean {
  if (!face) return false;
  const own = (face.options ?? []).filter((o) => /^[^:]{1,30}:\s*\S/.test(o));
  const real = own.filter((o) => !FEEDBACK_OPTION.test(o.trim()));
  if (own.length >= 2 && real.length >= 2) return true;
  // E948-S232 (the owner 28 Nov 11:45Z on the traction card "Should we try these three next?", drawn under Done:
  // "If it's waiting for an answer from me from like a decision, not in terms of like was this complete but actually like
  // some other decision, then was this in the right place?"): what the card asks decides its section, never only its
  // buttons. A question that asks a real choice ("Should we …?", "Which …?") is a Decision even when its one other
  // button is Change it: when it asks what the team does next ("Should we …?", "Do we …?", "Which …?"), or names a step to
  // take ("Run each test at 10 euros?") whose Yes does more than keep what was made. A question that judges finished work
  // ("Does the page say it?", "Are these numbers right?") or "Make the box ours?" with Yes: keep it stays a Review.
  if (own.length >= 2) return asksNext(face.decision) || (asksChoice(face.decision) && !real.some((r) => KEEPS.test(r)));
  return asksChoice(face.decision);
}
/** the Yes of finished work: it keeps what was made ("Yes: keep it", "Yes: looks right"), it starts nothing new. */
const KEEPS = /^[^:]*:\s*(?:keep|leave|accept|close|mark|done|looks|it'?s|that'?s|fine|good|right|ship it as)\b/i;
/** E948-S232: the question asks what the team does next: "Do we / Should we …?", "Which / When …?". */
export const asksNext = (decision: string | undefined) => {
  const q = firstAsk(decision);
  return q.endsWith("?") && (DECIDE_QUESTION.test(q) || SHOULD.test(q) || PICK_QUESTION.test(q));
};

/**
 * (the owner 26 Nov on a tester-names card, "this came as review but was a question??"): a decision that asks him
 * a real choice, whose answers lead to different work, is a Decision even with no buttons of its own. It asks a choice when
 * its first sentence
 *   1. asks what the team does: "Do we / Should we / Shall I …?", or any "Should …?"            (DECIDE_QUESTION, SHOULD)
 *   2. asks which one or when: "Which mortgage …?", "When do we …?", "What should we …?"          (PICK_QUESTION)
 *   3. names the step to take: "Greet Ana by name …?", "Buy the phone at 844 euros?"           (an action verb first)
 *   4. weighs two ways: "… by the name they typed or the Google one?"                              (OR_CHOICE)
 * A question that only judges finished work ("Is this right?", "Does it read well?", "Keep it?") stays a Review.
 */
const SHOULD = /^(?:should|shall)\b[^?]*\?/i;
export const PICK_QUESTION = /^(?:which|when|where|who|whom|what\b[^?]*\b(?:should|do|shall|will) (?:we|i|the team))\b[^?]*\?/i;
const OR_CHOICE = /\b\w+,? or (?!not\b|no\b|anything\b|something\b)\w+/i;
/** first words that open a question about the work, a sentence about a thing, or the follow-ups the card switches on (Start, Switch), never a new step to take. */
const NOT_A_STEP =
  /^(?:is|are|was|were|am|be|does|do|did|has|have|had|can|could|will|would|may|might|must|should|shall|how|why|what|which|when|where|who|whom|whose|the|this|these|that|those|a|an|your|our|my|its|their|it|they|you|we|i|he|she|one|all|every|both|each|any|now|so|then|and|or|but|ok|okay|good|right|done|ready|enough|here|there|keep|mark|close|accept|approve|confirm|stay|leave|start|switch|happy|fine|looks?|reads?|\d\S*)$/i;
/** the decision's first sentence, links reduced to their words. */
const firstAsk = (decision: string | undefined) => (decision ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim().split(/(?<=[?.!])\s+/)[0] ?? "";
export function asksChoice(decision: string | undefined): boolean {
  const q = firstAsk(decision);
  if (!q.endsWith("?")) return false;
  if (DECIDE_QUESTION.test(q) || SHOULD.test(q) || PICK_QUESTION.test(q)) return true;
  const first = q.split(/\s+/)[0]?.replace(/[^\p{L}\d']/gu, "") ?? "";
  if (first && !NOT_A_STEP.test(first)) return true;
  return OR_CHOICE.test(q.replace(/\?$/, ""));
}
/** the buttons a choice gets when the card names none: Yes: plan it for "Do we …?", Yes: go ahead for any other. */
export const choiceDefaults = (decision: string | undefined): string[] | undefined =>
  DECIDE_QUESTION.test(firstAsk(decision)) ? ["Yes: plan it", "No: park it"] : asksChoice(decision) && !PICK_QUESTION.test(firstAsk(decision)) ? ["Yes: go ahead", "No: park it"] : undefined;
/** the one word each kind of card shows first on its meta line, the same in every section name (docs/review-cards.md). */
export const CARD_WORD = { decision: "Decision", review: "Review" } as const;

/**
 * One rule says which review card sits in Urgent, and every count reads it (the top bar, each section's pill, the menu,
 * phone and laptop alike). Round 1 (vn_9ad3d512, 25 Nov: "if you are in an urgency environment, then you get bumped up
 * into a red type ... All I need is consistency") let cards on his top three objectives and his ideas of the day before
 * rise too, and Urgent swallowed most of the inbox. Round 2 (his chat 26 Nov: "too much stuff became urgent suddenly -
 * we cant have 80pct of inbox be urgent.."): a review card may be urgent only when
 *   1. he labelled it urgent, or it is truly time-bound: a deadline today or tomorrow, an outage, a payment `urgent`
 *   2. he pushed it himself today: a press of his from today (first, again, frustrated)                    `pressed`
 *   3. his own words dated today started it                                                                `his-idea`
 * and Urgent holds at most a handful of them: 5 cards or 15 percent of the inbox, whichever is smaller (`urgentCap`;
 * the inbox is his open review cards and asks, and an urgent ask already in Urgent takes a place first),
 * time-bound first, then today's presses, then today's ideas, in his objective order. The rest stay in their own
 * sections. `stampUrgent` picks them once over the whole inbox (lib/inbox useReviewCards) and every reader reads the
 * stamp, so a project's pill and the Team inbox agree. Everything in Urgent counts red, once; green is only Done (E948-S178).
 */
export const URGENT_MAX = 5;
export const URGENT_SHARE = 0.15;
export type UrgentWhy = "urgent" | "pressed" | "his-idea";
type UrgentInput = {
  id?: string;
  title?: string;
  /** set by `stampUrgent`: why it is in Urgent, or null when it is not (absent: the card was never stamped). */
  urgent?: UrgentWhy | null;
  ownerPriority?: OwnerPriority;
  face?: { ready?: { why?: string } | null; source?: string; deadline?: { at: string } | null; title?: string } | null;
  inboxSince?: string;
  createdAt?: string;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MONTH = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i;
const ISO_DAY = /\b(20\d\d)-(\d\d)-(\d\d)\b/;
/** the source holds his words: a quote of his, or it opens on him ("Your voice note", "You chose", "<his name> on 25 Nov"). */
const HIS_WORDS = /["“”]/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const himRe = () => {
  const first = ownerName().trim().split(/\s+/)[0] ?? "";
  return first && !/^the$/i.test(first) ? `you|your|${escapeRe(first)}` : "you|your";
};
const DAY_MS = 86_400_000;

/** the day (UTC midnight, ms) his words in a card's source were said, read from its date; the year is the arrival's. */
export function sourceDay(source: string | undefined, arrived: number): number | undefined {
  if (!source) return undefined;
  const iso = ISO_DAY.exec(source);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const dm = DAY_MONTH.exec(source);
  const md = dm ? undefined : MONTH_DAY.exec(source);
  const day = dm ? +dm[1] : md ? +md[2] : NaN;
  const month = MONTHS.indexOf(((dm ? dm[2] : md?.[1]) ?? "").slice(0, 3).toLowerCase());
  if (!Number.isFinite(day) || month < 0 || day < 1 || day > 31) return undefined;
  const year = new Date(arrived).getUTCFullYear();
  const at = Date.UTC(year, month, day);
  // words of December on a card that arrived in January were last year's
  return at > arrived + DAY_MS ? Date.UTC(year - 1, month, day) : at;
}

/** the UTC day (midnight, ms) of `now`. */
const dayOf = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/** the day his own words in the card's source were said, when the source holds his words and a date. */
function hisWordsDay(i: UrgentInput): number | undefined {
  const source = (i.face?.source ?? "").trim();
  const him = himRe();
  if (!source || !(HIS_WORDS.test(source) || new RegExp(`^\\W*(?:${him})\\b`, "i").test(source)) || !new RegExp(`\\b(?:${him})\\b`, "i").test(source)) return undefined;
  const arrived = Date.parse(i.inboxSince ?? i.createdAt ?? "");
  return sourceDay(source, Number.isFinite(arrived) ? arrived : Date.now());
}

/** 3: his own words dated today started the card. */
export function isHisIdeaToday(i: UrgentInput, now = Date.now()): boolean {
  const said = hisWordsDay(i);
  return said != null && said === dayOf(now);
}

/** an outage or a payment, read from the card's title. */
const TIME_BOUND = /\b(?:outage|is down|went down|(?:payment|invoice|bill|renewal|rent|tax)s? (?:is |are )?(?:due|overdue|failed|declined|bounced)|(?:card|payment) (?:was )?declined|expires? (?:today|tomorrow))\b/i;
/** 1: labelled urgent, a deadline today or tomorrow (a past day's deadline is not), an outage or a payment. */
export function isTimeBound(i: UrgentInput, now = Date.now()): boolean {
  if (i.face?.ready?.why === "urgent") return true;
  const at = Date.parse(i.face?.deadline?.at ?? "");
  if (Number.isFinite(at) && at >= dayOf(now) && at < dayOf(now) + 2 * DAY_MS) return true;
  // the card's own title only: a row title holds the brief ("nothing charged"), not what is due
  return TIME_BOUND.test(i.face?.title ?? i.title ?? "");
}

/** 2: a press of his from today. */
export function isPressedToday(i: UrgentInput, now = Date.now()): boolean {
  const p = i.ownerPriority?.pressing;
  if (!p) return false;
  const at = Date.parse(p.said ?? "");
  return Number.isFinite(at) && dayOf(at) === dayOf(now);
}

/** why a card could sit in Urgent before the cap (the first that holds), or undefined. */
export function urgentCandidate(i: UrgentInput, now = Date.now()): UrgentWhy | undefined {
  if (isTimeBound(i, now)) return "urgent";
  if (isPressedToday(i, now)) return "pressed";
  if (isHisIdeaToday(i, now)) return "his-idea";
  return undefined;
}

/** how many cards Urgent holds for an inbox of `total`: at most 5 or 15 percent, whichever is smaller (at least 1). */
export const urgentCap = (total: number) => (total <= 0 ? 0 : Math.min(URGENT_MAX, Math.max(1, Math.floor(total * URGENT_SHARE))));

const RANK: Record<UrgentWhy, number> = { urgent: 0, pressed: 1, "his-idea": 2 };
/** the ids in Urgent and why: the candidates, best first, cut at the cap over the whole inbox. */
export function pickUrgent<T extends UrgentInput>(cards: T[], now = Date.now(), o: { asks?: number; urgentAsks?: number } = {}): Map<T, UrgentWhy> {
  const cand = cards.map((c, k) => ({ c, k, why: urgentCandidate(c, now) })).filter((x): x is { c: T; k: number; why: UrgentWhy } => !!x.why);
  const due = (c: T) => { const at = Date.parse(c.face?.deadline?.at ?? ""); return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER; };
  const obj = (c: T) => c.ownerPriority?.objective?.n ?? Number.MAX_SAFE_INTEGER;
  const since = (c: T) => -(Date.parse(c.inboxSince ?? c.createdAt ?? "") || 0);
  cand.sort((a, b) => RANK[a.why] - RANK[b.why] || due(a.c) - due(b.c) || obj(a.c) - obj(b.c) || since(a.c) - since(b.c) || a.k - b.k);
  // the cap is over his whole inbox (review cards and open asks), and urgent asks already in Urgent take their places first
  const room = Math.max(0, urgentCap(cards.length + (o.asks ?? 0)) - (o.urgentAsks ?? 0));
  return new Map(cand.slice(0, room).map((x) => [x.c, x.why]));
}

/** every card with its `urgent` stamp, picked once over the whole inbox it is given. */
export function stampUrgent<T extends UrgentInput>(cards: T[], now = Date.now()): (T & { urgent: UrgentWhy | null })[] {
  const picked = pickUrgent(cards, now);
  return cards.map((c) => ({ ...c, urgent: picked.get(c) ?? null }));
}

/** why a review card sits in Urgent, or undefined when it does not: its stamp; an unstamped card alone is its own inbox of one. */
export function urgentWhy(i: UrgentInput): UrgentWhy | undefined {
  if (i.urgent !== undefined) return i.urgent ?? undefined;
  return urgentCandidate(i);
}

/** the words its tag says when it is in Urgent as his idea of today ("Your idea, 26 Nov"), else undefined. */
export function hisIdeaNote(i: UrgentInput): string | undefined {
  if (urgentWhy(i) !== "his-idea") return undefined;
  const said = hisWordsDay(i);
  if (said == null) return undefined;
  const d = new Date(said);
  return `Your idea, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].replace(/^./, (c) => c.toUpperCase())}`;
}

/** E948-S132: a review card in Urgent sits above every other section and counts red. */
export const isUrgentReview = (i: UrgentInput) => !!urgentWhy(i);

/**
 * E948-S178 (the owner 22 Nov 20:57Z, vn_facd277a: "It's showing three, but there is only two waiting for review and one
 * in Urgent. The one in Urgent is a red one ... it's being counted as one of the green ones"): Urgent is a red section,
 * so every card in it counts red, once, and never in green. Green is only Done, waiting for your review.
 */
type RedInput = Omit<UrgentInput, "face"> & { face?: (Pick<CardFace, "decision" | "options" | "next"> & { ready?: { why?: string } | null; source?: string }) | null };
export const countsRed = (i: RedInput) =>
  isDecisionCard(i.face) || isUrgentReview(i);

/** E948-S103: the review cards split as the Inbox shows them: decisions and Urgent wait on him (red), the rest is finished work (green). */
export function splitDecisions<T extends RedInput>(cards: T[] | undefined): { decisions: T[]; review: T[] } {
  const decisions: T[] = [];
  const review: T[] = [];
  for (const c of cards ?? []) (countsRed(c) ? decisions : review).push(c);
  return { decisions, review };
}

/**
 * (the owner 2026-11-16, vn_c95c40ad: "something that was time sensitive ... how come that this is not the first
 * thing on my inbox?"): a card with a deadline leads its section, its time left counting down (`leadsFirst`).
 */
export const hasDeadline = (face: Pick<CardFace, "deadline"> | undefined | null) => !!face?.deadline?.at && Number.isFinite(Date.parse(face.deadline.at));

/**
 * (the owner 2026-11-16 08:04Z: "came in too subtly"; 20:27Z: "I don't want to add more sections!!! It should
 * just be at the top on blocked waiting for me or top done waiting for your review"): a card for something he was
 * waiting on, now ready, leads the section it belongs to (Decisions or Done, waiting for your review), never a section
 * of its own; a card with a deadline leads it too, right under the ready ones (components/review.tsx `leadsFirst`).
 */
export const isReady = (face: Pick<CardFace, "ready"> | undefined | null) => !!face?.ready;
/** a card that leads its section: ready for him, or with a deadline. */
export const leadsSection = (face: Pick<CardFace, "ready" | "deadline"> | undefined | null) => isReady(face) || hasDeadline(face);
/** the list with its leading cards first (ready ones, then deadlines, each soonest deadline first), the rest in their order. */
export function leadsFirst<T extends { face?: { ready?: unknown; deadline?: { at: string } } | null }>(cards: T[]): T[] {
  const due = (c: T) => (c.face?.deadline?.at && Number.isFinite(Date.parse(c.face.deadline.at)) ? Date.parse(c.face.deadline.at) : Number.MAX_SAFE_INTEGER);
  const ready = cards.filter((c) => !!c.face?.ready).sort((a, b) => due(a) - due(b));
  const dated = cards.filter((c) => !c.face?.ready && due(c) < Number.MAX_SAFE_INTEGER).sort((a, b) => due(a) - due(b));
  const lead = new Set([...ready, ...dated]);
  return [...ready, ...dated, ...cards.filter((c) => !lead.has(c))];
}
