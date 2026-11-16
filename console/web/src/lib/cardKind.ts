import type { CardFace } from "@/api/review-types";

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

/** E948-S103: the review cards split as the Inbox shows them: decisions wait on him (red), the rest is finished work (green). */
export function splitDecisions<T extends { face?: Pick<CardFace, "decision" | "options" | "next"> | null }>(cards: T[] | undefined): { decisions: T[]; review: T[] } {
  const decisions: T[] = [];
  const review: T[] = [];
  for (const c of cards ?? []) (isDecisionCard(c.face) ? decisions : review).push(c);
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
