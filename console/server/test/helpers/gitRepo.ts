import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A throwaway checkout `<reposRoot>/<name>` whose origin is a bare repo in its own temp dir (never GitHub, never a real
 * checkout:), seeded with `files` on main, so the console's spine writer can commit and push to it.
 */
export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
export const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

export interface TempCheckout {
  dir: string;
  origin: string;
  /** The file as it is on origin main (what another host would pull). */
  onMain(rel: string): string;
  /** Commits on origin main, newest first (subject lines). */
  log(): string[];
  cleanup(): void;
}

export function tempCheckout(reposRoot: string, name: string, files: Record<string, string>): TempCheckout {
  if (!path.resolve(reposRoot).startsWith(fs.realpathSync(os.tmpdir())) && !path.resolve(reposRoot).startsWith(os.tmpdir())) throw new Error(`tempCheckout: ${reposRoot} is not under the OS temp dir`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `console-origin-${name}-`));
  const origin = path.join(base, `${name}.git`);
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(base, "seed");
  git(base, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), text);
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["push", "-q", "origin", "main"]);
  const dir = path.join(reposRoot, name);
  git(reposRoot, ["clone", "-q", origin, dir]);
  git(dir, ["config", "user.name", "console"]);
  git(dir, ["config", "user.email", "console@test"]);
  return {
    dir,
    origin,
    onMain: (rel) => git(origin, ["show", `main:${rel}`]),
    log: () => git(origin, ["log", "--format=%s", "main"]).split("\n"),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}
