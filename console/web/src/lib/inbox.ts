import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api, type MilestoneStatusView, type PendingItem, type ReviewItem, type StatusBatch } from "@/api";
import { useRawWaiting, useSharedQuery } from "@/lib/data";
import { useSnoozes } from "@/lib/snooze";
import { answeredHere, answeredSlot, applyServerAnswers, useSentVersion } from "@/lib/sentRows";
import { fromGapFinder, useGapFinder } from "@/lib/gapFinder";
import { foldReviews } from "@/lib/sameTopic";
import { pickUrgent, type UrgentWhy } from "@/lib/cardKind";

/**
 * every count of what waits
 * on the owner is the length of the list it stands for, computed by one function from one fetch:
 * - red (Blocked, waiting on you): `blockedItems` over the status batch (GET /api/status, or a milestone's status);
 * - green (Done, waiting for your review): `reviewCards` over GET /api/review-items.
 * The sidebar's Team pill, each milestone's pill, the phone top bar, the project switcher, the milestone page's "Waiting
 * on you" tab and the Team home sections all call these, so a pill can no longer say 1 while its list is empty.
 * Before: the pills read /api/counts and their own /status fetch, each polled on its own 30 s clock, and they ignored a
 * snooze or a press the list had already applied.
 */

/**
 * E948-S141 (the owner 18 Nov 04:30Z, his phone: "Done, waiting for your review 4" and the top bar 4 over one Sent row
 * and no open card; "Must have given this feedback more than 20 times"): THE rule every inbox count uses. A count is the
 * number of open cards its section draws: an item he answered here (any Sent mark, its green row shown or not) is not
 * open, in every section, the top bar and the sidebar, from the moment he answers until the server stops listing it.
 * Before, only Blocked on you left answered items out (E948-S117); Done, Decisions, Goals to set and Ideas counted
 * them while E948-S140 had already taken their rows off the page.
 */
export function openCards<T>(
  items: T[],
  slotOf: (t: T) => string,
  answered: (slot: string, since?: string | null) => boolean = answeredSlot,
  sinceOf?: (t: T) => string | null | undefined,
): T[] {
  // answered stays answered until the server lists the card again dated after his answer (sent back to him)
  return items.filter((i) => !answered(slotOf(i), sinceOf?.(i)));
}
export const reviewSlot = (i: Pick<ReviewItem, "id">) => `review:${i.id}`;
/** when a review card last came to him (its round back in review), to tell a card sent back from one he answered. */
// (inboxSince only: createdAt moves on a restamp, which is nothing new for him)
export const reviewSince = (i: Partial<Pick<ReviewItem, "inboxSince">>) => i.inboxSince ?? undefined;

/** Which milestones a count covers: all, or the selected project's (lib/project `keep`). */
export type Keep = (milestoneId?: string | null) => boolean;
const all: Keep = () => true;

