import { DEFAULT_TENANT, type DB } from "../db.js";
import { homeWorld } from "../identity.js";

/**
 * a world binds its runs only to its own T3 threads and acts only on
 * seats no other world holds. Steer and stop send into a run's `threadId` on the host's shared T3 client, and stopping a
 * child run releases its `seat` at the broker; both values come from the run's reporter (a wake's PATCH, a manager's
 * child-run POST), so without this check a tester world could record the home world's thread (or `seat1`) on its own run and then
 * steer or interrupt that thread, or free a seat the home world wake holds.
 *
 * A thread belongs to another world when the console knows it under that world: a run, an assignment's home thread or a
 * ticket session of another world, or a platform thread (the Team desk, a handover; the home world's). A thread the console never
 * recorded is not judged here (its id is a random T3 id no world is shown). the home world (the platform) is never refused.
 */

const tryGet = (db: DB, sql: string, ...args: unknown[]): { t?: string } | undefined => {
  try {
    return db.prepare(sql).get(...args) as { t?: string } | undefined;
  } catch {
    return undefined; // a table this db lacks (tests, an older schema): nothing recorded there
  }
};

/** The world of a run (the home world when the row has none). */
export const worldOfRun = (db: DB, runId: string): string =>
  (tryGet(db, "SELECT tenant_id AS t FROM runs WHERE id = ?", runId)?.t as string | undefined) ?? DEFAULT_TENANT;

/** The world of an assignment (through its milestone), or undefined. */
export const worldOfAssignment = (db: DB, assignmentId: string): string | undefined =>
  tryGet(db, "SELECT m.tenant_id AS t FROM assignments a JOIN milestones m ON m.id = a.milestone_id WHERE a.id = ?", assignmentId)?.t;

/** The other world that holds `threadId`, or undefined when no other world is known to hold it. */
export function threadHolder(db: DB, world: string, threadId: string): string | undefined {
  if (world === DEFAULT_TENANT || !threadId) return undefined;
  const other = (sql: string) => tryGet(db, sql, threadId, world)?.t;
  return (
    other("SELECT tenant_id AS t FROM runs WHERE thread_id = ? AND tenant_id != ? LIMIT 1") ??
    other(
      "SELECT m.tenant_id AS t FROM cycle_assignment_link l JOIN assignments a ON a.id = l.assignment_id JOIN milestones m ON m.id = a.milestone_id WHERE l.thread_id = ? AND m.tenant_id != ? LIMIT 1",
    ) ??
    other("SELECT m.tenant_id AS t FROM ticket_session s JOIN milestones m ON m.id = s.milestone_id WHERE s.thread_id = ? AND m.tenant_id != ? LIMIT 1") ??
    (tryGet(db, `SELECT '${homeWorld()}' AS t FROM desk_session WHERE thread_id = ? LIMIT 1`, threadId)?.t ||
      tryGet(db, `SELECT '${homeWorld()}' AS t FROM cycle_handover WHERE thread_id = ? LIMIT 1`, threadId)?.t)
  );
}

/** Why `world` may not bind `threadId` to its run, or undefined. */
export const threadRefusal = (db: DB, world: string, threadId: string | null | undefined): string | undefined => {
  if (!threadId) return undefined;
  const holder = threadHolder(db, world, threadId);
  return holder ? `thread ${threadId} is not a thread of the ${world} world: a run binds only its own world's threads` : undefined;
};

/**
 * True when something outside `world` holds `seat` now: a running run or a server seat hold of another world, the Team
 * desk's live session or a live ticket session of another world. Then this world's stop must not release it at the broker.
 */
export function seatHeldElsewhere(db: DB, world: string, seat: string): boolean {
  if (world === DEFAULT_TENANT) return false;
  const held = (sql: string, ...args: unknown[]) => !!tryGet(db, sql, ...args)?.t;
  return (
    held("SELECT tenant_id AS t FROM runs WHERE seat = ? AND outcome = 'running' AND tenant_id != ? LIMIT 1", seat, world) ||
    held("SELECT r.tenant_id AS t FROM cycle_seat_hold h JOIN runs r ON r.id = h.run_id WHERE h.seat = ? AND r.tenant_id != ? LIMIT 1", seat, world) ||
    held(`SELECT '${homeWorld()}' AS t FROM desk_session WHERE seat = ? AND ended_at IS NULL LIMIT 1`, seat) ||
    held("SELECT m.tenant_id AS t FROM ticket_session s JOIN milestones m ON m.id = s.milestone_id WHERE s.seat = ? AND s.archived_at IS NULL AND m.tenant_id != ? LIMIT 1", seat, world)
  );
}
