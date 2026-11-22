import type { SpinesJson } from "../adapters/spines.js";
import type { Tree, TreeNode } from "../adapters/tree.js";

/**
 * a wake on a spine with children steers them (epicspine-skill run_state contract, docs/handoffs/.md).
 * Each child gets one verdict the wake prompt states: pick it up (ready, or running with no persona of its own),
 * leave it to its persona, or skip it (planning, parked, finished).
 */
export type RunState = "planning" | "ready" | "running" | "parked" | "finished";

export interface ChildEpic {
  path: string;
  title: string;
  status: string;
  runState: RunState;
  /** Name of the enabled persona assigned to the child's own milestone (it runs the child; the parent leaves it alone). */
  ownedBy?: string;
  /**
   * the ready rows of the child's own ledger (tree `ready`), listed by id on its PICK UP line so no ready row
   * hides behind "read each child's ledger" (three rows sat ready an hour that way). Undefined = the tree was not read.
   */
  ready?: string[];
}

/** The ready rows of the spine at `childPath` in the tree: its own ledger rows and their sub-rows, never a nested spine's. */
export function childReadyRows(t: Tree, childPath: string): string[] {
  const norm = (p?: string) => (p ?? "").replace(/^\.\//, "");
  const find = (n: TreeNode): TreeNode | undefined =>
    n.kind === "spine" && norm(n.path) === norm(childPath) ? n : n.children.reduce<TreeNode | undefined>((f, c) => f ?? find(c), undefined);
  const spine = find(t.root);
  if (!spine) return [];
  const out: string[] = [];
  const rows = (n: TreeNode) => {
    for (const c of n.children)
      if (c.kind === "ticket") {
        if (c.ready && !out.includes(c.id)) out.push(c.id);
        rows(c);
      }
  };
  rows(spine);
  return out;
}

export type ChildVerdict = "pickup" | "owned" | "planning" | "parked" | "finished";

/** The contract table, for a spines.py that does not emit `run_state` yet. */
export function runStateOf(status: string): RunState {
  const s = status.trim().toLowerCase();
  if (s === "draft") return "planning";
  if (s === "ready") return "ready";
  if (s === "active" || s === "blocked") return "running";
  if (s === "deferred") return "parked";
  return "finished"; // review, done, superseded (and anything unknown: never started by a parent)
}

export function childVerdict(c: ChildEpic): ChildVerdict {
  if (c.runState === "planning" || c.runState === "parked" || c.runState === "finished") return c.runState;
  return c.ownedBy ? "owned" : "pickup";
}

const RUN_STATES = new Set<string>(["planning", "ready", "running", "parked", "finished"]);

/**
 * The children of the node at `rel`, or undefined when it has none to steer (a leaf: its wake prompt is unchanged).
 * `has_children` (skill 2026.10.24.9) decides when present; otherwise any child that is not finished counts.
 */
export function childEpicsFor(spines: SpinesJson, rel: string, ownerOf: (childPath: string) => string | undefined): ChildEpic[] | undefined {
  const node = spines.nodes.find((n) => n.path === rel);
  if (!node || !node.children.length) return undefined;
  const children = node.children.flatMap((p): ChildEpic[] => {
    const c = spines.nodes.find((n) => n.path === p);
    if (!c) return [];
    const runState = c.run_state && RUN_STATES.has(c.run_state) ? (c.run_state as RunState) : runStateOf(c.status);
    const ownedBy = ownerOf(p);
    return [{ path: p, title: c.title, status: c.status, runState, ...(ownedBy ? { ownedBy } : {}) }];
  });
  const steers = typeof node.has_children === "boolean" ? node.has_children : children.some((c) => c.runState !== "finished");
  return steers && children.length ? children : undefined;
}
