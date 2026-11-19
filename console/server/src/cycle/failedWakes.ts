import { parseAsks } from "../inbox/asks.js";
import { sameText } from "../inbox/spineWrite.js";
import type { Run } from "../store.js";
import { SKIP_PREFIX } from "./skipUnchanged.js";

/**
 * A persona whose home thread broke once failed 23 wakes in a row, 10 h, and nobody heard:
 * this many failed wakes in a row of one persona on one milestone raise one inbox card (a console-written ask in the
 * milestone's spine; raiseAsk never asks the same question twice while it is open). The next wake that works takes it out.
 */
export const FAILED_WAKES_IN_A_ROW = 3;

/** a wake that tried to run: top level, ended, not a gated skip, not deferred or stopped. */
const tried = (r: Run) =>
  r.kind === "wake" && !r.parentRunId && !!r.endedAt && r.outcome !== "deferred" && r.outcome !== "stopped" && r.outcome !== "running" && !r.summary.startsWith(SKIP_PREFIX);

/**
 * `runs` newest first (store.listRuns). "failed": the newest `n` tried wakes all failed; "ok": the newest tried wake worked;
 * undefined: neither (fewer than `n` failures so far).
 */
export function wakeStreak(runs: Run[], n = FAILED_WAKES_IN_A_ROW): { state: "failed"; runs: Run[] } | { state: "ok" } | undefined {
  const t = runs.filter(tried);
  if (!t.length) return undefined;
  if (t[0].outcome !== "failed") return { state: "ok" };
  const head = t.slice(0, n);
  return head.length === n && head.every((r) => r.outcome === "failed") ? { state: "failed", runs: head } : undefined;
}

/** the card's question: stable per persona and milestone, so it is asked once while open. */
export const failedWakesQuestion = (persona: string, milestone: string, n = FAILED_WAKES_IN_A_ROW) =>
  `You decide: keep waking the ${persona} of ${milestone}, which failed its last ${n} wakes in a row, or switch it off until it is fixed?`;

/** what the team does, with the newest error and when the streak started. */
export function failedWakesAction(runs: Run[]): string {
  const last = runs[0];
  const err = (last.summary || "no reason recorded").replace(/\s+/g, " ").slice(0, 240);
  return `keep it waking: the console already moves a home thread that cannot start a turn to a new one; the team finds the cause of: ${err} (first failure ${runs[runs.length - 1].startedAt.slice(0, 16)}Z)`;
}

/** the code of the open card for this question in `spineText`, if any. */
export function openFailedWakesAsk(spineText: string, question: string): string | undefined {
  return parseAsks(spineText).find((x) => x.state === "open" && sameText(x.question) === sameText(question))?.code ?? undefined;
}
