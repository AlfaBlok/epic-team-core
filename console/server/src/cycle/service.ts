import { pickArgsFor, pickWith, rememberThread, stampFromThread, stampHost, stampRun } from "../providers/pick.js";
import { ensureProviders } from "../providers/schema.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TENANT, type DB } from "../db.js";
import type { Assignment, Milestone, OpenAsk, Persona, Run, StartGuard, Store } from "../store.js";
import { buildWakePrompt, DEFAULT_MAX_WORKERS, milestoneDeckUrl } from "../wakePrompt.js";
import { teamLink } from "../notify/notice.js";
import type { WakeLink, WakeSkills } from "../teamSkills.js";
import { ruleBrokenSection } from "./gateCore.js";
import type { ChildEpic } from "./children.js";
import { isCredentialRefusal, ROTATE_HINT } from "../t3/tokenWatch.js";
import { T3BusyError, busyKind, errorText, isThreadBusy, matchProject, sendFailureText, type T3Client, type T3Project, type T3ScheduledTask } from "../t3/client.js";
import type { Dispatcher } from "../t3/dispatcher.js";
import { roomLine, type Room } from "./workerRoom.js";
import { pickerFor } from "../t3/hostDispatcher.js";
import { createIdleStopper } from "./idleStop.js";
import { classifyRefusal, DEFER_MAX_MS, deferredSummary, isHostCap, isStartGap, nextDeferral, refusalText, type Refusal } from "./capRefusal.js";
import type { Vps3Target } from "../t3/remoteHost.js";
import { nextRunAfter } from "./nextRun.js";
import { scaleCadence } from "../pursuits.js";
import { cadenceAfterTimedWake, timedCheckReplaces, timedReplacesSummary } from "./timedCheck.js";
import { readSeats, seatBlockerFor } from "../adapters/seats.js";
import type { Tree, TreeNode } from "../adapters/tree.js";
import { isDeliveryManager, isUnblocker } from "../inbox/asks.js";
import { heldRelease, releasedWhy } from "./held.js";
import { gateKindOf, gateSkipSummary, lastRealWake, staleRunMsFor, type GateDecision } from "./gateCore.js";
import type { Grant } from "./grants.js";
import { parkDecision } from "./park.js";
import { SKIP_PREFIX, askFingerprint, cadenceSkipDecision, dataHash, keepSeatSeen, readyPart, spinesHash, wakeFingerprint, workedIds, type WakeState } from "./skipUnchanged.js";
import { wakeParts, wokeBecause } from "./wakeWhy.js";
import { rollupLagMsFromEnv, rollupPart, rollupSection, spineLags, type LastCommitAt, type SpineLag } from "./rollup.js";
import { gitOut } from "../freshness.js";
import { classifyAsks, markCarried, memorySkipDecision, readAskMemory, withPrints } from "./askMemory.js";
import { snapshotRubric } from "./rubric.js";
import { createReconciler, landedCommit, RESENT, USAGE_LIMIT } from "./reconcile.js";
import { gitLog } from "../adapters/outcome.js";
import { createRepoPuller, type GitRunner } from "./repoPull.js";
import { prepareCheckout, preWakeLine, staleSessionReason, type HostGit, type PreWake } from "./preWake.js";
import { createEnvironments, migrateEnvironments } from "./environments.js";
import { FOLLOW_UP_MARK } from "./followUp.js";
import { workersOffText, getWorkerLaunch, migrateWorkerLaunch, saveWorkerLaunch, workerMessage, workerSummary, workerThreadTitle, type WorkerLaunchInput } from "./workerLaunch.js";
import { getHandover, handoverMessage, handoverTitle, migrateHandover, saveHandover, threadUrl, type Handover, type HandoverInput } from "./handover.js";
import {
  bootstrapPrompt,
  inactivePrompt,
  nothingNewPrompt,
  skipPrompt,
  wakeProtocol,
  wakeStub,
} from "./prompts.js";
import { milestoneWorld } from "../tenancy/world.js";
import { hooks, openForJobs, WORLD_WAKE_HOLD_CODE, type JobEnd, type JobRoute, type WorldWakeHold } from "../plug/hooks.js";
import { seatHeldElsewhere, threadRefusal, worldOfRun } from "./threadBinding.js";
import { headSha } from "../gitRefs.js";
import { openGate, type StartGate } from "./startGate.js";
import { checkoutName } from "../adapters/repoNames.js";
import { type HostId, mainHost, ownerName, workerHost, hostReposRoot } from "../identity.js";

export interface CycleOptions {
  /** Kill switch (env CONSOLE_CYCLE_ENABLED). false: no T3 call is ever made and wakes are told to stop. */
  enabled: boolean;
  /** one new the main server session per gap (cycle/startGate.ts; env CONSOLE_SESSION_START_GAP_MS, 0 = off). Unset = no gate. */
  startGate?: StartGate;
  /** a world's hold reason, or undefined when its personas may wake; default from env (on). */
  worldHold?: WorldWakeHold;
  /** worlds whose wakes run on their own job servers (model A); their wakes never start a T3 thread. */
  jobRoute?: JobRoute;
  t3?: T3Client;
  dispatcher?: Dispatcher;
  /** a launch host's own dispatcher (the worker server: its client gates on the worker server memory, reserves centrally); unset = `dispatcher`. */
  hostDispatchers?: Partial<Record<HostId, Dispatcher>>;
  /** world-aware `pick --world --persona` (env CONSOLE_PROVIDER_PICK=on); off = plain `pick`, as before. */
  providerPick?: boolean;
  /** the worker server target (a persona with host the worker server wakes there; undefined = not configured, such wakes fail). */
  worker?: Vps3Target;
  /** console scheduler tick for every assignment, any host (unset/0 = no timer; tests call tickCadence). */
  cadenceTickMs?: number;
  /** Base URL woken agents use to reach this console (env CONSOLE_PUBLIC_URL). */
  publicUrl: string;
  /** the console's name for people (milestone deck links in wakes and briefs); default CONSOLE_TEAM_URL, else the production site. */
  teamUrl?: string;
  /** A running top-level run older than this no longer blocks a wake; it is marked failed. */
  staleRunMs?: number;
  /** A run-now placeholder younger than this is claimed by the next wake instead of a new run. */
  claimWindowMs?: number;
  /**
   * a running run with no thread past this (its start window) can be stopped: Stop closes it instead of 409
   * no_thread. Default NO_THREAD_STOP_MS.
   */
  noThreadStopMs?: number;
  /**
   * a running top-level wake with no thread past this is an orphan (its start failed and its retry was lost or
   * failed too): the reconciler closes it failed and Run now starts a fresh wake instead of answering already_running.
   * Default NO_THREAD_CLOSE_MS.
   */
  noThreadCloseMs?: number;
  bootstrapModel?: string;
  /** M1 seats.json. A wake whose home thread sits on a limited / logged-out seat goes to a new home thread on a seat with headroom. */
  seatsFile?: string;
  /** ceiling of child workers running at once per milestone (default 10; env CONSOLE_MAX_WORKERS_PER_MILESTONE in index.ts). */
  maxWorkersPerMilestone?: number;
  /** the ceiling now, from the broker's free seats and the worker server's memory (cycle/workerRoom.ts); unset = the flat ceiling. */
  workerRoom?: () => Promise<Room>;
  /**
   * effort follows priority: the effort of the owner's best-ranked pursuit carrying this milestone's spine
   * (null = in no pursuit: its cadence and the global ceiling as set). Parked: no cadence wakes, ceiling 0. `priority`
   * = the wake's priority lines (which epics of its repo come first, each one's ceiling).
   */
  effortFor?: (m: Milestone) => { parked: boolean; wakeFactor: number; maxWorkers: number; minWakeMinutes?: number; pursuitName: string } | null;
  priorityFor?: (m: Milestone) => string;
  /** priority mode: why this assignment's cadence and timed wakes wait now (undefined = they may run). */
  wakeHold?: (assignmentId: string) => string | undefined;
  /** the wake prompt's pack section for this persona when the milestone repo has a pack on (undefined / "" = none). */
  packSection?: (m: Milestone, p: Persona, since?: string) => Promise<string | undefined>;
  /** a role brief put right after the prompt's first line (the Writer brief of a social repo); `since` = its last wake's start. */
  roleBrief?: (m: Milestone, p: Persona, since?: string) => Promise<string | undefined>;
  /** the wake's Team services section (which central MCP services this persona may use; undefined = omit). */
  teamServices?: (p: Persona, runId: string) => Promise<string | undefined>;
  /**
   * the persona's team skills (each one's use_when for the `## Skills` lines) and the wake check: `ok: false` (a
   * declared skill not in the library or not installed on the persona's host) fails the wake with its reason, no T3 call.
   */
  teamSkills?: (p: Persona, w?: { milestone?: Milestone; link?: WakeLink }) => Promise<WakeSkills>;
  /** the milestone's non-green tree leaves as a wake-prompt section (undefined = omit). */
  treeTodo?: (m: Milestone) => Promise<string | undefined>;
  /** the milestone's active standing approvals (spines.py `grants`), listed in the wake as section F (undefined = none). */
  grants?: (m: Milestone) => Promise<Grant[]>;
  /** open coded asks of the milestone (as /waiting-on-owner lists them); stored on an Unblocker run at wake. */
  openAsks?: (m: Milestone) => Promise<OpenAsk[]>;
  /**
   * the milestone spine's run state (`spines.py --json` `run_state` / `runnable`).
   * undefined = unknown (no spine, spines.py slow or older than the field): wake as before, one warning per milestone.
   */
  runState?: (m: Milestone) => Promise<RunState | undefined>;
  /** true while the milestone reads Ready to mark (Outcome written, the owner has not marked): cadence and timed wakes skip it. */
  readyToMark?: (m: Milestone) => Promise<boolean>;
  /** the "asked, no row yet" section of a Delivery manager wake (open Done-means lines no ledger row covers; undefined = none). */
  askedNoRow?: (m: Milestone) => Promise<string | undefined>;
  /** open asks the ask gate held back from the owner's inbox (inbox/askGate.ts), for the Delivery Manager to settle. */
  heldAsks?: (m: Milestone) => Promise<string | undefined>;
  /** a bootstrap's new milestone, recorded in the world's state/milestones.json first (default: console.db only). */
  createMilestone?: (input: { title: string; repo: string; path: string; owner: string; paused: boolean }) => Promise<Milestone>;
  /** the section on the repo's commits on main that name no ticket (undefined = none, or not the repo's home milestone). */
  orphanCommits?: (m: Milestone) => Promise<string | undefined>;
  /**
   * every world's orphan commits on main (milestone = the repo's home), read by the orphan sweep (tickOrphans), which
   * wakes that milestone's Delivery Manager when one is older than the grace and no wake since has carried it.
   */
  orphansDue?: () => Promise<Array<{ milestoneId: string; short: string; date: string }>>;
  /** launch board reds with no open row whose owning epic is in this milestone's tree (Delivery Manager only). */
  launchDrafts?: (m: Milestone) => Promise<string | undefined>;
  /**
   * the milestone's objectives below green (docs/pursuits.json): `section` goes into the Delivery Manager's wake,
   * `idle` names the ones with nothing moving; while one is idle the cadence wake is never skipped as "nothing new".
   */
  objectives?: (m: Milestone) => Promise<{ section?: string; idle: string[] }>;
  /**
   * the owner's objectives, his order, live (objectives.ts): `block` opens every wake prompt of the milestone,
   * `line` rides in the first worker rule of every brief. Undefined: another world's milestone (none).
   */
  ownerObjectives?: (m: Milestone) => Promise<{ block: string; line: string } | undefined>;
  /** the repo's open desk-to-desk notes from other worlds (desk/inbox.ts; undefined = none, or not the repo's home milestone). */
  deskInbox?: (m: Milestone) => Promise<string | undefined>;
  /** Mac ticket questions to the Team desk still open for this milestone (a Delivery Manager wake answers them first). */
  deskQuestions?: (m: Milestone, base: string) => Promise<string | undefined>;
  /** a Delivery Manager wake's section on stopped / overdue `Monitoring:` items (write a coded ask or clear the item). */
  monitorAlerts?: (m: Milestone) => Promise<string | undefined>;
  /** the milestone spine's child epics when it has some to steer (undefined = leaf: the usual wake steps). */
  children?: (m: Milestone) => Promise<ChildEpic[] | undefined>;
  /** auto-park: the milestone's epic tree (undefined = no gate; a wake parks only on a non-fallback tree). */
  treeFor?: (m: Milestone) => Promise<Tree>;
  /** how many answered canonical asks of other epics this milestone references (they count as actionable for the park gate). */
  referencedAnswers?: (m: Milestone) => Promise<number>;
  /** re-arm check for parked assignments, run on start and then every N ms (unset/0 = no timer). */
  rearmEveryMs?: number;
  /** close running runs from T3 thread state every N ms (unset/0 = no timer; `reconcile` still works). */
  reconcileEveryMs?: number;
  /** settle ended home threads (stops their idle provider process) every N ms (unset/0 = no timer; `idleStop` still works). */
  idleStopEveryMs?: number;
  /** fire timed wakes (assignment retryAt) every N ms (unset/0 = no timer; `tickRetry` still works). */
  retryTickMs?: number;
  /** model of a handover thread (default opus). */
  handoverModel?: string;
  /**
   * a wake refused at the worker server's load/memory cap launches on the main server when the main server has room. Off by default (the wake defers on the worker server); true is the incident override only
   * (`CONSOLE_CAP_FALLBACK=1`), and also opens the console worker route (POST /api/runs/<id>/workers, the main server launches).
   */
  capFallback?: boolean;
  /** a deferred wake (load-cap, no seat) gives up, failed with the reason, after this many ms (default 60 min). */
  deferMaxMs?: number;
  /** a wake T3 refused because the thread stayed busy re-wakes this many ms later (default 5 min)... */
  busyRewakeMs?: number;
  /**...at most this many times in a row (default 3); then the run fails with T3's cause. */
  busyRewakeCap?: number;
  /** a Run now / timed wake whose send failed (not busy, not "not found") retries once this many ms later (default 5 min; 0 = fail at once). */
  sendRetryMs?: number;
  /** Run now answers with the run row after this many ms even if the wake (e.g. a first thread launch) is still going (default 10 s). */
  runNowReplyMs?: number;
  /**
   * git for the run-end pull of the milestone's checkout on this host (unset = no pulls; index.ts
   * passes the real one). With `repoDir` (the checkout `resolveRepo` reads) and `onRepoPulled` (spines.py cache drop).
   */
  git?: GitRunner;
  repoDir?: (m: Milestone) => string | undefined;
  onRepoPulled?: (repoDir: string) => void;
  /** A wake pulls first when the last pull of its repo is older than this (default 60 s). */
  wakePullMaxAgeMs?: number;
  /**
   * this long after a cadence wake ended, pull its checkout again and re-stamp its fingerprint when only the
   * spine text moved (the wake's own Current State commit landing after its PATCH). Default 3 min; 0 = off.
   */
  restampAfterMs?: number;
  /**
   * newest commit time on some paths of a checkout (the roll-up check of a Delivery Manager wake); default
   * `git log -1 --format=%cI -- <paths>`.
   */
  lastCommitAt?: LastCommitAt;
  /** a parent's Current State is due for a roll-up when its Verified at is this old and a child moved since (default 24 h, CONSOLE_ROLLUP_LAG_HOURS). */
  rollupLagMs?: number;
  /** told when a run ended (same moments as the run-end pull), e.g. to collect its token usage. */
  onRunEnded?: (runId: string) => void;
  /**
   * git on the persona's host (the main server here, the worker server over ssh) for the pre-wake pull + tool fingerprint of its
   * checkout; unset = no pre-wake step (home threads are reused as before).
   */
  hostGit?: HostGit;
  /**
   * credit gate (credits/gate.ts): before any wake (cadence, timed, Run now, answer wake: all go through runNow),
   * a world out of credits with its gate on gets a held run back and nothing reaches T3. Unset or undefined = wake.
   */
  creditGate?: (a: Assignment, m: Milestone) => Run | undefined;
  /**
   * no-model pre-check of a cadence or timed wake (cycle/wakeGate.ts): `work: false` records an idle skip and
   * starts nothing; `work: true` wakes (past the unchanged-skip) and `commit` runs once the wake starts. Undefined = no gate.
   */
  wakeGate?: (a: Assignment, m: Milestone, p: Persona, runs: Run[], opts?: { readOnly?: boolean }) => Promise<GateDecision | undefined>;
}

/** the orphan sweep reads the orphan list this often, gives a fresh orphan this long to be named, and re-wakes after this. */
export const ORPHAN_CHECK_MS = 5 * 60_000;
export const ORPHAN_GRACE_MS = 10 * 60_000;
export const ORPHAN_REWAKE_MS = 6 * 3_600_000;

/** planning | ready | running | parked | finished; a wake works only `runnable` spines (Status ready, active, blocked). */
export interface RunState {
  state: string;
  runnable: boolean;
}

/** HTTP-mapped cycle errors (status + code). */
/** parkedReason of an assignment parked because its milestone is settled. */
export const SETTLED_REASON = "settled";

export class CycleError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface AssignmentLink {
  assignmentId: string;
  projectId?: string;
  threadId?: string;
  seat?: string;
  /** the T3 target the home thread lives on. */
  host: HostId;
  syncState: "none" | "pending" | "synced" | "error";
  syncError?: string;
  pendingRunId?: string;
  setupStartedAt?: string;
  /** tool fingerprint (preWake.ts) of the checkout when the home thread's session started. */
  toolFp?: string;
}

/** summary of a wake deferred because the thread was busy (also how the re-wake cap counts them). */
export const BUSY_PREFIX = "thread busy";
/** summary of a cadence wake the console scheduler started, until the persona's /wake claims it. */
const CADENCE_PENDING = "Cadence wake: waiting for the persona to wake";
/** a real cadence wake's first summary names why it woke (the persona's report replaces it; `wokeBecause` stays). */
const wokeLine = (why?: string) => (why ? `Woke on cadence · woke: ${why}` : "Woke on cadence");
const TERMINAL = new Set(["progressed", "blocked", "monitoring", "idle", "failed", "blank_report", "stopped"]);
/** summary of a run whose wake send failed once and waits for its one retry. */
export const SEND_RETRY_PREFIX = "Run now: send failed";
/** a run with no thread this long after its start can be stopped (a launch in flight gets this long). */
export const NO_THREAD_STOP_MS = 2 * 60_000;
/**
 * a top-level wake still running with no thread after this is closed by the console. Past the send retry (5 min)
 * and a worker-server coding start (12 min); a start still in flight (`starting`) is never closed. Production
 * 2026-10-30..11-13: no wake that reported back ever ran over 15 min without a thread; the ones that did were all stuck.
 */
export const NO_THREAD_CLOSE_MS = 15 * 60_000;
/** a starter's note queued into the running wake (no second wake): act on it in this wake, report on this run only. */
export function queuedNoteText(by: string, note: string, runId: string): string {
  return [
    `${by}'s note, queued by the console into this running wake (run ${runId}) instead of starting a second wake:`,
    "<<<",
    note,
    ">>>",
    `Act on it in this wake and say what you did about it in this run's report (\`queued note: done|not done: <why>\`). Report on run ${runId} only; do not PATCH any other run with this report.`,
  ].join("\n");
}
/** a send failure worth one later retry: not a console refusal, not an unknown thread or task. */
const retryableSend = (e: unknown) => !(e instanceof CycleError) && !/not[_ ]found/i.test(errorText(e));

