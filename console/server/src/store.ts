import type { Deferral } from "./cycle/capRefusal.js";
import { runProviderFields } from "./providers/pick.js";
import { randomUUID } from "node:crypto";
import { DEFAULT_TENANT, type DB } from "./db.js";
import type Database from "better-sqlite3";
import type { Cadence } from "./schemas.js";
import { EVER_ON_SQL, TOGGLE_KIND } from "./assignmentToggle.js";
import { parseWakeParts, type WakeParts } from "./cycle/wakeWhy.js";
import type { HostRunRow } from "./runHostRow.js";
import { guardMilestoneRepo, repoScopeOf, worldClaims } from "./tenancy/repoScope.js";
import { type HostId, mainHost, ownerName, workerHost } from "./identity.js";

export interface Milestone {
  id: string;
  title: string;
  repo: string;
  path: string;
  owner: string;
  paused: boolean;
  /** console-only "settled" mark (ISO); absent = not settled. Never changes the spine or the derived status. */
  settledAt?: string;
  /** when Settings last saved an explicit title (ISO); set = `title` wins over the spine's own title. */
  titleSetAt?: string;
  /** one of the owner's big roots, at this position in the sidebar (1 first); absent = an ordinary milestone. */
  bigRoot?: number;
  createdAt: string;
}
export interface Persona {
  id: string;
  name: string;
  remit: string;
  skills: string[];
  model: string;
  mayWrite: boolean;
  /** where this persona's threads run. */
  host: HostId;
  /** each wake launches a new T3 thread with the full prompt instead of waking the home thread. */
  freshThreadEachWake: boolean;
  /** a cadence wake with nothing new since the last real wake is skipped (default on). */
  skipUnchanged: boolean;
  createdAt: string;
}
export interface Assignment {
  id: string;
  milestoneId: string;
  personaId: string;
  cadence: Cadence;
  enabled: boolean;
  t3ScheduledTaskId?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  /** set while auto-parked (enabled=false by the wake gate); only parked assignments are re-armed. */
  parkedAt?: string;
  parkedReason?: string;
  /** write granted on this milestone only (the owner, e.g. by approving a write ask), limited to writeScope. */
  writeEnabled: boolean;
  writeScope: string;
  /** a timed wake a run asked for (ISO UTC) and the run that asked; cleared once the cycle fires it. */
  retryAt?: string;
  retryRunId?: string;
  /** Derived: the earlier of nextRunAt (cadence) and retryAt (retryAt only while enabled). */
  nextWakeAt?: string;
  /** never been switched on; attached off and only ever woken by Run now, if at all. */
  neverOn?: boolean;
  createdAt: string;
}
/** blank_report: the T3 turn completed and the persona never reported. */
/** stopped: the owner (or the desk) interrupted the run from the console; it never resumes on its own. */
/** deferred: the wake could not get a seat or host (load-cap, all seats busy); the console retries it with backoff (runs.deferred). */
export type Outcome = "running" | "progressed" | "blocked" | "monitoring" | "idle" | "failed" | "blank_report" | "stopped" | "deferred";
/** answer_run: a turn the owner started in a home thread via Send to; never a wake of the assignment. */
/** toggle: the on/off switch was flipped; a log line, never a wake. */
export type RunKind = "wake" | "answer_run" | "toggle";
export interface Run {
  id: string;
  assignmentId: string;
  milestoneId?: string;
  startedAt: string;
  endedAt?: string;
  seat?: string;
  threadId?: string;
  /** T3 environment of the thread (stamped by the cycle's triggers / backfill); undefined = not known yet. */
  environmentId?: string;
  outcome: Outcome;
  summary: string;
  parentRunId?: string;
  kind: RunKind;
  /** Copied from the assignment at insert, so a run of a since-deleted assignment still names its persona. */
  personaId?: string;
  /** the run asked to be woken again at this time. */
  retryAt?: string;
  /** the owner's one-off instructions given with Run now (this run's wake only). */
  instructions?: string;
  /** who gave `instructions` (the owner from the UI, Unblocker when it wakes the Delivery Manager). */
  instructionsBy?: string;
  /** the asks this run checked (the Unblocker's finishing PATCH), one entry per ask. */
  checks?: RunCheck[];
  /** open asks of the milestone when this run's wake prompt was built (Unblocker): its checks must cover each. */
  openAsks?: OpenAsk[];
  /** fingerprint of the open asks + active grants at this Unblocker wake (a cadence wake with the same one may skip). */
  askFingerprint?: string;
  /** a monitoring run's next scheduled check (ISO UTC). */
  nextCheckAt?: string;
  /** when the watch ends (ISO UTC), when the report said. */
  until?: string;
  /** the word the agent reported when the server stored another (a `blocked` with no open ask → monitoring). */
  reportedOutcome?: string;
  /** ended monitoring because this egress was offline (`egress:laptop`); its online event wakes the assignment. */
  heldOn?: string;
  /** the wake fingerprint's parts at this wake (refreshed with askFingerprint). */
  wakeParts?: WakeParts;
  /** why this real cadence wake ran (the fingerprint part that changed, or the skip rule that did not hold). */
  wokeBecause?: string;
  /** the wake fingerprint when this real cadence wake started (askFingerprint is the one at its end). */
  startFingerprint?: string;
  /** the id the creating POST /api/runs sent; the same id again (per assignment) returns this run. */
  clientRequestId?: string;
  /** NO_SELF_READY: spine lines this run's commits turned from draft to ready (flagged amber, "self-readied"). */
  selfReadied?: string[];
  /** the run's commits broke its pack's rules (`pack.py validate --by <role>` after the run; red "rule broken"). */
  ruleBroken?: RuleBroken;
  /** the `note: done|not done: <why>` line of the report of a run that carried instructions. */
  noteAck?: string;
  /** starters that found this wake still running and started none: what each did (queued its note, or already running). */
  startGuards?: StartGuard[];
  /** a finished run with instructions whose report never acknowledged them (flagged amber, "note skipped"). */
  noteSkipped?: boolean;
  /** what the console did to the persona's checkout before this wake (pull, fresh session). */
  preWake?: string;
  /** a deferred wake's retry state (reason, attempts, next try); kept after it launched or gave up. */
  deferred?: Deferral;
  /** the host the run's thread was launched on when it is not the persona's (the worker server at its cap → the main server). */
  launchHost?: HostId;
  /** the host the run's agent ran on, as recorded (launch or the creating agent); absent on older rows. */
  host?: HostId;
  /** the wake reported idle while these steps read ready (stored as idle; the milestone names the disagreement). */
  readyIgnored?: string[];
  /** this ended wake and the ones before it gave the same report (same outcome, same summary bar numbers/times/ids), n in a row (≥ 4). */
  repeating?: number;
  /** when the first wake of that streak started. */
  repeatSince?: string;
  /** a Delivery manager wake that launched no worker while rows read ready and named no `blocker:` (flagged amber, "stalled"). */
  stalled?: string;
  /** what the dispatcher picked for this run (absent on runs from before S13): provider class, T3 instance, model, price. */
  provider?: string;
  providerInstance?: string;
  model?: string;
  priceKey?: string;
  /** true = seat subscription, priced at list for credits but not a bill. */
  notional?: boolean;
}
/** what the run-end pack check found: the roles it validated as, one issue line per problem (`<sha7> <validator line>`). */
/** a Run now (any starter) that met this running wake: `queued` its note into the wake's thread, or `already_running` (no note, or the queue failed). */
export interface StartGuard {
  at: string;
  by: string;
  action: "queued" | "already_running";
  note?: string;
  reason?: string;
}

