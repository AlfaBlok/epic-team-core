import type { Milestone, MilestoneStatusView } from "@/api";

/**
 * the owner's big roots (the social product launch, the memory service launch, hair transplant, house decision) are the milestones with a
 * `bigRoot` position; they lead the sidebar and Team home in that order as "Focus milestones", the rest follow as "Other milestones".
 * With no big root set, `roots` is empty and every screen shows its list as before.
 */
export function splitBigRoots<M extends Pick<Milestone, "bigRoot" | "createdAt">>(ms: M[] | undefined): { roots: M[]; rest: M[] } {
  const all = ms ?? [];
  const roots = all.filter((m) => m.bigRoot != null).sort((a, b) => a.bigRoot! - b.bigRoot! || a.createdAt.localeCompare(b.createdAt));
  return { roots, rest: all.filter((m) => m.bigRoot == null) };
}

/**
 * the position a milestone gets when the owner makes it focus or creates a new focus milestone: after
 * the last focus milestone (1 with none), capped at 99 as the server's schema.
 */
export function nextFocusPosition(ms: Pick<Milestone, "bigRoot">[] | undefined): number {
  return Math.min(99, Math.max(0, ...(ms ?? []).map((m) => m.bigRoot ?? 0)) + 1);
}

/**
 * move the focus milestone at `index` one place up (-1) or down (+1). Returns the PATCHes that renumber the focus
 * list 1..n in the new order, only for the milestones whose position changes (a swap of neighbours on a 1..n list: two).
 */
export function moveFocus<M extends Pick<Milestone, "id" | "bigRoot">>(roots: M[], index: number, dir: -1 | 1): { id: string; bigRoot: number }[] {
  const to = index + dir;
  if (index < 0 || to < 0 || to >= roots.length) return [];
  const order = [...roots];
  [order[index], order[to]] = [order[to], order[index]];
  return order.flatMap((m, i) => (m.bigRoot === i + 1 ? [] : [{ id: m.id, bigRoot: i + 1 }]));
}

/** "40%" and its tooltip ("2 of 5 branches done · share of the tree done"); undefined while the status has no tree. */
export function progressLabel(st: Pick<MilestoneStatusView, "progress"> | undefined): { text: string; title: string } | undefined {
  const p = st?.progress;
  if (!p) return undefined;
  return { text: `${p.pct}%`, title: `${p.pct}% done: ${p.done} of ${p.total} branch${p.total === 1 ? "" : "es"} done (each branch weighs the same; its rows count by share done)` };
}

/** about 20 milestones show; the rest wait behind Load more, 20 at a time. */
export const MILESTONE_PAGE = 20;

/**
 * cut the milestone list in the owner's priority order (focus milestones in his order, then the others) at `limit`.
 * Returns the focus and other milestones that show and how many wait behind Load more.
 */
export function pageMilestones<M>(roots: M[], rest: M[], limit: number): { roots: M[]; rest: M[]; hidden: number } {
  const r = roots.slice(0, limit);
  const o = rest.slice(0, Math.max(0, limit - r.length));
  return { roots: r, rest: o, hidden: roots.length + rest.length - r.length - o.length };
}

/** a milestone's circle: one segment per branch of its tree, the done ones green (its status's progress); none yet = an empty ring. */
export function milestoneWheelRows(status: { progress?: { done: number; total: number } } | undefined): { state: "green" | "unknown" }[] {
  const p = status?.progress;
  if (!p?.total) return [];
  const done = Math.min(p.total, Math.round(p.done));
  return Array.from({ length: p.total }, (_, k) => ({ state: k < done ? "green" : "unknown" }));
}

/** a milestone goal's one-line answer under its name (as an objective's key results answer): how much of its tree is done. */
export function milestoneAnswer(status: { progress?: { pct: number; done: number; total: number } } | undefined): string {
  const p = status?.progress;
  if (!p?.total) return "Nothing measured yet: its tree has no parts to count.";
  const done = Math.min(p.total, Math.round(p.done));
  return `${p.pct}% done: ${done} of ${p.total} part${p.total === 1 ? "" : "s"} finished.`;
}
