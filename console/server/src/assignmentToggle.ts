/**
 * the assignment on/off toggle leaves a run-log line (who, when, on→off / off→on), and "never on" is derived
 * from the log, so "attached off and never switched on" no longer looks like "someone switched it off".
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_TENANT, type DB } from "./db.js";
import type { Identity } from "./auth/identity.js";
import { ownerName } from "./identity.js";

/** Run kind of a toggle line: shown in Activity, never a wake (no usage, no wake counts, no last_run_at bump). */
export const TOGGLE_KIND = "toggle";

/** Who toggled: `X-Console-Actor` header (agents set it), else the owner (the console UI is his). */
export const toggleActor = (header: string | undefined) => header?.trim().slice(0, 80) || ownerName();

/**
 * a world's own desk switches its own world's assignments (its Delivery Manager, or another of its personas with
 * write in that world) with its persona token, through this same PATCH; rule 3 (auth/routeScope.ts) already 404s another
 * world's assignment. The toggle line names the persona behind the token, never "the owner": a world token cannot sign as him.
 */
export const tokenPersonaId = (i: Identity | undefined): string | undefined =>
  i?.kind !== "token" ? undefined : i.personaId ?? (/^persona:(pe_[\w-]+)$/.exec(i.label)?.[1] || undefined);

export function toggleActorFor(db: DB, header: string | undefined, i: Identity | undefined): string {
  if (i?.kind !== "token" || i.tenant === DEFAULT_TENANT) return toggleActor(header);
  const pid = tokenPersonaId(i);
  const name = pid ? (db.prepare("SELECT name FROM personas WHERE id = ?").get(pid) as { name: string } | undefined)?.name : undefined;
  const who = `${name ?? `token ${i.label}`} of ${i.tenant}`;
  const extra = header?.trim().slice(0, 60);
  return (extra && extra !== who ? `${who} (${extra})` : who).slice(0, 120);
}

/**
 * may this caller switch `enabled`? Only a world (not the home world) persona token is judged here: its persona must be of the
 * assignment's world (rule 3 already holds the world) and have write there (persona may_write, or one of its assignments in
 * that world with write on). A persona without write (a read-only Scout, say) gets a refusal; logins, the home world and tokens with no
 * persona (made by the world's owner on the Access page) pass as before.
 */
export function worldToggleRefusal(db: DB, i: Identity | undefined, assignmentId: string): string | undefined {
  if (i?.kind !== "token" || i.tenant === DEFAULT_TENANT) return undefined;
  const pid = tokenPersonaId(i);
  if (!pid) return undefined;
  const world = (db.prepare("SELECT m.tenant_id AS t FROM assignments a JOIN milestones m ON m.id = a.milestone_id WHERE a.id = ?").get(assignmentId) as
    | { t: string }
    | undefined)?.t;
  if (world !== undefined && world !== i.tenant) return `assignment ${assignmentId} is not in world ${i.tenant}`;
  const p = db.prepare("SELECT may_write FROM personas WHERE id = ? AND tenant_id = ?").get(pid, i.tenant) as { may_write: number } | undefined;
  if (!p) return `the token's persona is not a persona of ${i.tenant}`;
  if (p.may_write) return undefined;
  const writes = db
    .prepare("SELECT 1 FROM assignments a JOIN milestones m ON m.id = a.milestone_id WHERE a.persona_id = ? AND m.tenant_id = ? AND a.write_enabled = 1 LIMIT 1")
    .get(pid, i.tenant);
  return writes ? undefined : `only a persona with write in ${i.tenant} (its Delivery Manager, say) switches its assignments`;
}

export const toggleSummary = (from: boolean, to: boolean, by: string) =>
  `toggle ${from ? "on" : "off"}→${to ? "on" : "off"}: switched ${to ? "on" : "off"} by ${by}`;

/** Write one toggle line when `enabled` changed; no line for a no-op PATCH. */
export function logToggle(
  db: DB,
  before: { id: string; milestoneId: string; personaId: string; enabled: boolean },
  after: { enabled: boolean },
  by: string,
): void {
  if (before.enabled === after.enabled) return;
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (id, assignment_id, milestone_id, persona_id, started_at, ended_at, outcome, summary, kind)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(`run_${randomUUID()}`, before.id, before.milestoneId, before.personaId, at, at, toggleSummary(before.enabled, after.enabled, by), TOGGLE_KIND);
}

/**
 * SQL (on `assignments`): 1 when the assignment has ever been on. On now, auto-parked (only an enabled one parks), or a
 * run line only an enabled assignment produces: a toggle, a cadence wake, a park note or a re-arm. Run now alone is not.
 */
export const EVER_ON_SQL = `(assignments.enabled = 1 OR assignments.parked_at IS NOT NULL OR EXISTS (
  SELECT 1 FROM runs r WHERE r.assignment_id = assignments.id AND r.parent_run_id IS NULL
    AND (r.kind = '${TOGGLE_KIND}' OR r.summary LIKE 'Woke on cadence%' OR r.summary LIKE 'parked: %' OR r.summary LIKE 're-armed: %')))`;

/**
 * The assignments that ever produced such a run line, in one pass over the runs, for the assignments list. The
 * per-row EXISTS above scanned every root run of each assignment that is off (121 of 214 live), 62 ms a list on the main
 * server, re-run after nearly every write; the list now reads this set, kept until a run is added (store.ts).
 */
export const EVER_ON_IDS_SQL = `SELECT DISTINCT assignment_id FROM runs WHERE parent_run_id IS NULL AND assignment_id IS NOT NULL
  AND (kind = '${TOGGLE_KIND}' OR summary LIKE 'Woke on cadence%' OR summary LIKE 'parked: %' OR summary LIKE 're-armed: %')`;
