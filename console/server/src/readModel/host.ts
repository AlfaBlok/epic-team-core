import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { identity } from "../identity.js";
import type { DB } from "../db.js";
import { addPatch, applyPatch, keyOf, type Patch, type ViewKey } from "./views.js";
import { createRefresher, type Refresher, type RefresherOptions } from "./refresher.js";
import { ensureReadModel, markRead, readPayload, readStamp } from "./table.js";
import type { SpinesRunner } from "../adapters/spines.js";
import { answerSpinesAsk, isSpinesAsk } from "./spinesBridge.js";
import { driftLine, type DriftResult } from "./drift.js";
import { DRIFT_KEY, T3_KEY, ensureIndexerTables, kvAt, kvGet, kvSet, sendToIndexer, type IndexerMsg } from "../indexer/queue.js";

/**
 * the request side of the read model. GET /waiting-on-owner, /status and /milestones/:id/status answer from the
 * view's console.db row (a few ms: one indexed read, the parse cached per computed version), never from spines.py or
 * git. Only a view that has no row yet (first boot ever, or a view nobody asked for before) is computed inline, answered
 * and handed to the refresher, which stores it (it is the only writer) and keeps it current.
 *
 * The refresher runs in a worker thread (worker.ts: its own DB connection, its own spines.py runs), so its CPU never
 * holds a request; `in-process` runs the same refresher on this thread (tests, or a build without the worker bundle).
 * the owner's own changes (answer, snooze, supersede) are applied to every view at once (`patch`) and kept applied for a few
 * minutes, until the refresher has re-read the spine they were written to.
 */
export interface ReadModelHostOptions {
  db: DB;
  /**
   * `external`: the refresher runs in the console's indexer process (indexer/core.ts); this host only reads the
   * stored views and hands it changes through console.db (indexer/queue.ts).
   */
  mode: "worker" | "in-process" | "none" | "external";
  /** Worlds kept warm from the start ("" = unscoped). Re-read when the worker starts. */
  worlds: () => string[];
  /** in-process: the refresher's inputs (db and worlds are filled in here). */
  refresher?: Omit<RefresherOptions, "db" | "worlds">;
  /** worker: what the worker needs to build its own reads (it opens its own connection to dbPath). */
  worker?: { dbPath: string; reposRoot: string; skillDir?: string; spinesFixture?: string; tenant?: string; teamRepo?: string };
  /**
   * the main thread's (cached) spines.py runner; when set, the worker asks it for spines.py output instead of
   * running its own (one run in flight per repo across the console).
   */
  spines?: SpinesRunner;
  /** Run ids still running, and T3's read of each (status: Working vs stalled); sent to the worker every 10 s. */
  runningRuns?: () => string[];
  t3State?: (runId: string) => { status: string; checkedAt: string } | undefined;
  /** Refresher tick (default 5 s; 0 = only on demand, tests). */
  tickMs?: number;
  /** How long the owner's change stays applied on top of the stored views (default 5 min). */
  patchTtlMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
  /**
   * the drift check (drift.ts): every `everyMs` (first after `firstAfterMs`, default 10 min) each stored view is
   * rebuilt off to the side and compared; `onResult` gets every result (the app logs it and alerts on drift). 0 = off.
   */
  drift?: { everyMs: number; firstAfterMs?: number; confirmAfterMs?: number; onResult?: (r: DriftResult) => void };
  /**
   * how long a request waits on an inline read of a view with no stored row (spines.py: seconds on an idle host, minutes
   * on a CPU-capped one) before it answers from the nearest stored view instead (`nearestView`; default 2 s, 0 =
   * wait as before). The inline read carries on and the refresher stores the view, so the next request is a hit.
   */
  inlineBudgetMs?: number;
}

export interface ViewRead<T> {
  payload: T;
  /** When the view was last known current (computed, or its inputs found unchanged). */
  asOf: string;
  /** fallback: a stored neighbour stood in while the asked view is still being read (see `nearestView`). */
  source: "snapshot" | "inline" | "fallback";
}

