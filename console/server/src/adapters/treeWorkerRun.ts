import { parentPort } from "node:worker_threads";
import { setIdentity, type Identity } from "../identity.js";
import { trackDeps } from "./fileDeps.js";
import { buildTree } from "./tree.js";
import type { MilestoneRef } from "./milestone.js";
import type { SpinesJson } from "./spines.js";
import type { OwnerInfo } from "../tenancy/owner.js";

/**
 * the tree worker's message loop (treeWorker.ts loads it). One job: build one milestone tree with its file
 * deps (the same `trackDeps(() => buildTree(...))` the main thread ran) and post both back. spines.py outputs are kept
 * by id (`sid`) so one output is cloned across once, not on every build; an id this side no longer holds is asked for
 * again (`need`).
 */
export interface TreeJob {
  id: number;
  reposRoot: string;
  m: MilestoneRef & { title?: string };
  owner: OwnerInfo;
  /** the main thread's identity now (its owner can change at run time: a tenant row) */
  identity?: Partial<Identity>;
  sid?: number;
  spines?: SpinesJson;
}
export type TreeReply = { id: number; tree: unknown; deps: Map<string, string> } | { id: number; error: string } | { id: number; need: number };

const KEEP = 32;
const kept = new Map<number, SpinesJson | undefined>();

parentPort?.on("message", (job: TreeJob) => {
  const reply = (r: TreeReply) => parentPort!.postMessage(r);
  try {
    let spines: SpinesJson | undefined;
    if (job.sid != null) {
      if ("spines" in job) {
        kept.delete(job.sid);
        kept.set(job.sid, job.spines);
        while (kept.size > KEEP) kept.delete(kept.keys().next().value as number);
      } else if (!kept.has(job.sid)) return reply({ id: job.id, need: job.sid });
      spines = kept.get(job.sid);
    }
    if (job.identity) setIdentity(job.identity);
    const { value, deps } = trackDeps(() => buildTree(job.reposRoot, job.m, spines, job.owner));
    reply({ id: job.id, tree: value, deps });
  } catch (e) {
    reply({ id: job.id, error: (e as Error)?.stack || String(e) });
  }
});
