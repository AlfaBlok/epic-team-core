import { answeredAsks, HONESTY_FLAGS, isClosed, type Tree, type TreeNode } from "../adapters/tree.js";
import { ownerName } from "../identity.js";

/**
 * auto-park v1: one predicate for every assignment. Actionable = open tree nodes an agent can move
 * (grey/blue/yellow, not closed) plus flagged nodes (status not trustworthy, e.g. a dishonest green).
 * 🔴 red waits on the owner and green is done; neither is actionable.
 */
const REF_FLAGS = ["cycle", "repeat"]; // reference nodes are not counted (same rule as buildTree's counts)

export function actionableCount(t: Tree): number {
  let n = 0;
  const visit = (x: TreeNode) => {
    if (!x.flags.some((f) => REF_FLAGS.includes(f))) {
      const flagged = x.flags.some((f) => HONESTY_FLAGS.includes(f));
      if (flagged || (x.color !== "green" && x.color !== "red" && !isClosed(x))) n++;
    }
    x.children.forEach(visit);
  };
  visit(t.root);
  // an `[answered]` line is work for the owner (act on it, delete it) even when its row still shows red for the owner.
  return n + answeredAsks(t).length;
}

export type ParkDecision = { park: true; reason: string } | { park: false; actionable?: number };

/** undefined tree (build failed) or a fallback tree (doc parser only, with warnings) never parks. */
export function parkDecision(t: Tree | undefined, referencedAnswers = 0): ParkDecision {
  if (!t || t.source === "fallback") return { park: false };
  // answers at other epics' canonical asks that this milestone waits on are work for its owner too.
  const actionable = actionableCount(t) + referencedAnswers;
  if (actionable > 0) return { park: false, actionable };
  return { park: true, reason: t.counts.red > 0 ? `waiting on ${ownerName()}: ${t.counts.red} red` : "all green" };
}
