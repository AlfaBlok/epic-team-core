import fs from "node:fs";
import path from "node:path";

/**
 * An epic's archive: its finished rows, moved out of its Issue Ledger into `<stem>.archive.md` beside it,
 * ids kept, so a big epic stays short. The archive is a page, never a second epic: its title does not start with
 * `EPIC-<n>:` and it has no `Spine ID:` line (the skill's spines.py lists only epics), and it names its epic on an
 * `Archive of: [EPIC-907 …](<stem>.md)` line. Every lookup of a row by id (a closed card, a key result's work, a row
 * read by path) reads the archive the same way as the ledger when the row is not in the ledger any more.
 */
export const ARCHIVE_SUFFIX = ".archive.md";

/** `docs/spines/x.archive.md` is an archive. */
export function isArchiveRel(rel: string): boolean {
  return rel.endsWith(ARCHIVE_SUFFIX);
}

/** the archive beside spine `rel` (`docs/spines/x.md` → `docs/spines/x.archive.md`); undefined for an archive itself. */
export function archiveRelOf(rel: string): string | undefined {
  if (!rel.endsWith(".md") || isArchiveRel(rel)) return undefined;
  return rel.slice(0, -3) + ARCHIVE_SUFFIX;
}

/** the spine an archive belongs to (`docs/spines/x.archive.md` → `docs/spines/x.md`); a spine is its own. */
export function sourceRelOf(rel: string): string {
  return isArchiveRel(rel) ? rel.slice(0, -ARCHIVE_SUFFIX.length) + ".md" : rel;
}

/** the epic code an archive names on its `Archive of:` line (`Archive of: [EPIC-907: …](x.md)`). */
export function archiveEpicCode(text: string): string | undefined {
  const line = /^Archive of:\s*(.+)$/m.exec(text)?.[1];
  return line ? /\bEPIC-\d+[A-Z]?\b/.exec(line)?.[0] : undefined;
}

/** the text of spine `abs`'s archive, when it has one. */
export function readArchiveOf(abs: string): string | undefined {
  const a = archiveRelOf(abs);
  if (!a) return undefined;
  try {
    return fs.readFileSync(a, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * spine `rel` and then its archive, as repo-relative paths that exist in `dir`: the order every lookup by id reads them
 * (the ledger wins; the archive answers only for a row the ledger no longer holds).
 */
export function withArchive(dir: string, rel: string): string[] {
  const a = archiveRelOf(rel);
  return a && fs.existsSync(path.join(dir, a)) ? [rel, a] : [rel];
}
