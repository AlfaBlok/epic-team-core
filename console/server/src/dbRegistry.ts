import { ownerName, socialProduct } from "./identity.js";
/**
 * the console.db schema registry. The repo is the only source of work state and
 * decisions; console.db holds only caches rebuilt from the repo and operational data. Every table the server can create
 * is listed here, with every column, as one of:
 *
 * - `cache`: built from the repo (or a scan of it) and safe to drop; only its declared `writers` (the indexer:
 *   readModel/, the Book builder, the repo index) may INSERT / UPDATE / DELETE / REPLACE it.
 * - `ops`: operational, not work state (sign-ins, tokens, logs, queues, dedupe, scheduler state, billing).
 * - `violation`: holds work state or a decision the repo lacks (audit); `fix` names the row that removes it.
 *
 * `violationColumns` are the decision columns of an otherwise operational table, each with its fixing row. `grey` marks
 * the audit's judgement calls (kept as ops, with the row that resolves them).
 *
 * test/registry.test.ts fails on any table or column the server creates that is not here, on any entry with no
 * table, and on a new violation: the violation lists only shrink. Adding a table? Declare it `cache` (and its writer) or
 * `ops`, with a one-line reason. If it holds a decision or work state, it belongs in the repo instead (L-45).
 * Source: docs/status/e62-s1-db-audit.md.
 */
export type TableClass = "cache" | "ops" | "violation";

export interface TableEntry {
  class: TableClass;
  reason: string;
  /** violation: the row that removes it. */
  fix?: string;
  /** cache: src paths (files, or dirs ending in /) that may write it. */
  writers?: string[];
  /** ops: decision columns of an otherwise operational table, column -> fixing row. */
  violationColumns?: Record<string, string>;
  /** The audit's GREY: kept as ops; the row that resolves it, why, and the columns at issue. */
  grey?: { fix: string; why: string; columns?: string[] };
  /**
   * an index of a team-repo file. `columns` are the ones the file owns (absent = every row is the file's).
   * The rebuild proof (rebuildProof.ts) blanks them and the next boot and team-state pass must bring them back.
   */
  index?: { file: string; columns?: string[] };
  /** Every column, space separated, in table order. */
  columns: string;
}

