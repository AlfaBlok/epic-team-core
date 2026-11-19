import type { DB } from "../db.js";
import type { Outcome, Run, Store } from "../store.js";
import type { T3Client, T3ThreadRun, T3ThreadState } from "../t3/client.js";
import type { Dispatcher } from "../t3/dispatcher.js";
import { LOG_FORMAT, parseCommits, type GitLog } from "../adapters/outcome.js";

/** the console closes runs from T3 thread state instead of trusting the persona to PATCH. */
export interface ReconcileDeps {
  db: DB;
  store: Store;
  /** The T3 a thread of this assignment lives on (the main server or the worker server); undefined = unreachable, the run is left to the stale limit. */
  /** `run` when the call is about one run (its launchHost overrides the link's host). */
  t3For: (assignmentId: string, run?: Run) => T3Client | undefined;
  dispatcher?: Dispatcher;
  /** assignment -> home thread / project (cycle link table). */
  link: (assignmentId: string) => { threadId?: string; projectId?: string } | undefined;
  /**
   * a commit on the milestone repo that carries this run's `Run:` trailer (the worker's work landed), checked before
   * an unreported child run is closed: such a run closes progressed, not blank_report. Undefined = no check.
   */
  landed?: (run: Run) => Promise<{ sha: string; subject: string; at?: string } | undefined>;
  /** Called after a run is closed (bootstrap seat hold release). */
  onClosed?: (runId: string) => Promise<void>;
  staleRunMs: number;
  /**
   * the hard cap for a run whose thread shows work (a live turn, live child threads) or cannot be read: 8 workers
   * were failed at 180 min (staleRunMs) on 2026-11-01 while their T3 tasks still ran (reads reset by the worker server tunnel, or a
   * long live turn). Default HARD_RUN_MS.
   */
  hardRunMs?: number;
  /** A run with no matching T3 turn counts as dead after this long. */
  graceMs: number;
  now?: () => number;
  maxReads?: number;
  /**
   * deliver a wake run's message once more (a send lost to a console restart, or a turn the provider could not
   * start: `fresh` = a new home thread on a seat the broker now prefers). True when re-sent; the run then waits
   * another grace period. Never called twice for one run (RESENT in its summary).
   */
  resend?: (run: Run, why: string, fresh: boolean) => Promise<boolean>;
  /**
   * close the run when it is an orphan wake (running, no thread, past its start window, no start in flight);
   * true = it was closed. Checked before the stale limit, so an orphan never waits 3 h.
   */
  orphan?: (run: Run) => boolean;
}

/** the summary mark of a run whose wake was re-sent once. */
export const RESENT = "re-sent once";
/**
 * T3's error text when the provider could not start the turn (on the worker server, 2026-10-31: the MCP registration timed out under load).
 * Also a home thread too long to hand to a provider session ("Insufficient context allowance for the provider handoff"):
 * that thread can never start a turn again, so the wake goes to a new one instead of failing every wake on it.
 */
export const START_FAILED = /could not start this turn|did not answer the MCP server registration|insufficient context allowance/i;
/**
 * a turn that failed on the seat's usage limit (T3 2026-11-01: error "Usage limit reached: Claude API rate limit
 * reached. Try again later.", notice "… until the 5-hour limit resets in 1h 5m", reply "You've hit your session limit").
 * Mirrors the broker's LIMIT_RE (m0/broker/broker.py), which sets maxed_until on a `done --fail --signal` it matches.
 */
export const USAGE_LIMIT = /hit your (?:session |weekly |usage |5-hour |five-hour )?limit|usage limit|rate.?limit|limit reached|session limit|quota/i;

const LIVE = new Set(["idle", "preparing", "queued", "starting", "running", "waiting"]);
const FAILED = new Set(["failed", "cancelled", "interrupted", "rolled_back"]);
const NOTE = "[console:";
const ADOPT_AFTER_MS = 2 * 60_000;
const RECENT_MS = 10 * 60_000;
/**
 * a child worker run whose last turn completed without a report waits this long before it reads blank_report:
 * a worker's next turn (a background task finishing, a delegated child's result) can come minutes later (run_54e7fc03,
 * turn 1 ended 02:40:33Z after its merge, turn 2 came 02:51:00Z and reported).
 */
