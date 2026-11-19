import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { worldPriorities } from "../inbox/jordiPriority.js";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db.js";
import { createStore, UnknownTenant, type Milestone, type Store } from "../store.js";
import { askLookupIn, worldHost } from "../status/monitorAlert.js";
import { invalidateSpines, type SpinesJson, type SpinesRunner } from "../adapters/spines.js";
import { resolveRepo } from "../adapters/repos.js";
import { configureRepoScope } from "../tenancy/repoScope.js";
import { headOf } from "../adapters/gitHead.js";
import type { Tree, TreeNode } from "../adapters/tree.js";
import { createSpineReads, type SpineReads } from "../spineReads.js";
import { waitingAndDefects, type WaitingDeps } from "../inbox/waiting.js";
import { askerFor, requestReads, type Asker } from "../inbox/asker.js";
import { coverOfIn, createStatus, type StatusService } from "../status/routes.js";
import { computeAdhoc, computeStatus, computeWaiting, keyOf, parseKey, type ViewKey } from "./views.js";
import { computeReviewRows } from "../review/rows.js";
import { deleteSnapshot, ensureReadModel, listSnapshotKeys, markChecked, readPayload, writeSnapshot } from "./table.js";
import { viewDiff, type DriftDiff, type DriftResult } from "./drift.js";

/** how long a pass keeps the checkouts each view reads (a new milestone's repo is seen within this). */
export const DIRS_TTL_MS = 30_000;

/**
 * the read model's refresher. Runs off the request path (a worker thread in production, see worker.ts) and
 * keeps one console.db row per view (views.ts) current:
 *  - every tick it stamps each milestone repo (HEAD + mtime/size of the spine files its trees read; no git spawn) and
 *    fingerprints the console rows the lists read (milestones, assignments, Needs the owner rows, answers);
 *  - a repo whose stamp moved gets one spines.py run (one at a time per repo, at most `spinesConcurrency` repos at once),
 *    and only the views that read that repo wait for it: a slow repo (a social world repo) never holds the others;
 *  - views whose inputs changed are recomputed one after another and written; unchanged ones get `checked_at` = now.
 * Status views also follow runs (Working / Queued): recomputed when the database changed, at most every `statusEveryMs`,
 * and at least every `statusMaxAgeMs` (timed words like a wake due).
 */
export interface RefresherOptions {
  db: DB;
  reposRoot: string;
  /** spines.py runner (uncached: the refresher keeps the last output per repo and runs it again when the repo's stamp moves). */
  spines?: SpinesRunner;
  /** The console's own scope (CONSOLE_TENANT), used for world "". */
  tenant?: string;
  /** Worlds whose Team views are kept warm from the start ("" = unscoped: auth off or shadow). */
  worlds: string[];
  homeThread?: (assignmentId: string) => string | undefined;
  /** checkout name of the owner's team repo (its asks are labelled "Team"), as the main thread's waiting deps. */
  teamRepo?: string;
  t3State?: (runId: string) => { status: string; checkedAt: string } | undefined;
  now?: () => number;
  statusEveryMs?: number;
  statusMaxAgeMs?: number;
  /** Re-run spines.py for every repo this often, whatever the stamps say (a missed edit heals). */
  fullEveryMs?: number;
  /** A view nobody read for this long is dropped (ad hoc spine views opened once). */
  dropUnreadMs?: number;
  spinesConcurrency?: number;
  /**
   * a repo whose stamp moved is re-read (spines.py + its views) no sooner than this after its
   * last spines.py run started (default 0 = at once; the worker mounts 5 min, CONSOLE_RESCAN_GAP_MS). Its views keep the
   * last output meanwhile and other views never wait for it. A console write (`dirty(dir)`) and the full refresh re-read at once.
   */
  rescanGapMs?: number;
  /** Files changed between two commits of a checkout (default git diff); tests pass a fake. */
  changedFiles?: ChangedFiles;
  /** How long a view computation may wait for spines.py (the run itself is bounded by its own timeout). */
  softMs?: number;
  log?: (msg: string) => void;
  /** A view was written (the worker tells the main thread). */
  onWritten?: (key: string, at: string) => void;
}

interface AssignmentRow {
  id: string;
  milestone_id: string;
  persona_id: string;
  enabled: number;
  last_run_at: string | null;
}

