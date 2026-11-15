import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";
import { ownerName } from "../identity.js";
import type { Assignment, Run, Store } from "../store.js";

/**
 * Priority mode (the owner's voice note of 2026-11-12): one console action gives the machine to one or two
 * rows. On start every running session that is not one of them is asked (a T3 steer) to save its state and stop: a
 * worker commits and pushes its work in progress, writes where it is in its row's Last attempted and PATCHes its run
 * `monitoring`; a wake ends its turn without dispatching anything else. While it is on, a new child run for any other
 * row is refused (POST /api/runs → 409 priority_mode), cadence, timed and stall watch wakes of other assignments wait,
 * and the Delivery Manager's wake prompt names the rows (so the free seats all go to them). When every named row's
 * worker has finished (or on Resume, or after PRIORITY_MAX_MS), each parked worker is woken again in its own thread
 * with a brief that starts "resume from your row's Last attempted", best pursuit rank first; a send that
 * fails is handed to its Delivery Manager in one Run now. Every park and resume is a line in cycle_priority_log and
 * the console log.
 */

export const PRIORITY_BY = "Priority mode";
export const PRIORITY_CODE = "priority_mode";
/** a mode nobody ends resumes by itself after this long (the parked work must not wait forever). */
export const PRIORITY_MAX_MS = 6 * 3_600_000;
/** a row code as the ledgers write it: E907-S3, E948-S60, TAX-A10, E900-R3. */
export const ROW_RE = /^[A-Z][A-Z0-9]*-[A-Z]*\d+$/;
const TICKET_RE = /^([A-Z][A-Z0-9]*-[A-Z]*\d+)\b/;

/** the row a child run works: the first word of its summary (`<ticket id> <what it does>`, the dispatch rule). */
export function ticketOf(summary: string | undefined): string | undefined {
  return TICKET_RE.exec((summary ?? "").trim())?.[1];
}

/** EPIC-<n> of a row code (E907-S3 → EPIC-907); undefined for codes without an epic number (TAX-A10). */
export function epicOfRow(row: string): string | undefined {
  const m = /^E(\d+)-/.exec(row);
  return m ? `EPIC-${m[1]}` : undefined;
}

export interface PrioritySession {
  id: string;
  rows: string[];
  by: string;
  reason: string;
  startedAt: string;
  /** assignments whose wakes keep running (the Delivery Managers of the named rows). */
  assignments: string[];
  endedAt?: string;
  endedBy?: string;
  endWhy?: string;
}

export type ParkState = "asked" | "ask_failed" | "resumed" | "resume_failed" | "handed_to_manager" | "skipped";
export interface PriorityPark {
  sessionId: string;
  runId: string;
  kind: "worker" | "wake";
  ticket?: string;
  assignmentId: string;
  parentRunId?: string;
  threadId?: string;
  rank: number | null;
  state: ParkState;
  parkedAt: string;
  resumeRunId?: string;
  resumedAt?: string;
  note?: string;
}
export interface PriorityLogLine {
  at: string;
  event: string;
  runId?: string;
  ticket?: string;
  detail: string;
}

export interface PriorityView {
  on: boolean;
  session?: PrioritySession;
  parked: PriorityPark[];
  log: PriorityLogLine[];
  /** the named rows' runs now running (ids), while on. */
  focusRunning: string[];
}

export interface PriorityDeps {
  /** send text into a run's own thread (steer, falling back to a new turn); throws when T3 refuses. */
  send: (run: Run, text: string) => Promise<unknown>;
  /** the pursuit rank of a row (1 = first); null = no rank (goes last). */
  rankOf?: (row: string) => number | null;
  /** a Run now of an assignment with a note (the Delivery Manager); undefined = no cycle. */
  wake?: (assignmentId: string, note: string) => Promise<unknown>;
  /** is this assignment a Delivery Manager (gets the wake when no assignment is known for a row). */
  isManager?: (a: Assignment) => boolean;
  /** the console's own URL for the PATCH lines in the messages. */
  base: string;
  now?: () => number;
  maxMs?: number;
  log?: (line: string) => void;
}

