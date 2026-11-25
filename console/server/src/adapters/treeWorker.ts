import { workerData } from "node:worker_threads";
import { setIdentity, setSites, type Identity, type Sites } from "../identity.js";

/**
 * the tree worker thread's entry: `buildTree` walks every spine and ticket file of a milestone, synchronously,
 * and on the main server it held the console's event loop about 40% of the time (wakes, workers and the owner's app all
 * waited). It now runs here. A worker loads its modules afresh, so the console's identity and sites (set by the hosted
 * layer or the environment on the main thread) arrive in workerData and are set before the tree modules load
 * (tenancy/owner.ts DEFAULT_OWNER reads the identity once at load), the same way as the read model worker (readModel/worker.ts).
 */
const wd = workerData as { identity?: Partial<Identity>; sites?: Partial<Sites> } | undefined;
if (wd?.identity) setIdentity(wd.identity);
if (wd?.sites) setSites(wd.sites);
await import("./treeWorkerRun.js");