/**
 * Each milestone's assignments in ownerFor's order (inbox/waiting.ts: enabled first, then one with a home thread, then the
 * newest run), with persona and enabled kept: what the waiting views read from the assignments, without the run times.
 */
/**
 * Paths no view reads (code, dated logs, voice note transcripts, proposal and landing pages): a commit that touches only
 * these moves HEAD but changes nothing a view shows, so it rebuilds nothing (about one commit in seven on a busy
 * repo). Anything else (spines, cards, asks, desk, docs/status screenshots, priorities, pursuits …) still rebuilds.
 */
export const UNREAD_PATHS = ["hosted/", "core/", "browser/", "video/", "docs/voice-notes/", "docs/proposals/", "docs/landing/", "docs/outcomes/2"];
export const unreadPath = (rel: string) => UNREAD_PATHS.some((p) => rel.startsWith(p));

/** Files changed between two commits (git diff --name-only); undefined when git cannot say (a rewritten history). */
export type ChangedFiles = (dir: string, from: string, to: string) => string[] | undefined;
export const gitChangedFiles: ChangedFiles = (dir, from, to) => {
  try {
    const out = execFileSync("git", ["-C", dir, "diff", "--name-only", "--no-renames", from, to], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
    return out.split("\n").filter(Boolean);
  } catch {
    return undefined;
  }
};

/** Two spines.py outputs say the same (a re-run after a commit that changed nothing they read). */
export function sameOutput(a: SpinesJson | undefined, b: SpinesJson | undefined): boolean {
  if (!a || !b) return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function ownerOrder(rows: AssignmentRow[], db?: DB): [string, string[]][] {
  let threads = new Set<string>();
  try {
    if (db) threads = new Set((db.prepare("SELECT assignment_id FROM cycle_assignment_link WHERE thread_id IS NOT NULL").all() as { assignment_id: string }[]).map((r) => r.assignment_id));
  } catch {
    /* no links table: no home threads */
  }
  const by = new Map<string, AssignmentRow[]>();
  for (const r of rows) by.set(r.milestone_id, [...(by.get(r.milestone_id) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, list]) => [
      m,
      [...list]
        .sort(
          (a, b) =>
            Number(!!b.enabled) - Number(!!a.enabled) ||
            Number(threads.has(b.id)) - Number(threads.has(a.id)) ||
            (b.last_run_at ?? "").localeCompare(a.last_run_at ?? "") ||
            a.id.localeCompare(b.id),
        )
        .map((r) => `${r.id}:${r.persona_id}:${r.enabled ? 1 : 0}`),
    ]);
}

interface DirStamp {
  head?: string;
  files: Map<string, string>;
}

const statOf = (abs: string) => {
  try {
    const st = fs.statSync(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
};

/** Repo-relative files a tree was read from (spines and tickets). */
function treeFiles(t: Tree): string[] {
  const out = new Set<string>();
  const go = (n: TreeNode) => {
    if (n.path) out.add(n.path.replace(/^\.\//, ""));
    n.children.forEach(go);
  };
  go(t.root);
  return [...out];
}

export function createRefresher(o: RefresherOptions) {
  const { db } = o;
  ensureReadModel(db);
  configureRepoScope(db, o.reposRoot); // the worker's own db hands out world milestones as the console's does
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.warn(m));
  const statusEveryMs = o.statusEveryMs ?? 30_000;
  const statusMaxAgeMs = o.statusMaxAgeMs ?? 120_000;
  // every hour (was 15 min): HEAD and the stamped spine files catch every change; this only heals a missed one.
  const fullEveryMs = o.fullEveryMs ?? 60 * 60_000;
  const dropUnreadMs = o.dropUnreadMs ?? 3 * 24 * 3600_000;
  const softMs = o.softMs ?? 120_000;
  const rescanGapMs = o.rescanGapMs ?? 0;
  const base = createStore(db, o.tenant ? { tenant: o.tenant } : {});
  const stores = new Map<string, Store>();
  const storeFor = (world: string): Store => {
    if (!world || world === base.tenant) return base;
    let s = stores.get(world);
    if (!s) stores.set(world, (s = createStore(db, { tenant: world })));
    return s;
  };
  // The last spines.py output per repo: views read it; a stamp change queues a new run (pump), which replaces it.
  const spinesOut = new Map<string, SpinesJson>();
  // views read at once for one repo share one run (they each started their own before).
  const firstRun = new Map<string, Promise<SpinesJson>>();
  const lastSpines: SpinesRunner | undefined = o.spines
    ? async (dir) => {
        const v = spinesOut.get(dir);
        if (v) return v;
        let p = firstRun.get(dir);
        if (!p) {
          p = o.spines!(dir)
            .then((fresh) => (spinesOut.set(dir, fresh), fresh))
            .finally(() => firstRun.delete(dir));
          firstRun.set(dir, p);
        }
        return p;
      }
    : undefined;
  const reads: SpineReads = createSpineReads({ db, store: base, reposRoot: o.reposRoot, spines: lastSpines });
  /** Files each repo's trees were read from, with their stamp when recorded. */
  const stamps = new Map<string, DirStamp>();
  const treeFor = async (m: Milestone): Promise<Tree> => {
    const t = await reads.treeFor(m, softMs);
    const dir = reads.locateDir(m);
    const st = dir ? stamps.get(dir) : undefined;
    if (dir && st) for (const rel of treeFiles(t)) if (!st.files.has(rel)) st.files.set(rel, statOf(path.join(dir, rel)));
    return t;
  };

  // ---------- views ----------
  const keys = new Map<string, ViewKey>();
  const dirty = new Set<string>();
  let readAt = new Map<string, string | undefined>();
  const register = (k: ViewKey) => {
    const s = keyOf(k);
    if (!keys.has(s)) {
      keys.set(s, k);
      dirty.add(s);
    }
    return s;
  };
  const defaults = () => {
    for (const w of o.worlds) {
      register({ kind: "waiting", world: w, includeSettled: false });
      register({ kind: "status", world: w, includeSettled: false });
      register({ kind: "review", world: w });
      let ms: Milestone[] = [];
      try {
        ms = storeFor(w).listMilestones({});
      } catch (e) {
        log(`read model: world ${w || "(all)"}: ${(e as Error).message}`);
      }
      for (const m of ms) {
        register({ kind: "waiting", world: w, milestoneId: m.id, includeSettled: false });
        register({ kind: "status-one", world: w, milestoneId: m.id });
      }
    }
  };
  const loadStored = () => {
    readAt = new Map();
    for (const r of listSnapshotKeys(db)) {
      const k = parseKey(r.key);
      if (!k) continue;
      readAt.set(r.key, r.readAt);
      const last = Date.parse(r.readAt ?? r.asOf);
      const kept = o.worlds.includes(k.world) && (k.kind !== "adhoc" || now() - last < dropUnreadMs);
      if (!kept && now() - last > dropUnreadMs) {
        deleteSnapshot(db, r.key);
        keys.delete(r.key);
        continue;
      }
      register(k);
    }
  };

  /** Repo dirs a view reads: its world's milestones' checkouts (references resolve across the world), or the ad hoc repo. */
  let dirsMemo = new Map<string, string[]>();
  /** each pass (every 5 s) listed every milestone of every world and resolved its repo again: kept DIRS_TTL_MS instead. */
  let dirsMemoAt = -Infinity;
  const dirsOf = (k: ViewKey): string[] => {
    const s = keyOf(k);
    if (!dirsMemo.has(s)) dirsMemo.set(s, dirsOfNow(k));
    return dirsMemo.get(s)!;
  };
  const dirsOfNow = (k: ViewKey): string[] => {
    if (k.kind === "adhoc") {
      const r = resolveRepo(o.reposRoot, k.repo);
      return r ? [r.path] : [];
    }
    let ms: Milestone[] = [];
    try {
      ms = storeFor(k.world).listMilestones({ includeSettled: true });
    } catch {
      return [];
    }
    return [...new Set(ms.flatMap((m) => resolveRepo(o.reposRoot, m.repo)?.path ?? []))];
  };

  // ---------- spines.py per repo ----------
  const ready = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const queue: string[] = [];
  const concurrency = o.spinesConcurrency ?? 2;
  /** when each repo's last spines.py run started; a moved stamp within rescanGapMs waits for `gapTimer`. */
  const lastRunAt = new Map<string, number>();
  let gapTimer: ReturnType<typeof setTimeout> | undefined;
  let gapDue = Infinity;
  const kickAt = (due: number) => {
    if (stopped || due >= gapDue) return;
    if (gapTimer) clearTimeout(gapTimer);
    gapDue = due;
    gapTimer = setTimeout(() => {
      gapTimer = undefined;
      gapDue = Infinity;
      kick();
    }, Math.max(0, due - now()));
    gapTimer.unref?.();
  };
  /** a stamp move inside the gap: true = keep the last output for now (a pass at the gap's end re-reads it). */
  const inGap = (dir: string, t: number): boolean => {
    const last = lastRunAt.get(dir);
    if (!rescanGapMs || last === undefined || !ready.has(dir) || t - last >= rescanGapMs) return false;
    kickAt(last + rescanGapMs);
    return true;
  };
  const pump = () => {
    while (running.size < concurrency && queue.length) {
      const dir = queue.shift()!;
      if (running.has(dir) || ready.has(dir)) continue;
      const t0 = now();
      lastRunAt.set(dir, t0);
      invalidateSpines(o.spines, dir); // a cached runner (in-process: the main thread's) must run again, not answer from before the change
      const before = spinesOut.get(dir);
      const p = (o.spines ? o.spines(dir).then((v) => void spinesOut.set(dir, v)) : Promise.resolve())
        .catch((e) => log(`read model: spines.py ${path.basename(dir)}: ${(e as Error).message} (last good output kept)`))
        .then(() => {
          running.delete(dir);
          ready.add(dir);
          // its views were rebuilt from the last output meanwhile (`readable`); a new output rebuilds them again, but only
          // when it says something else: the same output after a commit (most of them) rebuilt every view of every world
          // reading the repo a second time.
          const after = spinesOut.get(dir);
          if (before && after !== before && !sameOutput(before, after)) {
            reads.drop(dir);
            for (const [s, k] of keys) if (dirsOf(k).includes(dir)) dirty.add(s);
          }
          const ms = now() - t0;
          if (ms > 10_000) log(`read model: spines.py ${path.basename(dir)} took ${Math.round(ms / 1000)} s`);
          pump();
          kick();
        });
      running.set(dir, p);
    }
  };
  /** a view may be computed from this repo: read, or re-read with a last good output to answer from meanwhile. */
  const readable = (dir: string) => ready.has(dir) || spinesOut.has(dir);
  const ensureSpines = (dir: string) => {
    if (ready.has(dir) || running.has(dir) || queue.includes(dir)) return;
    queue.push(dir);
    pump();
  };
  const dropDir = (dir: string) => {
    reads.drop(dir);
    ready.delete(dir);
    stamps.set(dir, { head: headOf(dir), files: new Map() });
    for (const [s, k] of keys) if (dirsOf(k).includes(dir)) dirty.add(s);
  };

  // ---------- change detection ----------
  const fingerprint = (): string => {
    const h = createHash("sha1");
    const q = (sql: string) => {
      try {
        h.update(JSON.stringify(db.prepare(sql).all()));
      } catch {
        h.update(sql); // a table this console does not have (yet)
      }
    };
    q("SELECT * FROM milestones ORDER BY id"); // every column: priority (big_root), titles, settle, pause
    // ownerFor reads last_run_at only to break a tie between assignments (enabled, then a home thread, then the newest
    // run): the order it picks from goes in, not the time. Each wake moved last_run_at, so every wake (about 18 an hour)
    // rebuilt every view of every world; now only a wake that changes who is picked does.
    try {
      h.update(JSON.stringify(ownerOrder(db.prepare("SELECT id, milestone_id, persona_id, enabled, last_run_at FROM assignments ORDER BY id").all() as AssignmentRow[], db)));
    } catch {
      h.update("assignments");
    }
    q("SELECT id, name FROM personas ORDER BY id");
    // no needs_jordi and no jordi_responses here: asks and answers come from the spines alone (a console spine
    // write marks its checkout dirty), so the cache depends on the repo for them.
    q("SELECT assignment_id, thread_id FROM cycle_assignment_link ORDER BY assignment_id");
    return h.digest("hex");
  };
  const dataVersion = () => {
    try {
      return Number(db.pragma("data_version", { simple: true }));
    } catch {
      return 0;
    }
  };
  let lastFp: string | undefined;
  let lastDv = -1;
  let lastStatusAt = 0;
  let lastFullAt = now();

  const changedFiles = o.changedFiles ?? gitChangedFiles;
  /**
   * HEAD moved, no stamped spine file changed and the commits touched only paths no view reads: the stamp takes the new
   * HEAD and nothing is rebuilt. Anything git cannot answer counts as a change.
   */
  const onlyUnreadMoved = (dir: string): boolean => {
    const st = stamps.get(dir);
    if (!st?.head) return false;
    const h = headOf(dir);
    if (!h || h === st.head) return false;
    for (const [rel, v] of st.files) if (statOf(path.join(dir, rel)) !== v) return false;
    const files = changedFiles(dir, st.head, h);
    if (!files?.length || !files.every(unreadPath)) return false;
    st.head = h;
    skippedCommits++;
    return true;
  };
  let skippedCommits = 0;

  const stampChanged = (dir: string): boolean => {
    const st = stamps.get(dir);
    if (!st) return true;
    if (headOf(dir) !== st.head) return true;
    for (const [rel, v] of st.files) if (statOf(path.join(dir, rel)) !== v) return true;
    return false;
  };

  // ---------- compute ----------
  let passMemo = new Map<string, Promise<unknown>>();
  let askerMemo = new Map<string, Promise<Asker | undefined>>();
  /**
   * How views are computed from a set of spine reads. The refresher's own (`main`) records file stamps as trees are read;
   *'s drift check builds a second one off to the side (fresh reads, no tree memo) to rebuild a view and compare.
   */
  const computer = (treeOf: (m: Milestone) => Promise<Tree>, rd: SpineReads, memo: () => Map<string, Promise<unknown>>, clock: () => number) => {
    const waitingDeps = (world: string): WaitingDeps => ({ store: storeFor(world), reposRoot: o.reposRoot, treeFor: treeOf, ...(o.homeThread ? { homeThread: o.homeThread } : {}), ...(o.teamRepo ? { teamRepo: o.teamRepo } : {}) });
    const statusFor = (world: string): StatusService => {
      const store = storeFor(world);
      const deps = waitingDeps(world);
      return createStatus({
        db,
        store,
        milestoneInfo: (m) => rd.withOutcome(m, softMs),
        treeFor: treeOf,
        waiting: (f) => {
          const k = JSON.stringify([world, f]);
          const pm = memo();
          if (!pm.has(k)) pm.set(k, waitingAndDefects(deps, f));
          return pm.get(k) as ReturnType<typeof waitingAndDefects>;
        },
        ...(o.t3State ? { t3State: o.t3State } : {}),
        coverOf: coverOfIn(store, treeOf),
        askLookup: askLookupIn(base, treeOf, worldHost, (m) => resolveRepo(o.reposRoot, m.repo)?.name), // the ask may sit in another world
        priorities: () => worldPriorities(store, o.reposRoot), // the Team list sorts by the owner's levels first
        now: clock,
      });
    };
    return { waitingDeps, statusFor };
  };
  const main = computer(treeFor, reads, () => passMemo, now);
  const compute = async (k: ViewKey): Promise<unknown> => {
    switch (k.kind) {
      case "waiting": {
        // askers here (git blame of the ask line), once per item per pass, never on the request.
        const deps = main.waitingDeps(k.world);
        const reads = { ...deps, store: requestReads(deps.store) };
        return computeWaiting(deps, k, (it) => {
          const key = `${k.world}\0${it.id}`;
          if (!askerMemo.has(key)) askerMemo.set(key, askerFor(reads, it));
          return askerMemo.get(key)!;
        });
      }
      case "adhoc":
        return computeAdhoc(main.waitingDeps(k.world), k);
      case "status":
      case "status-one":
        return computeStatus(main.statusFor(k.world), storeFor(k.world), k);
      case "review":
        return computeReviewRows(storeFor(k.world), o.reposRoot);
    }
  };
  /** Team views first (the screen the owner lives on), then milestone pages. */
  const rank = (k: ViewKey) => (k.kind === "status" ? 0 : (k.kind === "waiting" && !k.milestoneId) || k.kind === "review" ? 1 : k.kind === "waiting" ? 2 : k.kind === "status-one" ? 3 : 4);

  let busy: Promise<void> | undefined;
  let again = false;
  let stopped = false;
  let kickTimer: ReturnType<typeof setTimeout> | undefined;
  /** Run a pass soon (spines.py for a repo finished, a dirty message). */
  const kick = () => {
    if (stopped || kickTimer) return;
    kickTimer = setTimeout(() => {
      kickTimer = undefined;
      void tick();
    }, 50);
    kickTimer.unref?.();
  };

  const pass = async () => {
    if (now() - dirsMemoAt >= DIRS_TTL_MS) {
      dirsMemo = new Map();
      dirsMemoAt = now();
    }
    defaults();
    loadStored();
    const t = now();
    // Repos: a moved stamp re-reads the repo; a full refresh re-reads all of them.
    const allDirs = new Set<string>();
    for (const k of keys.values()) for (const d of dirsOf(k)) allDirs.add(d);
    const full = t - lastFullAt >= fullEveryMs;
    if (full) lastFullAt = t;
    for (const dir of allDirs) if (full || (stampChanged(dir) && !inGap(dir, t) && !onlyUnreadMoved(dir))) dropDir(dir);
    for (const dir of allDirs) ensureSpines(dir);
    // Console rows: a changed fingerprint recomputes every view; runs alone (data_version) only the statuses.
    const fp = fingerprint();
    const dv = dataVersion();
    const statusKeys = [...keys].filter(([, k]) => k.kind === "status" || k.kind === "status-one").map(([s]) => s);
    if (fp !== lastFp) {
      lastFp = fp;
      for (const s of keys.keys()) dirty.add(s);
    }
    if ((dv !== lastDv && t - lastStatusAt >= statusEveryMs) || t - lastStatusAt >= statusMaxAgeMs) {
      lastDv = dv;
      for (const s of statusKeys) dirty.add(s);
    }
    passMemo = new Map();
    askerMemo = new Map();
    const todo = [...dirty].map((s) => [s, keys.get(s)!] as const).filter(([, k]) => !!k).sort((a, b) => rank(a[1]) - rank(b[1]));
    let statusDone = false;
    for (const [s, k] of todo) {
      if (stopped) return;
      // Waits for its repos' spines.py; others go on. The review view reads the spine files itself (review/rows.ts),
      // never spines.py, so it never waits: a busy repo re-running spines.py after each pull (13-23 s on the main server) held it back.
      // a repo re-read after a write has its last output; its
      // asks come from the file as it is now (inbox/asks.ts), so the view is rebuilt at once, not after the queued
      // spines.py run (one at a time on the main server: 60-400 s each, so an answer stayed counted for minutes). Only a repo never
      // read yet (a cold start) is waited for.
      if (k.kind !== "review" && !dirsOf(k).every(readable)) continue;
      const t0 = now();
      try {
        const payload = await compute(k);
        // A milestone that no longer exists (or a repo gone): drop its view.
        if (payload === null) deleteSnapshot(db, s);
        else {
          const at = new Date(t0).toISOString();
          writeSnapshot(db, s, payload, at, now() - t0);
          o.onWritten?.(s, at);
        }
        dirty.delete(s);
        if (k.kind === "status" || k.kind === "status-one") statusDone = true;
      } catch (e) {
        // a removed world's views (its tenant gone) are dropped, never retried every pass for the 3 unread days.
        if (e instanceof UnknownTenant) {
          deleteSnapshot(db, s);
          keys.delete(s);
          dirty.delete(s);
          log(`read model: ${s}: ${(e as Error).message}; view dropped`);
        } else log(`read model: ${s}: ${(e as Error).message}`);
      }
      await new Promise((r) => setImmediate(r)); // let messages in between views
    }
    if (statusDone) lastStatusAt = t;
    // Views whose inputs did not move are current as of this pass.
    markChecked(
      db,
      [...keys.keys()].filter((s) => !dirty.has(s)),
      new Date(t).toISOString(),
    );
  };

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (busy) {
      again = true;
      return busy;
    }
    busy = pass()
      .catch((e) => log(`read model: pass failed: ${(e as Error).stack ?? e}`))
      .finally(() => {
        busy = undefined;
        if (again) {
          again = false;
          kick();
        }
      });
    return busy;
  };

  const idle = async () => {
    for (let i = 0; i < 100; i++) {
      if (busy) await busy;
      if (running.size) await Promise.all(running.values());
      if (kickTimer) await new Promise((r) => setTimeout(r, 60));
      if (!busy && !running.size && !kickTimer) return;
    }
  };

  // ---------- drift check ----------
  /**
   * Rebuild every stored view off to the side and compare it with its row (computation times ignored). Side reads are
   * fresh (trees parsed again from the checkouts, built once per check) over the spines.py output this refresher already
   * holds: no extra spines.py run, no git spawn beyond what a normal pass does. A status view is rebuilt as of its stored
   * time (timed words). A view that differs is checked again after `confirmAfterMs` and the refresher's next pass: still
   * different = drift; matching = it was catching up (`settled`).
   */
  const sideCompute = (rd: SpineReads, k: ViewKey, asOf: number): Promise<unknown> => {
    const side = computer((m) => rd.treeFor(m, softMs), rd, () => sideMemo, () => asOf);
    switch (k.kind) {
      case "waiting":
        return computeWaiting(side.waitingDeps(k.world), k);
      case "adhoc":
        return computeAdhoc(side.waitingDeps(k.world), k);
      case "status":
      case "status-one":
        return computeStatus(side.statusFor(k.world), storeFor(k.world), k);
      case "review":
        return Promise.resolve(computeReviewRows(storeFor(k.world), o.reposRoot));
    }
  };
  let sideMemo = new Map<string, Promise<unknown>>();
  const comparable = (s: string, k: ViewKey) => !dirty.has(s) && dirsOf(k).every((d) => ready.has(d) && !stampChanged(d));
  const compareOnce = async (only?: Set<string>): Promise<{ checked: number; skipped: number; differ: DriftDiff[] }> => {
    const rd = createSpineReads({ db, store: base, reposRoot: o.reposRoot, spines: lastSpines, treeTtlMs: 3600_000 });
    let checked = 0;
    let skipped = 0;
    const differ: DriftDiff[] = [];
    dirsMemo = new Map();
    for (const [s, k] of keys) {
      if (stopped) break;
      if (only && !only.has(s)) continue;
      const row = readPayload(db, s);
      if (!row || !comparable(s, k)) {
        skipped++;
        continue;
      }
      sideMemo = new Map();
      try {
        const fresh = await sideCompute(rd, k, Date.parse(row.asOf));
        checked++;
        if (fresh === null) differ.push({ key: s, path: "(root)", stored: "(a stored view)", fresh: "(no such view: milestone or repo gone)" });
        else {
          const d = viewDiff(row.payload, fresh);
          if (d) differ.push({ key: s, ...d });
        }
      } catch (e) {
        skipped++;
        log(`read model drift check: ${s}: ${(e as Error).message}`);
      }
      await new Promise((r) => setImmediate(r));
    }
    return { checked, skipped, differ };
  };
  const driftCheck = async (d: { confirmAfterMs?: number } = {}): Promise<DriftResult> => {
    const t0 = now();
    const at = new Date(t0).toISOString();
    try {
      await tick();
      await idle();
      const first = await compareOnce();
      let differ = first.differ;
      let settled = 0;
      if (differ.length) {
        // A pass may still be on its way (a run changed a status, a pull moved a repo): give it its normal chance.
        await new Promise((r) => setTimeout(r, d.confirmAfterMs ?? statusMaxAgeMs + 30_000));
        await tick();
        await idle();
        const again = await compareOnce(new Set(differ.map((x) => x.key)));
        settled = differ.length - again.differ.length;
        differ = again.differ;
      }
      return { at, ok: differ.length === 0, checked: first.checked, skipped: first.skipped, settled, differ, ms: now() - t0 };
    } catch (e) {
      return { at, ok: false, checked: 0, skipped: 0, settled: 0, differ: [], ms: now() - t0, error: (e as Error).message };
    }
  };

  return {
    tick,
    driftCheck,
    register: (k: ViewKey) => {
      register(k);
      kick();
    },
    /**
     * A checkout changed (a console write or pull): re-read it now. Without a dir: re-check the console rows.
     * `stale` (a pull, not the console's own write): the next pass sees the moved stamp, within rescanGapMs.
     */
    dirty: (dir?: string, d?: { stale?: boolean }) => {
      if (dir && !d?.stale) dropDir(dir);
      else if (!dir) lastFp = undefined;
      kick();
    },
    /** Every view is recomputed on the next pass (the owner answered: the answered set changed). */
    dirtyAll: () => {
      for (const s of keys.keys()) dirty.add(s);
      kick();
    },
    /** How many moved HEADs rebuilt nothing (their commits touched only UNREAD_PATHS), since the start. */
    skippedCommits: () => skippedCommits,
    /** Resolves when no pass and no spines.py run is in flight (tests). */
    idle,
    keys: () => [...keys.keys()],
    stop: () => {
      stopped = true;
      if (kickTimer) clearTimeout(kickTimer);
      if (gapTimer) clearTimeout(gapTimer);
    },
  };
}

export type Refresher = ReturnType<typeof createRefresher>;
