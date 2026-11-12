import type { Tree, TreeNode } from "../adapters/tree.js";
import type { Run } from "../store.js";

/**
 * wake-ending contract: the only endings a wake reports are progressed, blocked, monitoring and idle; anything
 * else is failed with a reason. `blocked` without an open ask is already stored as monitoring (app.ts).
 */
export const WAKE_ENDING_RULE =
  "Endings (the console enforces them): `progressed` = a step done, the summary names the next step; " +
  "`blocked` = cites an open ask code (else stored as monitoring); `monitoring` needs `nextCheckAt` or `until` (else 400 'monitoring needs a date'); " +
  "`idle` only when no step is ready (an idle with ready steps is kept, and the milestone shows the steps as ignored: fix their status or work them); anything else is `failed` with the reason in the summary.";

export const MONITORING_NEEDS_DATE = "monitoring needs a date: add nextCheckAt (ISO UTC) or until";

/** a held run's fallback next check, only used if the egress online event is missed. */
export const HELD_FALLBACK_MS = 6 * 3600_000;

type Patch = {
  outcome?: Run["outcome"];
  summary?: string;
  endedAt?: string | null;
  retryAt?: string | null;
  nextCheckAt?: string | null;
  until?: string | null;
  reportedOutcome?: string;
  heldOn?: string | null;
  readyIgnored?: string[] | null;
};

/**
 * Ready steps of a tree (`ready`: status ready/todo, nothing blocking it), by id; none when the spine itself is
 * not runnable (Status other than ready, active or blocked), where `idle: not runnable` is the honest word.
 */
export function readySteps(t: Tree): string[] {
  if (!/^\W*(ready|active|blocked)\b/i.test(t.root.status)) return [];
  const out: string[] = [];
  const visit = (n: TreeNode) => {
    if (n.ready) out.push(n.id);
    n.children.forEach(visit);
  };
  visit(t.root);
  return out;
}

const pick = <K extends "retryAt" | "nextCheckAt" | "until">(p: Patch, run: Run | undefined, k: K) => (p[k] !== undefined ? p[k] : run?.[k]);

/**
 * held (the Team Browser answered HELD: an egress is offline): the wake ends `monitoring` whatever it reported
 * (progressed / idle would book a follow-up or a cadence wake that only holds again), and a monitoring with no date gets
 * the 6 h fallback next check. The egress online event (POST /api/egress/:name/online) is what normally wakes it.
 */
function held<P extends Patch>(p: P, run: Run | undefined, now: number): P {
  const on = p.heldOn !== undefined ? p.heldOn : run?.heldOn;
  if (!on) return p;
  const word = p.outcome ?? run?.outcome;
  if (word === "progressed" || word === "idle") p = { ...p, outcome: "monitoring", reportedOutcome: word };
  else if (word !== "monitoring") return p;
  if ((["nextCheckAt", "until", "retryAt"] as const).some((k) => { const t = pick(p, run, k); return !!t && Date.parse(t) > now; })) return p;
  return { ...p, outcome: "monitoring", nextCheckAt: new Date(now + HELD_FALLBACK_MS).toISOString() };
}

/** the milestone reason for a wake that reported idle while steps read ready (the console no longer relabels it). */
export function readyIgnoredReason(persona: string, steps: string[]): string {
  const shown = steps.slice(0, 5).join(", ") + (steps.length > 5 ? ", …" : "");
  return `${persona} says nothing is runnable, but ${steps.length} step${steps.length === 1 ? "" : "s"} read${steps.length === 1 ? "s" : ""} ready: ${shown}: fix the step status or work them`;
}

/**
 * Apply the contract to a run PATCH (after the blocked → monitoring rewrite). Returns the patch to store, or an error
 * message for a 400. `ready` lists the milestone's ready steps (undefined = unknown: idle is kept, fails open); it is
 * only called for an `idle` ending of a running wake.
 */
export async function wakeEnding<P extends Patch>(p: P, run: Run | undefined, ready: () => Promise<string[] | undefined>, now = Date.now()): Promise<{ patch: P } | { error: string }> {
  p = held(p, run, now);
  // A `blocked` the console rewrote to monitoring keeps its old leniency: the agent reported blocked, not monitoring.
  if (p.outcome === "monitoring" && p.reportedOutcome !== "blocked" && !pick(p, run, "nextCheckAt") && !pick(p, run, "until") && !pick(p, run, "retryAt")) return { error: MONITORING_NEEDS_DATE };
  if (!run || run.outcome !== "running") return { patch: p };
  // A finishing PATCH (endedAt) that still says running, or a console-only word, is not a wake ending.
  if ((p.endedAt && (p.outcome ?? run.outcome) === "running") || p.outcome === "blank_report") {
    const word = p.outcome ?? run.outcome;
    return { patch: { ...p, outcome: "failed", reportedOutcome: word, summary: `${p.summary ?? run.summary} [console: '${word}' is not a wake ending; stored as failed]`.trim() } };
  }
  // an idle with ready steps stays idle (relabelled it progressed, which hid a spine mismatch): the
  // steps are recorded on the run and the milestone names the disagreement.
  if (p.outcome === "idle" && run.kind === "wake" && !run.parentRunId) {
    const steps = await ready().catch(() => undefined);
    if (steps?.length) {
      const shown = steps.slice(0, 5).join(", ") + (steps.length > 5 ? ", …" : "");
      const note = `[console: idle reported with ${steps.length} ready step${steps.length === 1 ? "" : "s"} (${shown})]`;
      return { patch: { ...p, readyIgnored: steps, summary: `${p.summary ?? run.summary} ${note}`.trim() } };
    }
  }
  return { patch: p };
}
