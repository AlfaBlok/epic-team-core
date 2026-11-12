import type { DB } from "../db.js";
import { errorText, type T3Client } from "../t3/client.js";
import { type HostId, mainHost, workerHost } from "../identity.js";

/**
 * which T3 environment each thread lives on, so the console can link `t3code://threads/<env>/<thread>`
 * (the T3 desktop app's deep link; `t3-thread://v1/<id>` only works inside T3's own chat).
 *
 * - Host → environment id: `CONSOLE_T3_ENV_VPS1` / `CONSOLE_T3_ENV_VPS3` if set, else what that host's T3 answered to
 *   t3_environment_read (kept in `t3_environments`, so a cold the worker server is still known after a restart).
 * - Run → environment id (`runs.environment_id`): stamped by triggers on every insert / thread change: the parent
 *   run's environment (delegate_task creates the child on the parent's T3), else the host of the home thread it is
 *   (cycle_assignment_link), else another run of the same thread. Never from the persona's host: a persona can move
 *   (the Delivery Manager moved the main server → the worker server on 2026-10-23) and its older threads stay where they were.
 * - Backfill: the same rules over rows still unknown, then a T3 read of the thread on each reachable host.
 */
export type Host = HostId;
// the host ids are config: read at call time, a value set after this module loads still counts
const hosts = (): Host[] => [mainHost(), workerHost()];

/** One expression for both triggers (NEW = the run row just written). */
const STAMP = `
  UPDATE runs SET environment_id = COALESCE(
    (SELECT p.environment_id FROM runs p WHERE p.id = NEW.parent_run_id),
    (SELECT e.environment_id FROM cycle_assignment_link l JOIN t3_environments e ON e.host = l.host WHERE l.thread_id = NEW.thread_id),
    (SELECT o.environment_id FROM runs o WHERE o.thread_id = NEW.thread_id AND o.id <> NEW.id AND o.environment_id IS NOT NULL)
  ) WHERE id = NEW.id;`;

