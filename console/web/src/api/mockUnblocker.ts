import type { MockDb } from "./seed";
import type { UnblockerCounts, UnblockerStats, UnblockerStatsWindow } from "./types";

const SPAN: Record<UnblockerStatsWindow, number> = { "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000, all: Infinity };

/** the mock's GET /api/unblocker-stats: counts from the seeded Unblocker runs (no timings, no reversals). */
export function unblockerStats(db: MockDb, q: { window: UnblockerStatsWindow; milestoneId?: string }, now: Date): UnblockerStats {
  const to = now.getTime();
  const from = to - SPAN[q.window];
  const ids = new Set(db.personas.filter((p) => /unblocker/i.test(p.name)).map((p) => p.id));
  const runs = db.runs.filter((r) => {
    const pid = r.personaId ?? db.assignments.find((a) => a.id === r.assignmentId)?.personaId;
    const t = Date.parse(r.startedAt);
    return !r.parentRunId && r.kind !== "answer_run" && ids.has(pid ?? "") && t > from && t <= to && (!q.milestoneId || r.milestoneId === q.milestoneId);
  });
  const count = (rs: typeof runs): UnblockerCounts => {
    const c: UnblockerCounts = { wakesFired: 0, wakesSkipped: 0, newAsks: 0, assessed: 0, answered: 0, left: 0, split: 0, reversed: 0, askToVerdict: { count: 0, medianMs: null, worstMs: null, estimated: 0, waiting: 0, oldestWaitingMs: null } };
    for (const r of rs) {
      if (r.summary.startsWith("skipped: nothing new since")) c.wakesSkipped++;
      else c.wakesFired++;
      for (const x of r.checks ?? []) {
        if (x.carriedFrom || x.skipped) continue;
        c.assessed++;
        c[x.decision === "answered" ? "answered" : x.decision === "split" ? "split" : "left"]++;
      }
    }
    return c;
  };
  const milestones = db.milestones
    .filter((m) => runs.some((r) => r.milestoneId === m.id))
    .map((m) => ({ milestoneId: m.id, milestoneTitle: m.title, ...count(runs.filter((r) => r.milestoneId === m.id)) }));
  return { window: q.window, from: Number.isFinite(from) ? new Date(from).toISOString() : null, to: now.toISOString(), milestones, total: count(runs) };
}
