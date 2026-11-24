import { execFile } from "./spawnHost.js";
import fs from "node:fs";
import path from "node:path";
import { sites } from "./identity.js";

/**
 * git in a checkout and a push that follows the checkout's Integration policy (moved unchanged from
 * social/write.ts, where the social writer and the team skills screen both used them).
 */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GitRunner = (dir: string, args: string[], env?: Record<string, string>) => Promise<GitResult>;

const runGit: GitRunner = (dir, args, env) =>
  new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

/** The console's commit identity (as inbox/spineWrite.ts), used when the checkout has none of its own. */
export const consoleGitIdentity = () => ({
  GIT_AUTHOR_NAME: "Agent Team Console",
  GIT_COMMITTER_NAME: "Agent Team Console",
  GIT_AUTHOR_EMAIL: sites().gitEmail,
  GIT_COMMITTER_EMAIL: sites().gitEmail,
});
const MAKES_COMMITS = new Set(["commit", "pull", "rebase", "merge", "cherry-pick", "revert"]);

/**
 * git in a checkout. A command that makes commits gets the console's identity when the checkout has none (repo or
 * global `user.email`): the main server's the service user has no global identity, so every console social write was refused live with
 * "Author identity unknown" (2026-11-01, first live approve). The repo's own identity, when set, wins.
 */
export const gitRunner: GitRunner = async (dir, args, env) => {
  if (MAKES_COMMITS.has(args[0]) && !env?.GIT_AUTHOR_EMAIL && !process.env.GIT_AUTHOR_EMAIL && !(await runGit(dir, ["config", "user.email"])).stdout.trim())
    return runGit(dir, args, { ...consoleGitIdentity(), ...env });
  return runGit(dir, args, env);
};

/** `Integration policy:` of the checkout (AGENTS.md, then the root spine); undefined = not declared (main-direct). */
export function integrationPolicy(repoDir: string): string | undefined {
  for (const f of ["AGENTS.md", "docs/spines/root.md"]) {
    try {
      const m = /^\s*(?:[-*]\s*)?Integration policy:\s*`?([^`\s(]+)/im.exec(fs.readFileSync(path.join(repoDir, f), "utf8"));
      if (m) return m[1].toLowerCase();
    } catch {
      /* next */
    }
  }
  return undefined;
}

export interface PushResult {
  state: "pushed" | "rebased" | "no-remote" | "skipped" | "failed";
  detail?: string;
}

/** Push a checkout's commits per its Integration policy (main-direct or none: push; a reject: `pull --rebase` and one retry). */
export async function pushCheckout(git: GitRunner, dir: string): Promise<PushResult> {
  const policy = integrationPolicy(dir);
  if (policy && policy !== "main-direct") return { state: "skipped", detail: `Integration policy: ${policy} (committed, not pushed)` };
  const remotes = (await git(dir, ["remote"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!remotes.includes("origin")) return { state: "no-remote" };
  const head = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.code !== 0) return { state: "failed", detail: `rev-parse: ${(head.stderr || head.stdout).trim().split("\n").pop()}` };
  const branch = head.stdout.trim();
  if (branch === "HEAD") return { state: "skipped", detail: "detached HEAD" };
  const first = await git(dir, ["push", "origin", `HEAD:${branch}`]);
  if (first.code === 0) return { state: "pushed" };
  const pull = await git(dir, ["pull", "--rebase", "--autostash", "origin", branch]);
  if (pull.code !== 0) {
    await git(dir, ["rebase", "--abort"]);
    return { state: "failed", detail: `pull --rebase: ${(pull.stderr || pull.stdout).trim().split("\n").pop()}` };
  }
  const again = await git(dir, ["push", "origin", `HEAD:${branch}`]);
  return again.code === 0 ? { state: "rebased" } : { state: "failed", detail: `push: ${(again.stderr || again.stdout).trim().split("\n").pop()}` };
}
