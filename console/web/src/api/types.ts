// Types per the M2 Data contract (docs/spines/m2-team-console.md → "Data contract").
// ids are strings, times are ISO-8601 UTC strings.
import type { AskKind, OwnerPriority } from "./inbox-types";
import { type HostId } from "../lib/identity";

/**
 * Badge status = the first word of the spine's `Status:` line (EpicSpine vocabulary; "One status word per
 * state": deferred = paused by the owner, blocked = waiting on a named external dependency), `paused` = paused in the
 * console, `unknown` = no status word. `Waiting on:` never implies blocked.
 */
export type MilestoneStatus =
  | "draft"
  | "ready"
  | "active"
  | "blocked"
  | "review"
  | "testing"
  | "done"
  | "superseded"
  | "deferred"
  | "paused"
  | "unknown";

export interface DodItem {
  text: string;
  /** null = untracked criterion (plain list item, not a checkbox). */
  checked: boolean | null;
  /** Original number of a numbered untracked criterion ("1" for "1...."); absent for bullets and checkboxes. */
  id?: string;
}

export interface Dod {
  done: number;
  total: number;
  items: DodItem[];
  /** true = checkbox items; false = items are plain list criteria (e.g. a numbered "Exit Test"), so progress can't be tracked. */
  tracked?: boolean;
}

/** Machine-read sections found in the milestone file (Overview "Spine shape" hint). */
export interface SpineShape {
  dod: boolean;
  currentState: boolean;
  status: boolean;
  waitingOn: boolean;
  issueLedger: boolean;
  queue: boolean;
}

export interface Milestone {
  id: string;
  title: string;
  /** Derived: the spine's own title (spines.py node), when it differs from the stored `title`; shown instead of it unless titleOverride. */
  docTitle?: string;
  /** Settings saved an explicit title, so `title` wins over docTitle (see milestoneName). */
  titleOverride?: boolean;
  /** Local checkout path or `owner/name`. */
  repo: string;
  /** the world (tenant) that owns it, on GET /milestones/:id; only the home world's milestones have an Epic Book. */
  world?: string;
  /** Spine or epic ticket file inside the repo. */
  path: string;
  owner: string;
  paused: boolean;
  /** console-only "settled" mark (ISO); absent = not settled. Separate from the spine status. */
  settledAt?: string;
  /** one of the owner's big roots, at this position (1 first); absent = an ordinary milestone. */
  bigRoot?: number;
  createdAt: string;
  // Derived, read-only (filled by the spine adapter; may be absent before that).
  status?: MilestoneStatus;
  dod?: Dod;
  blockedReason?: string;
  /** `Waiting on:` text from Current State (context only). */
  waitingOn?: string;
  stateExcerpt?: string;
  shape?: SpineShape;
  /** Set when the repo or file could not be read. */
  docError?: string;
  /** non-green nodes still to do in the milestone's epic tree (list endpoint; absent when unreadable). */
  nonGreen?: number;
  /** the spine's `## Outcome` (null = none written, or spines.py does not emit it yet). */
  outcome?: Outcome | null;
  /** outcome.verdict, else derived by the server (accomplished? / superseded / parked / blocked on the owner / in progress). */
  verdict?: Verdict;
  /** owner/name of the milestone repo on GitHub (for commit, PR and spine links). */
  remote?: string;
  /** named lines of the spine's `## Current State`. */
  state?: CurrentState;
  /** last git commit on the spine file (ISO). */
  spineCommitAt?: string;
  /** Doctrine-2 fields from `spines.py --json` (GET /milestones/:id only); absent = not provided. */
  doctrine?: Doctrine;
  /** `spines.py --json` run_state (planning | ready | running | parked | finished) and whether a wake works it; absent = unknown. */
  runState?: string;
  runnable?: boolean;
  /** the spine's Current State `Monitoring:` items (waits on a time or a condition); [] or absent = none. */
  monitoring?: MonitorItem[];
}

/** one `Monitoring:` item; dates are ISO UTC. */
export interface MonitorItem {
  what: string;
  since?: string;
  until?: string;
  nextCheckAt?: string;
  /** What the next check looks at. */
  nextCheck?: string;
  then?: string;
}

/** Console contract (epicspine-skill docs/doctrine/console-contract.md); every field optional. */
export interface Doctrine {
  goal?: string;
  serves?: string;
  /** Ancestors from the parent up to the root, each with its own `serves`. */
  servesChain?: { path: string; title: string; serves?: string }[];
  children?: { path: string; title: string; status?: string; contributes?: string }[];
  doneMeans?: { id: string; text: string; done: boolean }[];
  pages?: { path: string; title: string; via: string }[];
  missingSections?: string[];
  size?: { lines: number; long_cells: number };
}

/** `## Current State` (epicspine-skill console contract #latest-state, camelCased): raw text after `Label:`, null when missing. */
export interface CurrentState {
  status: string | null;
  lastAttempted: string | null;
  result: string | null;
  evidence: string | null;
  waitingOn: string | null;
  nextAction: string | null;
  verifiedAt: string | null;
  /** "spines" = spines.py `current_state`; "markdown" = the console's fallback parse. */
  source: "spines" | "markdown";
}

/** Console contract #outcome (epicspine-skill docs/doctrine/console-contract.md), camelCased. */
export interface Outcome {
  verdict: string | null;
  sentence: string | null;
  evidence: { doneMeans: string; links: string[] }[];
  risk: string | null;
  closedAt: string | null;
  closedBy: string | null;
}

export interface Verdict {
  /** accomplished | partially accomplished | not accomplished | superseded | accomplished? | parked | blocked on the owner | in progress */
  word: string;
  source: "outcome" | "derived";
  note?: string;
}

/** A spine commit made during a run (GET /api/milestones/:id/run-commits → { [runId]: RunCommit[] }). */
export interface RunCommit {
  sha: string;
  subject: string;
  at: string;
}

export type MilestoneInput = Pick<Milestone, "title" | "repo" | "path" | "owner"> & {
  paused?: boolean;
  /** position among the owner's big roots; null on a patch makes it an ordinary milestone again. */
  bigRoot?: number | null;
};

export interface Persona {
  id: string;
  name: string;
  /** The prompt. */
  remit: string;
  skills: string[];
  model: string;
  /** false = restoration/ops actions diagnose only; writes go to Needs the owner. */
  mayWrite: boolean;
  /** where its threads run; absent = the main server. the worker server = the ephemeral the worker server box, started on wake. */
  host?: PersonaHost;
  /** every wake launches a new thread with the full prompt (the Unblocker); absent = false (home thread). */
  freshThreadEachWake?: boolean;
  /** a cadence wake with nothing new since the last real wake is skipped; absent = true (on). */
  skipUnchanged?: boolean;
  createdAt: string;
}

export type PersonaHost = HostId;

/** a generic persona template (the code repo/personas/templates/<name>.md, GET /api/persona-templates). */
export interface PersonaTemplate {
  name: string;
  template: string;
  model: string;
  host: string;
  /** the team skills the template declares (absent from servers before). */
  skills?: string[];
  remit: string;
  reads: string;
  writes: string;
  /** The remit a persona made from it starts with (Remit, Reads, Writes in one text). */
  prompt: string;
}
export type PersonaInput = Pick<Persona, "name" | "remit" | "skills" | "model" | "mayWrite" | "host">;

export type Cadence =
  | { type: "interval"; everyMinutes: number; quiet?: { from: string; to: string; timeZone: string } }
  | { type: "fixed_time"; timeOfDay: string; weekdays: number[] };

export interface Assignment {
  id: string;
  milestoneId: string;
  personaId: string;
  cadence: Cadence;
  enabled: boolean;
  t3ScheduledTaskId?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  /** auto-park: set while the wake gate has it switched off (nothing actionable); the toggle resumes it. */
  parkedAt?: string;
  parkedReason?: string;
  /** write on this milestone only, limited to writeScope; this switch is the only write gate; persona.mayWrite only sets the default of a new assignment. */
  writeEnabled?: boolean;
  writeScope?: string;
  /** a timed wake a run asked for (ISO UTC) and the run that asked; cleared once it fires. */
  retryAt?: string;
  retryRunId?: string;
  /** the earlier of nextRunAt and retryAt. */
  nextWakeAt?: string;
  /** never been switched on (attached off; Run now alone does not count). */
  neverOn?: boolean;
  /** the objective (pursuit id) it works: an objective's Personas tab lists only its own. */
  objective?: string;
}

export type AssignmentInput = Pick<Assignment, "milestoneId" | "personaId" | "cadence"> & {
  enabled?: boolean;
  writeEnabled?: boolean;
  writeScope?: string;
  /** "" clears it on a patch. */
  objective?: string;
};

/** POST /api/milestones/bootstrap: an agent in the repo creates the spine/ticket and sets the path. */
export interface BootstrapInput {
  repo: string;
  title: string;
  goal: string;
  kind: "spine" | "ticket";
  owner?: string;
}

export interface BootstrapResult {
  milestone: Milestone;
  run: Run;
}

/** blank_report: the T3 turn completed and the persona never reported. */
/** monitoring = nothing to do until a time or a condition (nextCheckAt); blocked = the owner must act (an open ask code). */
/** stopped: the owner (or the desk) stopped the run from the console; it never resumes on its own. */
/** deferred: load-cap or no seat when the wake started; the console retries it (`deferred` holds the retry state). */
export type RunOutcome = "running" | "progressed" | "blocked" | "monitoring" | "idle" | "failed" | "blank_report" | "stopped" | "deferred";
/** answer_run: a turn the owner started in a home thread via Send to; never counted as a wake. */
/** toggle: the on/off switch was flipped (summary names who and from→to); never a wake. */
export type RunKind = "wake" | "answer_run" | "toggle";

export interface Run {
  id: string;
  assignmentId: string;
  /** Set by the server on every run (copied from the assignment, or the bootstrapped milestone). */
  milestoneId?: string;
  startedAt: string;
  endedAt?: string;
  seat?: string;
  threadId?: string;
  /** T3 environment of the thread (t3code:// link); undefined = not known yet. */
  environmentId?: string;
  outcome: RunOutcome;
  summary: string;
  parentRunId?: string;
  /** Absent on older servers = wake. */
  kind?: RunKind;
  /** Stamped by the server from the assignment at insert; names the persona after the assignment is deleted. */
  personaId?: string;
  /** running runs only, the last T3 thread state the server's reconciler read. */
  t3?: RunT3State;
  /** the owner's one-off instructions given with Run now (injected into this run's wake only). */
  instructions?: string;
  /** who gave `instructions` (the owner from the UI; Unblocker when it woke the Delivery Manager). */
  instructionsBy?: string;
  /** the asks this run checked (the Unblocker's finishing PATCH), one entry per ask. */
  checks?: RunCheck[];
  /** the timed wake this run asked for (ISO UTC). */
  retryAt?: string;
  /** a monitoring run's next scheduled check (ISO UTC) and, when known, when the watch ends. */
  nextCheckAt?: string;
  until?: string;
  /** the word the agent reported when the server stored another (a `blocked` citing no open ask → monitoring). */
  reportedOutcome?: string;
  /** ended monitoring because this Team Browser egress was offline (`egress:laptop`); its online event wakes it. */
  heldOn?: string;
  /** NO_SELF_READY: spine lines this run's commits turned from draft to ready (amber "self-readied"; the DM reverts). */
  selfReadied?: string[];
  /** the run's commits failed its pack's `pack.py validate --by <role>` (red "rule broken"; the DM routes the fix). */
  ruleBroken?: { at: string; roles: string[]; issues: string[] };
  /** the report's `note: done|not done: <why>` line (runs that carried instructions). */
  noteAck?: string;
  /** finished with instructions but never acknowledged them (amber "note skipped"). */
  noteSkipped?: boolean;
  /** what the console did to the persona's checkout before the wake (pull, fresh session). */
  /** retry state of a deferred wake (load-cap / no seat): reason, attempts, next try. */
  deferred?: { reason: string; host: HostId; attempts: number; firstAt: string; nextAt: string };
  /** the host its thread launched on when not the persona's (the worker server at its cap → the main server). */
  launchHost?: HostId;
  /** the host the run's agent ran on, as recorded at launch (absent on older runs). */
  host?: HostId;
  preWake?: string;
  /** why this real cadence wake was not skipped (the fingerprint part that changed: spines, prompt, answer, running, ready; or the skip rule that did not hold). */
  wokeBecause?: string;
  /** the wake reported idle while these steps read ready (stored as idle; amber "ignored ready"). */
  readyIgnored?: string[];
  /** the same report (outcome + summary bar numbers/times/ids) n wakes in a row (≥ 4), since repeatSince. */
  repeating?: number;
  repeatSince?: string;
  /** a Delivery manager wake that launched no worker while rows read ready and named no `blocker:` (amber "stalled"). */
  stalled?: string;
  /** tokens the run used (from its transcript, collected a few minutes after it ends); absent = not collected yet. */
  usage?: RunUsage;
  /** a running run's tokens so far (read every 2 min). */
  usageLive?: RunUsage;
  /** the owner's steers into the running thread, oldest first (kept apart from `summary`, which the persona rewrites). */
  steers?: RunSteer[];
  /** what the dispatcher picked for this run (absent on runs from before S13 and on runs agents post). */
  provider?: string;
  providerInstance?: string;
  model?: string;
  priceKey?: string;
  /** true = seat subscription: priced at list for credits, not a bill. */
  notional?: boolean;
}

/** one steer sent into a run's thread; `auto` = queued because the turn could not take it. */
export interface RunSteer {
  at: string;
  mode: "steer" | "auto";
  message: string;
}

