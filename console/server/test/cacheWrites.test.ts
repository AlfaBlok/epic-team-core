import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB_REGISTRY, cacheTables } from "../src/dbRegistry.js";
import { srcFiles, srcRel } from "./helpers/fullDb.js";

/**
 * only the indexer writes a cache table. A static scan of core/console/server/src: an INSERT,
 * UPDATE, DELETE or REPLACE on a `cache` table (dbRegistry.ts) outside that table's declared writers fails, and so does
 * a call of the read model's row writers (readModel/table.ts) from outside readModel/.
 */
const WRITE = /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(\w+)/gi;
const ROW_WRITERS = /\b(writeSnapshot|deleteSnapshot|markChecked|markRead)\s*\(/g;

const allowed = (table: string, rel: string) => (DB_REGISTRY[table]!.writers ?? []).some((w) => (w.endsWith("/") ? rel.startsWith(w) : rel === w));

/** Cache writes in one file's text that its path may not make. */
export function cacheWriteProblems(rel: string, text: string): string[] {
  const caches = new Set(cacheTables());
  const out: string[] = [];
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(WRITE)) {
    const t = m[2]!;
    if (caches.has(t) && !allowed(t, rel)) out.push(`${rel}:${lineOf(m.index!)} ${m[1]!.toUpperCase()} ${t}: only ${DB_REGISTRY[t]!.writers!.join(", ")} may write the cache table ${t}`);
  }
  if (!rel.startsWith("readModel/"))
    for (const m of text.matchAll(ROW_WRITERS)) if (!/function\s*$/.test(text.slice(Math.max(0, m.index! - 12), m.index!))) out.push(`${rel}:${lineOf(m.index!)} ${m[1]}(): only readModel/ writes read_model rows`);
  return out;
}

describe("T62-S3 only the indexer writes a cache table", () => {
  it("no module outside the declared writers INSERTs, UPDATEs, DELETEs or REPLACEs a cache table", () => {
    const problems = srcFiles().flatMap((f) => cacheWriteProblems(srcRel(f).split(path.sep).join("/"), fs.readFileSync(f, "utf8")));
    expect(problems, `${problems.join("\n")}\nroot L-45: a cache is rebuilt from the repo by its indexer only; write the repo (the spine writer), then refresh the cache.`).toEqual([]);
  });

  it("the scan knows the cache tables and catches a write from elsewhere (demo)", () => {
    expect(cacheTables().sort()).toEqual(["book_cache", "deck_material", "desk_view_cache", "read_model", "repo_index", "review_live", "spines_cache"]); // added deck_material (the epic decks' material facts, written by deck/notify.ts only); spines_cache (indexer/ only)
    expect(cacheWriteProblems("inbox/routes.ts", 'db.prepare("UPDATE read_model SET payload = ? WHERE key = ?")')).toHaveLength(1);
    expect(cacheWriteProblems("app.ts", "db.prepare(`INSERT OR REPLACE INTO book_cache (id) VALUES (1)`)")).toHaveLength(1);
    expect(cacheWriteProblems("review/review.ts", 'db.prepare("DELETE FROM repo_index WHERE host = ?")')).toHaveLength(1);
    expect(cacheWriteProblems("status/x.ts", "writeSnapshot(db, key, payload, at)")).toHaveLength(1);
    expect(cacheWriteProblems("readModel/refresher.ts", "writeSnapshot(db, key, payload, at)")).toEqual([]);
    expect(cacheWriteProblems("desk/repoIndex.ts", 'db.prepare("DELETE FROM repo_index WHERE host = ?")')).toEqual([]);
    expect(cacheWriteProblems("inbox/routes.ts", 'db.prepare("SELECT payload FROM read_model")')).toEqual([]);
  });
});
