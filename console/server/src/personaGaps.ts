import { isDeliveryManager } from "./inbox/asks.js";
import { milestoneOfEpic } from "./pursuitRoutes.js";
import type { Assignment, Milestone, Persona } from "./store.js";

/**
 * Every goal comes with a Delivery Manager (the owner: "a wheel
 * without a persona is not going to turn"; the house sat 19 h with none). A milestone or objective turns only when a
 * Delivery Manager is on it: switched on, or auto-parked with nothing to do (it wakes again by itself). One check
 * for the objectives screen (the pill), GET /api/persona-gaps and scripts/persona_check.py, run every wake.
 */

/** the one sentence every place says (a wheel without a persona does not turn). */
export const NO_TURNER = "No Delivery Manager: this wheel does not turn";
export const TURNER_OFF = "Its Delivery Manager is switched off: this wheel does not turn";

/** on: a Delivery Manager wakes on it; off: one is assigned but switched off; none: no Delivery Manager at all. */
export type Turner = "on" | "off" | "none";

export function turnerOf(teams: { persona: string; enabled: boolean; parked?: boolean }[] | undefined): Turner {
  const dms = (teams ?? []).filter((t) => isDeliveryManager(t.persona));
  if (!dms.length) return "none";
  return dms.some((t) => t.enabled || t.parked) ? "on" : "off";
}

export const gapWords = (t: Turner) => (t === "none" ? NO_TURNER : t === "off" ? TURNER_OFF : "");

/** a gap is a goal with no persona at all; a Delivery Manager switched off is there, only not waking (shown, never failed). */
export const isGap = (g: Pick<PersonaGap, "turner">) => g.turner === "none";

export interface PersonaGap {
  kind: "milestone" | "objective";
  id: string;
  title: string;
  world: string;
  turner: Exclude<Turner, "on">;
  why: string;
  milestoneId?: string;
}

type GapStore = {
  listMilestones: () => Milestone[];
  listAssignments: (f: { milestoneId: string }) => Assignment[];
  getPersona: (id: string) => Persona | undefined;
};

const teamsOn = (s: GapStore, milestoneId: string) =>
  s.listAssignments({ milestoneId }).map((a) => ({ persona: s.getPersona(a.personaId)?.name ?? "", enabled: a.enabled, parked: !!a.parkedAt && a.parkedReason !== "settled" }));

/** every live milestone (not settled, not paused) of every world with no Delivery Manager turning it. */
export function milestoneGaps(s: GapStore, worldOf: (id: string) => string): PersonaGap[] {
  return s
    .listMilestones()
    .filter((m) => !m.settledAt && !m.paused)
    .flatMap((m): PersonaGap[] => {
      const t = turnerOf(teamsOn(s, m.id));
      return t === "on" ? [] : [{ kind: "milestone", id: m.id, title: m.title, world: worldOf(m.id), turner: t, why: gapWords(t), milestoneId: m.id }];
    });
}

export interface ObjectiveIn {
  id: string;
  name: string;
  epics: { repo: string; path?: string; spine?: string }[];
}

/**
 * every objective (his pursuits and other worlds) whose epics sit under no milestone with a Delivery Manager on it.
 * An objective with several milestones turns when any of them does.
 */
export function objectiveGaps(objectives: ObjectiveIn[], s: GapStore, worldOf: (id: string) => string): PersonaGap[] {
  const live = s.listMilestones().filter((m) => !m.settledAt);
  return objectives.flatMap((o): PersonaGap[] => {
    const ms = [...new Map(o.epics.map((e) => milestoneOfEpic(live, e.repo, e.path ?? e.spine ?? "")).filter((h) => !!h).map((h) => [h!.m.id, h!.m])).values()];
    const turners = ms.map((m) => turnerOf(teamsOn(s, m.id)));
    if (turners.includes("on")) return [];
    const t: Exclude<Turner, "on"> = turners.includes("off") ? "off" : "none";
    return [{ kind: "objective", id: o.id, title: o.name, world: ms[0] ? worldOf(ms[0].id) : "", turner: t, why: ms.length ? gapWords(t) : `${NO_TURNER} (no milestone runs its epics)`, ...(ms[0] ? { milestoneId: ms[0].id } : {}) }];
  });
}

/**
 * The world's Delivery Manager for a new milestone: the first persona of that world named Delivery Manager.
 * A milestone created anywhere gets one assigned at once, switched off, every 2 h when switched on (the owner: "we
 * should have by default a delivery manager turned off ... if it's a wheel, it has to have a persona").
 */
export function deliveryManagerOf(personas: Persona[]): Persona | undefined {
  return personas.find((p) => isDeliveryManager(p.name));
}

export const DEFAULT_DM_CADENCE = { type: "interval" as const, everyMinutes: 120 };
