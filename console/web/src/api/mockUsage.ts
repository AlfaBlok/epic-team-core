import type { MockDb } from "./seed";
import type { UsageGroup, UsageGroupBy, UsageTotals } from "./types";

/** the mock's GET /api/usage, same grouping as the server (ended wake runs started in [from, to)). */
export function usageTotals(db: MockDb, q: { from?: string; to?: string; groupBy: UsageGroupBy }, now: Date): UsageTotals {
  const to = q.to ?? now.toISOString();
  const from = q.from ?? new Date(Date.parse(to) - 24 * 3600_000).toISOString();
  const empty = (key: string, label: string): UsageGroup => ({
    key, label, runs: 0, collected: 0, pending: 0, missing: 0, skipped: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, costUsd: 0,
    live: { runs: 0, input: 0, output: 0, costUsd: 0 },
  });
  const groups = new Map<string, UsageGroup>();
  const total = empty("total", "Total");
  for (const r of db.runs) {
    if (r.kind === "answer_run" || !r.endedAt || r.startedAt < from || r.startedAt >= to) continue;
    const personaId = r.personaId ?? db.assignments.find((a) => a.id === r.assignmentId)?.personaId;
    const [key, label] =
      q.groupBy === "persona"
        ? [personaId ?? "none", db.personas.find((p) => p.id === personaId)?.name ?? "deleted persona"]
        : q.groupBy === "milestone"
          ? [r.milestoneId ?? "none", db.milestones.find((m) => m.id === r.milestoneId)?.title ?? "no milestone"]
          : q.groupBy === "seat"
            ? [r.usage?.seat ?? r.seat ?? "unknown", r.usage?.seat ?? r.seat ?? "unknown"]
            : [r.startedAt.slice(0, 10), r.startedAt.slice(0, 10)];
    const g = groups.get(key) ?? empty(key, label);
    groups.set(key, g);
    for (const t of [g, total]) {
      t.runs++;
      const u = r.usage;
      if (!u) {
        t.pending++;
        continue;
      }
      t.collected++;
      if (u.source === "no-thread" || u.source === "no-turn") t.skipped++;
      t.input += u.input;
      t.cacheWrite += u.cacheWrite;
      t.cacheRead += u.cacheRead;
      t.output += u.output;
      t.turns += u.turns;
      t.costUsd += u.costUsd ?? 0;
    }
  }
  const list = [...groups.values()].sort((a, b) => (q.groupBy === "day" ? a.key.localeCompare(b.key) : b.costUsd - a.costUsd || b.runs - a.runs));
  return { from, to, groupBy: q.groupBy, groups: list, total, missingReasons: {}, updatedAt: null };
}
