import path from "node:path";

/**
 * one git operation at a time per checkout, across every part of the console. Before this, four separate pullers
 * (run-end pull, freshness, new-ask HEAD watch, book refresh) and the spine writer each kept their own "one in flight"
 * map, so two of them could fetch or pull the same checkout at once; git then refused one of them ("cannot lock ref
 * 'refs/remotes/origin/main'", "Cannot fast-forward to multiple branches": a second fetch rewrote FETCH_HEAD under a
 * pull), seen in the journal on 2026-11-01 next to answers whose spine write took 8-140 s.
 *
 * In-process only: the EpicSpine background sync and agent sessions on the host still run their own git, so callers
 * also retry once on `gitContention` (below).
 */
const chains = new Map<string, Promise<unknown>>();

/**
 * the longest a caller waits for the git operation ahead of it. On 2026-11-11 05:03Z a run-end `git pull` whose
 * HTTPS helper hung kept the code repo's lock for 5 min; the owner's feedback press waited behind it until the restart killed
 * the pull. Every git call under the lock has its own timeout, so a holder past this is stuck, not slow: the next caller
 * goes on (logged) instead of waiting for ever. `CONSOLE_REPO_LOCK_MAX_MS`, 0 = no limit.
 */
export const REPO_LOCK_MAX_MS = Number(process.env.CONSOLE_REPO_LOCK_MAX_MS ?? 90_000);

export function withRepoLock<T>(dir: string, fn: () => Promise<T>, o: { maxWaitMs?: number; log?: (m: string) => void } = {}): Promise<T> {
  const key = path.resolve(dir);
  const max = o.maxWaitMs ?? REPO_LOCK_MAX_MS;
  const prev = chains.get(key) ?? Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ahead =
    max > 0
      ? Promise.race([
          prev,
          new Promise<void>((res) => {
            timer = setTimeout(() => {
              (o.log ?? ((m: string) => console.warn(m)))(`repo lock ${key}: the git operation ahead held it over ${Math.round(max / 1000)} s; going on without it`);
              res();
            }, max);
            timer.unref?.();
          }),
        ]).finally(() => clearTimeout(timer))
      : prev;
  const next = ahead.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

/** Whether a git operation holds (or waits for) the lock of dir right now. */
export const repoLocked = (dir: string) => chains.has(path.resolve(dir));

/** A refusal caused by another git process working in the same checkout at that moment: worth one retry after a pause. */
export const gitContention = (msg: string) =>
  /cannot lock ref|Cannot fast-forward to multiple branches|not something we can merge in \.git\/FETCH_HEAD|index\.lock|Unable to create '.*\.lock'|shallow file has changed/i.test(msg);

/** The pause before that retry. */
export const CONTENTION_RETRY_MS = 1_500;