export function migratePriority(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycle_priority_session (
      id TEXT PRIMARY KEY, rows TEXT NOT NULL, by TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL, assignments TEXT NOT NULL DEFAULT '[]',
      ended_at TEXT, ended_by TEXT, end_why TEXT
    );
    CREATE TABLE IF NOT EXISTS cycle_priority_park (
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, ticket TEXT, assignment_id TEXT NOT NULL,
      parent_run_id TEXT, thread_id TEXT, rank INTEGER, state TEXT NOT NULL, parked_at TEXT NOT NULL,
      resume_run_id TEXT, resumed_at TEXT, note TEXT,
      PRIMARY KEY (session_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS cycle_priority_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL,
      run_id TEXT, ticket TEXT, detail TEXT NOT NULL DEFAULT ''
    );
  `);
}

export class PriorityError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;
const opt = <T>(v: unknown) => (v === null || v === undefined ? undefined : (v as T));

/** the save-state steer a parked worker gets (the owner's words: save, write where you are, stop). */
export function parkMessage(i: { runId: string; ticket?: string; rows: string[]; base: string; resumeAt: string }): string {
  const row = i.ticket ?? "your row";
  return [
    `PRIORITY MODE: ${ownerName()} gave the machine to ${i.rows.join(" and ")}. Stop now, after saving your state:`,
    `1. Commit and push your work in progress (a branch is fine; name ${row} in the message).`,
    `2. Write where you are in ${row}'s Last attempted (done so far, half-done, branch or worktree, exact next step), commit and push the spine.`,
    `3. PATCH your run monitoring: curl -sS -X PATCH ${i.base}/api/runs/${i.runId} -H 'content-type: application/json' -d '${JSON.stringify({
      outcome: "monitoring",
      nextCheckAt: i.resumeAt,
      summary: `${row} parked by priority mode: <where you are, next step>`,
      endedAt: "<ISO UTC now>",
    })}'`,
    `4. Stop: do no more work and start nothing. The console wakes you in this thread when priority mode ends, to resume from ${row}'s Last attempted.`,
  ].join("\n");
}

/** the steer a running wake gets: end the turn, dispatch nothing but the named rows. */
export function wakeParkMessage(rows: string[], home: boolean): string {
  return home
    ? `PRIORITY MODE: ${ownerName()} gave the machine to ${rows.join(" and ")}. Dispatch only ${rows.join(" and ")} (every free seat goes to them), start nothing else, then end this turn with your PATCH.`
    : `PRIORITY MODE: ${ownerName()} gave the machine to ${rows.join(" and ")}. Save what you have (commit and push), start nothing new, and end this turn with your PATCH now.`;
}

/** the resume brief: starts with the words the row asks for. */
export function resumeMessage(i: { oldRunId: string; newRunId: string; ticket?: string; base: string }): string {
  const row = i.ticket ?? "your row";
  return [
    `resume from your row's Last attempted: priority mode ended, ${row} is yours again.`,
    `Read ${row}'s Last attempted (what you wrote when you parked), pull, and carry on from its next step.`,
    `Your console run is now ${i.newRunId} (it replaces ${i.oldRunId}): every PATCH and the Run trailer of your commits use ${i.newRunId};`,
    `finish as your first brief says, then: curl -sS -X PATCH ${i.base}/api/runs/${i.newRunId} -H 'content-type: application/json' -d '{"outcome":"progressed|monitoring|blocked|failed","summary":"${row} <what happened>","endedAt":"<ISO UTC now>"}'.`,
  ].join("\n");
}

const RESUMABLE: Run["outcome"][] = ["monitoring", "stopped", "running"];

