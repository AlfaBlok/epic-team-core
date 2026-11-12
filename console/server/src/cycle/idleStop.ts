import type { DB } from "../db.js";
import type { T3Client, T3ThreadState } from "../t3/client.js";
import { errorText } from "../t3/client.js";
import { type HostId, mainHost, workerHost } from "../identity.js";

/**
 * stop the provider session of a home thread once its wake has ended. T3 keeps a thread's Claude process alive
 * (`ready`, 80-350 MB, 2-5% CPU) after the turn ends, so on 2026-11-03 the main server held 10 such processes while the broker's
 * session cap counted 1 open run (load5 17-20, 2.6 GB swap). Settling a thread (`t3_thread_organize settle`) detaches its
 * provider sessions and T3 stops the process; the next wake's send un-settles the thread and T3 resumes the same
 * Claude session (`--resume <id>`, proven on the worker server 2026-11-03: the resumed turn still knew the earlier turn's word).
 * T3 itself refuses to settle a thread whose turn still runs ("is still running. Stop it before settling.").
 *
 * Only threads the console launched and binds to an assignment (cycle_assignment_link) are touched, and only when:
 * the newest console run on the thread has ended at least `afterEndMs` ago; no run on it (nor any child run of one) is
 * open; T3 shows no active turn, no queued message and no live child thread; and, when the thread had a turn after the
 * console's run ended (someone used it by hand), that turn ended at least `idleMs` ago. Delegated worker threads, the
 * Team and Repo desks, ticket chats and handovers are never touched (L-3: the owner's own threads are his).
 */
export const IDLE_STOP_AFTER_END_MS = 60_000;
export const IDLE_STOP_IDLE_MS = 10 * 60_000;
/** Threads whose last console run ended longer ago than this are not read again (they were settled or left alone). */
export const IDLE_STOP_LOOKBACK_MS = 48 * 3600_000;
const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const LIVE_CHILD = new Set(["idle", "pending", "preparing", "queued", "starting", "running", "waiting"]);

export type Host = HostId;
export interface IdleStopDeps {
  db: DB;
  /** The T3 of a host if it can be reached now (the worker server only while its tunnel is up: never starts the box); undefined = skip. */
  clientFor: (host: Host) => T3Client | undefined;
  now?: () => number;
  afterEndMs?: number;
  idleMs?: number;
  /** At most this many T3 reads per tick (default 12). */
  maxReads?: number;
  log?: (line: string) => void;
}
export interface IdleStop {
  threadId: string;
  host: Host;
  runId: string;
  at: string;
}

interface Candidate {
  threadId: string;
  linkHost: string;
  projectId: string | null;
  runId: string;
  endedAt: string | null;
  launchHost: string | null;
}

const ms = (s?: string | null) => (s ? Date.parse(s) : NaN);
const safeAll = <T>(db: DB, sql: string, ...args: unknown[]): T[] => {
  try {
    return db.prepare(sql).all(...args) as T[];
  } catch {
    return []; // a table this db lacks (tests, an older schema)
  }
};

