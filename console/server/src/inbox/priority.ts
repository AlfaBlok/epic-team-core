import type { Milestone, Store } from "../store.js";
import { resolveRepo } from "../adapters/repos.js";
import { FIRST_TIER, objectiveOf, tierOf, worldObjectiveDefs, type JordiPriority, type Locatable, type ObjectiveMark, type PriorityLookup } from "./jordiPriority.js";

/**
 * the owner's lists ("Blocked, waiting on you", "Done, waiting for your review") follow milestone priority:
 * the sidebar's order, the owner's big roots by their position first, then the other milestones as listed (created order),
 * settled ones last. Rank 0 is the top milestone; an item with no known milestone sorts after every ranked one.
 */
export function milestoneRanks(
  ms: Pick<Milestone, "id" | "bigRoot" | "createdAt" | "settledAt">[],
  objectiveOf?: (m: Pick<Milestone, "id">) => number | undefined,
): Map<string, number> {
  const roots = ms.filter((m) => m.bigRoot != null).sort((a, b) => a.bigRoot! - b.bigRoot! || a.createdAt.localeCompare(b.createdAt));
  const rest = ms.filter((m) => m.bigRoot == null);
  const order = [...roots, ...rest.filter((m) => !m.settledAt), ...rest.filter((m) => m.settledAt)];
  if (!objectiveOf) return new Map(order.map((m, i) => [m.id, i]));
  // the owner: "It needs to be dynamic based on the priority of the objective". A milestone ranks by the objective it
  // moves, his order in the objectives file read now; the hand-set big-root position only orders milestones his
  // objectives do not reach, after every one they do.
  const n = new Map(order.map((m) => [m.id, objectiveOf(m) ?? Number.MAX_SAFE_INTEGER]));
  const ranked = order.map((m, i) => ({ m, i })).sort((a, b) => n.get(a.m.id)! - n.get(b.m.id)! || a.i - b.i);
  return new Map(ranked.map(({ m }, i) => [m.id, i]));
}

/**
 * the world's milestones ranked by his objectives (ticket → key result → objective → his order, all read from the repo at
 * this call): each milestone by the objective its epic file or repo moves (objectiveOf: the objective whose epics list
 * its spine, else whose own repo it lives in, else whose words its title says). Every list and queue ranks by this.
 */
export function worldRanks(store: Pick<Store, "listMilestones">, reposRoot: string, opts: { includeSettled?: boolean } = { includeSettled: true }): Map<string, number> {
  const ms = store.listMilestones(opts);
  const defs = worldObjectiveDefs(store, reposRoot);
  if (!defs.length) return milestoneRanks(ms);
  // the same milestones and the same parsed objectives give the same ranks: an inbox read pays one string compare
  const key = `${reposRoot}\0${ms.map((m) => `${m.id}|${m.repo}|${m.path}|${m.bigRoot ?? ""}|${m.settledAt ?? ""}|${m.title}`).join("\0")}`;
  const hit = ranksMemo.get(key);
  if (hit && hit.defs === defs) return hit.ranks;
  const names = new Map<string, string>();
  const nameOf = (repo: string) => names.get(repo) ?? names.set(repo, resolveRepo(reposRoot, repo)?.name ?? repo).get(repo)!;
  const byId = new Map(ms.map((m) => [m.id, m]));
  const ranks = milestoneRanks(ms, (m) => {
    const x = byId.get(m.id);
    const repo = x?.repo ? nameOf(x.repo) : undefined;
    return x ? objectiveOf(defs, { ...(repo ? { repo } : {}), ...(x.path ? { path: x.path } : {}), title: x.title })?.n : undefined;
  });
  if (ranksMemo.size > 20) ranksMemo.clear();
  ranksMemo.set(key, { defs, ranks });
  return ranks;
}
const ranksMemo = new Map<string, { defs: unknown; ranks: Map<string, number> }>();

type Ranked = { milestoneId?: string; alsoIn?: string[] };

/** An item's rank: the best of its milestone and every other milestone that lists it (`alsoIn`: a spine two milestones track). */
export function rankOf(i: Ranked, ranks: Map<string, number>): number {
  return Math.min(Number.MAX_SAFE_INTEGER, ...[i.milestoneId, ...(i.alsoIn ?? [])].flatMap((id) => (id != null && ranks.has(id) ? [ranks.get(id)!] : [])));
}

