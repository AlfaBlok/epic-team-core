import { workerData } from "node:worker_threads";
import { setIdentity, type Identity } from "../identity.js";

/**
 * the read model worker thread's entry (E996-S29): a worker thread loads its modules afresh, so the console's identity
 * (set by the hosted layer or the environment on the main thread) is handed over in workerData and set before the
 * refresher's modules load (db.ts DEFAULT_TENANT and tenancy/owner.ts DEFAULT_OWNER read it once at load).
 */
const id = (workerData as { identity?: Partial<Identity> } | undefined)?.identity;
if (id) setIdentity(id);
await import("./workerRun.js");
