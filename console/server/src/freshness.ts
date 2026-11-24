import { execFile } from "./spawnHost.js";
import { headSha, upstreamSha } from "./gitRefs.js";
import fs from "node:fs";
import path from "node:path";
import { createRepoPuller } from "./cycle/repoPull.js";
import type { LockHealer } from "./gitStaleLock.js";

/**
 * source freshness. The console reads the checkouts on this host; they move by (a) the EpicSpine 15-min sync,
 * (b) the run-end pull, and here (c) a pull when a milestone page is opened and its repo's last pull is older
 * than 60 s (the console mounts 5 min), (d) a `git ls-remote` poll of every repo with an unsettled milestone (
 * every 5 min, was 20 s), (e) the Refresh button.
 * Every pull is `git pull -q --ff-only` (one in flight per repo, never forced: a dirty or diverged tree is left alone
 * and reported), and the spines.py cache of the repo is dropped when HEAD moved.
 */
export type GitOut = (repoDir: string, args: string[]) => Promise<string>;

export const gitOut =
  (timeoutMs = 30_000): GitOut =>
  (repoDir, args) =>
    new Promise((resolve, reject) => {
      execFile("git", ["-C", repoDir, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        // git's last line is often just "Aborting": the first error:/fatal: line says why.
        const lines = String(stderr || "").trim().split("\n").filter(Boolean);
        const why = lines.find((l) => /^(error|fatal):/.test(l)) || lines.pop() || (err.killed ? `timed out after ${timeoutMs} ms` : err.message);
        reject(new Error(why));
      });
    });

/**
 * `git log` read through a memo of (checkout, HEAD, arguments): its answer only changes when HEAD moves, yet the objectives'
 * last moves (every scorecards build, every 20 s) and the claims' last commits (every lease check) ran one git spawn per
 * objective and per claim each time, forking the console's whole process: 2.5 s of a 90 s live profile on the main server.
 * Only `log` with no relative date is kept; anything else, or a checkout whose HEAD cannot be read, goes straight to git.
 *
 * A HEAD move no longer drops them all. One `git log --name-only` of the commits since the kept HEAD (per
 * checkout, shared by every kept answer) says which files moved; a log of named paths (`-- docs/spines/x.md`) that none
 * of those commits touched is the same answer and moves forward to the new HEAD. The main server commits every few
 * minutes, and each commit used to re-run every objective's and claim's log; now only the ones whose spine it touched.
 * A rewritten history (a commit left behind), a log with a revision, a glob or no paths is asked again.
 */
