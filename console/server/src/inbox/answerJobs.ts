import type { DB } from "../db.js";

/**
 * what happens to an answer after the console has stored it and replied. the owner's click stores the answer in
 * console.db (jordi_responses, job_state 'pending') and is acknowledged at once; this job then writes it into the spine
 * (commit + push), wakes the persona who asked, and records each step on the row, which the card reads (Saved → Written
 * to the spine → <persona> woken, or Failed + reason + Retry).
 *
 * Durable: the state is on the row, so a restart loses nothing: `resume` at boot picks up every row still pending or
 * running. A step that fails for a reason worth retrying (git failed, T3 refused) is tried again after RETRY_MS[n]; the
 * last try is final (`last`), which the step uses to wake the asker with the answer it could not write.
 * One job per answer at a time; jobs of different answers run side by side (the spine writer serialises per checkout).
 */
export type JobState = "pending" | "running" | "done" | "failed";
export type StepResult = { state: "done" } | { state: "retry"; error: string } | { state: "failed"; error: string };
export type AnswerStep = (id: string, o: { attempt: number; last: boolean }) => Promise<StepResult>;

/** Pause before try 2, 3, 4, 5 (then failed: Retry on the card). */
export const RETRY_MS = [5_000, 30_000, 120_000, 600_000];
/** On SIGTERM, how long the console waits for the steps already running to finish before it exits (they resume at boot either way). */
export const DRAIN_MS = 25_000;

export interface AnswerJobsOptions {
  db: DB;
  step: AnswerStep;
  retryMs?: number[];
  now?: () => number;
  log?: (msg: string) => void;
  /** every state change of a job (the press log follows the answer's job). */
  onState?: (id: string, s: { state: JobState; attempts: number; error?: string | null }) => void;
}

export interface AnswerJobs {
  /** Run the answer's job now (a retry waiting on a timer runs at once). Resolves when this try ends; never rejects. */
  start(id: string, o?: { reset?: boolean }): Promise<void>;
  /**
   * Start it on the next turn of the event loop (after the reply that stored it has gone out). `holdMs` waits
   * that long first (the card's Bring it back window): `cancel` inside it writes nothing and wakes nobody.
   */
  schedule(id: string, holdMs?: number): void;
  /** take back an answer whose job has not started (Bring it back): true when nothing ran, the row is deleted. */
  cancel(id: string): boolean;
  /** Boot: start every job left pending or running by the previous process. */
  resume(): string[];
  /** SIGTERM: start nothing new; wait up to ms for the tries in flight. True when none is left running. */
  drain(ms?: number): Promise<boolean>;
  /** How many tries are running now. */
  running(): number;
  /** Tests: resolves when no try is running or waiting on a timer. */
  idle(): Promise<void>;
}

