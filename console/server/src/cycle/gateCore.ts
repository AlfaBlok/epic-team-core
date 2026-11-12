import type { Persona, Run } from "../store.js";
import { SKIP_PREFIX } from "./skipUnchanged.js";

/**
 * What the cycle needs from the wake pre-check and the pack check: moved unchanged from cycle/wakeGate.ts
 * and cycle/packWake.ts, whose campaign and post logic is the hosted social layer's.
 */
export type GateKind = "publisher" | "responder";

export interface GateDecision {
  work: boolean;
  why: string;
  /** Called once the wake really starts: saves what it was shown (the Responder's inbox prints). */
  commit?: () => void;
}

/** The pack role a persona holds alone (explicit `Pack role:` line in the remit, else its name's words). */
export function gateKindOf(p: Pick<Persona, "name" | "remit">): GateKind | undefined {
  const explicit = /^[\s>*-]*pack roles?:\s*(.+)$/im.exec(p.remit ?? "");
  const words = (explicit ? explicit[1].split(/[,/&+]|\band\b/) : p.name.split(/[^A-Za-z]+/)).map((w) => w.replace(/[`*]/g, "").trim().toLowerCase()).filter(Boolean);
  const roles = new Set(words.filter((w) => w === "publisher" || w === "responder" || w === "writer" || w === "author"));
  if (roles.size !== 1) return undefined; // Author = Writer + Publisher: writes too, never gated
  const [r] = roles;
  return r === "publisher" || r === "responder" ? r : undefined;
}

/**
 * a Publisher's wake takes minutes, and while a run of its assignment counts as running the cadence starts
 * none. One that never reported (run_df1b56e0, 10 Nov 17:01Z) held Get testers' Publisher for the full 3 h stale window,
 * so P-0006's 19:00Z slot passed unattempted. A Publisher's run is stale after 45 min (never later than the general window).
 */
export const PUBLISHER_STALE_MS = 45 * 60_000;
export function staleRunMsFor(p: Pick<Persona, "name" | "remit"> | undefined, staleMs: number): number {
  return p && gateKindOf(p) === "publisher" ? Math.min(staleMs, PUBLISHER_STALE_MS) : staleMs;
}

/** The summary of a gated skip run (starts with SKIP_PREFIX, so wake stats count it as a skip). */
export const gateSkipSummary = (lastRealWakeId: string | undefined, why: string) => `${SKIP_PREFIX} ${lastRealWakeId ?? "the last wake"} (pre-check: ${why})`;

/** The newest real wake of an assignment (top level, not a skip, a hold or one still running), newest-first runs. */
export function lastRealWake(runs: Run[]): Run | undefined {
  return runs.find((r) => !r.parentRunId && r.kind !== "answer_run" && r.outcome !== "running" && !r.heldOn && !/^(skipped|held|parked|re-armed)\b/.test(r.summary));
}

/** `blocker: rule broken …` lines for a Delivery Manager wake: runs of its milestone flagged since its previous wake. */
export function ruleBrokenSection(runs: Run[], since: string, personaName: (r: Run) => string | undefined): string | undefined {
  const hit = runs.filter((r) => r.ruleBroken && r.ruleBroken.at > since).sort((a, b) => a.ruleBroken!.at.localeCompare(b.ruleBroken!.at));
  if (!hit.length) return undefined;
  return [
    "## Rule broken (pack check after a wake)",
    "These runs committed pack-file changes their role may not make (the console's `pack.py validate --by <role>` after the run). Nothing was blocked or reverted.",
    "Put each in your summary as its own `blocker: rule broken: …` line, record it in the epic (Issue Ledger / Current State), and route the fix forward " +
      "(a new commit by the role that may make it, or a revert only if the change must not stand).",
    ...hit.flatMap((r) => [
      `blocker: rule broken: run ${r.id} (${personaName(r) ?? "persona"}${r.ruleBroken!.roles.length ? ` as ${r.ruleBroken!.roles.join("/")}` : ", no pack role"})`,
      ...r.ruleBroken!.issues.slice(0, 10).map((l) => `  - ${l}`),
      ...(r.ruleBroken!.issues.length > 10 ? [`  - … ${r.ruleBroken!.issues.length - 10} more on the run`] : []),
    ]),
  ].join("\n");
}
