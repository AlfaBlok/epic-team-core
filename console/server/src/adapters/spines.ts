import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { camelState, inside, readDoc, type CurrentState, type RawCurrentState } from "./doc.js";
import { listDocs, type DocItem } from "./repos.js";
import type { Dod } from "../dod.js";
import { headSha } from "../gitRefs.js";

/** EpicSpine's discovery contract: `spines.py --json --repo DIR` (epicspine-skill references/spine-model.md §Epic Log). */
export interface SpinesJson {
  root: string | null;
  nodes: SpineNode[];
  orphans: { path: string; title: string; reason: string }[];
  mismatches: { path: string; parent: string; problem: string }[];
}

export interface SpineNode {
  id: string;
  path: string;
  title: string;
  /** Deprecated (console contract): the root is the node with `parent: null`. */
  type?: string;
  parent: string | null;
  status: string;
  rollup_status: string;
  dod: { id: string; text: string; done: boolean }[];
  children: string[];
  // Doctrine-2 fields (epicspine-skill docs/doctrine/console-contract.md). Absent before the tools release.
  goal?: string | null;
  serves?: string | null;
  done_means?: { id: string; text: string; done: boolean }[];
  contributes?: Record<string, string>;
  pages?: { path: string; title: string; via: string }[];
  missing_sections?: string[];
  size?: { lines: number; long_cells: number };
  /** run contract: planning | ready | running | parked | finished, and whether a wake may work it. Absent before 2026.10.24.9. */
  run_state?: string;
  runnable?: boolean;
  has_children?: boolean;
  /** `## Current State` (console contract #latest-state): null = no section; absent before the skill release. */
  current_state?: Partial<RawCurrentState> | null;
  /** `## Outcome` (console contract #outcome): null = no section; absent before the skill release. */
  outcome?: {
    verdict?: string | null;
    sentence?: string | null;
    evidence?: { done_means?: string | null; links?: string[] | null }[] | null;
    risk?: string | null;
    closed_at?: string | null;
    closed_by?: string | null;
  } | null;
}

/** Returns the parsed `spines.py --json` output for a checkout; throws when it cannot be run or read. */
export type SpinesRunner = (repoDir: string) => Promise<SpinesJson>;

/** Checks the shape so a changed or broken script fails loudly (→ fallback) instead of rendering garbage. */
export function parseSpinesJson(text: string): SpinesJson {
  const d = JSON.parse(text);
  if (!d || typeof d !== "object" || !Array.isArray(d.nodes) || !Array.isArray(d.orphans))
    throw new Error("spines.py: unexpected JSON shape");
  for (const n of d.nodes)
    if (typeof n?.path !== "string" || !Array.isArray(n.dod) || !Array.isArray(n.children)) throw new Error("spines.py: bad node");
  for (const o of d.orphans) if (typeof o?.path !== "string") throw new Error("spines.py: bad orphan");
  return { root: d.root ?? null, nodes: d.nodes, orphans: d.orphans, mismatches: Array.isArray(d.mismatches) ? d.mismatches : [] };
}

/**
 * Skill dir, first that has scripts/spines.py (symlinks followed): `EPICSPINE_SKILL_DIR` if set (only that), else
 * ~/.claude/skills/epic-spine (where the SessionStart hook syncs it), else ~/.agents/skills/epic-spine.
 * Undefined = not installed (the picker falls back to path rules).
 */
