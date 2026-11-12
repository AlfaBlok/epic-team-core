import type { Assignment, Milestone, Run } from "../store.js";

/**
 * bounded follow-up wake (Q2): a wake that ends `progressed` while steps are still ready on its
 * milestone (row cap, no free seat) books one more wake of the same ENABLED assignment right away, at most once per
 * hour per assignment and never from a follow-up wake (chain depth 1). A wake of an assignment that is off (a Run now)
 * books nothing: the milestone shows Stalled and its Pending item asks the owner to switch the persona on.
 */
export const FOLLOW_UP_MARK = "follow-up booked";
export const FOLLOW_UP_GAP_MS = 3_600_000;

/** Wake prompt rule: a wake that leaves ready rows names them and why, and knows the console books the follow-up. */
export const LEFT_READY_RULE =
  "If ready rows are left when you finish, name them and why in the summary line (`left ready: <ids> (worker ceiling | no seat with headroom | row cap)`); " +
  "the console then books one follow-up wake right away (at most one per hour, never from a follow-up wake) while you are switched on.";

const isWake = (r: Run) => r.kind === "wake" && !r.parentRunId;
const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);
const listed = (ids: string[]) => ids.slice(0, 5).join(", ") + (ids.length > 5 ? ", …" : "");

export type FollowUp = { book: true; at: string; note: string } | { book: false; note?: string };

/**
 * What a finishing PATCH does about a follow-up. `runs` = the assignment's runs (any order); `ready` = the milestone's
 * ready step ids after the wake. Pure: the caller appends `note` to the summary and, when `book`, sets `retryAt: at`.
 */
export function followUp(o: {
  run: Run;
  outcome: Run["outcome"] | undefined;
  assignment: Assignment | undefined;
  milestone: Pick<Milestone, "paused" | "settledAt"> | undefined;
  runs: Run[];
  ready: string[];
  now: number;
}): FollowUp {
  const { run, assignment: a, ready, now } = o;
  if (o.outcome !== "progressed" || !isWake(run) || !ready.length) return { book: false };
  if (!o.milestone || o.milestone.paused || o.milestone.settledAt) return { book: false };
  const steps = `${ready.length} step${ready.length === 1 ? "" : "s"} still ready (${listed(ready)})`;
  if (!a || !a.enabled || a.parkedAt) return { book: false, note: `[console: ${steps}; this persona is off, so this was a one-off wake: no follow-up booked]` };
  const wakes = o.runs.filter((r) => isWake(r) && r.id !== run.id);
  // Depth 1: the wake right before this one booked a follow-up less than an hour before this one started.
  const prev = wakes.filter((r) => r.startedAt <= run.startedAt).sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0];
  if (prev?.summary.includes(FOLLOW_UP_MARK) && ms(run.startedAt) - ms(prev.endedAt ?? prev.startedAt) < FOLLOW_UP_GAP_MS)
    return { book: false, note: `[console: ${steps}; this was the follow-up wake, none booked from it (depth 1): the next cadence wake picks them up]` };
  // Once per hour per assignment.
  const recent = wakes.find((r) => r.summary.includes(FOLLOW_UP_MARK) && now - ms(r.endedAt ?? r.startedAt) < FOLLOW_UP_GAP_MS);
  if (recent) return { book: false, note: `[console: ${steps}; a follow-up was already booked within the hour (run ${recent.id}): none booked]` };
  const at = new Date(now).toISOString();
  return { book: true, at, note: `[console: ${steps}; ${FOLLOW_UP_MARK} ${at}]` };
}
