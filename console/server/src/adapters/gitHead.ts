import fs from "node:fs";
import path from "node:path";

/**
 * the commit a checkout's HEAD points at, read from the.git files (no git spawn: spawning on the request path
 * blocks the event loop). Handles a `.git` file (worktree / submodule `gitdir:`), `commondir`, loose and packed refs.
 * Undefined when it cannot be read; callers then fall back to their own expiry.
 */
export function headOf(repoDir: string): string | undefined {
  try {
    let gitDir = path.join(repoDir, ".git");
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"));
      if (!m) return undefined;
      gitDir = path.resolve(repoDir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
    let common = gitDir;
    try {
      common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    } catch {
      /* not a linked worktree */
    }
    for (const dir of [gitDir, common]) {
      try {
        const sha = fs.readFileSync(path.join(dir, ref), "utf8").trim();
        if (sha) return sha;
      } catch {
        /* next */
      }
    }
    const packed = fs.readFileSync(path.join(common, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) if (line.endsWith(` ${ref}`)) return line.slice(0, line.indexOf(" "));
    return undefined;
  } catch {
    return undefined;
  }
}