export function resolveSkillDir(env: NodeJS.ProcessEnv, home = os.homedir()): string | undefined {
  const cands = env.EPICSPINE_SKILL_DIR
    ? [env.EPICSPINE_SKILL_DIR]
    : [path.join(home, ".claude/skills/epic-spine"), path.join(home, ".agents/skills/epic-spine")];
  for (const c of cands) {
    try {
      const dir = fs.realpathSync(c);
      if (fs.statSync(path.join(dir, "scripts", "spines.py")).isFile()) return dir;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/**
 * Default spines.py timeout. Requests never wait this long (softSpines answers from the last good output after a few
 * seconds); it bounds the background run that fills the cache, which takes ~22 s cold on a loaded the main server.
 */
/**
 * 180 s (was 90 s). a social world repo's run also reads the repos its asks name (the code repo among them) and took ~100 s
 * on the main server: every run was killed at 90 s and retried each pass (136 times in 36 h), holding the one scan slot for nothing
 * while the social product's rows stayed as they were. CONSOLE_SPINES_TIMEOUT_MS overrides.
 */
export const SPINES_TIMEOUT_MS = Number(process.env.CONSOLE_SPINES_TIMEOUT_MS) > 0 ? Number(process.env.CONSOLE_SPINES_TIMEOUT_MS) : 180_000;

/** Runs at most `max` jobs at once, the rest wait in order (FIFO). A finished job hands its slot to the next waiter. */
export type Limiter = <T>(job: () => Promise<T>) => Promise<T>;
export function limiter(max: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (job) => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next(); // the slot passes straight on: no new caller can slip in between
      else active--;
    }
  };
}

/**
 * one spines.py scan at a time across the whole console (every repo, every runner). Up to 7 ran at once on
 * the main server, each ~5-22 s of CPU in the 1.5-core user slice (DOD-1). Requests do not wait on it: the
 * caches answer from the last good output. CONSOLE_SPINES_CONCURRENCY raises it.
 */
export const spinesSlot: Limiter = limiter(Math.max(1, Number(process.env.CONSOLE_SPINES_CONCURRENCY) || 1));

/**
 * Runs `python3 <skillDir>/scripts/spines.py --json --repo <dir>` with a timeout (default SPINES_TIMEOUT_MS), one
 * at a time through `limit` (default spinesSlot, shared); the timeout starts when the scan does.
 */
export function spinesPyRunner(skillDir: string, opts: { python?: string; timeoutMs?: number; limit?: Limiter } = {}): SpinesRunner {
  const script = path.join(skillDir, "scripts", "spines.py");
  const timeout = opts.timeoutMs ?? SPINES_TIMEOUT_MS;
  const limit = opts.limit ?? spinesSlot;
  // an unchanged output answers with the same object, so trees memoized on it (treeMemo) stay valid across runs.
  const last = new Map<string, { stdout: string; value: SpinesJson }>();
  return (repoDir) =>
    limit(() => new Promise<SpinesJson>((resolve, reject) => {
      execFile(
        opts.python ?? "python3",
        [script, "--json", "--repo", repoDir],
        { timeout, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(err.killed ? new Error(`spines.py: timed out after ${timeout} ms`) : err);
          try {
            const prev = last.get(repoDir);
            if (prev && prev.stdout === stdout) return resolve(prev.value);
            const value = parseSpinesJson(stdout);
            last.set(repoDir, { stdout, value });
            resolve(value);
          } catch (e) {
            reject(e);
          }
        },
      );
    }));
}

export type SpinesLog = (msg: string) => void;
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

/**
 * what spines.py reads from a checkout, as one cheap key with no git child: HEAD (from
 * `.git`), the `.git/index` mtime (a commit, checkout or add) and the mtime + size of every spine, page and orphan file
 * the last output listed, plus their folders (a new file there). Undefined when HEAD cannot be read from the files (a
 * worktree, a fixture dir): the cache then re-runs on its TTL as before.
 */
export function checkoutVersion(repoDir: string, last?: SpinesJson): string | undefined {
  const sha = headSha(repoDir);
  if (!sha) return undefined;
  const stat = (p: string) => {
    try {
      const st = fs.statSync(p);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "-";
    }
  };
  const files = new Set<string>();
  for (const n of last?.nodes ?? []) {
    files.add(n.path);
    for (const pg of n.pages ?? []) files.add(pg.path);
  }
  for (const o of last?.orphans ?? []) files.add(o.path);
  const dirs = new Set([".", "docs", ...[...files].map((f) => path.dirname(f))]);
  const parts = [sha, stat(path.join(repoDir, ".git", "index"))];
  for (const f of [...[...dirs].sort(), ...[...files].sort()]) parts.push(`${f}=${stat(path.resolve(repoDir, f))}`);
  return parts.join("|");
}

/** a repo whose key did not move is still scanned again after this long (a change the key cannot see). */
export const SPINES_MAX_AGE_MS = 30 * 60_000;

/**
 * a changed repo is scanned again at most this often. the code repo takes
 * a commit every 1-5 min on the main server and each cost a spines.py run of 11-24 s (console 0.43 core over 30 min after).
 * The console's own spine write still scans at once. CONSOLE_RESCAN_GAP_MS overrides (0 = off = the behaviour).
 */
export const SPINES_RESCAN_GAP_MS = 5 * 60_000;
export const rescanGapMs = (env: Record<string, string | undefined> = process.env): number => {
  const v = env.CONSOLE_RESCAN_GAP_MS;
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : SPINES_RESCAN_GAP_MS;
};

/**
 * Per-repo stale-while-revalidate cache (default 60 s; was 30 s) in front of a runner. A fresh hit answers at once; a stale hit
 * answers with the last good output and starts one background refresh; only a repo never read waits for the run.
 * a stale hit re-runs only when the checkout's key (`version`, default checkoutVersion) moved since the run that
 * produced the output, or that run is older than `maxAgeMs` (default 30 min); otherwise the output stays current for
 * another TTL. On the main server the TTL re-runs were most of the console's own CPU (0.6-0.7 core, the infra repo DOD-1 11-03).
 * `minGapMs` (default 0 = off; the console mounts SPINES_RESCAN_GAP_MS): a re-run that is not urgent (a stale hit
 * whose key moved, a pull, the read model seeing a change) starts no sooner than `minGapMs` after the repo's last run
 * started; callers meanwhile get the last good output, and every ask in the gap shares that one deferred run. Urgent runs
 * start at once (and start a deferred one now): the console's own write (`invalidate` without `stale`) and a repo never read.
 * A failed run is never cached as "no spines": the last good output is kept (retried after the TTL) and the failure
 * is logged with its reason; with no good output yet the call rejects and the next call runs again.
 */
export function cachedRunner(
  run: SpinesRunner,
  ttlMs = 60_000,
  now = () => Date.now(),
  log: SpinesLog = (m) => console.warn(m),
  opts: {
    version?: (repoDir: string, last?: SpinesJson) => string | undefined;
    maxAgeMs?: number;
    minGapMs?: number;
    /**
     * the output a repo had before this start (the indexer's spines_cache): taken as this cache's last good output,
     * with the checkout key it was read at, so a restart re-runs spines.py only for a checkout that moved since.
     */
    seed?: (repoDir: string) => { value: SpinesJson; ver?: string; from: number } | undefined;
    /**
     * a seeded repo whose checkout moved within `minGapMs` of its last run (before the restart) answers `since`
     * with the seeded output at once and re-reads at the gap's end; this is called when that run is done (the indexer
     * tells its read model to take the new output).
     */
    onSeedRefreshed?: (repoDir: string) => void;
  } = {},
): InvalidatableRunner {
  const version = opts.version ?? checkoutVersion;
  const maxAgeMs = opts.maxAgeMs ?? SPINES_MAX_AGE_MS;
  const minGapMs = opts.minGapMs ?? 0;
  /** `from`: when the run that produced `value` started (`since`); `ver`/`ranAt`: the key at that start and when it ran. */
  const good = new Map<string, { at: number; value: SpinesJson; dirty?: boolean; from?: number; ver?: string; ranAt?: number; seed?: boolean }>();
  const pending = new Map<string, Promise<SpinesJson>>();
  /** bumped by invalidate; a run that started before the bump does not count as fresh. */
  const gen = new Map<string, number>();
  const fresh = new Map<string, Promise<SpinesJson>>();
  const startedAt = new Map<string, number>();
  /** the key of the run in flight (set when it starts), when the repo's last run started (`now` clock), and the start of a deferred run. */
  const pendingVer = new Map<string, string | undefined>();
  const lastStart = new Map<string, number>();
  const deferred = new Map<string, () => void>();
  const seeded = new Set<string>();
  /**
   * the seed of a repo, once, before its first read (ranAt = now: the max-age re-run comes a full period later).
   * the seed's run start counts as the repo's last run, so the rescan gap holds across a restart (a restart no
   * longer re-reads every moved repo at once).
   */
  const seedOf = (repoDir: string) => {
    if (!opts.seed || seeded.has(repoDir) || good.has(repoDir)) return;
    seeded.add(repoDir);
    const s = opts.seed(repoDir);
    if (!s) return;
    good.set(repoDir, { at: now(), value: s.value, from: s.from, ...(s.ver !== undefined ? { ver: s.ver } : {}), ranAt: now(), seed: true });
    if (!lastStart.has(repoDir)) lastStart.set(repoDir, Math.min(s.from, now()));
  };
  const told = new WeakSet<Promise<SpinesJson>>();
  const refresh = (repoDir: string, urgent = false): Promise<SpinesJson> => {
    let p = pending.get(repoDir);
    if (p) {
      if (urgent) deferred.get(repoDir)?.(); // a deferred run starts now (after the caller's gen bump, so it counts as fresh)
      return p;
    }
    const last = lastStart.get(repoDir);
    const wait = urgent || !good.has(repoDir) || last === undefined ? 0 : last + minGapMs - now();
    if (wait > 0) {
      p = new Promise<SpinesJson>((resolve) => {
        const go = () => {
          clearTimeout(timer);
          deferred.delete(repoDir);
          resolve(launch(repoDir));
        };
        const timer = setTimeout(go, wait);
        timer.unref?.();
        deferred.set(repoDir, go);
      });
      startedAt.set(repoDir, Date.now() + wait); // since(t): a run that starts after t, shared by every ask in the gap
      pendingVer.delete(repoDir);
    } else p = launch(repoDir);
    p = p.finally(() => {
      pending.delete(repoDir);
      pendingVer.delete(repoDir);
    });
    p.catch(() => {});
    pending.set(repoDir, p);
    return p;
  };
  const launch = (repoDir: string): Promise<SpinesJson> => {
    const g = gen.get(repoDir) ?? 0;
    const from = Date.now();
    const ranAt = now();
    // The key before the run: a change during the run moves it again, so the next stale hit scans once more.
    const ver = version(repoDir, good.get(repoDir)?.value);
    startedAt.set(repoDir, from);
    lastStart.set(repoDir, ranAt);
    pendingVer.set(repoDir, ver);
    return run(repoDir)
      .then((out) => {
        // the same output as before keeps the same object, so the trees built from it stay memoized (a
        // re-run every TTL and the read model's runs no longer make the next read rebuild every tree of the world).
        const prev = good.get(repoDir)?.value;
        const value = prev && JSON.stringify(prev) === JSON.stringify(out) ? prev : out;
        good.set(repoDir, { at: now(), value, dirty: g !== (gen.get(repoDir) ?? 0), from, ver, ranAt });
        return value;
      })
      .catch((e) => {
        const prev = good.get(repoDir);
        log(`spines.py failed for ${repoDir}: ${reason(e)}${prev ? " (keeping last good output)" : ""}`);
        if (!prev) throw e;
        good.set(repoDir, { at: now(), value: prev.value, from: prev.from }); // back off one TTL before retrying
        return prev.value;
      });
  };
  const cached = (async (repoDir: string) => {
    seedOf(repoDir);
    const hit = good.get(repoDir);
    if (!hit) return refresh(repoDir);
    if (hit.dirty) return fresh.get(repoDir) ?? refresh(repoDir, true); // invalidated: wait for the run after the change
    if (now() - hit.at >= ttlMs) {
      const same = hit.ver !== undefined && now() - (hit.ranAt ?? 0) < maxAgeMs && version(repoDir, hit.value) === hit.ver;
      if (same) hit.at = now(); // nothing spines.py reads moved: current for another TTL, no scan
      else void refresh(repoDir).catch(() => {}); // no sooner than minGapMs after the last run
    }
    return hit.value;
  }) as InvalidatableRunner;
  /**
   * The checkout changed (pull): the next read waits for a run that starts after now (last good output on failure).
   * `stale` (a pull, not the console's own write): reads keep the last good output at once while that run goes;
   * its output replaces it when done. A read that has no output yet still waits.
   */
  cached.invalidate = (repoDir: string, o?: { stale?: boolean }) => {
    seedOf(repoDir);
    const urgent = !o?.stale || !good.has(repoDir);
    if (urgent) {
      gen.set(repoDir, (gen.get(repoDir) ?? 0) + 1);
      const hit = good.get(repoDir);
      if (hit) hit.dirty = true;
    }
    const before = pending.get(repoDir);
    // a deferred run has not started: started now (urgent) or left to its time (a pull), it already sees this change.
    if (before && deferred.has(repoDir)) {
      if (urgent) deferred.get(repoDir)!();
      fresh.set(repoDir, before);
      void before.finally(() => fresh.get(repoDir) === before && fresh.delete(repoDir)).catch(() => {});
      return;
    }
    const next: Promise<SpinesJson> = (before ? before.catch(() => undefined) : Promise.resolve(undefined))
      .then(() => refresh(repoDir, urgent))
      .finally(() => {
        if (fresh.get(repoDir) === next) fresh.delete(repoDir);
      });
    next.catch(() => {});
    fresh.set(repoDir, next);
  };
  /**
   * the output of a run that started at or after `t` (Date.now clock): the read-model worker saw the checkout
   * change at `t`. Answers from the last output when its run started late enough, shares a run in flight that did, else
   * queues one right after it, so the worker and the requests never run spines.py for one repo twice at once. The cache
   * is not marked dirty (requests keep the last good output meanwhile) but the new output replaces it.
   */
  cached.since = (repoDir: string, t: number) => {
    seedOf(repoDir);
    const p = pending.get(repoDir);
    // right after a restart, a seeded repo that moved within the gap keeps its seeded output for now (the
    // read model does not hold a slot for minutes) and re-reads at the gap's end; onSeedRefreshed reports that run.
    const seededHit = good.get(repoDir);
    if (seededHit?.seed && !seededHit.dirty && minGapMs > 0) {
      const moved = seededHit.ver === undefined || version(repoDir, seededHit.value) !== seededHit.ver;
      const waits = p ? deferred.has(repoDir) : (lastStart.get(repoDir) ?? -Infinity) + minGapMs > now();
      if (moved && waits) {
        const r = p ?? refresh(repoDir);
        if (!told.has(r)) {
          told.add(r);
          r.then(() => opts.onSeedRefreshed?.(repoDir), () => undefined);
        }
        return Promise.resolve(seededHit.value);
      }
    }
    if (p && (startedAt.get(repoDir) ?? 0) >= t) return p;
    const hit = good.get(repoDir);
    if (!p && hit && !hit.dirty && (hit.from ?? 0) >= t) return Promise.resolve(hit.value); // a start's prewarm, already done
    // the checkout's key is the one a run saw at its start: that run already reads the change (the console's own
    // write, a pull: the worker asks a moment after the main thread queued it; before, a second run followed it).
    const v = version(repoDir, hit?.value);
    if (v !== undefined) {
      if (p && pendingVer.get(repoDir) === v) return p;
      if (!p && hit && !hit.dirty && hit.ver === v && now() - (hit.ranAt ?? 0) < maxAgeMs) return Promise.resolve(hit.value);
    }
    return (p ? p.catch(() => undefined) : Promise.resolve(undefined)).then(() => refresh(repoDir));
  };
  /** the run queued by the last invalidate (pull or write) of repoDir while it is still going, else undefined. */
  cached.settled = (repoDir: string) => fresh.get(repoDir);
  return cached;
}

/** A runner whose per-repo cache can be dropped after the checkout changed. */
export type InvalidatableRunner = SpinesRunner & {
  invalidate: (repoDir: string, o?: { stale?: boolean }) => void;
  since?: (repoDir: string, t: number) => Promise<SpinesJson>;
  settled?: (repoDir: string) => Promise<SpinesJson> | undefined;
};

/** resolves once the run queued by the last invalidate of repoDir is done (at once when none is going). */
export const spinesSettled = async (run: SpinesRunner | undefined, repoDir: string): Promise<void> => {
  await (run as Partial<InvalidatableRunner> | undefined)?.settled?.(repoDir)?.catch(() => undefined);
};

/** a run that started at or after `t` when `run` can tell (cachedRunner), else a plain run. */
export const spinesSince = (run: SpinesRunner, repoDir: string, t: number): Promise<SpinesJson> => {
  const since = (run as Partial<InvalidatableRunner>).since;
  return t > 0 && since ? since(repoDir, t) : run(repoDir);
};

/** Drop the cache of `run` for repoDir when it has one (cachedRunner); a plain runner has nothing to drop. */
export const invalidateSpines = (run: SpinesRunner | undefined, repoDir: string, o?: { stale?: boolean }) =>
  (run as Partial<InvalidatableRunner> | undefined)?.invalidate?.(repoDir, o);

/**
 * prewarm: runs spines.py once per repo, one after another (the host is loaded; never in parallel), so the
 * first request after a start finds a cached result. Never throws; failures are logged.
 */
export async function prewarmSpines(run: SpinesRunner, repoDirs: string[], log: SpinesLog = (m) => console.warn(m)): Promise<void> {
  for (const dir of [...new Set(repoDirs)]) {
    try {
      await run(dir);
    } catch (e) {
      log(`spines.py prewarm failed for ${dir}: ${reason(e)}`);
    }
  }
}

/** Local DoD counts for a file spines.py lists without DoD (orphans). */
function localDod(repoDir: string, rel: string): { done: number; total: number } {
  const abs = inside(repoDir, rel);
  const info = abs ? readDoc(abs) : undefined;
  return info ? { done: info.dod.done, total: info.dod.total } : { done: 0, total: 0 };
}

/**
 * Picker list from `spines.py --json`: tree nodes (depth-first, with depth + parent), then orphans (flagged with
 * the reason), then ticket files (tickets/, docs/tickets/), which spines.py does not cover. Paths already listed
 * as a node or orphan are not repeated as tickets.
 */
export function docsFromSpines(repoDir: string, s: SpinesJson, tickets: DocItem[]): DocItem[] {
  const depth = new Map<string, number>();
  const out: DocItem[] = [];
  for (const n of s.nodes) {
    const d = n.parent && depth.has(n.parent) ? depth.get(n.parent)! + 1 : 0;
    depth.set(n.path, d);
    out.push({
      path: n.path,
      kind: "spine",
      title: n.title || path.basename(n.path, ".md"),
      ...(n.status ? { status: n.status } : {}),
      ...(n.rollup_status && n.rollup_status !== n.status ? { rollupStatus: n.rollup_status } : {}),
      dod: { done: n.dod.filter((i) => i.done).length, total: n.dod.length },
      via: "spines",
      depth: d,
      parent: n.parent,
      ...(n.type ? { type: n.type } : {}),
    });
  }
  for (const o of s.orphans)
    out.push({
      path: o.path,
      kind: "spine",
      title: o.title || path.basename(o.path, ".md"),
      dod: localDod(repoDir, o.path),
      via: "spines",
      orphan: o.reason || "orphan",
    });
  const seen = new Set(out.map((d) => d.path));
  for (const t of tickets) if (t.kind === "ticket" && !seen.has(t.path)) out.push({ ...t, via: "spines" });
  return out;
}

/** Picker list for a checkout: spines.py when it works, else listDocs path rules marked `via: "fallback"`. */
export async function pickerDocs(repoDir: string, run?: SpinesRunner): Promise<DocItem[]> {
  const local = listDocs(repoDir);
  if (run) {
    try {
      return docsFromSpines(repoDir, await run(repoDir), local);
    } catch {
      /* fall through */
    }
  }
  return local.map((d) => ({ ...d, via: "fallback" as const }));
}

// ---------- Doctrine-2 Overview fields (console contract) ----------

/** Milestone `doctrine` object: every field optional; absent = not provided (yet) by spines.py. */
export interface Doctrine {
  goal?: string;
  serves?: string;
  /** Ancestors from the parent up to the root, each with its own `serves` (absent on the root). */
  servesChain?: { path: string; title: string; serves?: string }[];
  children?: { path: string; title: string; status?: string; contributes?: string }[];
  doneMeans?: { id: string; text: string; done: boolean }[];
  pages?: { path: string; title: string; via: string }[];
  missingSections?: string[];
  size?: { lines: number; long_cells: number };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");

/** Maps the node at `docPath` to the Overview fields; undefined when the node is absent or carries nothing. */
export function doctrineFor(s: SpinesJson, docPath: string): Doctrine | undefined {
  const byPath = new Map(s.nodes.map((n) => [norm(n.path), n]));
  const node = byPath.get(norm(docPath));
  if (!node) return undefined;
  const d: Doctrine = {};
  if (str(node.goal)) d.goal = node.goal!;
  if (str(node.serves)) d.serves = node.serves!;
  // Serves chain: walk `parent` to the root (parent: null), guarding against cycles and dangling parents.
  const chain: NonNullable<Doctrine["servesChain"]> = [];
  const seen = new Set([norm(node.path)]);
  for (let p = node.parent; p && !seen.has(norm(p)); ) {
    seen.add(norm(p));
    const a = byPath.get(norm(p));
    if (!a) break;
    chain.push({ path: a.path, title: a.title || path.basename(a.path, ".md"), ...(str(a.serves) ? { serves: a.serves! } : {}) });
    p = a.parent;
  }
  if (chain.length) d.servesChain = chain;
  const contributes = node.contributes && typeof node.contributes === "object" ? node.contributes : {};
  const sentence = (p: string) => str(contributes[p]) ?? str(Object.entries(contributes).find(([k]) => norm(k) === norm(p))?.[1]);
  const children = node.children.map((p) => {
    const c = byPath.get(norm(p));
    const status = str(c?.status);
    const contrib = sentence(p);
    return { path: p, title: c?.title || path.basename(p, ".md"), ...(status ? { status } : {}), ...(contrib ? { contributes: contrib } : {}) };
  });
  if (children.length) d.children = children;
  if (Array.isArray(node.done_means)) d.doneMeans = node.done_means.filter((i) => i && typeof i.text === "string");
  if (Array.isArray(node.pages)) d.pages = node.pages.filter((pg) => pg && typeof pg.path === "string");
  if (Array.isArray(node.missing_sections)) d.missingSections = node.missing_sections.filter((x) => typeof x === "string");
  if (node.size && typeof node.size === "object") d.size = node.size;
  return Object.keys(d).length ? d : undefined;
}

/**
 * Milestone `dod` from the spines.py node (console contract): `done_means`, else `dod`; undefined when the node is
 * absent or has neither, so the caller keeps the markdown parse. When the markdown parse read the same number of
 * items it is the same list read locally, so it stands: old spines keep today's `tracked` (plain-list criteria stay
 * untracked) and item text/ids.
 */
export function dodFor(s: SpinesJson, docPath: string, local: Dod): Dod | undefined {
  const node = s.nodes.find((n) => norm(n.path) === norm(docPath));
  if (!node) return undefined;
  const valid = (l: unknown) => (Array.isArray(l) ? l.filter((i) => i && typeof i.text === "string") : []);
  const dm = valid(node.done_means);
  const list: { id: string; text: string; done: boolean }[] = dm.length ? dm : valid(node.dod);
  if (!list.length) return undefined;
  if (local.items.length === list.length) return local;
  const items = list.map((i) => ({ text: i.text, checked: !!i.done, ...(str(i.id) ? { id: i.id } : {}) }));
  return { done: items.filter((i) => i.checked).length, total: items.length, items, tracked: true };
}

/** The spines.py node's title (Doctrine-2 `# EPIC-n: …`), when the node is listed and has one. */
export function docTitleFor(s: SpinesJson, docPath: string): string | undefined {
  return str(s.nodes.find((n) => norm(n.path) === norm(docPath))?.title)?.trim();
}

/** Milestone `outcome` (camelCase of the node's `outcome`); unwritten fields are null, evidence [] when none. */
export interface Outcome {
  verdict: string | null;
  sentence: string | null;
  evidence: { doneMeans: string; links: string[] }[];
  risk: string | null;
  closedAt: string | null;
  closedBy: string | null;
}

/** The node's `## Outcome`, or null when the node is absent, has no section, or the field is not shipped yet. */
export function outcomeFor(s: SpinesJson, docPath: string): Outcome | null {
  const o = s.nodes.find((n) => norm(n.path) === norm(docPath))?.outcome;
  if (!o || typeof o !== "object") return null;
  const n = (v: unknown) => str(v) ?? null;
  return {
    verdict: n(o.verdict),
    sentence: n(o.sentence),
    evidence: (Array.isArray(o.evidence) ? o.evidence : [])
      .filter((e) => e && typeof e === "object")
      .map((e) => ({ doneMeans: str(e.done_means) ?? "", links: (Array.isArray(e.links) ? e.links : []).filter((l): l is string => !!str(l)) })),
    risk: n(o.risk),
    closedAt: n(o.closed_at),
    closedBy: n(o.closed_by),
  };
}

/**
 * The node's `current_state`: undefined when spines.py does not emit the field (pre-release) or the node is absent,
 * so the caller falls back to its own parse; null when the spine has no `## Current State`.
 */
export function currentStateFor(s: SpinesJson, docPath: string): CurrentState | null | undefined {
  const node = s.nodes.find((n) => norm(n.path) === norm(docPath));
  if (!node || !("current_state" in node) || node.current_state === undefined) return undefined;
  const c = node.current_state;
  return c && typeof c === "object" ? camelState(c, "spines") : null;
}

/**
 * spines.py output for a repo without waiting longer than `softMs` on a cache miss: answers from the last good
 * output for that repo (or undefined) while the run keeps filling the cache. Never throws.
 */
export function softSpines(run: SpinesRunner) {
  const lastGood = new Map<string, SpinesJson>();
  // a read that ran out of time with no good output yet (a cold console: spines.py ~22 s after a restart)
  // answers undefined like a failure would, but it is "not read yet", not "no spines": the status reads it as loading.
  const missedAt = new Map<string, number>();
  let seq = 0;
  const soft = async (repoDir: string, softMs = 4_000): Promise<SpinesJson | undefined> => {
    try {
      const p = run(repoDir).then((v) => (lastGood.set(repoDir, v), v));
      p.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), softMs);
      });
      const out = await Promise.race([p, late]).finally(() => clearTimeout(timer));
      if (!out && !lastGood.has(repoDir)) missedAt.set(repoDir, ++seq);
      return out ?? lastGood.get(repoDir);
    } catch {
      return lastGood.get(repoDir);
    }
  };
  return Object.assign(soft, {
    /** A mark to pass to `missedSince` (taken before a request reads anything). */
    mark: () => seq,
    /** Some read of repoDir since `mark` ran out of time with no good output: what was built from it is not data. */
    missedSince: (repoDir: string, mark: number) => (missedAt.get(repoDir) ?? 0) > mark,
  });
}

