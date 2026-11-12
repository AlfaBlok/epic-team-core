import type { Store } from "../store.js";

/**
 * will work added on a milestone be delivered? Ready rows are dispatched by the milestone's Delivery Manager
 * wake (root L-26), so an Add lands on no delivery lane when that assignment is off (or missing, or the milestone is paused).
 * The Add and placement answers carry this, and the desk says it in the same reply, word for word. Reading only: the desk
 * never switches a persona on or off unless the owner asks.
 */
export const DELIVERY_PERSONA = "Delivery Manager";

export interface Delivery {
  delivered: boolean;
  /** The persona whose assignment delivers the work (when the milestone has one). */
  persona?: string;
  assignmentId?: string;
  /** Set when it will not be delivered: "added, will not be delivered: <persona> is off". */
  notice?: string;
}

export function deliveryFor(store: Store, milestoneId: string): Delivery {
  const m = store.getMilestone(milestoneId);
  if (!m) return { delivered: false, notice: "added, will not be delivered: the milestone is not on the console" };
  const dm = store
    .listAssignments({ milestoneId })
    .map((a) => ({ a, p: store.getPersona(a.personaId) }))
    .filter((x) => x.p?.name.trim().toLowerCase() === DELIVERY_PERSONA.toLowerCase());
  if (!dm.length) return { delivered: false, notice: `added, will not be delivered: no ${DELIVERY_PERSONA} is assigned to ${m.title}` };
  const on = dm.find((x) => x.a.enabled) ?? dm[0];
  const who = { persona: on.p!.name, assignmentId: on.a.id };
  if (!on.a.enabled) return { delivered: false, ...who, notice: `added, will not be delivered: ${on.p!.name} is off` };
  if (m.paused) return { delivered: false, ...who, notice: `added, will not be delivered: ${m.title} is paused` };
  return { delivered: true, ...who };
}
