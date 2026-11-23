import type { DB } from "../db.js";
import { isUnblocker } from "../inbox/asks.js";
import type { Assignment, Milestone, OpenAsk, Run, Store } from "../store.js";
import { classifyAsks, readAskMemory } from "./askMemory.js";
import type { Grant } from "./grants.js";

/**
 * a new ask wakes the Unblocker. When a pull moves a repo (freshness pulls, the run-end pull, or
 * any other move of HEAD such as the EpicSpine background sync, seen by a 60 s HEAD watch), the console waits a short
 * debounce, then for each milestone of that repo with a switched-on Unblocker (root L-10: never an off one) looks for
 * open ask codes it has not seen: not in the per-ask memory (never assessed), not already the reason of an
 * earlier new-ask wake, not written by an Unblocker run (its commit's `Run:` trailer). Any such codes → one Run now of
 * that Unblocker with a note naming them (one wake per batch, however many asks the pull brought). The Unblocker's
 * cadence is then a slow backstop: UNBLOCKER_BACKSTOP_MINUTES (6 h) by default, tunable per assignment.
 *
 * What a code was decided once is kept in table `ask_wake_seen` (created on first use, not a numbered migration).
 *
 * one assessment per ask per checkout. Milestones read from the same checkout (a root and an epic under it)
 * share their asks: a code decided for one is not woken for again by another, and a check in flight claims its codes
 * (in memory, before it wakes) so a concurrent check of a sibling skips them and looks again after. Each check pulls
 * the checkout first, so an ask answered and pushed since the last pull wakes nobody.
 */
export const UNBLOCKER_BACKSTOP_MINUTES = 6 * 60;
/** The cadence a new assignment gets when none is given: the Unblocker's 6 h backstop, every other persona 2 h (the dialog's default). */
export const defaultCadenceFor = (personaName?: string) =>
  ({ type: "interval" as const, everyMinutes: isUnblocker(personaName) ? UNBLOCKER_BACKSTOP_MINUTES : 120 });

export const NEW_ASK_DEBOUNCE_MS = 2 * 60_000;
export const NEW_ASK_NOTE_BY = "Console";
export const newAskNote = (codes: string[]) =>
  `New ask${codes.length === 1 ? "" : "s"} in this milestone's tree since the last pull: ${codes.join(", ")}. Assess ${codes.length === 1 ? "it" : "each"} now.`;

export interface NewAskWakeDeps {
  db: DB;
  store: Store;
  /** The milestone's open coded asks (as the Unblocker's wake lists them). */
  openAsks: (m: Milestone) => Promise<OpenAsk[]>;
  grants?: (m: Milestone) => Promise<Grant[]>;
  /** The checkout a milestone's repo is read from (undefined: none on this host). */
  repoDir: (m: Milestone) => string | undefined;
  /** fast-forward the checkout before reading its asks (errors ignored: read what is there). */
  pull?: (dir: string) => Promise<unknown>;
  /** The run id in the `Run:` trailer of the commit that last wrote `line` (1-based) of `rel`, if any. */
  authorRun?: (dir: string, rel: string, line: number) => Promise<string | undefined>;
  /** Wake the assignment now (the Run-now path) with this note. */
  wake: (assignmentId: string, note: string, noteBy: string) => Promise<Run & { startGuard?: string }>;
  debounceMs?: number;
  log?: (msg: string) => void;
}

export type CheckResult =
  | { milestoneId: string; woke: true; runId: string; codes: string[] }
  | { milestoneId: string; woke: false; reason: string; codes?: string[] };