export function createAnswerJobs(o: AnswerJobsOptions): AnswerJobs {
  const { db } = o;
  const retryMs = o.retryMs ?? RETRY_MS;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.warn(m));
  const inFlight = new Map<string, Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queued = new Set<string>();
  let draining = false;
  const iso = (t = now()) => new Date(t).toISOString();
  const write = (id: string, f: { state: JobState; attempts?: number; error?: string | null; nextAt?: string | null }) =>
    db
      .prepare(
        `UPDATE jordi_responses SET job_state = ?, job_attempts = COALESCE(?, job_attempts), job_error = CASE WHEN ? THEN ? ELSE job_error END, job_next_at = ? WHERE id = ?`,
      )
      .run(f.state, f.attempts ?? null, f.error !== undefined ? 1 : 0, f.error ?? null, f.nextAt ?? null, id);
  const set = (id: string, f: { state: JobState; attempts?: number; error?: string | null; nextAt?: string | null }) => {
    write(id, f);
    if (!o.onState) return;
    try {
      const r = db.prepare("SELECT job_attempts, job_error FROM jordi_responses WHERE id = ?").get(id) as { job_attempts: number | null; job_error: string | null } | undefined;
      o.onState(id, { state: f.state, attempts: r?.job_attempts ?? f.attempts ?? 0, error: f.state === "done" ? null : (f.error ?? r?.job_error ?? null) });
    } catch (e) {
      log(`answer ${id}: press log: ${(e as Error).message}`);
    }
  };

  const tryOnce = async (id: string): Promise<void> => {
    const row = db.prepare("SELECT job_state, job_attempts FROM jordi_responses WHERE id = ?").get(id) as { job_state: string | null; job_attempts: number | null } | undefined;
    if (!row) return;
    const attempt = (row.job_attempts ?? 0) + 1;
    const last = attempt > retryMs.length;
    set(id, { state: "running", attempts: attempt, nextAt: null });
    let r: StepResult;
    try {
      r = await o.step(id, { attempt, last });
    } catch (e) {
      r = { state: "retry", error: (e as Error).message || String(e) };
    }
    if (r.state === "retry" && !last && !draining) {
      const wait = retryMs[attempt - 1];
      set(id, { state: "pending", error: r.error, nextAt: iso(now() + wait) });
      log(`answer ${id}: try ${attempt} failed (${r.error}); again in ${Math.round(wait / 1000)} s`);
      const t = setTimeout(() => {
        timers.delete(id);
        void start(id);
      }, wait);
      t.unref?.();
      timers.set(id, t);
      return;
    }
    if (r.state === "retry" && draining) {
      // Shutting down: left pending, the next process resumes it.
      set(id, { state: "pending", error: r.error });
      return;
    }
    if (r.state === "done") set(id, { state: "done", error: null });
    else {
      set(id, { state: "failed", error: r.error });
      log(`answer ${id}: failed after ${attempt} ${attempt === 1 ? "try" : "tries"}: ${r.error}`);
    }
  };

  const start = (id: string, s: { reset?: boolean } = {}): Promise<void> => {
    if (draining) return Promise.resolve();
    const running = inFlight.get(id);
    if (running) return running;
    const t = timers.get(id);
    if (t) clearTimeout(t), timers.delete(id);
    if (s.reset) db.prepare("UPDATE jordi_responses SET job_state = 'pending', job_attempts = 0, job_next_at = NULL WHERE id = ?").run(id);
    const p = tryOnce(id)
      .catch((e) => log(`answer ${id}: job error: ${(e as Error).stack ?? e}`))
      .finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  };

  return {
    start,
    schedule: (id, holdMs) => {
      if (draining) return;
      if (holdMs && holdMs > 0) {
        const t = setTimeout(() => {
          timers.delete(id);
          void start(id);
        }, holdMs);
        t.unref?.();
        timers.set(id, t);
        return;
      }
      queued.add(id);
      setImmediate(() => {
        queued.delete(id);
        void start(id);
      });
    },
    cancel: (id) => {
      if (inFlight.has(id) || queued.has(id)) return false;
      const row = db.prepare("SELECT job_state, job_attempts FROM jordi_responses WHERE id = ?").get(id) as { job_state: string | null; job_attempts: number | null } | undefined;
      if (!row || row.job_state !== "pending" || (row.job_attempts ?? 0) > 0) return false;
      const t = timers.get(id);
      if (t) clearTimeout(t), timers.delete(id);
      db.prepare("DELETE FROM jordi_responses WHERE id = ? AND job_state = 'pending' AND COALESCE(job_attempts, 0) = 0").run(id);
      return true;
    },
    resume: () => {
      const ids = (db.prepare("SELECT id FROM jordi_responses WHERE job_state IN ('pending', 'running') ORDER BY created_at").all() as { id: string }[]).map((r) => r.id);
      // An interrupted try is not counted against the retries.
      db.prepare("UPDATE jordi_responses SET job_state = 'pending', job_attempts = MAX(COALESCE(job_attempts, 1) - 1, 0) WHERE job_state = 'running'").run();
      for (const id of ids) void start(id);
      if (ids.length) log(`answer jobs: resumed ${ids.length} after restart`);
      return ids;
    },
    drain: async (ms = DRAIN_MS) => {
      draining = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      const all = Promise.all([...inFlight.values()]).then(() => true);
      const timeout = new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), ms);
        t.unref?.();
      });
      return Promise.race([all, timeout]);
    },
    running: () => inFlight.size,
    idle: async () => {
      while (inFlight.size || timers.size || queued.size) {
        await Promise.all([...inFlight.values()]);
        if (!inFlight.size && (timers.size || queued.size)) await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}
