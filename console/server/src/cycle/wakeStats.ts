import type { Hono } from "hono";
import type { Run, Store } from "../store.js";
import { SKIP_PREFIX } from "./skipUnchanged.js";

/**
 * wasted-wake alarm. A real wake the console started on its own (cadence, timed, release, new asks: it records
 * `wokeBecause`; never a skip, never the owner's Run now) that ended `monitoring` or `blocked` with the same wake fingerprint at
 * its end as at its start (`startFingerprint` = `askFingerprint`) changed nothing: "wasted". Counted per assignment per
 * UTC day; more than WASTED_ALARM a day is flagged. GET /api/wake-stats?days=1 (read only).
 */
export const WASTED_ALARM = 4;
const WASTED_OUTCOMES = ["monitoring", "blocked"];

const isSkip = (r: Run) => r.summary.startsWith(SKIP_PREFIX);
const top = (r: Run) => !r.parentRunId && r.kind === "wake";

export const isWastedWake = (r: Run): boolean =>
  top(r) && !isSkip(r) && !!r.wokeBecause && WASTED_OUTCOMES.includes(r.outcome) && !!r.startFingerprint && r.startFingerprint === r.askFingerprint;

export interface WakeDayStats {
  assignmentId: string;
  day: string;
  repo?: string;
  persona?: string;
  skipped: number;
  /** Real top-level wakes (not skips, not parked / not-runnable stubs: those carry no fingerprint either). */
  real: number;
  /** Of `real`: started by the console (they record wokeBecause). */
  auto: number;
  wasted: number;
  wastedRunIds: string[];
  /** wasted > WASTED_ALARM */
  alarm: boolean;
}

/** Per assignment and UTC day over the last `days` UTC days (today included), newest day first; only rows with a wake. */
export function wakeStats(store: Store, o: { days?: number; now?: number } = {}): { days: number; from: string; alarmAbove: number; rows: WakeDayStats[]; alarms: WakeDayStats[] } {
  const days = Math.max(1, Math.min(31, Math.floor(o.days ?? 1)));
  const now = new Date(o.now ?? Date.now());
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))).toISOString();
  const assignments = new Map(store.listAssignments({}).map((a) => [a.id, a]));
  const personas = new Map(store.listPersonas().map((p) => [p.id, p.name]));
  const milestones = new Map(store.listMilestones({ includeSettled: true }).map((m) => [m.id, m.repo]));
  const acc = new Map<string, WakeDayStats>();
  for (const r of store.listRuns({ since: from })) {
    if (!top(r) || !r.askFingerprint) continue; // fingerprinted wakes only (cadence personas)
    const day = r.startedAt.slice(0, 10);
    const k = `${r.assignmentId}\u0000${day}`;
    let row = acc.get(k);
    if (!row) {
      const a = assignments.get(r.assignmentId);
      const persona = personas.get(r.personaId ?? a?.personaId ?? "");
      const repo = milestones.get(r.milestoneId ?? a?.milestoneId ?? "") ?? undefined;
      row = { assignmentId: r.assignmentId, day, ...(repo ? { repo } : {}), ...(persona ? { persona } : {}), skipped: 0, real: 0, auto: 0, wasted: 0, wastedRunIds: [], alarm: false };
      acc.set(k, row);
    }
    if (isSkip(r)) row.skipped++;
    else {
      row.real++;
      if (r.wokeBecause) row.auto++;
      if (isWastedWake(r)) {
        row.wasted++;
        row.wastedRunIds.push(r.id);
      }
    }
  }
  const rows = [...acc.values()].map((x) => ({ ...x, alarm: x.wasted > WASTED_ALARM }));
  rows.sort((a, b) => b.day.localeCompare(a.day) || b.wasted - a.wasted || a.assignmentId.localeCompare(b.assignmentId));
  return { days, from, alarmAbove: WASTED_ALARM, rows, alarms: rows.filter((x) => x.alarm) };
}

/** GET /api/wake-stats?days=1..31 */
export function mountWakeStats(api: Hono, store: Store): void {
  api.get("/wake-stats", (c) => {
    const q = c.req.query("days");
    const days = q === undefined ? 1 : Number(q);
    if (!Number.isInteger(days) || days < 1 || days > 31) return c.json({ error: "validation_error", message: "days must be an integer 1..31" }, 400);
    return c.json(wakeStats(store, { days }));
  });
}
