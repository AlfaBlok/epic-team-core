import { NEWEST_HEAD } from "../desk/hisObjectives.js";
import { z } from "zod";
import type { DB } from "../db.js";
import { FINISH_THE_JOB_RULE, REPO_IS_SOURCE_RULE, STEPS_PAGE_RULE, VISUAL_FIRST_RULE } from "../inbox/asks.js";
import { WORKER_FINISH_RULE, WORKER_TIER_RULE } from "./prompts.js";
import { deckBriefLine } from "../wakePrompt.js";
import { mainHost, workerHost } from "../identity.js";
import { CONTEXT_HEAD } from "./ticketContext.js";

/**
 * the worker route below refuses
 * (409 `vps1_workers_off`) unless the incident override `CONSOLE_CAP_FALLBACK=1` is set; this is its answer.
 */
export const workersOffText = (): string =>
  `the console work queue needs ${workerHost().toUpperCase()} configured on this console (CONSOLE_VPS3_SSH and its dispatcher); worker launches on ${mainHost()} are off (${mainHost().toUpperCase()} serves production first). ` +
  `Dispatch on ${workerHost().toUpperCase()} with \`$EPICSPINE_DISPATCHER pick\` and delegate_task; if pick returns a null id, say queued in your summary. Incident override: CONSOLE_CAP_FALLBACK=1 on the console.`;

/**
 * the console's work queue. A manager whose own pick was refused hands the row here; the console launches it on
 * the worker server through that host's own pick the moment there is room (cycle/workQueue.ts), else (incident override,
 * no worker server) on the main server. Older text:
 * the console launches a worker on the main server for a manager whose own pick was refused (the worker server at its load or memory
 * cap, the main server with room: the worker server dispatcher answers `fallback: "console"`). `POST /api/runs/<wake run id>/workers`
 * records one child run of that wake (idempotent per clientRequestId), picks the main server seat (the main server's memory,
 * load and session gates), and launches a top-level T3 thread on the main server in the milestone repo with the manager's
 * brief. A retryable refusal defers the child run (backoff 1, 2, 4, 8, then every 10 min; gives up after
 * 60 min); the console retries it itself. The worker PATCHes its own child run when it finishes, because its
 * completion does not reach the manager's thread (no delegate_task parent).
 */
export const workerLaunchIn = z
  .object({
    /** the ledger row the worker works on, e.g. `E9-2h` (starts the child run summary) */
    ticket: z.string().trim().min(1).max(80),
    /** the brief the manager would have given delegate_task; `<child run id>` is replaced with the child run's id */
    brief: z.string().trim().min(1).max(30_000),
    /** a short line for the run summary and the thread title */
    title: z.string().trim().max(200).optional(),
    clientRequestId: z.string().trim().min(1).max(120),
    /** the model the worker should run (default: the persona's) */
    model: z.string().trim().max(80).optional(),
  })
  .strict();
export type WorkerLaunchInput = z.infer<typeof workerLaunchIn>;

export function migrateWorkerLaunch(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycle_worker_launch (
      run_id TEXT PRIMARY KEY,
      ticket TEXT NOT NULL,
      title TEXT,
      brief TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

type Row = Record<string, string | null>;
export const getWorkerLaunch = (db: DB, runId: string) =>
  db.prepare("SELECT * FROM cycle_worker_launch WHERE run_id = ?").get(runId) as Row | undefined;
export const saveWorkerLaunch = (db: DB, runId: string, i: WorkerLaunchInput, at: string) =>
  db
    .prepare("INSERT OR IGNORE INTO cycle_worker_launch (run_id, ticket, title, brief, model, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(runId, i.ticket, i.title ?? null, i.brief, i.model ?? null, at);

export const workerSummary = (ticket: string, title?: string | null, host: string = mainHost()) => `${ticket} ${title || "worker"} (console launch on ${host})`;
export const workerThreadTitle = (ticket: string, title?: string | null) => `${ticket}: ${title || "worker"}`.slice(0, 120);

/** The first message of the worker's thread: the manager's brief plus how this worker reports (it has no parent thread). */
export function workerMessage(o: { base: string; runId: string; parentRunId: string; ticket: string; brief: string; deckUrl?: string; where?: string; context?: string; newest?: string }): string {
  const h = "-H 'content-type: application/json'";
  const brief = o.brief.split("<child run id>").join(o.runId);
  return [
    // the milestone's deck first, unless the manager's brief already names it.
    ...(o.deckUrl && !brief.includes(o.deckUrl) ? [deckBriefLine(o.deckUrl), ""] : []),
    // then the ticket's context to read first, unless the manager's brief already opens with it.
    ...(o.context && !brief.includes(CONTEXT_HEAD) ? [o.context] : []),
    // then his newest words on the objectives the brief names, older ones marked replaced or stands.
    ...(o.newest && !brief.includes(NEWEST_HEAD) ? [o.newest] : []),
    brief,
    "",
    `## Console protocol (child run ${o.runId} of wake ${o.parentRunId}, launched by the console on ${o.where ?? mainHost()})`,
    `You work ticket ${o.ticket}. End every commit message with the trailer line \`Run: ${o.runId}\`.`,
    `Your report goes to the console, not to a parent thread: as your last step PATCH your run: \`curl -sS -X PATCH ${o.base}/api/runs/${o.runId} ${h} -d '{"outcome":"progressed|blocked|monitoring|idle|failed","summary":"${o.ticket} <one line>","endedAt":"<ISO-8601 UTC now>"}'\`.`,
    WORKER_FINISH_RULE,
    REPO_IS_SOURCE_RULE,
    WORKER_TIER_RULE,
    FINISH_THE_JOB_RULE,
    STEPS_PAGE_RULE,
    VISUAL_FIRST_RULE,
  ].join("\n");
}
