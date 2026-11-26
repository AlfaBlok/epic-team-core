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
  if (own.length >= 2) return own.filter((o) => !FEEDBACK_OPTION.test(o.trim())).length >= 2;
  return DECIDE_QUESTION.test((face.decision ?? "").trim());
}
/** the one word each kind of card shows first on its meta line, the same in every section name (docs/review-cards.md). */
export const CARD_WORD = { decision: "Decision", review: "Review" } as const;

/**
 * (the owner 25 Nov 23:51Z, vn_9ad3d512: "I was excited about some of the ideas that we discussed in the morning
 * ... they didn't come back to me ... I never get to that section because I'm always kind of going from the top to the
 * bottom ... by sections ... if you are in an urgency environment, then you get bumped up into a red type ... All I need is
 * consistency"): one rule says which review card sits in Urgent, and every count reads it (the top bar, each section's
 * pill, the menu, phone and laptop alike). A review card is urgent, red, when
 *   1. he called it urgent or pressed for it (asked for it first, again, or with frustration)          `urgent`
 *   2. it moves one of his top objectives, his first three in his order (docs/pursuits.json)           `top-objective`
 *   3. his own words started it and it reached him the day he said them, or the day after             `his-idea`
 * Everything in Urgent counts red, once; green is only Done, waiting for your review (E948-S178).
 */
export const TOP_OBJECTIVES = 3;
export type UrgentWhy = "urgent" | "top-objective" | "his-idea";
type UrgentInput = { ownerPriority?: OwnerPriority; face?: { ready?: { why?: string } | null; source?: string } | null; inboxSince?: string; createdAt?: string };

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

/** 3: his own words started the card, and it reached his inbox the day he said them or the next. */
export function isHisIdeaThatDay(i: UrgentInput): boolean {
  const source = (i.face?.source ?? "").trim();
  const him = himRe();
  if (!source || !(HIS_WORDS.test(source) || new RegExp(`^\\W*(?:${him})\\b`, "i").test(source)) || !new RegExp(`\\b(?:${him})\\b`, "i").test(source)) return false;
  const arrived = Date.parse(i.inboxSince ?? i.createdAt ?? "");
  if (!Number.isFinite(arrived)) return false;
  const said = sourceDay(source, arrived);
  if (said == null) return false;
  const arrivedDay = Math.floor(arrived / DAY_MS) * DAY_MS;
  return arrivedDay >= said && arrivedDay - said <= DAY_MS;
}

/** why a review card sits in Urgent (the first that holds), or undefined when it does not. */
export function urgentWhy(i: UrgentInput): UrgentWhy | undefined {
  if (i.ownerPriority?.pressing || i.face?.ready?.why === "urgent") return "urgent";
  const n = i.ownerPriority?.objective?.n;
  if (n != null && n < TOP_OBJECTIVES) return "top-objective";
  if (isHisIdeaThatDay(i)) return "his-idea";
  return undefined;
}

/** the words its tag says when it is in Urgent as his idea of that day ("Your idea, 25 Nov"), else undefined. */
export function hisIdeaNote(i: UrgentInput): string | undefined {
  if (urgentWhy(i) !== "his-idea") return undefined;
  const arrived = Date.parse(i.inboxSince ?? i.createdAt ?? "");
  const said = sourceDay(i.face?.source, arrived);
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
