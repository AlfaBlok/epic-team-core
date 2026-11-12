import type { SpinesJson } from "../adapters/spines.js";
import type { RunState } from "./service.js";

/**
 * the run state of the node at `rel` from `spines.py --json` (contract: draft = planning,
 * ready = ready, active / blocked = running, deferred = parked, review / done / superseded = finished; only ready and
 * running are runnable). undefined when the node or the field is absent (older skill): the caller wakes as before.
 */
export function runStateFor(spines: SpinesJson, rel: string): RunState | undefined {
  const node = spines.nodes.find((n) => n.path === rel);
  if (!node || typeof node.run_state !== "string" || !node.run_state) return undefined;
  return { state: node.run_state, runnable: typeof node.runnable === "boolean" ? node.runnable : node.run_state === "ready" || node.run_state === "running" };
}