/** token counts of one model in a run. */
export interface ModelUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** API calls (assistant messages). */
  turns: number;
}
/** a run's usage; costUsd is an API list-price estimate (null when a model has no price). */
export interface RunUsage extends ModelUsage {
  model: string;
  costUsd: number | null;
  estimate: true;
  collectedAt: string;
  /** `claude-code:<host>`, `no-thread` for a skipped wake, `no-turn` for a wake that never got a turn (all zeros). */
  source: string;
  byModel?: Record<string, ModelUsage & { costUsd: number | null }>;
  /** the seat (Claude config dir) the tokens came from: `seat3`, `default`. */
  seat?: string;
  dirs?: string[];
  /** false = first read 1 min after the end, re-read at 5 min. */
  final?: boolean;
  /** tokens so far of a run still working. */
  live?: boolean;
}
export type UsageGroupBy = "persona" | "milestone" | "seat" | "day";
/** GET /api/usage totals for one group (persona, milestone or day). */
export interface UsageGroup extends ModelUsage {
  key: string;
  label: string;
  runs: number;
  collected: number;
  /** Ended, not read yet (ended under a minute ago, next sweep, host asleep). */
  pending: number;
  /** read, no transcript names it (retried for 7 days). */
  missing?: number;
  skipped: number;
  costUsd: number;
  /** runs still working and their tokens so far (not in the totals). */
  live?: { runs: number; input: number; output: number; costUsd: number };
}
export interface UsageTotals {
  from: string;
  to: string;
  groupBy: UsageGroupBy;
  groups: UsageGroup[];
  total: UsageGroup;
  /** why missing runs are missing, with counts. */
  missingReasons?: Record<string, number>;
  /** the newest read behind these numbers. */
  updatedAt?: string | null;
}

/** the Unblocker's numbers per milestone and window (GET /api/unblocker-stats). */
export type UnblockerStatsWindow = "24h" | "7d" | "all";
export interface UnblockerAskTiming {
  count: number;
  medianMs: number | null;
  worstMs: number | null;
  worstCode?: string;
  estimated: number;
  waiting: number;
  oldestWaitingMs: number | null;
  oldestWaitingCode?: string;
}
export interface UnblockerCounts {
  wakesFired: number;
  wakesSkipped: number;
  newAsks: number;
  assessed: number;
  answered: number;
  left: number;
  split: number;
  reversed: number;
  askToVerdict: UnblockerAskTiming;
  /** confidence rubric, when its checks carry scores. */
  score?: { count: number; median: number; threshold?: number };
}
export interface UnblockerMilestoneStats extends UnblockerCounts {
  milestoneId: string;
  milestoneTitle: string;
}
export interface UnblockerStats {
  window: UnblockerStatsWindow;
  from: string | null;
  to: string;
  milestones: UnblockerMilestoneStats[];
  total: UnblockerCounts;
}

/** one ask an Unblocker run checked. `spine` = repo-relative path of the ask line, optionally `:<line>`. */
export interface RunCheck {
  code: string;
  decision: "answered" | "left" | "split";
  answer?: string;
  confidence?: number;
  source?: string;
  why?: string;
  /** left provide asks: what was checked for an existing credential or a no-credential path. */
  searched?: string;
  spine?: string;
  /** copied from an earlier run by a skipped cadence wake (nothing new), not checked again. */
  skipped?: boolean;
  /** a remembered verdict carried unchanged since this run assessed it (not assessed again). */
  carriedFrom?: string;
  /** the confidence rubric's factors (0-4 each), the hard-floor ids it touches and the console's stamp. */
  scores?: { reversal: number; options: number; impact: number; evidence: number };
  floor?: string[];
  rubric?: { score: number; threshold: number; minFactor: number; weights: Record<string, number>; clears: boolean; from: "milestone" | "global" | "default" };
}

/** `detail` is T3's own status word (cancelled, interrupted…); `startedAt` the matched turn's start. */
export interface RunT3State {
  status: "live" | "completed" | "failed" | "unknown";
  detail?: string;
  startedAt?: string;
  checkedAt: string;
}

export type RunInput = Omit<Run, "id" | "t3">;

export type NeedsOwnerStatus = "open" | "approved" | "denied" | "answered" | "superseded";

export interface NeedsOwner {
  id: string;
  runId: string;
  milestoneId: string;
  question: string;
  proposedAction: string;
  status: NeedsOwnerStatus;
  createdAt: string;
  /** status superseded: `<repo>/<code>` of the coded ask that replaced it, or `moot`. */
  supersededBy?: string;
  supersededAt?: string;
}

// Read-only views, served by core/console/server/src/routes/read.ts.

export interface Thread {
  id: string;
  title: string;
  project: string;
  workspaceRoot?: string;
  milestoneId?: string;
  /** T3 run status: running, starting, queued, preparing, waiting (active) · idle, completed, failed, … */
  status: string;
  updatedAt: string;
  parentThreadId?: string;
  seat?: string;
  model?: string;
  /** T3 environment of the thread (the console's own T3), when known. */
  environmentId?: string;
}

export interface Ticket {
  id: string;
  title: string;
  repo: string;
  milestoneId?: string;
  /** Backlog rows: normalised (done, blocked, active, dispatched, ready, pending, paused, "—"). */
  status: string;
  /** Raw status text when it says more than `status`. */
  statusDetail?: string;
  owner?: string;
  /**
   * "ledger" | "queue" (or another work-item heading) | "… · ticket file" when enriched from a linked file |
   * "ticket-root (not linked from spine)" | "tickets-dir" | "github".
   */
  source: string;
  url?: string;
  /** Ticket file path inside the repo. */
  path?: string;
}

export interface Seat {
  id: string;
  name: string;
  /** Percent of the 5-hour window; undefined = unknown. */
  usage5h?: number;
  usageWeekly?: number;
  resetsAt: { fiveHour?: string; weekly?: string; limitedUntil?: string };
  limited: boolean;
  inFlight: number;
  status: "ok" | "limited" | "unknown" | "logged_out";
  /** Why usage is unknown. */
  reason?: string;
  readAt?: string;
  org?: string;
  /** why there is no weekly % (`not metered`: Team seats have no general weekly cap). */
  weeklySource?: string;
  /** per-model weekly windows (e.g. Fable). */
  modelWeekly?: { model: string; pct?: number; resetsAt?: string }[];
}

/** One persona on a seat (GET /api/seats/board): `world` is the product it works for; absent = a customer's agent. */
export interface BoardPersona {
  name: string;
  world?: string;
  runs: number;
}
/** One AI subscription on the Seats screen: its persona now, the last 24 h and its load. */
export interface BoardSeat {
  id: string;
  plan?: string;
  state: "working" | "free" | "limited" | "signed_out" | "unknown";
  usage5h?: number;
  usageWeekly?: number;
  /** Fable credit left this week, percent; 0 when its plan has none or Fable was refused on it. */
  fableLeft?: number;
  fableNote?: string;
  limitedUntil?: string;
  running: number;
  now: BoardPersona[];
  day: BoardPersona[];
  runs24h: number;
  lastUsed?: string;
}
/** GET /api/seats/board: every seat in seats.json, never padded to `target`. */
export interface SeatBoard {
  seats: BoardSeat[];
  target: number;
  signedIn: number;
  workingNow: number;
  personas: number;
  runs24h: number;
  /** seats with Fable credit left now. */
  fableSeats?: number;
  readAt?: string;
}

/** A git checkout under REPOS_ROOT on the main server (GET /api/repos). */
export interface Repo {
  name: string;
  path: string;
  /** owner/name when origin is on GitHub. */
  remote?: string;
  hasEpicSpine: boolean;
}

/** A candidate milestone file in a repo (GET /api/repos/:name/docs). */
export interface RepoDoc {
  path: string;
  kind: "spine" | "ticket";
  title: string;
  status?: string;
  dod: { done: number; total: number };
  /** "spines" = listed by EpicSpine `spines.py --json`; "fallback" = path rules (spines.py missing or failed). */
  via?: "spines" | "fallback";
  /** Tree nodes from spines.py: depth below the root (0 = root), parent path, spine type, aggregate status when it differs. */
  depth?: number;
  parent?: string | null;
  type?: string;
  rollupStatus?: string;
  /** Goal doc outside the spine tree: the reason (e.g. "not reachable from the root"). */
  orphan?: string;
}

/** GET /api/cycle: the server's scheduler kill switch (CONSOLE_CYCLE_ENABLED). Off = no wakes and no Run now. */
export interface CycleInfo {
  enabled: boolean;
  publicUrl?: string;
}

export const ACTIVE_THREAD_STATUSES = ["running", "starting", "queued", "preparing", "waiting"];

/** A synced site in the central browser auth store (GET /api/auth/sites). Never carries cookie values. */
export interface AuthSite {
  id: string;
  /** Site pattern: *.reddit.com, x.com, *.airbnb.* */
  pattern: string;
  domains: string[];
  cookieCount: number;
  /** Earliest cookie expiry: often a short-lived cookie the site renews itself (x.com __cf_bm: 30 min); a hint only. */
  earliestExpiry?: string;
  /** When the login expires: the site's login cookies (x.com auth_token/ct0, reddit.com reddit_session), else the latest cookie. */
  loginExpiry?: string;
  /** Which cookie(s) loginExpiry comes from; absent from browser services before. */
  loginCookie?: string;
  sourceBrowser: string;
  sourceProfile: string;
  /** The browser profile this entry came from ("Chrome/Profile 5"); one entry per (pattern, profile). */
  profileKey?: string;
  /** The accounts this profile holds (the Team Browser's profile map) and the profile's own name. */
  accounts?: string[];
  profileLabel?: string;
  /** Reads that name no account use this entry. */
  defaultForReads?: boolean;
  syncedAt: string;
  lastUsedAt?: string;
  lastUsedBy?: string;
  /** Last logged-in read by the Team Browser: "dead" = rejected (403 / login redirect), re-sync needed. */
  session?: "ok" | "dead";
  sessionReason?: string;
  /** the row is on the owner's Mac list: its Run all re-syncs it (Re-sync pressed, or out of sync). */
  resync?: { reason: "pressed" | "out-of-sync"; why: string; requestedAt: string; lastTryAt?: string; lastError?: string };
}

/** A sign-in as Setup sees it (GET /api/auth/reach): an AuthSite's metadata, `via` = the world whose browser lends it. */
export type ReachSite = Pick<AuthSite, "id" | "pattern" | "domains" | "syncedAt" | "loginExpiry" | "session" | "sessionReason"> & { via?: string };

/** GET /api/auth/reach: the browsers the world's team reads (its own first, then one it borrows), with their sign-ins. */
export interface AuthReach {
  sources: { world: string; own: boolean; sites: ReachSite[]; error?: string }[];
}

/** one site in the Team Browser's hourly signed-in check (GET /api/auth/check; no cookie values). */
export interface SignedInCheck {
  site: string;
  state: "signed_in" | "signed_out" | "held" | "error" | "not_synced" | "by_api";
  detail: string;
  /** The one step that fixes it ("none" when nothing is needed). */
  fix: string;
  pattern?: string;
  checkedAt: string;
  /** When the site entered this state. */
  since: string;
  /** The ask in the owner's inbox for this lost session, when one was raised. */
  ask?: { code: string; path: string; raisedAt: string };
}

/** a Team Browser egress's online state (GET /api/auth/egress, from the browser's health poller; no address). */
export interface EgressStatus {
  /** Egress name in the Team Browser's map: `laptop` is the owner's laptop. */
  name: string;
  state: "online" | "offline" | "unknown" | "disabled";
  /** Online/offline since (ISO). */
  since?: string;
  /** Last passing check (ISO). */
  lastSeen?: string;
  checkedAt?: string;
  reason?: string;
  /** `hold`: reads through it answer HELD while it is offline. */
  whenDown?: string;
  /** real Reddit/X writes held in the Team Browser's outbox until the laptop is back. */
  heldWrites?: number;
}

export type AuthSyncState = "pending" | "synced" | "expired" | "error";

/** A one-time sync token (POST /api/auth-sync, GET /api/auth-sync/:token). */
export interface AuthSync {
  token: string;
  status: AuthSyncState;
  patterns: string[];
  browserHint: string;
  createdAt: string;
  expiresAt: string;
  /** Copy-paste command for the Mac terminal. */
  command: string;
  scriptUrl: string;
  /** A row's Re-sync: the profile the command opens and syncs ("Chrome/Profile 5"). */
  targetProfile?: string;
  error?: string;
  result?: {
    browser: string;
    profile: string;
    profileName?: string;
    /** keptBeside: other profiles' entries for the same site, left untouched. */
    sites: { id?: string; pattern: string; cookieCount: number; domains: string[]; keptBeside?: string[] }[];
  };
}

// ---------- epic tree (GET /api/milestones/:id/tree) ----------

export type TreeColor = "grey" | "blue" | "yellow" | "red" | "green";

export interface TreeNode {
  /** Unique within the tree. */
  key: string;
  id: string;
  kind: "spine" | "ticket" | "dod";
  title: string;
  /** short code shown on the row (M5, root); absent on older servers (then the id). */
  code?: string;
  /** short plain label shown beside the code (spine `Label:` line, else derived from the title); absent on older servers. */
  label?: string;
  /** Raw status text as written in the spine / ticket. */
  status: string;
  color: TreeColor;
  path?: string;
  children: TreeNode[];
  /** unknown-status, dishonest-green, mismatch, stale, done-open-descendants (honesty); cycle, repeat, depth-cap (structure). */
  flags: string[];
  notes?: string[];
  /** Ledger gate cell (`Needs` column), e.g. "the owner go". */
  needs?: string;
  /** ledger row's `Depends on` cell, e.g. "#17, #18, #19". */
  dependsOn?: string;
  /** ledger row's owner cell. */
  owner?: string;
  /** ledger row's `Next action` cell; absent on older servers. */
  nextAction?: string;
  /** open human asks to the owner on this node (row-linked asks make it red). */
  asks?: { ask: string; question: string; who: string; since: string | null }[];
  /** ready/todo with nothing blocking it (no gate, no ask); absent on older servers. */
  ready?: true;
  /** open items for the owner on this node (it is red; the Tree red count is their sum). */
  waiting?: number;
  /** an ancestor of a red node: red ring, never counted as red. */
  rollup?: "red";
  /** the row waits on an open ask counted elsewhere (its codes): red ring, never counted. */
  waitsOn?: string[];
  /** spine nodes: spines.py run_state (planning | ready | running | parked | finished); finished ones are folded. */
  runState?: string;
  /** closed without done (superseded, cancelled, moved): drawn muted like done work, never "ready". */
  closed?: true;
}