export interface ReadModelHost {
  /** The stored view, else (no row yet) computed inline and handed to the refresher, which stores it. */
  view<T>(k: ViewKey, inline: () => Promise<T>): Promise<ViewRead<T>>;
  /** The stored view, if any. */
  peek<T>(k: ViewKey): ViewRead<T> | undefined;
  /** A checkout changed (a console write or pull): its views are recomputed. `stale`: a pull, re-read within the rescan gap. */
  dirty(dir?: string, d?: { stale?: boolean }): void;
  /** the owner changed something every view may show (an answer): all views are recomputed. */
  dirtyAll(): void;
  /** Apply the owner's change to every view at once (and re-read the spines behind them). */
  patch(p: Patch): void;
  /** the last drift check's result (undefined until the first one ran). */
  drift(): DriftResult | undefined;
  /** run a drift check now (resolves with its result; undefined when no refresher is running). */
  checkDrift(): Promise<DriftResult | undefined>;
  /** in-process only: the refresher (tests drive `tick`/`idle`). */
  refresher?: Refresher;
  close(): void;
}

/** The worker bundle next to the server bundle (dist/readModelWorker.mjs), else (tsx) worker-dev.mjs, which loads worker.ts. */
export function workerFile(): URL | undefined {
  const here = import.meta.url;
  const candidates = here.endsWith(".mjs") ? [new URL("./readModelWorker.mjs", here)] : [new URL("./worker-dev.mjs", here)];
  return candidates.find((u) => fs.existsSync(fileURLToPath(u)));
}

