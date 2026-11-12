import { execFile } from "node:child_process";
import path from "node:path";

/**
 * a git lock file left behind by a killed git (SIGKILL leaves `.git/index.lock`; SIGTERM does not, git removes
 * it on the signal) blocks every later pull of that checkout until a human deletes it. Seen 2026-11-02: a 0-byte
 * memory `.git/index.lock` from 01:27 CET kept the console's pull failing for 4 h (32 commits behind).
 *
 * Self-heal, used by every console pull (run-end, freshness, book, pre-wake on the main server and the worker server): when a pull fails on
 * `Unable to create '<checkout>/.git/<...>.lock': File exists`, and that lock is older than STALE_LOCK_MS, and no git
 * process runs in that checkout (cwd inside it, or the checkout path in its arguments, i.e. `git -C <dir>`), the lock is
 * deleted and the caller retries the pull once. Anything else (a young lock, a git still running, a lock outside
 * `<checkout>/.git/`) leaves it alone and the pull error stands.
 */
export const STALE_LOCK_MS = 10 * 60_000;

/** The lock file a git error names, when it lies inside `<repoDir>/.git/`; else undefined. */
export function staleLockPath(repoDir: string, msg: string): string | undefined {
  const m = /Unable to create '([^']+\.lock)': File exists/i.exec(msg);
  if (!m) return undefined;
  const lock = path.resolve(repoDir, m[1]);
  const gitDir = path.resolve(repoDir, ".git") + path.sep;
  return lock.startsWith(gitDir) && !lock.slice(gitDir.length).split(path.sep).includes("..") ? lock : undefined;
}

export type HealResult = { removed: true; lock: string; ageMin: number } | { removed: true; restored: string[] } | { removed: false; why: string };

/**
 * The check-and-delete as one POSIX sh script (so the worker server path runs the same thing over ssh). Args: $1 checkout,
 * $2 lock file, $3 minimum age in seconds. Prints one line: `removed <age s>`, `young <age s>`, `busy <pid>`, `gone`.
 */
export const HEAL_SCRIPT = [
  'd=$1; f=$2; min=$3',
  // `$2 = --redundant` restores worktree edits that are already in HEAD or upstream (REDUNDANT below)
  '[ "$f" = --redundant ] && { cd "$d" || exit 1',
  '  u=$(git rev-parse -q --verify "@{u}" 2>/dev/null)',
  '  git diff --name-only | while IFS= read -r p; do',
  '    if [ -f "$p" ] && git diff --cached --quiet -- "$p"; then',
  '      h=$(git hash-object -- "$p")',
  '      if [ "$h" = "$(git rev-parse -q --verify "HEAD:$p")" ] || { [ -n "$u" ] && [ "$h" = "$(git rev-parse -q --verify "$u:$p")" ]; }; then',
  '        git checkout -q -- "$p" && echo "restored $p" && continue',
  '      fi',
  '    fi',
  '    echo "kept $p"',
  '  done; exit 0; }',
  '[ -e "$f" ] || { echo gone; exit 0; }',
  'age=$(( $(date +%s) - $(stat -c %Y "$f") ))',
  '[ "$age" -ge "$min" ] || { echo "young $age"; exit 0; }',
  'for p in /proc/[0-9]*; do',
  '  c=$(cat "$p/comm" 2>/dev/null) || continue',
  '  case "$c" in git|git-*) ;; *) continue ;; esac',
  '  w=$(readlink "$p/cwd" 2>/dev/null)',
  '  case "$w" in "$d"|"$d"/*) echo "busy ${p#/proc/}"; exit 0 ;; esac',
  '  if tr "\\000" "\\n" < "$p/cmdline" 2>/dev/null | grep -qxF -e "$d" -e "$d/" -e "$d/.git"; then echo "busy ${p#/proc/}"; exit 0; fi',
  'done',
  'rm -f -- "$f" && echo "removed $age"',
].join("\n");

