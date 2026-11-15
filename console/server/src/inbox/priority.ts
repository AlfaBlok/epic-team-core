import type { Milestone, Store } from "../store.js";
import { tierOf, type JordiPriority, type Locatable, type PriorityLookup } from "./jordiPriority.js";

/**
 * the owner's lists ("Blocked, waiting on you", "Done, waiting for your review") follow milestone priority:
 * the sidebar's order, the owner's big roots by their position first, then the other milestones as listed (created order),
 * settled ones last. Rank 0 is the top milestone; an item with no known milestone sorts after every ranked one.
 */
export function milestoneRanks(ms: Pick<Milestone, "id" | "bigRoot" | "createdAt" | "settledAt">[]): Map<string, number> {
  const roots = ms.filter((m) => m.bigRoot != null).sort((a, b) => a.bigRoot! - b.bigRoot! || a.createdAt.localeCompare(b.createdAt));
  const rest = ms.filter((m) => m.bigRoot == null);
  const order = [...roots, ...rest.filter((m) => !m.settledAt), ...rest.filter((m) => m.settledAt)];
  return new Map(order.map((m, i) => [m.id, i]));
}

type Ranked = { milestoneId?: string; alsoIn?: string[] };

/** An item's rank: the best of its milestone and every other milestone that lists it (`alsoIn`: a spine two milestones track). */
export function rankOf(i: Ranked, ranks: Map<string, number>): number {
  return Math.min(Number.MAX_SAFE_INTEGER, ...[i.milestoneId, ...(i.alsoIn ?? [])].flatMap((id) => (id != null && ranks.has(id) ? [ranks.get(id)!] : [])));
}

/**
 * Stable sort by milestone rank: items of one milestone (and unranked ones) keep their order. Each item carries
 * `priority` (1 = top milestone; absent when its milestone is unknown) so a screen merging two lists keeps the order.
 *
 * with `owner` (the Prioritizer's levels from the repo, jordiPriority.ts) the owner's level comes first: high, then
 * normal and unranked, then low; the milestone order and the old order only break ties inside one level. Each item then
 * carries `owner` (its level and the why quoting him) and always a `priority`, `tier * TIER_SPAN + rank`, so a screen
 * merging two lists (waiting.tsx mergeByPriority) keeps the same order.
 * several red lines: inside tier 0 the first line's items lead, then the next line's (`line * LINE_SPAN + rank`).
 */
export const TIER_SPAN = 1_000_000;
/** one red line's span inside tier 0 (lines in order; milestone ranks stay far below it). */
export const LINE_SPAN = 10_000;
export function byMilestonePriority<T extends Ranked & Locatable>(
  items: T[],
  ranks: Map<string, number>,
  lookup?: PriorityLookup,
): (T & { priority?: number; ownerPriority?: JordiPriority })[] {
  return items
    .map((it, i) => {
      const p = lookup?.(it);
      return { it, i, r: rankOf(it, ranks), p, t: lookup ? tierOf(p) : 0, l: p?.pressing ? (p.pressing.order ?? 0) : (p?.redLine?.line ?? 0) };
    })
    .sort((a, b) => a.t - b.t || a.l - b.l || a.r - b.r || a.i - b.i)
    .map(({ it, r, p, t, l }) => {
      if (!lookup) return r === Number.MAX_SAFE_INTEGER ? it : { ...it, priority: r + 1 };
      // inside the red tier the first line leads, then the second, each in milestone order.
      const rank = Math.min(r + 1, LINE_SPAN - 1);
      return { ...it, priority: t * TIER_SPAN + Math.min(l, TIER_SPAN / LINE_SPAN - 1) * LINE_SPAN + rank, ...(p ? { ownerPriority: p } : {}) };
    });
}

/** The store's milestones (this world's, settled included) as ranks. */
export const storeRanks = (store: Pick<Store, "listMilestones">) => milestoneRanks(store.listMilestones({ includeSettled: true }));
