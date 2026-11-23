import { ownerName } from "../identity.js";
import type { HeldAsk } from "./askGate.js";

/**
 * the owner, closing a review card on 23 Nov: "the held-questions fix for every goal, in the overall check".
 * a question the ask gate holds back from the owner goes to that goal's Delivery Manager to rewrite or drop. Two
 * tax questions sat held more than 7 days because that world's Delivery Manager was off and nobody else saw
 * the list. Now a held ask whose own manager is off, or has not touched it within HELD_ROUTE_MS, is listed to the
 * Delivery Manager of the world's home goal (the overall check), every goal, every wake, until it is rewritten or dropped.
 * Its line changing (a rewrite) restarts the clock; an `[answered …]` line (dropped or decided) ends it.
 */
export const HELD_ROUTE_MS = 2 * 3_600_000;

export interface HeldOfGoal {
  milestoneId: string;
  title: string;
  /** that goal's own Delivery Manager is switched on (enabled and not parked) */
  managerOn: boolean;
  held: HeldAsk[];
}

export interface RoutedHeld extends HeldAsk {
  milestoneId: string;
  goal: string;
  why: "manager off" | "not acted on in 2 h";
  /** whole hours held, when known */
  hours?: number;
}

/** the held asks the home Delivery Manager takes over: the owner's goal manager is off, or the hold is 2 hours old. */
export function heldToRoute(goals: HeldOfGoal[], homeMilestoneId: string, now = Date.now()): RoutedHeld[] {
  const seen = new Set<string>();
  const out: RoutedHeld[] = [];
  for (const g of goals) {
    if (g.milestoneId === homeMilestoneId) continue; // its own manager already lists them
    for (const h of g.held) {
      const key = `${h.repo}:${h.path}:${h.line ?? h.question}`;
      if (seen.has(key)) continue;
      const at = h.since ? Date.parse(h.since) : NaN;
      const age = Number.isFinite(at) ? now - at : undefined;
      const why = !g.managerOn ? "manager off" : age !== undefined && age >= HELD_ROUTE_MS ? "not acted on in 2 h" : undefined;
      if (!why) continue;
      seen.add(key);
      out.push({ ...h, milestoneId: g.milestoneId, goal: g.title, why, ...(age !== undefined ? { hours: Math.floor(age / 3_600_000) } : {}) });
    }
  }
  return out.sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0));
}

/** the home Delivery Manager's wake section: held asks other goals' managers left, to rewrite or drop this wake. */
export function routedHeldSection(routed: RoutedHeld[], homeRepo: string): string | undefined {
  if (!routed.length) return undefined;
  return [
    `## Held questions other goals left (the overall check)`,
    `The ask gate holds these questions back from ${ownerName()}, and their own goal's Delivery Manager is off or has not acted on them for 2 hours. ` +
      `This wake, for each one: rewrite it so it passes the gate (one decision, his words or a real \`why ${ownerName()}:\`, an About line, a link), or drop it ` +
      "(`[answered <CODE> <date> @Delivery-Manager] … — answer: dropped, not his ask`), or do the work yourself. " +
      `A question in your own repo (${homeRepo}) you edit; one in another repo is another world: never edit it, send its owner a desk note ` +
      "(`python3 scripts/desk_note.py send --to <that repo's checkout> --from <this world> --reply-to <this repo> --about \"Rewrite or drop held ask <CODE>\" --body \"<the gate's reason, and the rewrite you propose>\"`) and name the note on your wake report.",
    ...routed.slice(0, 20).map(
      (h) =>
        `- ${h.code ?? "(no code)"} · ${h.goal} · ${h.why}${h.hours !== undefined ? ` · held ${h.hours} h` : ""} · ${h.repo}/${h.path}${h.line !== undefined ? `:${h.line + 1}` : ""}${h.repo === homeRepo ? "" : " (another world: desk note)"}: ${h.question.slice(0, 140)} — held: ${h.reason.slice(0, 160)}`,
    ),
    ...(routed.length > 20 ? [`- … ${routed.length - 20} more`] : []),
  ].join("\n");
}
