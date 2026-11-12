import fs from "node:fs";
import path from "node:path";

/**
 * a checkout's HEAD and its upstream sha read from `.git` itself, no `git` child. Spawning git from the console
 * (a large process) blocks its event loop for 10-30 ms each; `rev-parse HEAD` per repo per status poll and per freshness
 * tick added up to a third of its CPU (live profile 2026-11-03 18:23Z). Undefined whenever the layout is not the plain one
 * (a worktree's `.git` file, a detached upstream, an unreadable ref): callers then ask git as before.
 */
const SHA = /^[0-9a-f]{40}$/;

function gitDirOf(dir: string): string | undefined {
  const g = path.join(dir, ".git");
  try {
    return fs.statSync(g).isDirectory() ? g : undefined;
  } catch {
    return undefined;
  }
}

function refSha(gitDir: string, ref: string): string | undefined {
  if (!/^refs\/[\w./-]+$/.test(ref) || ref.includes("..")) return undefined;
  try {
    const s = fs.readFileSync(path.join(gitDir, ref), "utf8").trim();
    if (SHA.test(s)) return s;
  } catch {
    /* packed */
  }
  try {
    for (const line of fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8").split("\n")) {
      const [sha, name] = line.split(" ");
      if (name === ref && SHA.test(sha)) return sha;
    }
  } catch {
    /* none */
  }
  return undefined;
}

/** HEAD's branch ref (`refs/heads/main`), or undefined when detached or unreadable. */
function headRef(gitDir: string): string | undefined {
  try {
    return /^ref: (refs\/heads\/\S+)$/.exec(fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim())?.[1];
  } catch {
    return undefined;
  }
}

/** The sha HEAD points at, from the files. */
export function headSha(dir: string): string | undefined {
  const g = gitDirOf(dir);
  if (!g) return undefined;
  let head: string;
  try {
    head = fs.readFileSync(path.join(g, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (SHA.test(head)) return head;
  const ref = /^ref: (\S+)$/.exec(head)?.[1];
  return ref ? refSha(g, ref) : undefined;
}

/** The sha of HEAD's branch on origin (`refs/remotes/origin/<branch>`), from the files. */
export function upstreamSha(dir: string): string | undefined {
  const g = gitDirOf(dir);
  const ref = g && headRef(g);
  return g && ref ? refSha(g, `refs/remotes/origin/${ref.slice("refs/heads/".length)}`) : undefined;
}

/** HEAD's branch name (`main`), from the files. */
export function headBranch(dir: string): string | undefined {
  const g = gitDirOf(dir);
  return g ? headRef(g)?.slice("refs/heads/".length) : undefined;
}

/** origin/main's sha, from the files (orphan commits are read from it). */
export function originMainSha(dir: string): string | undefined {
  const g = gitDirOf(dir);
  return g ? refSha(g, "refs/remotes/origin/main") : undefined;
}
