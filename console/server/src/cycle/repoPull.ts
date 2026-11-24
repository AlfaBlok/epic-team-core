import { groupRun } from "../spawnHost.js";
import { healedLine, lockHealer, type LockHealer } from "../gitStaleLock.js";
import { CONTENTION_RETRY_MS, gitContention, withRepoLock } from "../repoLock.js";
import { recoverPull } from "./syncRecover.js";

/**
 * what a run writes to its repo must show at once, not after the 15-min background sync. When a run
 * ends the console fast-forwards that milestone's checkout here (the one `resolveRepo` reads) and drops the spines.py
 * cache for it. Never forced: a dirty or diverged tree is logged with its reason and left alone (no reset, no stash).
 */
export type GitRunner = (repoDir: string, args: string[]) => Promise<void | string>;
/** A git runner that resolves with stdout (what the self-heal of a stuck pull reads, syncRecover.ts). */
export type GitOutRunner = (repoDir: string, args: string[]) => Promise<string>;
/** gitRunner() marks its runners with this: they resolve with stdout, so a pull through them may self-heal. */
const OUT = Symbol.for("console.gitRunner.stdout");

/**
 * git runs in its own process group and the whole group is killed on the timeout, and the result comes on the
 * timeout itself. With `execFile` a timeout killed git alone: a `git pull` over HTTPS leaves `git-remote-https` holding
 * the pipes, the callback never came, and the pull kept the checkout's console-wide lock (repoLock.ts) until a restart
 * (the code repo, 2026-11-11 05:03-05:09Z: the owner's feedback press waited behind it; the same failure fixed in the
 * spine writer). No prompt ever waits for a terminal.
 */
export const gitRunner = (timeoutMs = 30_000): GitOutRunner => {
  // started by the spawn host (its own process group there, the whole group killed on timeout)
  const run: GitOutRunner = async (repoDir, args) => {
    const r = await groupRun("git", ["-C", repoDir, ...args], {
      timeout: timeoutMs,
      cap: 4_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15" },
    });
    if (r.code === 0 && !r.timedOut) return r.out;
    // the first error:/fatal: line (it names the lock file); git's last line is often "remove the file manually".
    const lines = r.err.trim().split("\n").filter(Boolean);
    const why = r.timedOut ? `timed out after ${timeoutMs} ms (killed with its children)` : r.error ?? undefined;
    throw new Error(lines.find((l) => /^(error|fatal):/.test(l)) || why || lines.pop() || `git ${args[0]} failed`);
  };
  return Object.assign(run, { [OUT]: true });
};

export interface RepoPullerOptions {
  git?: GitRunner;
  /** Called after a pull succeeded (spines.py cache invalidation). */
  onPulled?: (repoDir: string) => void;
  log?: (msg: string) => void;
  now?: () => number;
  /** pause before the one retry of a pull another git process got in the way of (default CONTENTION_RETRY_MS). */
  contentionRetryMs?: number;
  /**
   * a pull still failing on a stale `.git/*.lock` (older than 10 min, no git running in the checkout) deletes
   * it, logs it and retries once. Default on (local healer); false = off.
   */
  healLock?: LockHealer | false;
  /**
   * a pull still refused after the retry and the lock heal goes to `recoverPull` (fetch + merge by name,
   * local commits already on main dropped, the console's own rebased, clean-merging local edits stashed and put back;
   * never a reset). Default: on with gitRunner() (or no `git`), off with any other runner; false = off.
   */
  recover?: GitOutRunner | false;
}

export type PullResult = { ok: true } | { ok: false; reason: string };

export function createRepoPuller(o: RepoPullerOptions = {}) {
  const git = o.git ?? gitRunner();
  const log = o.log ?? ((m: string) => console.warn(m));
  const now = o.now ?? (() => Date.now());
  const heal = o.healLock === false ? undefined : (o.healLock ?? lockHealer());
  const recoverGit: GitOutRunner | undefined =
    o.recover === false ? undefined : (o.recover ?? ((git as unknown as Record<symbol, unknown>)[OUT] ? (git as GitOutRunner) : undefined));
  const inFlight = new Map<string, Promise<PullResult>>();
  const lastAt = new Map<string, number>();

  /**
   * the pull itself, under the checkout's console-wide git lock (repoLock.ts), tried once more after a pause
   * when another git process in the same checkout made it fail (the host's background sync, an agent session).
   */
  const pullLocked = (repoDir: string) =>
    withRepoLock(repoDir, async () => {
      const once = () => git(repoDir, ["pull", "-q", "--ff-only"]);
      try {
        try {
          await once();
        } catch (e) {
          if (!gitContention((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, o.contentionRetryMs ?? CONTENTION_RETRY_MS));
          await once();
        }
      } catch (e) {
        try {
          // still refused on a lock file: delete it when stale and unused, then one more try.
          const h = heal ? await heal(repoDir, (e as Error).message) : undefined;
          if (!h?.removed) throw e;
          log(`repo pull ${repoDir}: ${healedLine(repoDir, h)}`);
          await once();
        } catch (e2) {
          if (!recoverGit) throw e2;
          const r = await recoverPull((args) => recoverGit(repoDir, args), { retryMs: o.contentionRetryMs ?? CONTENTION_RETRY_MS });
          if (!r.ok) throw new Error(r.tried ? `${(e2 as Error).message} (self-heal: ${r.reason})` : (e2 as Error).message);
          log(`repo pull ${repoDir}: self-healed after "${(e2 as Error).message}": ${r.did}`);
        }
      }
    });

  /** `git pull -q --ff-only` in repoDir; at most one per repo in flight (concurrent callers share it). Never throws. */
  const pull = (repoDir: string): Promise<PullResult> => {
    let p = inFlight.get(repoDir);
    if (p) return p;
    lastAt.set(repoDir, now());
    p = pullLocked(repoDir)
      .then((): PullResult => {
        try {
          o.onPulled?.(repoDir);
        } catch (e) {
          log(`repo pull ${repoDir}: cache invalidation failed: ${(e as Error).message}`);
        }
        return { ok: true };
      })
      .catch((e): PullResult => {
        const reason = (e as Error).message;
        log(`repo pull ${repoDir} failed (left as is, nothing reset): ${reason}`);
        return { ok: false, reason };
      })
      .finally(() => inFlight.delete(repoDir));
    inFlight.set(repoDir, p);
    return p;
  };

  /** Pull only when the last pull of repoDir started more than maxAgeMs ago (or never); otherwise join or skip. */
  const pullIfOlder = (repoDir: string, maxAgeMs: number): Promise<PullResult | undefined> => {
    const p = inFlight.get(repoDir);
    if (p) return p;
    const at = lastAt.get(repoDir);
    if (at !== undefined && now() - at < maxAgeMs) return Promise.resolve(undefined);
    return pull(repoDir);
  };

  return { pull, pullIfOlder, lastPullAt: (repoDir: string) => lastAt.get(repoDir) };
}

export type RepoPuller = ReturnType<typeof createRepoPuller>;
