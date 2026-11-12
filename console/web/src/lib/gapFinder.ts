import { api, type Assignment, type Persona } from "@/api";
import type { CardFrom } from "@/api/review-types";
import { useSharedQuery } from "@/lib/data";

/**
 * the Gap finder is on when a persona of that name has a
 * switched-on assignment. Only then does the console show its menu entry, its runs and its Team home card; off, its page says
 * how to switch it on, with a link to the place to do it. One fetch for every reader (the menu, the page, the card lists).
 */
export interface GapFinderState {
  on: boolean;
  /** Where to switch it on or off: its assignment's Personas tab, else its persona's settings, else the Personas page. */
  settings: string;
}

export const isGapFinder = (p: Pick<Persona, "name">) => /^gap[\s-]?finder$/i.test(p.name.trim());

export function gapFinderState(personas: Pick<Persona, "id" | "name">[], assignments: Pick<Assignment, "personaId" | "milestoneId" | "enabled">[]): GapFinderState {
  const ids = new Set(personas.filter(isGapFinder).map((p) => p.id));
  const mine = assignments.filter((a) => ids.has(a.personaId));
  const live = mine.find((a) => a.enabled);
  const at = live ?? mine[0];
  const settings = at ? `/milestones/${at.milestoneId}?tab=personas` : ids.size ? `/personas?edit=${[...ids][0]}` : "/personas";
  return { on: !!live, settings };
}

/** undefined while loading or when the lists cannot be read (another world's 403): a reader then keeps what it shows. */
export function useGapFinder(): GapFinderState | undefined {
  return useGapFinderQuery().data;
}

export function useGapFinderQuery() {
  return useSharedQuery<GapFinderState>("gap-finder", () => Promise.all([api.listPersonas(), api.listAssignments()]).then(([p, a]) => gapFinderState(p, a)));
}

/** A Team home card the Gap finder sent: its From box names it or links its page. */
export const fromGapFinder = (from?: Pick<CardFrom, "name" | "page">) => !!from && (isGapFinder(from) || from.page === "/gap-finder");