export interface RuleBroken {
  at: string;
  roles: string[];
  issues: string[];
}
/** one open ask at wake time; kind is the ask type (provide = a credential, key or account). */
export interface OpenAsk {
  code: string;
  kind: string;
  path?: string;
  line?: number;
  /** hash of the ask line's text (a reworded ask changes the wake fingerprint). */
  textHash?: string;
  /** hash of the owner's comments on the ask's card (messages + saved answers); "" / absent when none. */
  commentHash?: string;
  /** hash of the repo files the ask line links to; "" / absent when none. */
  evidenceHash?: string;
  /** the ask's fingerprint at this wake (text, grants, comment, evidence: cycle/askMemory.ts) and its parts. */
  print?: string;
  parts?: Record<"text" | "grants" | "comment" | "evidence", string>;
  /** unchanged since this run assessed it: carried as `left (unchanged since <run>)`, not assessed again. */
  carriedFrom?: string;
  /** when the ask's spine line was written (git blame, as the inbox's `since`): the start of its ask → verdict time. */
  since?: string;
}
/** one ask an Unblocker run checked: answered (with answer, confidence, source), left (why) or split. */
export interface RunCheck {
  code: string;
  decision: "answered" | "left" | "split";
  answer?: string;
  /** 0-100 (percent). */
  confidence?: number;
  source?: string;
  why?: string;
  /** `left` provide asks: what was checked for an existing credential or a no-credential path. */
  searched?: string;
  /** Repo-relative spine path of the ask line, optionally `:<1-based line>`. */
  spine?: string;
  /** copied from an earlier run by a skipped cadence wake (nothing new), not checked again. */
  skipped?: boolean;
  /** a remembered verdict carried, not assessed again: shown as `left (unchanged since <carriedFrom>)`. */
  carriedFrom?: string;
  /** the confidence rubric's factors, 0-4 each (higher = safer to answer without the owner). */
  scores?: { reversal: number; options: number; impact: number; evidence: number };
  /** hard-floor ids the ask touches (left for the owner whatever the score). */
  floor?: string[];
  /** stamped by the console: the score and the settings it was judged by (cycle/rubric.ts RubricStamp). */
  rubric?: { score: number; threshold: number; minFactor: number; weights: Record<"reversal" | "options" | "impact" | "evidence", number>; clears: boolean; from: "milestone" | "global" | "default" };
}
export interface NeedsJordi {
  id: string;
  runId?: string;
  milestoneId: string;
  question: string;
  proposedAction: string;
  status: "open" | "approved" | "denied" | "answered" | "superseded";
  createdAt: string;
  /** status superseded: `<repo>/<code>` of the coded ask that replaced it, or `moot`. */
  supersededBy?: string;
  supersededAt?: string;
}

/** one world (a customer or ours). the home world = today's team; every row belongs to exactly one tenant. */
export interface Tenant {
  id: string;
  name: string;
  /** Which console skin the world sees (`console` = today's; `social` =). */
  skin: string;
  /** Credits plan (`internal` = metered, never held). */
  plan: string;
  ownerHandle: string;
  ownerName: string;
  reposRoot?: string;
  secretsBackend: string;
  boxProvider?: string;
  paused: boolean;
  createdAt: string;
}
/** a machine personas run on (replaces the main server|the worker server enum at S10; seeded, not read yet). */
export interface Host {
  id: string;
  tenantId: string;
  kind: string;
  provider?: string;
  t3McpUrl?: string;
  tokenFile?: string;
  ssh?: string;
  publicConsoleUrl?: string;
  memoryFloorMb?: number;
  notes: string;
  createdAt: string;
}

/** Thrown for references to rows that do not exist (mapped to HTTP 400). */
export class UnknownReference extends Error {}

const now = () => new Date().toISOString();
/**
 * a run's endedAt follows its outcome. Every word but `running` is an ending, so it carries an endedAt, stamped
 * once (the first ending keeps its time; a later ending word does not restamp); `running` never has one (a move back to
 * running, e.g. after a false blank_report, clears it). Returns the ended_at to write: undefined = leave the column.
 */
export function endedAtFor(outcome: Outcome, stored: string | null | undefined, given: string | null | undefined, at: () => string = now): string | null | undefined {
  if (outcome === "running" || outcome === "deferred") return stored || given ? null : given; // deferred is not an ending
  if (given) return given;
  return stored ? (given === null ? stored : undefined) : at();
}
const newId = (prefix: string) => `${prefix}_${randomUUID()}`;
const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);
const bool = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);

type Row = Record<string, any>;

/** The earlier of two ISO times (either may be missing). */
export function earliest(a?: string | null, b?: string | null): string | undefined {
  if (!a || !b) return opt(a ?? b);
  return Date.parse(b) < Date.parse(a) ? b : a;
}

const toMilestone = (r: Row): Milestone => ({
  id: r.id,
  title: r.title,
  repo: r.repo,
  path: r.path,
  owner: r.owner,
  paused: !!r.paused,
  settledAt: opt(r.settled_at),
  titleSetAt: opt(r.title_set_at),
  ...(r.big_root != null ? { bigRoot: Number(r.big_root) } : {}),
  createdAt: r.created_at,
});
const toPersona = (r: Row): Persona => ({
  id: r.id,
  name: r.name,
  remit: r.remit,
  skills: JSON.parse(r.skills),
  model: r.model,
  mayWrite: !!r.may_write,
  host: r.host === workerHost() ? workerHost() : mainHost(),
  freshThreadEachWake: !!r.fresh_thread_each_wake,
  skipUnchanged: r.skip_unchanged === undefined ? true : !!r.skip_unchanged,
  createdAt: r.created_at,
});
const toAssignment = (r: Row): Assignment => ({
  id: r.id,
  milestoneId: r.milestone_id,
  personaId: r.persona_id,
  cadence: JSON.parse(r.cadence),
  enabled: !!r.enabled,
  t3ScheduledTaskId: opt(r.t3_scheduled_task_id),
  lastRunAt: opt(r.last_run_at),
  nextRunAt: opt(r.next_run_at),
  parkedAt: opt(r.parked_at),
  parkedReason: opt(r.parked_reason),
  writeEnabled: !!r.write_enabled,
  writeScope: r.write_scope ?? "",
  retryAt: opt(r.retry_at),
  retryRunId: opt(r.retry_run_id),
  nextWakeAt: r.enabled ? earliest(r.next_run_at, r.retry_at) : opt(r.next_run_at),
  neverOn: !r.ever_on,
  createdAt: r.created_at,
});
/**
 * what a wake may write. The assignment is the gate: write_enabled limited to write_scope. The persona's
 * may_write is only the default a NEW assignment starts with (DEFAULT_WRITE_SCOPE); it is not read at wake time.
 */