export function createPriorityMode(db: DB, store: Store, d: PriorityDeps) {
  migratePriority(db);
  const now = () => (d.now ? d.now() : Date.now());
  const iso = () => new Date(now()).toISOString();
  const maxMs = d.maxMs ?? (Number(process.env.CONSOLE_PRIORITY_MAX_MS) || PRIORITY_MAX_MS);

  const toSession = (r: Row): PrioritySession => ({
    id: r.id as string,
    rows: JSON.parse(r.rows as string),
    by: r.by as string,
    reason: r.reason as string,
    startedAt: r.started_at as string,
    assignments: JSON.parse((r.assignments as string) || "[]"),
    endedAt: opt(r.ended_at),
    endedBy: opt(r.ended_by),
    endWhy: opt(r.end_why),
  });
  const toPark = (r: Row): PriorityPark => ({
    sessionId: r.session_id as string,
    runId: r.run_id as string,
    kind: r.kind as PriorityPark["kind"],
    ticket: opt(r.ticket),
    assignmentId: r.assignment_id as string,
    parentRunId: opt(r.parent_run_id),
    threadId: opt(r.thread_id),
    rank: (r.rank as number | null) ?? null,
    state: r.state as ParkState,
    parkedAt: r.parked_at as string,
    resumeRunId: opt(r.resume_run_id),
    resumedAt: opt(r.resumed_at),
    note: opt(r.note),
  });

  /** the session that is on (none = priority mode is off). */
  function active(): PrioritySession | undefined {
    const r = db.prepare("SELECT * FROM cycle_priority_session WHERE ended_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as Row | undefined;
    return r && toSession(r);
  }
  const last = (): PrioritySession | undefined => {
    const r = db.prepare("SELECT * FROM cycle_priority_session ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as Row | undefined;
    return r && toSession(r);
  };
  const parksOf = (sid: string) => (db.prepare("SELECT * FROM cycle_priority_park WHERE session_id = ? ORDER BY parked_at, run_id").all(sid) as Row[]).map(toPark);
  const setPark = (sid: string, runId: string, p: Partial<Pick<PriorityPark, "state" | "resumeRunId" | "resumedAt" | "note">>) => {
    db.prepare(
      `UPDATE cycle_priority_park SET state = COALESCE(?, state), resume_run_id = COALESCE(?, resume_run_id), resumed_at = COALESCE(?, resumed_at), note = COALESCE(?, note)
       WHERE session_id = ? AND run_id = ?`,
    ).run(p.state ?? null, p.resumeRunId ?? null, p.resumedAt ?? null, p.note ?? null, sid, runId);
  };
  function log(sid: string, event: string, detail: string, run?: { id: string; ticket?: string }) {
    db.prepare("INSERT INTO cycle_priority_log (session_id, at, event, run_id, ticket, detail) VALUES (?, ?, ?, ?, ?, ?)").run(sid, iso(), event, run?.id ?? null, run?.ticket ?? null, detail);
    (d.log ?? console.log)(`priority mode ${sid}: ${event}${run ? ` ${run.id}${run.ticket ? ` (${run.ticket})` : ""}` : ""}: ${detail}`);
  }

  /** runs started in the last 3 days (running ones are never older than that: stale runs are closed). */
  const recentRuns = () => store.listRuns({ since: new Date(now() - 3 * 86_400_000).toISOString() });
  const isFocus = (s: PrioritySession, r: Run) => {
    const t = ticketOf(r.summary);
    return !!t && s.rows.includes(t);
  };

  function view(): PriorityView {
    const s = active() ?? last();
    if (!s) return { on: false, parked: [], log: [], focusRunning: [] };
    const lines = (db.prepare("SELECT * FROM cycle_priority_log WHERE session_id = ? ORDER BY id").all(s.id) as Row[]).map((r) => ({
      at: r.at as string,
      event: r.event as string,
      runId: opt<string>(r.run_id),
      ticket: opt<string>(r.ticket),
      detail: r.detail as string,
    }));
    const on = !s.endedAt;
    const focusRunning = on ? recentRuns().filter((r) => r.parentRunId && r.outcome === "running" && isFocus(s, r)).map((r) => r.id) : [];
    return { on, session: s, parked: parksOf(s.id), log: lines, focusRunning };
  }

  /** Start: park every running session that is not one of `rows`. */
  async function start(i: { rows: string[]; by: string; reason?: string; assignmentId?: string }): Promise<PriorityView> {
    const rows = [...new Set(i.rows.map((r) => r.trim().toUpperCase()).filter(Boolean))];
    if (rows.length < 1 || rows.length > 2) throw new PriorityError(400, "rows_count", "name one or two rows");
    const bad = rows.find((r) => !ROW_RE.test(r));
    if (bad) throw new PriorityError(400, "bad_row", `${bad} is not a row code like E907-S3`);
    const on = active();
    if (on) throw new PriorityError(409, "already_on", `priority mode is already on for ${on.rows.join(", ")}: resume first`);
    if (i.assignmentId && !store.getAssignment(i.assignmentId)) throw new PriorityError(404, "not_found", `assignment ${i.assignmentId} not found`);
    const runs = recentRuns();
    // the wakes that keep running: the assignments whose runs worked these rows, the one named, else every Delivery Manager.
    const homes = new Set<string>();
    if (i.assignmentId) homes.add(i.assignmentId);
    for (const r of runs) {
      const t = ticketOf(r.summary);
      if (t && rows.includes(t)) homes.add(r.assignmentId);
    }
    if (!homes.size && d.isManager) for (const a of store.listAssignments()) if (d.isManager(a)) homes.add(a.id);
    const s: PrioritySession = { id: `pm_${randomUUID().slice(0, 8)}`, rows, by: i.by, reason: (i.reason ?? "").trim(), startedAt: iso(), assignments: [...homes] };
    db.prepare("INSERT INTO cycle_priority_session (id, rows, by, reason, started_at, assignments) VALUES (?, ?, ?, ?, ?, ?)").run(
      s.id,
      JSON.stringify(rows),
      s.by,
      s.reason,
      s.startedAt,
      JSON.stringify(s.assignments),
    );
    log(s.id, "on", `${s.by} gave the machine to ${rows.join(" and ")}${s.reason ? `: ${s.reason}` : ""}; wakes kept for ${s.assignments.length} assignment(s)`);
    const resumeAt = new Date(now() + maxMs).toISOString();
    const running = runs.filter((r) => r.outcome === "running" && !isFocus(s, r));
    // workers first (they hold the seats), then the wakes.
    running.sort((a, b) => Number(!a.parentRunId) - Number(!b.parentRunId));
    for (const r of running) {
      const kind: PriorityPark["kind"] = r.parentRunId ? "worker" : "wake";
      const ticket = kind === "worker" ? ticketOf(r.summary) : undefined;
      const rank = ticket && d.rankOf ? safeRank(ticket) : null;
      db.prepare(
        "INSERT OR IGNORE INTO cycle_priority_park (session_id, run_id, kind, ticket, assignment_id, parent_run_id, thread_id, rank, state, parked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'asked', ?)",
      ).run(s.id, r.id, kind, ticket ?? null, r.assignmentId, r.parentRunId ?? null, r.threadId ?? null, rank, iso());
      if (!r.threadId) {
        setPark(s.id, r.id, { state: "ask_failed", note: "no thread yet" });
        log(s.id, "park_failed", "no thread yet to ask", { id: r.id, ticket });
        continue;
      }
      const text = kind === "worker" ? parkMessage({ runId: r.id, ticket, rows, base: d.base, resumeAt }) : wakeParkMessage(rows, homes.has(r.assignmentId));
      try {
        await d.send(r, text);
        log(s.id, "park", kind === "worker" ? `asked to save state and stop (rank ${rank ?? "none"})` : "wake asked to end its turn", { id: r.id, ticket });
      } catch (e) {
        setPark(s.id, r.id, { state: "ask_failed", note: errText(e) });
        log(s.id, "park_failed", errText(e), { id: r.id, ticket });
      }
    }
    // a named row with no worker running gets one now: its Delivery Manager is woken with the order.
    const idle = rows.filter((row) => !runs.some((r) => r.parentRunId && r.outcome === "running" && ticketOf(r.summary) === row));
    if (idle.length && d.wake)
      for (const a of s.assignments) {
        try {
          await d.wake(a, `Priority mode is on for ${rows.join(" and ")} (${s.by}). Dispatch ${idle.join(" and ")} now with every free seat; start no other row.`);
          log(s.id, "wake", `woke ${a} to dispatch ${idle.join(" and ")}`);
        } catch (e) {
          log(s.id, "wake_failed", `${a}: ${errText(e)}`);
        }
      }
    return view();
  }

  function safeRank(row: string): number | null {
    try {
      return d.rankOf?.(row) ?? null;
    } catch {
      return null;
    }
  }

  /** End the mode and wake every parked worker in its thread, best rank first. */
  async function resume(i: { by: string; why: string }): Promise<PriorityView> {
    const s = active();
    if (!s) throw new PriorityError(409, "not_on", "priority mode is off");
    db.prepare("UPDATE cycle_priority_session SET ended_at = ?, ended_by = ?, end_why = ? WHERE id = ?").run(iso(), i.by, i.why, s.id);
    log(s.id, "off", `${i.by}: ${i.why}`);
    const parks = parksOf(s.id)
      .filter((p) => p.kind === "worker")
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.parkedAt.localeCompare(b.parkedAt));
    const forManager = new Map<string, PriorityPark[]>();
    for (const p of parks) {
      const old = store.getRun(p.runId);
      const t = { id: p.runId, ticket: p.ticket };
      if (!old) {
        setPark(s.id, p.runId, { state: "skipped", note: "run is gone" });
        log(s.id, "resume_skipped", "run is gone", t);
        continue;
      }
      if (!RESUMABLE.includes(old.outcome)) {
        setPark(s.id, p.runId, { state: "skipped", note: `ended ${old.outcome}: nothing to resume` });
        log(s.id, "resume_skipped", `ended ${old.outcome}: nothing to resume`, t);
        continue;
      }
      if (old.outcome === "running") {
        setPark(s.id, p.runId, { state: "skipped", note: "never stopped: still running" });
        log(s.id, "resume_skipped", "never stopped: still running", t);
        continue;
      }
      if (!old.threadId || !old.parentRunId) {
        forManager.set(p.assignmentId, [...(forManager.get(p.assignmentId) ?? []), p]);
        continue;
      }
      const fresh = store.createRun({
        assignmentId: old.assignmentId,
        parentRunId: old.parentRunId,
        outcome: "running",
        seat: old.seat ?? null,
        threadId: old.threadId,
        summary: `${p.ticket ?? ""} resume of ${old.id} (priority mode ended, rank ${p.rank ?? "none"})`.trim(),
        clientRequestId: `${p.ticket ?? "row"}-resume-${s.id}-${old.id.slice(4, 12)}`,
      });
      try {
        await d.send(fresh, resumeMessage({ oldRunId: old.id, newRunId: fresh.id, ticket: p.ticket, base: d.base }));
        store.updateRun(old.id, { nextCheckAt: null, summary: `${old.summary} · resumed as ${fresh.id}` });
        setPark(s.id, p.runId, { state: "resumed", resumeRunId: fresh.id, resumedAt: iso() });
        log(s.id, "resume", `woken in its thread as ${fresh.id} (rank ${p.rank ?? "none"})`, t);
      } catch (e) {
        store.updateRun(fresh.id, { outcome: "failed", endedAt: iso(), summary: `${fresh.summary}: send failed, handed to its Delivery Manager (${errText(e)})` });
        setPark(s.id, p.runId, { state: "resume_failed", resumeRunId: fresh.id, note: errText(e) });
        log(s.id, "resume_failed", errText(e), t);
        forManager.set(p.assignmentId, [...(forManager.get(p.assignmentId) ?? []), p]);
      }
    }
    // what could not be woken in its own thread goes to its Delivery Manager in one Run now, in the same order.
    for (const [a, list] of forManager) {
      const lines = list.map((p, n) => `${n + 1}. ${p.ticket ?? p.runId} (parked run ${p.runId})`).join("\n");
      try {
        if (!d.wake) throw new Error("no cycle to wake");
        await d.wake(a, `Priority mode ended. Relaunch these parked rows, in this order, each with a brief that starts "resume from your row's Last attempted":\n${lines}`);
        for (const p of list) setPark(s.id, p.runId, { state: "handed_to_manager" });
        log(s.id, "resume_handed", `${list.length} row(s) to ${a}: ${list.map((p) => p.ticket ?? p.runId).join(", ")}`);
      } catch (e) {
        log(s.id, "resume_failed", `handing ${list.length} row(s) to ${a}: ${errText(e)}`);
      }
    }
    return view();
  }

  /** a child run for another row is refused while the mode is on (the dispatch records it first). */
  function refusesChild(input: { parentRunId?: string | null; summary: string }): string | undefined {
    if (!input.parentRunId) return undefined;
    const s = active();
    if (!s) return undefined;
    const t = ticketOf(input.summary);
    if (t && s.rows.includes(t)) return undefined;
    log(s.id, "refused", `new worker for ${t ?? "an unnamed row"} refused`, { id: input.parentRunId, ticket: t });
    return `priority mode is on for ${s.rows.join(" and ")} (since ${s.startedAt}): no worker for ${t ?? "another row"} until it ends. Leave the row ready; it is picked up when priority mode ends.`;
  }

  /** why a cadence, timed or stall watch wake of this assignment waits now (undefined = it may wake). */
  function holdsWake(assignmentId: string): string | undefined {
    const s = active();
    if (!s || s.assignments.includes(assignmentId)) return undefined;
    return `priority mode on for ${s.rows.join(" and ")}`;
  }

  /** the wake prompt's line while the mode is on (empty when off). */
  function promptLines(): string {
    const s = active();
    if (!s) return "";
    return [
      `PRIORITY MODE IS ON (since ${s.startedAt}, ${s.by}${s.reason ? `: ${s.reason}` : ""}): only ${s.rows.join(" and ")} run.`,
      `Dispatch only ${s.rows.join(" and ")}; every free seat goes to them. Do not start, relaunch or resume any other row: the console refuses their child runs (409 ${PRIORITY_CODE})`,
      `and wakes every parked worker itself, in priority order, when these rows finish or ${ownerName()} presses Resume.`,
    ].join(" ");
  }

  /** auto-resume: every named row had a worker that has ended since the start and none runs now, or the mode is too old. */
  async function tick(): Promise<PriorityView | undefined> {
    const s = active();
    if (!s) return undefined;
    if (now() - Date.parse(s.startedAt) > maxMs) return resume({ by: PRIORITY_BY, why: `on for more than ${Math.round(maxMs / 3_600_000)} h: resumed by itself` });
    const runs = recentRuns().filter((r) => r.parentRunId);
    const done = s.rows.every((row) => {
      const mine = runs.filter((r) => ticketOf(r.summary) === row);
      return !mine.some((r) => r.outcome === "running" || r.outcome === "deferred") && mine.some((r) => !!r.endedAt && r.endedAt >= s.startedAt);
    });
    if (!done) return undefined;
    return resume({ by: PRIORITY_BY, why: `${s.rows.join(" and ")} finished` });
  }

  return { view, active, start, resume, refusesChild, holdsWake, promptLines, tick };
}

export type PriorityMode = ReturnType<typeof createPriorityMode>;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