export interface MilestoneTree {
  milestoneId: string;
  root: TreeNode;
  counts: Record<TreeColor, number>;
  /** open work only (finished epics below the root and their rows are not counted). */
  nonGreen: number;
  closed: number;
  flagged: number;
  /** finished epics below the root (folded, not counted); absent on older servers. */
  finished?: number;
  /** counted nodes in Planning (draft) / Parked (deferred); counts cover the spine's own rows only. */
  planning?: number;
  parked?: number;
  source: "spines" | "fallback";
  warnings: string[];
  /** the world's owner when it is not the owner (absent for the home world). */
  owner?: OwnerInfo;
}

// ---------- node view + Spines page ----------

/** A tree (or subtree, `?nodeKey=`) with the checkout it reads and which spine paths are tracked as milestones. */
export type NodeTree = MilestoneTree & {
  /** Checkout name under REPOS_ROOT (absent when the milestone's repo is not found). */
  repo?: string;
  remote?: string;
  /** Repo-relative spine path → id of the milestone tracking it. */
  tracked?: Record<string, string>;
};

/** One spine from `spines.py --json` (GET /api/repos/:name/spines). */
export interface SpineListItem {
  path: string;
  id: string;
  title: string;
  status: string;
  color: TreeColor;
  rollup: string;
  rollupColor: TreeColor;
  parent: string | null;
  depth: number;
  dod: { done: number; total: number };
  /** Open human asks (`waiting_on` entries not answered). */
  openAsks: number;
  milestoneId?: string;
  orphan?: string;
}

export interface SpineListing {
  repo: string;
  remote?: string;
  root: string | null;
  nodes: SpineListItem[];
  fetchedAt: string;
  /** The server is refreshing this repo in the background; read again shortly. */
  refreshing: boolean;
}

/** Ad hoc (untracked) spine: checkout name + repo-relative path. */
export interface SpineRef {
  repo: string;
  path: string;
  title?: string;
}

/** Hosts view (GET /api/hosts). */
export type HostState = "up" | "starting" | "off" | "unknown";
export type T3Reach = "reachable" | "unreachable" | "not_checked" | "not_configured" | "checking";
export interface HostWake {
  state: "idle" | "waking" | "ok" | "failed";
  startedAt?: string;
  finishedAt?: string;
  /** The exact failure reason when state is failed. */
  error?: string;
}
/** one live run on a host (the Hosts page unfolds "N agents running" into these). */
export interface RunningAgent {
  runId: string;
  persona: string;
  kind: "wake" | "worker";
  goal?: string;
  summary?: string;
  startedAt: string;
}
export interface HostView {
  id: HostId;
  state: HostState;
  t3: { state: T3Reach; detail?: string };
  /** Runs open in the console whose T3 thread was last read as live (wakes + child workers); `unconfirmed` = state unknown. */
  agents: { live: number; wakes: number; workers: number; unconfirmed: number; running?: RunningAgent[] };
  seats?: { name: string; capacity: number; available: number; inUse: number };
  /** the worker server: what `coding status` said (raw text kept) or why it could not be read. */
  coding?: {
    state: HostState;
    name?: string;
    type?: string;
    ipv4?: string;
    location?: string;
    uptime?: string;
    rawLine: string;
    raw: string;
    error?: string;
  };
  wake?: HostWake;
  canWake?: boolean;
  idleShutdown?: { afterMinutes: number; note: string };
  note?: string;
}
export interface HostsView {
  generatedAt: string;
  checkedAt?: string;
  stale: boolean;
  checking: boolean;
  hosts: HostView[];
  /** every cap on how many agents run, its value and today's reading; `limitNow` names the one that holds now. */
  caps?: HostCap[];
  limitNow?: string;
  /** each ticket or wake waiting for a slot, oldest first. */
  waiting?: SlotWait[];
}

export interface HostCap {
  id: string;
  name: string;
  limit: string;
  now?: string;
  state: "room" | "tight" | "full" | "unknown";
  why: string;
}

export interface SlotWait {
  kind: "wake" | "ticket";
  id: string;
  title: string;
  why: string;
  since?: string;
  nextTry?: string;
  repo?: string;
  /** in the console's work queue: it starts by itself when its limit clears. */
  queued?: boolean;
  /** waited over a day: named on top. */
  overDay?: boolean;
  days?: number;
  /** a card he sent back: its answer is his, the queue takes it first. */
  sentBack?: boolean;
  /** its place in the one queue order (1 = the next free slot is its), queued tickets only. */
  place?: number;
  /** why it sits there: urgent or his feedback, his objective order, or waited over a day. */
  tier?: "first" | "overDay" | "objective";
  /** his objective it moves (n 0 = his first): the queue goes in his objectives' order. */
  objective?: { n: number; name: string };
}

/** a standing approval of a milestone (spines.py `grants`), with the Decisions rows citing it. */
export type GrantState = "active" | "expired" | "revoked";
export interface GrantUse {
  path: string;
  /** 1-based line of the Decisions row. */
  line: number;
  date?: string;
  text: string;
}
export interface ApprovalGrant {
  code: string;
  who?: string | null;
  scope: string;
  limits?: string | null;
  expires?: string | null;
  context?: string | null;
  since?: string | null;
  state: GrantState;
  revoked?: string | null;
  why?: string | null;
  /** Repo-relative spine that holds the line (an ancestor when inherited). */
  source: string;
  inherited: boolean;
  uses: number;
  useRows: GrantUse[];
}
export interface ApprovalsView {
  path?: string;
  grants: ApprovalGrant[];
  nextCode?: string;
  note?: string;
}
export interface GrantInput {
  scope: string;
  limits?: string;
  /** YYYY-MM-DD or never; empty = never. */
  expires?: string;
  context?: string;
}
export interface GrantWriteResult {
  code: string;
  line: string;
  sha?: string;
  path: string;
  view: ApprovalsView;
  /** The Delivery Manager's wake (absent when none is switched on). */
  wake?: { runId: string } | { error: string };
}

// ----------: one server-computed status per milestone ----------

export type OutcomeWord = "not_yet" | "ready_to_mark" | "accomplished" | "partially" | "superseded" | "reopened";
export type FlowWord = "settled" | "paused" | "needs_you" | "planning" | "parked" | "working" | "monitoring" | "queued" | "stalled" | "nothing_to_do";
export type PendingKind = "ask" | "needs_jordi" | "answered" | "ready_to_mark" | "stalled" | "free_text_ask" | "failed_run" | "mark_ready" | "monitor_alert";
/** an ask a monitor alert names, resolved in its own repo / world (state missing = no ask has that code). */
export interface MonitorAlertAsk {
  code: string;
  repo: string;
  state: "open" | "answered" | "done" | "missing";
  snoozedUntil?: string;
  question?: string;
  milestoneId?: string;
  milestoneTitle?: string;
  /** Console link to its milestone's Waiting on you: relative, or absolute on another world's host. */
  href?: string;
  /** the ask's waiting item id in its own world, and that world. */
  id?: string;
  world?: string;
  /** an open ask's card fields: the alert shows the ask's own card (its buttons) inline. */
  card?: {
    ask: AskKind;
    question: string;
    path: string;
    line?: number;
    row?: string;
    options?: string[];
    recommendation?: string;
    contextText?: string;
    impact?: string;
    risk?: string;
    whyYou?: string;
    secret?: { app: string; name: string };
    since?: string;
  };
}

/**
 * One pending line: `open` waits on the owner (counted everywhere); `answered` = the owner replied, an agent has not acted yet;
 * `alarm` (Stalled) = orange, an action for the owner that is not an ask, never red, not in needsYou.
 */
export interface PendingItem {
  id: string;
  kind: PendingKind;
  /** snoozed = a monitor alert whose every unblocking ask the owner snoozed (one quiet line, never counted). */
  state: "open" | "answered" | "alarm" | "snoozed";
  milestoneId: string;
  /** a snoozed monitor alert: when the first of its asks' snoozes ends (counted again from then). */
  snoozedUntil?: string;
  /** GET /status only: rank of the best milestone listing it (1 = top of the sidebar); items come sorted by it. */
  priority?: number;
  /** the owner's level from the Prioritizer, with the why quoting him. */
  ownerPriority?: OwnerPriority;
  title: string;
  ask?: AskKind;
  code?: string;
  repo?: string;
  nodeKey?: string;
  /** rows that wait on this ask (red ring in the tree, never counted). */
  refNodes?: string[];
  since?: string;
  persona?: string;
  /** mark_ready and the retired free_text_ask (since never sent: a defect instead): the spine line, its link and the raw line. */
  path?: string;
  line?: number;
  url?: string;
  detail?: string;
  /** stalled: switched-off personas that could take the ready steps, first = suggested. */
  switchOn?: { assignmentId: string; persona: string }[];
  /** monitor_alert: a `Monitoring:` item naming a stop / outage or a day overdue; the asks it names; what happens next. */
  monitor?: { why: ("stop" | "overdue")[]; since?: string; nextCheckAt?: string; nextCheck?: string; overdueMs?: number; asks: MonitorAlertAsk[]; next: string };
}

/** GET /api/milestones/:id/status: the two marks (outcome, flow) and the pending items, computed by the server. */
/** one header note about the last ended wake of an assignment. */
export interface WakeNote {
  kind: "ready_ignored" | "repeating";
  persona: string;
  runId: string;
  text: string;
  steps?: string[];
  n?: number;
  since?: string;
}

export interface MilestoneStatusView {
  milestoneId: string;
  outcome: { word: OutcomeWord; source: "outcome" | "derived"; note?: string; open?: number };
  flow: {
    word: FlowWord;
    reason: string;
    until?: string;
    nextWakeAt?: string;
    personas?: string[];
    run?: { id: string; assignmentId: string; startedAt: string; parentRunId?: string; summary: string; wake?: number };
    /** working: runs T3 confirms live now (same rule as Activity's "N workers running"); > 0 = green pulsing dot. */
    live?: number;
    monitoring?: MonitorItem[];
  };
  items: PendingItem[];
  /** the last wake of an assignment ignored ready steps, or repeats the same report (header lines, never pending). */
  wakeNotes?: WakeNote[];
  /** Open items for the owner: the one number every badge shows. Null while `loading` (no badge, never a low number). */
  needsYou: number | null;
  /** its spines were not read yet (a console just restarted): no items, no number; the web draws a loading mark. */
  loading?: boolean;
  /** when the server's stored view was last known current (the read model); absent on a per-request answer. */
  asOf?: string;
  /** how far the goal is (share of the tree done, each level-1 branch weighing the same); root's painted color. */
  progress?: { pct: number; done: number; total: number; color: TreeColor };
  /** codes in the spines that name no ask: a defect for the Delivery Manager, never counted. */
  defects?: { kind?: "ref" | "free_text"; milestoneId: string; repo: string; code?: string; path: string; line: number; nodeKey?: string; url?: string; text: string; note?: string }[];
  reasons: string[];
}

/** the owner's Outcome mark (POST /api/milestones/:id/mark). */
export type MarkVerdict = "accomplished" | "partially" | "not_accomplished" | "superseded";
export interface MarkInput {
  verdict: MarkVerdict;
  sentence: string;
  risk?: string;
  note?: string;
  evidence: { doneMeans: string; evidence: string }[];
}
export interface MarkResult {
  verdict: MarkVerdict;
  path: string;
  sha?: string;
  /** the mark settled the milestone (Accomplished, Partially, Superseded). */
  settled?: boolean;
  status: MilestoneStatusView;
}

/** the owner stamps a Planning epic ready (or moves it back): POST /api/milestones/:id/stamp. */
export type StampTo = "ready" | "draft";
export interface StampResult {
  to: StampTo;
  path: string;
  sha?: string;
}
/** POST /api/runs/:id/stop. `workersRunning` = child runs left running (Stop without "and its workers"). */
export interface StopResult {
  run: Run;
  workers: Run[];
  workersRunning: number;
  workerErrors: { runId: string; error: string }[];
}
/**
 * Add on a tree node (POST /api/milestones/:id/tree/add). the owner's own Add is ready by default (a
 * Done-means line also gets a ready row; the Delivery manager is woken); `draft: true` = "Just register it".
 */
export type AddKind = "row" | "done_means" | "epic";
export interface AddInput {
  kind: AddKind;
  title: string;
  line?: string;
  /** Spine the item goes under (default: the milestone's own). */
  path?: string;
  /** "Just register it (draft)". */
  draft?: boolean;
}
export interface AddResult {
  kind: AddKind;
  path: string;
  /** The new row / Done-means id. */
  id?: string;
  /** A child epic's new spine file. */
  newPath?: string;
  sha?: string;
  /** written ready (the owner's ask), else a draft and why. */
  ready?: boolean;
  draftWhy?: string;
  /** the ready row a new Done-means line got. */
  rowId?: string;
  /** the Delivery manager wake a ready Add started (or why not). */
  wake?: { runId: string } | { error: string };
}
/** GET /api/asked-no-row: an open Done-means line in a runnable epic that no ledger row covers. */
export interface AskedNoRowItem {
  milestoneId: string;
  milestoneTitle: string;
  path: string;
  spineTitle: string;
  id: string;
  text: string;
}
/** GET /api/orphan-commits: a commit on a tracked repo's main that names no ticket (row code or spine path). */
export interface OrphanCommitItem {
  milestoneId: string;
  milestoneTitle: string;
  repo: string;
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}
/** one line of "Next wake picks up" (GET /api/next-wake): a ready epic or row the next standing wake starts. */
export interface NextWakeItem {
  milestoneId: string;
  milestoneTitle: string;
  kind: "epic" | "row";
  id: string;
  title: string;
  nodeKey: string;
  path?: string;
  persona: string;
  at: string;
}