export function createReadModelHost(o: ReadModelHostOptions): ReadModelHost {
  const { db } = o;
  ensureReadModel(db);
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.warn(m));
  const patchTtlMs = o.patchTtlMs ?? 5 * 60_000;
  const tickMs = o.tickMs ?? 5_000;
  const parsed = new Map<string, { asOf: string; value: unknown }>();
  const inflight = new Map<string, Promise<{ value: unknown; at: string }>>();
  const touched = new Set<string>();
  let patches: { at: number; p: Patch }[] = [];

  // ---------- the refresher ----------
  let worker: Worker | undefined;
  let refresher: Refresher | undefined;
  const timers: ReturnType<typeof setInterval>[] = [];
  let closed = false;
  let restarts = 0;
  const post = (m: unknown) => {
    if (o.mode === "external") {
      try {
        const x = m as { type?: string; states?: unknown };
        if (x.type === "t3") kvSet(db, T3_KEY, x.states ?? {});
        else sendToIndexer(db, m as IndexerMsg);
      } catch (e) {
        log(`read model: indexer queue: ${(e as Error).message}`);
      }
      return;
    }
    try {
      worker?.postMessage(m);
    } catch {
      /* worker gone: it is restarted */
    }
  };
  const t3States = () => {
    const out: Record<string, { status: string; checkedAt: string }> = {};
    for (const id of o.runningRuns?.() ?? []) {
      const s = o.t3State?.(id);
      if (s) out[id] = s;
    }
    return out;
  };
  const inProcess = () => {
    if (!o.refresher) return;
    refresher = createRefresher({ ...o.refresher, db, worlds: o.worlds(), ...(o.t3State ? { t3State: o.t3State } : {}) });
    if (tickMs > 0) {
      void refresher.tick();
      const t = setInterval(() => void refresher!.tick(), tickMs);
      t.unref?.();
      timers.push(t);
    }
  };
  const startWorker = () => {
    const file = workerFile();
    if (!file || !o.worker) {
      log("read model: no worker bundle; refreshing on the main thread");
      return inProcess();
    }
    const spines = o.spines && !o.worker.spinesFixture ? o.spines : undefined;
    const w = new Worker(file, { workerData: { ...o.worker, identity: identity(), worlds: o.worlds(), tickMs, t3: t3States(), ...(spines ? { spinesViaHost: true, startedAt: now() } : {}) } });
    worker = w;
    w.on("message", (m: { type?: string; msg?: string }) => {
      if (m?.type === "log" && m.msg) log(m.msg);
      else if (m?.type === "drift-result") gotDrift((m as { result: DriftResult }).result);
      else if (isSpinesAsk(m))
        answerSpinesAsk(spines, m, (r) => {
          try {
            w.postMessage(r);
          } catch {
            /* worker gone: its restart asks again */
          }
        });
    });
    w.on("error", (e) => log(`read model worker: ${e.stack ?? e.message}`));
    w.on("exit", (code) => {
      if (worker === w) worker = undefined;
      if (closed) return;
      const wait = Math.min(60_000, 5_000 * 2 ** Math.min(restarts++, 4));
      log(`read model worker exited (${code}); restarting in ${wait / 1000} s`);
      const t = setTimeout(startWorker, wait);
      t.unref?.();
    });
  };
  if (o.mode === "external") ensureIndexerTables(db);
  if (o.mode === "worker" || o.mode === "external") {
    if (o.mode === "worker") startWorker();
    if (o.runningRuns) {
      const t = setInterval(() => post({ type: "t3", states: t3States() }), 10_000);
      t.unref?.();
      timers.push(t);
    }
  } else if (o.mode === "in-process") inProcess();
  // Last read per view, so views nobody opens any more are dropped by the refresher.
  {
    const t = setInterval(() => {
      if (!touched.size) return;
      try {
        markRead(db, [...touched], new Date(now()).toISOString());
      } catch {
        /* next minute */
      }
      touched.clear();
    }, 60_000);
    t.unref?.();
    timers.push(t);
  }

  // ---------- drift check ----------
  let lastDrift: DriftResult | undefined;
  let driftWaiters: ((r: DriftResult | undefined) => void)[] = [];
  const gotDrift = (r: DriftResult) => {
    lastDrift = r;
    log(driftLine(r));
    try {
      o.drift?.onResult?.(r);
    } catch (e) {
      log(`read model drift check: alert failed: ${(e as Error).message}`);
    }
    const w = driftWaiters;
    driftWaiters = [];
    for (const f of w) f(r);
  };
  const checkDrift = (): Promise<DriftResult | undefined> => {
    const confirm = o.drift?.confirmAfterMs !== undefined ? { confirmAfterMs: o.drift.confirmAfterMs } : {};
    if (refresher) return refresher.driftCheck(confirm).then((r) => (gotDrift(r), r));
    if (o.mode === "external") {
      // the indexer stores its result under DRIFT_KEY; the check takes minutes (a confirm wait), so look every 5 s.
      const before = kvAt(db, DRIFT_KEY);
      post({ type: "drift", ...confirm });
      return new Promise<DriftResult | undefined>((res) => {
        const t0 = now();
        const look = () => {
          const at = kvAt(db, DRIFT_KEY);
          if (at && at !== before) {
            const r = kvGet<DriftResult>(db, DRIFT_KEY)?.v;
            if (r) gotDrift(r);
            return res(r);
          }
          if (closed || now() - t0 > 60 * 60_000) return res(undefined);
          const t = setTimeout(look, 5_000);
          t.unref?.();
        };
        look();
      });
    }
    if (!worker) return Promise.resolve(undefined);
    const p = new Promise<DriftResult | undefined>((res) => driftWaiters.push(res));
    post({ type: "drift", ...confirm });
    return p;
  };
  if (o.drift && o.drift.everyMs > 0 && o.mode !== "none") {
    // a restart no longer brings the hourly check forward. The last check's time (the
    // indexer's stored result) holds across restarts, so the first one waits for the hour since it; the old fixed 10 min
    // after start put a ~4-min rebuild of every view behind each restart (13 restarts in 14 h).
    let lastAt = NaN;
    try {
      lastAt = Date.parse(kvAt(db, DRIFT_KEY) ?? "");
    } catch {
      /* no indexer tables: the first check after firstAfterMs */
    }
    const firstMs = Math.max(o.drift.firstAfterMs ?? 10 * 60_000, Number.isFinite(lastAt) ? lastAt + o.drift.everyMs - now() : 0);
    const first = setTimeout(() => {
      void checkDrift();
      const t = setInterval(() => void checkDrift(), o.drift!.everyMs);
      t.unref?.();
      timers.push(t);
    }, firstMs);
    first.unref?.();
    timers.push(first as unknown as ReturnType<typeof setInterval>);
  }

  const register = (k: ViewKey) => {
    if (refresher) refresher.register(k);
    else post({ type: "register", key: k });
  };

  // ---------- reads ----------
  /**
   * a review patch only bridges until the review view is read again from the spines: a view whose read started
   * after the patch (`asOf`) already holds the write, so the patch is skipped. Else a row back in review within the TTL (a
   * New iteration done fast, a goal reopened) stayed hidden up to 5 min after the spine had it. The review view reads the
   * spine files itself (no spines.py lag); ask patches keep the TTL.
   */
  const patched = (k: ViewKey, value: unknown, asOf?: string): unknown => {
    if (!patches.length) return value;
    const t = now();
    patches = patches.filter((x) => t - x.at < patchTtlMs);
    const readAt = asOf ? Date.parse(asOf) : NaN;
    let v = value;
    for (const x of patches) if (!(x.p.kind === "review" && readAt > x.at)) v = applyPatch(k, v, x.p);
    return v;
  };
  const peek = <T>(k: ViewKey): ViewRead<T> | undefined => {
    const s = keyOf(k);
    const st = readStamp(db, s);
    if (!st) return undefined;
    let hit = parsed.get(s);
    if (!hit || hit.asOf !== st.asOf) {
      const row = readPayload(db, s);
      if (!row) return undefined;
      hit = { asOf: row.asOf, value: JSON.parse(row.payload) };
      parsed.set(s, hit);
    }
    touched.add(s);
    return { payload: patched(k, hit.value, hit.asOf) as T, asOf: st.checkedAt > st.asOf ? st.checkedAt : st.asOf, source: "snapshot" };
  };

  return {
    view: async <T>(k: ViewKey, inline: () => Promise<T>): Promise<ViewRead<T>> => {
      const hit = peek<T>(k);
      if (hit) return hit;
      const s = keyOf(k);
      let p = inflight.get(s);
      if (!p) {
        const t0 = now();
        p = inline()
          .then((value) => {
            // Answered, never stored: an inline read may be a cold one (spines.py not done after a restart, the doc parser's
            // partial list). The refresher is the only writer; it stores the view once its repos are read.
            register(k);
            return { value: value as unknown, at: new Date(t0).toISOString() };
          })
          .finally(() => inflight.delete(s));
        inflight.set(s, p);
      }
      const budget = o.inlineBudgetMs ?? 2_000;
      const r = budget > 0 ? await Promise.race([p, new Promise<undefined>((res) => (setTimeout(res, budget) as { unref?: () => void }).unref?.())]) : await p;
      if (!r) {
        const near = nearestView(k, peek);
        if (near) {
          log(`read model: ${s} not stored yet, answered from ${near.from} after ${budget} ms (its read carries on)`);
          return { payload: near.read.payload as T, asOf: near.read.asOf, source: "fallback" };
        }
        const late = await p;
        return { payload: patched(k, late.value, late.at) as T, asOf: late.at, source: "inline" };
      }
      return { payload: patched(k, r.value, r.at) as T, asOf: r.at, source: "inline" };
    },
    peek,
    dirty: (dir?: string, d?: { stale?: boolean }) => {
      if (refresher) refresher.dirty(dir, d);
      else post({ type: "dirty", ...(dir ? { dir } : {}), ...(d?.stale ? { stale: true } : {}) });
    },
    dirtyAll: () => {
      if (refresher) refresher.dirtyAll();
      else post({ type: "dirtyAll" });
    },
    patch: (p: Patch) => {
      patches = addPatch(patches, p, now());
      if (refresher) refresher.dirtyAll();
      else post({ type: "dirtyAll" });
    },
    drift: () => lastDrift,
    checkDrift,
    get refresher() {
      return refresher;
    },
    close: () => {
      closed = true;
      for (const t of timers) clearInterval(t);
      for (const f of driftWaiters) f(undefined);
      driftWaiters = [];
      refresher?.stop();
      void worker?.terminate();
    },
  };
}

