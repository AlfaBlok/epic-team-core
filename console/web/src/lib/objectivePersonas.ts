import type { Assignment } from "@/api/types";

/**
 * Which assignments an objective's Personas tab lists (the owner: one Delivery Manager per objective on its
 * Personas tab). Several objectives share one milestone (eight sit on the home root spine), so the
 * milestone alone listed the whole team on each. One rule:
 * - an assignment that names an objective shows on that objective only, whatever milestone it wakes on;
 * - one that names none shows on its milestone's objective only when no other objective shares that milestone.
 */
export function personasOfObjective<A extends Pick<Assignment, "milestoneId" | "objective">>(
  assignments: A[],
  o: { id: string; milestoneId?: string; shared?: boolean },
): A[] {
  return assignments.filter((a) => (a.objective ? a.objective === o.id : !o.shared && !!o.milestoneId && a.milestoneId === o.milestoneId));
}
