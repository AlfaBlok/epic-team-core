import type { SpineRef } from "@/api";

/** node view of a tracked milestone: the node key is one URL segment (its slashes encoded). */
export const milestoneNodeHref = (milestoneId: string, nodeKey: string) => `/milestones/${encodeURIComponent(milestoneId)}/node/${encodeURIComponent(nodeKey)}`;

/** ad hoc view of any spine (untracked), optionally from one node down. */
export function spineViewHref(ref: SpineRef & { nodeKey?: string }) {
  const q = new URLSearchParams({ path: ref.path, ...(ref.nodeKey ? { node: ref.nodeKey } : {}), ...(ref.title ? { title: ref.title } : {}) });
  return `/spines/${encodeURIComponent(ref.repo)}/view?${q}`;
}

/** Hook for's ancestry breadcrumb: a node of a tracked milestone's tree → its node view. */
export const nodeViewHref = milestoneNodeHref;

/**
 * Hook for's ancestry breadcrumb: an ancestor spine (checkout name + repo-relative path) → the milestone tracking
 * it when there is one (`tracked`: spine path → milestone id, as in NodeTree.tracked), else its ad hoc node view.
 */
export function spineHref(ref: SpineRef, tracked?: Record<string, string>) {
  const id = tracked?.[ref.path];
  return id ? `/milestones/${encodeURIComponent(id)}` : spineViewHref(ref);
}