/** one epic of the Team page's "Moving now" strip (GET /api/moving-now). */
export interface MovingEpic {
  milestoneId: string;
  repo: string;
  path: string;
  title: string;
  status: string;
  /** Running child runs whose row is in this epic. */
  workers: { ticket: string; runId: string; persona: string }[];
  /** Last commit on the epic's spine. */
  lastCommitAt?: string;
  /** Rows that read done now and did not at UTC midnight. */
  doneToday: string[];
  /** Unclaimed ready rows. */
  ready: string[];
  rows: string[];
}

/** GET /api/status: every unsettled milestone; `needsYou` counts unique open items (the Team badge). */
export interface StatusBatch {
  milestones: MilestoneStatusView[];
  items: PendingItem[];
  /** null while any milestone is `loading`. */
  needsYou: number | null;
  loading?: boolean;
  at: string;
  /** when the server's stored view was last known current (the read model). */
  asOf?: string;
}

/** source freshness of one repo checkout on the main server (GET /api/milestones/:id/freshness, /api/freshness). */
export interface RepoFreshness {
  repo: string;
  sha?: string;
  /** Last time the checkout heard from GitHub (any fetch/pull: 15-min sync, run-end, on open, poll, Refresh). */
  syncedAt?: string;
  /** Commits on origin/main not in the checkout, as of the last fetch. */
  behind?: number;
  ahead?: number;
  /** Last pull failed, or the tree is dirty/diverged (never forced). */
  error?: string;
  pulling?: boolean;
}

/** Item 7: the spine's Current State (prose) vs its children's newest commit. */
export interface NarrativeAge {
  verifiedAt?: string;
  childCommitAt?: string;
  behindMinutes?: number;
  behindHours?: number;
}

export interface MilestoneFreshness extends RepoFreshness {
  repos: RepoFreshness[];
  narrative?: NarrativeAge;
}

/** POST /api/milestones/:id/refresh (429 + rateLimited when refreshed < 5 s ago). */
export interface RefreshResult extends RepoFreshness {
  pulled: boolean;
  rateLimited?: boolean;
}

export interface FreshnessSummary {
  repos: RepoFreshness[];
  oldestSyncedAt?: string;
}

/** the Team desk chat, a view on one T3 thread (the console keeps no transcript). */
export interface DeskMessage {
  id: string;
  role: "user" | "assistant";
  /** `seed` = a session's launch message: shown as a divider, never as text. */
  kind: "message" | "seed";
  text: string;
  /** The page the owner sent it from. */
  page?: string;
  /** what the console told the milestone chat had changed since his previous message (shown folded). */
  since?: string;
  status: string;
  at?: string;
  /** Seed only: which session this starts (more than 1 = the earlier thread was gone). */
  session?: number;
  /** seed only: why this session followed an earlier one ("New session: the desk moved from the main server to the worker server. …"). */
  note?: string;
  truncated?: boolean;
  /** the item's position in the T3 thread (`before` of the next older page); negative = an earlier session's. */
  position?: number;
  /** his message's request id (every request lands on exactly one ticket row). */
  request?: string;
  /** the ticket rows that hold that request id now: [] = on none yet; unset = not read yet. */
  rows?: { code: string; repo: string; path: string; status?: string; title?: string }[];
}
/** what a chat read asks for: the newest `limit` messages, or (with `before`) the page older than that position. */
export interface ChatRead {
  limit?: number;
  before?: number;
}
/** a file uploaded for a chat message (POST /api/chat/attachments); `path` serves it to the world's signed-in users. */
export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  createdAt: string;
  path: string;
}

export interface DeskChat {
  available: boolean;
  reason?: string;
  threadId?: string;
  environmentId?: string;
  session?: number;
  status?: string;
  /** The desk is mid-turn. */
  working: boolean;
  /** when the current turn started (server time from T3), for the working line's timer. */
  workingSince?: string;
  /** Messages T3 has not accepted yet (a busy thread retries for minutes). */
  sending: number;
  /** `clientRequestId` names the message that failed after its request answered. */
  sendError?: { text: string; at: string; clientRequestId?: string };
  messages: DeskMessage[];
  hasEarlier: boolean;
  /** T3 is down (`maintenance` = stopped on purpose): the messages are the last good read; one quiet line says so. */
  t3?: "restarting" | "maintenance";
  /** a customer's workspace: the page shows no way into our T3 (no Open in T3). */
  customer?: boolean;
  /** this chat runs on the workspace's own server and AI (its Call uses the browser's own speech). */
  ownServer?: boolean;
  /** the owner's sends stored while T3 was down, oldest first; the console delivers them once T3 is back. */
  queued?: { id: string; text: string; page?: string; at: string }[];
  /** his voice notes shown sent but not in this chat yet (the console re-sends each minute; `failed`: tries used up). */
  undeliveredNotes?: { id: string; at: string; text: string; state: "retrying" | "failed"; error?: string }[];
  /** T3 was slow, so this is the console's last good read; a fresh one is under way (the page polls again soon). */
  stale?: boolean;
  /** the host whose T3 runs the desk's thread. */
  host?: string;
  /** that host's T3 cannot be reached now: the messages are the last good read, the chat says so and keeps retrying. */
  unreachable?: string;
  /** an older page only: T3 was slow, the console reads on, ask again in a moment (the chat retries by itself). */
  loading?: boolean;
}

/** a ticket's own T3 session (POST /api/tickets/session, GET /api/tickets/sessions): one thread per ledger row, run by its assignee persona in chat mode. */
export interface TicketSession {
  milestoneId: string;
  rowId: string;
  title?: string;
  /** Repo-relative spine whose ledger holds the row. */
  path: string;
  threadId: string;
  environmentId?: string;
  /** t3code:// link when the environment is known. */
  link: string | null;
  persona: { id: string; name: string };
  /** The row names no persona: the epic's Delivery manager holds it. */
  fellBack: boolean;
  /** POST only: this call launched the thread (false = the stored one was reused). */
  launched: boolean;
}

/**
 * one world. the home world = today's team. Served by GET /api/tenants and
 * GET /api/tenants/:id (read-only; scoped to the session's world from S3). Skin `console` = today's look, `social` =.
 */
/** the human who owns a world: `handle` is what spines say (`@Ana`), `name` what the UI shows. the owner in the home world. */
export interface OwnerInfo {
  handle: string;
  name: string;
}

export interface Tenant {
  id: string;
  name: string;
  skin: "console" | "social" | (string & {});
  /** Credits plan; `internal` = metered, never held. */
  plan: string;
  ownerHandle: string;
  ownerName: string;
  reposRoot?: string;
  secretsBackend: string;
  boxProvider?: string;
  paused: boolean;
  createdAt: string;
}

/** `GET /api/providers?world=W`: a provider class this world may use (shared ones have world null). */
export interface ProviderClass {
  id: string;
  kind: "seat" | "api" | "openrouter" | "opencode" | "codex" | (string & {});
  world: string | null;
  priceKey: string;
  notional: boolean;
  /** T3 instances of a non-seat class (seats come from the seat pool). */
  instances: string[];
}
export interface ProvidersResponse {
  world: string;
  classes: ProviderClass[];
  prices: { priceKey: string; notional: boolean; models: string[] }[];
}
/** `GET|PUT /api/tenants/:id/provider`: the world default (null = seat pool / each persona's model). */
export interface TenantProviderSetting {
  tenantId: string;
  defaultProvider: string | null;
  defaultModel: string | null;
}
/** `GET|PUT /api/personas/:id/provider` (PUT body `{provider: string | null, model?: string}`). */
export interface PersonaProviderSetting {
  personaId: string;
  world: string;
  /** null = the world default. */
  provider: string | null;
  model: string;
  /** what a wake asks the dispatcher for: override > world default > claude-seat. */
  effective: { provider: string; model: string };
}
/** `GET /api/providers/price?priceKey=K&model=M`: USD per million tokens. */
export interface ProviderPriceInfo {
  model: string;
  priceKey: string;
  notional: boolean;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * the social pack export (epicspine-skill `pack.py social --json`, schemaVersion 1), served by
 * GET /api/tenants/:id/social as `SocialData`: the social screens' one typed source (it replaced's posts-ledger
 * rows). Same shapes as hosted/console/server/src/social/types.ts (Post/Topic/Idea/Asset/Report are prefixed Social here).
 * Writes come in (rows carry `_line`; `sources` says where each section lives).
 */
export const SOCIAL_SCHEMA_VERSION = 1;

export type Weight = "over" | "normal" | "under" | "avoid";
/** posts.rows.status lifecycle (schema `lifecycles.post`). */
export const POST_STATES = ["idea", "draft", "scheduled", "posted", "measured", "held", "pulled", "expired"] as const;
export type PostState = (typeof POST_STATES)[number];
/** ideas.rows.state lifecycle (schema `lifecycles.idea`). */
/** ideas never expire, `new → open → spent`; picked up / drafted / posted are legacy, read as open. */
export const IDEA_STATES = ["new", "open", "spent", "picked up", "drafted", "posted", "parked", "epic"] as const;
export type IdeaState = (typeof IDEA_STATES)[number];

export interface PackWarning {
  /** Repo-relative file (or `pack.py` when the export itself failed). */
  file: string;
  /** 1-based line, null for a whole file or section. */
  line: number | null;
  message: string;
}

interface PackRow {
  _line: number;
}

export interface KeyMessage extends PackRow {
  id: string | null;
  message: string | null;
  weight: Weight | string | null;
  source: string | null;
  carried_by: string[];
}
export interface TopicWeight extends PackRow {
  topic: string | null;
  weight: Weight | string | null;
  why: string | null;
  source: string | null;
  since: string | null;
}
export interface FeedbackLogRow extends PackRow {
  date: string | null;
  from: string | null;
  feedback: string | null;
  landed: string | null;
  applied_by: string | null;
}
export interface FormatShare extends PackRow {
  /** text | thread | diagram | screenshot | demo clip | video */
  format: string | null;
  /** Percent as a number (40% → 40). */
  share: number | null;
  example: string | null;
}
export interface ExampleRow extends PackRow {
  link: string | null;
  verdict: "like" | "dislike" | string | null;
  why: string | null;
}
export interface HoldRule extends PackRow {
  id: string | null;
  match: string | null;
  why: string | null;
}

export interface SocialBrief {
  objective: string | null;
  targets: string | null;
  audience: string | null;
  key_messages: KeyMessage[];
  voice: string[];
  style_rules: string[];
  never_say: string[];
  topic_weights: TopicWeight[];
  feedback_log: FeedbackLogRow[];
  formats: FormatShare[];
  examples: ExampleRow[];
  hold_rules: HoldRule[];
}

export interface WeekHighlight extends PackRow {
  id: string | null;
  highlight: string | null;
  why: string | null;
  until: string | null;
  served_by: string[];
}
export interface DoDont extends PackRow {
  kind: "do" | "don't" | string | null;
  rule: string | null;
  until: string | null;
}
export interface MonthPriority extends PackRow {
  id: string | null;
  priority: string | null;
  why: string | null;
  month: string | null;
  served_by: string[];
}
export interface SocialDirections {
  week: WeekHighlight[];
  do_dont: DoDont[];
  voice_note: string | null;
  month: MonthPriority[];
}

export interface SocialTopic extends PackRow {
  rank: number | null;
  id: string | null;
  topic: string | null;
  where: string | null;
  link: string | null;
  heat: number | null;
  date: string | null;
  reply_target: boolean | null;
  used_by: string[];
}

export interface SocialIdea extends PackRow {
  id: string | null;
  date: string | null;
  idea: string | null;
  format: string | null;
  platform: string | null;
  from: string | null;
  link: string | null;
  state: IdeaState | string | null;
  why: string | null;
  became: string[];
  /** its posts by platform (`{"Reddit": ["P-0060"]}`); absent from an older export. */
  used_on?: Record<string, string[]>;
}

/** one line of `data/insights.md` › Insights (the Reporter's weekly pass; server social/types.ts InsightLine). */
export interface SocialInsight extends PackRow {
  id: string | null;
  insight: string | null;
  use: string | null;
  evidence: string | null;
  confidence: string | null;
  campaign?: string | null;
  since: string | null;
  /** active | retired */
  state: string | null;
}
/** a proposed My calls line (`data/insights.md` › Proposed calls). */
export interface SocialProposedCall extends PackRow {
  id: string | null;
  call: string | null;
  evidence: string | null;
  campaign?: string | null;
  since: string | null;
  state: string | null;
}
/** one kept hot thread (`data/threads.md`; server social/types.ts ThreadRow). */
export interface SocialThread extends PackRow {
  id: string | null;
  found: string | null;
  platform: string | null;
  community: string | null;
  title: string | null;
  link: string | null;
  why: string | null;
  numbers: string | null;
  visibility: number | null;
  campaign?: string | null;
  reply: string | null;
  state: string | null;
}

export interface SocialPost extends PackRow {
  id: string | null;
  date: string | null;
  persona: string | null;
  /** post | reply | outreach */
  kind: "post" | "reply" | "outreach" | string | null;
  platform: string | null;
  /** the campaign it counts toward (epic code); null/absent = the repo itself. */
  campaign?: string | null;
  community: string | null;
  slot: string | null;
  title: string | null;
  text: string | null;
  format: string | null;
  assets: string[];
  topic: string | null;
  highlight: string | null;
  messages: string[];
  idea: string | null;
  checks: string | null;
  link: string | null;
  replies: number | null;
  metrics: string | null;
  result: string | null;
  feedback: string | null;
  status: PostState | string | null;
  /** a held post whose slot has passed: Schedule gives it this next free slot (`YYYY-MM-DDTHH:MMZ`, the server's). */
  nextSlot?: string;
}