export const SETTLE_MS = 20 * 60_000;
/**
 * a T3 delegated worker (a `thread:delegated-task:` subagent thread) whose turn ended unreported stays open this
 * long after its last sign of life (turn end, PATCH, a commit with its `Run:` trailer): the claim lease (2 h, renewed by
 * each commit naming the row) plus 30 min grace. Such a worker often ends a turn while a background job waits for a
 * deploy window (run_499981bf: turn 1 ended 02:26Z, turn 2 came 03:06Z, turn 3 04:12Z and reported); closed at the
 * 20 min settle window, the memory service refused its run id, its claim looked free and the worker server cleanup moved its worktree. T3's
 * task_status (workState) answers only the parent thread and acknowledges delivery when read, so the console cannot use it.
 */
export const DELEGATED_HOLD_MS = 150 * 60_000;
/** default hard cap (ReconcileDeps.hardRunMs). */
export const HARD_RUN_MS = 12 * 3600_000;

const t = (s?: string | null) => (s ? Date.parse(s) : NaN);

/** a child run on a T3 delegated-task thread (DELEGATED_HOLD_MS applies to it, not SETTLE_MS alone). */
export function isDelegatedWorker(run: Pick<Run, "parentRunId" | "threadId">, st?: T3ThreadState): boolean {
  if (!run.parentRunId) return false;
  if (run.threadId?.startsWith("thread:delegated-task:")) return true;
  return (st?.raw as Record<string, unknown> | undefined)?.relationshipToParent === "subagent";
}
/** the state detail of a delegated worker held open (the run counts as a live worker meanwhile). */
export const HELD = "worker waiting";

/**
 * The first T3 turn that was still live, or ended, after the run began. With `newest`, the last such turn: a
 * run alone on its thread (a delegated worker) spans every later turn (it waits for a background task, a notification
 * starts the next turn), so its first turn ending is not its end; judged by it, the worker was closed blank_report
 * mid-work and again after each PATCH back to running.
 */
export function matchTurn(runs: T3ThreadRun[] | undefined, startedAt: string, newest = false): T3ThreadRun | undefined {
  const start = Date.parse(startedAt);
  const covers = (r: T3ThreadRun) => !r.completedAt || !(t(r.completedAt) < start);
  if (newest) return (runs ?? []).find(covers); // T3 lists newest first
  const ordered = [...(runs ?? [])].reverse(); // newest first -> oldest first
  return ordered.find(covers);
}

/**
 * every T3 turn still live, or ended, after the run began, newest first. A worker can take several turns; the
 * run is judged by its latest one (matchTurn's oldest turn closed run_48159c5b between turns).
 */
export function turnsSince(runs: T3ThreadRun[] | undefined, startedAt: string): T3ThreadRun[] {
  const start = Date.parse(startedAt);
  const at = (r: T3ThreadRun) => t(r.startedAt ?? r.requestedAt) || 0;
  return (runs ?? []).map((r, i) => ({ r, i })).filter(({ r }) => !r.completedAt || !(t(r.completedAt) < start))
    .sort((a, b) => at(b.r) - at(a.r) || a.i - b.i) // newest first; T3's own order (newest first) breaks ties
    .map(({ r }) => r);
}
const isLive = (r: T3ThreadRun) => LIVE.has(r.status) && !r.completedAt;
/** The turns a run is judged by: alone on its thread every covering turn, newest first; else matchTurn's one. */
function coveringTurns(runs: T3ThreadRun[] | undefined, startedAt: string, newest: boolean): T3ThreadRun[] {
  if (newest) return turnsSince(runs, startedAt);
  const one = matchTurn(runs, startedAt);
  return one ? [one] : [];
}

/**
 * the last T3 state the reconciler read for a running run, so the Activity timeline can tell a live worker
 * from an abandoned one. `detail` is T3's own status word (e.g. cancelled vs failed); `startedAt` the matched turn's start.
 */
export type RunT3Status = "live" | "completed" | "failed" | "unknown";
export interface RunT3State {
  status: RunT3Status;
  detail?: string;
  startedAt?: string;
  checkedAt: string;
}

