import type { PendingItem, PendingKind } from "@/api";

/**
 * the Pending selector is the one inbox. Every count of "waiting on you" (Team badge, the selector, a
 * milestone's tab, its Waiting on you box) is the number of open items of the server's status (GET /api/status,
 * /api/milestones/:id/status): nothing counts from its own list.
 */

/** Open items for the owner, within a tree node's subtree when `nodeKey` is given (same rule as the server's node filter). */
export function openItems(items: PendingItem[] | undefined, nodeKey?: string): PendingItem[] {
  return (items ?? []).filter((i) => i.state === "open" && (!nodeKey || i.nodeKey === nodeKey || !!i.nodeKey?.startsWith(nodeKey + "/")));
}

export type PendingGroupKey = "alerts" | "needs_you" | "ready_to_mark" | "stalled" | "runs";
export const PENDING_GROUPS: { key: PendingGroupKey; label: string; kinds: PendingKind[] }[] = [
  { key: "alerts", label: "Monitor alerts", kinds: ["monitor_alert"] },
  { key: "needs_you", label: "Needs you", kinds: ["ask", "needs_jordi", "free_text_ask", "mark_ready"] },
  { key: "ready_to_mark", label: "Ready to mark", kinds: ["ready_to_mark"] },
  { key: "stalled", label: "Stalled", kinds: ["stalled"] },
  { key: "runs", label: "Failed or unreported runs", kinds: ["failed_run"] },
];

/** The selector's groups, in order, empty ones left out. Answers already given (kind answered) are not listed. */
export function groupPending(items: PendingItem[] | undefined): { key: PendingGroupKey; label: string; items: PendingItem[] }[] {
  const list = (items ?? []).filter((i) => i.kind !== "answered");
  return PENDING_GROUPS.map((g) => ({ key: g.key, label: g.label, items: list.filter((i) => g.kinds.includes(i.kind)) })).filter((g) => g.items.length > 0);
}

/** The one action an item offers: where it goes (in the console), or the rewrite request for a free-text ask. */
export type PendingAction = { label: string; to: string } | { label: string; rewrite: { milestoneId: string; path: string } };
export function pendingAction(i: PendingItem): PendingAction {
  const ms = `/milestones/${encodeURIComponent(i.milestoneId)}`;
  switch (i.kind) {
    case "free_text_ask":
      return i.path ? { label: "Rewrite as a coded ask", rewrite: { milestoneId: i.milestoneId, path: i.path } } : { label: "Answer", to: `${ms}?tab=waiting&item=${encodeURIComponent(i.id)}` };
    case "ready_to_mark":
      return { label: "Review and mark", to: `${ms}?tab=summary` };
    case "mark_ready":
      return { label: "Mark ready", to: `${ms}?tab=waiting&item=${encodeURIComponent(i.id)}` };
    case "stalled":
      return { label: "Switch on", to: `${ms}?tab=personas` };
    case "failed_run":
      return { label: "Open run", to: `${ms}?tab=activity` };
    case "monitor_alert":
      return { label: "Open alert", to: `${ms}?tab=waiting&item=${encodeURIComponent(i.id)}` };
    default:
      return { label: "Answer", to: `${ms}?tab=waiting&item=${encodeURIComponent(i.id)}` };
  }
}