/**
 * Stable sort by milestone rank: items of one milestone (and unranked ones) keep their order. Each item carries
 * `priority` (1 = top milestone; absent when its milestone is unknown) so a screen merging two lists keeps the order.
 *
 * with `owner` (the Prioritizer's levels from the repo, jordiPriority.ts) his objectives lead (the owner asked:
 * "is the order of my objectives used at all?"): an item he asked by name to be first (or labelled urgent)
 * leads; then every item of his first objective, then his second, and so on in his order (docs/pursuits.json), items on
 * none last. Inside one objective the old order holds: pressing, the red line, then high, normal and low, each line in
 * milestone order. Each item then carries `owner` (its level and the why quoting him) and always a `priority`, so a
 * screen merging two lists (waiting.tsx mergeByPriority) keeps the same order:
 * `tier * TIER_SPAN + line * LINE_SPAN + rank - (OBJECTIVE_NONE - objective) * OBJECTIVE_SPAN - head * HEAD_SPAN`, so an
 * item on none keeps the number it had before.
 */
/** one tier's span inside an objective (tiers FIRST_TIER -3 to low 3 fit inside one objective's span). */
export const TIER_SPAN = 1_000_000;
/** one red line's span inside a tier (lines in order; milestone ranks stay far below it). */
export const LINE_SPAN = 10_000;
/** one objective's span (his order, docs/pursuits.json): room for every tier inside it. */
export const OBJECTIVE_SPAN = 10_000_000;
/** objectives counted apart: up to 98 of his, the 99th place is "on none". */
export const OBJECTIVE_NONE = 99;
/** the head: an item he asked by name to be first (or urgent) before every objective. */
export const HEAD_SPAN = OBJECTIVE_SPAN * (OBJECTIVE_NONE + 1);
export function byMilestonePriority<T extends Ranked & Locatable>(
  items: T[],
  ranks: Map<string, number>,
  lookup?: PriorityLookup,
): (T & { priority?: number; ownerPriority?: JordiPriority })[] {
  return items
    .map((it, i) => {
      const p = lookup?.(it);
      // his objectives' order first (n 0 is his first; none after every objective)
      const o = Math.min(p?.objective?.n ?? OBJECTIVE_NONE, OBJECTIVE_NONE);
      // E948-S155: an urgent ask (`label: urgent`) is in the same first tier as an item he asked by name to be first.
      const first = !!(it as { urgent?: boolean }).urgent || p?.pressing?.kind === "first";
      // inside one objective: pressing, the red line, then his levels (the objective itself no longer makes a tier)
      const t = first ? FIRST_TIER : lookup ? tierOf(p && { ...p, objective: undefined }) : 0;
      return { it, i, r: rankOf(it, ranks), p, h: first ? 0 : 1, t, o, l: p?.pressing ? (p.pressing.order ?? 0) : (p?.redLine?.line ?? 0) };
    })
    .sort((a, b) => a.h - b.h || a.o - b.o || a.t - b.t || a.l - b.l || a.r - b.r || a.i - b.i)
    .map(({ it, r, p, h, t, o, l }) => {
      if (!lookup) return r === Number.MAX_SAFE_INTEGER ? it : { ...it, priority: r + 1 };
      const rank = Math.min(r + 1, LINE_SPAN - 1);
      const line = Math.min(l, TIER_SPAN / LINE_SPAN - 1);
      // an item on none of his objectives keeps the number it always had; each objective above it, and the head, lie below
      return { ...it, priority: t * TIER_SPAN + line * LINE_SPAN + rank - (OBJECTIVE_NONE - o) * OBJECTIVE_SPAN - (1 - h) * HEAD_SPAN, ...(p ? { ownerPriority: p } : {}) };
    });
}

/**
 * ready rows in his objectives' order, for a wake's dispatch: the rows of his first objective first, then his
 * second, rows on none last; ties keep the ledger's order. Each row carries the objective it moves.
 */
export function byObjective<T extends Locatable>(rows: T[], objectiveOf: (row: T) => ObjectiveMark | undefined): (T & { objective?: ObjectiveMark })[] {
  return rows
    .map((row, i) => ({ row, i, o: objectiveOf(row) }))
    .sort((a, b) => (a.o?.n ?? Number.MAX_SAFE_INTEGER) - (b.o?.n ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
    .map(({ row, o }) => (o ? { ...row, objective: o } : row));
}

/** The store's milestones (this world's, settled included) as ranks. */
export const storeRanks = (store: Pick<Store, "listMilestones">, reposRoot?: string) =>
  reposRoot ? worldRanks(store, reposRoot) : milestoneRanks(store.listMilestones({ includeSettled: true }));