export const DB_REGISTRY: Record<string, TableEntry> = {
  agent_tokens: { class: "ops", reason: "sign-in, roles, tokens, setup links, denied-request log", columns: "id tenant_id hash label created_at created_by last_used_at revoked_at paths persona_id" },
  ask_memory: { class: "ops", reason: "memo of the run log: the Unblocker verdict per ask fingerprint (skips a re-assessment), rebuilt from runs.open_asks + runs.checks by rebuildAskMemory; whether an ask is open or answered is the spine's", columns: "milestone_id code print parts run_id verdict why check_json assessed_at" },
  ask_wake_seen: { class: "ops", reason: "dedupe: asks a new-ask wake already fired for", columns: "milestone_id code reason run_id seen_at" },
  assignments: { class: "ops", index: { file: "state/assignments.json", columns: ["cadence", "enabled", "write_enabled", "write_scope"] }, reason: `scheduler state per (spine, persona): last/next run, retry, park, T3 task; cadence, ${ownerName()}'s switch and the write grant are an index of the world's team-repo state/assignments.json, written there first`, columns: "id milestone_id persona_id cadence enabled t3_scheduled_task_id last_run_at next_run_at created_at parked_at parked_reason write_enabled write_scope retry_at retry_run_id" },
  auth_events: { class: "ops", reason: "sign-in, roles, tokens, setup links, denied-request log", columns: "id at mode method path status reason kind tenant_id peer agent caller" },
  auth_handoffs: { class: "ops", reason: "one-time 2 min links that sign a login into its world on the other host", columns: "hash user_id tenant_id created_at expires_at used_at host" },
  auth_setups: { class: "ops", reason: "sign-in, roles, tokens, setup links, denied-request log", columns: "hash user_id created_at expires_at used_at" },
  book_cache: { class: "cache", reason: "last built Epic Book, rebuilt from the spines", writers: ["book/service.ts"], columns: "id built_at data" },
  book_refresh: { class: "ops", reason: "daily Book refresh log (pull, probe result)", columns: "at ok data" },
  deck_material: { class: "cache", reason: "each epic deck's material facts at its last line in docs/status/deck-updates.md (the card's \"what changed\" words)", writers: ["deck/notify.ts"], columns: "key fp data at" },
  browser_instances: { class: "ops", reason: "port of each world's Team Browser", columns: "tenant_id port created_at" },
  browser_sync_worlds: { class: "ops", reason: "browser sync token hash to world", columns: "token_hash tenant_id created_at" },
  chat_seen: { class: "ops", reason: `when ${ownerName()} last opened each chat`, columns: "desk_key seen_at" },
  chat_attachments: { class: "ops", reason: "files attached in Chat (the file store beside the db); the message that links them lives in the desk thread", columns: "id tenant_id name mime bytes file sha256 created_at sent_at" },
  credit_accounts: { class: "ops", reason: "billing balances", columns: "tenant_id since gate balance_mc monthly_grant_mc grant_day last_grant_at last_grant_mc crossing_id notice_crossing notice_id updated_at" },
  credit_ledger: { class: "ops", reason: "billing ledger", columns: "id tenant_id at kind millicredits run_id box_session_id price_key model notional usd note actor" },
  cycle_assignment_link: { class: "ops", reason: "home thread, project, seat, host, sync state per assignment", columns: "assignment_id project_id thread_id seat sync_state sync_error pending_run_id setup_started_at host tool_fp" },
  cycle_bootstrap: { class: "ops", reason: "log of a bootstrap request (the run writes the spine)", columns: "milestone_id run_id kind goal created_at" },
  cycle_handover: { class: "ops", reason: "idempotency of a handover thread", columns: "client_request_id host thread_id project_id title repo epic created_at" },
  cycle_run_steer: { class: "ops", reason: "send log of steers into a running thread", columns: "run_id at mode message" },
  cycle_priority_session: { class: "ops", reason: "priority mode switch: which rows hold the machine and since when (run control, like Stop)", columns: "id rows by reason started_at assignments ended_at ended_by end_why" },
  cycle_priority_park: { class: "ops", reason: "the sessions priority mode parked and how each was resumed (run log)", columns: "session_id run_id kind ticket assignment_id parent_run_id thread_id rank state parked_at resume_run_id resumed_at note" },
  cycle_priority_log: { class: "ops", reason: "every park and resume line (run log)", columns: "id session_id at event run_id ticket detail" },
  cycle_seat_hold: { class: "ops", reason: "seat held by a bootstrap run or a console-launched worker", columns: "run_id seat" },
  cycle_worker_launch: { class: "ops", reason: "launch spec of a worker the console starts on the main server for a refused pick (incident override only), kept for its deferred retries", columns: "run_id ticket title brief model created_at" },
  desk_outbox: { class: "ops", reason: "chat sends queued while T3 was down", columns: "seq desk_key client_request_id text page message created_at sent_at thread_id failed_at error" },
  desk_placement: { class: "ops", reason: "what the desk placed in the tree and when its note was sent (placed/delivered/dropped is read from the spine on every read)", columns: "id repo path kind item_id title placed_at noted_at note_error tenant_id" },
  desk_view_cache: { class: "cache", reason: "last view of each chat, read back from its T3 thread; safe to drop, rebuilt on the next read", writers: ["desk/session.ts"], columns: "desk_key thread_id view updated_at" },
  desk_session: { class: "ops", reason: "chat thread per desk key", columns: "seq thread_id project_id seat created_at ended_at end_reason seed_version desk_key tenant_id host" },
  desk_voice_hooks: { class: "ops", reason: "voice-note relay state, poll cursors, hook dedupe", columns: "evidence_ref received_at result" },
  desk_voice_meta: { class: "ops", reason: "voice-note relay state, poll cursors, hook dedupe", columns: "key value" },
  desk_voice_notes: { class: "ops", reason: "voice-note relay state, poll cursors, hook dedupe", columns: "evidence_ref captured_at url state reason seen_at posted_at tries archived_at via hook_at" },
  gateway_picks: { class: "ops", reason: "dispatcher picks per world, for load", columns: "id tenant_id instance picked_at done_at" },
  hosts: { class: "ops", reason: "host registry seeded from env", columns: "id tenant_id kind provider t3_mcp_url token_file ssh public_console_url memory_floor_mb notes created_at" },
  laptop_sessions: { class: "ops", reason: "the I'm on my laptop switch, a few hours of UI state (on since, until, ended); what the team must know goes to the Team desk", columns: "id since until by ended_at ended_by" },
  jordi_responses: { class: "ops", reason: `delivery and answer-job log of ${ownerName()}'s answers (never the source of answered; the spine's [answered] line is)`, columns: "id item_id milestone_id item kind text assignment_id thread_id delivery delivery_error created_at delivered_at spine_status spine_reason spine_sha spine_path spine_at replaces_id wake_status wake_run_id wake_reason via chat_text client_key job_state job_attempts job_error job_next_at job_wake tenant_id settles" },
  mail_caps: { class: "ops", index: { file: "state/access.json" }, reason: "daily send cap per persona: an index of the world's team-repo state/access.json, written there first", columns: "persona_id daily_cap updated_at" },
  mail_inbound: { class: "ops", reason: "mail send log, inbound relay state, cursors", columns: "message_id uid from_addr subject received_at state reason seen_at posted_at tries row_code" },
  mail_meta: { class: "ops", reason: "mail send log, inbound relay state, cursors", columns: "key value" },
  login_reads: { class: "ops", reason: "each time the Team Browser's sign-in act asked to read one of the team's own stored logins: who, which account, which run, granted or refused; no value", columns: "id at run_id persona_id persona_name account store_name outcome detail" },
  mail_reads: { class: "ops", reason: "mailbox read log: who searched, read or fetched an attachment, shown on the Services page", columns: "id at run_id via persona_id persona_name tool what outcome detail" },
  mail_sends: { class: "ops", reason: "mail send log, inbound relay state, cursors", columns: "id at run_id persona_id persona_name recipients subject outcome detail message_id" },
  mcp_access: { class: "ops", index: { file: "state/access.json" }, reason: "per-persona on/off for each service: an index of the world's team-repo state/access.json, written there first", columns: "service_id persona_id allowed updated_at" },
  treg_calls: { class: "ops", reason: "spend ledger of treg reads through the console: who, why, which endpoint, cost from treg's header, refusals and budget stops; no results", columns: "id at day tenant_id persona_id run_id source endpoint purpose status cost_usd call_id served_by outcome detail" },
  treg_digests: { class: "ops", reason: "the console's Mon/Wed/Fri treg pass, top items per read; bought data, kept as the free digest", columns: "day at cost_usd json" },
  mcp_hub_calls: { class: "ops", reason: "call log of the services hub: who called (caller kind, credential id, seat, session, thread, run, persona), which service and tool, outcome; no arguments or results", columns: "id at tenant_id caller_kind credential seat session thread_id run_id persona_id tool service service_tool outcome detail" },
  mcp_service_secrets: { class: "ops", reason: "where each service secret lives (app + name, no value)", columns: "service_id field app name set_at set_by" },
  mcp_services: { class: "ops", reason: "services registry (config; secrets live elsewhere)", columns: "id tenant_id key name kind config builtin shared created_at created_by" },
  memberships: { class: "ops", reason: "sign-in, roles, tokens, setup links, denied-request log; handle = which People handle a login is (the People list itself is the root spine's)", columns: "user_id tenant_id role created_at handle" },
  people_seen: { class: "ops", reason: "which Know cards a person pressed Seen on (a read mark, like chat_seen; the outcome is the spine's answered line)", columns: "tenant_id handle card seen_at" },
  messages: { class: "ops", reason: `send log of what ${ownerName()} sent into persona threads`, columns: "id milestone_id assignment_id kind text ref_item_id thread_id delivery delivery_error created_at tenant_id" },
  milestones: { class: "ops", index: { file: "state/milestones.json + state/big-roots.json", columns: ["title", "owner", "paused", "settled_at", "title_set_at", "big_root"] }, reason: "index of the world's team-repo state/milestones.json (tracked spines, name, owner, paused, settled) and state/big-roots.json (big_root); every change is written there first and the file is applied back on each pass", columns: "id title repo path owner paused created_at settled_at title_set_at big_root tenant_id" },
  needs_jordi: { class: "ops", reason: "log of asks raised through POST /needs-owner, each a coded line in its spine (rows superseded by <repo>/<code>); the read path never reads it", columns: "id run_id milestone_id question proposed_action status created_at superseded_by superseded_at tenant_id" },
  personas: { class: "ops", index: { file: "state/personas/<name>.md", columns: ["name", "remit", "skills", "model", "host", "provider", "may_write", "fresh_thread_each_wake", "skip_unchanged"] }, reason: "index of the world's team-repo persona files (state/personas/<name>.md): every change is written there first and the files are applied back on each pass; ids kept for the run log", columns: "id name remit skills model may_write created_at host fresh_thread_each_wake skip_unchanged tenant_id provider" },
  provider_threads: { class: "ops", reason: "provider + model a home thread launched on", columns: "thread_id provider provider_instance model price_key notional at" },
  indexer_queue: { class: "ops", reason: "what the console asks of its indexer process (a checkout changed, a view, a drift check, a book rebuild); taken and deleted by it within a second", columns: "id msg at" },
  indexer_kv: { class: "ops", reason: "the indexer's heartbeat and drift result, the console's T3 states for it, each repo's book commits as of its HEAD, the git blame and first-added answers of the waiting views, when the console's hourly KPI read and drift check last ran", columns: "k v at" },
  spines_cache: { class: "cache", reason: "the last spines.py output per checkout, so the console never runs spines.py and a restart re-reads only moved checkouts (and only when read by the same scanner)", writers: ["indexer/"], columns: "dir json ver started_at ran_at scanner" },
  read_model: { class: "cache", reason: "computed views, rebuilt from the repo by the refresher", writers: ["readModel/"], columns: "key payload as_of checked_at read_at computed_ms" },
  repo_index: { class: "cache", reason: "scan of the checkouts on each host (scripts/repo_index.py)", writers: ["desk/repoIndex.ts"], columns: "host name data" },
  repo_index_scan: { class: "ops", reason: "when each host was last scanned, error", columns: "host at ok_at error" },
  review_agent_wake: { class: "ops", reason: `dedupe: review rows the gate kept from ${ownerName()} that already woke their Delivery manager`, columns: "item_key milestone_id run_id seen_at" },
  presses: { class: "ops", reason: "press log and outbox: each button press, its tries and result; a press only waits here until it lands in the repo (root L-45), then it is its log line", columns: "id at action target who via route state result reason attempts tries next_at landed_at ms sha http_status ref request response client_key tenant_id" },
  review_live: { class: "cache", reason: "live check of each review link (URL + commit); a recomputable check, safe to drop", writers: ["review/review.ts"], columns: "url commit_sha ok status error checked_at" },
  rubric_wake: { class: "ops", reason: "audit log: the rubric a run was judged by", columns: "run_id json" },
  runs: { class: "ops", reason: "wake log: outcome, summary, usage, flags (a monitoring report writes the spine's Monitoring: line; status never reads monitoring from here)", columns: "id assignment_id milestone_id started_at ended_at seat thread_id outcome summary parent_run_id persona_id kind retry_at instructions environment_id checks instructions_by open_asks ask_fingerprint usage usage_checked_at usage_note next_check_at monitor_until reported_outcome held_on self_readied note_ack pre_wake ready_ignored repeating repeat_since stalled wake_parts woke_because rule_broken start_fingerprint start_guard client_request_id deferred launch_host usage_live host tenant_id provider provider_instance model price_key notional" },
  sessions: { class: "ops", reason: "sign-in, roles, tokens, setup links, denied-request log", columns: "id_hash user_id tenant_id created_at expires_at last_seen_at" },
  social_digest_sent: { class: "ops", reason: "digest send dedupe", columns: "tenant_id repo date sent_at error" },
  staging_meta: { class: "ops", reason: "when the staging copy was made, scrub report", columns: "key value" },
  stripe_events: { class: "ops", reason: "Stripe webhook dedupe", columns: "id type at result" },
  team_subscriptions: { class: "ops", reason: "billing ledger of Epic Team plan subscriptions; source Stripe (Epic Team's own account, its signed webhook), the plan via setPlan, a desk note per change (not spine work)", columns: "tenant_id subscription customer email status livemode started_at updated_at" },
  t3_environments: { class: "ops", reason: "T3 environment id per host", columns: "host environment_id read_at" },
  tenant_moves: { class: "ops", reason: "undo log of a world move", columns: "seq move_id tbl row_key col old_value new_value at" },
  tenants: { class: "ops", reason: "worlds: skin, plan, world pause, default provider/model (account config)", columns: "id name skin plan owner_handle owner_name repos_root secrets_backend box_provider paused created_at default_provider default_model" },
  oauth_identities: { class: "ops", reason: "which Google or GitHub account is which login (sign-ins), and the world a sign-up made", columns: "provider subject user_id email created_at last_used_at signup_world" },
  youtube_connect: { class: "ops", reason: "when the team's YouTube Allow last stored its keys and for which channel (names only; the keys are in the secret store)", columns: "id channel at" },
  step_pages: { class: "ops", reason: "a steps page's per-page token (the credential its Done switches send) and where its ticks go; the ticks themselves are Decisions rows in the owning spine", columns: "id token title url repo spine world created_by created_at" },
  step_secrets: { class: "ops", reason: "which key name a steps page's private box may write (app, NAME) and the provide ask that approves it, whether it is a file box; never a value", columns: "page_id step app name ask replace_ok file" },
  step_secret_log: { class: "ops", reason: "one names-only line per key pasted on a steps page (who, which page and step, app NAME, ask, stored or refused and why); never a value", columns: "id at world page_id page_title step app name ask outcome detail" },
  step_changes: { class: "ops", reason: "a queue: a step change between its tap and its commit in the owning spine (the spine is the record, L-45), then its wake's retries until a run starts", columns: "id page_id step state words title row_ref ask_ref status reason sha state_change created_at filed_at file_attempts file_next_at wake wake_mid wake_note wake_run wake_attempts wake_next_at wake_error wake_at" },
  step_questions: { class: "ops", reason: "a message queue between a Mac ticket's agent and the team (its question, the answer it polls, the wake's retry), like Chat; a decision the answer makes goes into the spine by the persona that answers (L-45)", columns: "id page_id row_code question state asked_at answer answered_at answered_by milestone_id wake wake_run wake_error wake_at" },
  feedback_links: { class: "ops", reason: "voice feedback links (a token per recipient, who, product, campaign); access credentials like setup links", columns: "id token world who product campaign created_at created_by revoked_at" },
  feedback_notes: { class: "ops", reason: "voice feedback pipeline (recording, transcript until filed, cost, filing state); the item itself is the file in the world's repo feedback/voice/", columns: "id link_id world started_at finished_at state seconds cost_usd transcript structure file sha repo file_error told_at" },
  feedback_segments: { class: "ops", reason: "voice feedback parts' text and cost (no audio is kept)", columns: "note_id n at seconds text cost_usd" },
  site_views: { class: "ops", reason: "daily view counts of epicspine.dev's pages and of the public code on GitHub (site telemetry, counts only, not spine work)", columns: "day page n" },
  site_visits: { class: "ops", reason: "one row per counted visit of epicspine.dev's pages: time, page, source (post id, referring host or direct), test flag; nothing about the visitor (site telemetry; the daily line in data/site-daily.md is the record)", columns: "id at day page source referrer test" },
  site_referrers: { class: "ops", reason: "each site GitHub names as referring visitors to the public code page, with the first day it was read (backlinks; site telemetry, counts only)", columns: "host first_day via" },
  tester_signups: { class: "ops", reason: "customer records from the public pages: sign-ups, payments, world setup steps (not spine work)", columns: "id email name use_case plan source created_at updated_at notified offer answers seen_at world_id payment paid_at world_at world_steps stripe_customer stripe_subscription cancelled_at browser_login visit_source site" },
  ticket_session: { class: "ops", reason: "thread per ledger row (Discuss)", columns: "seq milestone_id repo spine_path row_id row_key thread_id project_id persona_id persona_name fell_back seat created_at archived_at archive_reason tenant_id" },
  users: { class: "ops", reason: "sign-in, roles, tokens, setup links, denied-request log", columns: "id email name pw_hash created_at disabled_at" },
  voice_asks: { class: "ops", reason: "voice on/off and budget, call usage, requests sent to the desk during a call", columns: "id call_id n request head sent_at send_error answered_at answer kind" },
  voice_calls: { class: "ops", reason: "voice on/off and budget, call usage, requests sent to the desk during a call, its transcript for the next call's 24 h recall", columns: "id started_at last_beat_at ended_at end_reason model text_in text_cached_in audio_in audio_cached_in text_out audio_out tr_in tr_out responses cost_usd session_id transcript_posted_at transcript_error tenant_id milestone_id brief_tokens transcript recall_tokens jordi_words" },
  voice_note_segments: { class: "ops", reason: "voice-note recording pipeline, transcripts, cost", columns: "note_id n at mime file bytes seconds text usage cost_usd error" },
  voice_note_spills: { class: "ops", reason: "a voice note filed on one item, its model check and the one Team desk line with the rest; retries; runtime plumbing like desk_outbox", columns: "note_id tenant_id milestone_id at page state rest line tries next_at told_at error" },
  desk_crossings: { class: "ops", reason: `a part of ${ownerName()}'s desk message passed to his other desk (EpicTeam ↔ ${socialProduct()}), its model check, the line, retries; runtime plumbing like voice_note_spills`, columns: "id msg_key from_world to_world at state about quote line note tries next_at passed_at note_at noted_at said_head error" },
  voice_note_touches: { class: "ops", reason: `one pass per long voice note of ${ownerName()}'s, which inbox cards it marked (the marks themselves are Decisions lines in the spines, L-45) and whose owner it woke; runtime plumbing like voice_note_spills`, columns: "note_key tenant_id at spoken_at words state touched error" },
  voice_notes: { class: "ops", reason: "voice-note recording pipeline, transcripts, cost", columns: "id tenant_id milestone_id started_at finished_at state seconds cost_usd page transcript posted_at post_error start_ms" },
  voice_settings: { class: "ops", reason: "voice on/off and budget, call usage, requests sent to the desk during a call", columns: "key value" },
  voice_usage: { class: "ops", reason: "voice on/off and budget, call usage, requests sent to the desk during a call", columns: "call_id event_id kind at usage" },
  wa_meta: { class: "ops", reason: "WhatsApp notice dedupe and send log", columns: "key value" },
  wa_notices: { class: "ops", reason: "WhatsApp notice dedupe and send log", columns: "key kind first_seen_at sent_at seeded" },
  wa_key_results: { class: "ops", reason: "the colour of each objective's key result the owner was last told on WhatsApp (dedupe of the green or red line)", columns: "key objective label state value note done_means test told_state told_value seen_at changed_at" },
  wa_sends: { class: "ops", reason: "WhatsApp notice dedupe and send log (via: console or the persona that holds whatsapp-notify)", columns: "id at kind items ok receipt error via" },
  push_subs: { class: "ops", reason: "phone notification subscriptions per login", columns: "id tenant_id user_id endpoint p256dh auth device created_at last_ok_at last_error" },
  push_sends: { class: "ops", reason: "phone notification send log", columns: "id at kind keys subs ok error" },
  push_meta: { class: "ops", reason: "phone notification desk cursor", columns: "key value" },
  wake_gate_prints: { class: "ops", reason: "fingerprints of social inboxes for the pre-wake check", columns: "assignment_id prints updated_at" },
  world_secret_log: { class: "ops", reason: "encrypted secret vault, readers, audit log", columns: "seq at tenant_id verb target by detail" },
  world_secret_readers: { class: "ops", reason: "encrypted secret vault, readers, audit log", columns: "tenant_id app name path switched_at" },
  world_secrets: { class: "ops", reason: "encrypted secret vault, readers, audit log", columns: "tenant_id app name iv tag ct fp key_id prev_iv prev_tag prev_ct prev_fp cls provider source set_at set_by" },
};

