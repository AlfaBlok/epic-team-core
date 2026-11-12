import fs from "node:fs";

/**
 * which files (and directories) a synchronous computation read, with their stamps, so a memo of its result can
 * be revalidated by a few stats instead of being rebuilt. Readers call `noteFile`; `trackDeps` collects the notes of
 * everything it runs (nested tracking also feeds the outer one). Synchronous only: no await inside `trackDeps`.
 */
export type Deps = Map<string, string>;

let active: Deps | undefined;

/** `mtimeMs:size` of a file or directory (a directory's mtime moves when an entry is added or removed); "-" when missing. */
export function stampOf(abs: string): string {
  try {
    const st = fs.statSync(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

/** Record that the running computation read `abs` (stamp as seen by the reader, else stat it now). */
export function noteFile(abs: string, stamp?: string) {
  if (active && !active.has(abs)) active.set(abs, stamp ?? stampOf(abs));
}

export function trackDeps<T>(fn: () => T): { value: T; deps: Deps } {
  const outer = active;
  const deps: Deps = new Map();
  active = deps;
  try {
    return { value: fn(), deps };
  } finally {
    active = outer;
    if (outer) for (const [k, v] of deps) if (!outer.has(k)) outer.set(k, v);
  }
}

/** True when any recorded file or directory has a different stamp now (edited, created, deleted). */
export function depsChanged(deps: Deps): boolean {
  for (const [abs, stamp] of deps) if (stampOf(abs) !== stamp) return true;
  return false;
}