export interface SocialAsset extends PackRow {
  id: string | null;
  kind: "diagram" | "screenshot" | "clip" | "video" | "logo" | string | null;
  file: string | null;
  made_by: string | null;
  source: string | null;
  cuts: string | null;
  used_by: string[];
}

/** One `data/reports/{date}.md` (oldest first). */
export interface SocialReport {
  date: string;
  path: string;
  numbers: string | null;
  best_worst: string | null;
  learned: string | null;
  highlights: string | null;
  feedback: string | null;
  cost: string | null;
}

/** Where each non-`many` section lives (`"brief.objective"`, `"posts.rows"`, …): what the write API saves. */
export interface SectionSource {
  path: string;
  heading: string | null;
  exists: boolean;
}

/** The whole `pack.py social --json` document. */
export interface SocialExport {
  schemaVersion: number;
  pack: "social" | string;
  packVersion: number;
  /** Absolute checkout path the export read. */
  repo: string;
  /** UTC, YYYY-MM-DDTHH:MM:SSZ. */
  generatedAt: string;
  warnings: PackWarning[];
  brief: SocialBrief;
  directions: SocialDirections;
  topics: SocialTopic[];
  ideas: SocialIdea[];
  posts: SocialPost[];
  /** the messages ledger (DMs); empty when the repo has none or the host's skill exports none. */
  messages?: { chats: SocialChat[]; messages: SocialMessage[] };
  /** `data/insights.md`; absent from an older export (the server then reads the file). */
  insights?: { lines: SocialInsight[]; calls: SocialProposedCall[] };
  /** `data/threads.md`; absent from an older export. */
  threads?: SocialThread[];
  assets: SocialAsset[];
  reports: SocialReport[];
  sources: Record<string, SectionSource>;
}

/** one conversation of `data/messages-ledger.md` › Chats (server social/types.ts ChatRow). */
export interface SocialChat {
  _line: number;
  id: string | null;
  platform: string | null;
  /** Ours: the reddit and X handles we post with. */
  account: string | null;
  /** The other person. */
  who: string | null;
  /** dm | chat request | pm */
  kind: string | null;
  link: string | null;
  campaign?: string | null;
  started: string | null;
  /** open | waiting | left | hidden | done */
  state: string | null;
  reason: string | null;
  feedback: string | null;
  messages: string[];
}
/** one message in or out (server social/types.ts MessageRow). */
export interface SocialMessage {
  _line: number;
  id: string | null;
  chat: string | null;
  at: string | null;
  /** them | us */
  from: string | null;
  persona: string | null;
  text: string | null;
  answers: string | null;
  checks: string | null;
  feedback: string | null;
  result: string | null;
  /** received; ours draft → scheduled → posted, pulled, expired */
  status: string | null;
}
/** where a chat stands for the owner (server social/messages.ts ChatStatus). */
export type ChatStatus = "reply" | "drafting" | "left" | "hidden" | "sending" | "waiting" | "done";
export interface ChatView {
  repo: string;
  chat: SocialChat;
  messages: SocialMessage[];
  status: ChatStatus;
  group: "you" | "them" | "done";
  theirs: SocialMessage | null;
  /** The reply waiting for his Send (draft), or the one being sent (scheduled). */
  draft: SocialMessage | null;
  lastOurs: SocialMessage | null;
  at: string;
}
/** GET /api/tenants/:id/social/messages. */
export interface MessagesView {
  tenantId: string;
  repos: { repo: string; warnings: PackWarning[] }[];
  chats: ChatView[];
  /** waiting = chats that need the owner (a reply to send, left by rule, a hidden request): the menu pill. */
  counts: { you: number; them: number; done: number; waiting: number };
}
/** GET /api/tenants/:id/social/chats/:chat/history. */
export interface ChatHistoryEntry {
  commit: string;
  at: string;
  who: string;
  subject: string;
  changes: string[];
  /** Texts of ours this commit wrote (a new message or version): message id → text. */
  texts: Record<string, string>;
}
export interface ChatHistory {
  tenantId: string;
  repo: string;
  id: string;
  entries: ChatHistoryEntry[];
  warning?: string;
}

/** a campaign's one-pager parts (server social/campaignPlan.ts ONE_PAGER_PARTS), by part name. */
export const ONE_PAGER_PARTS = ["Why this campaign", "The bet", "What we measure", "What we hope", "My calls", "Not doing", "Approval"] as const;
export type OnePagerPart = (typeof ONE_PAGER_PARTS)[number];
export type OnePagerFields = Partial<Record<OnePagerPart, string>>;
/** The API's keys for the parts, in part order. */
export const ONE_PAGER_KEYS = { why: "Why this campaign", bet: "The bet", measure: "What we measure", hope: "What we hope", calls: "My calls", notDoing: "Not doing", approval: "Approval" } as const;
export type OnePagerKey = keyof typeof ONE_PAGER_KEYS;
/** the owner's one-pager (`owner`: his lines) and a draft an agent holds for him (never his decision). */
export interface OnePager {
  state: "empty" | "owner";
  line: string | null;
  fields: OnePagerFields;
  draft: { row: string | null; note: string; fields: OnePagerFields } | null;
  /** folded into the campaign's product deck (its Product tab). */
  moved?: boolean;
}

/**
 * GET /api/tenants/:id/social[?repo=<name>]: the world's social data. `repo` = the world's repo it came from (null =
 * none of the world's repos is a social one; `data` is then an empty export). `data` is always a full export shape:
 * export failures, timeouts and bad output arrive as `data.warnings`, never as a 500.
 */
export interface SocialData {
  tenantId: string;
  repo: string | null;
  data: SocialExport;
  /** `?campaign=`: the campaign the posts are narrowed to, with its plan (Markdown, the spine's `## Campaign plan`). */
  campaign?: { code: string; name: string; path: string; platform: string | null; period: string | null; plan: string; onePager?: OnePager };
  /** Mock client only (local dev, tests): the data is lib/social.ts's sample, and the screens say so. The server never sets it. */
  sample?: true;
}

/**
 * GET /api/tenants/:id/social/metrics[?repo=]: the live numbers of the campaign's posted X posts, read now from the
 * X API (public metrics, cached a few minutes). Reddit is not readable from the console host (Reddit refuses it), so its
 * numbers come only from the ledger's Metrics cell (the Reporter). `missing` says why a live post has no live read.
 */
export interface SocialLiveNumbers {
  impressions: number;
  likes: number;
  reposts: number;
  replies: number;
  quotes?: number;
  bookmarks?: number;
}
/**
 * GET /api/tenants/:id/social/kpis[?repo=]: the performance view at the top of the social product Home. Per platform,
 * five daily series (posts, replies sent, replies received, followers, impressions) and the best post, with the rule.
 * Shapes and the computation are the server's (server/src/social/kpisCompute.ts; the mock runs the same code).
 */
export type { SocialKpisBody, PlatformKpis, KpiSeries, KpiPoint, BestPost, SeriesKey, KpiPlatform } from "../../../server/src/social/kpisCompute";
/** GET /api/tenants/:id/site-kpis: page views, new users registered, code page views (server/src/siteKpisCompute.ts). */
export type { SiteCount, SiteKpisBody, SiteSeries, SiteSeriesKey, SiteWhere } from "../../../server/src/siteKpisCompute";
/** GET /api/tenants/:id/social/launch: the launch block of the Performance page (server/src/social/launchCompute.ts). */
export type { LaunchBody, LaunchChannel, LaunchKeyResult, LaunchState } from "../../../server/src/social/launchCompute";
// the product deck, the metrics catalog with each campaign's target, and one slide per role.
export type { MotionBody, CatalogRow, TargetView, PersonaSlide, ProductSlide, MetricId } from "../../../server/src/social/motionCompute";

export interface SocialMetrics {
  tenantId: string;
  repo: string | null;
  /** When the platform was read (ISO), null when nothing was read. */
  readAt: string | null;
  posts: Record<string, SocialLiveNumbers>;
  missing: { id: string; why: string }[];
}

/**
 * POST /api/tenants/:id/social/<action>[?repo=] (server social/write.ts). Each write commits to the campaign repo
 * as the owner (pack-validated) and answers with the fresh export plus what it wrote. Errors: 400 bad body, 404 unknown
 * world/repo/row, 409 a persona is editing that file (retry), 422 the pack refuses it (`error.issues`), 503 no pack skill.
 */
export type SocialWriteAction =
  | { action: "brief"; body: SocialBriefInput }
  | { action: "directions"; body: SocialDirectionsInput }
  | { action: "ideas"; body: { idea: string; format?: string | null; platform?: string | null; link?: string | null } }
  | { action: `ideas/${string}/drop`; body?: undefined }
  | { action: `ideas/${string}`; body: { idea?: string; format?: string | null; platform?: string | null; link?: string | null } }
  | { action: `posts/${string}/feedback`; body: { feedback: string } }
  | { action: `posts/${string}/text`; body: { text: string } }
  | { action: `posts/${string}/${"pull" | "release" | "drop" | "restore"}`; body?: undefined }
  /** a new version for the owner's review; the post stays held, the Writer redrafts it. */
  | { action: `posts/${string}/revise`; body: { feedback: string } }
  /** approve a held post; with feedback it stays held and the Writer applies it, then schedules it. */
  | { action: `posts/${string}/approve`; body: { feedback?: string; slot?: string } }
  /** Post now (a scheduled post goes out at once) and Give feedback on an idea. */
  | { action: `posts/${string}/post-now`; body?: undefined }
  | { action: `ideas/${string}/feedback`; body: { feedback: string } }
  /** the owner approves every post of this campaign (the hold rule `Kind: post`), or not. */
  | { action: "approval"; body: { on: boolean; campaign?: string | null } }
  /** take back a Style rule made from repeated feedback. */
  | { action: `style-rules/${string}/undo`; body?: undefined }
  /** a DM reply: Send, Don't send, Undo (restore); Change it (revise); Rewrite it myself (text). */
  | { action: `messages/${string}/${"send" | "drop" | "restore"}`; body?: undefined }
  | { action: `messages/${string}/revise`; body: { feedback: string } }
  | { action: `messages/${string}/text`; body: { text: string } }
  /** a chat: Draft a reply for me, Accept and draft a reply, Done, no reply needed, and their Undos. */
  | { action: `chats/${string}/${"draft" | "accept" | "done" | "reopen" | "undo"}`; body?: undefined };

/** Brief save: each given section is replaced whole; omitted ones stay. Ids left out are filled (1.., R1..). */
export interface SocialBriefInput {
  objective?: string;
  targets?: string;
  audience?: string;
  voice?: string[];
  style_rules?: string[];
  never_say?: string[];
  key_messages?: { id?: string | number | null; message: string; weight?: "over" | "normal" | "under" | "avoid" | null; source?: string | null }[];
  topic_weights?: { topic: string; weight: "over" | "normal" | "under" | "avoid"; why?: string | null; source?: string | null; since?: string | null }[];
  formats?: { format: string; share: number; example?: string | null }[];
  examples?: { link: string; verdict: "like" | "dislike"; why?: string | null }[];
  hold_rules?: { id?: string | null; match: string; why?: string | null }[];
  /** The repo's console assignments of that persona (by name) get this cadence. */
  cadence?: { persona: string; cadence: Cadence }[];
}

/** POST /api/tenants/:id/social/assets (multipart): the file → data/assets/A-<n>-<name> + a data/assets.md row. */
export interface SocialAssetUpload {
  file: File;
  /** Else from the file type (svg → diagram, video → clip, image → screenshot). */
  kind?: "diagram" | "screenshot" | "clip" | "video" | "logo";
  source?: string;
  cuts?: string;
}

export interface SocialDirectionsInput {
  week?: { id?: string | null; highlight: string; why?: string | null; until?: string | null }[];
  do_dont?: { kind: "do" | "don't"; rule: string; until?: string | null }[];
  voice_note?: string;
  month?: { id?: string | null; priority: string; why?: string | null; month?: string | null }[];
}

/** one change to a post's ledger row (server social/history.ts): who, when, what changed, the row then. */
export interface PostHistoryEntry {
  commit: string;
  at: string;
  who: string;
  subject: string;
  changes: string[];
  /** The text version this commit left (1 = first), when the text changed. */
  version?: number;
  row: { status: string; title: string; text: string; slot: string; feedback: string; checks: string; link: string };
}
export interface PostHistory {
  tenantId: string;
  repo: string;
  id: string;
  entries: PostHistoryEntry[];
  warning?: string;
}

export interface SocialWriteResult extends SocialData {
  action: string;
  /** Row or sections written: `I-4`, `P-0003`, `objective,voice`. */
  id: string;
  /** The commit (after a rebase, the rebased one); null = nothing changed. */
  commit: string | null;
  push: { state: "pushed" | "rebased" | "no-remote" | "skipped" | "failed"; detail?: string };
  files: string[];
  cadence?: { assignmentId: string; persona: string; cadence: Cadence }[];
  /** A pulled live post: the Publisher Run now (C5); approve: the Publisher (slot due) or the Writer (with feedback);
   *  revise: the Writer. Or why it was not woken. */
  wake?: { assignmentId: string; runId: string; role?: "Publisher" | "Writer" | "Scout" | "Responder" } | { error: string };
  /** Per action: idea add `{id}`; pull/release/drop `{was, status, effect}`; idea drop `{was}`. */
  info?: Record<string, unknown>;
}


/** a Style rule made from the same feedback twice: `<text> [C6 S1: feedback F1, F3 on P-0138, P-0143]`. */
export interface C6StyleRule {
  id: string;
  text: string;
  /** Feedback ids (`F3` = the 3rd row of the Feedback log). */
  feedback: string[];
  posts: string[];
}

export interface DigestPost {
  id: string;
  kind: string | null;
  platform: string | null;
  community: string | null;
  title: string | null;
  link: string | null;
  replies: number | null;
  metrics: string | null;
  result: string | null;
  feedback: string | null;
  status: string | null;
}