/** Tables that exist only inside one migration (created, copied and renamed in the same step): never in a booted DB. */
export const TRANSIENT_TABLES: Record<string, string> = {
  messages_v2: "db.ts migration temp, renamed to messages",
};

/** a hosted layer's own tables (its sign-ins, outboxes and logs), added to the registry when it loads */
export function registerTables(entries: Record<string, TableEntry>): void {
  for (const [table, entry] of Object.entries(entries)) {
    if (DB_REGISTRY[table]) throw new Error(`db registry: ${table} is already registered`);
    DB_REGISTRY[table] = entry;
  }
}

export const registryColumns = (table: string): string[] => (DB_REGISTRY[table]?.columns ?? "").split(/\s+/).filter(Boolean);
export const indexTables = (): string[] => Object.keys(DB_REGISTRY).filter((t) => DB_REGISTRY[t]!.index);
export const cacheTables = (): string[] => Object.keys(DB_REGISTRY).filter((t) => DB_REGISTRY[t]!.class === "cache");
export const violationTables = (): string[] => Object.keys(DB_REGISTRY).filter((t) => DB_REGISTRY[t]!.class === "violation");
export const violationColumns = (): string[] =>
  Object.entries(DB_REGISTRY).flatMap(([t, e]) => Object.keys(e.violationColumns ?? {}).map((c) => `${t}.${c}`));
