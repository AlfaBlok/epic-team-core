import type { Cadence } from "../schemas.js";
import { nextRunAfter } from "./nextRun.js";

/**
 * a timed check (the assignment's retryAt: a monitoring nextCheckAt, a retryAt, a follow-up or an
 * held wake) and the cadence never both wake the same hour. A cadence wake whose timed check falls due within
 * the hour (and before the next cadence fire) gives way to it; a timed wake that fires moves the cadence on a full
 * interval from then. Fixed-time cadences are left as they are (their next slot is already after the timed wake).
 */
export const REPLACE_WINDOW_MS = 60 * 60_000;
export const TIMED_REPLACES_PREFIX = "skipped: timed check at";

/**
 * The timed check that takes this cadence wake's place, or undefined when the cadence wake goes ahead.
 * A Publisher's cadence is its catch-up pace, so it never gives way (`keepsCadence`): when its run asks for a check an
 * hour on, the half-hour cadence wake would give way and posts past their slot would wait an hour. Its no-model
 * pre-check still skips a wake with no work.
 */
export function timedCheckReplaces(retryAt: string | undefined, nextCadence: Date, now: Date, keepsCadence = false): string | undefined {
  if (!retryAt || keepsCadence) return undefined;
  const t = Date.parse(retryAt);
  if (Number.isNaN(t)) return undefined;
  return t <= Math.min(nextCadence.getTime(), now.getTime() + REPLACE_WINDOW_MS) ? retryAt : undefined;
}

export const timedReplacesSummary = (retryAt: string, runId?: string) =>
  `${TIMED_REPLACES_PREFIX} ${retryAt}${runId ? ` (requested by run ${runId})` : ""} replaces this cadence wake`;

/** The cadence's next fire after a timed wake at `now`: never earlier than a full interval from then. */
export function cadenceAfterTimedWake(c: Cadence, nextRunAt: string | undefined, now: Date): string | undefined {
  if (!nextRunAt) return undefined;
  const after = nextRunAfter(c, now).getTime();
  return after > Date.parse(nextRunAt) ? new Date(after).toISOString() : undefined;
}