export function headKeptLog(git: GitOut, o: { head?: (dir: string) => string | undefined; max?: number } = {}): GitOut {
  const head = o.head ?? headSha;
  const max = o.max ?? 2_000;
  type Kept = { p: Promise<string>; paths?: string[] };
  const byDir = new Map<string, { head: string; kept: Map<string, Kept>; moving?: Promise<void> }>();
  /** the paths a log names when its answer depends on them alone (no revision, no glob, from the checkout's top). */
  const pathsOf = (dir: string, args: string[]): string[] | undefined => {
    const at = args.indexOf("--");
    if (at < 0 || at === args.length - 1) return undefined;
    if (args.slice(1, at).some((a) => (!a.startsWith("-") && !/^\d+$/.test(a)) || /^--(all|branches|tags|remotes|glob|follow)\b/.test(a))) return undefined;
    const paths = args.slice(at + 1);
    if (paths.some((p) => !p || /[*?[\]:]/.test(p[0]) || /[*?[]/.test(p) || p.startsWith("/") || p.split("/").includes(".."))) return undefined;
    return fs.existsSync(path.join(dir, ".git")) ? paths.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, "")) : undefined;
  };
  const moveForward = (dir: string, st: { head: string; kept: Map<string, Kept> }, to: string): Promise<void> => {
    const from = st.head;
    const forward = [...st.kept.values()].some((k) => k.paths);
    const drop = () => {
      st.kept.clear();
      st.head = to;
    };
    if (!forward) return Promise.resolve(drop());
    return git(dir, ["log", "--left-right", "--format=%x01%m", "--name-only", `${from}...${to}`]).then(
      (out) => {
        const touched = new Set<string>();
        let side = "";
        for (const line of out.split("\n")) {
          if (line.startsWith("\x01")) side = line.slice(1).trim();
          else if (line && side) {
            if (side === "<") return drop(); // a commit HEAD left behind: history was rewritten
            touched.add(line);
          }
        }
        for (const [key, k] of st.kept) {
          const hit = !k.paths || [...touched].some((f) => k.paths!.some((p) => f === p || f.startsWith(`${p}/`) || p === "."));
          if (hit) st.kept.delete(key);
        }
        st.head = to;
      },
      () => drop(),
    );
  };
  return async (dir, args) => {
    const sha = args[0] === "log" && !args.some((a) => /^--(since|until|after|before)=.*(ago|now|today|yesterday)/i.test(a)) ? head(dir) : undefined;
    if (!sha) return git(dir, args);
    let st = byDir.get(dir);
    if (!st) byDir.set(dir, (st = { head: sha, kept: new Map() }));
    if (st.head !== sha) {
      const s = st;
      s.moving ??= moveForward(dir, s, sha).finally(() => (s.moving = undefined));
      await s.moving;
      if (s.head !== sha) return git(dir, args); // moved again meanwhile: answer fresh, the next call catches up
    }
    const key = args.join("\0");
    let k = st.kept.get(key);
    if (!k) {
      const kk: Kept = { p: git(dir, args), paths: pathsOf(dir, args) };
      k = kk;
      const s = st;
      kk.p.catch(() => s.kept.get(key) === kk && s.kept.delete(key));
      st.kept.set(key, kk);
      if (st.kept.size > max) st.kept.delete(st.kept.keys().next().value!);
    }
    return k.p;
  };
}

export interface RepoFreshness {
  repo: string;
  /** Checkout HEAD (full sha; the web shows 7). */
  sha?: string;
  /** Last time this checkout heard from GitHub: newest of `.git/FETCH_HEAD` (any fetch/pull, cron included) and our last good pull. */
  syncedAt?: string;
  /** Commits on the upstream branch (origin/main) not in HEAD, as of the last fetch. */
  behind?: number;
  ahead?: number;
  /** Last pull failed (diverged, network,...) or the tree is dirty: shown amber with this on hover. */
  error?: string;
  pulling?: boolean;
}

export interface RefreshResult extends RepoFreshness {
  /** HEAD moved. */
  pulled: boolean;
  /** Refused: this repo was refreshed less than refreshMinMs ago. */
  rateLimited?: boolean;
}

export interface FreshnessOptions {
  git?: GitOut;
  /** Drop the spines.py cache of repoDir. */
  invalidate?: (repoDir: string) => void;
  now?: () => number;
  log?: (msg: string) => void;
  /** Pull on open when the last pull is older than this (default 60 s). */
  openMaxAgeMs?: number;
  /** An open waits for its pull at most this long (default 3 s), then serves what it has. */
  openWaitMs?: number;
  /** the same for a repo pulled before (default openWaitMs; the console sets 0: it serves the last trees meanwhile). */
  reopenWaitMs?: number;
  /** the poll skips a repo pulled less than this ago (default 0 = always ask; the console mounts its poll interval). */
  pollSkipMs?: number;
  /** after a failed `ls-remote` the repo waits this long (default 10 min), doubling per failure up to pollBackoffMaxMs (6 h). */
  pollBackoffMs?: number;
  pollBackoffMaxMs?: number;
  /** Refresh at most once per this per repo (default 5 s). */
  refreshMinMs?: number;
  /** stale-lock self-heal (default on, false = off). */
  healLock?: LockHealer | false;
  /** read HEAD and the upstream from.git (no git child) when the layout allows; default on with the real git. */
  headFromFiles?: boolean;
  /** keep a checkout's uncommitted-changes check this long per HEAD (default 60 s). */
  dirtyMaxAgeMs?: number;
}