/** persona.model is free text in the UI; map it to a T3 model id. */
export function modelId(model: string): string {
  const m = model.trim().toLowerCase();
  if (m.startsWith("claude-")) return model.trim();
  for (const k of ["opus", "sonnet", "haiku"]) if (m.includes(k)) return `claude-${k}-5-5`;
  if (m.includes("fable")) return "claude-fable-5-1";
  return "claude-sonnet-5-5";
}

export function migrateCycle(db: DB) {
  // Side tables (not in db.ts MIGRATIONS) so the core schema version stays owned by the CRUD layer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycle_assignment_link (
      assignment_id TEXT PRIMARY KEY,
      project_id TEXT,
      thread_id TEXT,
      seat TEXT,
      sync_state TEXT NOT NULL DEFAULT 'none',
      sync_error TEXT,
      pending_run_id TEXT,
      setup_started_at TEXT,
      host TEXT NOT NULL DEFAULT '${mainHost()}'
    );
    CREATE TABLE IF NOT EXISTS cycle_bootstrap (
      milestone_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      goal TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cycle_seat_hold (
      run_id TEXT PRIMARY KEY,
      seat TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cycle_run_steer (
      run_id TEXT NOT NULL,
      at TEXT NOT NULL,
      mode TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cycle_run_steer_run ON cycle_run_steer(run_id, at);
  `);
  // host of the home thread (side table, idempotent; older tables lack the column).
  const cols = db.prepare("PRAGMA table_info(cycle_assignment_link)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "host")) db.exec(`ALTER TABLE cycle_assignment_link ADD COLUMN host TEXT NOT NULL DEFAULT '${mainHost()}'`);
  if (!cols.some((c) => c.name === "tool_fp")) db.exec("ALTER TABLE cycle_assignment_link ADD COLUMN tool_fp TEXT");
  migrateEnvironments(db); // triggers stamping runs.environment_id
  migrateHandover(db);
  migrateWorkerLaunch(db);
}

type Row = Record<string, any>;
/** one steer the owner sent into a running run's thread. */
export type RunSteer = { at: string; mode: "steer" | "auto"; message: string };
const opt = <T>(v: T | null | undefined) => (v == null ? undefined : v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createCycle(db: DB, store: Store, o: CycleOptions) {
  /** the milestone's effort from the owner's pursuits; a bad read is no effort (the pace as set). */
  const effortOf = (m: Milestone) => {
    try {
      return o.effortFor?.(m) ?? null;
    } catch {
      return null;
    }
  };
  migrateCycle(db);
  const gate = o.startGate ?? openGate;
  ensureProviders(db);
  const worldPick = o.providerPick ?? process.env.CONSOLE_PROVIDER_PICK === "on";
  const base = o.publicUrl.replace(/\/+$/, "");
  const staleMs = o.staleRunMs ?? 3 * 3600_000;
  const claimMs = o.claimWindowMs ?? 15 * 60_000;
  const noThreadStopMs = o.noThreadStopMs ?? NO_THREAD_STOP_MS;
  const noThreadCloseMs = o.noThreadCloseMs ?? NO_THREAD_CLOSE_MS;
  /** wake runs whose start (host start, send, launch) is in flight now: never closed as an orphan meanwhile. */
  const starting = new Set<string>();
  /** run id -> when the reconciler re-sent its wake; the claim window restarts there. */
  const resentAt = new Map<string, number>();
  const background = new Set<Promise<unknown>>();
  /** Console URL a persona on this host is given: the worker server reaches the console through the reverse forward. */
  const baseFor = (host: HostId) => (host === workerHost() && o.worker ? o.worker.publicUrl : base);
  const iso = () => new Date().toISOString();
  /** why this milestone's world may not wake an agent on a shared host (undefined = it may). */
  const worldHold = openForJobs(o.worldHold ?? hooks.worldWakeGate(), o.jobRoute); // a job world is let through
  const worldOfM = (m: Milestone) => store.worldOfMilestone(m.id);
  // the milestone's deck (the home world's Deck tab; another world's milestone has no deck) in every wake and worker brief.
  const deckUrlOf = (m: Milestone) =>
    (worldOfM(m) ?? DEFAULT_TENANT) === DEFAULT_TENANT ? milestoneDeckUrl(o.teamUrl ?? process.env.CONSOLE_TEAM_URL ?? teamLink(), m.id) : undefined;
  const holdOf = (m: Milestone) => worldHold(worldOfM(m));
  /** the world when its wakes run on its own job servers (model A), else undefined (a T3 thread, as before). */
  const jobRoute = o.jobRoute;
  const jobWorldOf = (m: Milestone | undefined): string | undefined => {
    const w = m ? worldOfM(m) : undefined;
    return w && jobRoute?.handles(w) ? w : undefined;
  };
  const heldLogged = new Set<string>();
  /** Cadence and timed ticks skip a held world's assignment quietly: one log line per assignment per process. */
  const skipHeld = (a: Assignment, m: Milestone): boolean => {
    const hold = holdOf(m);
    if (!hold) return false;
    if (!heldLogged.has(a.id)) {
      heldLogged.add(a.id);
      console.log(`world wake gate ${a.id} (${worldOfM(m)}): ${hold}`);
    }
    return true;
  };
  const refuseHeld = (m: Milestone) => {
    const hold = holdOf(m);
    if (hold) throw new CycleError(409, WORLD_WAKE_HOLD_CODE, hold, { world: worldOfM(m) });
  };

  // ---------- link table ----------
  const getLink = (id: string): AssignmentLink | undefined => {
    const r = db.prepare("SELECT * FROM cycle_assignment_link WHERE assignment_id = ?").get(id) as Row | undefined;
    return (
      r && {
        assignmentId: r.assignment_id,
        projectId: opt(r.project_id),
        threadId: opt(r.thread_id),
        seat: opt(r.seat),
        host: r.host === workerHost() ? workerHost() : mainHost(),
        syncState: r.sync_state,
        syncError: opt(r.sync_error),
        pendingRunId: opt(r.pending_run_id),
        setupStartedAt: opt(r.setup_started_at),
        toolFp: opt(r.tool_fp),
      }
    );
  };
  const setLink = (id: string, p: Partial<Omit<AssignmentLink, "assignmentId">>) => {
    db.prepare("INSERT OR IGNORE INTO cycle_assignment_link (assignment_id) VALUES (?)").run(id);
    const cols: Record<string, unknown> = {
      project_id: p.projectId,
      thread_id: p.threadId,
      seat: p.seat,
      host: p.host,
      sync_state: p.syncState,
      sync_error: p.syncError,
      pending_run_id: p.pendingRunId,
      setup_started_at: p.setupStartedAt,
      tool_fp: p.toolFp,
    };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (set.length)
      db.prepare(`UPDATE cycle_assignment_link SET ${set.map(([k]) => `${k} = ?`).join(", ")} WHERE assignment_id = ?`).run(
        ...set.map(([, v]) => v),
        id,
      );
  };
  const clearLinkField = (id: string, col: "pending_run_id" | "sync_error") =>
    db.prepare(`UPDATE cycle_assignment_link SET ${col} = NULL WHERE assignment_id = ?`).run(id);

  // ---------- thread environments ----------
  /** A host's T3 only if it can be read now: the worker server only while its tunnel is up (never starts the box). */
  const environments = createEnvironments({
    db,
    clientFor: (h) => (!o.enabled ? undefined : h === mainHost() ? o.t3 : o.worker?.tunnelUp() ? o.worker.client : undefined),
  });
  let vps3EnvRead = false;
  /** Read host environment ids not known yet (the worker server once per process while reachable), then backfill runs. Never throws. */
  const environmentTick = async () => {
    try {
      if (!environments.hostEnvironment(mainHost())) await environments.refreshHost(mainHost());
      if (!vps3EnvRead && o.worker?.tunnelUp()) vps3EnvRead = !!(await environments.refreshHost(workerHost()));
      await environments.backfill();
    } catch (e) {
      console.error("thread environments:", errorText(e));
    }
  };

  // ---------- helpers ----------
  const t3 = () => {
    if (!o.enabled) throw new CycleError(409, "cycle_disabled", "the console cycle is off (CONSOLE_CYCLE_ENABLED is not true)");
    if (!o.t3) throw new CycleError(503, "t3_unavailable", "no T3 client configured");
    return o.t3;
  };
  type Host = HostId;
  /** The T3 client of a host. the worker server without a configured target is an error, never a fallback to the main server. */
  const clientFor = (host: Host): T3Client => {
    if (host === mainHost()) return t3();
    t3(); // kill switch
    if (!o.worker) throw new CycleError(502, "vps3_unavailable", `${workerHost()} unavailable: ${workerHost()} target not configured (CONSOLE_VPS3_SSH / CONSOLE_VPS3_MCP_URL)`);
    return o.worker.client;
  };
  /** the worker server: run `coding start`, tunnel and health check. Any failure is a vps3_unavailable error (no fallback). */
  const ensureHost = async (host: Host) => {
    if (host !== workerHost()) return;
    clientFor(host);
    try {
      await o.worker!.ensure();
    } catch (e) {
      throw new CycleError(502, "vps3_unavailable", `${workerHost()} unavailable: ${errorText(e)}`);
    }
    await environments.refreshHost(workerHost()); // before the run gets its thread, so the trigger stamps it (never throws)
  };
  /** A link whose thread is on another host than the persona's now belongs to the old host: forget the thread. */
  const linkFor = (id: string, host: Host): AssignmentLink | undefined => {
    const l = getLink(id);
    if (!l || !l.threadId || l.host === host) return l;
    db.prepare("UPDATE cycle_assignment_link SET thread_id = NULL, project_id = NULL, seat = NULL, tool_fp = NULL, host = ? WHERE assignment_id = ?").run(host, id);
    return getLink(id);
  };
  const ctx = (id: string) => {
    const a = store.getAssignment(id);
    if (!a) throw new CycleError(404, "not_found", `assignment ${id} not found`);
    const m = store.getMilestone(a.milestoneId)!;
    const p = store.getPersona(a.personaId)!;
    return { a, m, p };
  };
  const projectCache = new Map<Host, { at: number; list: T3Project[] }>();
  const listProjects = async (host: Host, fresh = false) => {
    let pc = projectCache.get(host);
    if (fresh || !pc || Date.now() - pc.at > 60_000) {
      pc = { at: Date.now(), list: await clientFor(host).listProjects() };
      projectCache.set(host, pc);
    }
    return pc.list;
  };
  /** Repos are cloned at the same path on every host: ~/github/<repo name> (a renamed repo keeps its old folder). */
  const repoName = (repo: string) => checkoutName(repo);
  const ensuring = new Map<string, Promise<{ project: T3Project; chain?: string }>>();
  /** register (and if needed clone) a missing repo on its host, root L-12. Never falls back to another host. */
  const ensureProject = async (repo: string, host: Host): Promise<{ project: T3Project; chain?: string }> => {
    const name = repoName(repo);
    const root = path.join(hostReposRoot(), name);
    const client = clientFor(host);
    const afterRegister = async () => {
      const list = await listProjects(host, true);
      return matchProject(list, repo) ?? list.find((p) => p.workspaceRoot === root);
    };
    const fail = (msg: string) => new CycleError(400, "repo_not_cloned", `${host}: ${msg}`);
    if (!client.createProject) throw new CycleError(400, "unknown_project", `no T3 project is registered on ${host} for repo ${repo}`);
    const register = async (workspaceRoot: string) => {
      await client.createProject!({ title: name, workspaceRoot });
      return afterRegister();
    };
    let createError: Error;
    try {
      const project = await register(root);
      if (project) return { project, chain: `registered project on ${host}` };
      createError = new Error("project not listed after create");
    } catch (e) {
      createError = e as Error;
    }
    const raced = await afterRegister().catch(() => undefined); // registered meanwhile (e.g. by another run)
    if (raced) return { project: raced };
    // create failed (directory missing / not a git checkout): clone, then register
    if (!client.cloneProject || !/^[\w.-]+\/[\w.-]+$/.test(repo.replace(/\.git$/, "")))
      throw fail(`repo ${repo} is not cloned at ${root} and cannot be cloned (needs owner/name): ${createError.message}`);
    let cwd: string;
    try {
      cwd = (await client.cloneProject({ repository: repo.replace(/\.git$/, ""), destinationPath: root })).cwd;
    } catch (e) {
      throw fail(`could not clone ${repo} into ${root}: ${errorText(e)}`);
    }
    try {
      const project = await register(cwd);
      if (project) return { project, chain: `cloned + registered on ${host}` };
      throw new Error("project not listed after create");
    } catch (e) {
      throw fail(`cloned ${repo} into ${cwd} but could not register it: ${errorText(e)}`);
    }
  };
  /** The T3 project of a repo on a host, plus what the missing-project chain did (if anything). */
  const resolveProjectEx = async (repo: string, host: Host = mainHost()): Promise<{ project: T3Project; chain?: string }> => {
    const found = matchProject(await listProjects(host), repo);
    if (found) return { project: found };
    const key = `${host}|${repo}`; // one create/clone per (host, repo) in flight; concurrent wakes share it
    let p = ensuring.get(key);
    if (!p) {
      p = ensureProject(repo, host).finally(() => ensuring.delete(key));
      ensuring.set(key, p);
    }
    return p;
  };
  const resolveProject = async (repo: string, host: Host = mainHost()) => (await resolveProjectEx(repo, host)).project;
  /**
   * Pick a seat for a thread. hold=false releases it right away (long-lived home threads). With the world pick on
   * the dispatcher answers for the persona's world + provider + model; `stamp` is what the run records either way.
   * `host` is where the thread launches; that host's dispatcher picks (and gates on its memory), the release
   * goes to the central one (one shared reservation store). No host = the central dispatcher, as before.
   */
  /**
   * `fallback` (fresh-thread and new-home-thread wakes): the worker server refused at its load or memory cap → pick on the main server
   * (the central dispatcher, which gates on the main server's own memory and CPU load); `host` in the answer is where the thread
   * must launch. A refusal throws CycleError `no_seat` with the owner's wording (`load-cap on the worker server (…), will retry`, never
   * "no seat available") and details `{ retryable, refusals }`: a retryable one defers the wake instead of failing it.
   */
  /** a wake note that is the owner's own (his words or his voice note): its wake may fall back to his kept seat. */
  const ownersNote = (by: string | null | undefined) => by === ownerName() || by === "voice note";
  const pickSeat = async (model: string, hold: boolean, personaId?: string, host?: Host, opt: { fallback?: boolean; startGate?: "take" | "mark"; owner?: boolean; ownerFallback?: boolean } = {}) => {
    if (!o.dispatcher) throw new CycleError(503, "no_dispatcher", "EPICSPINE_DISPATCHER is not set");
    const args = pickArgsFor(db, personaId, model);
    const what = `pick ${personaId ?? "seat"} (${model})`;
    // a pick on the main server is a session start: one per gap (closed = a retryable refusal, the wake waits for the gate).
    // `mark` (the owner's own action: an answer, a handover, a bootstrap) never waits but counts once it got a seat.
    const marking = opt.startGate === "mark";
    let slot = host === workerHost() || marking ? 0 : takeStart(what);
    let r = await pickWith(pickerFor(host, o.dispatcher, o.hostDispatchers), worldPick, args, modelId, opt.owner);
    let at: Host | undefined = host;
    let fellBack: Refusal | undefined;
    const refusals: Refusal[] = [];
    // a wake that carries the owner's own note takes the seat kept for him only when no other seat can take it
    if (r.seat === null && opt.ownerFallback && !opt.owner && /^no seat\b|team worker ceiling/i.test(r.reason)) {
      const mine = await pickWith(pickerFor(host, o.dispatcher, o.hostDispatchers), worldPick, args, modelId, true);
      if (mine.seat !== null) r = mine;
    }
    if (r.seat === null) {
      gate.cancel(slot);
      const first = classifyRefusal(r.reason);
      refusals.push(first);
      if (opt.fallback && host === workerHost() && first.host === workerHost() && isHostCap(first) && o.capFallback === true) {
        const t = marking ? ({ ok: true, token: 0 } as const) : gate.take(`${what}, ${workerHost()} capped`);
        if (!t.ok) refusals.push(classifyRefusal(t.reason));
        else {
          slot = t.token;
          r = await pickWith(o.dispatcher, worldPick, args, modelId); // the main server: local pick, the main server's memory + load gates
          if (r.seat === null) refusals.push(classifyRefusal(r.reason)), gate.cancel(slot);
          else (at = mainHost()), (fellBack = first);
        }
      }
    }
    if (r.seat === null) {
      const retryable = refusals.every((x) => x.retryable);
      throw new CycleError(503, "no_seat", refusalText(refusals), { retryable, refusals });
    }
    if (marking && at !== workerHost()) gate.mark(what);
    if (!hold) await o.dispatcher.done(r.seat).catch(() => undefined);
    return { seat: r.seat, modelSelection: { instanceId: r.providerInstanceId, model: r.stamp!.model }, stamp: r.stamp, host: at, fellBack };
  };
  /**
   * the infra repo S9, at most 6 agent sessions on the main server. A pick on the main server is gated by the broker (`session cap on
   * the main server`); a wake into an existing the main server home thread takes no pick, so it asks the same count first. Over the cap it
   * throws a retryable `no_seat`: the wake is deferred (`session-cap on the main server (6 live / cap 6), will retry`), never
   * dropped. An unreadable count never blocks.
   */
  const sessionGate = async (host: Host) => {
    if (host !== mainHost() || !o.dispatcher?.sessions) return;
    const s = await o.dispatcher.sessions().catch(() => undefined);
    if (!s?.full) return;
    const r = classifyRefusal(`session cap on ${mainHost()}: ${s.live} live (cap ${s.cap})`);
    throw new CycleError(503, "no_seat", refusalText([r]), { retryable: true, refusals: [r] });
  };
  /**
   * claim the next the main server session start for `what`, or throw the retryable start-gap refusal (`session-start gap on
   * the main server (last start 30 s ago / gap 90 s), will retry`): the wake is deferred until the gate opens (defer below).
   */
  const takeStart = (what: string): number => {
    const t = gate.take(what);
    if (t.ok) return t.token;
    const r = classifyRefusal(t.reason);
    throw new CycleError(503, "no_seat", refusalText([r]), { retryable: true, refusals: [r] });
  };
  /** a deferral held only by the start gap retries when the gate opens (+ a little, so ties spread), not on the backoff. */
  const gapRetryMs = (reason: string) => (isStartGap(reason) ? gate.waitMs() + 1_000 + Math.floor(Math.random() * 4_000) : undefined);
  /** a pick refusal a later attempt may get past (load-cap, all seats busy, ceiling, dispatcher unreachable). */
  /** why the home thread's seat cannot take a turn now (`seat1 limited until …`, `seat2 logged out`), else undefined. */
  const seatBlocked = seatBlockerFor(o.seatsFile, { persona: true, owner: ownerName() }); // never the seat kept for the owner
  const isDeferrable = (e: unknown): e is CycleError =>
    e instanceof CycleError && e.code === "no_seat" && !!(e.details as { retryable?: boolean } | undefined)?.retryable;
  const track = (pr: Promise<unknown>) => {
    const p = pr.catch((e) => console.error("cycle background:", e)).finally(() => background.delete(p));
    background.add(p);
  };
  const runningRun = (assignmentId: string): Run | undefined =>
    store.listRuns({ assignmentId, limit: 50 }).find((r) => r.outcome === "running" && !r.parentRunId && r.kind === "wake");
  /** a Publisher's run is stale sooner (wakeGate.ts PUBLISHER_STALE_MS). */
  const staleFor = (r: Run) => staleRunMsFor(r.personaId ? store.getPersona(r.personaId) : undefined, staleMs);
  const isStale = (r: Run) => Date.now() - Date.parse(r.startedAt) > staleFor(r);
  /**
   * a running top-level wake with no thread past noThreadCloseMs whose start is not in flight: its start failed
   * and nothing will ever claim it (2026-11-12: a T3 401 at start, then "running" with no thread for 2.5 h,
   * Stop said no_thread and Run now already_running). A job server's wake has no T3 thread by design and is left alone.
   */
  const isOrphan = (r: Run): boolean => {
    if (r.threadId || r.outcome !== "running" || r.parentRunId || r.kind !== "wake") return false;
    if (starting.has(r.id) || retrying.has(r.id)) return false;
    if (Date.now() - Date.parse(r.startedAt) <= noThreadCloseMs) return false;
    const a = store.getAssignment(r.assignmentId);
    const m = a ? store.getMilestone(a.milestoneId) : undefined;
    return !(m && jobWorldOf(m));
  };
  /** close an orphan wake failed, with what its start said, so the next start is a fresh wake (never already_running). */
  function closeOrphan(r: Run, by: string): Run {
    const mins = Math.round((Date.now() - Date.parse(r.startedAt)) / 60_000);
    const done = store.updateRun(r.id, {
      outcome: "failed",
      endedAt: iso(),
      retryAt: null,
      nextCheckAt: null,
      summary: `No thread after ${mins} min: the wake never started (${r.summary.trim().slice(0, 400) || "no start note"}); closed by the console (${by}) so a new wake can start`,
    })!;
    if (getLink(r.assignmentId)?.pendingRunId === r.id) clearLinkField(r.assignmentId, "pending_run_id");
    const a = store.getAssignment(r.assignmentId);
    if (a?.retryRunId === r.id) store.updateAssignment(a.id, { retryAt: null, retryRunId: null });
    console.warn(`orphan wake ${r.id} (${r.assignmentId}): no thread after ${mins} min, closed failed (${by})`);
    track(releaseSeatHold(r.id));
    track(onRunEnded(r.id));
    return done;
  }
  /** the assignment's live wake (running, top-level, not stale): every starter asks this one question before it starts a wake. */
  const liveWake = (assignmentId: string): Run | undefined => {
    const r = runningRun(assignmentId);
    if (r && isOrphan(r)) {
      closeOrphan(r, "at the next start");
      return undefined;
    }
    return r && !isStale(r) ? r : undefined;
  };
  // ---------- assignment ↔ T3 scheduled task ----------
  /** a task titled `console:<id>`, then end or a space (never one of an assignment whose id merely starts with it). */
  const ownsTask = (id: string) => (t: T3ScheduledTask) => t.title === `console:${id}` || !!t.title?.startsWith(`console:${id} `);
  /**
   * every task on the main server's T3 titled for this assignment, in its milestone repo's project. undefined = could not
   * list (logged; callers keep the tracked-id behaviour). One listScheduledTasks per call; projects come from the cache.
   */
  async function titledTasks(id: string, m: Milestone, link?: AssignmentLink): Promise<T3ScheduledTask[] | undefined> {
    try {
      const projectId = (link?.host === mainHost() && link.projectId) || matchProject(await listProjects(mainHost()), m.repo)?.id;
      if (!projectId) return [];
      return (await t3().listScheduledTasks(projectId)).filter(ownsTask(id));
    } catch (e) {
      console.error(`sync ${id}: list T3 tasks:`, errorText(e));
      return undefined;
    }
  }
  /**
   * delete the assignment's tasks; one that will not delete is paused instead (root L-10: it must not
   * wake). Logged; never throws. Only ever called with tasks listed under the assignment's `console:` title (ownsTask).
   */
  async function dropTasks(id: string, tasks: T3ScheduledTask[]): Promise<string[]> {
    const left: string[] = [];
    for (const t of tasks) {
      try {
        await t3().deleteScheduledTask(t.id);
        console.log(`sync ${id}: deleted T3 scheduled task ${t.id} (${t.title ?? ""})`);
      } catch (e) {
        console.error(`sync ${id}: delete T3 scheduled task ${t.id}:`, errorText(e));
        left.push(t.id);
        await t3().updateScheduledTask(t.id, { enabled: false }).catch(() => undefined);
      }
    }
    return left;
  }

  /**
   * Make T3 match the assignment. The console scheduler (tickCadence) wakes every persona, any host, so the main server's
   * T3 holds no task for an assignment: tasks titled `console:<id>` (created by the setup turn before) are deleted,
   * nothing else is ever touched. Idempotent: a second sync lists none and deletes nothing. nextRunAt comes from the cadence.
   */
  async function sync(id: string): Promise<void> {
    if (!o.enabled) return;
    const a = store.getAssignment(id);
    if (!a) return;
    const m = store.getMilestone(a.milestoneId)!;
    try {
      const found = await titledTasks(id, m, getLink(id));
      const tracked = a.t3ScheduledTaskId;
      if (found) {
        const left = await dropTasks(id, found);
        // the tracked id goes once its task is gone: deleted now, or no longer listed under its title (deleted earlier)
        if (tracked && !left.includes(tracked)) store.updateAssignment(id, { t3ScheduledTaskId: null });
      }
      // could not list: the tracked task (created under its title) is paused, never deleted unseen, so it cannot double-wake
      if (!found && tracked) await t3().updateScheduledTask(tracked, { enabled: false }).catch(() => undefined);
      const live = a.enabled && !m.paused;
      store.updateAssignment(id, { nextRunAt: live ? nextRunAfter(a.cadence, new Date()).toISOString() : null });
      if (!found) throw new Error("could not list T3 scheduled tasks; retried on the next sync");
      setLink(id, { syncState: "synced" });
      clearLinkField(id, "sync_error");
    } catch (e) {
      setLink(id, { syncState: "error", syncError: errorText(e) });
      throw e;
    }
  }

  /**
   * once per console start, sync every assignment that may still have a T3 scheduled task (a tracked id, or a
   * the main server persona: the setup turn made one per assignment). Deletes only `console:`-titled tasks. Never throws.
   */
  async function clearTasks(): Promise<string[]> {
    if (!o.enabled || !o.t3) return [];
    const done: string[] = [];
    for (const a of store.listAssignments()) {
      if (!a.t3ScheduledTaskId && store.getPersona(a.personaId)?.host !== mainHost()) continue;
      await sync(a.id).then(() => done.push(a.id), (e) => console.error(`clear T3 tasks ${a.id}:`, errorText(e)));
    }
    return done;
  }

  async function onAssignmentDeleted(a: Assignment, projectId?: string) {
    const link = getLink(a.id);
    db.prepare("DELETE FROM cycle_assignment_link WHERE assignment_id = ?").run(a.id);
    if (!o.enabled || !o.t3) return;
    // a pre- task the first sync could not delete; only tasks listed under the assignment's title go.
    const proj = (link?.host === mainHost() && link.projectId) || projectId;
    const m = store.getMilestone(a.milestoneId);
    const tasks = proj ? (await o.t3.listScheduledTasks(proj)).filter(ownsTask(a.id)) : m ? ((await titledTasks(a.id, m)) ?? []) : [];
    await dropTasks(a.id, tasks);
  }

  // ---------- auto-park ----------
  /** Tree for the gate; undefined on no tree adapter, no spine path or any build error (never parks). */
  const gateTree = async (m: Milestone): Promise<Tree | undefined> => {
    if (!o.treeFor || !m.path) return undefined;
    try {
      return await o.treeFor(m);
    } catch {
      return undefined;
    }
  };

  const refAnswers = async (m: Milestone): Promise<number> => {
    if (!o.referencedAnswers || !m.path) return 0;
    try {
      return await o.referencedAnswers(m);
    } catch {
      return 0;
    }
  };

  /**
   * Disable the assignment, pause its T3 task and log a skipped run: the park is an Activity / run-log line only.:
   * it raises no Needs the owner note (it asked nothing); notes earlier parks raised are not inbox items (`isParkNote`).
   */
  async function park(a: Assignment, reason: string, threadId: string | null, seat: string | null) {
    store.updateAssignment(a.id, { enabled: false, parkedAt: iso(), parkedReason: reason });
    await sync(a.id).catch((e) => console.error(`auto-park sync ${a.id}:`, e));
    return store.createRun({ assignmentId: a.id, outcome: "idle", endedAt: iso(), threadId, seat, summary: `parked: ${reason}` });
  }

  /** a settled milestone's assignment parks (disabled, T3 task paused, one run-log line, no Needs the owner note). */
  async function parkSettled(a: Assignment, threadId: string | null, seat: string | null) {
    store.updateAssignment(a.id, { enabled: false, parkedAt: iso(), parkedReason: SETTLED_REASON });
    await sync(a.id).catch((e) => console.error(`settled-park sync ${a.id}:`, e));
    return store.createRun({ assignmentId: a.id, outcome: "idle", endedAt: iso(), threadId, seat, summary: `parked: ${SETTLED_REASON}` });
  }

  // ---------- runnable gate ----------
  const runStateWarned = new Set<string>();
  /** The milestone's run_state when its spine is not runnable (planning, parked, finished); undefined = wake (runnable or unknown). */
  async function notRunnable(m: Milestone): Promise<string | undefined> {
    if (!o.runState || !m.path) return undefined;
    const s = await o.runState(m).catch(() => undefined);
    if (!s) {
      if (!runStateWarned.has(m.id)) console.warn(`run_state unknown for milestone ${m.id} (${m.path}): waking as before`);
      runStateWarned.add(m.id);
      return undefined;
    }
    runStateWarned.delete(m.id);
    return s.runnable ? undefined : s.state;
  }

  /** the skip state of a Ready to mark milestone (undefined = wake; unreadable = wake as before). */
  async function awaitingMark(m: Milestone): Promise<string | undefined> {
    if (!o.readyToMark) return undefined;
    return (await o.readyToMark(m).catch(() => false)) ? "ready to mark" : undefined;
  }

  /** One run-log line `skipped: <run_state>` (not repeated while it is still the newest run): no run started, no seat taken. */
  function logNotRunnable(a: Assignment, state: string, threadId: string | null, seat: string | null): Run {
    const summary = `skipped: ${state}`;
    const last = store.listRuns({ assignmentId: a.id, limit: 1 })[0];
    if (last?.summary === summary && last.outcome === "idle") return last;
    return store.createRun({ assignmentId: a.id, outcome: "idle", endedAt: iso(), threadId, seat, summary });
  }

  /** Re-enable parked assignments whose milestone tree has actionable nodes again. Hand-disabled ones are left alone. */
  async function rearmParked(): Promise<string[]> {
    const rearmed: string[] = [];
    for (const a of store.listAssignments()) {
      if (!a.parkedAt || a.enabled) continue;
      const m = store.getMilestone(a.milestoneId);
      if (!m || m.settledAt) continue; // settled stays parked until unsettled
      const d = parkDecision(await gateTree(m), await refAnswers(m));
      if (d.park && a.parkedReason === SETTLED_REASON) store.updateAssignment(a.id, { parkedReason: d.reason }); // unsettled: reason no longer stale
      if (d.park || d.actionable === undefined) continue; // still nothing to do, or no trustworthy tree: stay parked
      store.updateAssignment(a.id, { enabled: true, parkedAt: null, parkedReason: null });
      await sync(a.id).catch((e) => console.error(`auto-park re-arm sync ${a.id}:`, e));
      store.createRun({ assignmentId: a.id, outcome: "idle", endedAt: iso(), summary: `re-armed: ${d.actionable} actionable` });
      rearmed.push(a.id);
    }
    return rearmed;
  }

  /**
   * console scheduler for every persona, any host (no T3 scheduled tasks). Wakes each enabled, due
   * assignment through the Run-now path; nextRunAt advances first so a failed start is retried on the next cadence, not
   * hot. The park gate and the unchanged-skip run before any T3 call: a skipped wake costs no turn, thread or tunnel.
   */
  async function tickCadence(now: Date = new Date()): Promise<string[]> {
    if (!o.enabled || (!o.t3 && !jobRoute)) return [];
    const woken: string[] = [];
    for (const a of store.listAssignments()) {
      const p = store.getPersona(a.personaId);
      const m = store.getMilestone(a.milestoneId);
      if (!p || !m || !a.enabled || m.paused || m.settledAt) continue;
      if (!o.t3 && !jobWorldOf(m)) continue; // no T3 client: only the job worlds wake
      if (skipHeld(a, m)) continue; // no wake of a world without its own box (nextRunAt stays: it wakes when the gate opens)
      if (o.wakeHold?.(a.id)) continue; // priority mode: nextRunAt stays, it wakes when the mode ends
      const effort = effortOf(m);
      if (effort?.parked) continue; // its pursuit is parked: no cadence wakes (Run now still wakes it)
      const cadence = scaleCadence(a.cadence, effort, effort?.minWakeMinutes); // effort follows priority
      if (!a.nextRunAt) {
        store.updateAssignment(a.id, { nextRunAt: nextRunAfter(cadence, now).toISOString() });
        continue;
      }
      // a faster pace pulls a far-off next wake in (rank raised); a slower one waits for the next wake as booked.
      const pulledIn = !!effort && cadence !== a.cadence && !!a.lastRunAt && nextRunAfter(cadence, new Date(a.lastRunAt)).getTime() <= now.getTime();
      if (Date.parse(a.nextRunAt) > now.getTime() && !pulledIn) continue;
      const next = nextRunAfter(cadence, now);
      store.updateAssignment(a.id, { nextRunAt: next.toISOString(), lastRunAt: now.toISOString() });
      if (liveWake(a.id) || deferredWake(a.id)) continue; // still running, or deferred (it retries itself): skip this tick
      const timed = timedCheckReplaces(a.retryAt, next, now); // the timed check due this hour wakes instead
      if (timed) {
        store.createRun({ assignmentId: a.id, outcome: "idle", endedAt: iso(), summary: timedReplacesSummary(timed, a.retryRunId) });
        continue;
      }
      const notRun = (await notRunnable(m)) ?? (await awaitingMark(m)); // a planning / parked / finished spine is not worked; nor one waiting for the owner's mark
      if (notRun) {
        logNotRunnable(a, notRun, null, null);
        continue;
      }
      const gate = parkDecision(await gateTree(m), await refAnswers(m)); // nothing to do: park without starting the box
      if (gate.park) {
        await park(a, gate.reason, null, null);
        continue;
      }
      const link = getLink(a.id);
      const home = link?.host === p.host ? link : undefined;
      await pullBeforeWake(m); // compare with what is pushed, not a checkout one commit behind
      const g = await preCheck(a, m, p); // no model run when the gate sees no work
      if (g.skipped) continue;
      const u = g.work ? { why: `pre-check: ${g.work.why}` } : await unchangedSkip(a, m, p, home?.threadId ?? null, home?.seat ?? null);
      if (u.skipped) continue; // nothing new, no turn
      try {
        const run = await runNow(a.id);
        if (store.getRun(run.id)?.outcome === "running") g.work?.commit?.();
        // labelled as the cadence wake it is (the claiming /wake keeps it: "Woke on cadence", as T3 tasks did)
        if (store.getRun(run.id)?.summary.startsWith("Run now:")) store.updateRun(run.id, { summary: CADENCE_PENDING });
        if (u.why) store.updateRun(run.id, { wokeBecause: u.why }); // why it was not skipped
        woken.push(a.id);
      } catch (e) {
        console.error(`cadence scheduler ${a.id}:`, errorText(e));
      }
    }
    return woken;
  }

  /**
   * timed wakes: a run that finished with `retryAt` asks for a wake at that time. Due ones fire through the Run-now
   * path (any host) and are cleared; while a run of the assignment is still running the request stays pending for the
   * next tick (skip rule unchanged). Paused / settled milestones drop the request. Off means off: a disabled
   * assignment's request is dropped, never fired (only a manual Run now wakes an off persona).
   */
  async function tickRetry(now: Date = new Date()): Promise<string[]> {
    if (!o.enabled || (!o.t3 && !jobRoute)) return [];
    const woken: string[] = [];
    for (const a of store.listAssignments()) {
      if (!a.retryAt || Date.parse(a.retryAt) > now.getTime()) continue;
      const m = store.getMilestone(a.milestoneId);
      if (!o.t3 && !jobWorldOf(m)) continue; // no T3 client: only the job worlds wake
      const clear = () => store.updateAssignment(a.id, { retryAt: null, retryRunId: null });
      if (!a.enabled || !m || m.paused || m.settledAt) {
        clear();
        continue;
      }
      if (liveWake(a.id) || deferredWake(a.id)) continue;
      if (skipHeld(a, m)) continue; // the request stays pending until the world has its own box
      if (o.wakeHold?.(a.id)) continue; // priority mode: the request stays pending until it ends
      clear();
      const notRun = (await notRunnable(m)) ?? (await awaitingMark(m)); // a follow-up wake does not work a spine that stopped being runnable (or waits for the owner's mark)
      if (notRun) {
        logNotRunnable(a, notRun, null, null);
        continue;
      }
      const src0 = a.retryRunId ? store.getRun(a.retryRunId) : undefined;
      // a timed check (not a release of a held run) passes the same no-model pre-check as a cadence wake.
      const g = heldRelease(src0, a.retryAt) ? {} : await (async () => (await pullBeforeWake(m), preCheck(a, m, store.getPersona(a.personaId))))();
      if (g.skipped) continue;
      try {
        const run = await runNow(a.id);
        if (store.getRun(run.id)?.outcome === "running") g.work?.commit?.();
        const cadenceAt = cadenceAfterTimedWake(a.cadence, a.nextRunAt, now); // this wake replaces the hour's cadence wake
        if (cadenceAt) store.updateAssignment(a.id, { nextRunAt: cadenceAt });
        const src = a.retryRunId ? store.getRun(a.retryRunId) : undefined;
        const booked = src?.summary.includes(FOLLOW_UP_MARK);
        const released = heldRelease(src, a.retryAt); // the egress or credits it was held on came back
        const why = released
          ? releasedWhy(src!.heldOn!, src!.id)
          : booked
            ? `Follow-up wake (booked by run ${a.retryRunId}: steps still ready)`
            : `Timed wake (retryAt ${a.retryAt}, requested by run ${a.retryRunId ?? "?"})`;
        if (store.getRun(run.id)?.summary.startsWith("Run now:")) store.updateRun(run.id, { summary: `${why}: waiting for the persona to wake` });
        if (store.getRun(run.id)?.outcome === "running") store.updateRun(run.id, { wokeBecause: why }); // a timed wake records why it woke too
        woken.push(a.id);
      } catch (e) {
        console.error(`timed wake ${a.id}:`, errorText(e));
      }
    }
    return woken;
  }

  /**
   * the wake section on orphan commits only
   * reached a Delivery Manager wake that ran, so a repo whose home milestone is finished, parked, waiting for its mark, on a
   * 12 h cadence or skipped as unchanged never saw them (epicspine-skill fee7d83 sat 2.5 days). This sweep, every
   * ORPHAN_CHECK_MS on the scheduler tick, wakes the home milestone's Delivery Manager through Run now (past the runnable,
   * park and unchanged gates; the wake prompt carries the section) when an orphan is older than ORPHAN_GRACE_MS and no
   * wake of it started after the newest orphan; the same orphans still unlinked wake it again after ORPHAN_REWAKE_MS.
   */
  let orphanCheckedAt = 0;
  async function tickOrphans(now: Date = new Date()): Promise<string[]> {
    if (!o.enabled || !o.t3 || !o.orphansDue) return [];
    if (now.getTime() - orphanCheckedAt < ORPHAN_CHECK_MS) return [];
    orphanCheckedAt = now.getTime();
    const due = await o.orphansDue().catch((e) => (console.error("orphan sweep:", errorText(e)), []));
    const byMilestone = new Map<string, Array<{ short: string; date: string }>>();
    for (const c of due) byMilestone.set(c.milestoneId, [...(byMilestone.get(c.milestoneId) ?? []), c]);
    const woken: string[] = [];
    for (const [milestoneId, cs] of byMilestone) {
      if (!cs.some((c) => now.getTime() - Date.parse(c.date) >= ORPHAN_GRACE_MS)) continue;
      const m = store.getMilestone(milestoneId);
      if (!m || m.paused || m.settledAt) continue;
      const a = store.listAssignments({ milestoneId }).find((x) => (x.enabled || (!!x.parkedAt && x.parkedReason !== SETTLED_REASON)) && isDeliveryManager(store.getPersona(x.personaId)?.name)); // auto-parked counts, hand-switched-off does not
      if (!a || skipHeld(a, m) || liveWake(a.id) || deferredWake(a.id)) continue;
      const newest = Math.max(...cs.map((c) => Date.parse(c.date)));
      const carried = store
        .listRuns({ assignmentId: a.id, limit: 100 })
        .find((r) => !r.parentRunId && r.kind === "wake" && r.outcome !== "failed" && !r.heldOn && !/^(skipped|held|parked|re-armed)\b/.test(r.summary) && Date.parse(r.startedAt) > newest);
      if (carried && now.getTime() - Date.parse(carried.startedAt) < ORPHAN_REWAKE_MS) continue;
      const why = `orphan commits: ${cs.map((c) => c.short).join(", ")}`;
      try {
        const run = await runNow(a.id);
        if (store.getRun(run.id)?.summary.startsWith("Run now:")) store.updateRun(run.id, { summary: `Orphan-commit wake (${why}): waiting for the persona to wake` });
        if (store.getRun(run.id)?.outcome === "running") store.updateRun(run.id, { wokeBecause: why });
        woken.push(a.id);
      } catch (e) {
        console.error(`orphan wake ${a.id}:`, errorText(e));
      }
    }
    return woken;
  }

  const timers: NodeJS.Timeout[] = [];
  // the worker server tunnel (local T3 forward + reverse console forward) stays up while the worker server run is open or a wake is imminent.
  if (o.worker) {
    o.worker.setActivity(() => {
      const openRuns = db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs r JOIN assignments a ON a.id = r.assignment_id JOIN personas p ON p.id = a.persona_id
           WHERE r.outcome = 'running' AND p.host = ? AND r.started_at > ?`,
        )
        .get(workerHost(), new Date(Date.now() - staleMs).toISOString()) as { n: number };
      if (openRuns.n > 0) return true;
      // a desk chat (Team, repo, world desk) whose live thread runs on the worker server keeps the forward up for its reads
      try {
        if (db.prepare("SELECT 1 FROM desk_session WHERE host = ? AND ended_at IS NULL LIMIT 1").get(workerHost())) return true;
      } catch {
        /* no desk table (tests) */
      }
      const soon = new Date(Date.now() + 2 * 60_000).toISOString();
      const due = db
        .prepare(
          `SELECT COUNT(*) AS n FROM assignments a JOIN personas p ON p.id = a.persona_id
           WHERE p.host = ? AND ((a.enabled = 1 AND a.next_run_at IS NOT NULL AND a.next_run_at <= ?) OR (a.enabled = 1 AND a.retry_at IS NOT NULL AND a.retry_at <= ?))`,
        )
        .get(workerHost(), soon, soon) as { n: number };
      return due.n > 0;
    });
    if (o.cadenceTickMs && o.cadenceTickMs > 0) {
      const t = setInterval(() => o.worker!.maintain(), Math.min(15_000, o.cadenceTickMs));
      t.unref();
      timers.push(t);
    }
  }
  if (o.cadenceTickMs && o.cadenceTickMs > 0) {
    // the first tick waits for the start-up clear of pre- T3 tasks (no double wake from a task still live)
    const cleared = clearTasks().catch(() => []);
    const t = setInterval(
      () =>
        void cleared
          .then(() => tickCadence())
          .then(() => tickOrphans())
          .catch((e) => console.error("cadence scheduler:", e)),
      o.cadenceTickMs,
    );
    t.unref();
    timers.push(t);
  }
  if (o.retryTickMs && o.retryTickMs > 0) {
    const t = setInterval(() => {
      void tickRetry().catch((e) => console.error("timed wake:", e));
      void tickDeferred().catch((e) => console.error("deferred wake:", e));
    }, o.retryTickMs);
    t.unref();
    timers.push(t);
  }
  if (o.rearmEveryMs && o.rearmEveryMs > 0) {
    const tick = () => void rearmParked().catch((e) => console.error("auto-park re-arm:", e));
    timers.push(setTimeout(tick, 5_000), setInterval(tick, o.rearmEveryMs));
    timers.forEach((t) => t.unref());
  }

  // ---------- run-end pull ----------
  const puller = o.git ? createRepoPuller({ git: o.git, onPulled: o.onRepoPulled }) : undefined;
  const repoDirOf = (m: Milestone | undefined) => (puller && m && o.repoDir ? o.repoDir(m) : undefined);
  /** A run ended (PATCH with endedAt, or the reconciler closed it): fast-forward its milestone's checkout. Never throws. */
  async function onRunEnded(runId: string): Promise<void> {
    const run = store.getRun(runId);
    if (!run?.endedAt) return;
    o.onRunEnded?.(runId);
    const milestoneId = store.getAssignment(run.assignmentId)?.milestoneId ?? run.milestoneId;
    const dir = milestoneId ? repoDirOf(store.getMilestone(milestoneId)) : undefined;
    if (dir) await puller!.pull(dir);
    if (run.askFingerprint) {
      await stampWake(runId); // the state this wake left behind is the new baseline
      const after = o.restampAfterMs ?? 180_000;
      if (dir && after > 0) {
        const t = setTimeout(() => {
          timers.splice(timers.indexOf(t), 1);
          track(restampOwnCommit(runId, dir));
        }, after);
        t.unref();
        timers.push(t);
      }
    }
  }
  const pullBeforeWake = async (m: Milestone) => {
    const dir = repoDirOf(m);
    if (dir) await puller!.pullIfOlder(dir, o.wakePullMaxAgeMs ?? 60_000);
  };

  // ---------- console-recorded runs ----------
  const reconciler = createReconciler({
    db,
    store,
    /** threads are read from the T3 they live on. the worker server without a target is skipped (never read from the main server). */
    t3For: (assignmentId, run) => {
      if (run?.launchHost === mainHost()) return o.t3; // the main server fallback launch of the worker server persona
      if (getLink(assignmentId)?.host !== workerHost() && run?.launchHost !== workerHost()) return o.t3;
      o.worker?.touchTunnel(); // same tunnel as the wakes; no coding start
      return o.worker?.client;
    },
    dispatcher: o.dispatcher,
    link: (id) => getLink(id),
    onClosed: async (runId) => {
      await releaseSeatHold(runId);
      track(onRunEnded(runId));
    },
    // an unreported worker whose commits (Run: trailer) are on the milestone repo landed its work.
    landed: async (run) => {
      const dir = run.milestoneId ? repoDirOf(store.getMilestone(run.milestoneId)) : undefined;
      if (!dir) return undefined;
      await puller!.pullIfOlder(dir, 5 * 60_000).catch(() => undefined);
      return landedCommit(gitLog, dir, run);
    },
    staleRunMs: staleMs,
    graceMs: claimMs,
    resend: (run, why, fresh) => resendWake(run, why, fresh),
    // a wake with no thread past its start (send failed, retry lost) is closed, never left for Run now to meet
    orphan: (r) => (isOrphan(r) ? (closeOrphan(r, "reconciler"), true) : false),
  });
  const reconcile = async () => {
    if (!(o.enabled && o.t3)) return { closed: [], noted: [], adopted: [] };
    const r = await reconciler.tick();
    await environmentTick();
    return r;
  };
  if (o.reconcileEveryMs && o.reconcileEveryMs > 0) {
    const tick = () => void reconcile().catch((e) => console.error("reconcile:", e));
    timers.push(setTimeout(tick, 10_000), setInterval(tick, o.reconcileEveryMs));
    timers.slice(-2).forEach((x) => x.unref());
  }

  // ---------- stop idle provider sessions of ended wakes ----------
  const idleStopper = createIdleStopper({
    db,
    clientFor: (h) => (!o.enabled ? undefined : h === mainHost() ? o.t3 : o.worker?.tunnelUp() ? o.worker.client : undefined),
  });
  const idleStop = async () => (o.enabled && o.t3 ? idleStopper.tick() : []);
  if (o.idleStopEveryMs && o.idleStopEveryMs > 0) {
    const tick = () => void idleStop().catch((e) => console.error("idle stop:", e));
    timers.push(setTimeout(tick, 30_000), setInterval(tick, o.idleStopEveryMs));
    timers.slice(-2).forEach((x) => x.unref());
  }

  // ----------: skip a cadence wake with nothing new ----------
  /**
   * fingerprint of what a cadence persona's wake would see (spine files of the milestone's tree at the checkout,
   * running child runs, ready-rows-and-a-free-seat (which rows, Delivery Manager only), newest console answer; the repo's data/ files). Undefined when it cannot be read (no tree,
   * no checkout): such a wake always runs.
   */
  /** The milestone's tree at its checkout, with every node and the text of each spine file in it (undefined: no tree or checkout). */
  async function treeFiles(m: Milestone): Promise<{ dir: string; tree: Tree; nodes: TreeNode[]; files: Map<string, string | undefined> } | undefined> {
    const dir = o.repoDir?.(m);
    if (!o.treeFor || !m.path || !dir) return undefined;
    let tree: Tree;
    try {
      tree = await o.treeFor(m);
    } catch {
      return undefined;
    }
    const files = new Map<string, string | undefined>();
    const nodes: TreeNode[] = [];
    const walk = (n: TreeNode) => {
      nodes.push(n);
      if (n.path && n.path.endsWith(".md") && !files.has(n.path)) {
        try {
          files.set(n.path, fs.readFileSync(path.resolve(dir, n.path), "utf8"));
        } catch {
          files.set(n.path, undefined);
        }
      }
      n.children.forEach(walk);
    };
    walk(tree.root);
    return { dir, tree, nodes, files };
  }
  // one `git log -1` per parent spine on every poll of every assignment was a large share of the console's git
  // spawns; the answer only changes when HEAD moves, so it is kept per (checkout, HEAD, paths).
  const lastCommits = new Map<string, string | undefined>();
  const lastCommitAt: LastCommitAt =
    o.lastCommitAt ??
    ((dir, paths) => {
      const sha = headSha(dir);
      const key = sha ? `${dir}\0${sha}\0${paths.join("\0")}` : undefined;
      if (key && lastCommits.has(key)) return Promise.resolve(lastCommits.get(key));
      return gitOut(10_000)(dir, ["log", "-1", "--format=%cI", "--", ...paths]).then(
        (s) => {
          const at = s.trim() || undefined;
          if (key) {
            if (lastCommits.size > 5000) lastCommits.clear();
            lastCommits.set(key, at);
          }
          return at;
        },
        () => undefined,
      );
    });
  /** the spines of the milestone's tree whose Current State lags their children (root first). */
  const lagsOf = (t: { dir: string; tree: Tree; files: Map<string, string | undefined> }): Promise<SpineLag[]> =>
    spineLags(t.tree.root, t.files, (paths) => lastCommitAt(t.dir, paths), Date.now(), o.rollupLagMs ?? rollupLagMsFromEnv()).catch(() => []);
  /** the Delivery Manager's roll-up section for this milestone (undefined when nothing lags). */
  async function rollupFor(m: Milestone): Promise<string | undefined> {
    const t = await treeFiles(m);
    return t ? rollupSection(await lagsOf(t), m.path) : undefined;
  }

  async function wakeState(a: Assignment, m: Milestone): Promise<{ fingerprint: string; readyAndSeatFree: boolean; parts: WakeState; readyIds: string[] } | undefined> {
    const t = await treeFiles(m);
    if (!t || !t.files.size) return undefined;
    const { dir, nodes, files } = t;
    const runs = store.listRuns({ assignmentId: a.id, limit: 100 });
    const running = runs.filter((r) => r.parentRunId && r.outcome === "running").map((r) => r.id);
    const worked = workedIds(runs);
    const readyNodes = nodes.filter((n) => n.ready && !worked.has(n.id.toUpperCase()));
    const readyIds = readyNodes.map((n) => n.id);
    // ready rows count only for a persona that dispatches (the Delivery Manager); the others never start them.
    const dispatches = isDeliveryManager(store.getPersona(a.personaId)?.name);
    const readyIdle = dispatches && readyIds.length > 0; // the seat is only looked up when there are ready rows
    const seatFree = readyIdle && o.dispatcher?.status ? await o.dispatcher.status().then((s) => s.available > 0, () => false) : false;
    const answer = db.prepare("SELECT id FROM jordi_responses WHERE milestone_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(m.id) as { id: string } | undefined;
    const readyAndSeatFree = readyIdle && seatFree;
    const todo = o.treeTodo ? await o.treeTodo(m).catch(() => "") : "";
    const grants = o.grants ? await o.grants(m).catch(() => []) : [];
    // a new rule-broken run is news for the Delivery Manager (its next cadence wake must not skip it).
    const flagged = dispatches ? ruleBrokenIds(m) : "";
    const prompt = [todo ?? "", JSON.stringify(grants), flagged].join("\n");
    // a parent's Current State lagging its children is news for the Delivery Manager (bookkeeping-only child
    // commits do not move the spines part), and stays news while the children keep moving.
    const rollup = dispatches ? rollupPart(await lagsOf(t)) : "";
    // the ready rows themselves (tree keys: unique even when every Issue cell reads `draft`) are a part, so the same set is not news.
    const parts: WakeState = { spines: spinesHash(files), running, readyAndSeatFree, ...(readyIdle ? { ready: readyNodes.map((n) => n.key) } : {}), answer: answer?.id ?? "", prompt, data: dataHash(dir), ...(rollup ? { rollup } : {}) };
    return { fingerprint: wakeFingerprint(parts), readyAndSeatFree, parts, readyIds };
  }
  /** ids of the milestone's runs flagged rule broken in the last week ("" when none). */
  const ruleBrokenIds = (m: Milestone) =>
    store
      .listRuns({ milestoneId: m.id, since: new Date(Date.now() - 7 * 86_400_000).toISOString() })
      .filter((r) => r.ruleBroken)
      .map((r) => r.id)
      .join(",");
  /** the rule-broken section of a Delivery Manager wake: runs flagged since its previous wake started (else the last day). */
  function ruleBrokenFor(m: Milestone, a: Assignment, runId: string): string | undefined {
    const prev = store.listRuns({ assignmentId: a.id, limit: 20 }).find((r) => r.id !== runId && r.kind === "wake" && !r.parentRunId);
    const since = prev?.startedAt ?? new Date(Date.now() - 86_400_000).toISOString();
    const runs = store.listRuns({ milestoneId: m.id, since: new Date(Date.parse(since) - 7 * 86_400_000).toISOString() });
    return ruleBrokenSection(runs, since, (r) => store.getPersona(r.personaId ?? store.getAssignment(r.assignmentId)?.personaId ?? "")?.name);
  }
  /** the wake gate's verdict; a "no work" verdict is recorded as an idle skip run (no T3 call). */
  async function preCheck(a: Assignment, m: Milestone, p: Persona | undefined): Promise<{ skipped?: Run; work?: GateDecision }> {
    if (!o.wakeGate || !p || !p.skipUnchanged) return {};
    const runs = store.listRuns({ assignmentId: a.id, limit: 100 });
    const d = await o.wakeGate(a, m, p, runs).catch((e) => {
      console.error(`wake pre-check ${a.id}:`, errorText(e));
      return undefined;
    });
    if (!d) return {};
    if (d.work) return { work: d };
    return { skipped: store.createRun({ assignmentId: a.id, outcome: "idle", endedAt: iso(), summary: gateSkipSummary(lastRealWake(runs)?.id, d.why) }) };
  }
  const skipsGeneral = (p: Persona) => p.skipUnchanged && !isUnblocker(p.name);
  /** the milestone's idle objectives, for its Delivery Manager only (the persona that owns them); [] for the others. */
  const idleObjectivesOf = async (m: Milestone, p: Persona): Promise<string[]> =>
    isDeliveryManager(p.name) && o.objectives ? (await o.objectives(m).catch(() => ({ idle: [] as string[] }))).idle : [];
  const idleWhy = (ids: string[]) => `objective${ids.length === 1 ? "" : "s"} below green with nothing moving: ${ids.join(", ")}`;

  /**
   * A cadence wake (the console scheduler, or a pre- T3 task still firing; never Run now, a timed wake or a wake by the DM/the owner)
   * with nothing new: record an idle run and start no thread. Undefined = wake as usual. Unblocker: its open asks
   * and grants match its last finished run, which left every ask (the run copies its checks, skipped: true). Any
   * other persona: the wake fingerprint matches the last real wake's (cadenceSkipDecision). Opt-out: skipUnchanged off.
   * when the wake is not skipped, `why` says which fingerprint part changed (or which skip rule did not hold).
   */
  async function unchangedSkip(a: Assignment, m: Milestone, p: Persona, threadId: string | null, seat: string | null): Promise<{ skipped?: Run; why?: string }> {
    if (!p.skipUnchanged) return { why: "skipping is off for this persona" };
    if (a.retryAt && Date.parse(a.retryAt) <= Date.now()) return { why: "its next check is due" }; // a due next check is news, never "nothing new"
    const idleObjectives = await idleObjectivesOf(m, p);
    if (idleObjectives.length) return { why: idleWhy(idleObjectives) }; // an objective below green with nothing moving is news
    if (!isUnblocker(p.name)) {
      const s = await wakeState(a, m);
      const runs = store.listRuns({ assignmentId: a.id, limit: 100 });
      const why = () => wokeBecause(runs, s && wakeParts(s.parts), s?.fingerprint, { readyIds: s?.readyIds });
      if (!s) return { why: why() }; // ready rows + a free seat are a fingerprint part, no longer a bypass
      const d = cadenceSkipDecision(runs, s.fingerprint, undefined, undefined, readyPart(s.parts));
      if (!d.skip) return { why: why() };
      const skipped = store.createRun({ assignmentId: a.id, outcome: "idle", endedAt: iso(), threadId, seat, summary: d.summary, askFingerprint: s.fingerprint });
      return { skipped: store.updateRun(skipped.id, { wakeParts: wakeParts(s.parts) }) ?? skipped };
    }
    if (!o.openAsks) return { why: "no open-asks reader" };
    const openAsks = await o.openAsks(m).catch(() => undefined);
    if (!openAsks) return { why: "open asks unreadable" };
    const grants = o.grants ? await o.grants(m).catch(() => []) : [];
    const fingerprint = askFingerprint(openAsks, grants);
    const runs = store.listRuns({ assignmentId: a.id, limit: 100 });
    // skip unless an open ask is new or changed since the run that assessed it (per-ask memory).
    const d = memorySkipDecision(runs, openAsks, classifyAsks(openAsks, grants, readAskMemory(db, m.id)));
    if (!d.skip) return { why: d.why };
    return { skipped: store.createRun({ assignmentId: a.id, outcome: "idle", endedAt: iso(), threadId, seat, summary: d.summary, checks: d.checks, askFingerprint: fingerprint }) };
  }

  /**
   * what the assignment's next cadence wake would see and decide, read-only (GET /api/assignments/:id/wake-check):
   * the fingerprint and its parts, the ready rows nobody is on, and skip or why not. Undefined: unknown assignment.
   */
  async function wakeCheck(id: string) {
    const a = store.getAssignment(id);
    const p = a && store.getPersona(a.personaId);
    const m = a && store.getMilestone(a.milestoneId);
    if (!a || !p || !m) return undefined;
    const runs = store.listRuns({ assignmentId: id, limit: 100 });
    const last = runs.find((r) => !r.parentRunId && r.kind !== "answer_run" && r.askFingerprint && !r.summary.startsWith(SKIP_PREFIX));
    const base = { assignmentId: id, persona: p.name, skipUnchanged: p.skipUnchanged, lastRealWake: last && { id: last.id, outcome: last.outcome, fingerprint: last.askFingerprint, wakeParts: last.wakeParts } };
    if (isUnblocker(p.name)) {
      // each open ask against the per-ask memory, and what the next cadence wake would do.
      const openAsks = o.openAsks ? await o.openAsks(m).catch(() => undefined) : undefined;
      if (!openAsks) return { ...base, unblocker: true };
      const grants = o.grants ? await o.grants(m).catch(() => []) : [];
      const asks = classifyAsks(openAsks, grants, readAskMemory(db, m.id));
      const d = memorySkipDecision(runs, openAsks, asks);
      return { ...base, unblocker: true, asks, wouldSkip: p.skipUnchanged && d.skip, ...(d.skip ? {} : { why: d.why }) };
    }
    const s = await wakeState(a, m);
    const idleObjectives = await idleObjectivesOf(m, p);
    const d = s && !idleObjectives.length ? cadenceSkipDecision(runs, s.fingerprint, undefined, undefined, readyPart(s.parts)) : { skip: false as const };
    // a Publisher's no-model pre-check verdict (its own campaign's posts only) and its wake brief, read-only (no run).
    const pub = gateKindOf(p) === "publisher";
    const gate = pub && o.wakeGate ? await o.wakeGate(a, m, p, runs, { readOnly: true }).catch(() => undefined) : undefined; // a look moves no post
    const brief = pub && o.roleBrief ? await o.roleBrief(m, p).catch(() => undefined) : undefined;
    return {
      ...base,
      fingerprint: s?.fingerprint,
      parts: s && wakeParts(s.parts),
      readyIds: s?.readyIds ?? [],
      wouldSkip: p.skipUnchanged && d.skip,
      ...(d.skip ? {} : { why: idleObjectives.length ? idleWhy(idleObjectives) : wokeBecause(runs, s && wakeParts(s.parts), s?.fingerprint, { readyIds: s?.readyIds }) }),
      ...(idleObjectives.length ? { idleObjectives } : {}),
      ...(gate ? { preCheck: { work: gate.work, why: gate.why } } : {}),
      ...(brief ? { brief } : {}),
    };
  }

  /**
   * a real wake of a cadence persona records its fingerprint (refreshed when it ends: its own spine edits are not news).
   * `start` (the stamp when the wake starts) also keeps it as startFingerprint, for the wasted-wake count.
   */
  async function stampWake(runId: string, start = false): Promise<void> {
    const run = store.getRun(runId);
    const a = run && !run.parentRunId && run.kind === "wake" && !run.summary.startsWith(SKIP_PREFIX) ? store.getAssignment(run.assignmentId) : undefined;
    const p = a && store.getPersona(a.personaId);
    const m = a && store.getMilestone(a.milestoneId);
    if (!a || !p || !m || !skipsGeneral(p)) return;
    const s = await wakeState(a, m);
    // a wake that saw its ready rows with a free seat keeps that as its baseline, even if the seat is busy now.
    const parts = s && wakeParts(s.parts);
    if (parts) parts.ready = keepSeatSeen(run?.wakeParts?.ready, parts.ready);
    store.updateRun(runId, { askFingerprint: s?.fingerprint ?? null, wakeParts: parts ?? null, ...(start && s ? { startFingerprint: s.fingerprint } : {}) });
  }

  /**
   * the wake's own Current State commit can reach the checkout after its run-end stamp.
   * Some minutes later, while this run is still the newest fingerprinted wake and nothing has changed since the stamp,
   * pull and re-stamp when the pull moved only the spine text (and data/ files). Anything else that changed (a child, an answer, the
   * prompt) stays news.
   */
  async function restampOwnCommit(runId: string, dir: string): Promise<void> {
    const run = store.getRun(runId);
    const a = run?.askFingerprint ? store.getAssignment(run.assignmentId) : undefined;
    const p = a && store.getPersona(a.personaId);
    const m = a && store.getMilestone(a.milestoneId);
    if (!run || !a || !p || !m || !skipsGeneral(p)) return;
    const newest = store.listRuns({ assignmentId: a.id, limit: 100 }).find((r) => !r.parentRunId && r.kind !== "answer_run" && r.askFingerprint);
    if (newest?.id !== runId) return;
    const before = await wakeState(a, m);
    if (!before || before.fingerprint !== run.askFingerprint) return;
    const pulled = await puller!.pull(dir);
    if (!pulled.ok) return;
    const after = await wakeState(a, m);
    if (!after || after.fingerprint === before.fingerprint) return;
    // the wake's own commit may also carry its data/ files; those are its own writes, not news.
    // so may the roll-up of a lagging parent (its own Current State commit), which clears the rollup part.
    if (wakeFingerprint({ ...before.parts, spines: after.parts.spines, data: after.parts.data, rollup: after.parts.rollup }) !== after.fingerprint) return;
    const parts = wakeParts(after.parts);
    parts.ready = keepSeatSeen(run.wakeParts?.ready, parts.ready);
    store.updateRun(runId, { askFingerprint: after.fingerprint, wakeParts: parts });
  }

  // ---------- run now / wake ----------
  /** busy re-wakes in a row before `runId` (the newest runs of the assignment whose summary starts with BUSY_PREFIX). */
  function busyStreak(assignmentId: string, runId: string): number {
    let n = 0;
    for (const r of store.listRuns({ assignmentId, limit: 20 })) {
      if (r.id === runId || r.parentRunId || r.kind === "answer_run") continue;
      if (!r.summary.startsWith(BUSY_PREFIX)) break;
      n++;
    }
    return n;
  }

  // Run now requests by clientRequestId, so a repeated POST (proxy/browser replay, double submit) gets the first result.
  const runNowRequests = new Map<string, { at: number; done: Promise<Run> }>();
  const RUN_NOW_REQUEST_TTL_MS = 10 * 60_000;

  /**
   * Run now for the HTTP route. Same `clientRequestId` → the same run (`replayed: true`), never a second wake or a 409;
   * replies with the run row once the wake takes longer than `runNowReplyMs`, so a slow first wake never holds the dialog.
   */
  async function runNowRequest(
    id: string,
    opts: { instructions?: string; instructionsBy?: string } = {},
    clientRequestId?: string,
  ): Promise<{ run: Run & { startGuard?: StartGuard["action"] }; replayed: boolean }> {
    const now = Date.now();
    for (const [k, v] of runNowRequests) if (now - v.at > RUN_NOW_REQUEST_TTL_MS) runNowRequests.delete(k);
    const key = clientRequestId ? `${id}\u0000${clientRequestId}` : undefined;
    const seen = key ? runNowRequests.get(key) : undefined;
    if (seen) {
      const run = await seen.done;
      return { run: store.getRun(run.id) ?? run, replayed: true };
    }
    let created: Run | undefined;
    const full = runNow(id, { ...opts, onRun: (r) => (created = r) });
    const done = full.catch((e) => {
      // A repeat before the row existed replays the same error; after it, the run row (which records the failure).
      if (created) return store.getRun(created.id) ?? created;
      throw e;
    });
    if (key) runNowRequests.set(key, { at: now, done });
    done.catch(() => key && runNowRequests.delete(key));
    const replyMs = o.runNowReplyMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<undefined>((res) => {
      timer = setTimeout(() => res(undefined), replyMs);
      timer.unref?.();
    });
    try {
      const run = await Promise.race([full, slow]);
      if (run) return { run, replayed: false };
      if (created) return { run: store.getRun(created.id) ?? created, replayed: false };
      return { run: await full, replayed: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * the one start guard. Every starter (Run now, Stall watch, answer and new-ask wakes, approvals, Team desk, the
   * social writer, cadence and timed wakes) goes through runNow, and runNow starts no wake while the assignment's wake runs.
   * A starter with a note queues it into the running wake's thread (steer, else auto) and gets that run back with
   * `startGuard: "queued"`; without a note (or when the queue fails) it gets 409 already_running. Either way the running run
   * records it (`startGuards`), so Activity shows who met it and what happened.
   */
  async function startGuard(live: Run, p: Persona, opts: { instructions?: string; instructionsBy?: string }): Promise<Run & { startGuard: StartGuard["action"] }> {
    const note = opts.instructions?.trim();
    const by = opts.instructionsBy ?? (note ? ownerName() : "Run now");
    const threadId = live.threadId ?? linkFor(live.assignmentId, p.host)?.threadId;
    let action: StartGuard["action"] = "already_running";
    let reason: string | undefined;
    if (note && threadId) {
      try {
        await steerInto(live, threadId, p.host, queuedNoteText(by, note, live.id));
        action = "queued";
      } catch (e) {
        reason = `could not queue the note: ${errorText(e)}`;
      }
    } else if (note) reason = "the running wake has no thread yet";
    const g: StartGuard = { at: iso(), by, action, ...(note ? { note: note.slice(0, 500) } : {}), ...(reason ? { reason } : {}) };
    const cur = store.getRun(live.id) ?? live;
    const run = store.updateRun(live.id, { startGuards: [...(cur.startGuards ?? []), g] }) ?? cur;
    console.log(`start guard ${live.assignmentId}: ${action} (run ${live.id} still running; by ${by}${reason ? `; ${reason}` : ""})`);
    if (action === "queued") return { ...run, startGuard: action };
    throw new CycleError(409, "already_running", `run ${live.id} of this assignment is still running`, { runId: live.id, action, ...(reason ? { reason } : {}) });
  }

  /** where a wake on `host` links its world's own skills: its T3 project's checkout of the milestone repo there. */
  const wakeLink = (m: Milestone, host: Host): WakeLink => ({
    host,
    checkout: () => listProjects(host).then((l) => matchProject(l, m.repo)?.workspaceRoot),
  });

  /**
   * the persona's skill check; a failure ends the run `failed` with the reason (never throws). `link` (the
   * wake itself) links the milestone's world's own skills into the checkout on that host first; without it (Run now, before
   * the host is up) a world skill only has to be one of the world's.
   */
  async function skillGate(p: Persona, runId: string, m: Milestone, link?: Host): Promise<WakeSkills> {
    if (!o.teamSkills || !p.skills.length) return { ok: true, use: {} };
    const r = await o.teamSkills(p, { milestone: m, ...(link ? { link: wakeLink(m, link) } : {}) }).catch((e): WakeSkills => ({ ok: true, use: {}, note: `skill check did not run (${errorText(e)})` }));
    if (!r.ok && store.getRun(runId)?.outcome === "running") store.updateRun(runId, { outcome: "failed", endedAt: iso(), summary: `Wake check failed: ${r.reason}` });
    return r;
  }

  async function runNow(id: string, opts: { instructions?: string; instructionsBy?: string; onRun?: (run: Run) => void } = {}): Promise<Run & { startGuard?: StartGuard["action"] }> {
    const peek = store.getAssignment(id);
    const viaJob = peek ? jobWorldOf(store.getMilestone(peek.milestoneId)) : undefined;
    if (!viaJob) t3(); // a job world's wake makes no T3 call; the kill switch still holds
    else if (!o.enabled) throw new CycleError(409, "cycle_disabled", "the console cycle is off (CONSOLE_CYCLE_ENABLED is not true)");
    const { a, m, p } = ctx(id);
    const host = p.host;
    refuseHeld(m); // before any run row, credit or T3 call
    if (m.settledAt) throw new CycleError(409, "settled", "the milestone is settled; unsettle it in Settings to wake its personas");
    const def = deferredWake(id); // a deferred wake stands for this one: try it now, never a second row
    if (def) {
      opts.onRun?.(def);
      return retryDeferred(def);
    }
    const live = liveWake(id);
    if (live) return startGuard(live, p, opts); // never a second wake while one runs
    const held = o.creditGate?.(a, m); // out of credits (gate on): a held run, no T3 call
    if (held) {
      opts.onRun?.(held);
      return held;
    }
    const link = linkFor(id, host);
    const run = store.createRun({
      assignmentId: id,
      outcome: "running",
      summary: "Run now: waiting for the persona to wake",
      threadId: link?.threadId ?? null,
      seat: link?.seat ?? null,
      instructions: opts.instructions?.trim() || null,
      instructionsBy: opts.instructionsBy ?? null,
    });
    setLink(id, { pendingRunId: run.id });
    opts.onRun?.(run);
    if (viaJob) return startJob(a, m, p, run, viaJob); // the world's own job server, never a shared host
    // a declared skill missing from the library or the host fails here, before any host start or T3 call.
    const skills = await skillGate(p, run.id, m);
    if (!skills.ok) {
      clearLinkField(id, "pending_run_id");
      throw new CycleError(409, "skill_check", skills.reason, { runId: run.id });
    }
    starting.add(run.id); // never an orphan while its start is in flight
    try {
      await ensureHost(host); // the worker server: coding start + health; throws vps3_unavailable, never falls back to the main server
      // a fresh-thread persona skips its home thread and scheduled task: the wake claims this run and launches a new thread.
      if (p.freshThreadEachWake) {
        const out = await wake(id);
        if (out.run?.outcome === "failed") throw new CycleError(502, "t3_error", out.run.summary, { runId: run.id });
        return store.getRun(run.id)!;
      }
      // no T3 scheduled task on any host: the stub goes to the home thread, or the first wake launches it.
      await sendWake(id, run.id);
    } catch (e) {
      console.error(`run now ${id}: ${errorText(e)}`);
      // load-cap / no seat: the wake waits (deferred, retried with backoff), not a failed run
      if (isDeferrable(e) && store.getRun(run.id)?.outcome === "running") return defer(run.id, e.message, host);
      // one failed send (fetch failed, a T3 error) is not yet a failed wake: retry it once after ~5 min.
      const retryMs = o.sendRetryMs ?? 5 * 60_000;
      if (retryMs > 0 && !p.freshThreadEachWake && !isThreadBusy(e) && retryableSend(e) && store.getRun(run.id)?.outcome === "running") {
        const at = new Date(Date.now() + retryMs).toISOString();
        const refused = isCredentialRefusal(errorText(e)) ? ` · ALERT: T3 on ${host} refused the console's MCP token (expired or revoked): ${ROTATE_HINT}` : "";
        if (refused) console.error(`[ALERT] run now ${id}: T3 on ${host} refused the console's MCP token; ${ROTATE_HINT}`);
        store.updateRun(run.id, { summary: `${SEND_RETRY_PREFIX} (${sendFailureText(e, link?.threadId, host)}); retrying once at ${at}${refused}` });
        const t = setTimeout(() => void retrySend(id, run.id), retryMs);
        t.unref();
        timers.push(t);
        return store.getRun(run.id)!;
      }
      clearLinkField(id, "pending_run_id");
      // the thread stayed busy (compacting) through the send retries: re-wake soon instead of failing the run.
      if (isThreadBusy(e) && store.getRun(run.id)?.outcome === "running") {
        const cap = o.busyRewakeCap ?? 3;
        if (busyStreak(id, run.id) < cap) {
          const at = new Date(Date.now() + (o.busyRewakeMs ?? 5 * 60_000)).toISOString();
          return store.updateRun(run.id, { outcome: "idle", endedAt: iso(), retryAt: at, summary: `${BUSY_PREFIX} (${busyKind(e)}${e instanceof T3BusyError && e.state ? `; T3 thread state: ${e.state}` : ""}), re-wake at ${at}` })!;
        }
        store.updateRun(run.id, {
          outcome: "failed",
          endedAt: iso(),
          summary: `Run now failed: thread still ${busyKind(e)} after ${cap} re-wakes: ${sendFailureText(e, link?.threadId, host)}`,
        });
        throw new CycleError(502, "t3_error", sendFailureText(e, link?.threadId, host), { runId: run.id });
      }
      const why = sendFailureText(e, link?.threadId, host);
      if (store.getRun(run.id)?.outcome === "running") store.updateRun(run.id, { outcome: "failed", endedAt: iso(), summary: `Run now failed: ${why}` });
      if (e instanceof CycleError) throw e;
      throw new CycleError(502, "t3_error", why, { runId: run.id });
    } finally {
      starting.delete(run.id);
    }
    return store.getRun(run.id)!;
  }

  /**
   * the wake of a world whose wakes run on its own job servers. The job route takes (or makes) a job
   * server of the world, hands it the world's helper login sealed over ssh stdin, signed links to its folder and a per-job
   * token for the agent gateway; the job's agent claims this run through the gateway (/wake) and reports on it there.
   * When the job ends with the run still open, the run fails with the job's reason (never left running).
   */
  function startJob(a: Assignment, m: Milestone, p: Persona, run: Run, world: string): Run {
    const route = jobRoute!;
    const stub = hooks.worldPrompt(
      wakeStub(route.base, a.id, { note: run.instructions ?? undefined, noteBy: run.instructionsBy ?? undefined, clientRequestId: run.id }),
      { tenant: world, personaId: p.id, consoleUrl: route.base },
    );
    store.updateRun(run.id, { summary: `Run now: handed to a job server of ${world} (waiting for the persona to wake)` });
    track(
      route
        .start({ runId: run.id, world, assignmentId: a.id, personaId: p.id, model: p.model, stub })
        .catch((e): JobEnd => ({ ok: false, result: "failed", detail: errorText(e) }))
        .then((end) => {
          if (getLink(a.id)?.pendingRunId === run.id) clearLinkField(a.id, "pending_run_id");
          const cur = store.getRun(run.id);
          if (cur?.outcome !== "running") return;
          const why = end.ok ? "the job ended without the persona's report" : `job server ${end.result}${end.detail ? `: ${end.detail}` : ""}`;
          store.updateRun(run.id, { outcome: "failed", endedAt: iso(), summary: `${cur.summary} · ${why}${end.server ? ` (${end.server})` : ""}`.slice(0, 2000) });
        }),
    );
    return store.getRun(run.id)!;
  }

  /**
   * before a wake, fast-forward the persona's checkout on its host and fingerprint its tool code (preWake.ts).
   * Recorded on the run (`preWake`); never throws. Undefined when there is no hostGit or no T3 project for the repo yet.
   */
  async function preWake(m: Milestone, host: Host, runId: string): Promise<PreWake | undefined> {
    if (!o.hostGit) return undefined;
    const dir = await listProjects(host)
      .then((l) => matchProject(l, m.repo)?.workspaceRoot)
      .catch(() => undefined);
    if (!dir) return undefined; // not registered yet: the launch below clones/registers it at the current origin
    const pw = await prepareCheckout(o.hostGit, host, dir);
    store.updateRun(runId, { preWake: preWakeLine(host, pw) });
    if ("error" in pw) {
      console.warn(`pre-wake ${m.repo} on ${host}: ${pw.error}`);
      return undefined;
    }
    if (!pw.pull.ok) console.warn(`pre-wake pull ${dir} on ${host} failed (left as is, nothing reset): ${pw.pull.reason}`);
    if (host === mainHost() && pw.from !== pw.to) o.onRepoPulled?.(dir);
    return pw;
  }

  async function fingerprintOf(host: Host, dir: string, runId: string): Promise<string | undefined> {
    const pw = await prepareCheckout(o.hostGit!, host, dir);
    store.updateRun(runId, { preWake: preWakeLine(host, pw) });
    return "error" in pw ? undefined : pw.toolFp;
  }

  /**
   * Deliver a wake for `runId`: a send into the home thread, else a new home thread. The checkout is pulled
   * first; when its tool code differs from what the home thread's session started with, the wake goes to a fresh home
   * thread (stdio MCP servers start once per session). The run's note travels in the message itself.
   */
  async function sendWake(id: string, runId: string, opts: { fresh?: string } = {}): Promise<void> {
    starting.add(runId); // a send or launch in flight is never an orphan
    try {
      await sendWakeNow(id, runId, opts);
    } finally {
      starting.delete(runId);
    }
  }
  async function sendWakeNow(id: string, runId: string, opts: { fresh?: string }): Promise<void> {
    const { m, p } = ctx(id);
    refuseHeld(m); // backstop: retries and deferred wakes reach here without runNow
    const host = p.host;
    const link = linkFor(id, host);
    const client = clientFor(host);
    const pw = await preWake(m, host, runId);
    // `fresh` (the reason) forces a new home thread, e.g. after the provider could not start a turn on the old one.
    // so does a home seat that is limited or logged out (the old thread is left as is; no seat with headroom
    // throws a retryable no_seat from pickSeat below, so the wake is deferred, never failed).
    const blocked = link?.threadId ? seatBlocked(link.seat) : undefined;
    const stale = link?.threadId
      ? opts.fresh ?? (blocked ? `home seat ${blocked}` : undefined) ?? (pw ? staleSessionReason(link.toolFp, pw.toolFp) : undefined)
      : undefined;
    const run = store.getRun(runId);
    if (stale) {
      const was = run?.preWake ?? "pre-wake";
      const line = was.includes(`fresh session: ${stale}`) ? was : `${was} · fresh session: ${stale}`; // a deferred retry: once
      store.updateRun(runId, { preWake: line });
      console.log(`wake ${id}: ${line} (old thread ${link!.threadId} left as is)`);
    }
    // a persona of another world calls with its world's token (the home world: unchanged).
    const stubFor = (h: Host) =>
      hooks.worldPrompt(
        wakeStub(baseFor(h), id, { note: run?.instructions, noteBy: run?.instructionsBy, preWake: store.getRun(runId)?.preWake, clientRequestId: runId }),
        { tenant: milestoneWorld(db, m.id), personaId: p.id, consoleUrl: baseFor(h) },
      );
    if (link?.threadId && !stale) {
      await sessionGate(host); // no pick on this path, so the S9 cap is checked here
      const slot = host === mainHost() ? takeStart(`wake ${id}`) : 0; // and the start gap
      await client.sendToThread(link.threadId, stubFor(host)).catch((e) => {
        gate.cancel(slot);
        throw e;
      });
      stampFromThread(db, runId, link.threadId);
      stampHost(db, runId, host);
      if (pw && link.toolFp === undefined) setLink(id, { toolFp: pw.toolFp }); // a thread from before with no tools: adopt
    } else {
      // pick first: the worker server at its load/memory cap → the new home thread launches on the main server when the main server has room
      const { seat, modelSelection, stamp, host: at = host, fellBack } = await pickSeat(p.model, false, p.id, host, { fallback: true, ownerFallback: ownersNote(run?.instructionsBy) });
      const { project, chain } = await resolveProjectEx(m.repo, at);
      const apw = at === host ? pw : await preWake(m, at, runId); // the main server's own checkout, fetched current
      // just registered / cloned: fingerprint what this new session starts with
      const fp = apw?.toolFp ?? (o.hostGit && project.workspaceRoot ? await fingerprintOf(at, project.workspaceRoot, runId) : undefined);
      const { threadId } = await clientFor(at).launchThread({
        projectId: project.id,
        title: `${p.name} → ${m.title}`,
        message: stubFor(at),
        modelSelection,
      });
      rememberThread(db, threadId, stamp);
      stampRun(db, runId, stamp);
      stampHost(db, runId, at);
      // the main server fallback thread is linked as the main server's: the next wake on the worker server (linkFor) starts a new home thread there
      setLink(id, { projectId: project.id, threadId, seat, host: at, ...(fp ? { toolFp: fp } : {}) });
      const cur = store.getRun(runId);
      const why = fellBack ? `on ${at} (${fellBack.text})` : undefined;
      const summary = chain || why ? `Run now: waiting for the persona to wake (${[chain, why].filter(Boolean).join("; ")})` : undefined;
      store.updateRun(runId, {
        threadId,
        seat,
        ...(cur?.outcome === "deferred" ? { outcome: "running" as const } : {}),
        ...(summary ? { summary } : {}),
        ...(at !== host ? { launchHost: at } : {}),
      });
    }
  }

  /**
   * the reconciler's one re-send of a wake run still pending for its assignment (no wake claimed it). Not a
   * fresh-thread persona (its wake launches its own thread). `fresh`: the provider could not start the turn: the old
   * seat is reported to the broker (`done --fail --signal`, it then prefers another seat for 10 min) and the wake goes
   * to a new home thread on the seat pickSeat returns. Returns false when the run is not eligible or the send fails.
   */
  async function resendWake(run: Run, why: string, fresh: boolean): Promise<boolean> {
    const a = store.getAssignment(run.assignmentId);
    if (!a || run.parentRunId || run.kind !== "wake") return false;
    const { p, m } = ctx(a.id);
    const link = getLink(a.id);
    if (p.freshThreadEachWake || link?.pendingRunId !== run.id) return false;
    if (jobWorldOf(m)) return false; // a job server's wake is never re-sent to a thread
    if (fresh && run.seat && o.dispatcher) await o.dispatcher.done(run.seat, true, why).catch(() => undefined);
    resentAt.set(run.id, Date.now());
    store.updateRun(run.id, { summary: `${run.summary} (${RESENT}${fresh ? " on a new thread" : ""}: ${why})` });
    const limited = USAGE_LIMIT.test(why); // the seat hit its usage limit, not a start failure
    try {
      await sendWake(a.id, run.id, fresh ? { fresh: limited ? `${run.seat ?? "its seat"} hit its usage limit` : `provider could not start the turn on ${run.seat ?? "its seat"}` } : {});
      console.log(`reconcile: re-sent wake ${run.id} (${a.id}): ${why}`);
      return true;
    } catch (e) {
      resentAt.delete(run.id);
      // no seat with headroom (every seat limited, load or session cap): the wake waits, never a red failure
      if (isDeferrable(e) && store.getRun(run.id)?.outcome === "running") {
        defer(run.id, e.message, p.host);
        console.log(`reconcile: re-send of ${run.id} deferred: ${e.message}`);
        return true;
      }
      const text = errorText(e);
      console.error(`reconcile: re-send of ${run.id} failed: ${text}`);
      store.updateRun(run.id, { summary: `${store.getRun(run.id)!.summary} [re-send failed: ${text.slice(0, 300)}]` });
      return false;
    }
  }

  /** the one retry of a failed wake send; a second failure records the run failed. */
  async function retrySend(id: string, runId: string): Promise<void> {
    const run = store.getRun(runId);
    if (!run || run.outcome !== "running" || !run.summary.startsWith(SEND_RETRY_PREFIX)) return; // claimed or closed meanwhile
    try {
      await sendWake(id, runId);
      if (store.getRun(runId)?.summary.startsWith(SEND_RETRY_PREFIX))
        store.updateRun(runId, { summary: `Run now: waiting for the persona to wake (sent on retry after: ${run.summary.slice(SEND_RETRY_PREFIX.length).trim()})` });
    } catch (e) {
      // no seat with headroom on the retry: the wake waits (deferred), never a red failure
      if (isDeferrable(e) && store.getRun(runId)?.outcome === "running") {
        defer(runId, e.message, ctx(id).p.host);
        return;
      }
      clearLinkField(id, "pending_run_id");
      let why = errorText(e);
      try {
        why = sendFailureText(e, linkFor(id, ctx(id).p.host)?.threadId, ctx(id).p.host);
      } catch {
        /* assignment gone: plain text */
      }
      console.error(`run now ${id} (retry): ${why}`);
      if (store.getRun(runId)?.outcome === "running") store.updateRun(runId, { outcome: "failed", endedAt: iso(), summary: `Run now failed after 1 retry: ${why}` });
    }
  }

  /** Called by the woken agent. Returns the prompt to follow and the run it records into (if any). */
  /** "seat seat1 limited until …" when seats.json says the home thread's seat cannot take work; else undefined. */
  function seatWarning(seat: string): string | undefined {
    if (!o.seatsFile) return undefined;
    try {
      const s = readSeats(o.seatsFile).find((x) => x.id === seat || x.name === seat);
      if (!s || (s.status !== "limited" && s.status !== "logged_out")) return undefined;
      const until = s.resetsAt.limitedUntil ? ` until ${s.resetsAt.limitedUntil}` : "";
      return `seat ${seat} ${s.status === "limited" ? `limited${until}` : "logged out"} (the next wake moves to a new home thread on a seat with headroom)`;
    } catch {
      return undefined;
    }
  }

  // wakes by clientRequestId, so a stub's retried POST /wake (its first one timed out client-side but started the
  // run) gets that wake's prompt again instead of "skipped: previous run still running".
  const wakeRequests = new Map<string, { at: number; done: Promise<{ prompt: string; run?: Run; skipped?: boolean }> }>();

  async function wakeRequest(
    id: string,
    body: { threadId?: string; seat?: string; clientRequestId?: string } = {},
  ): Promise<{ prompt: string; run?: Run; skipped?: boolean; replayed?: boolean }> {
    const now = Date.now();
    for (const [k, v] of wakeRequests) if (now - v.at > RUN_NOW_REQUEST_TTL_MS) wakeRequests.delete(k);
    const key = body.clientRequestId?.trim() ? `${id}\u0000${body.clientRequestId.trim()}` : undefined;
    const seen = key ? wakeRequests.get(key) : undefined;
    if (seen) {
      const out = await seen.done;
      return { ...out, ...(out.run ? { run: store.getRun(out.run.id) ?? out.run } : {}), replayed: true };
    }
    const done = wake(id, body);
    if (key) {
      wakeRequests.set(key, { at: now, done });
      done.catch(() => wakeRequests.delete(key));
    }
    return done;
  }

  async function wake(id: string, body: { threadId?: string; seat?: string } = {}): Promise<{ prompt: string; run?: Run; skipped?: boolean }> {
    if (!o.enabled) return { prompt: inactivePrompt("switched off (console cycle kill switch)") };
    const a = store.getAssignment(id);
    if (!a) return { prompt: inactivePrompt("deleted in the console") };
    const m = store.getMilestone(a.milestoneId)!;
    const p = store.getPersona(a.personaId)!;
    const hold = holdOf(m); // a held world's stub (or a hand call of /wake) gets no prompt to act on
    if (hold) return { prompt: inactivePrompt(hold) };
    const jobBase = jobWorldOf(m) ? jobRoute!.base : undefined; // the job's agent calls back through the gateway
    await pullBeforeWake(m); // the prompt and park gate read what other runs pushed
    const link = getLink(id);
    const threadId = body.threadId ?? link?.threadId ?? null;
    const seat = body.seat ?? link?.seat ?? null;

    let run: Run | undefined;
    const pending = link?.pendingRunId ? store.getRun(link.pendingRunId) : undefined;
    if (link?.pendingRunId) clearLinkField(id, "pending_run_id");
    const claimFrom = pending ? Math.max(Date.parse(pending.startedAt), resentAt.get(pending.id) ?? 0) : 0;
    if (pending && pending.outcome === "running" && Date.now() - claimFrom < claimMs) {
      run = store.updateRun(pending.id, { threadId, seat, summary: pending.summary === CADENCE_PENDING ? wokeLine(pending.wokeBecause) : "Run now: woke" })!;
    } else {
      // a switched-off assignment was woken by a T3 task: reconcile, which pauses or deletes it (root L-10)
      const offWake = (why: string) => {
        track(sync(id));
        return { prompt: inactivePrompt(why) };
      };
      if (!a.enabled) return offWake("disabled in the console");
      if (m.paused) return offWake("on a paused milestone");
      if (m.settledAt) {
        const parked = await parkSettled(a, threadId, seat);
        return { prompt: inactivePrompt(`parked: ${SETTLED_REASON}`), run: parked, skipped: true };
      }
      const notRun = await notRunnable(m); // a wake not started by the console (home-thread / T3 task) on a non-runnable spine
      if (notRun) return { prompt: inactivePrompt(`skipped: ${notRun}`), run: logNotRunnable(a, notRun, threadId, seat), skipped: true };
      const gate = parkDecision(await gateTree(m), await refAnswers(m));
      if (gate.park) {
        const parked = await park(a, gate.reason, threadId, seat);
        return { prompt: inactivePrompt(`parked: ${gate.reason}`), run: parked, skipped: true };
      }
      const prev = runningRun(id);
      if (prev && !isStale(prev)) {
        // same rule as runNow's start guard (a home-thread or T3-task wake while one runs records a skip, never a run)
        const skipped = store.createRun({
          assignmentId: id,
          outcome: "idle",
          endedAt: iso(),
          threadId,
          seat,
          summary: `skipped: previous run ${prev.id} still running`,
        });
        return { prompt: skipPrompt(prev.id), run: skipped, skipped: true };
      }
      if (prev)
        store.updateRun(prev.id, {
          outcome: "failed",
          endedAt: iso(),
          summary: `${prev.summary} (no report within ${Math.round(staleFor(prev) / 60_000)} min; marked failed by console)`.trim(),
        });
      const unchanged = await unchangedSkip(a, m, p, threadId, seat);
      if (unchanged.skipped) return { prompt: nothingNewPrompt(unchanged.skipped.summary), run: unchanged.skipped, skipped: true };
      run = store.createRun({ assignmentId: id, outcome: "running", threadId, seat, summary: wokeLine(unchanged.why) });
      if (unchanged.why) run = store.updateRun(run.id, { wokeBecause: unchanged.why })!;
    }
    stampFromThread(db, run.id, threadId ?? undefined); // the home thread's instance + model (none for pre-S13 threads)
    const seatNote = seat ? seatWarning(seat) : undefined;
    if (seatNote) run = store.updateRun(run.id, { summary: `${run.summary} · ${seatNote}` })!;
    if (skipsGeneral(p)) {
      await stampWake(run.id, true); // what this real wake saw (the baseline the next cadence wake compares with)
      run = store.getRun(run.id)!;
    }
    // the wake check (also for wakes the console did not start: a home-thread or T3-task wake).
    const skills = await skillGate(p, run.id, m, store.getRun(run.id)?.launchHost ?? p.host);
    if (!skills.ok) return { prompt: inactivePrompt(`stopped by the wake check: ${skills.reason}`), run: store.getRun(run.id), skipped: true };
    const todo = o.treeTodo ? await o.treeTodo(m) : undefined;
    const grants = o.grants ? await o.grants(m).catch(() => []) : [];
    // an Unblocker wakes the milestone's switched-on Delivery Manager after answering (root L-10).
    const managerAssignmentId = isUnblocker(p.name)
      ? store.listAssignments({ milestoneId: m.id }).find((x) => x.enabled && x.id !== a.id && isDeliveryManager(store.getPersona(x.personaId)?.name))?.id
      : undefined;
    // the asks this Unblocker wake must report on (its finishing PATCH carries one `checks` entry per code).
    if (isUnblocker(p.name) && o.openAsks) {
      const openAsks = await o.openAsks(m).catch(() => undefined);
      // each ask carries its fingerprint; unchanged ones are carried (`carriedFrom`), only new/changed ones are assessed.
      const marked = openAsks && markCarried(withPrints(openAsks, grants), classifyAsks(openAsks, grants, readAskMemory(db, m.id)));
      if (openAsks) run = store.updateRun(run.id, { openAsks: marked, askFingerprint: askFingerprint(openAsks, grants) })!;
    }
    // the rubric settings this Unblocker wake shows (its finishing PATCH is judged by the same numbers).
    const rubric = isUnblocker(p.name) ? snapshotRubric(db, run.id, m.id) : undefined;
    const effort = effortOf(m);
    // the flat ceiling, raised while seats and memory have room; a tier at the flat ceiling (Top) gets the room too.
    const flat = o.maxWorkersPerMilestone ?? DEFAULT_MAX_WORKERS;
    const room = o.workerRoom && !(effort && effort.maxWorkers < flat) ? await o.workerRoom().catch(() => undefined) : undefined;
    const ceiling = room?.max ?? flat;
    const maxWorkers = effort ? (effort.maxWorkers >= flat ? ceiling : Math.min(effort.maxWorkers, ceiling)) : ceiling;
    const priority = o.priorityFor ? (() => { try { return o.priorityFor!(m); } catch { return ""; } })() : "";
    const runningWorkers = store.listRuns({ milestoneId: m.id, limit: 1000 }).filter((r) => r.parentRunId && r.outcome === "running").length;
    const children = o.children ? await o.children(m).catch(() => undefined) : undefined;
    // the persona's pack role and what it may write; a Delivery Manager also gets the runs flagged rule broken since its last wake.
    const lastWake = store.listRuns({ assignmentId: a.id, limit: 5 }).find((r) => r.id !== run!.id && !r.parentRunId)?.startedAt;
    const pack = o.packSection ? await o.packSection(m, p, lastWake).catch(() => undefined) : undefined;
    const brief = o.roleBrief ? await o.roleBrief(m, p, lastWake).catch(() => undefined) : undefined;
    const broken = isDeliveryManager(p.name) ? ruleBrokenFor(m, a, run.id) : undefined;
    const rollup = isDeliveryManager(p.name) ? await rollupFor(m).catch(() => undefined) : undefined;
    const asked = isDeliveryManager(p.name) && o.askedNoRow ? await o.askedNoRow(m).catch(() => undefined) : undefined;
    const held = isDeliveryManager(p.name) && o.heldAsks ? await o.heldAsks(m).catch(() => undefined) : undefined;
    const alerts = isDeliveryManager(p.name) && o.monitorAlerts ? await o.monitorAlerts(m).catch(() => undefined) : undefined;
    const orphans = isDeliveryManager(p.name) && o.orphanCommits ? await o.orphanCommits(m).catch(() => undefined) : undefined;
    const inbox = isDeliveryManager(p.name) && o.deskInbox ? await o.deskInbox(m).catch(() => undefined) : undefined;
    const questions = isDeliveryManager(p.name) && o.deskQuestions ? await o.deskQuestions(m, jobBase ?? baseFor(p.host)).catch(() => undefined) : undefined;
    const launch = isDeliveryManager(p.name) && o.launchDrafts ? await o.launchDrafts(m).catch(() => undefined) : undefined;
    const objectives = isDeliveryManager(p.name) && o.objectives ? (await o.objectives(m).catch(() => undefined))?.section : undefined;
    const services = o.teamServices ? await o.teamServices(p, run.id).catch(() => undefined) : undefined;
    const owned = o.ownerObjectives ? await o.ownerObjectives(m).catch(() => undefined) : undefined;
    const deckUrl = deckUrlOf(m);
    let prompt =
      buildWakePrompt(p, m, a, run.instructions, run.instructionsBy, maxWorkers, children, skills.use, brief, deckUrl) +
      (owned?.block ? "\n\n" + owned.block : "") +
      (priority ? "\n\n" + priority : "") +
      (objectives ? "\n\n" + objectives : "") +
      (rollup ? "\n\n" + rollup : "") +
      (todo ? "\n" + todo : "") +
      (pack ? "\n\n" + pack : "") +
      (broken ? "\n\n" + broken : "") +
      (asked ? "\n\n" + asked : "") +
      (held ? "\n\n" + held : "") +
      (alerts ? "\n\n" + alerts : "") +
      (orphans ? "\n\n" + orphans : "") +
      (questions ? "\n\n" + questions : "") +
      (inbox ? "\n\n" + inbox : "") +
      (launch ? "\n\n" + launch : "") +
      (services ? "\n\n" + services : "") +
      "\n" +
      wakeProtocol({ base: jobBase ?? baseFor(p.host), run, assignment: a, milestone: m, persona: p, grants, managerAssignmentId, maxWorkers, runningWorkers, roomLine: room ? roomLine(room) : undefined, rubric, deckUrl, objectivesLine: owned?.line || undefined });
    if (skills.note) prompt += `\nNote: ${skills.note}.\n`;
    // the world's own skills are project skills of this checkout, not of the seat
    if (skills.world?.length)
      prompt += `\nNote: ${skills.world.map((s) => `\`${s}\``).join(", ")} ${skills.world.length > 1 ? "are" : "is"} this world's own skill${skills.world.length > 1 ? "s" : ""}, linked in this checkout's .claude/skills (open .claude/skills/<name>/SKILL.md).\n`;
    if (seatNote) prompt += `\nNote: ${seatNote}. Keep this run short; if a turn fails on usage limits, PATCH the run failed and say so.\n`;
    // a fresh-thread persona's new session needs its checkout current too (the home-thread path pulled in sendWake).
    if (p.freshThreadEachWake && !jobBase) await preWake(m, p.host, run.id).catch(() => undefined);
    const pre = store.getRun(run.id)?.preWake;
    if (pre && /pull failed|unreadable/.test(pre))
      prompt += `\nNote: console ${pre}. Your checkout and repo tools may be stale: fix it if it is yours to fix (never reset others' work), else say so in your summary.\n`;
    prompt = hooks.worldPrompt(prompt, { tenant: milestoneWorld(db, m.id), personaId: p.id, consoleUrl: jobBase ?? baseFor(p.host === workerHost() ? workerHost() : mainHost()) }); // the home world unchanged
    if (p.freshThreadEachWake && !jobBase) return launchFresh(a, m, p, run, prompt); // a job is a fresh session already
    return { prompt, run };
  }

  /**
   * a fresh-thread persona's wake runs in a NEW thread whose first message is the full prompt (no memory of earlier
   * wakes, nothing to skim from a saved file). The run points at it; the caller (the stub turn in the home thread,
   * or Run now) gets a hand-off note. Old threads are left as they are.
   */
  async function launchFresh(a: Assignment, m: Milestone, p: Persona, run: Run, prompt: string): Promise<{ prompt: string; run: Run }> {
    const host = p.host;
    refuseHeld(m); // backstop
    try {
      await ensureHost(host);
      // pick first: the worker server at its load/memory cap → the thread launches on the main server when the main server has room
      const { seat, modelSelection, stamp, host: picked = host, fellBack } = await pickSeat(p.model, false, p.id, host, { fallback: true, ownerFallback: ownersNote(run.instructionsBy) });
      const at: Host = picked;
      const client = clientFor(at);
      const { project } = await resolveProjectEx(m.repo, at);
      let message = prompt;
      if (at !== host) {
        // the main server's checkout of the repo, fetched current (the stale-checkout case), and the main server's console URL in the prompt
        const pw = await preWake(m, at, run.id).catch(() => undefined);
        // the world's own skills go into the checkout this fallback launch works in (best effort; checked on the persona's host)
        if (o.teamSkills && p.skills.length) await o.teamSkills(p, { milestone: m, link: wakeLink(m, at) }).catch(() => undefined);
        const from = baseFor(host);
        const to = baseFor(at);
        if (from !== to) message = message.split(from).join(to);
        if (pw === undefined && o.hostGit) console.warn(`fresh wake ${a.id}: no pre-wake on ${at} (no project / git)`);
      }
      const { threadId } = await client.launchThread({
        projectId: project.id,
        title: `${p.name} → ${m.title} · ${run.id}`,
        message,
        modelSelection,
      });
      rememberThread(db, threadId, stamp);
      stampRun(db, run.id, stamp);
      stampHost(db, run.id, at);
      if (at === host) setLink(a.id, { projectId: project.id, host }); // a fallback launch leaves the persona's link on its host
      const cur = store.getRun(run.id) ?? run;
      const where = fellBack ? ` · on ${at} (${fellBack.text})` : "";
      const after = cur.deferred ? ` · after ${cur.deferred.attempts} deferral${cur.deferred.attempts === 1 ? "" : "s"}` : "";
      const launched = store.updateRun(run.id, {
        threadId,
        seat,
        outcome: "running",
        summary: `${cur.summary} · fresh thread${where}${after}`,
        ...(at !== host ? { launchHost: at } : {}),
      })!;
      return {
        prompt: `This wake runs in a fresh thread (${threadId}) the console just launched with the full prompt. Do nothing else: reply \`handed off to ${threadId}\` and end your turn.`,
        run: launched,
      };
    } catch (e) {
      console.error(`fresh wake ${a.id}: ${errorText(e)}`);
      if (isDeferrable(e)) {
        const deferred = defer(run.id, e.message, host);
        if (deferred.outcome === "deferred")
          return { prompt: `The console deferred this wake (${e.message}); it retries by itself. Do nothing else: reply \`deferred\` and end your turn.`, run: deferred };
        return { prompt: `The console could not launch this wake's fresh thread (${deferred.summary}). Reply \`outcome: failed\` and stop.`, run: deferred };
      }
      const failed = store.updateRun(run.id, { outcome: "failed", endedAt: iso(), summary: `Fresh-thread wake failed: ${errorText(e)}` })!;
      return { prompt: `The console could not launch this wake's fresh thread (${errorText(e)}); it marked run ${run.id} failed. Reply \`outcome: failed\` and stop.`, run: failed };
    }
  }

  // ---------- host handover ----------
  const handovers = new Map<string, Promise<Handover>>();
  const handoverOut = (r: Record<string, string>): Handover => ({
    host: r.host as Host,
    threadId: r.thread_id,
    projectId: r.project_id,
    title: r.title,
    url: threadUrl(environments.hostEnvironment(r.host as Host), r.thread_id),
    createdAt: r.created_at,
  });
  /**
   * Launch the handover thread on `target` (never another host: a refusal is the answer, the agent retries or stays).
   * The same clientRequestId answers the first launch (`replayed`), also while it is still in flight.
   */
  async function handover(i: HandoverInput): Promise<{ handover: Handover; replayed: boolean }> {
    const key = i.clientRequestId;
    const prev = key ? getHandover(db, key) : undefined;
    if (prev) return { handover: handoverOut(prev), replayed: true };
    const inflight = key ? handovers.get(key) : undefined;
    if (inflight) return { handover: await inflight, replayed: true };
    const run = async (): Promise<Handover> => {
      const host: Host = i.target;
      await ensureHost(host);
      const { modelSelection, stamp } = await pickSeat(o.handoverModel ?? "opus", false, undefined, host, { startGate: "mark", owner: true }); // his handover may take his seat
      const { project } = await resolveProjectEx(i.repo, host);
      const title = handoverTitle(i.epic);
      let threadId: string;
      try {
        ({ threadId } = await clientFor(host).launchThread({ projectId: project.id, title, message: handoverMessage(i), modelSelection }));
      } catch (e) {
        throw new CycleError(502, "t3_error", `handover launch on ${host} failed: ${errorText(e)}`);
      }
      rememberThread(db, threadId, stamp);
      const h = { host, threadId, projectId: project.id, title, createdAt: iso() };
      if (key) saveHandover(db, key, h, i);
      console.log(`handover ${i.repo} ${i.epic} → ${host} thread ${threadId}${i.fromThread ? ` (from ${i.fromHost ?? "?"} ${i.fromThread})` : ""}`);
      return { ...h, url: threadUrl(environments.hostEnvironment(host), threadId) };
    };
    const p = run();
    if (key) {
      handovers.set(key, p);
      p.catch(() => undefined).finally(() => handovers.delete(key));
    }
    return { handover: await p, replayed: false };
  }

  // ---------- console worker launch on the main server (incident override only since, else refused 409) ----------
  /**
   * One child run of the wake `parentRunId` per clientRequestId (a repeat answers the first, `replayed`), launched on
   * the main server: a local the main server pick (the main server's memory, load and session gates), the milestone repo's the main server project, the brief as
   * the thread's first message. A retryable refusal defers the child run (backoff; tickDeferred retries it); a
   * final one fails it. The seat is held until the run reports a terminal outcome (cycle_seat_hold, as bootstrap).
   */
  async function launchWorker(parentRunId: string, i: WorkerLaunchInput): Promise<{ run: Run; replayed: boolean }> {
    t3();
    const parent = store.getRun(parentRunId);
    if (!parent) throw new CycleError(404, "not_found", `run ${parentRunId} not found`);
    if (parent.parentRunId) throw new CycleError(400, "not_a_wake", `run ${parentRunId} is a child run; launch workers from its wake ${parent.parentRunId}`);
    const a = store.getAssignment(parent.assignmentId);
    if (!a) throw new CycleError(404, "not_found", `assignment ${parent.assignmentId} not found`);
    const prev = store.getRunByClientRequest(a.id, i.clientRequestId);
    if (prev) return { run: prev, replayed: true };
    if (o.capFallback !== true) throw new CycleError(409, "vps1_workers_off", workersOffText());
    const m = store.getMilestone(a.milestoneId)!;
    refuseHeld(m);
    const child = store.createRun({
      assignmentId: a.id,
      parentRunId,
      outcome: "running",
      summary: workerSummary(i.ticket, i.title),
      clientRequestId: i.clientRequestId,
    });
    saveWorkerLaunch(db, child.id, i, iso());
    return { run: await tryWorker(child.id), replayed: false };
  }

  /** One launch attempt of a console worker run (first try or a deferred retry). */
  async function tryWorker(runId: string): Promise<Run> {
    const spec = getWorkerLaunch(db, runId);
    const run = store.getRun(runId)!;
    if (!spec) return run;
    const a = store.getAssignment(run.assignmentId);
    const m = a && store.getMilestone(a.milestoneId);
    const p = a && store.getPersona(a.personaId);
    if (!a || !m || !p) return store.updateRun(runId, { outcome: "failed", endedAt: iso(), summary: `${run.summary} · launch dropped: its assignment is gone` })!;
    // a worker deferred before the switch went off is never launched on the main server later.
    if (o.capFallback !== true) return store.updateRun(runId, { outcome: "failed", endedAt: iso(), summary: `${spec.ticket} worker not launched: ${workersOffText()}` })!;
    let seat: string | undefined;
    try {
      const picked = await pickSeat(spec.model || p.model, true, p.id, mainHost());
      seat = picked.seat;
      db.prepare("INSERT OR REPLACE INTO cycle_seat_hold (run_id, seat) VALUES (?, ?)").run(runId, seat);
      const project = await resolveProject(m.repo, mainHost());
      const message = workerMessage({ base: baseFor(mainHost()), runId, parentRunId: run.parentRunId!, ticket: spec.ticket!, brief: spec.brief!, deckUrl: deckUrlOf(m) });
      const { threadId } = await clientFor(mainHost()).launchThread({ projectId: project.id, title: workerThreadTitle(spec.ticket!, spec.title), message, modelSelection: picked.modelSelection });
      rememberThread(db, threadId, picked.stamp);
      stampRun(db, runId, picked.stamp);
      stampHost(db, runId, mainHost());
      const after = run.deferred ? ` · after ${run.deferred.attempts} deferral${run.deferred.attempts === 1 ? "" : "s"}` : "";
      console.log(`worker ${runId} (${spec.ticket}, wake ${run.parentRunId}) launched on ${mainHost()} thread ${threadId}${after}`);
      return store.updateRun(runId, { outcome: "running", threadId, seat, launchHost: mainHost(), summary: `${workerSummary(spec.ticket!, spec.title)}${after}` })!;
    } catch (e) {
      if (seat) await releaseSeatHoldNow(runId);
      if (isDeferrable(e)) {
        const d = nextDeferral(run.deferred, e.message, mainHost(), Date.now(), gapRetryMs(e.message));
        if (Date.now() - Date.parse(d.firstAt) < (o.deferMaxMs ?? DEFER_MAX_MS)) {
          console.log(`worker ${runId}: deferred: ${e.message} (attempt ${d.attempts}, next ${d.nextAt})`);
          return store.updateRun(runId, { outcome: "deferred", deferred: d, summary: `${spec.ticket} ${deferredSummary(d)}` })!;
        }
        const mins = Math.round((Date.now() - Date.parse(d.firstAt)) / 60_000);
        return store.updateRun(runId, { outcome: "failed", endedAt: iso(), deferred: d, summary: `${spec.ticket} worker launch on ${mainHost()} failed: ${e.message.replace(/, will retry$/, "")} for ${mins} min (${d.attempts} attempts); gave up` })!;
      }
      return store.updateRun(runId, { outcome: "failed", endedAt: iso(), summary: `${spec.ticket} worker launch on ${mainHost()} failed: ${errorText(e)}` })!;
    }
  }

  /** Release a held seat whatever the run's outcome (a launch that failed after its pick). */
  async function releaseSeatHoldNow(runId: string) {
    const r = db.prepare("SELECT seat FROM cycle_seat_hold WHERE run_id = ?").get(runId) as Row | undefined;
    if (!r) return;
    db.prepare("DELETE FROM cycle_seat_hold WHERE run_id = ?").run(runId);
    await o.dispatcher?.done(r.seat, true).catch(() => undefined);
  }

  // ---------- deferred wakes (load-cap / no seat, will retry) ----------
  /**
   * Defer a wake the dispatcher refused for now: one run row, outcome `deferred`, retried with backoff (1, 2, 4, 8, then
   * every 10 min) by tickDeferred; past deferMaxMs since the first refusal it fails with the reason. Returns the run.
   */
  function defer(runId: string, reason: string, host: Host): Run {
    const cur = store.getRun(runId)!;
    const d = nextDeferral(cur.deferred, reason, host, Date.now(), gapRetryMs(reason));
    const a = store.getAssignment(cur.assignmentId);
    if (a && getLink(a.id)?.pendingRunId === runId) clearLinkField(a.id, "pending_run_id");
    if (Date.now() - Date.parse(d.firstAt) >= (o.deferMaxMs ?? DEFER_MAX_MS)) {
      const mins = Math.round((Date.now() - Date.parse(d.firstAt)) / 60_000);
      const why = reason.replace(/, will retry$/, "");
      // no seat with headroom (every seat limited or busy) is never red: the wake is skipped, the next cadence
      // wake (or Run now) tries again; a host cap still gives up as failed
      if (/^(all seats busy|no seat)|maxed/i.test(reason))
        return store.updateRun(runId, { outcome: "idle", endedAt: iso(), deferred: d, summary: `Wake skipped: ${why} for ${mins} min (${d.attempts} attempts); the next wake tries again` })!;
      return store.updateRun(runId, { outcome: "failed", endedAt: iso(), deferred: d, summary: `Wake failed: ${why} for ${mins} min (${d.attempts} attempts); gave up` })!;
    }
    console.log(`wake ${cur.assignmentId}: deferred ${runId}: ${reason} (attempt ${d.attempts}, next ${d.nextAt})`);
    return store.updateRun(runId, { outcome: "deferred", deferred: d, summary: deferredSummary(d) })!;
  }

  /** The assignment's deferred wake (top-level), if any: it stands for the wake until it launches or gives up. */
  const deferredWake = (assignmentId: string): Run | undefined =>
    store.listRuns({ assignmentId, limit: 50 }).find((r) => r.outcome === "deferred" && !r.parentRunId && r.kind === "wake");

  const retrying = new Set<string>();
  /**
   * One more attempt at a deferred wake: the run goes back to running and is handed to the same start path (a
   * fresh-thread persona's wake claims it; others get the stub sent / a home thread launched). A refusal defers it
   * again (same row, attempts + 1); anything else fails it with the error.
   */
  async function retryDeferred(run: Run): Promise<Run> {
    if (retrying.has(run.id)) return store.getRun(run.id)!;
    retrying.add(run.id);
    try {
      const a = store.getAssignment(run.assignmentId);
      const m = a && store.getMilestone(a.milestoneId);
      if (!a || !m || !a.enabled || m.paused || m.settledAt)
        return store.updateRun(run.id, { outcome: "idle", endedAt: iso(), summary: `${run.summary} · dropped: the assignment is off or its milestone paused/settled` })!;
      const p = store.getPersona(a.personaId)!;
      const n = (run.deferred?.attempts ?? 0) + 1;
      store.updateRun(run.id, { outcome: "running", summary: `Retrying deferred wake (attempt ${n}): ${run.deferred?.reason ?? "will retry"}` });
      setLink(a.id, { pendingRunId: run.id });
      resentAt.set(run.id, Date.now()); // the claim window restarts now
      try {
        await ensureHost(p.host);
        if (p.freshThreadEachWake) {
          await wake(a.id); // claims the run; launchFresh launches, defers again or fails it
          const after = store.getRun(run.id)!;
          if (after.outcome === "running" && !after.threadId) // the wake ended before it claimed the run (switched off, parked)
            store.updateRun(run.id, { outcome: "idle", endedAt: iso(), summary: `${after.summary} · dropped: the wake did not start` });
        } else await sendWake(a.id, run.id);
      } catch (e) {
        const now = store.getRun(run.id)!;
        if (now.outcome === "running") {
          if (isDeferrable(e)) defer(run.id, e.message, p.host);
          else store.updateRun(run.id, { outcome: "failed", endedAt: iso(), summary: `Deferred wake failed: ${errorText(e)}` });
        }
        clearLinkField(a.id, "pending_run_id");
      }
      return store.getRun(run.id)!;
    } finally {
      retrying.delete(run.id);
    }
  }

  /** Retry every deferred wake whose next try is due. Returns the run ids attempted. */
  async function tickDeferred(now: Date = new Date()): Promise<string[]> {
    if (!o.enabled || !o.t3) return [];
    const due = (db.prepare("SELECT id FROM runs WHERE outcome = 'deferred' AND parent_run_id IS NULL").all() as { id: string }[])
      .map((r) => store.getRun(r.id)!)
      .filter((r) => r && Date.parse(r.deferred?.nextAt ?? r.startedAt) <= now.getTime());
    for (const r of due) await retryDeferred(r).catch((e) => console.error(`deferred wake ${r.id}:`, errorText(e)));
    // deferred console worker launches (child runs with a launch spec) retry the same way
    const workers = (db.prepare("SELECT r.id FROM runs r JOIN cycle_worker_launch w ON w.run_id = r.id WHERE r.outcome = 'deferred'").all() as { id: string }[])
      .map((r) => store.getRun(r.id)!)
      .filter((r) => r && Date.parse(r.deferred?.nextAt ?? r.startedAt) <= now.getTime());
    for (const r of workers) await tryWorker(r.id).catch((e) => console.error(`deferred worker ${r.id}:`, errorText(e)));
    return [...due, ...workers].map((r) => r.id);
  }

  // ---------- steer a running persona ----------
  /**
   * Post the owner's message into the thread of the assignment's running run as a steer (in-flight update). If T3 will not
   * steer the turn (not steerable yet), retry as auto, which queues it. Each steer is kept in its own
   * table (cycle_run_steer), never in the run summary, so a later persona PATCH of the summary cannot erase it.
   */
  async function steer(id: string, message: string, clientRequestId?: string): Promise<{ run: Run & { steers?: RunSteer[] }; threadId: string; mode: "steer" | "auto" }> {
    t3();
    const text = message.trim();
    if (!text) throw new CycleError(400, "empty_message", "message is required");
    const { p } = ctx(id);
    const run = runningRun(id);
    const threadId = run ? (run.threadId ?? linkFor(id, p.host)?.threadId) : undefined;
    if (!run || !threadId) throw new CycleError(409, "not_running", "this assignment has no running run with a thread to steer");
    return steerInto(run, threadId, p.host, text, clientRequestId);
  }

  /** The host a run's thread lives on: its assignment's persona host (the main server when the assignment is gone). */
  const hostOfRun = (run: Run): Host => {
    if (run.launchHost) return run.launchHost; // launched on the main server while the worker server was at its cap
    const a = store.getAssignment(run.assignmentId);
    return (a && store.getPersona(a.personaId)?.host) || mainHost();
  };

  /**
   * steer by run id, any running run: a persona wake or a child worker (runs.parent_run_id). Same delivery as
   * `steer` (steer, falling back to auto); the thread is the run's own, so a child is reached without its parent.
   */
  async function steerRun(runId: string, message: string, clientRequestId?: string): Promise<{ run: Run & { steers?: RunSteer[] }; threadId: string; mode: "steer" | "auto" }> {
    t3();
    const text = message.trim();
    if (!text) throw new CycleError(400, "empty_message", "message is required");
    const run = store.getRun(runId);
    if (!run) throw new CycleError(404, "not_found", `run ${runId} not found`);
    if (run.outcome !== "running") throw new CycleError(409, "not_running", `run ${runId} is not running (${run.outcome})`);
    if (!run.threadId) throw new CycleError(409, "no_thread", `run ${runId} has no thread yet: try again in a moment`);
    return steerInto(run, run.threadId, hostOfRun(run), text, clientRequestId);
  }

  /** send text into any run's own thread (running or parked), steer falling back to a new turn. */
  async function sendToRun(run: Run, text: string) {
    t3();
    if (!run.threadId) throw new CycleError(409, "no_thread", `run ${run.id} has no thread`);
    return steerInto(run, run.threadId, hostOfRun(run), text, `console-priority-${run.id}-${randomUUID().slice(0, 8)}`);
  }

  async function steerInto(run: Run, threadId: string, host: Host, text: string, clientRequestId?: string) {
    const foreign = threadRefusal(db, worldOfRun(db, run.id), threadId); // (audit N3)
    if (foreign) throw new CycleError(403, "foreign_thread", foreign);
    const crid = clientRequestId || `console-steer-${randomUUID()}`;
    let mode: "steer" | "auto" = "steer";
    try {
      const c = clientFor(host);
      if (host === workerHost()) o.worker?.touchTunnel();
      try {
        await c.sendToThread(threadId, text, crid, "steer");
      } catch {
        mode = "auto";
        await c.sendToThread(threadId, text, crid, "auto");
      }
    } catch (e) {
      if (e instanceof CycleError) throw e;
      throw new CycleError(502, "t3_error", errorText(e));
    }
    db.prepare("INSERT INTO cycle_run_steer (run_id, at, mode, message) VALUES (?, ?, ?, ?)").run(run.id, iso(), mode, text);
    const cur = store.getRun(run.id) ?? run;
    return { run: { ...cur, steers: steersOf(run.id) }, threadId, mode };
  }

  // ---------- stop a running run ----------
  /**
   * Interrupt the run's T3 turn, then close it `stopped` with the reason. Nothing resumes on its own (L-10): the
   * assignment's timed wake booked by this run is cleared, and no wake follows. A T3 refusal fails the stop and leaves the
   * run running. `withWorkers` also stops the run's running child runs (a persona wake's workers); without it they run on
   * and are counted in `workersRunning`.
   */
  async function stopRun(runId: string, opts: { reason: string; withWorkers?: boolean }): Promise<{ run: Run; workers: Run[]; workersRunning: number; workerErrors: { runId: string; error: string }[] }> {
    const reason = opts.reason.trim();
    if (!reason) throw new CycleError(400, "empty_reason", "a reason is required");
    const run = store.getRun(runId);
    if (!run) throw new CycleError(404, "not_found", `run ${runId} not found`);
    if (run.outcome !== "running") throw new CycleError(409, "not_running", `run ${runId} is not running (${run.outcome})`);
    // a run with no thread past its start window (or whose send failed and waits on its retry) has nothing to
    // interrupt: Stop closes it. Inside the window, with its start in flight, it still answers no_thread (a launch may land).
    if (!run.threadId && !threadlessStoppable(run)) throw new CycleError(409, "no_thread", `run ${runId} has no thread yet to interrupt: try again in a moment`);
    const stopOne = async (r: Run): Promise<Run> => {
      if (!r.threadId) return stopThreadless(r, reason);
      const world = worldOfRun(db, r.id);
      const foreign = threadRefusal(db, world, r.threadId); // never interrupt another world's thread
      if (foreign) throw new CycleError(403, "foreign_thread", foreign);
      const host = hostOfRun(r);
      const c = clientFor(host);
      if (!c.interruptThread) throw new CycleError(503, "not_supported", "this T3 client cannot interrupt a thread");
      if (host === workerHost()) o.worker?.touchTunnel();
      try {
        await c.interruptThread(r.threadId!, `Stopped from the console: ${reason}`, `console-stop-${r.id}`);
      } catch (e) {
        throw new CycleError(502, "t3_error", errorText(e));
      }
      const prev = r.summary.trim();
      const done = store.updateRun(r.id, {
        outcome: "stopped",
        endedAt: iso(),
        retryAt: null,
        nextCheckAt: null,
        summary: `Stopped: ${reason}${prev ? ` (was: ${prev.slice(0, 200)})` : ""}`,
      })!;
      const a = store.getAssignment(r.assignmentId);
      if (a?.retryRunId === r.id) store.updateAssignment(a.id, { retryAt: null, retryRunId: null });
      // a world's reported seat is released only when no other world holds it
      if (r.parentRunId && r.seat && o.dispatcher && !seatHeldElsewhere(db, world, r.seat)) await o.dispatcher.done(r.seat, false).catch(() => undefined);
      await releaseSeatHold(r.id);
      track(onRunEnded(r.id));
      return done;
    };
    t3();
    const kids = store.listRuns({ parentRunId: run.id, limit: 500 }).filter((r) => r.outcome === "running");
    const stopped = await stopOne(run);
    const workers: Run[] = [];
    const workerErrors: { runId: string; error: string }[] = [];
    if (opts.withWorkers)
      for (const k of kids) {
        if (!k.threadId && !threadlessStoppable(k)) {
          workerErrors.push({ runId: k.id, error: "no thread yet to interrupt" });
          continue;
        }
        try {
          workers.push(await stopOne(k));
        } catch (e) {
          workerErrors.push({ runId: k.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
    return { run: stopped, workers, workersRunning: kids.length - workers.length, workerErrors };
  }

  /** a running run with no thread that Stop may close: past its start window, or its send failed (waits on a retry), and no start in flight. */
  function threadlessStoppable(r: Run): boolean {
    if (r.threadId || starting.has(r.id) || retrying.has(r.id)) return false;
    return Date.now() - Date.parse(r.startedAt) > noThreadStopMs || r.summary.startsWith(SEND_RETRY_PREFIX);
  }
  /** Stop on a run with no thread: nothing to interrupt, the run closes `stopped` and its pending start is dropped. */
  async function stopThreadless(r: Run, reason: string): Promise<Run> {
    const prev = r.summary.trim();
    const done = store.updateRun(r.id, {
      outcome: "stopped",
      endedAt: iso(),
      retryAt: null,
      nextCheckAt: null,
      summary: `Stopped: ${reason} (no thread: the run never started, nothing to interrupt${prev ? `; was: ${prev.slice(0, 300)}` : ""})`,
    })!;
    if (getLink(r.assignmentId)?.pendingRunId === r.id) clearLinkField(r.assignmentId, "pending_run_id");
    const a = store.getAssignment(r.assignmentId);
    if (a?.retryRunId === r.id) store.updateAssignment(a.id, { retryAt: null, retryRunId: null });
    await releaseSeatHold(r.id);
    track(onRunEnded(r.id));
    return done;
  }

  /** the owner's steer notes on a run, oldest first. */
  function steersOf(runId: string): RunSteer[] | undefined {
    const rows = db.prepare("SELECT at, mode, message FROM cycle_run_steer WHERE run_id = ? ORDER BY at, rowid").all(runId) as RunSteer[];
    return rows.length ? rows : undefined;
  }


  // ---------- delivery to a persona's home thread ----------
  /**
   * a turn the owner starts in a home thread via Send to is recorded as a run of kind answer_run (after the send
   * succeeded; started_at is taken before it so the reconciler matches the T3 turn). It never counts as a wake.
   */
  function recordAnswerRun(assignmentId: string, threadId: string, startedAt: string, opts: { answerRun?: boolean; summary?: string }): string | undefined {
    if (!opts.answerRun) return undefined;
    const run = store.createRun({
      assignmentId,
      kind: "answer_run",
      outcome: "running",
      startedAt,
      threadId,
      summary: opts.summary ?? `Answer run: message from ${ownerName()}`,
    });
    return run.id;
  }

  /**
   * Post a message from the owner into the assignment's home thread. No home thread yet (never woken): launch it the
   * way run-now does (T3 project of the milestone repo, a seat from the dispatcher, the persona's model) with the
   * message as its first turn, and record it as the home thread so later wakes and the setup turn reuse it.
   */
  async function deliver(
    assignmentId: string,
    message: string,
    clientRequestId?: string,
    opts: { answerRun?: boolean; summary?: string } = {},
  ): Promise<{ threadId: string; launched: boolean; runId?: string }> {
    t3();
    const startedAt = iso();
    const { m, p } = ctx(assignmentId);
    const host = p.host;
    const link = linkFor(assignmentId, host);
    try {
      if (link?.threadId) {
        // a message to an existing thread never starts the worker server: if the box is off the send fails and says so
        const c = clientFor(host);
        if (host === workerHost()) o.worker?.touchTunnel(); // the send goes through the same persistent tunnel
        await c.sendToThread(link.threadId, message, clientRequestId);
        if (host === mainHost()) gate.mark(`message to ${assignmentId}`); // the owner's answer never waits, but counts
        const sentRun = recordAnswerRun(assignmentId, link.threadId, startedAt, opts);
        stampFromThread(db, sentRun, link.threadId);
        stampHost(db, sentRun, host);
        return { threadId: link.threadId, launched: false, runId: sentRun };
      }
      await ensureHost(host);
      const client = clientFor(host);
      const project = await resolveProject(m.repo, host);
      const { seat, modelSelection, stamp } = await pickSeat(p.model, false, p.id, host, { startGate: "mark" });
      const { threadId } = await client.launchThread({ projectId: project.id, title: `${p.name} → ${m.title}`, message, modelSelection });
      rememberThread(db, threadId, stamp);
      setLink(assignmentId, { projectId: project.id, threadId, seat, host });
      const launchedRun = recordAnswerRun(assignmentId, threadId, startedAt, opts);
      if (launchedRun) stampRun(db, launchedRun, stamp);
      stampHost(db, launchedRun, host);
      return { threadId, launched: true, runId: launchedRun };
    } catch (e) {
      if (e instanceof CycleError) throw e;
      throw new CycleError(502, "t3_error", errorText(e));
    }
  }

  /** post into a thread named in a spine's `Owner:` (no persona attached); never launches one. */
  async function deliverToThread(threadId: string, message: string, clientRequestId?: string): Promise<{ threadId: string; launched: boolean }> {
    const client = t3();
    try {
      await client.sendToThread(threadId, message, clientRequestId);
      return { threadId, launched: false };
    } catch (e) {
      throw new CycleError(502, "t3_error", errorText(e));
    }
  }

  // ---------- Bootstrap ----------
  async function bootstrap(input: { repo: string; title: string; goal: string; kind: "spine" | "ticket"; owner: string }) {
    const client = t3();
    const project = await resolveProject(input.repo);
    const mi = { title: input.title, repo: input.repo, path: "", owner: input.owner, paused: false };
    const milestone = o.createMilestone ? await o.createMilestone(mi) : store.createMilestone(mi);
    // Bootstrap runs belong to no assignment; assignment_id has no FK, so it carries a synthetic id.
    const runId = `run_${randomUUID()}`;
    db.prepare(
      `INSERT INTO runs (id, assignment_id, milestone_id, started_at, outcome, summary) VALUES (?, ?, ?, ?, 'running', ?)`,
    ).run(runId, `bootstrap:${milestone.id}`, milestone.id, iso(), `Bootstrap: creating the ${input.kind} file`);
    db.prepare("INSERT INTO cycle_bootstrap (milestone_id, run_id, kind, goal, created_at) VALUES (?, ?, ?, ?, ?)").run(
      milestone.id,
      runId,
      input.kind,
      input.goal,
      iso(),
    );
    let seat: string | undefined;
    try {
      const picked = await pickSeat(o.bootstrapModel ?? "claude-opus-5-5", true, undefined, undefined, { startGate: "mark" });
      seat = picked.seat;
      db.prepare("INSERT INTO cycle_seat_hold (run_id, seat) VALUES (?, ?)").run(runId, seat);
      const { threadId } = await client.launchThread({
        projectId: project.id,
        title: `Bootstrap: ${input.title}`,
        message: bootstrapPrompt({ base, milestone, run: store.getRun(runId)!, goal: input.goal, kind: input.kind }),
        modelSelection: picked.modelSelection,
      });
      store.updateRun(runId, { threadId, seat });
      stampRun(db, runId, picked.stamp);
      stampHost(db, runId, mainHost()); // t3 is the console host's T3
    } catch (e) {
      store.updateRun(runId, { outcome: "failed", endedAt: iso(), summary: `Bootstrap launch failed: ${errorText(e)}` });
      await releaseSeatHold(runId);
      if (e instanceof CycleError) throw e;
      throw new CycleError(502, "t3_error", errorText(e), { milestoneId: milestone.id, runId });
    }
    return { milestone: store.getMilestone(milestone.id)!, run: store.getRun(runId)! };
  }

  const listBootstraps = () =>
    (db.prepare("SELECT * FROM cycle_bootstrap ORDER BY created_at DESC").all() as Row[]).map((r) => ({
      milestoneId: r.milestone_id,
      runId: r.run_id,
      kind: r.kind,
      goal: r.goal,
      createdAt: r.created_at,
    }));

  /** Release a seat held by a run (bootstrap) once the run reports a terminal outcome. */
  async function releaseSeatHold(runId: string) {
    const r = db.prepare("SELECT seat FROM cycle_seat_hold WHERE run_id = ?").get(runId) as Row | undefined;
    if (!r) return;
    const run = store.getRun(runId);
    if (run && !TERMINAL.has(run.outcome)) return;
    db.prepare("DELETE FROM cycle_seat_hold WHERE run_id = ?").run(runId);
    await o.dispatcher?.done(r.seat, run?.outcome === "failed").catch(() => undefined);
  }

  async function status(id: string) {
    const { a } = ctx(id);
    const link = getLink(id);
    let thread: { status: string } | undefined;
    const target = link?.host === workerHost() ? o.worker?.client : o.t3; // status never starts the worker server
    if (o.enabled && target && link?.threadId)
      thread = await target.readThreadStatus(link.threadId).then((t) => ({ status: t.status })).catch(() => undefined);
    return { cycleEnabled: o.enabled, assignmentId: a.id, t3ScheduledTaskId: a.t3ScheduledTaskId, ...link, thread };
  }

  return {
    enabled: o.enabled,
    publicUrl: base,
    sync,
    onAssignmentDeleted,
    runNow,
    runNowRequest,
    /** launch a handover thread on the main server or the worker server. */
    handover,
    /** launch a worker on the main server for a wake whose own pick was refused (`fallback: "console"`). */
    launchWorker,
    steer,
    steerRun,
    sendToRun,
    stopRun,
    steersOf,
    /** the assignment's running (non-stale) wake run, if any: an answer steers it instead of waking. */
    liveRun: liveWake,
    wake,
    wakeRequest,
    wakeCheck,
    deliver,
    deliverToThread,
    bootstrap,
    listBootstraps,
    releaseSeatHold,
    /** pull the ended run's repo in the background (settled waits for it). */
    runEnded: (runId: string) => track(onRunEnded(runId)),
    status,
    getLink,
    /** T3 environment id of a thread / of a host (undefined = not known; the UI falls back to t3-thread://). */
    threadEnvironment: environments.forThread,
    hostEnvironment: environments.hostEnvironment,
    environmentTick,
    rearmParked,
    tickCadence,
    tickOrphans,
    clearTasks,
    tickRetry,
    tickDeferred,
    reconcile,
    /** one idle-stop sweep, and the threads settled lately (in memory). */
    idleStop,
    idleStops: idleStopper.recent,
    /** last T3 state the reconciler read for a running run (in memory; gone after a restart until the next tick). */
    runT3State: reconciler.t3State,
    /** a PATCH of a run (PATCH /api/runs/:id): proof of life the reconciler weighs before timing a run out. */
    touchRun: reconciler.touch,
    stop: () => {
      timers.forEach((t) => clearTimeout(t));
      o.worker?.close();
    },
    /** Resolves when background work (off-wake syncs, run-end pulls) has finished. Tests use it. */
    settled: async () => {
      while (background.size) await Promise.all([...background]);
    },
  };
}

export type Cycle = ReturnType<typeof createCycle>;