/** Classify one read the way closeRunning decides (live / completed / failed); anything else is unknown. */
export function classifyRead(st: T3ThreadState | undefined, startedAt: string, newest = false): Omit<RunT3State, "checkedAt"> {
  if (!st) return { status: "unknown", detail: "read failed" };
  const turns = coveringTurns(st.runs, startedAt, newest);
  const turn = turns.find(isLive) ?? turns[0];
  if (turn) {
    const start = turn.startedAt ?? turn.requestedAt;
    if (isLive(turn)) return { status: "live", detail: turn.status, startedAt: start };
    if (FAILED.has(turn.status)) return { status: "failed", detail: turn.status, startedAt: start };
    if (turn.status === "completed") return { status: "completed", detail: turn.status, startedAt: start };
    return { status: "unknown", detail: turn.status, startedAt: start };
  }
  if (FAILED.has(st.status)) return { status: "failed", detail: st.status };
  if (!st.runs && st.status === "completed") return { status: "completed", detail: st.status };
  if (!st.runs && LIVE.has(st.status)) return { status: "live", detail: st.status };
  return { status: "unknown", detail: st.runs ? "no T3 turn yet" : st.status };
}

/**
 * the child run a delegated T3 thread was launched for. The DM sets the delegate task's clientRequestId to
 * `<ticket>-<child run id>` and T3 keeps it in the thread id (`thread:delegated-task:…%3Adelegate-task%3Ae6-s34-run_3a000db5`):
 * returns `run_<first 8 hex>`, or undefined when the thread names no run.
 */
export function runHint(threadId: string): string | undefined {
  let s = threadId;
  try {
    s = decodeURIComponent(threadId);
  } catch {
    // keep the raw id
  }
  const i = s.lastIndexOf("delegate-task:");
  if (i < 0) return undefined;
  const m = /(?:^|[^0-9a-z])run_([0-9a-f]{8})(?![0-9a-z])/i.exec(s.slice(i + "delegate-task:".length));
  return m ? `run_${m[1].toLowerCase()}` : undefined;
}

/**
 * the newest commit since the run began (1 min slack) whose `Run:` trailer names this run (full id or its
 * `run_<8hex>` short form). Subjects are not read: the DM's dispatch commit cites the child run it starts.
 */
export async function landedCommit(log: GitLog, repoDir: string, run: Pick<Run, "id" | "startedAt">): Promise<{ sha: string; subject: string; at: string } | undefined> {
  const since = new Date(Date.parse(run.startedAt) - 60_000).toISOString();
  const short = run.id.slice(0, 12).toLowerCase();
  const out = await log(repoDir, [LOG_FORMAT, `--since=${since}`, "-n", "300"]);
  const hit = parseCommits(out).find((c) => c.runIds.some((v) => v.toLowerCase().slice(0, 12) === short));
  return hit ? { sha: hit.sha, subject: hit.subject, at: hit.at } : undefined;
}

export interface ReconcileResult {
  closed: string[];
  noted: string[];
  adopted: string[];
}

