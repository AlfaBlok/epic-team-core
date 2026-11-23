/**
 * E948-S183 one card per topic, where his inbox draws its cards (the rule and the check: server/src/inbox/sameTopic.ts).
 * The owner's 23 Nov screenshot: a plan ask and the review card of the same work both in Urgent. Before any card shows:
 * an open decision ask on the same ticket, page or topic as an open review card folds into that card (shown as superseded by it,
 * off every section and count); two asks, or two review cards, on one topic keep the one shown first.
 * E948-S187: a review card that arrives after an older ask on its topic joins the ask's card instead (its evidence and
 * decision show there, off the review list), and his answer on that card answers the review row too (answerJoined).
 */
import type { JoinedReview, OwnerResponse, ReviewItem, WaitingItem } from "@/api";
import { inboxFolds, type Fold } from "../../../server/src/inbox/sameTopic";

/** every open card checked against every other: the card each folded one goes into (the selection lives with the rule). */
export function topicFolds(asks: WaitingItem[] | undefined, reviews: ReviewItem[] | undefined): Map<string, Fold> {
  return inboxFolds(asks, reviews);
}

/** what an ask's card shows of a review card that joined it (E948-S187). */
export function joinedReview(r: ReviewItem): JoinedReview {
  const f = r.face;
  const url = f?.evidence?.url || r.liveUrl;
  return {
    id: r.id,
    ...(r.ref ? { ref: r.ref } : {}),
    title: f?.title || r.title,
    ...(url ? { evidence: { url, label: f?.evidence?.label || "Open the result", ...(f?.evidence?.look ? { look: f.evidence.look } : {}) } } : {}),
    ...(f?.delivered?.length ? { delivered: f.delivered } : {}),
    ...(f?.decision ? { decision: f.decision } : {}),
    ...(f?.options?.length ? { options: f.options } : {}),
  };
}

/**
 * the asks list with every ask folded into another card shown as superseded by it (`supersededBy` names that card), and
 * every review card that joined an older ask on it (`joined`, E948-S187).
 */
export function foldAsks(asks: WaitingItem[] | undefined, reviews: ReviewItem[] | undefined): WaitingItem[] | undefined {
  if (!asks) return asks;
  const f = topicFolds(asks, reviews);
  if (!f.size) return asks;
  const byId = new Map((reviews ?? []).map((r) => [r.id, r]));
  const joins = new Map<string, JoinedReview[]>();
  for (const [id, into] of f) {
    const r = byId.get(id);
    if (r) joins.set(into.into, [...(joins.get(into.into) ?? []), joinedReview(r)]);
  }
  return asks.map((i) => {
    const into = f.get(i.id);
    if (into) return { ...i, state: "superseded" as const, supersededBy: into.intoRef ?? into.into, foldedInto: into.into };
    const j = joins.get(i.id);
    return j ? { ...i, joined: j } : i;
  });
}

/**
 * the review list without a card folded into another card on the same topic: another review card shown first, or an
 * older ask (E948-S187: it shows on the ask's card). Without the asks, only review cards fold.
 */
export function foldReviews<T extends ReviewItem>(reviews: T[] | undefined, asks?: WaitingItem[]): T[] | undefined {
  if (!reviews) return reviews;
  const f = topicFolds(asks ?? [], reviews);
  return f.size ? reviews.filter((r) => !f.has(r.id)) : reviews;
}

/**
 * E948-S187: the joined review cards of every open ask on the list, so an answer pressed anywhere (card, ask set, voice)
 * reaches their rows too. Refreshed each time the asks list is folded.
 */
const joinedOf = new Map<string, JoinedReview[]>();
export function rememberJoined(asks: WaitingItem[] | undefined): void {
  for (const i of asks ?? []) {
    if (i.joined?.length && i.state === "open") joinedOf.set(i.id, i.joined);
    else joinedOf.delete(i.id);
  }
}
export const joinedFor = (askId: string): JoinedReview[] => joinedOf.get(askId) ?? [];

/** the review press his answer on the ask makes on a joined card: approve marks it complete, his words go with the rest. */
export type JoinedPress = { do: "complete"; pick: { choice?: string } } | { do: "deny"; reason: string } | { do: "relaunch"; feedback: string };
export function joinedPress(kind: OwnerResponse["kind"], text: string | undefined, r: JoinedReview): JoinedPress | undefined {
  const words = (text ?? "").trim();
  if (kind === "approve") return { do: "complete", pick: {} };
  if (kind === "deny") return { do: "deny", reason: words || "Declined on the ask it joined." };
  if (kind === "feedback") return words ? { do: "relaunch", feedback: words } : undefined;
  // an answer on a decision: one of the card's own buttons when it names one, else his words as his pick
  if (!words) return undefined;
  const own = r.options?.find((o) => o.toLowerCase() === words.toLowerCase() || o.split(":")[0].trim().toLowerCase() === words.toLowerCase());
  return { do: "complete", pick: { choice: (own ?? words).slice(0, 120) } };
}

/**
 * after his answer on an ask landed: the same answer on every review card that joined it (`joined`, taken when he
 * answered: the list may drop the ask before this runs). `undone` is asked first: an answer he took back with Bring it
 * back sends nothing. A failure or a closed tab leaves the card on his list, never a lost answer.
 */
export async function answerJoined(
  askId: string,
  joined: JoinedReview[],
  kind: OwnerResponse["kind"],
  text: string | undefined,
  api: {
    completeReviewItem(id: string, pick: { choice?: string }): Promise<unknown>;
    denyReviewItem(id: string, reason: string): Promise<unknown>;
    relaunchReviewItem(id: string, feedback: string): Promise<unknown>;
  },
  undone?: () => Promise<boolean> | boolean,
): Promise<string[]> {
  const done: string[] = [];
  if (!joined.length || (undone && (await undone()))) return done;
  for (const r of joined) {
    const p = joinedPress(kind, text, r);
    if (!p) continue;
    try {
      if (p.do === "complete") await api.completeReviewItem(r.id, p.pick);
      else if (p.do === "deny") await api.denyReviewItem(r.id, p.reason);
      else await api.relaunchReviewItem(r.id, p.feedback);
      done.push(r.id);
    } catch (e) {
      console.warn(`E948-S187: the answer on ask ${askId} did not reach its joined card ${r.ref ?? r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (done.length) joinedOf.delete(askId);
  return done;
}