/**
 * the stored view that can stand in for one that has no row yet, so a request never waits on a cold read:
 * the same scope with the other includeSettled (open items are a subset of settled ones), then for a milestone the
 * world's view narrowed to that milestone. Only for waiting and status views; undefined when none is stored.
 */
export function nearestView(k: ViewKey, peek: <T>(k: ViewKey) => ViewRead<T> | undefined): { from: string; read: ViewRead<unknown> } | undefined {
  const tries: { key: ViewKey; narrow?: (p: unknown) => unknown }[] = [];
  if (k.kind === "waiting" || k.kind === "status") tries.push({ key: { ...k, includeSettled: !k.includeSettled } as ViewKey });
  if (k.kind === "waiting" && k.milestoneId) {
    const id = k.milestoneId;
    const narrow = (p: unknown) => {
      const w = p as { items: { milestoneId?: string; alsoIn?: string[]; referencedBy?: { milestoneId: string }[] }[]; scopedIds?: string[] };
      const mine = (it: (typeof w.items)[number]) => it.milestoneId === id || !!it.alsoIn?.includes(id) || !!it.referencedBy?.some((r) => r.milestoneId === id);
      return { ...w, items: w.items.filter(mine), scopedIds: [id] };
    };
    for (const includeSettled of [k.includeSettled, !k.includeSettled]) tries.push({ key: { kind: "waiting", world: k.world, includeSettled }, narrow });
  }
  for (const t of tries) {
    const hit = peek<unknown>(t.key);
    if (hit) return { from: keyOf(t.key), read: t.narrow ? { ...hit, payload: t.narrow(hit.payload) } : hit };
  }
  return undefined;
}