/** Doctrine lookup for the milestone request: never throws, never waits longer than `softMs` (see softSpines). */
export function doctrineLookup(run: SpinesRunner, softMs = 4_000, soft = softSpines(run)) {
  return async (repoDir: string, docPath: string): Promise<Doctrine | undefined> => {
    const s = await soft(repoDir, softMs);
    return s ? doctrineFor(s, docPath) : undefined;
  };
}

/** `CONSOLE_SPINES_FIXTURE=<file>` (test/preview only): a runner that returns that file for every repo. */
export function fixtureRunner(file: string): SpinesRunner {
  return async () => parseSpinesJson(fs.readFileSync(file, "utf8"));
}

/**
 * Spines page: per-repo stale-while-revalidate view of spines.py. A hit is answered at once (a stale one also
 * starts one background refresh); only a repo never read waits for the run. Failures are not cached.
 */
export function spinesIndex(run: SpinesRunner, ttlMs = 60_000, now = () => Date.now()) {
  const cache = new Map<string, { at: number; value: SpinesJson }>();
  const pending = new Map<string, Promise<SpinesJson>>();
  const refresh = (dir: string) => {
    let p = pending.get(dir);
    if (!p) {
      p = run(dir)
        .then((value) => (cache.set(dir, { at: now(), value }), value))
        .finally(() => pending.delete(dir));
      p.catch(() => {});
      pending.set(dir, p);
    }
    return p;
  };
  return async (dir: string): Promise<{ value: SpinesJson; at: number; refreshing: boolean }> => {
    const hit = cache.get(dir);
    if (!hit) {
      const value = await refresh(dir);
      return { value, at: cache.get(dir)?.at ?? now(), refreshing: false };
    }
    if (now() - hit.at >= ttlMs) refresh(dir);
    return { ...hit, refreshing: pending.has(dir) };
  };
}
