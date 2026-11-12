import type { Run, createStore } from "../store.js";

type Store = ReturnType<typeof createStore>;

/** what a held run reads as in the console (`egress:laptop` → "held: laptop offline"). */
export const heldLabel = (heldOn: string) => (heldOn === "credits" ? "held: out of credits" : `held: ${heldOn.replace(/^egress:/, "")} offline`); // credits/gate.ts

/** the woke_because of a wake fired by a release (egress back online, credits back). */
export const RELEASED_PREFIX = "released:";
export const releasedWhy = (heldOn: string, runId: string) => `${RELEASED_PREFIX} ${heldOn} back (held run ${runId})`;

/**
 * the assignment's due retryAt is a release of `src` (a held run), not the run's own timed check: the run was
 * held, and the time is neither its retryAt nor its nextCheckAt (release sets retryAt = the release time).
 */
export function heldRelease(src: Run | undefined, retryAt: string | undefined): boolean {
  if (!src?.heldOn || !retryAt) return false;
  const at = Date.parse(retryAt);
  return ![src.retryAt, src.nextCheckAt].some((t) => !!t && Date.parse(t) === at);
}

/**
 * a release wake that ended held on the same egress again within this window means the egress is flapping
 * (a social world repo Responder, 2026-10-30: the laptop came back for seconds, 38 wakes found it offline again). The next
 * online event books the wake for the end of the window instead of now: at most one release wake per window.
 */
export const RELEASE_BACKOFF_MS = 30 * 60_000;

export interface EgressOnlineResult {
  egress: string;
  /** Assignments whose wake was set to now (the retry tick fires it within ~30 s). */
  woken: { assignmentId: string; runId: string }[];
  /** Held, but not woken: switched off (root L-10), paused / settled milestone, or a wake already due. */
  skipped: { assignmentId: string; runId: string; reason: string }[];
  /** held again right after a release wake (flapping egress): the wake is booked for `at`, not now. */
  deferred: { assignmentId: string; runId: string; at: string }[];
}

/**
 * an egress came back online (the Team Browser's offline → online flip). Every assignment whose latest wake ended
 * monitoring held on it gets `retryAt = now`; the normal timed-wake tick (tickRetry) fires one wake. Idempotent:
 * a repeat event before the tick finds the wake already due, and after the tick the latest wake is no longer the held one.
 */
export function releaseHeld(store: Store, egress: string, now = new Date()): EgressOnlineResult {
  const on = `egress:${egress}`;
  const out: EgressOnlineResult = { egress, woken: [], skipped: [], deferred: [] };
  for (const a of store.listAssignments()) {
    const last = store.listRuns({ assignmentId: a.id, limit: 50 }).find((r) => r.kind === "wake" && !r.parentRunId);
    if (!last || last.outcome !== "monitoring" || last.heldOn !== on) continue;
    const skip = (reason: string) => out.skipped.push({ assignmentId: a.id, runId: last.id, reason });
    const m = store.getMilestone(a.milestoneId);
    if (!a.enabled) skip("switched off (only Run now wakes it)");
    else if (!m || m.paused || m.settledAt) skip(m ? (m.paused ? "milestone paused" : "milestone settled") : "milestone missing");
    else if (a.retryAt && Date.parse(a.retryAt) <= now.getTime()) skip("wake already due");
    else {
      // the held run was itself a release wake that found the egress offline again: back off.
      const flapUntil = last.wokeBecause?.startsWith(RELEASED_PREFIX) ? Date.parse(last.startedAt) + RELEASE_BACKOFF_MS : 0;
      if (flapUntil > now.getTime()) {
        const at = new Date(flapUntil).toISOString();
        if (a.retryAt && a.retryRunId === last.id && Date.parse(a.retryAt) <= flapUntil) skip("wake already booked");
        else {
          store.updateAssignment(a.id, { retryAt: at, retryRunId: last.id });
          out.deferred.push({ assignmentId: a.id, runId: last.id, at });
        }
        continue;
      }
      store.updateAssignment(a.id, { retryAt: now.toISOString(), retryRunId: last.id });
      out.woken.push({ assignmentId: a.id, runId: last.id });
    }
  }
  return out;
}
