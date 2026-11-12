import type { DB } from "../db.js";

/**
 * provider + model per persona. Additive and idempotent by name like's ensureTenancy (no
 * user_version bump, safe with parallel lanes): a world default on tenants, a persona override, and on runs what the
 * dispatcher picked. NULL everywhere means today: the seat pool and the persona's own model.
 */
export const PROVIDER_COLUMNS: [table: string, column: string][] = [
  ["tenants", "default_provider"],
  ["tenants", "default_model"],
  ["personas", "provider"],
  ["runs", "provider"],
  ["runs", "provider_instance"],
  ["runs", "model"],
  ["runs", "price_key"],
  ["runs", "notional"],
];

const cols = (db: DB, t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));

export function ensureProviders(db: DB): void {
  db.transaction(() => {
    const have = new Map<string, Set<string>>();
    for (const [t, c] of PROVIDER_COLUMNS) {
      if (!have.has(t)) have.set(t, cols(db, t));
      if (!have.get(t)!.has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${c === "notional" ? "INTEGER" : "TEXT"}`);
    }
    // What a home thread was launched on: later wakes sent into it run on the same instance + model (stamped from here).
    db.exec(`CREATE TABLE IF NOT EXISTS provider_threads (
      thread_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_instance TEXT NOT NULL,
      model TEXT NOT NULL,
      price_key TEXT NOT NULL,
      notional INTEGER NOT NULL,
      at TEXT NOT NULL
    )`);
  })();
}
