/**
 * The claim written in a ledger row's Owner cell by `spines.py --claim` (`<by> — claimed <UTC>, lease until <UTC>`),
 * shown beside the row wherever rows are listed (a second wheel sees the row is taken before it dispatches).
 */
export interface RowClaim {
  by: string;
  at: string;
  until: string;
  /** the lease's end has passed (the console's sweep gives the row back unless the holder's commits renewed it). */
  past: boolean;
}
const CLAIM = /^\s*(.+?)\s*[—–-]+\s*claimed (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z), lease until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)/;

export function rowClaim(owner: string | undefined, now = Date.now()): RowClaim | undefined {
  const m = CLAIM.exec((owner ?? "").replace(/[`*]/g, ""));
  if (!m) return undefined;
  return { by: m[1], at: m[2], until: m[3], past: Date.parse(m[3].replace(/Z$/, ":00Z")) <= now };
}

/** `run_1571a767` from a run id, else the holder as written. */
export const shortHolder = (by: string) => (/^run_[0-9a-f]{8}/.test(by) ? by.slice(0, 12) : by);
