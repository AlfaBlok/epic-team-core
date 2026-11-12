/**
 * the Team home's wake numbers without the run list. The page fetched `GET /api/runs` (the newest 500 runs,
 * ~900 KB) only to count wakes per milestone card and per persona; `GET /api/runs/stats` answers those numbers from
 * the same 500 runs on the server. The rules mirror web/src/lib/derive.ts (isWakeRun, runsForMilestone,
 * milestoneRunStats, personaRunStats): web/src/components/runsPageLinePer.test.tsx runs both on the same runs and asserts equal
 * numbers; test/getApiRunsStats.test.ts checks the route counts what GET /api/runs and GET /api/assignments send.
 */
export interface StatsRun {
  id: string;
  assignmentId: string;
  milestoneId?: string;
  personaId?: string;
  parentRunId?: string;
  kind?: string;
  startedAt: string;
  outcome?: string;
  repeating?: number;
}
export interface StatsAssignment {
  id: string;
  milestoneId: string;
  personaId: string;
}

export interface RunStatsView<R> {
  /** Per milestone: wakes started in the last 24 h and the latest wake (its startedAt is the card's "last run"). */
  milestones: Record<string, { last24h: number; last?: R }>;
  /** Per persona: wakes across every milestone it is attached to, and the latest. */
  personas: Record<string, { count: number; last?: R }>;
  /** The footer "did of total wakes in 24 h did something" (every run of the last 24 h, no 500 cap; see wakesDidSomething). */
  wakes24h?: { did: number; total: number };
}

const isWakeRun = (r: StatsRun) => !r.parentRunId && r.kind !== "answer_run" && r.kind !== "toggle";

/** runsForMilestone: the run's assignment's milestone, the milestone stamped on the run, or `bootstrap:<milestone>`. */
export function runMilestones(r: StatsRun, byId: Map<string, StatsAssignment>): Set<string> {
  const ms = new Set<string>();
  const a = byId.get(r.assignmentId);
  if (a) ms.add(a.milestoneId);
  if (r.milestoneId) ms.add(r.milestoneId);
  if (r.assignmentId.startsWith("bootstrap:")) ms.add(r.assignmentId.slice("bootstrap:".length));
  return ms;
}

/**
 * the footer of one project (the social skin's selected project): only the runs of the given milestones. With no
 * list, every run (the console skin and "All projects").
 */
export function runsOfMilestones<R extends StatsRun>(runs: R[], assignments: StatsAssignment[], only?: Iterable<string>): R[] {
  if (!only) return runs;
  const keep = new Set(only);
  const byId = new Map(assignments.map((a) => [a.id, a]));
  return runs.filter((r) => [...runMilestones(r, byId)].some((m) => keep.has(m)));
}

export function runStats<R extends StatsRun>(runs: R[], assignments: StatsAssignment[], now: Date = new Date()): RunStatsView<R> {
  // Newest first (the client sorted with localeCompare on startedAt; a stable sort keeps the store's order on ties).
  const wakes = runs.filter(isWakeRun).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const since = now.getTime() - 86_400_000;
  const milestones: RunStatsView<R>["milestones"] = {};
  const personas: RunStatsView<R>["personas"] = {};
  for (const r of wakes) {
    const a = byId.get(r.assignmentId);
    for (const m of runMilestones(r, byId)) {
      const s = (milestones[m] ??= { last24h: 0 });
      s.last ??= r;
      if (Date.parse(r.startedAt) >= since) s.last24h++;
    }
    // personaRunStats counts only runs of a live assignment of the persona (not the stamp on an orphaned run).
    if (a) {
      const p = (personas[a.personaId] ??= { count: 0 });
      p.last ??= r;
      p.count++;
    }
  }
  return { milestones, personas };
}

/**'s footer (derive.ts wakesDidSomething): ended wakes started in the last 24 h, and how many progressed without repeating. */
export function wakesDidSomething(runs: StatsRun[], now: Date = new Date()): { did: number; total: number } {
  const since = now.getTime() - 86_400_000;
  const ended = runs.filter((r) => isWakeRun(r) && r.outcome !== "running" && Date.parse(r.startedAt) >= since);
  return { did: ended.filter((r) => r.outcome === "progressed" && !r.repeating).length, total: ended.length };
}