export function createReconciler(d: ReconcileDeps) {
  const now = () => (d.now ? d.now() : Date.now());
  const iso = () => new Date(now()).toISOString();
  let running = false;
  const states = new Map<string, RunT3State>();
  const hardMs = d.hardRunMs ?? HARD_RUN_MS;
  /** last PATCH per run (PATCH /api/runs/:id calls touch; in memory: a restart forgets, which only delays a close). */
  const touched = new Map<string, number>();
  const touch = (runId: string) => void touched.set(runId, now());
  /** when the run's thread first failed to read in the current streak, and how many reads failed. */
  const unreadable = new Map<string, { since: string; reads: number }>();
  const hhmm = (s: string) => `${s.slice(11, 16)}Z`;

  /**
   * what says the worker is still alive although the console cannot see it: a PATCH, or a commit carrying its
   * `Run:` trailer, within staleRunMs. Undefined = quiet.
   */
  async function recentActivity(run: Run): Promise<string | undefined> {
    const at = touched.get(run.id);
    if (at !== undefined && now() - at < d.staleRunMs) return `PATCH at ${hhmm(new Date(at).toISOString())}`;
    if (!d.landed) return undefined;
    const hit = await d.landed(run).catch(() => undefined);
    if (hit && (!hit.at || now() - Date.parse(hit.at) < d.staleRunMs)) return `commit ${hit.sha}`;
    return undefined;
  }

  /**
   * until when a delegated worker whose turn ended unreported stays open: DELEGATED_HOLD_MS after its last sign of
   * life (the turn end, a PATCH, a commit with its Run: trailer). Undefined = the hold is over. git is read only once the
   * turn end and PATCH no longer hold it.
   */
  async function heldUntil(run: Run, endedAt?: string): Promise<number | undefined> {
    const base = Math.max(t(endedAt) || 0, touched.get(run.id) ?? 0, t(run.startedAt) || 0);
    if (now() - base < DELEGATED_HOLD_MS) return base + DELEGATED_HOLD_MS;
    const hit = d.landed ? await d.landed(run).catch(() => undefined) : undefined;
    const at = t(hit?.at);
    if (Number.isFinite(at) && now() - at < DELEGATED_HOLD_MS) return at + DELEGATED_HOLD_MS;
    return undefined;
  }

  /** no later run shares the thread (a home thread holds one run per wake; a delegated thread only its own). */
  const aloneOnThread = (run: Run) =>
    !d.db.prepare("SELECT 1 FROM runs WHERE thread_id = ? AND id <> ? AND started_at >= ? LIMIT 1").get(run.threadId, run.id, run.startedAt);

  const resent = new Map<string, number>(); // run id -> when its wake was re-sent (grace restarts there)
  const close = async (run: Run, outcome: Outcome, why: string, endedAt?: string, signal?: string) => {
    d.store.updateRun(run.id, { outcome, endedAt: endedAt ?? iso(), summary: `${run.summary} ${NOTE} ${why}]`.trim() });
    if (run.parentRunId && run.seat && d.dispatcher) await d.dispatcher.done(run.seat, outcome === "failed", signal).catch(() => undefined);
    await d.onClosed?.(run.id).catch(() => undefined);
  };

  /**
   * A completed T3 turn nobody reported on: an answer run is done-like; a wake or a child worker run left blank is
   * blank_report (an unreported worker is unknown, not progress; it may have ended planning to act later).
   */
  const doneOutcome = (run: Run): Outcome => (run.kind === "answer_run" ? "progressed" : "blank_report");

  /**
   * a wake that dispatched child runs and then ended its turn without a PATCH did its job: progressed
   * "dispatched N workers" (auto-closed), not blank_report. Other unreported turns keep doneOutcome.
   */
  const closeDone = async (run: Run, why: string, endedAt?: string, st?: T3ThreadState, alone = false): Promise<boolean> => {
    const children = run.kind === "wake" && !run.parentRunId ? d.store.listRuns({ parentRunId: run.id, limit: 500 }).length : 0;
    if (!children) {
      if (doneOutcome(run) !== "blank_report") return close(run, doneOutcome(run), why, endedAt).then(() => true);
      // blank_report only once the thread is really done and nobody reported in the meantime.
      const going = alone ? await stillGoing(run, st, endedAt) : undefined; // a shared home thread: the old rule
      if (going) {
        const prev = states.get(run.id);
        // a held delegated worker is alive (a background job, a monitor): it counts as a live worker
        // (also while it settles: the ceiling counted it out for its first 20 min)
        const alive = going.startsWith(HELD) || (going.startsWith("settling") && isDelegatedWorker(run, st));
        if (prev) states.set(run.id, { ...prev, ...(alive ? { status: "live" as const } : {}), detail: going });
        return false;
      }
      const fresh = d.store.getRun(run.id);
      if (!fresh || fresh.outcome !== "running" || fresh.threadId !== run.threadId) return false; // a PATCH came in
      const hit = fresh.parentRunId && d.landed ? await d.landed(fresh).catch(() => undefined) : undefined;
      if (hit) return close(fresh, "progressed", `${why}; work landed: ${hit.sha} ${hit.subject}`.slice(0, 400), endedAt).then(() => true);
      return close(fresh, "blank_report", why, endedAt).then(() => true);
    }
    const base = run.summary.trim();
    const updated = { ...run, summary: `${base ? `${base} · ` : ""}dispatched ${children} worker${children === 1 ? "" : "s"}` };
    await close(updated, "progressed", `auto-closed: ${why}`, endedAt);
    return true;
  };

  /**
   * why an unreported, completed turn is not yet the end of a run alone on its thread (undefined = really
   * terminal). The delegated
   * task can still be waiting for its own child threads, hold an open request, have a turn queued, or (a worker) be in
   * the settle window before its next turn. T3 reads that fail count as "not sure yet": the stale limit still applies.
   */
  async function stillGoing(run: Run, st: T3ThreadState | undefined, endedAt?: string): Promise<string | undefined> {
    if (run.parentRunId && endedAt && now() - Date.parse(endedAt) < SETTLE_MS) return "settling: no report yet";
    if (isDelegatedWorker(run, st)) {
      const held = await heldUntil(run, endedAt);
      if (held !== undefined) return `${HELD}: turn ended${endedAt ? ` ${hhmm(endedAt)}` : ""}, no report yet, held until ${hhmm(new Date(held).toISOString())}`;
    }
    const raw = (st?.raw ?? {}) as Record<string, unknown>;
    if (Number(raw.pendingRequestCount) > 0) return "waiting on a T3 request";
    const t3 = d.t3For(run.assignmentId, run);
    const projectId = typeof raw.projectId === "string" ? raw.projectId : undefined;
    if (t3?.listChildThreads && projectId && run.threadId) {
      try {
        const kids = (await t3.listChildThreads(projectId, run.threadId)).filter((k) => LIVE.has(k.status));
        if (kids.length) return `waiting for ${kids.length} child thread${kids.length === 1 ? "" : "s"}`;
      } catch {
        return "child threads unreadable";
      }
    }
    if (t3?.queuedCount && run.threadId) {
      const n = await t3.queuedCount(run.threadId).catch(() => undefined);
      if (n === undefined) return "queue unreadable";
      if (n > 0) return `${n} turn${n === 1 ? "" : "s"} queued`;
    }
    return undefined;
  }

  async function readState(run: Run): Promise<T3ThreadState | undefined> {
    const t3 = d.t3For(run.assignmentId, run);
    if (!t3) return undefined;
    try {
      return await t3.readThreadStatus(run.threadId!);
    } catch {
      return undefined;
    }
  }

  /** T3's own error text for a failed turn ("Provider error: The provider could not start this turn. …"), or undefined. */
  async function lastError(run: Run): Promise<string | undefined> {
    const t3 = d.t3For(run.assignmentId, run);
    if (!t3?.readLastError || !run.threadId) return undefined;
    return t3.readLastError(run.threadId).catch(() => undefined);
  }

  /** one re-send of a top-level wake whose message never became a turn (or whose turn could not start). */
  async function tryResend(run: Run, why: string, fresh: boolean): Promise<boolean> {
    if (!d.resend || run.parentRunId || run.kind !== "wake" || run.summary.includes(RESENT) || resent.has(run.id)) return false;
    const ok = await d.resend(run, why, fresh).catch((e) => {
      console.error(`reconcile resend ${run.id}:`, e);
      return false;
    });
    if (ok) resent.set(run.id, now());
    return ok;
  }

  async function closeRunning(run: Run): Promise<boolean> {
    const age = now() - Date.parse(run.startedAt);
    const graceAge = now() - Math.max(Date.parse(run.startedAt), resent.get(run.id) ?? 0); // grace restarts at a re-send
    const timedOut = () => close(run, "failed", `timed out after ${Math.round(age / 60_000)} min with no outcome`);
    if (!run.threadId) {
      if (d.orphan?.(run)) return true; // it closed the run (seat hold, run-end pull) itself
      if (age > d.staleRunMs && !(await recentActivity(run))) {
        await timedOut();
        return true;
      }
      return false;
    }
    const st = await readState(run);
    const newest = aloneOnThread(run);
    states.set(run.id, { ...classifyRead(st, run.startedAt, newest), checkedAt: iso() });
    if (!st) {
      // an unreadable thread is not a dead worker (the worker server tunnel reset 1,329 reads on 2026-11-01 and 8 live
      // workers were failed at 180 min). Recorded on the run's T3 state; failed only past the hard cap and quiet.
      const u = unreadable.get(run.id) ?? { since: iso(), reads: 0 };
      u.reads++;
      unreadable.set(run.id, u);
      const why = `thread unreadable since ${hhmm(u.since)} (${u.reads} read${u.reads === 1 ? "" : "s"} failed)`;
      states.set(run.id, { status: "unknown", detail: why, checkedAt: iso() });
      if (u.reads === 1) console.warn(`reconcile ${run.id}: T3 ${why}; not failing it`);
      if (age > hardMs && !(await recentActivity(run))) {
        await close(run, "failed", `timed out after ${Math.round(age / 60_000)} min, ${why}, no PATCH or commit for ${Math.round(d.staleRunMs / 60_000)} min`);
        return true;
      }
      return false;
    }
    unreadable.delete(run.id);
    // a run alone on its thread is judged by its latest turn; any live turn (or, alone, an active one T3 has
    // not listed yet) keeps it open.
    const turns = coveringTurns(st.runs, run.startedAt, newest);
    const turn = turns[0];
    const status = turn?.status ?? st.status;
    if (turn) {
      if (turns.some(isLive) || (newest && st.activeRunId)) {
        if (age > hardMs) { // a live turn is work going on: only the hard cap ends it
          await close(run, "failed", `timed out: T3 turn still ${(turns.find(isLive) ?? turn).status} after ${Math.round(age / 60_000)} min`);
          return true;
        }
        return false;
      }
      if (FAILED.has(status)) {
        const err = await lastError(run); // the exact provider error, not just "failed"
        // a usage-limited seat is handled like a start failure: the broker is told (it sets maxed_until) and the
        // wake goes once more to a new home thread on a seat with headroom (or is deferred when none has any)
        if (err && (START_FAILED.test(err) || USAGE_LIMIT.test(err)) && (await tryResend(run, `T3 turn ${status}: ${err}`, true))) return false;
        await close(run, "failed", `T3 turn ${status}${err ? ` (${err})` : ""}, no report from persona`, turn.completedAt ?? undefined, err);
        return true;
      }
      if (status === "completed") {
        if (await closeDone(run, "T3 turn completed, no report from persona", turn.completedAt ?? undefined, st, newest)) return true;
        if (age > hardMs) {
          await close(run, "failed", `timed out after ${Math.round(age / 60_000)} min: ${states.get(run.id)?.detail ?? "no report"}`);
          return true;
        }
        return false;
      }
      return false; // unknown status word: leave alone
    }
    // No turn covers the run. Without per-turn data fall back to the thread status.
    if (!st.runs) {
      if (FAILED.has(st.status)) {
        await close(run, "failed", `T3 thread ${st.status}, no report from persona`);
        return true;
      }
      if (st.status === "completed" && graceAge > d.graceMs) {
        if (await closeDone(run, "T3 thread completed, no report from persona", undefined, st, newest)) return true;
      }
    } else if (graceAge > d.graceMs && !LIVE.has(st.status)) {
      // a send lost to a console restart (run_1bf2f284, 2026-10-28 02:15:25Z, deploy of 237b5e3) gets one re-send
      const why = `no T3 turn ran within ${Math.round(d.graceMs / 60_000)} min of the wake (send lost, e.g. a console restart)`;
      if (await tryResend(run, why, false)) return false;
      await close(run, "failed", run.summary.includes(RESENT) ? "no T3 turn ever ran for this run, also after the re-send" : "no T3 turn ever ran for this run");
      return true;
    }
    if (age > d.staleRunMs && !(await recentActivity(run))) {
      await timedOut();
      return true;
    }
    return false;
  }

  /** Persona said progressed/blocked/idle but T3 says the turn failed: keep the report, note the disagreement once. */
  async function noteMismatch(run: Run): Promise<boolean> {
    if (!run.threadId || run.summary.includes(NOTE)) return false;
    const st = await readState(run);
    const turn = st && matchTurn(st.runs, run.startedAt, aloneOnThread(run));
    if (!turn || !FAILED.has(turn.status)) return false;
    d.store.updateRun(run.id, { summary: `${run.summary} ${NOTE} T3 turn ${turn.status}, report says ${run.outcome}]` });
    return true;
  }

  /** Child threads of the home thread that no run row names: record them under the wake run that was live. */
  async function adopt(): Promise<string[]> {
    const out: string[] = [];
    const cutoff = new Date(now() - RECENT_MS).toISOString();
    const rows = d.db
      .prepare(
        `SELECT DISTINCT assignment_id FROM runs WHERE parent_run_id IS NULL AND kind = 'wake' AND assignment_id NOT LIKE 'bootstrap:%'
         AND (outcome = 'running' OR ended_at > ?)`,
      )
      .all(cutoff) as { assignment_id: string }[];
    for (const { assignment_id } of rows) {
      const l = d.link(assignment_id);
      if (!l?.threadId || !l.projectId) continue;
      const t3 = d.t3For(assignment_id);
      if (!t3?.listChildThreads) continue;
      let threads;
      try {
        threads = await t3.listChildThreads(l.projectId, l.threadId);
      } catch {
        continue;
      }
      const known = new Set(
        (d.db.prepare("SELECT thread_id FROM runs WHERE assignment_id = ? AND thread_id IS NOT NULL").all(assignment_id) as { thread_id: string }[]).map((r) => r.thread_id),
      );
      const children = new Set(threads.map((th) => th.threadId));
      const runsOf = d.store.listRuns({ assignmentId: assignment_id, limit: 200 });
      // the run a thread names; adopted even when the DM PATCHed a wrong thread id onto it (`e25-s3-worker`,
      // a bare task id): a thread id that is no child thread of the home thread is not a binding.
      const named = (th: { threadId: string }) => {
        const hint = runHint(th.threadId);
        const r = hint ? runsOf.find((x) => x.parentRunId && (x.id === hint || x.id.startsWith(`${hint}-`))) : undefined;
        return r && r.threadId !== th.threadId && (!r.threadId || !children.has(r.threadId)) ? r : undefined;
      };
      const claimed = new Set(threads.map((th) => runHint(th.threadId)).filter(Boolean));
      for (const th of threads.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
        if (known.has(th.threadId) || !th.createdAt || now() - Date.parse(th.createdAt) < ADOPT_AFTER_MS) continue;
        const own = named(th);
        if (own) {
          d.store.updateRun(own.id, { threadId: th.threadId });
          own.threadId = th.threadId;
          out.push(own.id);
          known.add(th.threadId);
          continue;
        }
        const created = Date.parse(th.createdAt);
        const wake = d.store
          .listRuns({ assignmentId: assignment_id, limit: 100 })
          .filter((r) => !r.parentRunId && r.kind === "wake" && Date.parse(r.startedAt) <= created && (!r.endedAt || Date.parse(r.endedAt) >= created - 60_000))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (!wake) continue;
        // The persona records the child run first and PATCHes its thread id a moment later: bind, don't duplicate.
        const unbound = d.store
          .listRuns({ assignmentId: assignment_id, limit: 200 })
          .filter((r) => r.parentRunId === wake.id && r.outcome === "running" && !r.threadId && !claimed.has(r.id.slice(0, 12)))
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
        if (unbound) {
          d.store.updateRun(unbound.id, { threadId: th.threadId });
          out.push(unbound.id);
        } else {
          const r = d.store.createRun({
            assignmentId: assignment_id,
            parentRunId: wake.id,
            startedAt: th.createdAt,
            outcome: "running",
            threadId: th.threadId,
            summary: `${th.title ?? "T3 task"} ${NOTE} recorded from T3, persona did not record it]`,
          });
          out.push(r.id);
        }
        known.add(th.threadId);
      }
    }
    return out;
  }

  async function tick(): Promise<ReconcileResult> {
    const res: ReconcileResult = { closed: [], noted: [], adopted: [] };
    if (running) return res;
    running = true;
    try {
      res.adopted = await adopt().catch((e) => (console.error("reconcile adopt:", e), []));
      const ids = (d.db.prepare("SELECT id FROM runs WHERE outcome = 'running' ORDER BY started_at LIMIT 200").all() as { id: string }[]).map((r) => r.id);
      let reads = 0;
      const max = d.maxReads ?? 25;
      for (const id of ids) {
        const run = d.store.getRun(id);
        if (!run || run.outcome !== "running") continue;
        if (run.threadId && ++reads > max) continue;
        if (await closeRunning(run).catch((e) => (console.error("reconcile run:", e), false))) res.closed.push(id);
      }
      const open = new Set(ids.filter((id) => !res.closed.includes(id)));
      for (const id of states.keys()) if (!open.has(id)) states.delete(id);
      for (const m of [unreadable, touched]) for (const id of m.keys()) if (!open.has(id)) m.delete(id);
      const cutoff = new Date(now() - RECENT_MS).toISOString();
      const recent = d.db
        .prepare("SELECT id FROM runs WHERE outcome IN ('progressed','blocked','monitoring','idle') AND thread_id IS NOT NULL AND ended_at > ? AND summary NOT LIKE '%[console:%' LIMIT 25")
        .all(cutoff) as { id: string }[];
      for (const { id } of recent) {
        const run = d.store.getRun(id);
        if (run && (await noteMismatch(run).catch(() => false))) res.noted.push(id);
      }
    } finally {
      running = false;
    }
    return res;
  }

  /** no T3 read here, only what the last tick saw (the API serves it per run). */
  const t3State = (runId: string): RunT3State | undefined => states.get(runId);

  return { tick, t3State, touch };
}