export function migrateEnvironments(db: DB) {
  // Needs cycle_assignment_link (migrateCycle) and runs.environment_id + t3_environments (db.ts).
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS runs_env_insert AFTER INSERT ON runs WHEN NEW.environment_id IS NULL AND NEW.thread_id IS NOT NULL
    BEGIN ${STAMP} END;
    CREATE TRIGGER IF NOT EXISTS runs_env_update AFTER UPDATE OF thread_id, parent_run_id ON runs WHEN NEW.environment_id IS NULL AND NEW.thread_id IS NOT NULL
    BEGIN ${STAMP} END;
  `);
}

export interface EnvironmentsDeps {
  db: DB;
  /** The T3 of a host if it can be read now without starting anything (the worker server: tunnel already up); else undefined. */
  clientFor: (host: Host) => T3Client | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** A thread not found on any reachable host is asked again after this long. */
  retryMs?: number;
  /** T3 reads per backfill pass. */
  maxProbes?: number;
}

export function createEnvironments(d: EnvironmentsDeps) {
  const env = d.env ?? process.env;
  const now = d.now ?? Date.now;
  const retryMs = d.retryMs ?? 3600_000;
  const maxProbes = d.maxProbes ?? 20;
  const db = d.db;
  const missed = new Map<string, number>(); // thread id -> last time no reachable host had it

  const override = (h: Host) => env[`CONSOLE_T3_ENV_${h.toUpperCase()}`]?.trim() || undefined;
  /** Writes the env overrides first, so the triggers (which read t3_environments) see them too. */
  const save = (h: Host, id: string) =>
    db.prepare("INSERT INTO t3_environments (host, environment_id, read_at) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET environment_id = excluded.environment_id, read_at = excluded.read_at").run(h, id, new Date(now()).toISOString());
  for (const h of hosts()) if (override(h)) save(h, override(h)!);

  const hostEnvironment = (h: Host): string | undefined =>
    override(h) ?? (db.prepare("SELECT environment_id FROM t3_environments WHERE host = ?").get(h) as { environment_id: string } | undefined)?.environment_id;

  /** Ask a host's T3 for its environment id (no-op with an override or an unreachable host). Never throws. */
  async function refreshHost(h: Host): Promise<string | undefined> {
    if (override(h)) return override(h);
    const c = d.clientFor(h);
    if (!c?.readEnvironmentId) return hostEnvironment(h);
    try {
      const id = await c.readEnvironmentId();
      const before = hostEnvironment(h);
      save(h, id);
      if (before !== id) stamp();
      return id;
    } catch (e) {
      console.error(`t3 environment ${h}:`, errorText(e));
      return hostEnvironment(h);
    }
  }

  /** The trigger rules over every run still unknown (e.g. written before its host's environment id was read). Returns how many got one. */
  function stamp(): number {
    const known = () => (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE environment_id IS NOT NULL").get() as { n: number }).n;
    const start = known();
    let k = start;
    // Repeat so a child whose parent was stamped in this pass follows (bounded: parent chains are short).
    for (let pass = 0; pass < 10; pass++) {
      db.prepare(
        `UPDATE runs SET environment_id = COALESCE(
           (SELECT p.environment_id FROM runs p WHERE p.id = runs.parent_run_id),
           (SELECT e.environment_id FROM cycle_assignment_link l JOIN t3_environments e ON e.host = l.host WHERE l.thread_id = runs.thread_id),
           (SELECT o.environment_id FROM runs o WHERE o.thread_id = runs.thread_id AND o.id <> runs.id AND o.environment_id IS NOT NULL))
         WHERE environment_id IS NULL AND thread_id IS NOT NULL`,
      ).run();
      const next = known();
      if (next === k) break;
      k = next;
    }
    return k - start;
  }

  /** Backfill: stamp, then read each still-unknown thread on the reachable hosts (the main server first). */
  async function backfill(): Promise<{ resolved: number; unresolved: number }> {
    stamp();
    const rows = db
      // Wakes before children (a known parent stamps its children for free), newest first.
      .prepare(
        "SELECT thread_id FROM runs WHERE environment_id IS NULL AND thread_id IS NOT NULL GROUP BY thread_id ORDER BY MIN(parent_run_id IS NOT NULL), MAX(started_at) DESC",
      )
      .all() as { thread_id: string }[];
    const stillUnknown = db.prepare("SELECT 1 FROM runs WHERE thread_id = ? AND environment_id IS NULL LIMIT 1");
    let resolved = 0;
    let probes = 0;
    for (const { thread_id: threadId } of rows) {
      if (probes >= maxProbes) break;
      const last = missed.get(threadId);
      if (last !== undefined && now() - last < retryMs) continue;
      if (!stillUnknown.get(threadId)) continue; // stamped as the child of a thread placed earlier in this pass
      let found: string | undefined;
      let asked = false;
      for (const h of hosts()) {
        const c = d.clientFor(h);
        const envId = hostEnvironment(h);
        if (!c || !envId) continue;
        probes++;
        asked = true;
        const ok = await c.readThreadStatus(threadId).then(() => true, () => false);
        if (ok) {
          found = envId;
          break;
        }
      }
      if (!found) {
        if (asked) missed.set(threadId, now()); // no host reachable: ask again next pass
        continue;
      }
      missed.delete(threadId);
      resolved += db.prepare("UPDATE runs SET environment_id = ? WHERE thread_id = ? AND environment_id IS NULL").run(found, threadId).changes;
      resolved += stamp(); // its children
    }
    const unresolved = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE environment_id IS NULL AND thread_id IS NOT NULL").get() as { n: number }).n;
    return { resolved, unresolved };
  }

  /** Environment of any thread the console knows: a run of it, else the home thread's host. */
  function forThread(threadId: string | undefined): string | undefined {
    if (!threadId) return undefined;
    const r = db.prepare("SELECT environment_id FROM runs WHERE thread_id = ? AND environment_id IS NOT NULL LIMIT 1").get(threadId) as
      | { environment_id: string }
      | undefined;
    if (r) return r.environment_id;
    const l = db.prepare("SELECT host FROM cycle_assignment_link WHERE thread_id = ?").get(threadId) as { host: string } | undefined;
    return l ? hostEnvironment(l.host === workerHost() ? workerHost() : mainHost()) : undefined;
  }

  return { hostEnvironment, refreshHost, stamp, backfill, forThread };
}

export type Environments = ReturnType<typeof createEnvironments>;
