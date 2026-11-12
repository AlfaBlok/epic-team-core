// tests never write or push a real checkout or its origin. A run seeded a milestone at the real
// ~/github/the code repo, raised the cycle.test.ts "Restart relay?" fixture through POST /api/needs-owner
// (in process, not the:18750 console), and the spine writer fast-forwarded, committed and pushed fake ask into
// the real main (674d6aeb). This setup file (every test worker) makes that impossible and loud:
//  - git run by the server (child_process) against a repo outside the OS temp dir may only read: a write or any
//    contact with a remote is replaced by a failing command, and the test that asked for it fails (afterEach);
//  - a push to GitHub from any process the tests start (git, python, a shell) is rewritten to a dead path
//    (pushInsteadOf in GIT_CONFIG_COUNT, which also holds under GIT_CONFIG_GLOBAL=/dev/null);
//  - the spine writer's own refusal (spineWrite.ts underTmp) records here too, so a test that points it at a real
//    checkout fails instead of passing on a skip.
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { afterEach } from "vitest";

export const REFUSED = "tests may not write a checkout outside the temp dir or contact its origin";

/** git subcommands that only read the repo (anything else outside the temp dir is refused). */
const READ_ONLY = new Set([
  "status", "log", "show", "rev-parse", "diff", "ls-files", "cat-file", "rev-list", "for-each-ref", "symbolic-ref",
  "describe", "merge-base", "blame", "grep", "ls-tree", "name-rev", "shortlog", "version", "check-ignore", "show-ref",
  "count-objects", "diff-tree", "diff-files", "diff-index", "var", "help", "check-ref-format",
]);

const BRANCH_WRITE = /^(-[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description)$/;
const BRANCH_LIST = /^(--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/;

type Guard ={ violations: string[]; record: (what: string) => void; drain: () => string[] };
const g = globalThis as unknown as { __e62s9?: Guard };
const guard: Guard = (g.__e62s9 ??= {
  violations: [],
  record(what) {
    this.violations.push(what);
  },
  drain() {
    return this.violations.splice(0);
  },
});

let tmpReal: string | undefined;
export function underTmp(dir: string): boolean {
  tmpReal ??= fs.realpathSync(os.tmpdir());
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    // a path that does not exist yet (git init <new dir>): judge its nearest existing parent
    const up = path.dirname(dir);
    return up !== dir && underTmp(up);
  }
  return real === tmpReal || real.startsWith(tmpReal + path.sep);
}

/** The repo a git argv acts on and its subcommand + args (global options -C, -c, --git-dir, --work-tree skipped). */
export function gitTarget(args: readonly string[], cwd: string): { dir: string; sub: string; rest: string[] } {
  let dir = cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "-C") dir = path.resolve(dir, args[++i] ?? ".");
    else if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace" || a === "--exec-path") {
      if (a === "--git-dir" || a === "--work-tree") dir = path.resolve(dir, args[i + 1] ?? ".");
      i++;
    } else if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) dir = path.resolve(dir, a.slice(a.indexOf("=") + 1));
    else if (a.startsWith("-")) continue;
    else break;
  }
  return { dir, sub: args[i] ?? "", rest: args.slice(i + 1) as string[] };
}

/** Why this git call is refused, or undefined when it may run. */
export function refusal(args: readonly string[], cwd: string): string | undefined {
  const { dir, sub, rest } = gitTarget(args, cwd);
  // init/clone act on the directory they name (the last positional), not where git runs; clone only from a local source
  const pos = rest.filter((a, i) => !a.startsWith("-") && !/^(-b|--branch|--initial-branch|--template|--separate-git-dir|-o|--origin|--reference|--depth|-c|--config)$/.test(rest[i - 1] ?? ""));
  if (sub === "init") return underTmp(path.resolve(dir, pos[pos.length - 1] ?? ".")) ? undefined : `git init in ${path.resolve(dir, pos[pos.length - 1] ?? ".")}`;
  if (sub === "clone") {
    const [src, dst] = pos;
    if (src && /^(https?|ssh|git):\/\/|^[\w.-]+@[\w.-]+:/.test(src)) return `git clone from ${src}`;
    const to = path.resolve(dir, dst ?? path.basename(src ?? "repo").replace(/\.git$/, ""));
    return underTmp(to) ? undefined : `git clone into ${to}`;
  }
  if (underTmp(dir)) return undefined;
  if (sub === "" || READ_ONLY.has(sub)) return undefined; // "" = git --version / --help
  if (sub === "config" && rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a))) return undefined;
  if (sub === "remote" && (rest.length === 0 || rest[0] === "-v" || rest[0] === "get-url")) return undefined;
  if (sub === "branch" && !rest.some((a) => BRANCH_WRITE.test(a)) && (rest.every((a) => a.startsWith("-")) || rest.some((a) => BRANCH_LIST.test(a))))
    return undefined;
  if (sub === "worktree" && rest[0] === "list") return undefined;
  if (sub === "stash" && rest[0] === "list") return undefined;
  return `git ${sub} in ${dir}`;
}

