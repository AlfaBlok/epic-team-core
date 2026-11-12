// a stand-in for a real checkout. A temp clone (named like the real repo) of a temp bare origin, seeded with
// copies of a few files read from the real checkout, so a test can finish runs (the console fetches the milestone repo),
// write spines and push without touching ~/github/<name> or GitHub (test/realCheckoutGuard.ts refuses that).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
/** The real the code repo checkout this suite lives in (read only: files are copied out of it). */
export const REAL_CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** `<tmp>/e62s9-co-*\/<name>` (origin `<tmp>/e62s9-co-*\/origin.git`), one commit holding `files` copied from `from`. */
export function tempCheckout(name = "home_repo", files: string[] = ["AGENTS.md", "docs/spines/root.md"], from = REAL_CHECKOUT): { dir: string; origin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e62s9-co-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const dir = path.join(root, name);
  const git = (args: string[], cwd = root) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "--bare", "-b", "main", origin]);
  git(["init", "-q", "-b", "main", dir]);
  git(["remote", "add", "origin", origin], dir);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(from, f), path.join(dir, f));
  }
  git(["add", "-A"], dir);
  git(["commit", "-q", "--allow-empty", "-m", "seed"], dir);
  git(["push", "-q", "origin", "HEAD:main"], dir);
  return { dir, origin };
}