const bare = (c: string) => c.trim().replace(/^.*\//, "").toUpperCase();

const ensured = new WeakSet<object>();
/** Exported for the schema registry test (it creates every table the server can create). */
export function ensureSeen(db: DB): void {
  if (ensured.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ask_wake_seen (
      milestone_id TEXT NOT NULL,
      code TEXT NOT NULL,
      reason TEXT NOT NULL,
      run_id TEXT,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (milestone_id, code)
    );
  `);
  ensured.add(db);
}

export function readSeen(db: DB, milestoneId: string): { code: string; reason: string; runId?: string; seenAt: string }[] {
  ensureSeen(db);
  return (db.prepare("SELECT code, reason, run_id, seen_at FROM ask_wake_seen WHERE milestone_id = ? ORDER BY seen_at, code").all(milestoneId) as {
    code: string; reason: string; run_id: string | null; seen_at: string;
  }[]).map((r) => ({ code: r.code, reason: r.reason, ...(r.run_id ? { runId: r.run_id } : {}), seenAt: r.seen_at }));
}

function markSeen(db: DB, milestoneId: string, codes: string[], reason: string, runId?: string): void {
  const put = db.prepare("INSERT OR IGNORE INTO ask_wake_seen (milestone_id, code, reason, run_id, seen_at) VALUES (?, ?, ?, ?, ?)");
  const at = new Date().toISOString();
  for (const c of codes) put.run(milestoneId, bare(c), reason, runId ?? null, at);
}

export function createNewAskWaker(d: NewAskWakeDeps) {
  const debounceMs = d.debounceMs ?? NEW_ASK_DEBOUNCE_MS;
  const log = d.log ?? ((m: string) => console.warn(m));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<unknown>>();
  let headTimer: ReturnType<typeof setInterval> | undefined;
  const heads = new Map<string, string>();
  /** `${repoDir}|${code}` of asks a check is waking for right now (taken before the wake, released after). */
  const claims = new Set<string>();

  const unblockerOf = (m: Milestone): Assignment | undefined =>
    d.store.listAssignments({ milestoneId: m.id }).find((a) => a.enabled && isUnblocker(d.store.getPersona(a.personaId)?.name));

  const runningWake = (a: Assignment) => d.store.listRuns({ assignmentId: a.id, limit: 20 }).find((r) => !r.parentRunId && r.outcome === "running");

  /** Was the ask line written by a run of an Unblocker (a SPLIT's new ask)? */
  const ownAsk = async (dir: string | undefined, a: OpenAsk): Promise<boolean> => {
    if (!dir || !d.authorRun || !a.path || !a.line) return false;
    const runId = await d.authorRun(dir, a.path, a.line).catch(() => undefined);
    const run = runId ? d.store.getRun(runId) : undefined;
    const as = run ? d.store.getAssignment(run.assignmentId) : undefined;
    return !!as && isUnblocker(d.store.getPersona(as.personaId)?.name);
  };

  /** codes already decided for another milestone read from the same checkout → that milestone's id. */
  const seenBySibling = (m: Milestone, dir: string | undefined): Map<string, string> => {
    const by = new Map<string, string>();
    if (!dir) return by;
    for (const o of d.store.listMilestones()) {
      if (o.id === m.id || d.repoDir(o) !== dir) continue;
      for (const s of readSeen(d.db, o.id)) if (!by.has(s.code)) by.set(s.code, o.id);
    }
    return by;
  };

  /** One milestone: wake its switched-on Unblocker once if its tree has open asks it has never seen. */
  async function check(milestoneId: string): Promise<CheckResult> {
    ensureSeen(d.db);
    const m = d.store.getMilestone(milestoneId);
    if (!m) return { milestoneId, woke: false, reason: "unknown milestone" };
    if (m.paused || m.settledAt) return { milestoneId, woke: false, reason: m.paused ? "milestone paused" : "milestone settled" };
    const a = unblockerOf(m);
    if (!a) return { milestoneId, woke: false, reason: "no switched-on Unblocker" };
    const dir = d.repoDir(m);
    if (dir && d.pull) await d.pull(dir).catch(() => undefined);
    const asks = await d.openAsks(m).catch(() => undefined);
    if (!asks) return { milestoneId, woke: false, reason: "open asks unreadable" };
    const grants = d.grants ? await d.grants(m).catch(() => []) : [];
    const seen = new Set(readSeen(d.db, m.id).map((s) => s.code));
    const fresh = classifyAsks(asks, grants, readAskMemory(d.db, m.id))
      .filter((s) => s.status === "new" && !seen.has(bare(s.code)))
      .map((s) => asks.find((x) => bare(x.code) === bare(s.code))!);
    if (!fresh.length) return { milestoneId, woke: false, reason: "no new asks" };
    const own: string[] = [];
    const other: OpenAsk[] = [];
    for (const x of fresh) ((await ownAsk(dir, x)) ? own.push(x.code) : other.push(x));
    if (own.length) markSeen(d.db, m.id, own, "written by the Unblocker");
    if (!other.length) return { milestoneId, woke: false, reason: "only the Unblocker's own asks", codes: own };
    // re-read what is decided, here and for siblings on the same checkout.
    const seenNow = new Set(readSeen(d.db, m.id).map((s) => s.code));
    const sibling = seenBySibling(m, dir);
    for (const x of other) {
      const by = sibling.get(bare(x.code));
      if (by && !seenNow.has(bare(x.code))) markSeen(d.db, m.id, [x.code], `assessed by the Unblocker of ${by}`);
    }
    const key = (c: string) => `${dir ?? m.id}|${bare(c)}`;
    const open = other.filter((x) => !seenNow.has(bare(x.code)) && !sibling.has(bare(x.code)));
    const codes = open.filter((x) => !claims.has(key(x.code))).map((x) => x.code);
    // claimed by a check in flight: look again after it (its wake may fail)
    if (codes.length < open.length) schedule(m.id);
    if (!codes.length) return { milestoneId, woke: false, reason: open.length ? "being woken for by another check" : "assessed for this checkout already" };
    const running = runningWake(a);
    if (running) {
      // A wake already listing them assesses them; otherwise look again after it (the next debounce).
      const listed = new Set((running.openAsks ?? []).map((x) => bare(x.code)));
      const covered = codes.filter((c) => listed.has(bare(c)));
      if (covered.length) markSeen(d.db, m.id, covered, "in a running wake", running.id);
      if (covered.length < codes.length) schedule(m.id);
      return { milestoneId, woke: false, reason: `a wake is still running (${running.id})`, codes };
    }
    for (const c of codes) claims.add(key(c));
    try {
      const run = await d.wake(a.id, newAskNote(codes), NEW_ASK_NOTE_BY);
      // a wake that started meanwhile got the note queued (start guard), not a second wake
      if (run.startGuard === "queued" || run.startGuard === "held" || run.startGuard === "handled") {
        markSeen(d.db, m.id, codes, run.startGuard === "queued" ? "queued into a running wake" : `${run.startGuard} for a wake`, run.id);
        return { milestoneId, woke: false, reason: `queued into running wake ${run.id}`, codes };
      }
      markSeen(d.db, m.id, codes, "woke the Unblocker", run.id);
      if (run.outcome === "running") d.store.updateRun(run.id, { wokeBecause: `new asks after a pull: ${codes.join(", ")}` });
      return { milestoneId, woke: true, runId: run.id, codes };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "already_running") schedule(m.id);
      else log(`new-ask wake ${m.id}: ${(e as Error).message}`);
      return { milestoneId, woke: false, reason: `wake failed: ${(e as Error).message}`, codes };
    } finally {
      for (const c of codes) claims.delete(key(c));
    }
  }

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p)).catch(() => undefined);
    return p;
  };

  /** Debounced check of one milestone (later calls inside the window join the first: one wake per batch). */
  function schedule(milestoneId: string): void {
    if (timers.has(milestoneId)) return;
    const t = setTimeout(() => {
      timers.delete(milestoneId);
      track(check(milestoneId).catch((e) => log(`new-ask check ${milestoneId}: ${(e as Error).message}`)));
    }, debounceMs);
    t.unref?.();
    timers.set(milestoneId, t);
  }

  /** A checkout moved (or was pulled): check every milestone read from it, after the debounce. */
  function repoMoved(dir: string): void {
    for (const m of d.store.listMilestones()) if (!m.paused && !m.settledAt && d.repoDir(m) === dir && unblockerOf(m)) schedule(m.id);
  }

  /** Watch HEAD of every milestone checkout (moves by the background sync too); the first read is the baseline. */
  function watchHeads(head: (dir: string) => Promise<string | undefined>, everyMs = 60_000): void {
    if (headTimer || everyMs <= 0) return;
    let busy = false;
    const tick = async () => {
      const dirs = new Set(d.store.listMilestones().flatMap((m) => d.repoDir(m) ?? []));
      for (const dir of dirs) {
        const h = await head(dir).catch(() => undefined);
        if (!h) continue;
        const was = heads.get(dir);
        heads.set(dir, h);
        if (was && was !== h) repoMoved(dir);
      }
    };
    void tick();
    headTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      void tick().finally(() => (busy = false));
    }, everyMs);
    headTimer.unref?.();
  }

  /** Tests: wait for pending debounces to fire and their checks to finish. */
  async function settled(): Promise<void> {
    while (timers.size || inFlight.size) {
      await new Promise((r) => setTimeout(r, Math.min(debounceMs, 25)));
      await Promise.all([...inFlight]);
    }
  }

  function stop(): void {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    if (headTimer) clearInterval(headTimer);
    headTimer = undefined;
  }

  return { check, repoMoved, schedule, watchHeads, settled, stop };
}

export type NewAskWaker = ReturnType<typeof createNewAskWaker>;

/** `git blame` the line, then read the `Run:` trailer of that commit (undefined: uncommitted, or no trailer). */
export const gitAuthorRun =
  (git: (dir: string, args: string[]) => Promise<string>) =>
  async (dir: string, rel: string, line: number): Promise<string | undefined> => {
    const sha = (await git(dir, ["blame", "--porcelain", "-L", `${line},${line}`, "--", rel])).split(/\s/)[0];
    if (!sha || /^0+$/.test(sha)) return undefined;
    const body = await git(dir, ["log", "-1", "--format=%B", sha]);
    return /^Run:\s*(run_[\w-]+)/m.exec(body)?.[1];
  };
