import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api, type MilestoneStatusView, type PendingItem, type ReviewItem, type StatusBatch } from "@/api";
import { useSharedQuery } from "@/lib/data";
import { useSnoozes } from "@/lib/snooze";
import { answeredHere } from "@/lib/sentRows";
import { fromGapFinder, useGapFinder } from "@/lib/gapFinder";

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

/** Which milestones a count covers: all, or the selected project's (lib/project `keep`). */
export type Keep = (milestoneId?: string | null) => boolean;
const all: Keep = () => true;

/** The open items the owner must act on, each once, in the batch's order: what the red pill counts and Blocked lists. */
export function blockedItems(
  status: { items?: PendingItem[] } | undefined,
  o: { keep?: Keep; nodeKey?: string; snoozing?: { has: (id: string) => boolean }; answered?: (id: string) => boolean } = {},
): PendingItem[] {
  const keep = o.keep ?? all;
  // a green Sent row counts nothing: what he answered here is out of every red count at once
  const answered = o.answered ?? answeredHere;
  const seen = new Set<string>();
  const out: PendingItem[] = [];
  for (const i of status?.items ?? []) {
    if (i.state !== "open" || seen.has(i.id)) continue;
    if (o.nodeKey && i.nodeKey !== o.nodeKey && !i.nodeKey?.startsWith(o.nodeKey + "/")) continue;
    if (!keep(i.milestoneId) || o.snoozing?.has(i.id) || answered(i.id)) continue;
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
  o: { keep?: Keep; snoozing?: { has: (id: string) => boolean }; gone?: { has: (id: string) => boolean } } = {},
): T[] {
  const keep = o.keep ?? all;
  return (list ?? []).filter((i) => keep(i.milestoneId) && !o.snoozing?.has(i.id) && !o.gone?.has(i.id));
}

/** The world's status batch, one fetch for every reader (sidebar, top bar, project switcher, Team home). */
export const useStatusBatch = () => useSharedQuery<StatusBatch>("status", () => api.listStatus(), { tag: "inbox" });
/** One milestone's status, one fetch for its page's tab count and its Waiting on you list. */
export const useMilestoneStatus = (milestoneId: string) =>
  useSharedQuery<MilestoneStatusView>(`status:${milestoneId}`, () => api.getMilestoneStatus(milestoneId), { tag: "inbox" });
/** The review cards, one fetch for every reader (green pills and the review section). */
export const useReviewList = () => useSharedQuery<(ReviewItem & { milestoneTitle?: string })[]>("review-items", () => api.listReviewItems(), { tag: "inbox" });

/** The red list (and so the red count) of a status batch or one milestone's status, with this browser's snoozes applied. */
export function useBlocked(status: { items?: PendingItem[] } | undefined, o: { keep?: Keep; nodeKey?: string } = {}) {
  const { entries } = useSnoozes();
  return blockedItems(status, { ...o, snoozing: entries });
}

/** The green list (and so the green count), with this browser's snoozes and presses applied. */
export function useReviewCards(o: { keep?: Keep } = {}) {
  const { data: listed, error, loading } = useReviewList();
  // with the Gap finder switched off, its cards are on no list and in no count.
  const gapFinder = useGapFinder();
  const off = gapFinder?.on === false;
  const data = useMemo(() => (off ? listed?.filter((i) => !fromGapFinder(i.face?.from)) : listed), [listed, off]);
  const { entries } = useSnoozes();
  const g = useGone();
  // a pressed card stays out until a fetch no longer lists it; then its id is forgotten (a reopened row shows again)
  useEffect(() => {
    if (!data || ![...gone].some((id) => !data.some((i) => i.id === id))) return;
    gone = new Set([...gone].filter((id) => data.some((i) => i.id === id)));
    goneVersion++;
  }, [data]);
  return { data, error, loading, cards: data && reviewCards(data, { ...o, snoozing: entries, gone: g }) };
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
