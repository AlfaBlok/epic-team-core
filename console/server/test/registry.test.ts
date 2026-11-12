import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { DB_REGISTRY, TRANSIENT_TABLES, registryColumns, violationColumns, violationTables } from "../src/dbRegistry.js";
import { columnsOf, fullDb, srcFiles, srcPath, srcRel, tablesOf } from "./helpers/fullDb.js";

/**
 * every console.db table and column is declared in src/dbRegistry.ts as cache, ops or a
 * known violation. A new table or column fails here until it is declared; a new violation fails here, full stop.
 */
const RULE =
  "root L-45: the repo is the only source of work state and decisions; console.db holds only caches rebuilt from the repo and operational data. Declare it in core/console/server/src/dbRegistry.ts as `cache` (with its writer) or `ops`, with a one-line reason; a decision or work state goes into the spine instead.";

/**
 * The known violations, frozen at the audit (2026-11-02). This list may only shrink: the fix rows (S4..S8)
 * remove their names as they move the decision into the repo. Never add a name here (L-45).
 */
const FROZEN_VIOLATION_TABLES: string[] = []; // removed review_items, review_links; needs_jordi; rubric_settings (repo file + spine line)
const FROZEN_VIOLATION_COLUMNS: string[] = []; // S6, S7: milestones, personas and assignments columns are now indexes of team-repo files (`index` in the registry); jordi_responses.spine_status is a delivery log, never read as answered

/** What is wrong with a booted DB against the registry (empty = fine). Also used by the demo below. */
export function registryProblems(db: DB): string[] {
  const out: string[] = [];
  const have = new Set(tablesOf(db));
  for (const t of have) if (!DB_REGISTRY[t]) out.push(`table ${t} is not in the schema registry`);
  for (const t of Object.keys(DB_REGISTRY)) if (!have.has(t)) out.push(`registry entry ${t} has no table (dropped? remove its entry)`);
  for (const t of have) {
    if (!DB_REGISTRY[t]) continue;
    const cols = columnsOf(db, t);
    const reg = new Set(registryColumns(t));
    for (const c of cols) if (!reg.has(c)) out.push(`column ${t}.${c} is not in the schema registry`);
    for (const c of reg) if (!cols.includes(c)) out.push(`registry column ${t}.${c} is not in the table (dropped? remove it)`);
  }
  return out;
}

/** Table names in every `CREATE TABLE` in src (a `${CONST}` name resolved from `CONST = "name"` in the same file). */
function createdInSource(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of srcFiles()) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\$\{(\w+)\}|["`]?(\w+))/gi)) {
      let name = m[2];
      if (m[1]) name = new RegExp(`\\b${m[1]}\\s*=\\s*["'\`](\\w+)["'\`]`).exec(text)?.[1] ?? `\${${m[1]}}`;
      out.set(name!, [...(out.get(name!) ?? []), srcRel(f)]);
    }
  }
  return out;
}

let db: DB;
beforeAll(async () => {
  db = await fullDb();
});

describe("E962-S3 schema registry", () => {
  it("every table and column of a freshly booted console.db is in the registry, and every entry has its table", () => {
    const problems = registryProblems(db);
    expect(problems, `${problems.join("\n")}\n${RULE}`).toEqual([]);
  });

  it("every CREATE TABLE in src is in the registry (tables a boot does not create, too)", () => {
    const src = createdInSource();
    const unknown = [...src].filter(([t]) => !DB_REGISTRY[t] && !TRANSIENT_TABLES[t]).map(([t, f]) => `${t} (${f.join(", ")})`);
    expect(unknown, `CREATE TABLE of tables not in the registry: ${unknown.join("; ")}\n${RULE}`).toEqual([]);
    const notCreated = Object.keys(DB_REGISTRY).filter((t) => !src.has(t));
    expect(notCreated, "registry entries no CREATE TABLE in src creates").toEqual([]);
  });

  it("each entry is complete: a reason; cache tables name their writer; violations name their fixing row", () => {
    for (const [t, e] of Object.entries(DB_REGISTRY)) {
      expect(e.reason.trim().length, `${t}: reason`).toBeGreaterThan(5);
      if (e.class === "cache") expect(e.writers?.length, `${t}: a cache table names its writers (the indexer)`).toBeGreaterThan(0);
      if (e.class === "violation") expect(e.fix, `${t}: a violation names its fixing row`).toMatch(/^E62-S\d+$/);
      for (const [c, fix] of Object.entries(e.violationColumns ?? {})) {
        expect(registryColumns(t), `${t}.${c}: a violation column is a column`).toContain(c);
        expect(fix, `${t}.${c}: fixing row`).toMatch(/^E62-S\d+$/);
      }
      for (const c of e.grey?.columns ?? []) expect(registryColumns(t), `${t}.${c}: a grey column is a column`).toContain(c);
      for (const w of e.writers ?? []) expect(fs.existsSync(srcPath(w)), `${t}: writer ${w} exists`).toBe(true);
    }
  });

  it("the violation lists only shrink: no table or column may become a new violation", () => {
    const newTables = violationTables().filter((t) => !FROZEN_VIOLATION_TABLES.includes(t));
    expect(newTables, `new violation tables ${newTables.join(", ")}: the violation list may only shrink. ${RULE}`).toEqual([]);
    const newCols = violationColumns().filter((c) => !FROZEN_VIOLATION_COLUMNS.includes(c));
    expect(newCols, `new violation columns ${newCols.join(", ")}: the violation list may only shrink. ${RULE}`).toEqual([]);
  });

  it("demo: a dummy table, or a column added to an ops table, fails the registry check", () => {
    db.exec("CREATE TABLE e62_dummy (id TEXT PRIMARY KEY, decision TEXT)");
    db.exec("ALTER TABLE tenants ADD COLUMN approved_by_jordi TEXT");
    try {
      expect(registryProblems(db)).toEqual(["table e62_dummy is not in the schema registry", "column tenants.approved_by_jordi is not in the schema registry"]);
    } finally {
      db.exec("DROP TABLE e62_dummy");
      db.exec("ALTER TABLE tenants DROP COLUMN approved_by_jordi");
    }
    expect(registryProblems(db)).toEqual([]);
  });
});