/** GET /api/tenants/:id/social/digest[?date=YYYY-MM-DD][&repo=] (server social/digest.ts): one day of the campaign. */
export interface SocialDigest {
  date: string;
  counts: { posts: number; replies: number; outreach: number; held: number; pulled: number; feedback: number; ideas: number; styleRules: number };
  posts: DigestPost[];
  replies: DigestPost[];
  held: DigestPost[];
  pulled: DigestPost[];
  ideas: { id: string | null; idea: string | null; state: string | null; from: string | null; became: string[] }[];
  feedback: { date: string | null; from: string | null; feedback: string | null; landed: string | null }[];
  /** C6 rules, each undone with `style-rules/<id>/undo`; `new` = made from a note of that day. */
  styleRules: (C6StyleRule & { new: boolean })[];
  report: SocialReport | null;
}
export interface SocialDigestView {
  tenantId: string;
  repo: string;
  /** The console page (social host when set) the owner's message links to. */
  page: string;
  /** The Reporter's file on GitHub, when written. */
  reportUrl: string | null;
  /** The day's message to the owner: sent at, or why it failed; null = not sent yet. */
  sent: { at: string | null; error: string | null } | null;
  digest: SocialDigest;
  warnings: PackWarning[];
}

/**
 * credits per world.
 * 1 credit = €0.01 of measured cost (provider price; seat runs notional at API list price). Stored server-side as
 * integer millicredits; `credits` fields are mc / 1000 rounded to 2 decimals.
 */
export type CreditLedgerKind = "grant" | "topup" | "debit" | "expire" | "adjust";
export interface CreditLedgerEntry {
  id: string;
  tenantId: string;
  at: string;
  kind: CreditLedgerKind;
  /** Signed: grants and top-ups positive, debits and expiries negative. */
  millicredits: number;
  credits: number;
  /** Debits: the run charged (one debit per run, ever). */
  runId?: string;
  priceKey?: string;
  model?: string;
  /** Debits: true = a seat run at API list price (not a bill). */
  notional?: boolean;
  usd?: number;
  note: string;
  actor: string;
}
export interface CreditBurnDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  credits: number;
  notionalCredits: number;
}
/** GET /api/tenants/:id/credits (world-scoped: another world's id is a 404). */
/** GET /api/tenants/:id/plan: may this world buy the paid plan from the console, and has it paid. */
export interface PlanState {
  tenantId: string;
  plan: string;
  canBuy: boolean;
  paid: boolean;
  awaiting: boolean;
  price: { name: string; eurPerMonth: number };
  /** the seat bundles on sale (2, 5, 16 seats); older consoles leave it out */
  bundles?: { seats: number; eurPerMonth: number }[];
  /** the seats the world's plan includes now */
  seats?: number;
  subscription?: { status: string; since: string; testMode: boolean };
}

export interface Credits {
  tenantId: string;
  plan: string;
  /** the home world / `internal` / own-key `team`: metered, never held. */
  unlimited: boolean;
  /** a paying plan's price and whose AI it runs on (`team`: Epic Team, €49 a month, the customer's own key). */
  terms?: { name: string; eurPerMonth: number; ai: "own-key" };
  /** The per-world gate (default off). */
  gate: boolean;
  /** Can dip below zero: runs already in flight finish. */
  balance: number;
  balanceMc: number;
  /** Credits the plan grants each month. */
  monthlyGrant: number;
  nextGrantAt?: string;
  lastGrantAt?: string;
  /** Gate on, not unlimited, balance ≤ 0: new wakes are held until a top-up or the grant. */
  held: boolean;
  /** Runs started before this are never charged. */
  since: string;
  /** Last 30 days, oldest first. */
  burn: CreditBurnDay[];
  /** Newest first. */
  ledger: CreditLedgerEntry[];
}
/** POST /api/tenants/:id/credits/grant (platform only: we top up by hand; no payment provider). */
export interface CreditGrantInput {
  credits: number;
  /** default topup; `grant` also starts the monthly plan grant on that day. */
  kind?: "topup" | "grant" | "adjust";
  note?: string;
}
export interface CreditsReleased {
  tenantId: string;
  woken: { assignmentId: string; runId: string }[];
  skipped: { assignmentId: string; runId: string; reason: string }[];
  noticeRetired?: string;
}
export interface CreditGrantResult {
  entry: CreditLedgerEntry;
  credits: Credits;
  released?: CreditsReleased;
}

/** `CONSOLE_AUTH` on the server. off = today (no login), shadow = logged only, on = enforced. */
export type AuthMode = "off" | "shadow" | "on";

/** who the console thinks is calling. `legacy` = a tailnet/loopback caller with no login, served as the home world (today's trust). */
export type MeIdentity =
  /** door: the owner let into the home world on a customer site; the web app shows the customer screens. */
  | { kind: "session"; tenantId: string; email: string; name: string; role: "owner" | "member"; door?: true }
  | { kind: "token"; tenantId: string; label: string }
  | { kind: "legacy"; tenantId: string }
  | { kind: "none" };

/** a world this login belongs to (the switcher lists them). */
export interface WorldMembership {
  tenantId: string;
  tenantName: string;
  role: "owner" | "member";
}

/**
 * GET /api/me. `tenant` is the caller's world (null when not logged in with auth on): read `tenant.skin` for the skin.
 * POST /api/access/login {email, password, tenant?} answers the same shape, or `{ choose: WorldMembership[] }` for a login in
 * several worlds; POST /api/access/switch {tenant} answers it too (new session). POST /api/access/logout ends the session.
 */
export interface Me {
  mode: AuthMode;
  identity: MeIdentity;
  tenant: Tenant | null;
  worlds: WorldMembership[];
  /** why this world's personas do not wake (no isolated box yet); absent = they wake. */
  wakeHold?: string;
  /** `awaiting_payment` for an EpicTeam sign-up's world until its plan is paid; absent = nothing to pay. */
  billing?: string;
  /**
   * POST /api/access/switch to a world that lives on the other host answers only this one-time link
   * (`https://the social site/login#handoff=…`,: in the fragment, never sent to a server); the page opens it and that host signs the same login into the world.
   */
  handoff?: string;
  /** true only when the console runs with CONSOLE_COMPANY_VIEW=1; absent = the Company view is parked (the owner 2026-11-12). */
  companyView?: boolean;
}

/** GET/POST /api/access/tokens (the world owner's agent tokens). The raw `token` is only in the POST answer, once. */
export interface AgentToken {
  id: string;
  tenantId: string;
  label: string;
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  token?: string;
}

/** Team services: one central sign-in per service; the console decides which personas may use it. */
export type TeamServiceState = "connected" | "not_connected" | "error" | "unchecked";
export interface TeamServicePersona {
  id: string;
  name: string;
  world: string;
  allowed: boolean;
  /** Set on this page (false = the service's default). */
  explicit: boolean;
  /** read (= allowed), draft, send per persona; the daily send cap and today's count. */
  mail?: { read: boolean; draft: boolean; send: boolean; dailyCap: number; sentToday: number };
  /** rework: an added email account's read (= allowed) and draft. */
  caps?: { read: boolean; draft: boolean };
}
export type MailCapability = "read" | "draft" | "send";
/** rework: what a persona may do with a service (a remote MCP server: use; an email account: read, draft, send). */
export type ServiceCapability = "use" | MailCapability;
export type TeamServiceKind = "remote" | "email";
/** A service's secret: whether it is set and since when; never its value. */
export interface TeamServiceSecret {
  field: string;
  label: string;
  optional?: boolean;
  app: string;
  name: string;
  set: boolean;
  setAt?: string;
  /** Set for a built-in whose secret is rotated elsewhere (the memory service: the seat hosts' copy). */
  managed?: string;
}
/** The Add service form. */
export interface AddTeamServiceInput {
  name: string;
  key?: string;
  kind: TeamServiceKind;
  url?: string;
  header?: string;
  address?: string;
  imapHost?: string;
  smtpHost?: string;
}
/** one send attempt (sent, refused by a rule, or failed at Gmail), newest first. */
export interface MailSendLog {
  id: number;
  at: string;
  runId?: string;
  personaId?: string;
  persona?: string;
  to: string;
  subject: string;
  outcome: "sent" | "refused" | "failed";
  detail?: string;
  messageId?: string;
}
/** the mail part of the Gmail card: who may receive, the send log, and the team mailbox to the desk. */
export interface MailReadLog {
  id: number;
  at: string;
  runId?: string;
  via?: string;
  personaId?: string;
  persona?: string;
  tool: string;
  what?: string;
  outcome: "ok" | "refused" | "failed";
  detail?: string;
}
export interface TeamMailView {
  recipients: "owner" | "anyone";
  jordiAddresses: string[];
  defaultCap: number;
  sends: MailSendLog[];
  /** every mailbox read (search, read, attachment) and refused draft: who, what, how it ended. Older consoles: absent. */
  reads?: MailReadLog[];
  inbox: {
    address: string;
    state: "polling" | "not_connected" | "error" | "unchecked";
    detail: string;
    checkedAt?: string;
    recent: { at?: string; from?: string; subject?: string; state: string; reason?: string; postedAt?: string }[];
  };
}
export interface TeamService {
  id: string;
  /** rework: the short name personas call it by, its type, its world, whether it is built in, its connection (no secret). */
  key?: string;
  kind?: TeamServiceKind;
  kindLabel?: string;
  world?: string;
  builtin?: boolean;
  config?: { url?: string; header?: string; address?: string; imapHost?: string; smtpHost?: string; catalog?: string };
  capabilities?: ServiceCapability[];
  secrets?: TeamServiceSecret[];
  name: string;
  what: string;
  scope: string;
  server: string;
  enforcement: string;
  connect: string;
  status: { state: TeamServiceState; detail: string; checkedAt?: string };
  personas: TeamServicePersona[];
  mail?: TeamMailView;
}
/** one the social product tester signup (server testers.ts; the public form on epicspine.dev/testers/). */
export interface TesterSignup {
  id: string;
  email: string;
  name: string;
  useCase: string;
  plan: string;
  source: string;
  /** the source of the visit that led to it (a post id, the referring site, direct). */
  visitSource?: string | null;
  createdAt: string;
  updatedAt: string;
  notified: string | null;
  /** what they signed up for, space separated: `tester-10` (testers page) and/or `waitlist-alpha` (the social product waitlist). */
  offer?: string;
  /** rework: the application's yes/no answers (null = a plain signup from before the application). */
  answers?: TesterAnswers | null;
  /** the tester's world (null = none yet), how they pay, and the last make-world steps. */
  worldId?: string | null;
  payment?: TesterPayment | null;
  worldAt?: string | null;
  worldSteps?: TesterWorldStep[] | null;
  /** this tester's one-off $10 Stripe link (their signup id rides along, so the payment makes their world); absent until the owner makes the link. */
  payLink?: string;
  cancelledAt?: string | null;
  /** when the owner first opened /testers with this row on it (null = new). */
  seenAt?: string | null;
}
/** rework (server testerApplication.ts): one yes/no per requirement, and the real-life case study question. */
export interface TesterAnswers {
  requirements: Partial<Record<"account" | "feedback" | "fivedays" | "pay" | "approve" | "login" | "window", "yes" | "no">>;
  caseStudy: "yes" | "no";
}
/** comped (free), paid (by hand), stripe (the payment link's webhook, once exists). */
export type TesterPayment = "comped" | "paid" | "stripe";
export interface TesterWorldStep {
  step: string;
  state: "done" | "exists" | "skipped" | "failed";
  detail?: string;
}
/** POST /api/testers/:id/world. The setup link and welcome text are shown once. */
export interface TesterWorldResult {
  signupId: string;
  worldId: string;
  payment: TesterPayment;
  steps: TesterWorldStep[];
  setupLink?: string;
  setupExpiresAt?: string;
  campaign?: { repo: string; milestoneId: string; writerAssignmentId?: string };
  welcome?: string;
}
export interface TestersView {
  signups: TesterSignup[];
  page: string;
  /** signups the owner has not seen on /testers yet (Team home shows "N new applications"). */
  newCount?: number;
  /** the sign-ups the Applications tracker counts (the team's own tests and the owner's own left out). */
  counted?: number;
}
export interface TeamServicesView {
  services: TeamService[];
  /** rework: the world shown; the worlds the platform may pick; whether the caller may change things (the world's owner). */
  world?: string;
  worlds?: string[];
  canEdit?: boolean;
  catalog?: { id: string; kind: TeamServiceKind; label: string }[];
}
/** option A: GET /api/connections/memory: a world's "Voice notes from the memory service" card (server a hosted services module). */
export type MemoryNoteFilter = "all" | "team";
/** one key pasted in a steps page's private box: names and outcome only, never a value. */
/** one ask of the Team Browser's sign-in act to read a team login; never a value. */
export interface TeamLoginRead {
  id: number;
  at: string;
  runId?: string;
  persona?: string;
  account: string;
  label?: string;
  name?: string;
  outcome: "granted" | "refused" | "failed";
  detail?: string;
}
export interface TeamLoginsView {
  ask: string;
  app: string;
  accounts: { account: string; label: string; name: string }[];
  log: TeamLoginRead[];
}

export interface StepKeyPaste {
  at: string;
  page: { id: string; title: string };
  step: string;
  app: string;
  name: string;
  ask: string;
  outcome: "stored" | "refused" | "failed";
  detail?: string;
}

/** GET /api/connects: one-button connects (an account its owner connects with one tap; server auth/connects.ts). */
export interface ConnectCard {
  id: string;
  title: string;
  what: string;
  /** the exact account to pick on Google's page */
  account: string;
  channel?: { name: string; handle: string; id?: string };
  /** plain names of what the Allow gives */
  gives: string[];
  connected: boolean;
  at?: string;
  /** the button: Google's consent page, through the customer site that carries the callback */
  startUrl: string;
  inbox: boolean;
}

