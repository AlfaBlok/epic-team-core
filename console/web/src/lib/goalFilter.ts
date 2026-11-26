import { useCallback, useMemo, useSyncExternalStore } from "react";
import { api } from "@/api";
import type { OwnerPriority } from "@/api/inbox-types";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import { useSharedQuery } from "@/lib/data";

/**
 * (the owner 26 Nov 00:02Z, vn_b5b6f567: "whatever ... has a pill, is contributing to a pill count, I would like
 * to extract ... what goal is it about ... labels that I can click on to deselect or select so that I can ... filter my
 * inbox by goal, but only of the goals that exist in the inbox. So this filter is dynamic"): every inbox card belongs to
 * one goal, his objective, and only the goals he turns on stay in every inbox section and every pill until he shows all again.
 *
 * A card's goal, the first that holds:
 *   1. the objective the server says it moves (`ownerPriority.objective`, his order)
 *   2. a review card: the objective whose spines hold the card's spine (`goalKey`)
 *   3. the objective that owns the card's milestone alone (a milestone several objectives share says nothing)
 *   4. Other
 */
export const OTHER_GOAL = "Other";
export type Goal = { name: string; rank: number };
export type GoalInput = { milestoneId?: string | null; goalKey?: string; ownerPriority?: OwnerPriority | null };

const LAST = Number.MAX_SAFE_INTEGER;

type GoalIndex = { bySpine: Map<string, Goal>; byMilestone: Map<string, Goal> };

/** his objectives (top-level pursuits), in his order, indexed by their spines and their own milestones. */
export function goalIndex(nodes: readonly ScorecardNode[] | undefined): GoalIndex {
  const bySpine = new Map<string, Goal>();
  const byMilestone = new Map<string, Goal>();
  const pursuits = (nodes ?? [])
    .filter((n) => n.kind === "pursuit" && !n.parked)
    .map((n, i) => ({ n, goal: { name: n.name, rank: n.rank != null ? n.rank - 1 : 1000 + i } }))
    .sort((a, b) => a.goal.rank - b.goal.rank);
  for (const { n, goal } of pursuits) {
    for (const s of n.spines ?? []) if (!bySpine.has(s)) bySpine.set(s, goal);
    if (n.milestoneId && !n.milestoneShared && !byMilestone.has(n.milestoneId)) byMilestone.set(n.milestoneId, goal);
  }
  return { bySpine, byMilestone };
}

export function goalOf(i: GoalInput, idx: GoalIndex): Goal {
  const o = i.ownerPriority?.objective;
  if (o?.name) return { name: o.name, rank: o.n };
  return (i.goalKey && idx.bySpine.get(i.goalKey)) || (i.milestoneId && idx.byMilestone.get(i.milestoneId)) || { name: OTHER_GOAL, rank: LAST };
}

/** the goals of these cards, each with how many cards it holds, in his order (Other last). */
export function goalsOf(items: readonly GoalInput[], idx: GoalIndex): (Goal & { count: number })[] {
  const by = new Map<string, Goal & { count: number }>();
  for (const i of items) {
    const g = goalOf(i, idx);
    const had = by.get(g.name);
    if (had) {
      had.count++;
      had.rank = Math.min(had.rank, g.rank);
    } else by.set(g.name, { ...g, count: 1 });
  }
  return [...by.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

/**
 * (the owner 26 Nov, chat with a screenshot): every goal is on at first; the first tap on a goal shows only that goal;
 * each further tap turns one more goal on or off; Show all puts every goal back. `null` is every goal on, else the goals
 * he turned on, by name, for this visit to the Inbox only (never stored: a card is never lost to an old filter).
 */
let only: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();
const set = (next: ReadonlySet<string> | null) => {
  only = next && next.size ? next : null;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** a tap on a goal label: with every goal on it shows that goal alone, then it turns that goal on or off. */
export function tapGoal(name: string) {
  if (!only) return set(new Set([name]));
  const next = new Set(only);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  set(next);
}
/** drop goals that left the inbox from the ones turned on (none left: every goal is on again). */
export function keepGoals(have: ReadonlySet<string>) {
  if (only && [...only].some((g) => !have.has(g))) set(new Set([...only].filter((g) => have.has(g))));
}
export const showAllGoals = () => void (only && set(null));
export const useShownGoals = (): ReadonlySet<string> | null => useSyncExternalStore(subscribe, () => only, () => only);

/** the same goal sets fetch the menu reads. */
export function useGoalIndex(): GoalIndex {
  const { data } = useSharedQuery<ScorecardsBody>("sb:scorecards", () => api.listScorecards(), { tag: "inbox" });
  const nodes = data?.nodes;
  return useMemo(() => goalIndex(nodes), [nodes]);
}

/** does this card show: every goal is on, or its goal is one he turned on. Every pill and section reads it. */
export function useGoalShown(): (i: GoalInput) => boolean {
  const on = useShownGoals();
  const idx = useGoalIndex();
  return useCallback((i: GoalInput) => !on || on.has(goalOf(i, idx).name), [on, idx]);
}
