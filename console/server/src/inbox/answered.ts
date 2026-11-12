import { sameText } from "./spineWrite.js";
import type { WaitingItem } from "./waiting.js";

/** The jordi_responses columns the delivery log keeps per answer (a log, never the source of "answered"). */
export type ResponseOutcome = { id: string; item_id: string; replaces_id?: string | null; delivery?: string | null; spine_status?: string | null };

/** an answer that did not land (delivery or spine write failed, e.g. a key not stored). */
export const answerFailed = (r: Pick<ResponseOutcome, "delivery" | "spine_status">): boolean => r.delivery === "failed" || r.spine_status === "failed";

/**
 * Latest response per item: rows in created_at DESC, rowid DESC order; a row a change replaced (`replaces_id`) never wins.
 * Rows must come ordered newest first.
 */
export function latestPerItem<T extends ResponseOutcome>(rows: T[]): Map<string, T> {
  const replaced = new Set(rows.flatMap((r) => (r.replaces_id ? [r.replaces_id] : [])));
  const out = new Map<string, T>();
  for (const r of rows) if (!replaced.has(r.id) && !out.has(r.item_id)) out.set(r.item_id, r);
  return out;
}

/**
 * open items the spine shows answered, the one rule
 * for Waiting on you, flow and counts. An ask is answered when its line is `[answered …]` (the item itself is answered,
 * nothing to add); a free-text item (`Waiting on:` line, red node) is answered when the same spine has an `[answered …]`
 * line for its question. Nothing in console.db counts: an answer whose spine write was skipped, failed or is still
 * pending leaves the ask open (its card shows why, with Retry), on every host and after any cache rebuild.
 */
export function answeredInSpine(items: WaitingItem[]): Set<string> {
  const key = (path: string | undefined, q: string) => `${path ?? ""}\u0000${sameText(q)}`;
  const lines = new Set(items.filter((i) => i.source === "ask" && (i.state === "answered" || i.state === "done")).map((i) => key(i.path, i.question)));
  return new Set(items.filter((i) => i.source === "heuristic" && i.state === "open" && !!i.path && lines.has(key(i.path, i.question))).map((i) => i.id));
}
