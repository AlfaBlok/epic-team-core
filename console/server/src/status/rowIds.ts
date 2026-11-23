import fs from "node:fs";
import path from "node:path";

/**
 * row ids are numbered across the whole repo, never per spine. The console once wrote a new row of one epic with an id
 * its own ledger lacked while another epic's spine already held it (rows moved out of an epic keep their ids). Every id that any spine of the repo names counts as taken, so the next row of an epic code takes the
 * number above the highest one used anywhere.
 */

/** markdown files under the repo's spine folders (docs/spines, recursive; the root spine's folder). */
function spineFiles(repoDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < 4 && !d.name.startsWith(".")) walk(p, depth + 1);
      else if (d.isFile() && d.name.endsWith(".md")) out.push(p);
    }
  };
  walk(path.join(repoDir, "docs", "spines"), 0);
  return out;
}

const cache = new Map<string, { at: number; ids: string[] }>();
const TTL_MS = 5_000;

/**
 * every `<code>-S<n>` row id named in any spine of the repo (e.g. `E907-S3`), as a list for nextCode's `taken`.
 * `codes` limits it to those prefixes (`E907-S`), so the list stays small. Unreadable repo: an empty list.
 */
export function repoRowIds(repoDir: string | undefined, codes?: string[], now = Date.now()): string[] {
  if (!repoDir) return [];
  let hit = cache.get(repoDir);
  if (!hit || now - hit.at > TTL_MS) {
    const ids = new Set<string>();
    for (const f of spineFiles(repoDir)) {
      let t: string;
      try {
        t = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const m of t.matchAll(/(?<![\w-])([A-Z][A-Za-z]*\d*-S)(\d+)(?![\w-])/g)) ids.add(m[1] + m[2]);
    }
    hit = { at: now, ids: [...ids] };
    cache.set(repoDir, hit);
  }
  return codes ? hit.ids.filter((id) => codes.some((c) => id.startsWith(c))) : hit.ids;
}

/** the highest `<prefix><n>` number in `ids` (0 when none). */
export function highestRowNumber(prefix: string, ids: string[]): number {
  let max = 0;
  for (const id of ids) if (id.startsWith(prefix)) {
    const n = Number(id.slice(prefix.length).replace(/[a-z]$/, ""));
    if (Number.isInteger(n)) max = Math.max(max, n);
  }
  return max;
}
