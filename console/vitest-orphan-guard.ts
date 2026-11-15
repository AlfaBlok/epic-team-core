// A test fork ends when its vitest parent is gone. A command timeout (an agent's tool limit, `timeout N`) kills the vitest
// parent but not its fork: the orphaned fork kept running, spinning at up to 90% CPU and growing about 20 MB a second up to
// Node's 4 GB heap limit (on the worker server, the biggest process in most low-memory minutes, refusing worker picks).
// The spin starves the fork's own event loop (no timer, no 'disconnect' event runs), so the watch runs in a worker thread
// with its own loop and kills the fork from there.
// Loaded as a vitest setup file inside each fork (browser and console server suites); lives beside the host guard.
import { Worker } from "node:worker_threads";

const KEY = Symbol.for("vitestOrphanGuard");
const g = globalThis as Record<symbol, unknown>;

/** The watch, run in a worker thread: SIGKILL the fork once it is re-parented (its vitest parent died). */
export const WATCH_SRC = `
const { workerData } = require("node:worker_threads");
const { pid, parent, intervalMs } = workerData;
setInterval(() => {
  if (process.ppid === parent) return;
  try { require("node:fs").writeSync(2, "vitest fork " + pid + ": vitest parent " + parent + " is gone, killing it (orphan guard)\\n"); } catch {}
  process.kill(pid, "SIGKILL");
}, intervalMs);
`;

/** Start the watch for this fork; once per process (setup files run again for each test file in the same fork). */
export function installOrphanGuard(intervalMs = 2000): Worker | null {
  if (g[KEY]) return null;
  g[KEY] = true;
  const w = new Worker(WATCH_SRC, { eval: true, workerData: { pid: process.pid, parent: process.ppid, intervalMs } });
  w.unref(); // never keeps a finished fork alive
  return w;
}

installOrphanGuard();