interface RepoState {
  lastOkAt?: number;
  error?: string;
  refreshedAt?: number;
}

export function createFreshness(o: FreshnessOptions = {}) {
  const git = o.git ?? gitOut();
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? ((m: string) => console.warn(m));
  const openMaxAgeMs = o.openMaxAgeMs ?? 60_000;
  const openWaitMs = o.openWaitMs ?? 3_000;
  const reopenWaitMs = o.reopenWaitMs ?? openWaitMs;
  const refreshMinMs = o.refreshMinMs ?? 5_000;
  const pollSkipMs = o.pollSkipMs ?? 0;
  const pollBackoffMs = o.pollBackoffMs ?? 10 * 60_000;
  const pollBackoffMaxMs = o.pollBackoffMaxMs ?? 6 * 3600_000;
  /** a repo whose `ls-remote` failed (no origin, a deleted test repo, a refused login) is asked again only after a growing wait. */
  const pollFailed = new Map<string, { n: number; until: number }>();
  // the real git self-heals a stuck pull (a test's fake git does not)
  const puller = createRepoPuller({ git: (d, a) => git(d, a).then(() => undefined), log, now, healLock: o.healLock, recover: o.git ? false : git });
  const state = new Map<string, RepoState>();
  const st = (dir: string) => state.get(dir) ?? (state.set(dir, {}), state.get(dir)!);
  const inFlight = new Map<string, Promise<boolean>>();
  // one timer per start() call: the milestone repos' poll and the workspace data repo's faster one
  const timers: ReturnType<typeof setInterval>[] = [];

  // HEAD from the files when the checkout is a plain one (no git child), else git as before. Only for the real git:
  // a test's fake git answers from its own script.
  const fromFiles = o.headFromFiles ?? !o.git;
  const dirtyMaxAgeMs = o.dirtyMaxAgeMs ?? 60_000;
  const dirtyMemo = new Map<string, { at: number; sha?: string; value?: string }>();
  const head = (dir: string) => {
    const sha = fromFiles ? headSha(dir) : undefined;
    return sha ? Promise.resolve(sha) : git(dir, ["rev-parse", "HEAD"]).then((s) => s.trim(), () => undefined);
  };
  /** ahead/behind per (HEAD, upstream) pair: it only changes when one of them moves. */
  const counts = new Map<string, { key: string; ahead: number; behind: number }>();

  /** One ff-only pull of dir (concurrent callers share it); drops the cache when HEAD moved (or always when forced). Resolves true when HEAD moved. */
  const pullAndDrop = (dir: string, dropAlways = false): Promise<boolean> => {
    const running = inFlight.get(dir);
    if (running) return dropAlways ? running.then((moved) => (moved || o.invalidate?.(dir), moved)) : running;
    const p = (async () => {
      const before = await head(dir);
      const r = await puller.pull(dir);
      const after = await head(dir);
      const s = st(dir);
      if (r.ok) {
        s.lastOkAt = now();
        s.error = await dirtyReason(dir);
      } else s.error = r.reason;
      const moved = !!after && after !== before;
      if (moved || dropAlways) o.invalidate?.(dir);
      return moved;
    })().finally(() => inFlight.delete(dir));
    inFlight.set(dir, p);
    return p;
  };

  const dirtyReason = async (dir: string): Promise<string | undefined> => {
    try {
      const changed = (await git(dir, ["status", "--porcelain", "--untracked-files=no"])).split("\n").filter(Boolean).length;
      return changed ? `checkout has ${changed} uncommitted change${changed === 1 ? "" : "s"} (left as is, nothing reset)` : undefined;
    } catch {
      return undefined;
    }
  };

  /** Pull on open: when the last pull of dir is older than openMaxAgeMs, start one and wait for it at most openWaitMs. */
  const onOpen = async (dir: string): Promise<void> => {
    let p = inFlight.get(dir);
    const at = puller.lastPullAt(dir);
    if (!p) {
      if (at !== undefined && now() - at < openMaxAgeMs) return;
      p = pullAndDrop(dir);
    }
    const waitMs = at === undefined ? openWaitMs : reopenWaitMs;
    if (waitMs <= 0) return void p.catch(() => false);
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([p.catch(() => false), new Promise((r) => (t = setTimeout(r, waitMs)))]);
    if (t) clearTimeout(t);
  };

  const fetchHeadAt = (dir: string): number | undefined => {
    try {
      // A worktree's.git is a file; the main checkouts the console reads have a.git directory.
      return fs.statSync(path.join(dir, ".git", "FETCH_HEAD")).mtimeMs;
    } catch {
      return undefined;
    }
  };

  const status = async (dir: string): Promise<RepoFreshness> => {
    const s = state.get(dir);
    const sha = await head(dir);
    let ahead: number | undefined;
    let behind: number | undefined;
    const up = fromFiles && sha ? upstreamSha(dir) : undefined;
    const key = up ? `${sha}:${up}` : undefined;
    const known = key ? counts.get(dir) : undefined;
    if (known && known.key === key) [ahead, behind] = [known.ahead, known.behind];
    else
      try {
        const [a, b] = (await git(dir, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).trim().split(/\s+/).map(Number);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          [ahead, behind] = [a, b];
          if (key) counts.set(dir, { key, ahead: a, behind: b });
        }
      } catch {
        /* no upstream */
      }
    const synced = Math.max(fetchHeadAt(dir) ?? 0, s?.lastOkAt ?? 0);
    // a repo this process never pulled ran `git status` on every status call (each /api/freshness poll)
    let error = s?.error;
    if (!s) {
      const m = dirtyMemo.get(dir);
      if (m && m.sha === sha && now() - m.at < dirtyMaxAgeMs) error = m.value;
      else dirtyMemo.set(dir, { at: now(), sha, value: (error = await dirtyReason(dir)) });
    }
    return {
      repo: path.basename(dir),
      ...(sha ? { sha } : {}),
      ...(synced ? { syncedAt: new Date(synced).toISOString() } : {}),
      ...(behind !== undefined ? { behind, ahead } : {}),
      ...(error ? { error } : {}),
      ...(inFlight.has(dir) ? { pulling: true } : {}),
    };
  };

  /** Refresh button: fetch + ff-only pull + cache drop, once per refreshMinMs per repo. */
  const refresh = async (dir: string): Promise<RefreshResult> => {
    const s = st(dir);
    if (s.refreshedAt !== undefined && now() - s.refreshedAt < refreshMinMs) return { ...(await status(dir)), pulled: false, rateLimited: true };
    s.refreshedAt = now();
    const pulled = await pullAndDrop(dir, true);
    return { ...(await status(dir)), pulled };
  };

  /**
   * One poll: `git ls-remote origin main` per repo; a remote sha HEAD does not already contain → pull.
   * a repo pulled here within `pollSkipMs` (an open, a run end, Refresh) is not asked again.
   */
  /** the HEAD each watched repo had at its last poll (start(..., { watchHead: true })). */
  const seenHead = new Map<string, string>();
  /**
   * watchHead: a checkout another process moved (the background sync, a worker's hand pull) is pulled by nobody
   * here, so nothing dropped the caches built from it: the poll drops them when HEAD differs from its last poll.
   */
  const poll = async (dirs: string[], skipMs = pollSkipMs, watchHead = false): Promise<void> => {
    for (const dir of [...new Set(dirs)]) {
      if (watchHead) {
        const h = await head(dir);
        const before = seenHead.get(dir);
        if (h) seenHead.set(dir, h);
        if (h && before && before !== h) o.invalidate?.(dir);
      }
      const pulledAt = puller.lastPullAt(dir);
      if (pulledAt !== undefined && now() - pulledAt < skipMs) continue;
      const failed = pollFailed.get(dir);
      if (failed && now() < failed.until) continue;
      try {
        const remote = (await git(dir, ["ls-remote", "origin", "refs/heads/main"])).trim().split(/\s+/)[0];
        pollFailed.delete(dir);
        const local = await head(dir);
        if (!remote || !local || remote === local) continue;
        // Local is ahead (a console spine write not pushed yet): nothing to pull.
        const contained = await git(dir, ["merge-base", "--is-ancestor", remote, "HEAD"]).then(() => true, () => false);
        if (!contained && (await pullAndDrop(dir)) && watchHead) {
          const h = await head(dir);
          if (h) seenHead.set(dir, h); // dropped already by the pull
        }
      } catch (e) {
        // a checkout whose origin is gone (removed test worlds: thousands of failed git calls a day at 5 min) waits 10 min,
        // then twice as long each time, up to 6 h; one answer from it clears the wait.
        const n = (failed?.n ?? 0) + 1;
        const wait = Math.min(pollBackoffMaxMs, pollBackoffMs * 2 ** (n - 1));
        pollFailed.set(dir, { n, until: now() + wait });
        log(`freshness poll ${dir}: ${(e as Error).message} (asked again in ${Math.round(wait / 60_000)} min)`);
      }
    }
  };

  /** Poll dirs() every everyMs; skipMs (default pollSkipMs) skips a repo pulled that recently; watchHead: see poll. */
  const start = (everyMs: number, dirs: () => string[], skipMs = pollSkipMs, watchHead = false) => {
    if (everyMs <= 0) return;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      // A throw from dirs (its db closed, a bad row) is logged, never an uncaught exception in the timer.
      void Promise.resolve()
        .then(() => poll(dirs(), skipMs, watchHead))
        .catch((e) => log(`freshness poll: ${(e as Error).message}`))
        .finally(() => (busy = false));
    }, everyMs);
    timer.unref?.();
    timers.push(timer);
  };
  const stop = () => {
    for (const t of timers.splice(0)) clearInterval(t);
  };

  return { onOpen, status, refresh, poll, start, stop, pullAndDrop };
}