export interface MemoryCard {
  world: string;
  team: string;
  /** the memory service's subscribers setting (the hosted layer's): off = Connect is refused until the owner's yes. */
  enabled: boolean;
  /** false while the memory service's side (Sign in with the memory service) is switched off: no Connect, just say so. */
  memoryReady?: boolean;
  state: "not_connected" | "connected" | "revoked";
  /** the home world only: notes still come by the console's own minute poll (until this world is connected). */
  legacyPoll?: boolean;
  account?: { email?: string; name?: string };
  connectedAt?: string;
  subscriptionName?: string;
  paused?: boolean;
  desk: string;
  filter: MemoryNoteFilter;
  desks: { id: string; label: string }[];
  lastNote?: { at: string; head?: string; via?: string; ms?: number; test?: boolean };
  lastError?: { at: string; text: string };
  memoryDelivery?: { at?: string; ok?: boolean; httpStatus?: number; attempts?: number; error?: string | null };
  safety: { everyMs: number; at?: string; result?: string };
  skippedToday: number;
  /** today (UTC): signed deliveries from the memory service, safety-check searches, and (EpicTeam) minute-poll searches on the console's own token. */
  today?: { hooks: number; safetySearches: number; pollSearches?: number };
  worlds?: { world: string; team: string; state: "connected" | "not_connected" | "revoked"; desk?: string; filter?: MemoryNoteFilter; account?: string }[];
  /** Chat voice notes forwarded to this the memory service; `reconnect`: the connection lacks voice_notes.write (Reconnect the memory service). */
  forwarding?: {
    ready: boolean;
    reconnect: boolean;
    why?: string;
    status?: { sent: number; queued: number; waiting: number; failed: number; last?: { noteId: string; at: string; state: string; jobId?: string; transcript?: string; error?: string } };
  };
  /** the memory service's helpers asking the Team desk (one read-only question per helper run): today's count and the last questions. */
  asks?: MemoryAsks;
  canEdit: boolean;
}
export interface MemoryAsks {
  perDay: number;
  today: number;
  recent: { at: string; helper?: string; question?: string; refs: string[]; outcome: string; detail?: string; model?: string; costUsd?: number; ms?: number; test?: boolean }[];
}
/** GET /api/book (server book/build.ts): the Epic Book, every repo's spines as one "where are we". */
export type BookState = "moving" | "stuck" | "parked" | "done";
export interface BookEvent {
  date: string;
  kind: "commit" | "decision";
  text: string;
  sha?: string;
}
export interface BookEpic {
  path: string;
  code: string;
  title: string;
  depth: number;
  parent: string | null;
  /** view-only fold (docs/epic-folds.json): drawn inside this parent epic (its path), not as its own epic. */
  foldedInto?: string;
  status: string;
  state: BookState;
  goal: string | null;
  serves: string | null;
  decisions: { date: string; outcome: string; decision: string; summary: string }[];
  timeline: BookEvent[];
  timelineTotal: number;
  next: string | null;
  lastAttempted: string | null;
  verifiedAt: string | null;
  waitingOn: string | null;
  asks: { code: string; who: string; question: string }[];
  dod: { done: number; total: number };
  outcome: string | null;
  href?: string;
  /** everything made for this epic, newest first (server book/deliverables.ts). */
  made?: Deliverable[];
}
/** one thing made for an epic: a mockup, deck, proposal, live page, tailnet preview or piece of evidence. */
export type DeliverableKind = "mockup" | "deck" | "proposal" | "live page" | "preview" | "evidence";
export interface Deliverable {
  url: string;
  label: string;
  kind: DeliverableKind;
  date: string | null;
  row?: string;
  file?: string;
  /** A tailnet preview: the folder it was served from, so a stopped one can be served again. */
  servePath?: string;
  /** A preview of a repo folder: that folder on GitHub. */
  repoUrl?: string;
  /** The last check: ok, not running (a stopped preview), gone (404 or removed from the repo), down (no answer). */
  check?: { state: "ok" | "not running" | "gone" | "down"; at: string; detail?: string };
}
/** one epic's section of "Everything made for this" in a milestone's book. */
export interface BookMade {
  path: string;
  code: string;
  title: string;
  depth: number;
  state: BookState;
  items: Deliverable[];
}
/** one cell of a repo's services x capabilities table (server book/build.ts). */
export type CapabilityState = "works" | "stale" | "gap" | "n/a";
export interface CapabilityCell {
  state: CapabilityState;
  summary: string;
  tested: string;
  test: string;
  lastGood?: string;
  lastReal?: { at: string; what: string; url?: string };
  why?: string;
  fix?: string;
  /** The egress this cell needs when it differs from the service's. */
  egress?: string;
  /** The egress the act tool reported at the last live test. */
  egressSeen?: string;
  /** the plain word on the chip, and the reason + fix in plain words. */
  plain?: CapabilityPlain;
}
/** Works / Partly / Not yet. */
export type PlainWord = "works" | "partly" | "not yet" | "n/a";
export interface CapabilityPlain {
  word: PlainWord;
  text: string;
}
/** one line of the plain status block above the table. */
export interface CapabilityStatusLine extends CapabilityPlain {
  world: string;
  platform: string;
}
/** rework: the network exit a service needs and what happens when it is offline. */
export interface CapabilityEgress {
  kind: string;
  label: string;
  offline?: string;
  detail?: string;
  tester?: string;
}
export interface CapabilityService {
  id: string;
  label: string;
  account?: string;
  route?: string;
  pending?: string;
  egress?: CapabilityEgress;
  cells: Record<string, CapabilityCell>;
}
export interface CapabilityTable {
  title: string;
  about: string;
  scope?: string;
  checkedAt: string;
  states: Record<string, string>;
  egressLegend?: Record<string, string>;
  plainStatus?: CapabilityStatusLine[];
  capabilities: { id: string; label: string }[];
  services: CapabilityService[];
  other?: { id: string; label: string; what: string; egress: CapabilityEgress; tested?: string }[];
  source: string;
  href?: string;
}
export interface BookRepo {
  name: string;
  remote?: string;
  root: string | null;
  epics: BookEpic[];
  counts: Record<BookState, number>;
  capabilities?: CapabilityTable;
  /** the service's feature list (server book/features.ts, docs/features/epicteam.json). */
  features?: FeatureList;
  /** Every service's feature list (docs/features/*.json), EpicTeam's first; set when the repo keeps more than one. */
  featureLists?: FeatureList[];
  /** The ranked top hero journeys (server book/features.ts, docs/features/hero-journeys.json `top`). */
  topJourneys?: TopJourneys;
  error?: string;
}
/** One rung of the ranked top list: what a user can do, and why it is worth it. */
export interface TopJourney {
  rank: number;
  id: string;
  title: string;
  why: string;
  belief?: string;
  screen?: string;
  clip?: string;
}
export interface TopJourneys {
  rankedAt?: string;
  journeys: TopJourney[];
  source: string;
  href?: string;
}
/** one line of a service's feature list. */
export interface Feature {
  id: string;
  title: string;
  text: string;
  rows: string[];
  learning?: string;
  since?: string;
  section?: string;
}
export interface FeatureList {
  service: string;
  title: string;
  updated?: string;
  groups: { id: string; title: string; intro?: string; features: Feature[] }[];
  source: string;
  href?: string;
}
export interface Book {
  builtAt: string;
  repos: BookRepo[];
  counts: Record<BookState, number>;
}
export interface BookView {
  book: Book | null;
  building: boolean;
  error?: string;
  /** stuck items for the owner's radar: books older than 2 days. */
  staleBooks?: StaleBook[];
  /** rework: the newest of the last rebuild and the last daily refresh. */
  refreshedAt?: string | null;
  /** the last daily refresh (pull + capability probe) that rebuilt the book. */
  dailyRefreshAt?: string | null;
}
/** GET /api/book/:key (server book/milestone.ts): one milestone's Epic Book, the human page. */
export interface BookTreeNode {
  path: string;
  code: string;
  title: string;
  parent: string | null;
  depth: number;
  /** view-only fold (docs/epic-folds.json): drawn inside its parent's row, not as its own row. */
  foldedInto?: string;
  state: BookState;
  status: string;
  dod: { done: number; total: number };
  next: string | null;
  waitingOn: string | null;
  asks: { code: string; who: string; question: string }[];
  outcome: string | null;
}
export interface MilestoneBook {
  builtAt: string;
  repo: { name: string; remote?: string };
  milestone: { id: string; title: string; path: string; code: string; state: BookState; status: string; href?: string };
  narrative: {
    goal: string | null;
    goals: { id: string; text: string; done: boolean }[];
    whereWeAre: string[];
    next: { code?: string; text: string; stuck?: boolean }[];
    outcome: string | null;
  };
  tree: BookTreeNode[];
  counts: Record<BookState, number>;
  timeline: BookEvent[];
  /**'s table, on the repo's root milestone only. */
  capabilities?: CapabilityTable;
  /** last updated = the newest of a spine change, the capability probe and the daily refresh; stale past 2 days. */
  updated?: BookUpdated;
  /** everything made, one section per epic (the milestone first, then the epics under it). */
  made?: BookMade[];
}
export interface BookUpdated {
  at: string | null;
  spineAt: string | null;
  probeAt: string | null;
  refreshedAt: string | null;
  stale: boolean;
}
/** a milestone's book none of whose sources moved in 2 days (GET /api/book `staleBooks`). */
export interface StaleBook {
  milestoneId: string;
  title: string;
  repo: string;
  updatedAt: string | null;
}
export interface MilestoneBookView {
  book: MilestoneBook | null;
  building: boolean;
}

/** one big rock of docs/big-rocks.md (GET /api/rocks, server deck/bigRocks.ts). */
export interface BigRock {
  id: string;
  name: string;
  want: string;
  weight: "heavy" | "medium";
  frequency: { notes: number; days: number; first: string | null; last: string | null; text: string };
  /** `<repo>/<code>`; empty = no epic yet. */
  epics: string[];
  why: string | null;
  evidence: { date: string; ref: string; url?: string; quote: string }[];
  /** GET /api/rocks only: the decks it sits on. */
  decks?: { ref: DeckRef; href: string; title: string; kind: "big" | "lane" }[];
}
export interface BigRocks {
  file: string;
  repo: string;
  goal: string | null;
  window: string | null;
  read: string | null;
  lastRead: string | null;
  method: string | null;
  note: string | null;
  keptBy?: string | null;
  refresh?: string | null;
  sources?: string | null;
  rocks: BigRock[];
}
/** who keeps a page, on which milestone, how often. */
export interface PageKeeper {
  name: string;
  personaId?: string;
  milestoneId?: string;
  milestone?: string;
  cadence?: string;
  enabled?: boolean;
}
export interface RocksAbout {
  file: string;
  repo: string;
  keptBy: string | null;
  keeper: PageKeeper | null;
  refresh: string | null;
  sources: string | null;
  lastRead: string | null;
}
export interface DeckAbout {
  repo: string;
  spinePath: string;
  milestone: { id: string; title: string; own: boolean } | null;
  workers: PageKeeper[];
  refresh: { at: string; lastOkAt: string | null };
  rocks: RocksAbout | null;
}
/** a focus project's three-phase plan (docs/arcs.md), each phase one epic: now, next, after. */
export interface ArcPhase {
  place: "now" | "next" | "after";
  repo: string;
  code: string;
  /** what this phase achieves, one plain line. */
  line: string;
  title: string | null;
  status: string | null;
  goal: string | null;
  /** the epic's deck in the console. */
  href: string | null;
}
export interface Arc {
  project: string;
  spine: string;
  aim: string | null;
  phases: ArcPhase[];
  file: string;
  fileStatus: string | null;
}
export interface BigRocksView {
  rocks: BigRocks | null;
  file: string;
  about?: RocksAbout;
}
export interface DeckRef {
  repo: string;
  code: string;
}
/** GET /api/deck/:repo/:code (server deck/build.ts): one high-level epic's deck. */
export interface EpicDeck {
  builtAt: string;
  ref: DeckRef;
  href: string;
  title: string;
  path: string;
  state: BookState;
  status: string;
  spineHref?: string;
  milestoneId?: string;
  updatedAt: string | null;
  rocks: BigRock[];
  goal: string | null;
  serves: string | null;
  goals: { id: string; text: string; done: boolean }[];
  whereWeAre: string[];
  next: { code?: string; text: string; stuck?: boolean }[];
  outcome: string | null;
  justDid: (BookEvent & { code: string })[];
  measure: {
    goalsMet: number;
    goalsTotal: number;
    epics: Record<BookState, number>;
    subGoals: { done: number; total: number };
    asksOnJordi: number;
    weekly: { week: string; n: number }[];
    trend: { date: string; goalsMet: number; goalsTotal: number; epicsDone: number; epicsTotal: number }[];
  };
  plan: BookTreeNode[];
  decisions: { date: string; code: string; outcome: string; decision: string; summary: string }[];
  waits: { code: string; who: string; question: string; epic: string }[];
  made: (Deliverable & { epic: string })[];
  fingerprint: string;
}
export interface EpicDeckView {
  deck: EpicDeck | null;
  about?: DeckAbout;
  /** on a product's decks, the page where its numbers live (one plain label) and the numbers read now. */
  live?: DeckLive;
  building: boolean;
}
export interface DeckLive {
  link: { label: string; url: string };
  counts: { label: string; source: string; value?: number | null; sourceText?: string; note?: string }[];
}
export interface DeckListItem {
  ref: DeckRef;
  href: string;
  title: string;
  state: BookState;
  kind: "big" | "lane";
  milestoneId?: string;
  goalsMet: number;
  goalsTotal: number;
  rocks: string[];
}
/** a deck's newest unseen line in docs/status/deck-updates.md: one card on the Team home. */
export interface DeckCard {
  ref: DeckRef;
  href: string;
  title: string;
  date: string;
  text: string;
  goals: { met: number; total: number };
}
export interface DecksView {
  decks: DeckListItem[];
  cards: DeckCard[];
  building?: boolean;
  updatesFile?: string;
  about?: Pick<DeckAbout, "refresh" | "rocks">;
}

