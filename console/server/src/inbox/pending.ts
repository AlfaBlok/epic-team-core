import type { DB } from "../db.js";
import { asksFor } from "./asks.js";
import { NO_PUSH, sameText } from "./spineWrite.js";

/**
 * an answer in a repo whose Integration policy needs a PR never got out of `queued` (the memory service, answered
 * 2026-10-25 03:21Z: spine write skipped, "the console does not push", the asker wrote the line through its own PR
 * f9e26a3, the card still said queued a week later). The console still never pushes there (git-doctrine: no PR from
 * the console); instead the answer moves on in two steps:
 * 1. `delivered` once the asker's wake carries the note (woken or steered) and the write was refused by the policy:
 *    "delivered, spine line pending in <repo> PR" (the asker writes the line in itself);
 * 2. `sent` (spine written) once the spine shows the `[answered …]` line, whoever wrote it: checked on every read of
 *    the inbox, throttled.
 */
export const pendingNote = (repo: string) => `delivered, spine line pending in ${repo} PR`;
/** The spine reason once the asker's own PR put the line in. */
export const WRITTEN_BY_ASKER = "written by the asker through the repo's own PR flow (the console does not push here)";
/** A spine write refused by the repo's Integration policy or Deploy gate (spineWrite.pushPolicy). */
export const isPolicySkip = (reason?: string | null) => !!reason && reason.endsWith(NO_PUSH);

/** Step 1: queued → delivered, only for a policy refusal whose asker got the note. True when the row changed. */
export function markDelivered(db: DB, id: string, repo: string, at = new Date().toISOString()): boolean {
  return (
    db
      .prepare(
        `UPDATE jordi_responses SET delivery = 'delivered', delivery_error = ?, delivered_at = COALESCE(delivered_at, ?)
         WHERE id = ? AND delivery = 'queued' AND spine_status = 'skipped' AND wake_status IN ('woken', 'steered') AND spine_reason LIKE ?`,
      )
      .run(pendingNote(repo), at, id, `%${NO_PUSH}`).changes > 0
  );
}

type Pending = { id: string; milestone_id: string | null; item: string; spine_path: string | null; created_at: string };

/**
 * Step 2: every answer whose spine write was skipped (queued or delivered) and whose spine now has the answered line
 * (matched by ask code, else by question) becomes `sent`, spine `written`. `repoDirOf` gives the milestone's checkout.
 * `spine_at` is the line's done date when it carries one (an old, consumed answer is not shown again as a fresh done card).
 * Returns the ids it settled.
 */
export function settleWritten(db: DB, repoDirOf: (milestoneId: string) => string | undefined, now = new Date().toISOString()): string[] {
  const rows = db
    .prepare(`SELECT id, milestone_id, item, spine_path, created_at FROM jordi_responses WHERE spine_status = 'skipped' AND delivery IN ('queued', 'delivered')`)
    .all() as Pending[];
  const out: string[] = [];
  for (const r of rows) {
    let item: { source?: string; decidedBy?: string; path?: string; code?: string; question?: string; title?: string };
    try {
      item = JSON.parse(r.item || "{}");
    } catch {
      continue;
    }
    if (item.source === "needs_jordi" || item.decidedBy) continue;
    const rel = r.spine_path ?? item.path;
    const dir = r.milestone_id ? repoDirOf(r.milestone_id) : undefined;
    if (!rel || !dir) continue;
    const q = sameText(item.question ?? item.title ?? "");
    const hit = asksFor(dir, rel).find(
      (a) => a.state === "answered" && !a.supersededBy && ((!!item.code && a.code === item.code) || (!!q && sameText(a.question) === q)),
    );
    if (!hit) continue;
    const done = hit.doneAt && /^\d{4}-\d{2}-\d{2}/.test(hit.doneAt) ? `${hit.doneAt.slice(0, 10)}T00:00:00.000Z` : undefined;
    const at = done && done >= r.created_at.slice(0, 10) ? done : now;
    db.prepare(
      `UPDATE jordi_responses SET delivery = 'sent', delivery_error = NULL, delivered_at = COALESCE(delivered_at, ?), spine_status = 'written', spine_reason = ?, spine_at = ? WHERE id = ?`,
    ).run(now, WRITTEN_BY_ASKER, at, r.id);
    out.push(r.id);
  }
  return out;
}
