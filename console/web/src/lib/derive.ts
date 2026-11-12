import type { Assignment, MilestoneStatusView, Run } from "@/api/types";

/** a turn the owner started via Send to; shown everywhere runs are, but never a wake. */
export const isAnswerRun = (r: Pick<Run, "kind">) => r.kind === "answer_run";
/** A persona wake (wake / run-now / bootstrap): top-level and not an answer run. */
/** a toggle line (on/off switched) is a log line, never a wake. */
export const isWakeRun = (r: Pick<Run, "kind" | "parentRunId">) => !r.parentRunId && !isAnswerRun(r) && r.kind !== "toggle";

/** Runs belonging to a milestone (runs link to assignments, assignments to milestones). */
export function runsForMilestone(milestoneId: string, assignments: Assignment[], runs: Run[]): Run[] {
  const ids = new Set(assignments.filter((a) => a.milestoneId === milestoneId).map((a) => a.id));
  // Bootstrap runs have no assignment; the server stamps milestoneId on every run.
  return runs.filter((r) => ids.has(r.assignmentId) || r.milestoneId === milestoneId || r.assignmentId === `bootstrap:${milestoneId}`);
}

/**
 * ticket ids a worker is on now: child runs still `running` whose T3 thread is not known to be finished.
 * Child summaries start with the ticket id (wake protocol B.2), e.g. ` keep moving` →. Upper-cased.
 */
export function workedTicketIds(runs: Run[]): Set<string> {
  const ids = new Set<string>();
  for (const r of runs) {
    if (!r.parentRunId || r.outcome !== "running" || r.t3?.status === "completed" || r.t3?.status === "failed") continue;
    // First word, trailing punctuation dropped; an id has a digit (S2, N10-6), so "fix the tree" adds nothing.
    const id = /^\s*\**([A-Za-z0-9][\w.-]*?)[.:,;)*]*(?:\s|$)/.exec(r.summary)?.[1];
    if (id && /\d/.test(id)) ids.add(id.toUpperCase());
  }
  return ids;
}

/** Latest top-level run start and soonest next wake across a milestone's enabled assignments. */
export function milestoneTiming(milestoneId: string, assignments: Assignment[], runs: Run[]) {
  const mine = assignments.filter((a) => a.milestoneId === milestoneId);
  const last = runsForMilestone(milestoneId, assignments, runs)
    .filter(isWakeRun)
    .map((r) => r.startedAt)
    .sort()
    .at(-1);
  const next = mine
    .map((a) => nextWake(a).at)
    .filter((x): x is string => !!x)
    .sort()[0];
  return { lastRunAt: last, nextRunAt: next };
}

/**
 * an assignment's next wake: the cadence (only while enabled) or a timed wake a run asked for (retryAt fires
 * even when the assignment is off, like Run now), whichever is earlier. `retry` names the run that asked.
 */
export function nextWake(a: Assignment): { at?: string; retry?: { runId?: string } } {
  const cadence = a.enabled ? a.nextRunAt : undefined;
  if (a.retryAt && (!cadence || Date.parse(a.retryAt) <= Date.parse(cadence))) return { at: a.retryAt, retry: { runId: a.retryRunId } };
  return { at: cadence };
}

export interface RunNode {
  run: Run;
  children: RunNode[];
}

/** Nest child runs (parentRunId) under their parents; newest first at every level. */
export function nestRuns(runs: Run[]): RunNode[] {
  const nodes = new Map(runs.map((r) => [r.id, { run: r, children: [] as RunNode[] }]));
  const roots: RunNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.run.parentRunId ? nodes.get(node.run.parentRunId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: RunNode[]) => {
    list.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
    list.forEach((n) => sort(n.children));
    return list;
  };
  return sort(roots);
}

/** Top-level runs (no parentRunId), newest first. Child agents' runs and answer runs are not counted as wakes. */
const topLevel = (runs: Run[]) => runs.filter(isWakeRun).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

export interface RunStats {
  count: number;
  last?: Run;
}

/** Wake count and latest run of one assignment. */
export function assignmentRunStats(assignmentId: string, runs: Run[]): RunStats {
  const mine = topLevel(runs.filter((r) => r.assignmentId === assignmentId));
  return { count: mine.length, last: mine[0] };
}

/** Wake count and latest run of a persona across every milestone it is attached to. */
export function personaRunStats(personaId: string, assignments: Assignment[], runs: Run[]): RunStats {
  const ids = new Set(assignments.filter((a) => a.personaId === personaId).map((a) => a.id));
  const mine = topLevel(runs.filter((r) => ids.has(r.assignmentId)));
  return { count: mine.length, last: mine[0] };
}

/** Wakes on a milestone in the last 24 h, and its latest run. */
export function milestoneRunStats(milestoneId: string, assignments: Assignment[], runs: Run[], now: Date = new Date()) {
  const mine = topLevel(runsForMilestone(milestoneId, assignments, runs));
  const since = now.getTime() - 86_400_000;
  return { last24h: mine.filter((r) => Date.parse(r.startedAt) >= since).length, last: mine[0] };
}