export type Freshness = ReturnType<typeof createFreshness>;

/** First timestamp in a `Verified at:` value; a bare date counts as the end of that day (UTC). */
export function parseVerifiedAt(v: string | null | undefined): number | undefined {
  const m = /(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)\s*(Z|[+-]\d{2}:?\d{2})?)?/.exec(v ?? "");
  if (!m) return undefined;
  const t = m[2] ? Date.parse(`${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}${m[3] ?? "Z"}`) : Date.parse(`${m[1]}T23:59:59Z`);
  return Number.isFinite(t) ? t : undefined;
}

export interface NarrativeAge {
  verifiedAt?: string;
  /** Newest commit on a descendant spine or ticket file. */
  childCommitAt?: string;
  /** How far the Current State is behind its children (only when a child is newer): minutes, and hours rounded. */
  behindMinutes?: number;
  behindHours?: number;
}

/** Item 7: is the spine's Current State (prose, `Verified at`) older than the newest commit on its descendants? */
export async function narrativeAge(git: GitOut, repoDir: string, verifiedAt: string | null | undefined, childPaths: string[]): Promise<NarrativeAge> {
  const v = parseVerifiedAt(verifiedAt);
  const out: NarrativeAge = v !== undefined ? { verifiedAt: new Date(v).toISOString() } : {};
  const paths = [...new Set(childPaths)].filter(Boolean);
  if (!paths.length) return out;
  const at = await git(repoDir, ["log", "-1", "--format=%cI", "--", ...paths]).then((s) => s.trim(), () => "");
  const c = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(c)) return out;
  out.childCommitAt = new Date(c).toISOString();
  if (v !== undefined && c > v) {
    out.behindMinutes = Math.max(1, Math.round((c - v) / 60_000));
    out.behindHours = Math.round((c - v) / 3_600_000);
  }
  return out;
}