/** Team skills: the code repo skills/team-skills.json, installed on every seat; personas attach them by name. */
export interface TeamSkillSource {
  type: "local" | "github";
  path?: string;
  repo?: string;
  /** github: the pinned 40-char commit. */
  commit?: string;
}
export interface TeamSkill {
  name: string;
  useWhen: string;
  source: TeamSkillSource;
  /** Where to read it: the pinned tree on GitHub, or ours in the code repo. */
  url?: string;
  /** The personas (of your world) that attach it. */
  usedBy: { id: string; name: string }[];
  /** `base` = the team library every world has; `world` = this world's own (in its repo). */
  scope?: "base" | "world";
  /** this caller may remove it (the owner: base skills on the console; a world's owner: its own skills). */
  removable?: boolean;
}
export interface TeamSkillsView {
  skills: TeamSkill[];
  /** Skills a persona holds that the library does not have (free text from before the pick-list): flagged, never dropped. */
  unknown: { skill: string; persona: { id: string; name: string } }[];
  /** May add: the owner on the console (the team library); a world's owner (the world's own skills). */
  canEdit: boolean;
  syncNote: string;
  /** the caller's world when it is not the home world, and the repo its own skills live in. */
  world?: { id: string; repo: string | null };
  /** The manifest could not be read. */
  error?: string;
}
export interface TeamSkillPreview {
  skill: { name: string; use_when: string; source: TeamSkillSource };
  url?: string;
  description: string;
  action: "added" | "repinned" | "unchanged";
  skillMdName: string | null;
}
export interface TeamSkillSync {
  host: HostId;
  ok: boolean;
  note: string;
}
export interface TeamSkillAddResult {
  action: "added" | "repinned" | "unchanged";
  skill: { name: string; use_when: string; source: TeamSkillSource };
  sha?: string;
  sync?: TeamSkillSync[];
  syncNote?: string;
  /** a world's add: how its repo took the commit. */
  push?: string;
}
export interface TeamSkillRemoveResult {
  removed: string;
  sha?: string;
  detachedFrom: { id: string; name: string }[];
  sync: TeamSkillSync[];
  syncNote: string;
}

/**
 * `GET /api/runs/active`, the Runs page's Active agents chart for one day in the viewer's timezone: the most
 * agents (wakes and child runs) active at any moment of each bucket from `start`, and the day's peak. Never the runs.
 */
export interface ActiveAgentsSeries {
  day: string;
  tz: string;
  start: string;
  end: string;
  bucketMinutes: number;
  counts: number[];
  peak: { count: number; at: string | null; runIds: string[] };
  runs: number;
  now: string;
}

/**
 * `GET /api/runs/hosts?range=24h|7d`, the Runs page's Live runs by host chart: per host, the runs live at each
 * bucket's busiest moment from `start` to `now`; the peak; how many runs each host had and what placed them.
 */
export type RunHostKey = HostId | "unknown";
export type RunHostRange = "24h" | "7d";
export interface RunHostsSeries {
  range: RunHostRange;
  start: string;
  now: string;
  bucketMinutes: number;
  counts: Record<RunHostKey, number[]>;
  peak: { count: number; at: string | null; byHost: Record<RunHostKey, number> };
  runs: Record<RunHostKey, number>;
  sources: Record<"recorded" | "launch" | "environment" | "parent" | "seat" | "unknown", number>;
  unknownIds: string[];
}

/** `GET /api/runs/stats`, the Team home's wake numbers from the newest 500 runs (no run list sent). */
/**
 * the pills (GET /api/counts), per world: what waits on the owner to unblock (red), what waits for his review (green),
 * unread replies in the world's Chat; `milestones` holds only those with something to show. null = not known yet.
 */
export interface CountsView {
  needsYou: number | null;
  review: number;
  chat: number | null;
  milestones: Record<string, { needsYou?: number | null; review?: number; chat?: number }>;
  asOf?: string;
}
/**
 * one row of the world switcher (GET /api/counts/worlds): a world this login belongs to and what
 * waits on the owner there, red (blocked asks; null = not read yet) and green (review cards). `current` = the world shown now.
 */
export interface WorldCounts {
  tenantId: string;
  tenantName: string;
  role: string;
  current: boolean;
  needsYou: number | null;
  review: number;
}
/** the chat the owner just opened (POST /api/chat/seen): his world's desk, or one milestone's Chat tab. */
export type ChatSeenTarget = { chat: "desk" } | { chat: "milestone"; id: string };

export interface RunStatsView {
  /** Per milestone id: wakes started in the last 24 h and the latest wake. */
  milestones: Record<string, { last24h: number; last?: Run }>;
  /** Per persona id: wakes across its assignments and the latest. */
  personas: Record<string, { count: number; last?: Run }>;
  /**'s footer: ended wakes started in the last 24 h (every one, no 500 cap) and how many did something. */
  wakes24h: { did: number; total: number };
}

/** one Brief slide, drawn from a section of the campaign's epic file (`ref` = its heading path). */
export interface TotemSlide {
  n: number;
  ref: string;
  file: string;
  title: string;
  source: string;
  body: string;
  draft?: string;
  facts?: { label: string; value: string }[];
  /** The benefits slide: what it does for you, the benefit it brings, and its screen. */
  benefits?: TotemBenefit[];
  asked?: { id: string; text: string }[];
}
export interface TotemBenefit {
  id: string;
  does: string;
  benefit: string;
  status: string;
  soon: boolean;
  screen?: { label: string; path: string; url?: string };
}
/** one note on a Product tab slide, filed to the campaign's spine (a `Product note` Decisions row). */
export interface ProductNote {
  date: string;
  file: string;
  slide: string;
  note: string;
  /** "the owner's", or "a test". */
  noteBy: string;
}

export interface TotemRebuild {
  ref: string;
  state: "rebuilt" | "kept" | "undone";
  date: string;
  note: string;
  changes: { date: string; text: string }[];
}
export interface TotemTask {
  id: string;
  title: string;
  owner: string;
  role: string;
  status: string;
  evidence: string;
  next: string;
  group: "waiting" | "moving" | "planned" | "done";
}
export interface TotemObservation {
  id: string;
  when: string;
  rule: string;
  why: string;
  confirmed: string;
  retired: boolean;
  proposal?: { part: string; text: string; state: "open" | "added" | "not now" };
  raw: string;
}
export interface TotemHistoryLine {
  time: string;
  who: string;
  text: string;
  kind: "decision" | "owner" | "wake";
}
export interface TotemHistoryWeek {
  week: string;
  line: string;
  page?: string;
  days: { date: string; day?: string; lines: TotemHistoryLine[] }[];
}
export interface TotemEpicRef {
  code: string;
  title: string;
  path: string;
}
/** GET /api/tenants/:id/campaigns/:mid/totems: the four parts of the campaign's epic file (and the team brief). */
export interface CampaignTotems {
  epic: TotemEpicRef & { kind: string; status: string };
  /** The plan's `Deck:` URL (the longer story deck, kept until its content is in the brief), else null. */
  deck?: string | null;
  chain: TotemEpicRef[];
  slides: TotemSlide[];
  rebuilds: TotemRebuild[];
  /** notes on the Product tab's slides, oldest first (older servers send none). */
  productNotes?: ProductNote[];
  work: { rows: TotemTask[]; asks: { code: string; text: string }[] };
  observations: TotemObservation[];
  history: { weeks: TotemHistoryWeek[] };
  /** the Benefits tab: what the product does for the people who use it (the brief's Benefits table, else the product
   * deck's What it does for you); older servers send none. */
  benefits?: { source: string | null; lines: TotemBenefit[]; asked: { id: string; text: string }[] };
  remote: string | null;
  team: { root: TotemEpicRef; slides: TotemSlide[]; rebuilds: TotemRebuild[]; observations: TotemObservation[] } | null;
}

/** a voice feedback link (server voiceFeedback.ts); `url` is the link to send. */
export interface FeedbackLink {
  id: string;
  token: string;
  url: string;
  world: string;
  who: string;
  product: string;
  campaign: string;
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
  notes: number;
  lastNoteAt?: string;
}
/** one note in the pipeline (recording, transcribed, filed); its text lives in the repo file once filed. */
export interface FeedbackNoteView {
  id: string;
  linkId: string;
  who: string;
  product: string;
  campaign: string;
  startedAt: string;
  finishedAt?: string;
  state: "recording" | "transcribed" | "filed" | "empty" | "discarded";
  seconds: number;
  costUsd: number;
  file?: string;
  sha?: string;
  repo?: string;
  fileError?: string;
  toldAt?: string;
  structure?: { summary: string; sentiment: string; asks: string[]; bugs: string[]; praise: string[]; quotes: string[] };
}
/** a filed item as read back from the repo (front matter fields, summary, asks, bugs). */
export interface FiledFeedback {
  file: string;
  fields: Record<string, string>;
  summary: string;
  asks: string[];
  bugs: string[];
}
export interface FeedbackView {
  links: FeedbackLink[];
  notes: FeedbackNoteView[];
  filed: FiledFeedback[];
  repo?: string;
  dir: string;
  public: boolean;
}

/** one sent briefing's pictures (GET /api/notify/briefings): 06:00 morning or 18:30 evening, in the order sent. */
export interface BriefingPictures {
  briefing: "morning" | "evening";
  at: string;
  pictures: { url: string; what: string; ok: boolean; receipt: string | null; delivery?: BriefingDelivery | null; deliveryAt?: string | null }[];
  /** the delivery state of the whole briefing (its weakest picture); null = not read yet. */
  delivery?: BriefingDelivery | null;
}
/** what the messaging channel says of a sent message: its delivery receipt. */
export type BriefingDelivery = "pending" | "sent" | "delivered" | "read" | "failed" | "unknown";

/** who sends the owner WhatsApp (the persona holding `whatsapp-notify`), the milestones it acts for, which path sends now. */
export interface WhatsAppHolderView {
  skill: string;
  /** explicit false = nobody holds the skill and the Delivery Manager is the default. */
  holder: { id: string; name: string; explicit: boolean } | null;
  milestones: { id: string; title: string }[];
  /** `console` until the persona's skill proved itself with a TEST message, then `persona`. */
  sender: "console" | "persona";
  handoverAt?: string;
  configured: boolean;
  lastSend?: { at: string; kind: string; items: number; ok: boolean; via: string; error?: string };
}

/**
 * GET /api/launch-board[?product=]: the launch board the console runs every 30 min (server/src/launch/board.ts,
 * mirrored). A red light names its owner: who fixes it, the epic, and why that owner (the open row or ask, else the capability).
 */
export interface LaunchCode { code: string; repo?: string; kind?: "row" | "ask" | "epic"; text: string; state: string; open: boolean; link?: string | null; who?: string }
export interface LaunchEpic { code: string; title: string; file: string; deck: string }
export interface LaunchOwner {
  by: "row" | "capability";
  who: string;
  epic: LaunchEpic | null;
  world?: string;
  next: LaunchCode | null;
  capability: { key: string; what: string; epic: LaunchEpic | null; world?: string | null };
  draft?: boolean;
  why: string;
}
export interface LaunchLight { group: string; label: string; state: "green" | "red" | "na"; seen: string; kind: string; fix?: string; codes?: LaunchCode[]; owner?: LaunchOwner }
export interface LaunchProduct { id: string; name: string; site: string; world?: string; greens: number; total: number; lights: LaunchLight[] }
export interface LaunchDraft { product: string; label: string; fix: string; seen: string; epic: string | null; spine: string | null; world?: string | null }
export interface LaunchBoard { checkedAt: string; nextAt: string; greens: number; total: number; ownerRule: string; products: LaunchProduct[]; drafts: LaunchDraft[] }
export interface LaunchBoardBody { board: LaunchBoard | null; ranAt: string | null; error?: string }

/**
 * the onboarding scorecard (GET /tenants/:id/onboarding), each tick read from live state. Iteration 2: done only
 * when a live check proves it, every other tick names its one fix and its proof; the vault lists every login and key;
 * an EpicTeam world (product team) has world, signin, vault, repos and seats.
 */
export type OnboardingTickState = "done" | "part" | "todo";
export interface OnboardingTick {
  id: "signin" | "vault" | "accounts" | "product" | "campaign" | "post" | "world" | "repos" | "seats";
  title: string;
  line: string;
  state: OnboardingTickState;
  today: string;
  how: string;
  fix?: string | null;
  proof?: string;
}
export interface OnboardingAccount {
  platform: string;
  label: string;
  state: "green" | "yellow" | "grey";
}
export interface OnboardingVaultItem {
  name: string;
  kind: "login" | "key";
  state: "green" | "red";
  why: string;
}
export interface Onboarding {
  world: string;
  product?: "social" | "team";
  site?: string | null;
  done: number;
  of: number;
  ticks: OnboardingTick[];
  accounts: OnboardingAccount[];
  vault?: OnboardingVaultItem[];
  readAt: string;
}

/** Priority mode: the machine given to one or two rows (GET /api/priority-mode). */
export interface PriorityPark {
  sessionId: string;
  runId: string;
  kind: "worker" | "wake";
  ticket?: string;
  assignmentId: string;
  parentRunId?: string;
  threadId?: string;
  rank: number | null;
  state: "asked" | "ask_failed" | "resumed" | "resume_failed" | "handed_to_manager" | "skipped";
  parkedAt: string;
  resumeRunId?: string;
  resumedAt?: string;
  note?: string;
}
export interface PriorityModeView {
  on: boolean;
  session?: { id: string; rows: string[]; by: string; reason: string; startedAt: string; assignments: string[]; endedAt?: string; endedBy?: string; endWhy?: string };
  parked: PriorityPark[];
  log: { at: string; event: string; runId?: string; ticket?: string; detail: string }[];
  focusRunning: string[];
}
