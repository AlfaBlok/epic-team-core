import type { DB } from "../db.js";

/**
 * the console and its indexer (indexer/main.ts, a separate niced, CPU-capped process) share
 * console.db and nothing else. Three small tables carry everything between them:
 *  - `indexer_queue`: what the console asks of the indexer (a checkout changed, a view to keep, a drift check, a book
 *    rebuild). The indexer takes the rows every second and deletes them.
 *  - `indexer_kv`: one JSON value per key, both ways (the indexer's heartbeat and drift result, the console's T3 states;
 *    the git blame and first-added answers of the waiting views, so a restart does not ask git again).
 *  - `spines_cache`: the last spines.py output per checkout (spinesCache.ts). The console reads it instead of running
 *    spines.py, and the indexer seeds itself from it, so neither start scans every repo again.
 * Like the read model, all three are a cache of the repos: dropping them is safe (they are created again and refilled).
 */
export function ensureIndexerTables(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexer_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS indexer_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS spines_cache (
      dir TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      ver TEXT,
      started_at INTEGER NOT NULL,
      ran_at INTEGER NOT NULL
    );
  `);
  // the scanner (spines.py and the modules it loads) each output was read with; another one re-reads the repo.
  const cols = db.prepare("PRAGMA table_info(spines_cache)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "scanner")) db.exec("ALTER TABLE spines_cache ADD COLUMN scanner TEXT");
}

/** What the console asks of the indexer. */
export type IndexerMsg =
  | { type: "dirty"; dir?: string; stale?: boolean }
  | { type: "dirtyAll" }
  | { type: "register"; key: unknown }
  | { type: "spines"; dir: string; stale?: boolean }
  | { type: "drift"; confirmAfterMs?: number }
  | { type: "book"; rebuild?: boolean };

export function sendToIndexer(db: DB, m: IndexerMsg, at = new Date().toISOString()) {
  db.prepare("INSERT INTO indexer_queue (msg, at) VALUES (?, ?)").run(JSON.stringify(m), at);
}

/** The indexer side: every waiting message, oldest first, removed in the same transaction. */
export function takeIndexerMsgs(db: DB, max = 500): IndexerMsg[] {
  return db.transaction(() => {
    const rows = db.prepare("SELECT id, msg FROM indexer_queue ORDER BY id LIMIT ?").all(max) as { id: number; msg: string }[];
    if (!rows.length) return [];
    db.prepare("DELETE FROM indexer_queue WHERE id <= ?").run(rows[rows.length - 1].id);
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r.msg) as IndexerMsg];
      } catch {
        return [];
      }
    });
  })();
}

export function kvSet(db: DB, k: string, v: unknown, at = new Date().toISOString()) {
  db.prepare("INSERT INTO indexer_kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at").run(k, JSON.stringify(v), at);
}

export function kvGet<T>(db: DB, k: string): { v: T; at: string } | undefined {
  const r = db.prepare("SELECT v, at FROM indexer_kv WHERE k = ?").get(k) as { v: string; at: string } | undefined;
  if (!r) return undefined;
  try {
    return { v: JSON.parse(r.v) as T, at: r.at };
  } catch {
    return undefined;
  }
}

/** The stamp of a key only (cheap: no JSON), to tell whether it moved. */
export function kvAt(db: DB, k: string): string | undefined {
  return (db.prepare("SELECT at FROM indexer_kv WHERE k = ?").get(k) as { at: string } | undefined)?.at;
}

/** The indexer writes this every few seconds; the console's /api/health reports it. */
export interface IndexerBeat {
  pid: number;
  startedAt: string;
  revision?: string;
  repos: number;
  /** spines.py runs since the start, and how many outputs came from spines_cache instead. */
  runs: number;
  seeded: number;
  book?: string;
}

export const BEAT_KEY = "beat";
export const DRIFT_KEY = "drift";
export const T3_KEY = "t3";

/** The indexer's last heartbeat and its age, undefined when it never ran on this DB. */
export function indexerBeat(db: DB, now = Date.now()): (IndexerBeat & { at: string; ageMs: number }) | undefined {
  try {
    const b = kvGet<IndexerBeat>(db, BEAT_KEY);
    return b ? { ...b.v, at: b.at, ageMs: now - Date.parse(b.at) } : undefined;
  } catch {
    return undefined;
  }
}