/**
 * a pull refused with "Your local changes to the following files would be overwritten by merge" where those
 * local changes already equal the file in HEAD or in upstream hold no work (the main server 2026-11-03: tax-assist-research's
 * AGENTS.md carried, uncommitted, the very edit origin had made; the checkout stayed 30 commits behind for hours, the
 * console showed an ask the repo had already closed and refused the answer's spine write). Each such file (index
 * equal to HEAD, content equal to HEAD's or upstream's blob) is checked out from HEAD and the pull retried; any other
 * local change is kept and the pull error stands.
 */
export const REDUNDANT = "--redundant";
export const overwriteRefused = (msg: string) => /local changes to the following files would be overwritten/i.test(msg);

export function parseRedundant(out: string): HealResult {
  const lines = out.split("\n").filter(Boolean);
  const restored = lines.filter((l) => l.startsWith("restored ")).map((l) => l.slice(9));
  const kept = lines.filter((l) => l.startsWith("kept ")).map((l) => l.slice(5));
  if (restored.length) return { removed: true, restored };
  return { removed: false, why: kept.length ? `local changes in ${kept.join(", ")} are not in HEAD or upstream (kept)` : "no local changes to restore" };
}

export function parseHeal(lock: string, out: string): HealResult {
  const [word, n] = out.trim().split(/\s+/);
  if (word === "removed") return { removed: true, lock, ageMin: Math.round(Number(n) / 60) };
  if (word === "young") return { removed: false, why: `${path.basename(lock)} is ${Math.round(Number(n) / 60)} min old (kept, < ${STALE_LOCK_MS / 60_000} min)` };
  if (word === "busy") return { removed: false, why: `git process ${n} is working in the checkout (lock kept)` };
  if (word === "gone") return { removed: false, why: "lock already gone" };
  return { removed: false, why: `stale-lock check failed: ${out.trim() || "no output"}` };
}

/** Runs HEAL_SCRIPT for (checkout, lock); resolves with its stdout. */
export type HealRunner = (repoDir: string, lock: string, minAgeS: number) => Promise<string>;

export const localHealRunner: HealRunner = (repoDir, lock, minAgeS) =>
  new Promise((resolve, reject) =>
    execFile("sh", ["-c", HEAL_SCRIPT, "heal", path.resolve(repoDir), lock, String(minAgeS)], { timeout: 15_000 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    ),
  );

/**
 * A pull error → delete the lock it names when stale and unused, or restore local edits already in HEAD or
 * upstream. Undefined = neither kind of error (nothing tried). Never throws.
 */
export type LockHealer = (repoDir: string, msg: string) => Promise<HealResult | undefined>;

export function lockHealer(run: HealRunner = localHealRunner, maxAgeMs = STALE_LOCK_MS): LockHealer {
  return async (repoDir, msg) => {
    if (overwriteRefused(msg)) {
      try {
        return parseRedundant(await run(path.resolve(repoDir), REDUNDANT, 0));
      } catch (e) {
        return { removed: false, why: `redundant-change check failed: ${(e as Error).message}` };
      }
    }
    const lock = staleLockPath(repoDir, msg);
    if (!lock) return undefined;
    try {
      return parseHeal(lock, await run(path.resolve(repoDir), lock, Math.round(maxAgeMs / 1000)));
    } catch (e) {
      return { removed: false, why: `stale-lock check failed: ${(e as Error).message}` };
    }
  };
}

/** One log line for a removed lock. */
export const healedLine = (repoDir: string, h: Extract<HealResult, { removed: true }>) =>
  "restored" in h
    ? `restored ${h.restored.join(", ")} (local edits already in HEAD or upstream, nothing lost), retrying the pull`
    : `removed stale ${path.relative(repoDir, h.lock)} (${h.ageMin} min old, no git running in ${path.basename(repoDir)}), retrying the pull`;