const isGit = (file: unknown) => typeof file === "string" && (file === "git" || file.endsWith("/git"));
const DEAD = [process.execPath, ["-e", `process.stderr.write(${JSON.stringify(REFUSED)} + "\\n"); process.exit(128)`]] as const;

/** A refused git argv becomes DEAD's; anything else passes through unchanged. */
function rewrite(file: unknown, rest: any[]): [unknown, any[]] {
  if (isGit(file) && Array.isArray(rest[0])) {
    const opts = rest[1] && typeof rest[1] === "object" ? rest[1] : undefined;
    const why = refusal(rest[0], typeof opts?.cwd === "string" ? opts.cwd : process.cwd());
    if (why) {
      guard.record(why);
      return [DEAD[0], [[...DEAD[1]], ...rest.slice(1)]];
    }
  }
  return [file, rest];
}

/** child_process.{execFile,execFileSync,spawn,spawnSync}(file, args?, options?, cb?): a refused git call runs DEAD. */
function wrap<F extends (...a: any[]) => any>(orig: F): F {
  const w = function (this: unknown, file: unknown, ...rest: any[]) {
    const [f, r] = rewrite(file, rest);
    return orig.call(this, f, ...r);
  } as unknown as F;
  // execFile's promisified form resolves { stdout, stderr }; keep it (and guard it too)
  const custom = (orig as any)[promisify.custom];
  if (custom) (w as any)[promisify.custom] = (file: unknown, ...rest: any[]) => custom(...[rewrite(file, rest)].flatMap(([f, r]) => [f, ...r]));
  return w;
}

const marked = cp as unknown as { __e62s9?: boolean };
if (!marked.__e62s9) {
  cp.execFile = wrap(cp.execFile);
  cp.execFileSync = wrap(cp.execFileSync);
  cp.spawn = wrap(cp.spawn);
  cp.spawnSync = wrap(cp.spawnSync);
  marked.__e62s9 = true;
  syncBuiltinESMExports(); // the server's `import { execFile } from "node:child_process"` bindings see the wrappers
}

// No process the tests start can push to GitHub, whatever the repo or language.
const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
if (!process.env.E62S9_PUSH_GUARD) {
  const dead = `file://${path.join(os.tmpdir(), "e62s9-push-refused")}/`;
  ["https://github.com/", "git@github.com:", "ssh://git@github.com/"].forEach((from, k) => {
    process.env[`GIT_CONFIG_KEY_${n + k}`] = `url.${dead}.pushInsteadOf`;
    process.env[`GIT_CONFIG_VALUE_${n + k}`] = from;
  });
  process.env.GIT_CONFIG_COUNT = String(n + 3);
  process.env.E62S9_PUSH_GUARD = "1";
}

// the host's global git config points core.hooksPath at the leak-watch hooks, so every commit and
// push in a fixture repo ran gitleaks (~1.7 s each on an idle the worker server, far more under a full run's load). That shared,
// host-wide cost made git-heavy files (e53s4, e63s11) flake only in the full run. Fixture repos live in the temp dir
// and cannot push to GitHub (above), so the scan guards nothing here; the hooks still chain to a repo's own hooks.
process.env.LEAK_WATCH_SKIP ??= "1";

afterEach(() => {
  const v = guard.drain();
  if (v.length) throw new Error(`${REFUSED}: ${[...new Set(v)].join("; ")}. Use a temp repo with a temp bare origin (see test/realCheckoutGuard.test.ts).`);
});