/**
 * ended wakes started in the last 24 h (the Team page fetches them with `listRuns({ since })`, no row cap), and
 * how many did something: progressed and not a repeated report (an idle with ready steps is stored idle, so it never
 * counts).
 */
export function wakesDidSomething(runs: Run[], now: Date = new Date()): { did: number; total: number } {
  const since = now.getTime() - 86_400_000;
  const ended = runs.filter((r) => isWakeRun(r) && r.outcome !== "running" && Date.parse(r.startedAt) >= since);
  return { did: ended.filter((r) => r.outcome === "progressed" && !r.repeating).length, total: ended.length };
}

/** A run's persona: its assignment's, else the one stamped on the run (assignment deleted since). */
export function runPersonaId(run: Run, assignments: Assignment[]): string | undefined {
  return assignments.find((a) => a.id === run.assignmentId)?.personaId ?? run.personaId;
}

/** A run whose assignment no longer exists (bootstrap runs never had one). */
export const isOrphanRun = (run: Run, assignments: Assignment[]) =>
  !run.assignmentId.startsWith("bootstrap:") && !assignments.some((a) => a.id === run.assignmentId);

/** Runs of a persona (Activity tab filter `?persona=`), including runs of its deleted assignments; child runs carry their parent's assignmentId. */
export function filterRunsByPersona(runs: Run[], assignments: Assignment[], personaId: string): Run[] {
  return runs.filter((r) => runPersonaId(r, assignments) === personaId);
}

export interface TimelineWake extends RunNode {
  /** 1 = the assignment's first wake (top-level runs only); 0 for an answer run (not a wake). */
  wake: number;
}

export interface TimelineGroup {
  /** Assignment id (or `bootstrap:<milestone>`). */
  assignmentId: string;
  assignment?: Assignment;
  /** The assignment's persona, or the one stamped on its runs once the assignment is deleted. */
  personaId?: string;
  /** runs of an assignment that no longer exists. */
  deleted: boolean;
  wakes: TimelineWake[];
}

/** Activity timeline: runs grouped per assignment (group with the newest wake first), wakes newest first, children nested. */
export function timelineGroups(runs: Run[], assignments: Assignment[]): TimelineGroup[] {
  const byAssignment = new Map<string, Run[]>();
  for (const r of runs) byAssignment.set(r.assignmentId, [...(byAssignment.get(r.assignmentId) ?? []), r]);
  const groups: TimelineGroup[] = [...byAssignment].map(([assignmentId, list]) => {
    const roots = nestRuns(list);
    const n = roots.filter((w) => !isAnswerRun(w.run)).length;
    let seen = 0;
    const assignment = assignments.find((a) => a.id === assignmentId);
    return {
      assignmentId,
      assignment,
      personaId: assignment?.personaId ?? list.find((r) => r.personaId)?.personaId,
      deleted: isOrphanRun(list[0], assignments),
      wakes: roots.map((w) => ({ ...w, wake: isAnswerRun(w.run) ? 0 : n - seen++ })),
    };
  });
  return groups.sort((a, b) => (b.wakes[0]?.run.startedAt ?? "").localeCompare(a.wakes[0]?.run.startedAt ?? ""));
}

/**
 * Settle opens only on the owner's mark: accomplished, partially or superseded (same rule as the server's
 * 409). Ready to mark, reopened and not yet stay closed.
 */
export const canSettle = (s: { outcome?: Pick<MilestoneStatusView["outcome"], "word"> } | undefined): boolean =>
  s?.outcome?.word === "accomplished" || s?.outcome?.word === "partially" || s?.outcome?.word === "superseded";

/** T3 state older than this is not trusted (the server reconciles every minute). */
export const T3_STALE_MS = 5 * 60_000;
const STOPPED = new Set(["cancelled", "interrupted"]);
export type LiveKind = "live" | "finished" | "failed" | "stopped" | "unknown";

/** what T3 says about a still-running run (undefined once the run is closed: its outcome speaks). */
export function runLiveState(r: Run, now: number = Date.now()): LiveKind | undefined {
  if (r.outcome !== "running" || r.endedAt) return undefined;
  const t = r.t3;
  if (!r.threadId || !t || !(now - Date.parse(t.checkedAt) <= T3_STALE_MS)) return "unknown";
  if (t.status === "live") return "live";
  if (t.status === "completed") return "finished";
  if (t.status === "failed") return STOPPED.has(t.detail ?? "") ? "stopped" : "failed";
  return "unknown";
}

/** Live runs in these nodes and all their descendants. */
export function countLive(nodes: RunNode[], now: number = Date.now()): number {
  return nodes.reduce((n, x) => n + (runLiveState(x.run, now) === "live" ? 1 : 0) + countLive(x.children, now), 0);
}

/** The "Running" filter: wakes with a live run or live child, groups that keep at least one. */
export function runningOnly(groups: TimelineGroup[], now: number = Date.now()): TimelineGroup[] {
  return groups.map((g) => ({ ...g, wakes: g.wakes.filter((w) => countLive([w], now) > 0) })).filter((g) => g.wakes.length > 0);
}
