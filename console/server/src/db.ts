import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeWorld, mainHost, opsRepo, ownerFromRow, ownerName, workerHost, seatDir, sites, stateDir } from "./identity.js";

export type DB = Database.Database;

/** a value inside a single-quoted SQL literal */
const sqlText = (s: string): string => s.replace(/'/g, "''");

export function defaultDbPath(): string {
  return process.env.CONSOLE_DB || path.join(stateDir(), "console.db");
}

// Each entry runs once, in order; PRAGMA user_version records how many have run.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE milestones (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE personas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    remit TEXT NOT NULL,
    skills TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT '',
    may_write INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
    persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    cadence TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    t3_scheduled_task_id TEXT,
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX assignments_milestone ON assignments(milestone_id);
  CREATE INDEX assignments_persona ON assignments(persona_id);
  -- assignment_id has no FK on purpose: the run log outlives a detached assignment.
  -- milestone_id is copied from the assignment at insert so history stays filterable.
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL,
    milestone_id TEXT REFERENCES milestones(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    seat TEXT,
    thread_id TEXT,
    outcome TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL
  );
  CREATE INDEX runs_assignment ON runs(assignment_id, started_at);
  CREATE INDEX runs_milestone ON runs(milestone_id, started_at);
  CREATE TABLE needs_jordi (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    proposed_action TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  );
  CREATE INDEX needs_jordi_status ON needs_jordi(status, created_at);
  `,
  // auto-park: set when the wake gate disabled the assignment (nothing actionable); cleared on re-arm or a manual toggle.
  `
  ALTER TABLE assignments ADD COLUMN parked_at TEXT;
  ALTER TABLE assignments ADD COLUMN parked_reason TEXT;
  `,
  // the owner's answers to waiting-on-the owner items; messages the owner sends to a persona's home thread.
  // item_id is the inbox item id (spine items are not rows anywhere), so no FK; assignment ids outlive detach.
  `
  CREATE TABLE jordi_responses (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    milestone_id TEXT REFERENCES milestones(id) ON DELETE CASCADE,
    item TEXT NOT NULL DEFAULT '{}',
    kind TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    assignment_id TEXT,
    thread_id TEXT,
    delivery TEXT NOT NULL,
    delivery_error TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX jordi_responses_item ON jordi_responses(item_id, created_at);
  CREATE INDEX jordi_responses_milestone ON jordi_responses(milestone_id, created_at);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    milestone_id TEXT REFERENCES milestones(id) ON DELETE CASCADE,
    assignment_id TEXT NOT NULL,
    text TEXT NOT NULL,
    ref_item_id TEXT,
    thread_id TEXT,
    delivery TEXT NOT NULL,
    delivery_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_milestone ON messages(milestone_id, created_at);
  `,
  // "Ask owner to write asks" is logged as a message of kind ask_for_asks, and may go to an owner thread with no
  // assignment: assignment_id becomes nullable (SQLite: rebuild the table).
  `
  CREATE TABLE messages_v2 (
    id TEXT PRIMARY KEY,
    milestone_id TEXT REFERENCES milestones(id) ON DELETE CASCADE,
    assignment_id TEXT,
    kind TEXT NOT NULL DEFAULT 'message',
    text TEXT NOT NULL,
    ref_item_id TEXT,
    thread_id TEXT,
    delivery TEXT NOT NULL,
    delivery_error TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO messages_v2 (id, milestone_id, assignment_id, text, ref_item_id, thread_id, delivery, delivery_error, created_at)
    SELECT id, milestone_id, assignment_id, text, ref_item_id, thread_id, delivery, delivery_error, created_at FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_v2 RENAME TO messages;
  CREATE INDEX messages_milestone ON messages(milestone_id, created_at);
  `,
  // jordi_responses is a delivery log; for spine items the answer is written into the spine (commit + push).
  // spine_status = written | skipped | failed (NULL for Needs the owner rows, which keep the thread message flow).
  `
  ALTER TABLE jordi_responses ADD COLUMN spine_status TEXT;
  ALTER TABLE jordi_responses ADD COLUMN spine_reason TEXT;
  ALTER TABLE jordi_responses ADD COLUMN spine_sha TEXT;
  ALTER TABLE jordi_responses ADD COLUMN spine_path TEXT;
  ALTER TABLE jordi_responses ADD COLUMN spine_at TEXT;
  `,
  // settled: console-only timestamp, separate from the spine status; null = not settled (all existing rows).
  `
  ALTER TABLE milestones ADD COLUMN settled_at TEXT;
  `,
  // per-assignment write: effective write = persona.may_write OR assignment.write_enabled, limited to write_scope.
  `
  ALTER TABLE assignments ADD COLUMN write_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE assignments ADD COLUMN write_scope TEXT NOT NULL DEFAULT '';
  -- M2-19 Activity: the persona is stamped on each run so runs of a deleted assignment keep it (no FK: history).
  ALTER TABLE runs ADD COLUMN persona_id TEXT;
  UPDATE runs SET persona_id = (SELECT persona_id FROM assignments a WHERE a.id = runs.assignment_id) WHERE persona_id IS NULL;
  `,
  // needs_jordi.status gains `superseded` (replaced by a coded spine ask, or moot): superseded_by is
  // `<repo>/<code>` or `moot`. Not an answer: no owner message, no write grant.
  `
  ALTER TABLE needs_jordi ADD COLUMN superseded_by TEXT;
  ALTER TABLE needs_jordi ADD COLUMN superseded_at TEXT;
  `,
  // persona host: where its threads run (the main server = the local T3, the worker server = the ephemeral the worker server box). Numbered by
  // position; the manager renumbers at merge when other branches add versions.
  `
  ALTER TABLE personas ADD COLUMN host TEXT NOT NULL DEFAULT '{{mainHost}}';
  `,
  // run kind: 'wake' (wake / run-now / bootstrap / child, told apart by parent_run_id and the bootstrap: id as
  // before) or 'answer_run' (a turn the owner started in a home thread via Send to). Answer runs never count as wakes.
  `
  ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'wake';
  `,
  // the assignment's write_enabled + write_scope is the only write gate (personas.may_write now only defaults new
  // assignments). So nothing live stalls: an enabled assignment of a may_write persona with ANY run in the last 7
  // days (whatever the outcome: a persona that only reports blocked still commits spine reconciles) is switched on, with the scope text of the behavior it had (persona-wide, per its remit).
  // Additive: data only, no schema change; assignments already on keep their own scope.
  `
  UPDATE assignments
     SET write_enabled = 1,
         write_scope = 'as before M2-36 (persona may-write, migrated): the writes, restarts and deploys your remit requires; ${sqlText(ownerName())} can narrow this scope'
   WHERE write_enabled = 0
     AND enabled = 1
     AND persona_id IN (SELECT id FROM personas WHERE may_write = 1)
     AND EXISTS (
       SELECT 1 FROM runs r
        WHERE r.assignment_id = assignments.id
          AND r.started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
     );
  `,
  // timed wake: a run PATCH may carry retry_at (the persona asks to be woken then); the assignment keeps the earliest
  // pending one (retry_at + the run that asked) until the cycle fires it, then clears both.
  `
  ALTER TABLE runs ADD COLUMN retry_at TEXT;
  ALTER TABLE assignments ADD COLUMN retry_at TEXT;
  ALTER TABLE assignments ADD COLUMN retry_run_id TEXT;
  `,
  // Run now with one-off instructions: the owner's note for that run, injected into the prompt of the wake that claims it.
  `
  ALTER TABLE runs ADD COLUMN instructions TEXT;
  `,
  // thread links: the T3 environment a run's thread lives on (links are t3code://threads/<env>/<thread>), and
  // each host's environment id as last read from its T3 (t3_environment_read). Rows are stamped by triggers (cycle).
  `
  ALTER TABLE runs ADD COLUMN environment_id TEXT;
  CREATE INDEX runs_thread ON runs(thread_id);
  CREATE TABLE t3_environments (
    host TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    read_at TEXT NOT NULL
  );
  `,
  // Unblocker visible in Activity: the asks a run checked (JSON array, set by its finishing PATCH), and who gave a
  // Run now note (the owner from the UI, Unblocker when it wakes the Delivery Manager). Additive: NULL on older runs.
  `
  ALTER TABLE runs ADD COLUMN checks TEXT;
  ALTER TABLE runs ADD COLUMN instructions_by TEXT;
  `,
  // the Unblocker reads every wake fresh: a persona flag that launches a NEW thread per wake (default off), and the
  // open asks of the milestone when the wake prompt was built (JSON [{code, kind, path, line}]); its finishing PATCH must
  // carry one `checks` entry per code. Additive: 0 / NULL on older rows.
  `
  ALTER TABLE personas ADD COLUMN fresh_thread_each_wake INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN open_asks TEXT;
  `,
  // the owner changes an answer before the owner acts: the new response points at the one it replaces (kept for
  // history; Activity shows "Changed answer: <old> → <new>"). Additive: NULL on older rows.
  `
  ALTER TABLE jordi_responses ADD COLUMN replaces_id TEXT;
  `,
  // an Unblocker cadence wake is skipped when nothing changed: the fingerprint of the open asks (code, kind, line
  // text hash) and active grants (code, text hash) at the wake. Additive: NULL on older runs and non-Unblocker runs.
  `
  ALTER TABLE runs ADD COLUMN ask_fingerprint TEXT;
  `,
  // tokens per wake: usage summed from the run's Claude Code transcript (JSON {model, input, cacheWrite, cacheRead,
  // output, turns, costUsd, estimate, collectedAt, source, byModel}; never message text), when the collector last looked
  // and why it found nothing yet (missing transcript, host asleep). Additive: NULL on older runs until the sweep fills them.
  `
  ALTER TABLE runs ADD COLUMN usage TEXT;
  ALTER TABLE runs ADD COLUMN usage_checked_at TEXT;
  ALTER TABLE runs ADD COLUMN usage_note TEXT;
  `,
  // any cadence persona skips a wake when nothing changed (runs.ask_fingerprint then holds its wake fingerprint);
  // a persona can opt out. Additive: existing personas default on.
  `
  ALTER TABLE personas ADD COLUMN skip_unchanged INTEGER NOT NULL DEFAULT 1;
  `,
  // Monitoring: a run waiting on a time or condition says when it checks next (next_check_at) and when the watch
  // ends (monitor_until); a `blocked` report citing no open ask is stored as monitoring, its own word kept in
  // reported_outcome for audit. Additive: NULL on older rows.
  `
  ALTER TABLE runs ADD COLUMN next_check_at TEXT;
  ALTER TABLE runs ADD COLUMN monitor_until TEXT;
  ALTER TABLE runs ADD COLUMN reported_outcome TEXT;
  `,
  // set when Settings saves a title of its own; it then wins over the spine's title. NULL = follow the spine.
  `
  ALTER TABLE milestones ADD COLUMN title_set_at TEXT;
  `,
  // an answer wakes (or steers) the persona who asked: what happened, per response. wake_status = woken | steered |
  // queued (steer waiting for the thread) | skipped | off (the owner unticked Wake) | failed; wake_run_id the run woken or steered. Additive: NULL on older rows.
  `
  ALTER TABLE jordi_responses ADD COLUMN wake_status TEXT;
  ALTER TABLE jordi_responses ADD COLUMN wake_run_id TEXT;
  ALTER TABLE jordi_responses ADD COLUMN wake_reason TEXT;
  `,
  // a run that ended monitoring because a Team Browser egress was offline names it (held_on = 'egress:laptop');
  // POST /api/egress/:name/online wakes those runs' assignments. Additive: NULL on older rows.
  `
  ALTER TABLE runs ADD COLUMN held_on TEXT;
  `,
];

export function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v].replaceAll("{{mainHost}}", sqlText(mainHost()))); // the host id is config, read when the migration runs
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  ensureColumns(db);
  ensureTenancy(db);
}

/**
 * Additive columns added by name, not by user_version (safe when parallel branches each append a migration).
 * runs.self_readied = JSON list of spine lines the run turned from draft to ready (NO_SELF_READY).
 * runs.note_ack = the report's `note: done|not done` line; runs.pre_wake = the pre-wake pull / fresh-session line.
 * jordi_responses.via = 'team-desk' when the owner's answer was registered from the desk chat, chat_text = his words.
 * runs.ready_ignored = JSON list of step ids that read ready when the wake reported idle; runs.repeating = how
 * many ended wakes in a row (this one included) gave the same report, runs.repeat_since = when the first of them started.
 * runs.stalled = why a Delivery manager wake that launched nothing is flagged stalled (no `blocker:` line).
 * runs.wake_parts = JSON of the wake fingerprint's parts (spines, prompt, answer, running, ready); runs.woke_because =
 * why a real cadence wake was not skipped (the part that changed, or the rule that let it run).
 * runs.start_fingerprint = a real cadence wake's fingerprint when it started (askFingerprint is refreshed when it
 * ends): equal at the end = the wake changed nothing (a "wasted" wake when it ended monitoring or blocked, wakeStats.ts).
 * runs.start_guard = JSON list of starters that met this running wake and started none ({at, by, action queued|already_running}).
 * runs.rule_broken = JSON {at, roles, issues} when the run's commits failed its pack's `pack.py validate --by <role>`.
 * runs.deferred = JSON retry state of a wake deferred by a load-cap / no seat ({reason, host, attempts, firstAt, nextAt});
 * runs.launch_host = the host its thread launched on when not the persona's (the worker server at its cap → the main server).
 * runs.client_request_id = the caller's id for a POST /api/runs (unique per assignment): a retried create returns the same run.
 * jordi_responses.client_key = the web's idempotency key for a POST …/respond (unique: a retried request returns the
 * stored answer, never a second one); job_* = the answer's background job (spine write, push, wake) that runs after the reply:
 * job_state pending | running | done | failed, job_attempts, job_error (last failure), job_next_at (next retry), job_wake (1/0).
 * milestones.big_root = position among the owner's big roots (the social product launch, the memory service launch, hair transplant, house
 * decision), 1 first; NULL = an ordinary milestone.
 * runs.usage_live = tokens so far of a run still working (JSON RunUsage, live: true), cleared when its usage lands.
 * runs.host = the host the run's agent ran on (the main server | the worker server), recorded at launch by the console or sent by the
 * agent that created the run; NULL on older rows (runHosts.ts places them from launch_host, environment id, parent).
 * runs.route = where a world's own route ran the run: `job` (a job server of its own) or `sandbox:<host>` (its world
 * sandbox on that host); NULL = a T3 thread on a shared host (or an older row).
 * jordi_responses.settles = JSON of the other open asks the same answer closed (written in their spines) and the
 * maybes (inbox/settles.ts), once per answer; NULL = not run (off, or the answer was not an ask).
 * assignments.objective = the objective (docs/pursuits.json id) the assignment works; its Personas tab lists it.
 */
const COLUMNS: [table: string, column: string, type: string][] = [
  ["assignments", "objective", "TEXT"],
  ["runs", "self_readied", "TEXT"],
  ["runs", "note_ack", "TEXT"],
  ["runs", "pre_wake", "TEXT"],
  ["runs", "ready_ignored", "TEXT"],
  ["runs", "repeating", "INTEGER"],
  ["runs", "repeat_since", "TEXT"],
  ["runs", "stalled", "TEXT"],
  ["runs", "wake_parts", "TEXT"],
  ["runs", "woke_because", "TEXT"],
  ["runs", "rule_broken", "TEXT"],
  ["runs", "start_fingerprint", "TEXT"],
  ["runs", "start_guard", "TEXT"],
  ["runs", "client_request_id", "TEXT"],
  ["runs", "deferred", "TEXT"],
  ["runs", "launch_host", "TEXT"],
  ["jordi_responses", "via", "TEXT"],
  ["jordi_responses", "chat_text", "TEXT"],
  ["jordi_responses", "client_key", "TEXT"],
  ["jordi_responses", "job_state", "TEXT"],
  ["jordi_responses", "job_attempts", "INTEGER"],
  ["jordi_responses", "job_error", "TEXT"],
  ["jordi_responses", "job_next_at", "TEXT"],
  ["jordi_responses", "job_wake", "INTEGER"],
  ["milestones", "big_root", "INTEGER"],
  ["runs", "usage_live", "TEXT"],
  ["runs", "host", "TEXT"],
  ["runs", "route", "TEXT"],
  ["jordi_responses", "settles", "TEXT"],
];
function ensureColumns(db: DB) {
  for (const [t, c, type] of COLUMNS) {
    const have = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);
    if (!have) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_client_request ON runs(assignment_id, client_request_id) WHERE client_request_id IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS jordi_responses_client_key ON jordi_responses(client_key) WHERE client_key IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS jordi_responses_job ON jordi_responses(job_state) WHERE job_state IN ('pending', 'running')");
  usageBackfill(db);
}

/** run_usage.py's SCAN_VERSION; usage read by an older scan is re-read (keep the two equal). */
export const USAGE_SCAN_VERSION = 2;

/**
 * backfill, at every start (idempotent): the last 7 days' runs still without usage are due now, and usage read by
 * an older scan (before every seat dir was read, or with older matching rules: `scan` below USAGE_SCAN_VERSION) is
 * provisional again, so the sweep re-reads it and records its seat (numbers stay shown meanwhile; credits already
 * debited are never debited twice).
 */
export function usageBackfill(db: DB) {
  if (!(db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).some((x) => x.name === "usage")) return;
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  db.prepare(`UPDATE runs SET usage_checked_at = NULL WHERE usage IS NULL AND kind = 'wake' AND ended_at >= ?`).run(since);
  db.prepare(
    `UPDATE runs SET usage = json_set(usage, '$.final', json('false'))
      WHERE usage IS NOT NULL AND kind = 'wake' AND ended_at >= ? AND json_extract(usage, '$.source') LIKE 'claude-code:%'
        AND COALESCE(json_extract(usage, '$.scan'), 1) < ? AND COALESCE(json_extract(usage, '$.final'), 1) != 0`,
  ).run(since, USAGE_SCAN_VERSION);
}

/** the default tenant. Every row from before multi-tenancy (and every row an unscoped store writes) is the home world's. */
export const DEFAULT_TENANT = homeWorld();

/**
 * tenancy, additive and idempotent by name (like ensureColumns: safe with parallel branches, safe to run on every
 * start). `tenants` + the home world row; `tenant_id TEXT NOT NULL DEFAULT 'the home world'` on root rows and on rows that copy their
 * milestone (assignments and the cycle_* side tables reach it through milestone_id / assignment_id); `hosts` seeded with
 * the main server and the worker server (nothing reads it yet: Persona.host stays the source until S10). Side tables created by their modules
 * (desk_session, desk_placement, ticket_session) get the column when they exist: createApp calls this again after them.
 * Rollback = the previous release: old code ignores the extra tables and columns, and its inserts take the default.
 */
export const TENANT_TABLES = [
  "milestones",
  "personas",
  "runs",
  "needs_jordi",
  "jordi_responses",
  "messages",
  "desk_session",
  "desk_placement",
  "ticket_session",
] as const;

export function ensureTenancy(db: DB, env: NodeJS.ProcessEnv = process.env): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        skin TEXT NOT NULL DEFAULT 'console',
        plan TEXT NOT NULL DEFAULT 'internal',
        owner_handle TEXT NOT NULL DEFAULT '${sqlText(ownerName())}',
        owner_name TEXT NOT NULL DEFAULT '${sqlText(ownerName())}',
        repos_root TEXT,
        secrets_backend TEXT NOT NULL DEFAULT '${sqlText(opsRepo())}',
        box_provider TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
        kind TEXT NOT NULL,
        provider TEXT,
        t3_mcp_url TEXT,
        token_file TEXT,
        ssh TEXT,
        public_console_url TEXT,
        memory_floor_mb INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
    `);
    const at = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO tenants (id, name, skin, plan, owner_handle, owner_name, repos_root, secrets_backend, created_at)
       VALUES (?, ?, 'console', 'internal', ?, ?, ?, ?, ?)`,
    ).run(DEFAULT_TENANT, homeWorld(), ownerName(), ownerName(), env.REPOS_ROOT || path.join(os.homedir(), "github"), opsRepo(), at);
    const home = os.homedir();
    const seed = db.prepare(
      `INSERT OR IGNORE INTO hosts (id, tenant_id, kind, provider, t3_mcp_url, token_file, ssh, public_console_url, notes, created_at)
       VALUES (@id, '${DEFAULT_TENANT}', @kind, @provider, @mcp, @token, @ssh, @pub, @notes, @at)`,
    );
    seed.run({
      id: mainHost(),
      kind: "local",
      provider: sites().hostProvider,
      mcp: env.T3_MCP_URL || null,
      token: env.T3_TOKEN_FILE || path.join(seatDir(home), ".t3token"),
      ssh: null,
      pub: env.CONSOLE_PUBLIC_URL || null,
      notes: "seeded from the console env; the console host (local T3)",
      at,
    });
    seed.run({
      id: workerHost(),
      kind: "ephemeral",
      provider: sites().hostProvider,
      mcp: env.CONSOLE_VPS3_MCP_URL || null,
      token: env.CONSOLE_VPS3_TOKEN_FILE || path.join(seatDir(home), `.t3token-${workerHost()}`),
      ssh: env.CONSOLE_VPS3_SSH || null,
      pub: env.CONSOLE_VPS3_PUBLIC_URL || null,
      notes: `seeded from the console env; started on wake (${opsRepo()} coding)`,
      at,
    });
    for (const t of TENANT_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[];
      if (cols.length && !cols.some((c) => c.name === "tenant_id"))
        db.exec(`ALTER TABLE ${t} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}'`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS milestones_tenant ON milestones(tenant_id);
      CREATE INDEX IF NOT EXISTS personas_tenant ON personas(tenant_id);
      CREATE INDEX IF NOT EXISTS runs_tenant ON runs(tenant_id, started_at);
      CREATE INDEX IF NOT EXISTS needs_jordi_tenant ON needs_jordi(tenant_id, status, created_at);
    `);
  })();
}

export function openDb(file: string = defaultDbPath()): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  // the running runs are read every 10 s (read model, cycle); without this each read scanned every run
  db.exec("CREATE INDEX IF NOT EXISTS runs_running ON runs(outcome) WHERE outcome = 'running'");
  // the runs list (newest 500, every status poll) walked and sorted every run (80-200 ms on the worker server, ~10x on the main server)
  db.exec("CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at)");
  // the owner's name is the home world's tenant row's (a hosted layer's set value or CONSOLE_OWNER_NAME wins)
  try {
    ownerFromRow((db.prepare("SELECT owner_name FROM tenants WHERE id = ?").get(DEFAULT_TENANT) as { owner_name?: string } | undefined)?.owner_name);
  } catch {
    /* no tenants table: an old or partial database */
  }
  return db;
}
