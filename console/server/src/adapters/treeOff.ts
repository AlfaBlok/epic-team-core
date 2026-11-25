import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { identity, sites } from "../identity.js";
import type { Deps } from "./fileDeps.js";
import type { MilestoneRef } from "./milestone.js";
import type { SpinesJson } from "./spines.js";
import type { Tree } from "./tree.js";
import type { OwnerInfo } from "../tenancy/owner.js";
import type { TreeJob, TreeReply } from "./treeWorkerRun.js";

/**
 * milestone trees built off the event loop. `buildTree` is synchronous and reads every spine and ticket file
 * of a milestone: on the main server (load 8, 4 cores) the console's loop was blocked 73 s of a 92 s profile, 38 s of it
 * in tree builds, so every request (wakes, worker launches, the owner's phone app) waited behind them. `buildOff` runs
 * the same build in one worker thread (treeWorker.ts) and resolves with the tree and its file deps, exactly what
 * `trackDeps(() => buildTree(...))` gave on this thread.
 *
 * `available()` is false (callers build inline, as before) when there is no worker bundle next to the server bundle (the
 * tests and tsx runs, unless `CONSOLE_TREE_WORKER=1`), when `CONSOLE_TREE_WORKER=0`, or after the worker failed to start
 * three times in a row. A worker that dies fails its builds in flight (the memo's next read tries again) and is restarted
 * on the next build.
 */
export interface TreeOff {
  available(): boolean;
  buildOff(reposRoot: string, m: MilestoneRef & { title?: string }, spines: SpinesJson | undefined, owner: OwnerInfo): Promise<{ value: Tree; deps: Deps }>;
  stats(): { builds: number; failures: number; starts: number; deaths: number; queued: number };
  close(): void;
}

/** the worker bundle next to the server bundle (dist/treeWorker.mjs), else (tsx, only when asked for) treeWorker-dev.mjs. */
export function treeWorkerFile(env: NodeJS.ProcessEnv = process.env): URL | undefined {
  if (env.CONSOLE_TREE_WORKER === "0") return undefined;
  const here = import.meta.url;
  const candidates = here.endsWith(".mjs") ? [new URL("./treeWorker.mjs", here)] : env.CONSOLE_TREE_WORKER === "1" ? [new URL("./treeWorker-dev.mjs", here)] : [];
  return candidates.find((u) => fs.existsSync(fileURLToPath(u)));
}

export function createTreeOff(file: URL | undefined = treeWorkerFile(), log: (m: string) => void = (m) => console.warn(m)): TreeOff {
  let worker: Worker | undefined;
  let nextId = 1;
  let nextSid = 1;
  let failedStarts = 0;
  let closed = false;
  const st = { builds: 0, failures: 0, starts: 0, deaths: 0 };
  /** spines.py outputs by object: the id the worker keeps it under (reset when a new worker starts). */
  let sids = new WeakMap<object, number>();
  const pending = new Map<number, { job: TreeJob; spines: SpinesJson | undefined; resolve: (v: { value: Tree; deps: Deps }) => void; reject: (e: Error) => void }>();

  const start = (): Worker | undefined => {
    if (worker || !file || closed || failedStarts >= 3) return worker;
    try {
      const w = new Worker(file, { workerData: { identity: identity(), sites: sites() } });
      st.starts++;
      sids = new WeakMap();
      w.unref();
      w.on("message", (r: TreeReply) => {
        failedStarts = 0;
        const p = pending.get(r.id);
        if (!p) return;
        if ("need" in r) {
          // the worker let this spines.py output go: send it again with the job
          w.postMessage({ ...p.job, spines: p.spines });
          return;
        }
        pending.delete(r.id);
        if ("error" in r) {
          st.failures++;
          const e = new Error(r.error.split("\n")[0]);
          e.stack = r.error;
          p.reject(e);
        } else {
          st.builds++;
          p.resolve({ value: r.tree as Tree, deps: r.deps });
        }
      });
      const gone = (why: string) => {
        if (worker !== w) return;
        worker = undefined;
        st.deaths++;
        log(`tree worker: ${why}; ${pending.size} build(s) in flight failed, it restarts on the next build`);
        for (const [id, p] of pending) {
          pending.delete(id);
          p.reject(new Error(`tree worker: ${why}`));
        }
      };
      w.on("error", (e) => {
        failedStarts++;
        gone(`error: ${e.message}`);
      });
      w.on("exit", (code) => gone(`exited (${code})`));
      worker = w;
      return w;
    } catch (e) {
      failedStarts++;
      log(`tree worker: could not start: ${(e as Error).message}`);
      return undefined;
    }
  };

  return {
    available: () => !!file && !closed && failedStarts < 3,
    buildOff(reposRoot, m, spines, owner) {
      const w = start();
      if (!w) return Promise.reject(new Error("tree worker: not running"));
      const id = nextId++;
      const job: TreeJob = { id, reposRoot, m, owner, identity: identity() };
      const msg: TreeJob = { ...job };
      if (spines && typeof spines === "object") {
        let sid = sids.get(spines);
        if (sid == null) {
          sid = nextSid++;
          sids.set(spines, sid);
          msg.spines = spines;
        }
        job.sid = msg.sid = sid;
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { job, spines, resolve, reject });
        try {
          w.postMessage(msg);
        } catch (e) {
          pending.delete(id);
          reject(e as Error);
        }
      });
    },
    stats: () => ({ ...st, queued: pending.size }),
    close() {
      closed = true;
      void worker?.terminate();
      worker = undefined;
    },
  };
}

let shared: TreeOff | undefined;
/** the console's one tree worker (started on the first build). */
export function treeOff(): TreeOff {
  shared ??= createTreeOff();
  return shared;
}
