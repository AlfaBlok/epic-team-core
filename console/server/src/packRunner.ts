import { execFile } from "./spawnHost.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * EpicSpine's pack export runner (`python3 <skill>/scripts/pack.py <pack> --json --repo <dir>`). Moved unchanged
 * from social/packExport.ts: the read config makes the runner, the social layer reads the social pack with it.
 */
/** Runs the export for one checkout; resolves with its stdout. */
export type PackRunner = (repoDir: string) => Promise<string>;

export const PACK_TIMEOUT_MS = 20_000;
const SCRIPT = path.join("scripts", "pack.py");

/**
 * Skill dir with the pack export (scripts/pack_export.py), first found: `preferred` (the console's resolved skill dir),
 * EPICSPINE_SKILL_DIR, ~/.claude/skills/epic-spine, ~/.agents/skills/epic-spine, then the epicspine-skill checkout
 * (~/github/epicspine-skill/skill/epic-spine) for a host whose installed copy predates the export.
 */
export function resolvePackSkillDir(env: NodeJS.ProcessEnv, home = os.homedir(), preferred?: string): string | undefined {
  const cands = [
    preferred,
    env.EPICSPINE_SKILL_DIR,
    path.join(home, ".claude/skills/epic-spine"),
    path.join(home, ".agents/skills/epic-spine"),
    path.join(home, "github/epicspine-skill/skill/epic-spine"),
  ];
  for (const c of cands) {
    if (!c) continue;
    try {
      const dir = fs.realpathSync(c);
      if (fs.statSync(path.join(dir, "scripts", "pack_export.py")).isFile() && fs.statSync(path.join(dir, SCRIPT)).isFile()) return dir;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export function packPyRunner(skillDir: string, opts: { python?: string; timeoutMs?: number; pack?: string } = {}): PackRunner {
  const script = path.join(skillDir, SCRIPT);
  const timeout = opts.timeoutMs ?? PACK_TIMEOUT_MS;
  return (repoDir) =>
    new Promise((resolve, reject) => {
      execFile(
        opts.python ?? "python3",
        [script, opts.pack ?? "social", "--json", "--repo", repoDir],
        { timeout, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const why = err.killed ? `timed out after ${timeout} ms` : String(stderr || err.message).trim().split("\n").pop();
            return reject(new Error(`pack.py: ${why}`));
          }
          resolve(stdout);
        },
      );
    });
}