export function createIdleStopper(d: IdleStopDeps) {
  const now = d.now ?? Date.now;
  const afterEndMs = d.afterEndMs ?? IDLE_STOP_AFTER_END_MS;
  const idleMs = d.idleMs ?? IDLE_STOP_IDLE_MS;
  const maxReads = d.maxReads ?? 12;
  const log = d.log ?? ((l: string) => console.log(l));
  /** thread -> the console run after whose end it was settled (or found settled); in memory, re-read once after a restart. */
  const done = new Map<string, string>();
  const recent: IdleStop[] = [];

  /** Threads of other kinds that may share an id with a link row (never touched). */
  const foreign = () =>
    new Set(
      [
        ...safeAll<{ t: string }>(d.db, "SELECT thread_id AS t FROM desk_session WHERE thread_id IS NOT NULL"),
        ...safeAll<{ t: string }>(d.db, "SELECT thread_id AS t FROM ticket_session WHERE thread_id IS NOT NULL"),
        ...safeAll<{ t: string }>(d.db, "SELECT thread_id AS t FROM cycle_handover WHERE thread_id IS NOT NULL"),
      ].map((r) => r.t),
    );

  /** Home threads with their newest console run (open or ended). */
  const candidates = (): Candidate[] =>
    safeAll<{ thread_id: string; host: string; project_id: string | null; id: string; ended_at: string | null; launch_host: string | null }>(
      d.db,
      `SELECT l.thread_id, l.host, l.project_id, r.id, r.ended_at, r.launch_host
         FROM cycle_assignment_link l
         JOIN runs r ON r.id = (SELECT r2.id FROM runs r2 WHERE r2.thread_id = l.thread_id ORDER BY r2.started_at DESC LIMIT 1)
        WHERE l.thread_id IS NOT NULL AND l.thread_id NOT LIKE 'thread:delegated-task:%'`,
    ).map((r) => ({ threadId: r.thread_id, linkHost: r.host, projectId: r.project_id, runId: r.id, endedAt: r.ended_at, launchHost: r.launch_host }));

  /** An open console run on the thread, or an open child run (a delegated worker) of any run on it. */
  const openWork = (threadId: string): boolean =>
    safeAll(
      d.db,
      `SELECT 1 FROM runs WHERE (thread_id = ? AND ended_at IS NULL)
          OR (ended_at IS NULL AND parent_run_id IN (SELECT id FROM runs WHERE thread_id = ?)) LIMIT 1`,
      threadId,
      threadId,
    ).length > 0;

  const lastTurnEnd = (st: T3ThreadState): number =>
    Math.max(0, ...(st.runs ?? []).map((r) => ms(r.completedAt ?? undefined)).filter((n) => Number.isFinite(n)));

  /** One sweep. Returns the threads settled now. Never throws. */
  async function tick(): Promise<IdleStop[]> {
    const t = now();
    const skip = foreign();
    const stopped: IdleStop[] = [];
    let reads = 0;
    for (const c of candidates()) {
      if (reads >= maxReads) break;
      if (skip.has(c.threadId) || done.get(c.threadId) === c.runId) continue;
      const ended = ms(c.endedAt);
      if (!Number.isFinite(ended) || t - ended < afterEndMs || t - ended > IDLE_STOP_LOOKBACK_MS) continue;
      if (openWork(c.threadId)) continue;
      const host: Host = (c.launchHost ?? c.linkHost) === workerHost() ? workerHost() : mainHost();
      const client = d.clientFor(host);
      if (!client?.settleThread) continue;
      reads++;
      try {
        const st = await client.readThreadStatus(c.threadId);
        const raw = st.raw as { settled?: boolean; archived?: boolean };
        if (raw.settled === true || raw.archived === true) {
          done.set(c.threadId, c.runId);
          continue;
        }
        if (st.activeRunId || ACTIVE.has(st.status) || (st.runs ?? []).some((r) => !r.completedAt && ACTIVE.has(r.status))) continue;
        const turnEnd = lastTurnEnd(st);
        // A turn after the console's run ended (a delivered worker result, a hand-typed message): wait for real idleness.
        const quiet = turnEnd > ended + 5_000 ? idleMs : afterEndMs;
        if (t - Math.max(ended, turnEnd) < quiet) continue;
        if (client.queuedCount && (await client.queuedCount(c.threadId)) > 0) continue;
        if (client.listChildThreads && c.projectId) {
          const kids = await client.listChildThreads(c.projectId, c.threadId);
          if (kids.some((k) => LIVE_CHILD.has(k.status))) continue;
        }
        await client.settleThread(c.threadId);
        done.set(c.threadId, c.runId);
        const s: IdleStop = { threadId: c.threadId, host, runId: c.runId, at: new Date(t).toISOString() };
        stopped.push(s);
        recent.unshift(s);
        recent.splice(50);
        log(`idle stop: settled ${c.threadId} on ${host} (run ${c.runId} ended ${Math.round((t - ended) / 1000)} s ago)`);
      } catch (e) {
        log(`idle stop: ${c.threadId} on ${host}: ${errorText(e)}`);
      }
    }
    return stopped;
  }

  return { tick, recent: () => [...recent] };
}
