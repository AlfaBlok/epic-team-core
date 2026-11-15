import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRepo } from "../adapters/repos.js";
import { homeRepo, ownerName } from "../identity.js";

/**
 * E996-S43 (the owner, Team desk 2026-11-13 20:52Z, after T9-A10: "It took huge numbert of attempts had to beg for details,
 * and in the end had to look upmyself where to paste the key"): no ask reaches him until a fresh agent completes it from
 * the card alone. scripts/ask_dryrun.py gives a fresh model ONLY the card's words and links (no repo, no spine), opens
 * every link itself and asks per step: is the exact place named, does it exist now, could I do it from these words alone.
 * Its verdicts sit in the home repo's docs/asks/dry-runs.json, keyed by the ask's raw spine line (`lineHash`), so an ask
 * whose words change is dry-run again. This gate (rule 8 of inbox/askGate.ts) holds back:
 *  - an ask whose current words failed: "ask needs rewriting: step N <why>";
 *  - an ask raised from DRY_RUN_FROM whose current words have no verdict yet: "waiting for its dry run".
 * Older open asks with no verdict pass until the sweep (every 15 min, agent-team-ask-dryrun.timer) reaches them.
 */
export const DRY_RUN_FILE = "docs/asks/dry-runs.json";
/** the day new asks start waiting for their dry run (the sweep of 2026-11-13 covered every ask open that day). */
export const DRY_RUN_FROM = "2026-11-14";

export interface DryRunVerdict {
  repo: string;
  path: string;
  code?: string;
  lineHash: string;
  verdict: "pass" | "fail";
  reason?: string;
  at?: string;
}

/** The hash both sides use: sha1 of the raw ask line, trimmed, inner whitespace collapsed (ask_dryrun.py line_hash). */
export function lineHash(raw: string): string {
  return createHash("sha1").update(raw.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16);
}

export function parseDryRuns(text: string): Map<string, DryRunVerdict> {
  const out = new Map<string, DryRunVerdict>();
  const j = JSON.parse(text) as { items?: Record<string, unknown> };
  for (const v of Object.values(j.items ?? {})) {
    const x = v as Partial<DryRunVerdict>;
    if (typeof x?.lineHash !== "string" || (x.verdict !== "pass" && x.verdict !== "fail")) continue;
    out.set(x.lineHash, x as DryRunVerdict);
  }
  return out;
}

/** The home repo's verdicts, read again when the file changes (like pagesIndex.ts). */
export function createDryRunReader(o: { reposRoot: string; home?: string }) {
  let cached: { file: string; mtime: number; map: Map<string, DryRunVerdict> } | null = null;
  const read = (): Map<string, DryRunVerdict> | undefined => {
    const dir = resolveRepo(o.reposRoot, o.home ?? homeRepo())?.path;
    if (!dir) return undefined;
    const file = path.join(dir, DRY_RUN_FILE);
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    if (cached && cached.file === file && cached.mtime === mtime) return cached.map;
    try {
      cached = { file, mtime, map: parseDryRuns(fs.readFileSync(file, "utf8")) };
      return cached.map;
    } catch {
      return cached?.map;
    }
  };
  /** the verdicts as read now, and when the file last changed (part of a memo key: new verdicts re-gate every world). */
  return Object.assign(read, { stamp: (): number => (read(), cached?.mtime ?? 0) });
}

/**
 * Why this open ask must wait (its dry run failed, or a new ask has none yet); undefined when it may reach the owner.
 * `raw` is the ask's line as the spine has it; `since` the ask's date (undefined = raised through the API now).
 */
export function dryRunProblem(raw: string | undefined, since: string | null | undefined, verdicts: Map<string, DryRunVerdict> | undefined): string | undefined {
  if (raw === undefined || !verdicts) return undefined;
  const v = verdicts.get(lineHash(raw));
  if (v?.verdict === "fail") return `ask needs rewriting: ${v.reason ?? "a fresh agent could not do it from the card alone"} (E996-S43 dry run)`;
  if (v) return undefined;
  if (since === undefined || (!!since && since >= DRY_RUN_FROM))
    return `waiting for its dry run: a fresh agent has not yet done it from the card alone, so it does not reach ${ownerName()} yet (E996-S43, every 15 min)`;
  return undefined;
}