export interface EffectiveWrite {
  mayWrite: boolean;
  /** Set when write is on: the scope the wake may write within. */
  scope?: string;
}
export function effectiveWrite(assignment?: Pick<Assignment, "writeEnabled" | "writeScope">): EffectiveWrite {
  if (assignment?.writeEnabled) return { mayWrite: true, scope: assignment.writeScope.trim() || `(no scope given: ask ${ownerName()} before any write)` };
  return { mayWrite: false };
}

/** scope text a new assignment of a may_write persona starts with (the former persona-wide behavior, now per assignment). */
export const DEFAULT_WRITE_SCOPE = `the writes, restarts and deploys your remit requires (default from the persona's may-write setting; ${ownerName()} can narrow it)`;

const toRun = (r: Row): Run => ({
  id: r.id,
  assignmentId: r.assignment_id,
  milestoneId: opt(r.milestone_id),
  startedAt: r.started_at,
  endedAt: opt(r.ended_at),
  seat: opt(r.seat),
  threadId: opt(r.thread_id),
  environmentId: opt(r.environment_id),
  outcome: r.outcome,
  summary: r.summary,
  parentRunId: opt(r.parent_run_id),
  kind: r.kind === "answer_run" || r.kind === TOGGLE_KIND ? r.kind : "wake",
  personaId: opt(r.persona_id),
  retryAt: opt(r.retry_at),
  instructions: opt(r.instructions),
  ...(r.instructions ? { instructionsBy: r.instructions_by ?? ownerName() } : {}),
  ...(r.checks ? { checks: parseChecks(r.checks) } : {}),
  ...(r.open_asks ? { openAsks: parseChecks(r.open_asks) as unknown as OpenAsk[] } : {}),
  ...(r.ask_fingerprint ? { askFingerprint: r.ask_fingerprint } : {}),
  ...(r.next_check_at ? { nextCheckAt: r.next_check_at } : {}),
  ...(r.monitor_until ? { until: r.monitor_until } : {}),
  ...(r.reported_outcome ? { reportedOutcome: r.reported_outcome } : {}),
  ...(r.held_on ? { heldOn: r.held_on } : {}),
  ...(parseWakeParts(r.wake_parts) ? { wakeParts: parseWakeParts(r.wake_parts) } : {}),
  ...(r.woke_because ? { wokeBecause: r.woke_because } : {}),
  ...(r.start_fingerprint ? { startFingerprint: r.start_fingerprint } : {}),
  ...(r.client_request_id ? { clientRequestId: r.client_request_id } : {}),
  ...(r.self_readied ? { selfReadied: JSON.parse(r.self_readied) as string[] } : {}),
  ...(r.rule_broken ? { ruleBroken: JSON.parse(r.rule_broken) as RuleBroken } : {}),
  ...(r.start_guard ? { startGuards: JSON.parse(r.start_guard) as StartGuard[] } : {}),
  ...(r.note_ack ? { noteAck: r.note_ack } : {}),
  ...(r.instructions && r.ended_at && !r.note_ack && r.outcome !== "failed" ? { noteSkipped: true } : {}),
  ...(r.pre_wake ? { preWake: r.pre_wake } : {}),
  ...(r.deferred ? { deferred: JSON.parse(r.deferred) as Deferral } : {}),
  ...(r.launch_host ? { launchHost: r.launch_host as HostId } : {}),
  ...(r.host === mainHost() || r.host === workerHost() ? { host: r.host as HostId } : {}),
  ...(r.ready_ignored ? { readyIgnored: JSON.parse(r.ready_ignored) as string[] } : {}),
  ...(r.repeating ? { repeating: r.repeating as number, ...(r.repeat_since ? { repeatSince: r.repeat_since } : {}) } : {}),
  ...(r.stalled ? { stalled: r.stalled as string } : {}),
  ...runProviderFields(r),
});
const isoOrNull = (t?: string | null) => (t ? new Date(t).toISOString() : null);
/** a monitoring run's next check, when still ahead (it then doubles as the timed wake). */
const futureCheck = (outcome: string, at?: string | null) =>
  outcome === "monitoring" && at && Date.parse(at) > Date.now() ? at : undefined;
