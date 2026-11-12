import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app.js";
import { openDb, type DB } from "../../src/db.js";
import { bookStore } from "../../src/book/service.js";

/**
 * a fresh console.db with every table the server can create: openDb (migrations, ensureColumns, ensureTenancy),
 * createApp (every module it mounts creates its own tables), then every exported `ensure*` / `migrate*` function in
 * src that takes only the db (tables some modules create lazily, on first use). Found by a scan, so a new module's
 * ensure function is run without anyone adding it here.
 */
export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/** the hosted tree's server source, when it sits beside core/ (its modules create tables and hold routes too) */
export const HOSTED_SRC = path.resolve(SRC, "../../../../hosted/console/server/src");
export const SRC_ROOTS = [SRC, ...(fs.existsSync(HOSTED_SRC) ? [HOSTED_SRC] : [])];

/** a source file's path relative to its own tree's src (core or hosted), e.g. `companyOps.ts` */
export function srcRel(file: string): string {
  const root = SRC_ROOTS.find((r) => !path.relative(r, file).startsWith("..")) ?? SRC;
  return path.relative(root, file);
}

/** the file at `rel` under whichever tree's src has it (core first) */
export function srcPath(rel: string): string {
  return SRC_ROOTS.map((r) => path.join(r, rel)).find((p) => fs.existsSync(p)) ?? path.join(SRC, rel);
}

export function srcFiles(dir?: string): string[] {
  if (dir === undefined) return SRC_ROOTS.flatMap((r) => srcFiles(r));
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? srcFiles(p) : /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

/** `export function ensureX(db: DB)` (or with defaulted extra arguments only), per file. */
const ENSURE = /export function ((?:ensure|migrate)\w*)\(\s*(?:db|d): DB((?:,\s*\w+(?::[^=,)]+)?\s*=\s*[^,)]+)*)\s*\)/g;

export function ensureFunctions(): { file: string; name: string }[] {
  return srcFiles().flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(ENSURE)].map((m) => ({ file, name: m[1]! })));
}

export async function fullDb(): Promise<DB> {
  const db = openDb(":memory:");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e62s3-db-")); // no real checkouts read (team repo, spines)
  createApp(db, { staticDir: path.join(root, "nope"), read: { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [] } });
  for (const f of ensureFunctions()) {
    const mod = (await import(f.file)) as Record<string, unknown>;
    const fn = mod[f.name];
    if (typeof fn === "function") (fn as (d: DB) => void)(db);
  }
  bookStore(db, () => {}); // the Book cache is created by its store (createApp makes one only when spines.py is configured)
  return db;
}

export function tablesOf(db: DB): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

export function columnsOf(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
}
