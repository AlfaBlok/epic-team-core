import type { Milestone, Store } from "../store.js";
import type { Outcome } from "../adapters/spines.js";
import { doneMeansCount } from "../adapters/outcome.js";
import { outcomeOf, type OutcomeWord } from "./compute.js";
import type { MarkVerdict } from "./mark.js";

/**
 * a finished goal stops spending wakes.
 * 1. the owner's mark settles: when his mark of Accomplished / Partially / Superseded reads back as that outcome (not
 *    Reopened:'s settle rule), the milestone is settled in the same call, so its personas stop waking without a
 *    second click. Settings > Unsettle works as before (the mark happens once; nothing re-settles it).
 * 2. Ready to mark (a persona wrote the Outcome, the owner has not marked) skips cadence and timed wakes; Run now still wakes.
 */

/** Settle after the owner's mark when the status now shows exactly his verdict (Accomplished, Partially, Superseded). */
export async function settleOnMark(
  store: Store,
  m: Milestone,
  verdict: MarkVerdict,
  word: OutcomeWord | undefined,
  // the settle mark goes to the team repo's state/milestones.json first (milestoneRecord); default: console.db only
  settle: (id: string) => Promise<Milestone | undefined> | Milestone | undefined = (id) => store.setSettled(id, true),
): Promise<boolean> {
  if (verdict === "not_accomplished" || word !== verdict) return false;
  if (store.getMilestone(m.id)?.settledAt) return false;
  return !!(await settle(m.id))?.settledAt;
}

/** What the outcome word needs from the milestone's derived info (app.ts `withOutcome`). */
export interface OutcomeInfo {
  status?: string;
  outcome?: Outcome | null;
  doctrine?: { doneMeans?: { done: boolean }[] };
  dod?: { done: number; total: number; tracked?: boolean };
}

/** True while the milestone reads Ready to mark (same rule as the status object; no tree needed: no verdict yet). */
export const readyToMarkOf = (info: (m: Milestone) => Promise<OutcomeInfo>) => async (m: Milestone): Promise<boolean> => {
  const i = await info(m);
  return outcomeOf({ status: i.status, outcome: i.outcome, doneMeans: doneMeansCount({ dod: i.dod, doneMeans: i.doctrine?.doneMeans }) }).word === "ready_to_mark";
};