/** The open items the owner must act on, each once, in the batch's order: what the red pill counts and Blocked lists. */
export function blockedItems(
  status: { items?: PendingItem[] } | undefined,
  o: { keep?: Keep; nodeKey?: string; snoozing?: { has: (id: string) => boolean }; answered?: (id: string, since?: string | null) => boolean } = {},
): PendingItem[] {
  const keep = o.keep ?? all;
  // a green Sent row counts nothing: what he answered here is out of every red count at once
  const answered = o.answered ?? answeredHere;
  const seen = new Set<string>();
  const out: PendingItem[] = [];
  for (const i of status?.items ?? []) {
    if (i.state !== "open" || seen.has(i.id)) continue;
    if (o.nodeKey && i.nodeKey !== o.nodeKey && !i.nodeKey?.startsWith(o.nodeKey + "/")) continue;
    if (!keep(i.milestoneId) || o.snoozing?.has(i.id) || answered(i.id, i.since)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out;
}

// A pressed review card leaves every list and count at once (module state, like a snooze), until the refetch drops it.
let gone = new Set<string>();
let goneVersion = 0;
const goneSubs = new Set<() => void>();
export function markReviewGone(id: string) {
  gone = new Set(gone).add(id);
  goneVersion++;
  goneSubs.forEach((f) => f());
}
const useGone = () => {
  useSyncExternalStore(
    (f) => {
      goneSubs.add(f);
      return () => goneSubs.delete(f);
    },
    () => goneVersion,
  );
  return gone;
};
const soon = new Map<ReturnType<typeof setTimeout>, string>();
/** Gone after its slide-out (`ms`), even when the page that pressed it has unmounted meanwhile. */
export function markReviewGoneAfter(id: string, ms: number) {
  const t = setTimeout(() => {
    soon.delete(t);
    markReviewGone(id);
  }, ms);
  soon.set(t, id);
}
/** a card that left on its 202 comes back when its press fails for good (the card says why). */
export function unmarkReviewGone(id: string) {
  soon.forEach((v, t) => v === id && (clearTimeout(t), soon.delete(t)));
  if (!gone.has(id)) return;
  gone = new Set([...gone].filter((g) => g !== id));
  goneVersion++;
  goneSubs.forEach((f) => f());
}
/** Tests only. */
export const resetReviewGone = () => {
  soon.forEach((_, t) => clearTimeout(t));
  soon.clear();
  gone = new Set();
  goneVersion++;
};

/** The review cards waiting on the owner: what the green pill counts and "Done, waiting for your review" lists. */
export function reviewCards<T extends Pick<ReviewItem, "id" | "milestoneId">>(
  list: T[] | undefined,
  o: { keep?: Keep; snoozing?: { has: (id: string) => boolean }; gone?: { has: (id: string) => boolean }; answered?: (slot: string, since?: string | null) => boolean } = {},
): T[] {
  const keep = o.keep ?? all;
  return openCards((list ?? []).filter((i) => keep(i.milestoneId) && !o.snoozing?.has(i.id) && !o.gone?.has(i.id)), reviewSlot, o.answered, (i) => reviewSince(i as Partial<ReviewItem>));
}

/** The world's status batch, one fetch for every reader (sidebar, top bar, project switcher, Team home). */
/**
 * E948-S141 iteration 2 (the owner 18 Nov 18:30Z: "See counters on phone vs desktop. It's broken nasty."): what he
 * answered on any device (GET /api/presses/answered), read with every list a count stands for, so his phone and his
 * laptop leave the same cards out (lib/sentRows withServerAnswers). One shared fetch, polled with the inbox.
 */
export function useServerAnswers() {
  const { data } = useSharedQuery("presses-answered", () => (api.listAnsweredPresses ? api.listAnsweredPresses() : Promise.resolve(undefined)), { tag: "inbox" });
  useEffect(() => applyServerAnswers(data?.answers), [data]);
}
export const useStatusBatch = () => {
  useServerAnswers();
  return useSharedQuery<StatusBatch>("status", () => api.listStatus(), { tag: "inbox" });
};
/** One milestone's status, one fetch for its page's tab count and its Waiting on you list. */
export const useMilestoneStatus = (milestoneId: string) =>
  useSharedQuery<MilestoneStatusView>(`status:${milestoneId}`, () => api.getMilestoneStatus(milestoneId), { tag: "inbox" });
/** The review cards, one fetch for every reader (green pills and the review section). */
export const useReviewList = () => {
  useServerAnswers();
  return useSharedQuery<(ReviewItem & { milestoneTitle?: string })[]>("review-items", () => api.listReviewItems(), { tag: "inbox" });
};

/** The red list (and so the red count) of a status batch or one milestone's status, with this browser's snoozes applied. */
export function useBlocked(status: { items?: PendingItem[] } | undefined, o: { keep?: Keep; nodeKey?: string } = {}) {
  const { entries } = useSnoozes();
  useSentVersion(); // an answer here takes its item out of the count at once
  return blockedItems(status, { ...o, snoozing: entries });
}

/** The green list (and so the green count), with this browser's snoozes and presses applied. */
export function useReviewCards(o: { keep?: Keep } = {}) {
  const { data: listed, error, loading } = useReviewList();
  // with the Gap finder switched off, its cards are on no list and in no count.
  const gapFinder = useGapFinder();
  const off = gapFinder?.on === false;
  // E948-S183: two review cards on one ticket, page or topic: the one shown first stays (lib/sameTopic.ts);
  // E948-S187: a review card that came after an older ask on its topic shows on the ask's card, not here
  const asks = useRawWaiting().data;
  const data = useMemo(() => foldReviews(off ? listed?.filter((i) => !fromGapFinder(i.face?.from)) : listed, asks), [listed, off, asks]);
  const { entries } = useSnoozes();
  const g = useGone();
  useSentVersion(); // E948-S141: an answer here takes its card out of every count at once
  // a pressed card stays out until a fetch no longer lists it; then its id is forgotten (a reopened row shows again)
  useEffect(() => {
    if (!data || ![...gone].some((id) => !data.some((i) => i.id === id))) return;
    gone = new Set([...gone].filter((id) => data.some((i) => i.id === id)));
    goneVersion++;
  }, [data]);
  // round 2 (his chat 26 Nov: "we cant have 80pct of inbox be urgent"): Urgent is picked once over his whole
  // open inbox, capped (lib/cardKind pickUrgent), and every list and count reads that stamp, phone and laptop alike.
  const open = data && reviewCards(data, { snoozing: entries, gone: g });
  const openKey = open?.map((i) => i.id).join(" ");
  const stamped = useMemo(() => {
    if (!data || !open) return data;
    // an open ask counts in his inbox; one labelled urgent or pressing sits in Urgent already (components/waiting isUrgentAsk)
    const openAsks = (asks ?? []).filter((a) => a.state === "open" && !a.snoozedUntil && !a.macAgent);
    const picked = pickUrgent(open, Date.now(), { asks: openAsks.length, urgentAsks: openAsks.filter((a) => !!a.urgent || !!a.ownerPriority?.pressing).length });
    const why = new Map<string, UrgentWhy>();
    picked.forEach((w, c) => why.set(c.id, w));
    return data.map((i) => ({ ...i, urgent: why.get(i.id) ?? null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, openKey, asks]);
  return { data: stamped, error, loading, cards: stamped && reviewCards(stamped, { ...o, snoozing: entries, gone: g }) };
}

/** The status a Waiting on you list counts from: the world's batch, one milestone's, or none (an untracked spine). */
export const useStatusFor = (milestoneId?: string, off?: boolean) =>
  useSharedQuery<StatusBatch | MilestoneStatusView | undefined>(
    off ? "status:none" : milestoneId ? `status:${milestoneId}` : "status",
    () => (off ? Promise.resolve(undefined) : milestoneId ? api.getMilestoneStatus(milestoneId) : api.listStatus()),
    { tag: "inbox" },
  );

/**
 * One milestone goal's inbox: its open asks (red) and its review cards (green), the numbers its sidebar entry
 * shows and its Inbox tab shows and lists, from the same status batch and review list with the same snoozes.
 */
export function milestoneInbox(
  batch: { milestones: { milestoneId: string; items?: PendingItem[] }[] } | undefined,
  cards: Pick<ReviewItem, "id" | "milestoneId">[] | undefined,
  milestoneId: string,
  snoozing?: { has: (id: string) => boolean },
): { ask: number; review: number } {
  const status = batch?.milestones.find((s) => s.milestoneId === milestoneId);
  return { ask: blockedItems(status, { snoozing }).length, review: (cards ?? []).filter((c) => c.milestoneId === milestoneId).length };
}
