import type { DB } from "./db.js";

/**
 * a number that changes whenever a table's rows change, from any connection (the console, its press worker,
 * the indexer process), so a read can keep its parsed rows until then. Three triggers count every insert, update and
 * delete in `table_versions`; reading it is one indexed row. The inbox read every stored answer (570 rows, 1.6 MB of
 * JSON) and parsed each one twice on every request; now it parses them once per change.
 *
 * Additive and idempotent (CREATE ... IF NOT EXISTS). A database this console may not write (a passive copy) gives no
 * version: the caller reads fresh every time, as before.
 */
export function tableVersion(db: DB, table: string): () => number | undefined {
  if (!/^\w+$/.test(table)) throw new Error(`not a table name: ${table}`);
  try {
    const bump = `UPDATE table_versions SET n = n + 1 WHERE name = '${table}';`;
    db.exec(`
      CREATE TABLE IF NOT EXISTS table_versions (name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO table_versions (name, n) VALUES ('${table}', 0);
      CREATE TRIGGER IF NOT EXISTS ${table}_version_insert AFTER INSERT ON ${table} BEGIN ${bump} END;
      CREATE TRIGGER IF NOT EXISTS ${table}_version_update AFTER UPDATE ON ${table} BEGIN ${bump} END;
      CREATE TRIGGER IF NOT EXISTS ${table}_version_delete AFTER DELETE ON ${table} BEGIN ${bump} END;
    `);
    const read = db.prepare("SELECT n FROM table_versions WHERE name = ?").pluck();
    return () => {
      try {
        return read.get(table) as number | undefined;
      } catch {
        return undefined;
      }
    };
  } catch {
    return () => undefined;
  }
}
