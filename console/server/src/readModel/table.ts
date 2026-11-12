import type { DB } from "../db.js";

/**
 * the read model. The console builds it from markdown (spines.py, the tree, the waiting-on-you scan) and
 * keeps the result in console.db, so a restart serves the last list at once. Agents never write it; markdown stays the
 * only source of truth. Dropping the table is safe: it is created again and rebuilt from the spines.
 *
 * One row per view (`key`, see keys.ts): `payload` is the computed JSON, `as_of` when it was computed, `checked_at` the
 * last time the refresher found its inputs unchanged (what the API reports as `asOf`), `read_at` the last request for it.
 */
export function ensureReadModel(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS read_model (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      as_of TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      read_at TEXT,
      computed_ms INTEGER
    );
  `);
}

export interface SnapshotRow {
  key: string;
  asOf: string;
  checkedAt: string;
  readAt?: string;
  computedMs?: number;
}

export function readStamp(db: DB, key: string): SnapshotRow | undefined {
  const r = db.prepare("SELECT key, as_of, checked_at, read_at, computed_ms FROM read_model WHERE key = ?").get(key) as
    | { key: string; as_of: string; checked_at: string; read_at: string | null; computed_ms: number | null }
    | undefined;
  return r && { key: r.key, asOf: r.as_of, checkedAt: r.checked_at, ...(r.read_at ? { readAt: r.read_at } : {}), ...(r.computed_ms !== null ? { computedMs: r.computed_ms } : {}) };
}

export function readPayload(db: DB, key: string): { payload: string; asOf: string; checkedAt: string } | undefined {
  const r = db.prepare("SELECT payload, as_of, checked_at FROM read_model WHERE key = ?").get(key) as { payload: string; as_of: string; checked_at: string } | undefined;
  return r && { payload: r.payload, asOf: r.as_of, checkedAt: r.checked_at };
}

export function writeSnapshot(db: DB, key: string, payload: unknown, at: string, computedMs?: number) {
  db.prepare(
    `INSERT INTO read_model (key, payload, as_of, checked_at, read_at, computed_ms) VALUES (@key, @payload, @at, @at, NULL, @ms)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, as_of = excluded.as_of, checked_at = excluded.checked_at, computed_ms = excluded.computed_ms`,
  ).run({ key, payload: JSON.stringify(payload), at, ms: computedMs ?? null });
}

/** The inputs of these views were found unchanged at `at`: their snapshot is current as of then. */
export function markChecked(db: DB, keys: string[], at: string) {
  if (!keys.length) return;
  const st = db.prepare("UPDATE read_model SET checked_at = ? WHERE key = ? AND checked_at < ?");
  db.transaction(() => {
    for (const k of keys) st.run(at, k, at);
  })();
}

export function markRead(db: DB, keys: string[], at: string) {
  if (!keys.length) return;
  const st = db.prepare("UPDATE read_model SET read_at = ? WHERE key = ?");
  db.transaction(() => {
    for (const k of keys) st.run(at, k);
  })();
}

export function listSnapshotKeys(db: DB): SnapshotRow[] {
  return (db.prepare("SELECT key, as_of, checked_at, read_at, computed_ms FROM read_model").all() as { key: string; as_of: string; checked_at: string; read_at: string | null; computed_ms: number | null }[]).map((r) => ({
    key: r.key,
    asOf: r.as_of,
    checkedAt: r.checked_at,
    ...(r.read_at ? { readAt: r.read_at } : {}),
    ...(r.computed_ms !== null ? { computedMs: r.computed_ms } : {}),
  }));
}

export function deleteSnapshot(db: DB, key: string) {
  db.prepare("DELETE FROM read_model WHERE key = ?").run(key);
}
