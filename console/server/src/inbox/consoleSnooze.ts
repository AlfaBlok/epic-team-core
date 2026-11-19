import type { DB } from "../db.js";
import { snoozedNow } from "./asks.js";

/**
 * a snooze on a card with no ask line to write the date on (a red node, a free-text `Waiting on:`, a row
 * on the owner: `source: "heuristic"`). Before, the press failed ("only an ask written in a spine can be snoozed",
 * 3 of his presses on 18 Nov 20:34Z). The console keeps the date here and the inbox hides the card until then, as
 * it does for a dated ask line. It holds only his choice to hide a card for a while (the card itself still comes from
 * the spine, root L-45); an ask line's snooze stays on its line.
 */
export function ensureConsoleSnoozes(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS console_snoozes (item_id TEXT PRIMARY KEY, until TEXT NOT NULL, by TEXT, at TEXT NOT NULL)`);
}

/** keep (or, `until` undefined, drop) the snooze of item `id`; true when something changed. */
export function setConsoleSnooze(db: DB, id: string, until: string | undefined, by?: string): boolean {
  ensureConsoleSnoozes(db);
  if (!until) return db.prepare("DELETE FROM console_snoozes WHERE item_id = ?").run(id).changes > 0;
  const was = (db.prepare("SELECT until FROM console_snoozes WHERE item_id = ?").get(id) as { until: string } | undefined)?.until;
  if (was === until) return false;
  db.prepare("INSERT INTO console_snoozes (item_id, until, by, at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET until = excluded.until, by = excluded.by, at = excluded.at").run(
    id,
    until,
    by ?? null,
    new Date().toISOString(),
  );
  return true;
}

/** the snoozes still ahead, by item id (a passed one is left out; it is dropped the next time one is kept). */
export function consoleSnoozes(db: DB, now = Date.now()): Map<string, string> {
  try {
    const rows = db.prepare("SELECT item_id, until FROM console_snoozes").all() as { item_id: string; until: string }[];
    return new Map(rows.filter((r) => snoozedNow(r.until, now)).map((r) => [r.item_id, r.until]));
  } catch {
    return new Map(); // no table yet (nothing was ever snoozed this way), or a read-only copy
  }
}