const parseChecks = (t: string): RunCheck[] => {
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const toNeedsJordi = (r: Row): NeedsJordi => ({
  id: r.id,
  runId: opt(r.run_id),
  milestoneId: r.milestone_id,
  question: r.question,
  proposedAction: r.proposed_action,
  status: r.status,
  createdAt: r.created_at,
  ...(r.status === "superseded" ? { supersededBy: r.superseded_by ?? "moot", supersededAt: opt(r.superseded_at) } : {}),
});

const toTenant = (r: Row): Tenant => ({
  id: r.id,
  name: r.name,
  skin: r.skin,
  plan: r.plan,
  ownerHandle: r.owner_handle,
  ownerName: r.owner_name,
  reposRoot: opt(r.repos_root),
  secretsBackend: r.secrets_backend,
  boxProvider: opt(r.box_provider),
  paused: !!r.paused,
  createdAt: r.created_at,
});
const toHost = (r: Row): Host => ({
  id: r.id,
  tenantId: r.tenant_id,
  kind: r.kind,
  provider: opt(r.provider),
  t3McpUrl: opt(r.t3_mcp_url),
  tokenFile: opt(r.token_file),
  ssh: opt(r.ssh),
  publicConsoleUrl: opt(r.public_console_url),
  memoryFloorMb: opt(r.memory_floor_mb),
  notes: r.notes,
  createdAt: r.created_at,
});

/** UPDATE only the columns whose value is not undefined; null clears a nullable column. */
/**
 * `db` whose `prepare` answers a statement already prepared for the same SQL text on this connection (store reads
 * ran prepare on every call; the console polls them every 30 s per tab). Statements are only run with get/all/run here.
 */
const statementCaches = new WeakMap<DB, Map<string, Database.Statement>>();
function withStatementCache(db: DB): DB {
  let cache = statementCaches.get(db);
  if (!cache) statementCaches.set(db, (cache = new Map()));
  const stmts = cache;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => {
          let st = stmts.get(sql);
          if (!st) stmts.set(sql, (st = target.prepare(sql)));
          return st;
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * answers of the hot list reads (runs, assignments: every status / inbox poll reads all of them), kept while
 * the database has seen no write: none by this connection (`total_changes`) and no commit by another one
 * (`PRAGMA data_version`). Callers get fresh row objects.
 * the console's indexer process commits to console.db every few seconds (its views, heartbeat, spines cache),
 * never to these tables, yet each commit dropped every memo, so nearly every poll re-ran the runs / assignments reads on
 * the main thread (seconds of it a minute on a loaded the main server). A write by this connection still drops them at once; a
 * commit by another connection drops them once they are `CONSOLE_MEMO_FOREIGN_MS` old (default 2 s, 0 = at once).
 */
const readMemos = new WeakMap<DB, { own: number; version: number; at: number; values: Map<string, object[]>; total: Database.Statement; ver: Database.Statement }>();
const foreignMs = () => {
  const v = Number(process.env.CONSOLE_MEMO_FOREIGN_MS);
  return Number.isFinite(v) && v >= 0 && process.env.CONSOLE_MEMO_FOREIGN_MS !== "" ? v : 2_000;
};
export function memoRead<T extends object>(db: DB, key: string, read: () => T[], now: () => number = Date.now): T[] {
  let m = readMemos.get(db);
  if (!m) {
    m = { own: -1, version: -1, at: 0, values: new Map(), total: db.prepare("SELECT total_changes()").pluck(), ver: db.prepare("PRAGMA data_version").pluck() };
    readMemos.set(db, m);
  }
  const own = m.total.get() as number;
  const version = m.ver.get() as number;
  const t = now();
  if (own !== m.own || (version !== m.version && t - m.at >= foreignMs())) {
    m.values.clear();
    m.own = own;
    m.version = version;
    m.at = t;
  }
  let rows = m.values.get(key) as T[] | undefined;
  if (!rows) m.values.set(key, (rows = read()));
  return rows.map((r) => ({ ...r }));
}

function patchRow(db: DB, table: string, id: string, cols: Record<string, unknown>): boolean {
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length === 0) return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  const sql = `UPDATE ${table} SET ${set.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`;
  return db.prepare(sql).run(...set.map(([, v]) => v), id).changes > 0;
}

/** Thrown when a scoped store is asked for a tenant that does not exist. */
export class UnknownTenant extends Error {}

/**
 * `createStore(db)` is today's store: unscoped, every tenant's rows, new rows take the home world default (no behaviour
 * change). `createStore(db, { tenant })` (or `forTenant(db, t)`) is scoped: every list/get sees only that tenant's rows
 * (a get by another tenant's id is `undefined`, so routes answer 404 as for a missing id), updates/deletes of other
 * tenants' ids do nothing, creates stamp the tenant, and a reference into another tenant throws UnknownReference.
 * Assignments carry no tenant of their own: they belong to their milestone's tenant and must share it with the persona.
 * Runs and asks copy the tenant of their milestone at insert (like runs.milestone_id).
 */
export function createStore(raw: DB, opts: { tenant?: string } = {}) {
  const db = withStatementCache(raw); // polls re-run the same reads; prepare each SQL text once per db
  const tenant = opts.tenant ?? null;
  if (tenant !== null && !db.prepare("SELECT 1 FROM tenants WHERE id = ?").get(tenant)) throw new UnknownTenant(`tenant ${tenant} not found`);
  /** SQL guard for a table with its own tenant_id; `@t` is bound to the scope (NULL = unscoped). */
  const own = (alias = "") => `(@t IS NULL OR ${alias}tenant_id = @t)`;
  /** Assignments: through their milestone. */
  const viaMilestone = (col = "milestone_id") => `(@t IS NULL OR ${col} IN (SELECT id FROM milestones WHERE tenant_id = @t))`;
  /** a world milestone whose repo is not one of the world's own checkouts comes out as `refused:<repo>` (repoScope.ts). */
  const guardedMilestones = (rows: Row[]) => {
    let claims: Map<string, Set<string>> | undefined;
    const claimsOnce = () => (claims ??= worldClaims(raw, repoScopeOf(raw)!));
    return rows.map((r) => guardMilestoneRepo(raw, r.tenant_id, toMilestone(r), claimsOnce));
  };
  const getMilestone = (id: string) => {
    const r = db.prepare(`SELECT * FROM milestones WHERE id = @id AND ${own()}`).get({ id, t: tenant }) as Row | undefined;
    return r && guardedMilestones([r])[0];
  };
  const getPersona = (id: string) => {
    const r = db.prepare(`SELECT * FROM personas WHERE id = @id AND ${own()}`).get({ id, t: tenant }) as Row | undefined;
    return r && toPersona(r);
  };
  // kept like the list reads (memoRead): the ever-on subquery reads the assignment's runs, and the record
  // writer and the wake brief ask for the same assignment many times a minute (~0.6 s a minute on the main server)
  const getAssignment = (id: string) =>
    memoRead(raw, `assignment\0${tenant}\0${id}`, () => {
      const r = db
        .prepare(`SELECT *, ${EVER_ON_SQL} AS ever_on FROM assignments WHERE id = @id AND ${viaMilestone()}`)
        .get({ id, t: tenant }) as Row | undefined;
      return r ? [toAssignment(r)] : [];
    })[0];
  const getRun = (id: string) => {
    const r = db.prepare(`SELECT * FROM runs WHERE id = @id AND ${own()}`).get({ id, t: tenant }) as Row | undefined;
    return r && toRun(r);
  };
  const getNeedsJordi = (id: string) => {
    const r = db.prepare(`SELECT * FROM needs_jordi WHERE id = @id AND ${own()}`).get({ id, t: tenant }) as Row | undefined;
    return r && toNeedsJordi(r);
  };
  /** Tenant of a milestone row (any tenant), for stamping copies; the home world default when it has none. */
  const tenantOfMilestone = (milestoneId: string): string =>
    (db.prepare("SELECT tenant_id FROM milestones WHERE id = ?").get(milestoneId) as Row | undefined)?.tenant_id ?? DEFAULT_TENANT;
  const tenantOfPersona = (personaId: string): string =>
    (db.prepare("SELECT tenant_id FROM personas WHERE id = ?").get(personaId) as Row | undefined)?.tenant_id ?? DEFAULT_TENANT;
  /** A scoped store only touches rows it can see. */
  const visible = (get: (id: string) => unknown, id: string) => tenant === null || get(id) !== undefined;
  /**
   * the assignment keeps the earliest pending timed wake (and which run asked for it).
   * off means off: a disabled assignment takes no timed wake (the run keeps its own retry_at for the record).
   */
  const requestRetry = (assignmentId: string, runId: string, at: string) => {
    const iso = new Date(at).toISOString();
    db.prepare(
      "UPDATE assignments SET retry_at = ?, retry_run_id = ? WHERE id = ? AND enabled = 1 AND (retry_at IS NULL OR retry_at > ?)",
    ).run(iso, runId, assignmentId, iso);
  };
  const del = (table: string, id: string, get: (id: string) => unknown) =>
    visible(get, id) && db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;

  const requireRefs = (refs: { milestoneId?: string; personaId?: string; runId?: string | null; parentRunId?: string | null }) => {
    if (refs.milestoneId !== undefined && !getMilestone(refs.milestoneId))
      throw new UnknownReference(`milestone ${refs.milestoneId} not found`);
    if (refs.personaId !== undefined && !getPersona(refs.personaId))
      throw new UnknownReference(`persona ${refs.personaId} not found`);
    if (refs.runId != null && !getRun(refs.runId)) throw new UnknownReference(`run ${refs.runId} not found`);
    if (refs.parentRunId != null && !getRun(refs.parentRunId))
      throw new UnknownReference(`parent run ${refs.parentRunId} not found`);
  };
  /** An assignment's milestone and persona live in one tenant (always true while everything is the home world). */
  const requireSameTenant = (milestoneId: string, personaId: string) => {
    if (tenantOfMilestone(milestoneId) !== tenantOfPersona(personaId))
      throw new UnknownReference(`persona ${personaId} is not in the tenant of milestone ${milestoneId}`);
  };

  return {
    /** the tenant this store is scoped to; undefined = unscoped (every tenant, today's behaviour). */
    tenant: tenant ?? undefined,
    /** the world a milestone belongs to (the home world when it has none), so a wake's prompt reads only that world. */
    worldOfMilestone: tenantOfMilestone,
    /** the world a persona belongs to (any tenant). */
    worldOfPersona: tenantOfPersona,

    // Tenants and hosts (read-only here: S5 creates a social world repo, S10 adds boxes)
    listTenants: () =>
      (db.prepare(`SELECT * FROM tenants WHERE (@t IS NULL OR id = @t) ORDER BY created_at, id`).all({ t: tenant }) as Row[]).map(toTenant),
    getTenant: (id: string) => {
      const r = db.prepare(`SELECT * FROM tenants WHERE id = @id AND (@t IS NULL OR id = @t)`).get({ id, t: tenant }) as Row | undefined;
      return r && toTenant(r);
    },
    listHosts: () => (db.prepare(`SELECT * FROM hosts WHERE ${own()} ORDER BY created_at, id`).all({ t: tenant }) as Row[]).map(toHost),

    // Milestones
    /** Settled milestones are hidden unless includeSettled. */
    listMilestones: (f: { includeSettled?: boolean } = {}) =>
      guardedMilestones(db.prepare(`SELECT * FROM milestones WHERE (@all = 1 OR settled_at IS NULL) AND ${own()} ORDER BY created_at, id`).all({ all: f.includeSettled ? 1 : 0, t: tenant }) as Row[]),
    getMilestone,
    /** `id` / `createdAt` given when the team repo's state/milestones.json already carries the entry. */
    createMilestone(input: { title: string; repo: string; path: string; owner: string; paused: boolean; bigRoot?: number | null; id?: string; createdAt?: string }): Milestone {
      const id = input.id ?? newId("ms");
      db.prepare(
        "INSERT INTO milestones (id, title, repo, path, owner, paused, created_at, tenant_id, big_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, input.title, input.repo, input.path, input.owner, input.paused ? 1 : 0, input.createdAt ?? now(), tenant ?? DEFAULT_TENANT, input.bigRoot ?? null);
      return getMilestone(id)!;
    },
    /** `titleSetAt: null` clears the explicit-title mark. */
    updateMilestone(id: string, p: Partial<Omit<Milestone, "id" | "createdAt" | "titleSetAt" | "bigRoot">> & { titleSetAt?: string | null; bigRoot?: number | null }) {
      if (!visible(getMilestone, id)) return undefined;
      const ok = patchRow(db, "milestones", id, {
        title: p.title,
        title_set_at: p.titleSetAt,
        repo: p.repo,
        path: p.path,
        owner: p.owner,
        paused: bool(p.paused),
        big_root: p.bigRoot,
      });
      return ok ? getMilestone(id) : undefined;
    },
    /** settle (at = now) or unsettle (at = null); idempotent, keeps the first settledAt when already settled. */
    setSettled(id: string, settled: boolean, at?: string) {
      const cur = getMilestone(id);
      if (!cur) return undefined;
      if (settled !== !!cur.settledAt) patchRow(db, "milestones", id, { settled_at: settled ? (at ?? now()) : null });
      return getMilestone(id);
    },
    deleteMilestone: (id: string) => del("milestones", id, getMilestone),

    // Personas
    listPersonas: () =>
      memoRead(raw, `personas\0${tenant}`, () => (db.prepare(`SELECT * FROM personas WHERE ${own()} ORDER BY created_at, id`).all({ t: tenant }) as Row[]).map(toPersona)),
    getPersona,
    /** `id` / `createdAt` given when the team repo's persona file already carries it. */
    createPersona(input: { name: string; remit: string; skills: string[]; model: string; mayWrite: boolean; host?: HostId; freshThreadEachWake?: boolean; skipUnchanged?: boolean; id?: string; createdAt?: string }): Persona {
      const id = input.id ?? newId("pe");
      db.prepare(
        "INSERT INTO personas (id, name, remit, skills, model, may_write, host, fresh_thread_each_wake, skip_unchanged, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, input.name, input.remit, JSON.stringify(input.skills), input.model, input.mayWrite ? 1 : 0, input.host ?? mainHost(), input.freshThreadEachWake ? 1 : 0, input.skipUnchanged === false ? 0 : 1, input.createdAt ?? now(), tenant ?? DEFAULT_TENANT);
      return getPersona(id)!;
    },
    updatePersona(id: string, p: Partial<Omit<Persona, "id" | "createdAt">>) {
      if (!visible(getPersona, id)) return undefined;
      const ok = patchRow(db, "personas", id, {
        name: p.name,
        remit: p.remit,
        skills: p.skills && JSON.stringify(p.skills),
        model: p.model,
        may_write: bool(p.mayWrite),
        host: p.host,
        fresh_thread_each_wake: bool(p.freshThreadEachWake),
        skip_unchanged: bool(p.skipUnchanged),
      });
      return ok ? getPersona(id) : undefined;
    },
    deletePersona: (id: string) => del("personas", id, getPersona),

    // Assignments
    listAssignments(f: { milestoneId?: string; personaId?: string } = {}) {
      return memoRead(raw, `assignments\0${tenant}\0${f.milestoneId ?? ""}\0${f.personaId ?? ""}`, () => {
        const rows = db
          .prepare(
            `SELECT *, ${EVER_ON_SQL} AS ever_on FROM assignments
             WHERE (@m IS NULL OR milestone_id = @m) AND (@p IS NULL OR persona_id = @p) AND ${viaMilestone()}
             ORDER BY created_at, id`,
          )
          .all({ m: f.milestoneId ?? null, p: f.personaId ?? null, t: tenant }) as Row[];
        return rows.map(toAssignment);
      });
    },
    getAssignment,
    createAssignment(input: {
      milestoneId: string;
      personaId: string;
      cadence: Cadence;
      enabled: boolean;
      t3ScheduledTaskId?: string | null;
      lastRunAt?: string | null;
      nextRunAt?: string | null;
      writeEnabled?: boolean;
      writeScope?: string;
      /** given when the team repo's state/assignments.json already carries the entry. */
      id?: string;
      createdAt?: string;
    }): Assignment {
      requireRefs({ milestoneId: input.milestoneId, personaId: input.personaId });
      requireSameTenant(input.milestoneId, input.personaId);
      // the persona's may_write is the default for a new assignment only; from here the assignment decides.
      const writeEnabled = input.writeEnabled ?? !!getPersona(input.personaId)?.mayWrite;
      const writeScope = input.writeScope ?? (writeEnabled ? DEFAULT_WRITE_SCOPE : "");
      const id = input.id ?? newId("as");
      db.prepare(
        `INSERT INTO assignments (id, milestone_id, persona_id, cadence, enabled, t3_scheduled_task_id, last_run_at, next_run_at, write_enabled, write_scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.milestoneId,
        input.personaId,
        JSON.stringify(input.cadence),
        input.enabled ? 1 : 0,
        input.t3ScheduledTaskId ?? null,
        input.lastRunAt ?? null,
        input.nextRunAt ?? null,
        writeEnabled ? 1 : 0,
        writeScope,
        input.createdAt ?? now(),
      );
      return getAssignment(id)!;
    },
    updateAssignment(
      id: string,
      p: {
        milestoneId?: string;
        personaId?: string;
        cadence?: Cadence;
        enabled?: boolean;
        t3ScheduledTaskId?: string | null;
        lastRunAt?: string | null;
        nextRunAt?: string | null;
        parkedAt?: string | null;
        parkedReason?: string | null;
        writeEnabled?: boolean;
        writeScope?: string;
        retryAt?: string | null;
        retryRunId?: string | null;
      },
    ) {
      const cur = getAssignment(id);
      if (!cur) return undefined;
      requireRefs({ milestoneId: p.milestoneId, personaId: p.personaId });
      if (p.milestoneId !== undefined || p.personaId !== undefined)
        requireSameTenant(p.milestoneId ?? cur.milestoneId, p.personaId ?? cur.personaId);
      // off means off: switching an assignment off (any route, auto-park included) drops its pending timed wake.
      if (p.enabled === false) p = { ...p, retryAt: null, retryRunId: null };
      patchRow(db, "assignments", id, {
        milestone_id: p.milestoneId,
        persona_id: p.personaId,
        cadence: p.cadence && JSON.stringify(p.cadence),
        enabled: bool(p.enabled),
        t3_scheduled_task_id: p.t3ScheduledTaskId,
        last_run_at: p.lastRunAt,
        next_run_at: p.nextRunAt,
        parked_at: p.parkedAt,
        parked_reason: p.parkedReason,
        write_enabled: bool(p.writeEnabled),
        write_scope: p.writeScope,
        retry_at: p.retryAt,
        retry_run_id: p.retryRunId,
      });
      return getAssignment(id);
    },
    deleteAssignment: (id: string) => del("assignments", id, getAssignment),

    // Runs
    /** Newest first; 500 rows unless `limit`. With `since` (ISO, started at or after) and no `limit`, no cap. */
    listRuns(f: { milestoneId?: string; assignmentId?: string; parentRunId?: string; since?: string; limit?: number } = {}) {
      return memoRead(raw, `runs\0${tenant}\0${JSON.stringify([f.milestoneId, f.assignmentId, f.parentRunId, f.since, f.limit])}`, () => {
        // only the given filters are in the WHERE, so SQLite can use runs_assignment / runs_milestone
        // (`@a IS NULL OR assignment_id = @a` forced a scan and sort of every run on each call).
        const by: [string | undefined, string][] = [
          [f.milestoneId, "milestone_id = @m"],
          [f.assignmentId, "assignment_id = @a"],
          [f.parentRunId, "parent_run_id = @p"],
          [f.since, "started_at >= @s"],
        ];
        const where = by.filter(([v]) => v !== undefined && v !== null).map(([, c]) => c);
        const rows = db
          .prepare(`SELECT * FROM runs WHERE ${[...where, own()].join(" AND ")} ORDER BY started_at DESC, rowid DESC LIMIT @limit`)
          .all({
            ...(f.milestoneId != null ? { m: f.milestoneId } : {}),
            ...(f.assignmentId != null ? { a: f.assignmentId } : {}),
            ...(f.parentRunId != null ? { p: f.parentRunId } : {}),
            ...(f.since != null ? { s: f.since } : {}),
            t: tenant,
            limit: f.limit ?? (f.since ? -1 : 500),
          }) as Row[];
        return rows.map(toRun);
      });
    },
    /**
     * the running child runs (a worker's claim on a row) of one milestone, newest first. claimsFor read every run
     * of every milestone of the repo (up to 1000 rows each) to keep these few, for each milestone on the Team page.
     */
    listRunningChildRuns(milestoneId: string): Run[] {
      return memoRead(raw, `running-children\0${tenant}\0${milestoneId}`, () =>
        (db
          .prepare(`SELECT * FROM runs WHERE milestone_id = @m AND parent_run_id IS NOT NULL AND outcome = 'running' AND ${own()} ORDER BY started_at DESC, rowid DESC`)
          .all({ m: milestoneId, t: tenant }) as Row[]).map(toRun),
      );
    },
    /**
     * the Runs page's Show 20 / 50 / all: the newest `top` wakes (no parent run; all when absent), each
     * with every run under it, and how many wakes there are. The page nests them as before.
     */
    listRunsTop(f: { top?: number; milestoneId?: string } = {}): { runs: Run[]; total: number } {
      const m = f.milestoneId != null ? { m: f.milestoneId } : {};
      const where = [...(f.milestoneId != null ? ["milestone_id = @m"] : []), "parent_run_id IS NULL", own()].join(" AND ");
      const total = db.prepare(`SELECT COUNT(*) FROM runs WHERE ${where}`).pluck().get({ ...m, t: tenant }) as number;
      const roots = db
        .prepare(`SELECT * FROM runs WHERE ${where} ORDER BY started_at DESC, rowid DESC LIMIT @limit`)
        .all({ ...m, t: tenant, limit: f.top ?? -1 }) as Row[];
      const out = [...roots];
      let ids = roots.map((r) => r.id as string);
      for (let depth = 0; ids.length && depth < 5; depth++) {
        const kids = db
          .prepare(`SELECT * FROM runs WHERE parent_run_id IN (SELECT value FROM json_each(@ids)) AND ${own()} ORDER BY started_at DESC, rowid DESC`)
          .all({ ids: JSON.stringify(ids), t: tenant }) as Row[];
        out.push(...kids);
        ids = kids.map((r) => r.id as string);
      }
      return { runs: out.map(toRun), total };
    },
    /**
     * the runs active at some moment of [start, end) (ISO UTC), only the fields the Active agents chart counts.
     * Stored stamps mix `…:00Z` and `…:00.000Z`, so the window is a second wider here and exact in activeSeries.
     */
    listRunsActiveBetween(start: string, end: string): { id: string; startedAt: string; endedAt?: string; kind: string }[] {
      const wide = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
      const rows = db
        .prepare(`SELECT id, started_at, ended_at, kind FROM runs WHERE started_at < @e AND (ended_at IS NULL OR ended_at > @s) AND ${own()}`)
        .all({ s: wide(start, -1000), e: wide(end, 1000), t: tenant }) as Row[];
      return rows.map((r) => ({ id: r.id as string, startedAt: r.started_at as string, endedAt: (r.ended_at as string | null) ?? undefined, kind: r.kind as string }));
    },
    /**
     * the runs live at some moment of [start, end) (ISO UTC) with what places each on a host: its recorded host,
     * launch host, the host of its T3 environment, its parent's same three, and the seat (one old row says `the worker server` there).
     * runHosts.ts picks the first that is known. Same one-second widening as listRunsActiveBetween.
     */
    listRunsHostBetween(start: string, end: string): HostRunRow[] {
      const wide = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
      const env = (alias: string) => `(SELECT e.host FROM t3_environments e WHERE e.environment_id = ${alias}.environment_id)`;
      const rows = db
        .prepare(
          `SELECT r.id, r.started_at, r.ended_at, r.kind, r.host, r.launch_host, ${env("r")} AS env_host, r.seat,
                  p.host AS parent_host, p.launch_host AS parent_launch_host, ${env("p")} AS parent_env_host
           FROM runs r LEFT JOIN runs p ON p.id = r.parent_run_id
           WHERE r.started_at < @e AND (r.ended_at IS NULL OR r.ended_at > @s) AND ${own("r.")}`,
        )
        .all({ s: wide(start, -1000), e: wide(end, 1000), t: tenant }) as Row[];
      const o = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      return rows.map((r) => ({
        id: r.id as string,
        startedAt: r.started_at as string,
        endedAt: o(r.ended_at),
        kind: r.kind as string,
        host: o(r.host),
        launchHost: o(r.launch_host),
        envHost: o(r.env_host),
        parentHost: o(r.parent_host),
        parentLaunchHost: o(r.parent_launch_host),
        parentEnvHost: o(r.parent_env_host),
        seat: o(r.seat),
      }));
    },
    getRun,
    /** the run a POST /api/runs with this clientRequestId already created for this assignment, if any. */
    getRunByClientRequest(assignmentId: string, clientRequestId: string): Run | undefined {
      const r = db
        .prepare(`SELECT * FROM runs WHERE assignment_id = @a AND client_request_id = @k AND ${own()}`)
        .get({ a: assignmentId, k: clientRequestId, t: tenant }) as Row | undefined;
      return r && toRun(r);
    },
    /** The assignment must exist at creation; the row is kept if the assignment is later deleted. */
    createRun(input: {
      assignmentId: string;
      startedAt?: string;
      endedAt?: string | null;
      seat?: string | null;
      threadId?: string | null;
      outcome: Outcome;
      summary: string;
      parentRunId?: string | null;
      kind?: RunKind;
      retryAt?: string | null;
      instructions?: string | null;
      instructionsBy?: string | null;
      checks?: RunCheck[] | null;
      askFingerprint?: string | null;
      nextCheckAt?: string | null;
      until?: string | null;
      reportedOutcome?: string | null;
      heldOn?: string | null;
      /** unique per assignment (index runs_client_request); callers check getRunByClientRequest first. */
      clientRequestId?: string | null;
      /** where the run's agent runs; a child run without one takes its parent's recorded host. */
      host?: HostId | null;
    }): Run {
      const a = getAssignment(input.assignmentId);
      if (!a) throw new UnknownReference(`assignment ${input.assignmentId} not found`);
      requireRefs({ parentRunId: input.parentRunId });
      const id = newId("run");
      const startedAt = input.startedAt ?? now();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO runs (id, assignment_id, milestone_id, persona_id, started_at, ended_at, seat, thread_id, outcome, summary, parent_run_id, kind, retry_at, instructions, instructions_by, checks, ask_fingerprint, next_check_at, monitor_until, reported_outcome, held_on, tenant_id, client_request_id, host)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             COALESCE(?, (SELECT p.host FROM runs p WHERE p.id = ?)))`,
        ).run(
          id,
          a.id,
          a.milestoneId,
          a.personaId,
          startedAt,
          endedAtFor(input.outcome, undefined, input.endedAt, () => startedAt) ?? null,
          input.seat ?? null,
          input.threadId ?? null,
          input.outcome,
          input.summary,
          input.parentRunId ?? null,
          input.kind ?? "wake",
          input.retryAt ? new Date(input.retryAt).toISOString() : null,
          input.instructions || null,
          input.instructions ? input.instructionsBy?.trim() || ownerName() : null,
          input.checks ? JSON.stringify(input.checks) : null,
          input.askFingerprint ?? null,
          isoOrNull(input.nextCheckAt),
          isoOrNull(input.until),
          input.reportedOutcome ?? null,
          input.heldOn ?? null,
          tenantOfMilestone(a.milestoneId),
          input.clientRequestId?.trim() || null,
          input.host ?? null,
          input.parentRunId ?? null,
        );
        const wakeAt = input.retryAt ?? futureCheck(input.outcome, input.nextCheckAt);
        if (wakeAt) requestRetry(a.id, id, wakeAt);
        // Child runs (parentRunId set) and answer runs do not count as a wake of the assignment.
        if (!input.parentRunId && input.kind !== "answer_run")
          db.prepare(
            "UPDATE assignments SET last_run_at = ? WHERE id = ? AND (last_run_at IS NULL OR last_run_at < ?)",
          ).run(startedAt, a.id, startedAt);
      })();
      return getRun(id)!;
    },
    updateRun(
      id: string,
      p: {
        endedAt?: string | null;
        seat?: string | null;
        threadId?: string | null;
        outcome?: Outcome;
        summary?: string;
        parentRunId?: string | null;
        retryAt?: string | null;
        checks?: RunCheck[] | null;
        openAsks?: OpenAsk[] | null;
        askFingerprint?: string | null;
        nextCheckAt?: string | null;
        until?: string | null;
        reportedOutcome?: string | null;
        heldOn?: string | null;
        wakeParts?: WakeParts | null;
        wokeBecause?: string | null;
        startFingerprint?: string | null;
        selfReadied?: string[] | null;
        ruleBroken?: RuleBroken | null;
        startGuards?: StartGuard[] | null;
        noteAck?: string | null;
        preWake?: string | null;
        deferred?: Deferral | null;
        launchHost?: HostId | null;
        host?: HostId | null;
        readyIgnored?: string[] | null;
        repeating?: number | null;
        repeatSince?: string | null;
        stalled?: string | null;
      },
    ) {
      const run = getRun(id);
      if (!run) return undefined;
      if (p.parentRunId === id) throw new UnknownReference("a run cannot be its own parent");
      requireRefs({ parentRunId: p.parentRunId });
      patchRow(db, "runs", id, {
        ended_at: endedAtFor(p.outcome ?? run.outcome, run.endedAt, p.endedAt),
        seat: p.seat,
        thread_id: p.threadId,
        outcome: p.outcome,
        summary: p.summary,
        parent_run_id: p.parentRunId,
        retry_at: p.retryAt && new Date(p.retryAt).toISOString(),
        checks: p.checks === undefined ? undefined : p.checks && JSON.stringify(p.checks),
        open_asks: p.openAsks === undefined ? undefined : p.openAsks && JSON.stringify(p.openAsks),
        ask_fingerprint: p.askFingerprint,
        next_check_at: p.nextCheckAt === undefined ? undefined : isoOrNull(p.nextCheckAt),
        monitor_until: p.until === undefined ? undefined : isoOrNull(p.until),
        reported_outcome: p.reportedOutcome,
        held_on: p.heldOn,
        wake_parts: p.wakeParts === undefined ? undefined : p.wakeParts && JSON.stringify(p.wakeParts),
        woke_because: p.wokeBecause,
        start_fingerprint: p.startFingerprint,
        self_readied: p.selfReadied === undefined ? undefined : p.selfReadied && JSON.stringify(p.selfReadied),
        rule_broken: p.ruleBroken === undefined ? undefined : p.ruleBroken && JSON.stringify(p.ruleBroken),
        start_guard: p.startGuards === undefined ? undefined : p.startGuards && JSON.stringify(p.startGuards),
        note_ack: p.noteAck,
        pre_wake: p.preWake,
        deferred: p.deferred === undefined ? undefined : p.deferred && JSON.stringify(p.deferred),
        launch_host: p.launchHost,
        host: p.host,
        ready_ignored: p.readyIgnored === undefined ? undefined : p.readyIgnored && JSON.stringify(p.readyIgnored),
        repeating: p.repeating,
        repeat_since: p.repeatSince,
        stalled: p.stalled,
      });
      // a monitoring report's next check is also a timed wake request (unless it asked for another time).
      const wakeAt = p.retryAt ?? futureCheck(p.outcome ?? run.outcome, p.nextCheckAt);
      if (wakeAt) requestRetry(run.assignmentId, id, wakeAt);
      return getRun(id);
    },

    // Needs the owner
    listNeedsJordi(f: { status?: string; milestoneId?: string } = {}) {
      const rows = db
        .prepare(
          `SELECT * FROM needs_jordi
           WHERE (@s IS NULL OR status = @s) AND (@m IS NULL OR milestone_id = @m) AND ${own()}
           ORDER BY created_at DESC, id DESC`,
        )
        .all({ s: f.status ?? null, m: f.milestoneId ?? null, t: tenant }) as Row[];
      return rows.map(toNeedsJordi);
    },
    getNeedsJordi,
    createNeedsJordi(input: {
      runId?: string | null;
      milestoneId: string;
      question: string;
      proposedAction: string;
      status: Exclude<NeedsJordi["status"], "superseded">;
    }): NeedsJordi {
      requireRefs({ milestoneId: input.milestoneId, runId: input.runId });
      const id = newId("nj");
      db.prepare(
        `INSERT INTO needs_jordi (id, run_id, milestone_id, question, proposed_action, status, created_at, tenant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.runId ?? null, input.milestoneId, input.question, input.proposedAction, input.status, now(), tenantOfMilestone(input.milestoneId));
      return getNeedsJordi(id)!;
    },
    /**
     * the log line of an ask raised through the API, written once its spine line is in (`by` = `<repo>/<code>`).
     * Stored as superseded by that code: the read path never reads this table (ops log only).
     */
    logRaisedAsk(input: { runId?: string | null; milestoneId: string; question: string; proposedAction: string; by: string }): NeedsJordi {
      requireRefs({ milestoneId: input.milestoneId, runId: input.runId });
      const id = newId("nj");
      const at = now();
      db.prepare(
        `INSERT INTO needs_jordi (id, run_id, milestone_id, question, proposed_action, status, created_at, superseded_by, superseded_at, tenant_id)
         VALUES (?, ?, ?, ?, ?, 'superseded', ?, ?, ?, ?)`,
      ).run(id, input.runId ?? null, input.milestoneId, input.question, input.proposedAction, at, input.by, at, tenantOfMilestone(input.milestoneId));
      return getNeedsJordi(id)!;
    },
    /** Open / approved / denied only; reopening a superseded item clears its supersede fields. */
    updateNeedsJordi(id: string, p: { status: Exclude<NeedsJordi["status"], "superseded"> }) {
      if (!visible(getNeedsJordi, id)) return undefined;
      return patchRow(db, "needs_jordi", id, { status: p.status, superseded_by: null, superseded_at: null }) ? getNeedsJordi(id) : undefined;
    },
    /** retire an item replaced by a coded ask (`by` = `<repo>/<code>`) or moot. Sets status only: no answer, no message. */
    supersedeNeedsJordi(id: string, by?: string) {
      if (!visible(getNeedsJordi, id)) return undefined;
      return patchRow(db, "needs_jordi", id, { status: "superseded", superseded_by: by?.trim() || "moot", superseded_at: now() })
        ? getNeedsJordi(id)
        : undefined;
    },
  };
}

export type Store = ReturnType<typeof createStore>;

/** the store scoped to one tenant (throws UnknownTenant for an unknown id). */
export const forTenant = (db: DB, tenant: string): Store => createStore(db, { tenant });
