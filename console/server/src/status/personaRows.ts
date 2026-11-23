import fs from "node:fs";
import path from "node:path";
import { TICKET_CODE, SPINE_PATH } from "./orphanCommits.js";

/**
 * every persona commit names its row. Commits from personas' daily jobs (the digest cards the console writes for a
 * persona, a persona's own daily wake) named no row and landed on the Delivery Manager's list of commits nobody can
 * find. Each persona's standing row lives in the one catalog of what the team does (docs/functions/catalog.json, a
 * `row` on its `{kind: "persona"}` line): the row that made the persona and holds its daily job. `"milestone"` = a
 * persona that works one milestone at a time (the Delivery Manager, the Watcher): it names the row it works, else its
 * milestone's spine path. The console names the row in the commits it writes for a persona (team cards, the owner's
 * answers on them) and tells each persona its row in its wake prompt.
 */

export const CATALOG_FILE = "docs/functions/catalog.json";
export const PER_MILESTONE = "milestone";

type Lives = { kind?: string; name?: string; row?: string }[];
const memo = new Map<string, { mtime: number; rows: Map<string, string> }>();

/** persona name (lower case) → its standing row (a row code or "milestone"), read from the home repo's catalog. */
export function personaRows(homeDir: string | undefined): Map<string, string> {
  if (!homeDir) return new Map();
  const file = path.join(homeDir, CATALOG_FILE);
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return new Map();
  }
  const hit = memo.get(file);
  if (hit && hit.mtime === mtime) return hit.rows;
  const rows = new Map<string, string>();
  try {
    const cat = JSON.parse(fs.readFileSync(file, "utf8")) as { functions?: { lives?: Lives }[] };
    for (const f of cat.functions ?? [])
      for (const l of f.lives ?? [])
        if (l.kind === "persona" && l.name && typeof l.row === "string" && l.row.trim() && !rows.has(l.name.toLowerCase())) rows.set(l.name.toLowerCase(), l.row.trim());
  } catch {
    return new Map();
  }
  memo.set(file, { mtime, rows });
  return rows;
}

/** the persona's standing row code; undefined for a per-milestone persona or one the catalog gives none. */
export function standingRow(homeDir: string | undefined, persona: string): string | undefined {
  const r = personaRows(homeDir).get(persona.trim().toLowerCase());
  return r && r !== PER_MILESTONE ? r : undefined;
}

/** `msg` with `row` in front, unless it already names a row or spine path (or no row is known). */
export function withRow(msg: string, row: string | undefined): string {
  if (!row || TICKET_CODE.test(msg) || SPINE_PATH.test(msg)) return msg;
  return `${row} ${msg}`;
}

/** The wake prompt's line: the row (or spine path) every commit of this persona names. */
export function standingRowSection(persona: string, row: string | undefined, spinePath: string): string {
  const name = row
    ? `Your standing row is ${row}: your daily job lives there.`
    : `You work one milestone at a time: name the row you work, else the milestone's spine path \`${spinePath}\`.`;
  return [
    "## Every commit names its row",
    `${name} Every commit message you make names its row code in the subject (\`${row ?? "<row>"} ${persona}: …\`); ` +
      "a commit for another row names that row instead. A commit that names no row lands on the Delivery Manager's list of commits nobody can find.",
  ].join("\n");
}
