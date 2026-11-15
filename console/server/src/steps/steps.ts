import { randomBytes } from "node:crypto";
import { phantomBoxSteps, phantomStepsProblem } from "../inbox/phantomRefs.js";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { currentAuth } from "../auth/identity.js";
import { ATTACH_MAX_BYTES, AttachError, splitCardFiles } from "../desk/attachLimits.js";
import { oneLine, type SpineWrite, type SpineWriter } from "../inbox/spineWrite.js";
import { copyPasteInHtml, copyPasteProblem, type CopyPasteBlock } from "./copyPaste.js";
import { addDecisionRow } from "../review/followups.js";
import { secureCopyOf } from "./secureLinks.js";
import { fileValueProblem, MAX_FILE, scrub } from "../plug/keys.js";
import type { PasteKey } from "../inbox/routes.js";
import { isAskCode } from "../inbox/asks.js";
import { deployerName, keyIndexFile, ownerName } from "../identity.js";

/**
 * steps pages with feedback built in. A page that gives the owner steps
 * (accounts, keys, setups) includes the console's kit (web/public/steps-kit.js +.css) and marks each step in its HTML
 * (`data-step`, and `data-row` or `data-ask`); the kit gives every step a Done switch. A tick:
 *  1. writes one Decisions row in the page's owning spine, marked `[step-done <page>/<step>]` (root L-45: the repo is
 *     the record; a reload reads the ticks back from that file, never from the browser);
 *  2. posts one `[step done]` line in the world's Team desk chat ("Done: <step> on <page>");
 *  3. wakes the owner of the waiting row or ask: the milestone's Delivery manager, through Run now (its live session
 *     gets it queued, cycle start guard), told to start the row's next run now.
 * Untick undoes it the same way: the row is taken out of the spine, the desk is told, the owner is woken to hold.
 *
 * a switch answers at once. The change is saved in the console db (`step_changes`) and the page says "saved,
 * filing to the repo"; the filer writes the changes to the spine in order in the background (a change taken back within
 * FILE_DELAY_MS files nothing), and the page says "in the repo" when the commit lands; the spine stays the record (L-45),
 * the db row only carries a change until then. The owner's wake is recorded with the change and tried until a run
 * starts (backoff, at most one run per change; a newer change of the step cancels a wake not yet started); the console
 * lists what is still on its way (`GET /api/steps/changes`, the kit under each step).
 *
 * Who may tick: a page registered here gets a per-page token (`step_pages`, ops: a credential like a feedback link);
 * the kit sends it, so a page served anywhere on the tailnet works without a console cookie and a stranger without the
 * token cannot tick (`/api/public/steps/<token>`). On the console's own pages the owner's session may tick by page id
 * (`/api/steps/pages/<id>/ticks`, a session only, never an agent token).
 *
 * a step that needs a
 * key has a private, write-only box beside its switches. The page registers each such step once with its key's name and
 * the coded `provide` ask that approves it (`secrets: [{step, app, name, ask, replace?}]` on POST /api/steps/pages); the
 * page's token may write only those names. A paste goes through the ask card's own key path (inbox `pasteKey`: the ask
 * must be open and name that `<app> <NAME>`, its answered line and the infra repo approval mirror are written, then
 * `secret put --stdin`), then the step is switched Done. An open ask that names no single key (a `do` ask whose step has
 * several, like's Client ID and secret) stores the Secrets page way instead (`addKey`: an `[answered SK-<n>]` line
 * in docs/secrets/added-by-owner.md citing the page and ask, store only). A step may have several boxes; it switches Done
 * when all of them hold a value. Never echoed, logged or stored here; a name already holding a value is refused unless
 * the box says `replace`; SECRET_TRIES_PER_HOUR per page; every try is one names-only line in `step_secret_log` (the
 * Services page lists them).
 *
 * a key that is a file (a Google service-account JSON key, several lines) gets a file box instead: the page
 * registers it with `file: true` and marks the step `data-secret-file="<app> <NAME>"`; the owner picks the file and one press
 * stores the whole file as the value through the same path (`secret put --multiline`, store only: the app platform env holds one
 * line per name) and ticks Done. At most MAX_FILE; a name that says JSON must hold a JSON object. Same rules as a paste.
 */

export const STEP_DESK_MARKER = "[step done]";
const PAGE_ID = /^sp_[a-f0-9]{8}$/;
const STEP_ID = /^[A-Za-z0-9][\w.-]{0,39}$/;
const REF = /^[A-Z][A-Za-z0-9]*(?:-\d+)?-[A-Z]?\d+[a-z]?$/; // T-A3, v2
// any repo-relative.md path, not only docs/spines/ (other worlds keep spines elsewhere, e.g. tax-assist-research's
// docs/EPIC_SPINE.md); it must stay inside the checkout, and a file outside docs/spines/ must read as a spine (isSpine).
const SPINE = /^(?!\/)[\w.-]+(?:\/[\w.-]+)*\.md$/;
/** A spine as spines.py finds one: a `## Current State` section, or a `Spine Type:` / `Root spine:` / `Parent spine:` header line. */
export const isSpine = (text: string): boolean =>
  /^## Current State[ \t]*$/m.test(text) || /^(?:Spine Type|Root spine|Parent spine):[ \t]*\S/m.test(text.split(/^## /m)[0]);
const APP = /^[a-z0-9][a-z0-9-]{0,80}$/; // as the infra repo `secret`
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** key pastes per page per hour (tries, stored or not). */
export const SECRET_TRIES_PER_HOUR = 6;
/** at most this many private boxes on one page. */
export const SECRETS_PER_PAGE = 8;
/** Writes per page per minute (a held-down switch never makes a commit storm). */
export const STEP_WRITES_PER_MIN = 12;

export interface StepPage {
  id: string;
  token: string;
  title: string;
  url: string;
  repo: string;
  spine: string;
  world: string;
  createdBy: string;
  createdAt: string;
}

/** a step's private box: which key it writes and the ask that approves it. */
export interface StepSecret {
  step: string;
  app: string;
  name: string;
  ask: string;
  replace: boolean;
  /** a file box (the whole file is the value); absent = a one-line paste. */
  file?: true;
}

export function ensureStepPages(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS step_secrets (
      page_id TEXT NOT NULL,
      step TEXT NOT NULL,
      app TEXT NOT NULL,
      name TEXT NOT NULL,
      ask TEXT NOT NULL,
      replace_ok INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (page_id, step, name)
    );
    CREATE TABLE IF NOT EXISTS step_secret_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      world TEXT NOT NULL,
      page_id TEXT NOT NULL,
      page_title TEXT NOT NULL,
      step TEXT NOT NULL,
      app TEXT NOT NULL,
      name TEXT NOT NULL,
      ask TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS step_pages (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      repo TEXT NOT NULL,
      spine TEXT NOT NULL,
      world TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // file boxes (a JSON key file); older dbs get the column.
  if (!(db.prepare("PRAGMA table_info(step_secrets)").all() as { name: string }[]).some((c) => c.name === "file")) db.exec("ALTER TABLE step_secrets ADD COLUMN file INTEGER NOT NULL DEFAULT 0");
}

export type StepState = "todo" | "done" | "stuck";
const STATE_MARK = { done: "step-done", stuck: "step-stuck" } as const;
export const NOTE_MARK = "step-note";
const markOf = (kind: string, page: string, step: string) => `[${kind} ${page}/${step}]`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Words longer than this are cut in the Decisions cell (it stays readable); the full note is a file beside it. */
export const WORDS_MAX = 600;
/**
 * a note has no length limit
 * on the page; the server keeps a sane cap and stores the whole text in the repo (noteFileOf), the spine line quotes its start.
 */
export const NOTE_MAX = 200_000;
/** The note's words for a spine line, a desk line or the page: one line, at most WORDS_MAX, no double quote. */
export const shortWords = (w: string): string => {
  // a note's screenshots (the files line) stay whole after the shortened words, so their links still open
  const { words, files } = splitCardFiles(w);
  const one = oneLine(words).replace(/"/g, "'");
  const cut = one.length > WORDS_MAX ? `${one.slice(0, WORDS_MAX).trimEnd()}…` : one;
  return files ? `${cut}${cut ? " " : ""}${oneLine(files)}` : cut;
};
/** A note too long for a spine line is filed whole as text in the owning repo. */
export const isLongNote = (w: string | undefined): w is string => !!w && oneLine(w).length > WORDS_MAX;
export const noteFileOf = (page: string, step: string, id: number) => `docs/step-notes/${page}/${step}-${id}.txt`;

/** A page whose title starts with TEST is a test: its ticks never read as the owner's (root L-46). */
export const isTestPage = (p: Pick<StepPage, "title">) => /^TEST\b/.test(p.title);
const who = (p: Pick<StepPage, "title">) => (isTestPage(p) ? `TEST tick (not ${ownerName()})` : ownerName());

export interface StepStatus {
  state: "done" | "stuck";
  at: string;
  words?: string;
}
export interface StepNote {
  at: string;
  words: string;
}

const dateOf = (line: string) => /^\|\s*(\d{4}-\d{2}-\d{2})/.exec(line.trim())?.[1] ?? "";
/**
 * his words from the cell that holds them, whichever column that is: a spine whose Decisions table has another shape
 * (an extra date column) kept them one cell further on, and every note there read as empty.
 */
const wordsOf = (line: string) => {
  const cell = line.split(" | ").find((c) => c.includes('his words: "'));
  return cell ? /his words: "(.*)"/.exec(cell)?.[1] : undefined;
};

/** Every step of `page` in this spine text: its state row (done or stuck; none = not started) and its notes, oldest first. */
export function stepsIn(text: string, page: string): { steps: Record<string, StepStatus>; notes: Record<string, StepNote[]> } {
  const steps: Record<string, StepStatus> = {};
  const notes: Record<string, StepNote[]> = {};
  const re = new RegExp(`\\[(${STATE_MARK.done}|${STATE_MARK.stuck}|${NOTE_MARK}) ${esc(page)}/([\\w.-]+)\\]`);
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const m = re.exec(line);
    if (!m) continue;
    const words = wordsOf(line);
    // a note row with no words kept is no note to show: never a dated line with nothing after it.
    if (m[1] === NOTE_MARK) {
      if (words?.trim()) (notes[m[2]] ??= []).push({ at: dateOf(line), words });
    }
    else steps[m[2]] = { state: m[1] === STATE_MARK.done ? "done" : "stuck", at: dateOf(line), ...(words ? { words } : {}) };
  }
  return { steps, notes };
}

/** The steps of `page` marked done (the first kit's view; kept for pages that read `ticks`). */
export function ticksIn(text: string, page: string): Record<string, { at: string }> {
  return Object.fromEntries(Object.entries(stepsIn(text, page).steps).filter(([, s]) => s.state === "done").map(([k, s]) => [k, { at: s.at }]));
}

export interface StepTick {
  page: Pick<StepPage, "id" | "title" | "url">;
  step: string;
  title: string;
  row?: string;
  ask?: string;
}

const waitsOf = (t: Pick<StepTick, "row" | "ask">) => [t.row, t.ask].filter(Boolean).join(" and ");
export const stateOf = (text: string, page: string, step: string): StepState => stepsIn(text, page).steps[step]?.state ?? "todo";
const LABEL: Record<StepState, string> = { done: "Done", stuck: "Stuck", todo: "Not started" };

/**
 * The spine text after the owner set this step to `state` with `words` (optional): a state change replaces the step's state
 * row (done and stuck have one, not started has none); words that come with Done or Not started, or with no change, are a
 * note row of their own. What changed: `state`, `note` or both. Skips when nothing changes or there is no Decisions table.
 */
export function applyStep(text: string, t: StepTick, to: StepState, words: string | undefined, date: string, at?: string): { text: string; changed: { state: boolean; note: boolean } } | { skip: string } {
  const from = stateOf(text, t.page.id, t.step);
  // the time he left it and the row it is about, so the row's inbox card can show his note (review/pageNotes.ts)
  const hm = at ? /T(\d{2}:\d{2})/.exec(at)?.[1] : undefined;
  const tag = `${hm ? ` at ${hm}Z` : ""}${waitsOf(t) ? `${hm ? "," : ""} for ${waitsOf(t)}` : ""}`;
  const stateChange = from !== to;
  const noteRow = !!words && !(stateChange && to === "stuck");
  if (!stateChange && !words) return { skip: `already ${LABEL[to].toLowerCase()} in the spine` };
  let out = text;
  const waits = waitsOf(t);
  const by = who(t.page);
  const said = words ? `; his words: "${words}"` : "";
  const add = (decision: string, summary: string) => {
    const next = addDecisionRow(out, { date, outcome: "accepted", decision, summary, evidence: t.page.url, revisit: "the step changes" });
    if (next === undefined) return false;
    out = next;
    return true;
  };
  if (stateChange) {
    const marks = [STATE_MARK.done, STATE_MARK.stuck].map((k) => markOf(k, t.page.id, t.step));
    out = out.split("\n").filter((l) => !(l.trim().startsWith("|") && marks.some((m) => l.includes(m)))).join("\n");
    if (to === "done" && !add(`Step done: ${t.title} on ${t.page.title} ${markOf(STATE_MARK.done, t.page.id, t.step)}${waits ? `, ${waits} can go on` : ""}`, `${by} switched Done on the steps page (E87): the desk was told and the owner woken`))
      return { skip: "the spine has no ## Decisions table" };
    if (to === "stuck" && !add(`Step stuck: ${t.title} on ${t.page.title} ${markOf(STATE_MARK.stuck, t.page.id, t.step)}${tag}${said}`, `${by} switched Stuck on the steps page (E87): ${waits ? `${waits} must clear what blocked him` : "the owner must clear what blocked him"}`))
      return { skip: "the spine has no ## Decisions table" };
  }
  if (noteRow && !add(`Step note: ${t.title} on ${t.page.title} ${markOf(NOTE_MARK, t.page.id, t.step)}${tag}${said}`, `${by} wrote a note on the steps page (E87): the desk was told and the owner woken`))
    return { skip: "the spine has no ## Decisions table" };
  return { text: out, changed: { state: stateChange, note: noteRow || (stateChange && to === "stuck" && !!words) } };
}

/** What happened, in a few words: `Done`, `Stuck`, `Back to not started`, `Note`. */
const headOf = (to: StepState, stateChange: boolean) => (!stateChange ? "Note" : to === "todo" ? "Back to not started" : LABEL[to]);

/** The one Team desk line per change. */
export function deskLine(t: StepTick, to: StepState, o: { repo: string; spine: string; sha?: string; woke: string; words?: string; stateChange?: boolean }): string {
  const waits = waitsOf(t);
  const test = isTestPage(t.page) ? `TEST tick (not ${ownerName()}), ` : "";
  return (
    `${STEP_DESK_MARKER} ${test}${headOf(to, o.stateChange ?? true)}: ${t.title} on ${t.page.title} (${secureCopyOf(t.page.url)})` +
    `${waits ? `, for ${waits}` : ""}${o.words ? `. His words: "${o.words}"` : ""}. Saved in ${o.repo} ${o.spine}${o.sha ? ` (${o.sha})` : ""}; ${o.woke}. ` +
    `This note comes from the console: tell ${ownerName()} in one line that the team has it, and nothing else.`
  );
}

/** What the owner of the waiting row or ask is told. */
export function ownerNote(t: StepTick, to: StepState, o: { repo: string; spine: string; sha?: string; words?: string; stateChange?: boolean }): string {
  const waits = waitsOf(t);
  const by = who(t.page);
  const test = isTestPage(t.page) ? ` This is a TEST tick on a TEST page, not ${ownerName()}: change nothing for it.` : "";
  const where = `${o.repo} ${o.spine}${o.sha ? ` (commit ${o.sha})` : ""}`;
  const step = `the step "${t.title}" of the steps page ${t.page.title} (${t.page.url})`;
  const pull = `First run \`git pull --ff-only\` on main in ${o.repo}; it is a Decisions row in ${where}.`;
  const said = o.words ? ` His words: "${o.words}".` : "";
  const run = t.row ? `dispatch ${t.row}'s next run at once` : "act at once";
  if (o.stateChange === false) return `${by} wrote a note on ${step}.${said} ${pull} Act on it now (${run}, with his words in its brief).${test}`;
  if (to === "done")
    return `${by} switched Done on ${step}.${said} ${pull} Whatever waits on this step starts now: ${run}${t.ask ? `, and treat ${t.ask} as done by him for this step` : ""}.${test}`;
  if (to === "stuck")
    return `${by} is STUCK on ${step} and could not finish it.${said || " He gave no words: ask him in the Team desk what went wrong."} ${pull} Clear what blocked him now: ${run} with his words in its brief; when it is fixed, tell him in the Team desk so he can switch the step to Done.${test}`;
  return `${by} switched ${step} back to Not started: it is NOT done after all.${said} ${pull} Hold any work${waits ? ` on ${waits}` : ""} that started on it.${test}`;
}

/** A wake's answer: a run that started, an error (with the failed run when one was made), or undefined (nobody on). */
export type WakeAnswer = { runId: string } | { error: string; failedRun?: string } | undefined;

export interface StepsDeps {
  db: DB;
  writer: SpineWriter;
  /** The console's checkout of a repo by its name. */
  repoDir: (repo: string) => string | undefined;
  /** The milestone whose tree holds the spine (its Delivery manager owns the rows). */
  milestoneFor: (repo: string, spine: string) => Promise<string | undefined>;
  /** Wake the milestone's Delivery manager (else its owner) with a note; undefined = nobody switched on. */
  wake?: (milestoneId: string, note: string) => Promise<WakeAnswer>;
  /** a run's outcome and summary now (a wake that made a run is checked again: did it really start?). */
  runOf?: (runId: string) => { outcome: string; summary: string } | undefined;
  /** add a line to a run's summary (a failed wake's run says the step change retries it). */
  noteRun?: (runId: string, text: string) => void;
  /** a run of this milestone made since `since` for this note (a console restart mid-wake never wakes twice). */
  findRun?: (milestoneId: string, since: string, note: string) => string | undefined;
  /** store a pasted key through the ask's key path (inbox `pasteKey`); absent = the boxes refuse. */
  pasteKey?: PasteKey;
  /** does this name hold a value already (names-only index)? undefined = cannot tell (refused unless replace). */
  hasKey?: (world: string, app: string, name: string) => boolean | undefined;
  /** the Secrets page's add (store only, an SK line), for an open ask that names no key of its own. */
  addKey?: (i: { app: string; name: string; value: string; note: string; replace: boolean; file?: boolean }) => Promise<{ ok: true; stored: { app: string; name: string; deployed: boolean } } | { ok: false; status: 400 | 403 | 409 | 502 | 503; code: string; message: string }>;
  /** One line into the world's Team desk chat. */
  tell?: (world: string, text: string, id: string) => Promise<true | string>;
  invalidate?: (repoDir: string) => void;
  now?: () => number;
  /** run the filer and the wake retries on a timer (default on; tests call `drain`). */
  pump?: boolean;
  /** how long a change waits before it is filed (an undo inside it files nothing). */
  fileDelayMs?: number;
  /** a page's HTML as the owner's browser gets it (undefined: not reachable); the copy-paste gate reads it. */
  fetchPage?: (url: string) => Promise<string | undefined>;
}

export class StepError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * where a change is. `saved` = in the console, filing to the repo; `filed` = in the repo (sha); `undone` =
 * taken back before it was filed, or the spine already said so (nothing written); `failed` = the spine refused it.
 */
export type ChangeStatus = "saved" | "filed" | "undone" | "failed";
/**
 * the wake of a filed change. `pending` = waiting for its next try (a T3 down, a failed run); `waking` = a try
 * runs now; `sent` = a run was made, checked again in WAKE_CHECK_MS; `started` = the run started (or was queued into a
 * live session); `off` = nobody switched on (never retried, root L-10); `cancelled` = a newer change of the step made it
 * moot; `gave_up` = still no run after WAKE_GIVE_UP_MS (the desk is told); `none` = nobody to wake.
 */
export type WakeStatus = "none" | "pending" | "waking" | "sent" | "started" | "off" | "cancelled" | "gave_up";

export interface StepChange {
  id: number;
  pageId: string;
  step: string;
  state: StepState;
  words?: string;
  title: string;
  row?: string;
  ask?: string;
  status: ChangeStatus;
  reason?: string;
  sha?: string;
  createdAt: string;
  filedAt?: string;
  fileAttempts: number;
  fileNextAt?: string;
  wake: WakeStatus;
  wakeRun?: string;
  wakeAttempts: number;
  wakeNextAt?: string;
  wakeError?: string;
}

/** What the kit shows under a step about its newest change. */
export interface ChangeView {
  id: number;
  status: ChangeStatus;
  reason?: string;
  sha?: string;
  at: string;
  wake: WakeStatus;
  wakeRun?: string;
  wakeNextAt?: string;
  wakeError?: string;
}

export interface TickResult {
  step: string;
  state: StepState;
  /** true when the step is done (the first kit read this). */
  done: boolean;
  /** saved = the change is in the console and files to the repo in the background; same = nothing changed. */
  spine: "saved" | "same";
  change?: ChangeView;
  steps: Record<string, StepStatus>;
  notes: Record<string, StepNote[]>;
  ticks: Record<string, { at: string }>;
  changes: Record<string, ChangeView>;
}

/** How long the filer waits for the first wake try before it tells the desk (the try goes on in the background). */
export const ANSWER_WAIT_MS = 5_000;
/** a change files after this (an undo inside it files nothing and wakes nobody). */
export const FILE_DELAY_MS = 4_000;
/** a wake that made a run is checked again after this (the cycle's own send retry is at 5 min). */
export const WAKE_CHECK_MS = 7 * 60_000;
/** no run after this long: the wake stops and the desk is told. */
export const WAKE_GIVE_UP_MS = 12 * 3_600_000;
/** the n-th retry waits 1, 2, 4, 8, 16, then 30 minutes. */
export const wakeBackoffMs = (attempts: number) => Math.min(30, 2 ** Math.max(0, attempts - 1)) * 60_000;
/** a refused git write is tried again after 1, 2, 4 … up to 15 minutes. */
const fileBackoffMs = (attempts: number) => Math.min(15, 2 ** Math.max(0, attempts - 1)) * 60_000;
/** The kit keeps showing a change's progress for this long; older ones read as the spine's state only. */
const CHANGE_SHOWN_MS = 6 * 3_600_000;
const PUMP_MS = 5_000;

export function ensureStepChanges(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS step_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id TEXT NOT NULL,
      step TEXT NOT NULL,
      state TEXT NOT NULL,
      words TEXT,
      title TEXT NOT NULL,
      row_ref TEXT,
      ask_ref TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      sha TEXT,
      state_change INTEGER,
      created_at TEXT NOT NULL,
      filed_at TEXT,
      file_attempts INTEGER NOT NULL DEFAULT 0,
      file_next_at TEXT,
      wake TEXT NOT NULL DEFAULT 'none',
      wake_mid TEXT,
      wake_note TEXT,
      wake_run TEXT,
      wake_attempts INTEGER NOT NULL DEFAULT 0,
      wake_next_at TEXT,
      wake_error TEXT,
      wake_at TEXT
    );
    CREATE INDEX IF NOT EXISTS step_changes_open ON step_changes (status, page_id);
    CREATE INDEX IF NOT EXISTS step_changes_wake ON step_changes (wake);
  `);
}

const changeOf = (r: Record<string, unknown>): StepChange => ({
  id: r.id as number,
  pageId: r.page_id as string,
  step: r.step as string,
  state: r.state as StepState,
  ...(r.words ? { words: r.words as string } : {}),
  title: r.title as string,
  ...(r.row_ref ? { row: r.row_ref as string } : {}),
  ...(r.ask_ref ? { ask: r.ask_ref as string } : {}),
  status: r.status as ChangeStatus,
  ...(r.reason ? { reason: r.reason as string } : {}),
  ...(r.sha ? { sha: r.sha as string } : {}),
  createdAt: r.created_at as string,
  ...(r.filed_at ? { filedAt: r.filed_at as string } : {}),
  fileAttempts: r.file_attempts as number,
  ...(r.file_next_at ? { fileNextAt: r.file_next_at as string } : {}),
  wake: r.wake as WakeStatus,
  ...(r.wake_run ? { wakeRun: r.wake_run as string } : {}),
  wakeAttempts: r.wake_attempts as number,
  ...(r.wake_next_at ? { wakeNextAt: r.wake_next_at as string } : {}),
  ...(r.wake_error ? { wakeError: r.wake_error as string } : {}),
});

const changeView = (c: StepChange): ChangeView => ({
  id: c.id,
  status: c.status,
  ...(c.reason ? { reason: c.reason } : {}),
  ...(c.sha ? { sha: c.sha } : {}),
  at: c.createdAt,
  wake: c.wake,
  ...(c.wakeRun ? { wakeRun: c.wakeRun } : {}),
  ...(c.wakeNextAt ? { wakeNextAt: c.wakeNextAt } : {}),
  ...(c.wakeError ? { wakeError: c.wakeError } : {}),
});

/** The spine's steps with the changes still filing laid over them, in order (what the page shows before the commit lands). */
export function overlay(spine: { steps: Record<string, StepStatus>; notes: Record<string, StepNote[]> }, saved: StepChange[]) {
  const steps = { ...spine.steps };
  const notes: Record<string, StepNote[]> = Object.fromEntries(Object.entries(spine.notes).map(([k, v]) => [k, [...v]]));
  for (const c of saved) {
    const at = c.createdAt.slice(0, 10);
    const from = steps[c.step]?.state ?? "todo";
    const stuckWords = c.state === "stuck" && from !== "stuck" && c.words;
    if (c.state === "todo") delete steps[c.step];
    else if (from !== c.state) steps[c.step] = { state: c.state, at, ...(stuckWords ? { words: shortWords(c.words!) } : {}) };
    if (c.words && !stuckWords) (notes[c.step] ??= []).push({ at, words: shortWords(c.words) });
  }
  return { steps, notes };
}

export function createSteps(d: StepsDeps) {
  ensureStepPages(d.db);
  ensureStepChanges(d.db);
  const now = d.now ?? Date.now;
  const iso = (ms = now()) => new Date(ms).toISOString();
  const fileDelay = d.fileDelayMs ?? FILE_DELAY_MS;
  const recent = new Map<string, number[]>();
  const row = (r: Record<string, string> | undefined): StepPage | undefined =>
    r && { id: r.id, token: r.token, title: r.title, url: r.url, repo: r.repo, spine: r.spine, world: r.world, createdBy: r.created_by, createdAt: r.created_at };

  const byToken = (token: string) => row(d.db.prepare("SELECT * FROM step_pages WHERE token = ?").get(token) as Record<string, string> | undefined);
  const byId = (id: string) => row(d.db.prepare("SELECT * FROM step_pages WHERE id = ?").get(id) as Record<string, string> | undefined);
  const changes = (sql: string, ...args: unknown[]) => (d.db.prepare(`SELECT * FROM step_changes WHERE ${sql}`).all(...args) as Record<string, unknown>[]).map(changeOf);
  const savedOf = (pageId: string) => changes("page_id = ? AND status = 'saved' ORDER BY id", pageId);
  const setChange = (id: number, f: Record<string, string | number | null>) => {
    if (!d.db.open) return; // a wake or a filing that finishes after the console (or a test) closed its database
    const keys = Object.keys(f);
    d.db.prepare(`UPDATE step_changes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
  };

  function spineText(p: StepPage): string {
    const dir = d.repoDir(p.repo);
    if (!dir) throw new StepError(409, "no_checkout", `the console has no checkout of ${p.repo}`);
    try {
      return fs.readFileSync(path.join(dir, p.spine), "utf8");
    } catch {
      throw new StepError(409, "no_spine", `${p.repo} has no ${p.spine}`);
    }
  }

  /** the private boxes a page asks for, checked (undefined = the request names none: the page keeps its own). */
  function secretsIn(v: unknown): StepSecret[] | undefined {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > SECRETS_PER_PAGE) throw new StepError(400, "validation_error", `secrets must be a list of at most ${SECRETS_PER_PAGE} {step, app, name, ask}`);
    const out = v.map((x: Record<string, unknown>) => {
      const step = typeof x?.step === "string" ? x.step.trim() : "";
      const app = typeof x?.app === "string" ? x.app.trim() : "";
      const name = typeof x?.name === "string" ? x.name.trim() : "";
      const ask = typeof x?.ask === "string" ? x.ask.trim() : "";
      if (!STEP_ID.test(step)) throw new StepError(400, "validation_error", "each secret needs the step's id");
      if (!APP.test(app) || !KEY_NAME.test(name)) throw new StepError(400, "validation_error", `secret ${step}: app and name as \`secret put <app> <NAME>\` takes them`);
      // the same code shape as the asks themselves (v2 too); the paste still finds it open in the spine (inbox pasteKey)
      if (!isAskCode(ask)) throw new StepError(400, "validation_error", `secret ${step}: ask must be the code of the provide ask that approves it (like E994-A1 or EPIC-905-A4)`);
      return { step, app, name, ask, replace: x.replace === true, ...(x.file === true ? { file: true as const } : {}) };
    });
    if (new Set(out.map((x) => `${x.step}/${x.name}`)).size !== out.length) throw new StepError(400, "validation_error", "one private box per key name on a step");
    return out;
  }
  const secretsOf = (pageId: string): StepSecret[] =>
    (d.db.prepare("SELECT * FROM step_secrets WHERE page_id = ? ORDER BY rowid").all(pageId) as Record<string, unknown>[]).map((r) => ({
      step: r.step as string,
      app: r.app as string,
      name: r.name as string,
      ask: r.ask as string,
      replace: r.replace_ok === 1,
      ...(r.file === 1 ? { file: true as const } : {}),
    }));
  function setSecrets(pageId: string, list: StepSecret[] | undefined) {
    if (!list) return;
    d.db.prepare("DELETE FROM step_secrets WHERE page_id = ?").run(pageId);
    const ins = d.db.prepare("INSERT INTO step_secrets (page_id, step, app, name, ask, replace_ok, file) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const x of list) ins.run(pageId, x.step, x.app, x.name, x.ask, x.replace ? 1 : 0, x.file ? 1 : 0);
  }

  /**
   * the copy-paste gate. A steps page that hands the owner terminal lines to copy is refused at registration
   * (422 copy_paste_steps) and named by GET /api/steps/pages/check; a page not reachable yet (registered before it is
   * written) passes, and its next registration or check reads it.
   */
  async function copyPasteCheck(url: string, boxes?: Set<string>): Promise<{ checked: boolean; found: CopyPasteBlock[]; phantom: string[] }> {
    if (!d.fetchPage || !/^https?:\/\/\S+$/.test(url)) return { checked: false, found: [], phantom: [] };
    const html = await d.fetchPage(url).catch(() => undefined);
    // E996-S29: and the steps that send him to paste into a private box the page does not draw.
    return html === undefined ? { checked: false, found: [], phantom: [] } : { checked: true, found: copyPasteInHtml(html), phantom: phantomBoxSteps(html, boxes ?? boxesAt(url), boxedUrls()) };
  }
  /** every registered page that draws a private box (a step elsewhere may send him there). */
  const boxedUrls = (): Set<string> =>
    new Set((d.db.prepare("SELECT DISTINCT p.url FROM step_pages p JOIN step_secrets s ON s.page_id = p.id").all() as { url: string }[]).map((r) => r.url));
  /** the steps with a private box on the page registered at `url` (any repo), plus `extra` (a registration's own `secrets`). */
  function boxesAt(url: string, extra?: unknown): Set<string> {
    const out = new Set<string>();
    for (const r of d.db.prepare("SELECT s.step FROM step_secrets s JOIN step_pages p ON p.id = s.page_id WHERE p.url = ?").all(url) as { step: string }[]) out.add(r.step);
    if (Array.isArray(extra)) for (const x of extra) if (typeof (x as { step?: unknown })?.step === "string") out.add((x as { step: string }).step.trim());
    return out;
  }

  function register(o: { title?: unknown; url?: unknown; repo?: unknown; spine?: unknown; secrets?: unknown; world?: string; by: string }): StepPage {
    const title = typeof o.title === "string" ? oneLine(o.title).slice(0, 120) : "";
    const url = typeof o.url === "string" ? o.url.trim() : "";
    const repo = typeof o.repo === "string" ? o.repo.trim() : "";
    const spine = typeof o.spine === "string" ? o.spine.trim().replace(/^\.\//, "") : "";
    if (!title) throw new StepError(400, "validation_error", "title is required");
    if (!/^https?:\/\/\S+$/.test(url)) throw new StepError(400, "validation_error", "url must be the page's http(s) address");
    if (!SPINE.test(spine) || spine.split("/").some((x) => x === ".." || x === ".")) throw new StepError(400, "validation_error", "spine must be the spine's .md path inside the repo");
    const dir = d.repoDir(repo);
    if (!dir) throw new StepError(404, "not_found", `the console has no checkout of ${repo || "(no repo)"}`);
    const file = path.join(dir, spine);
    if (!fs.existsSync(file)) throw new StepError(404, "not_found", `${repo} has no ${spine}`);
    const real = fs.realpathSync(file), top = fs.realpathSync(dir);
    if (!real.startsWith(top + path.sep)) throw new StepError(400, "validation_error", "spine must be the spine's .md path inside the repo");
    if (!spine.startsWith("docs/spines/") && !isSpine(fs.readFileSync(real, "utf8"))) throw new StepError(400, "validation_error", `${spine} is not a spine (no ## Current State, no Spine Type or Root spine line)`);
    const secrets = secretsIn(o.secrets);
    const same = d.db.prepare("SELECT * FROM step_pages WHERE url = ? AND repo = ? AND spine = ?").get(url, repo, spine) as Record<string, string> | undefined;
    if (same) {
      d.db.prepare("UPDATE step_pages SET title = ? WHERE id = ?").run(title, same.id);
      setSecrets(same.id, secrets);
      return byId(same.id)!;
    }
    const p: StepPage = {
      id: `sp_${randomBytes(4).toString("hex")}`,
      token: randomBytes(18).toString("base64url"),
      title,
      url,
      repo,
      spine,
      world: o.world ?? DEFAULT_TENANT,
      createdBy: o.by,
      createdAt: iso(),
    };
    d.db
      .prepare("INSERT INTO step_pages (id, token, title, url, repo, spine, world, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.token, p.title, p.url, p.repo, p.spine, p.world, p.createdBy, p.createdAt);
    setSecrets(p.id, secrets);
    return p;
  }

  /** The newest change of each step of the page (recent ones only), for the kit's "filing" and "in the repo" words. */
  function latestChanges(pageId: string): Record<string, ChangeView> {
    const since = iso(now() - CHANGE_SHOWN_MS);
    const out: Record<string, ChangeView> = {};
    for (const c of changes("page_id = ? AND (created_at >= ? OR status = 'saved' OR wake IN ('pending', 'waking', 'sent')) ORDER BY id", pageId, since)) out[c.step] = changeView(c);
    return out;
  }

  /**
   * The page as the kit sees it: each step's state (none = not started) and notes as the spine has them, with the changes
   * still filing laid over them (the console db holds a change only until its commit lands; the repo stays the
   * record, L-45), and the newest change of each step (where it is: filing, in the repo, its wake).
   */
  function view(p: StepPage) {
    const v = overlay(stepsIn(spineText(p), p.id), savedOf(p.id));
    const ticks = Object.fromEntries(Object.entries(v.steps).filter(([, s]) => s.state === "done").map(([k, s]) => [k, { at: s.at }]));
    // the private boxes, names only: `set` = the name holds a value now (null = the console cannot tell).
    const secrets: Record<string, { app: string; name: string; ask: string; replace: boolean; set: boolean | null; file?: true; maxBytes?: number }[]> = {};
    for (const x of secretsOf(p.id))
      (secrets[x.step] ??= []).push({ app: x.app, name: x.name, ask: x.ask, replace: x.replace, set: d.hasKey?.(p.world, x.app, x.name) ?? null, ...(x.file ? { file: true as const, maxBytes: MAX_FILE } : {}) });
    return { page: { id: p.id, title: p.title, url: p.url, repo: p.repo, spine: p.spine, test: isTestPage(p) }, ...v, ticks, changes: latestChanges(p.id), secrets };
  }

  /** the page registered at this address (a trailing slash either way; the newest when several spines share it). */
  function byUrl(url: string): StepPage | undefined {
    const u = url.trim().replace(/\/+$/, "");
    if (!u) return undefined;
    return row(d.db.prepare("SELECT * FROM step_pages WHERE url IN (?, ?) ORDER BY created_at DESC LIMIT 1").get(u, `${u}/`) as Record<string, string> | undefined);
  }

  /**
   * one step of a page as the kit shows it (the spine's rows with the changes still filing over them, and its
   * newest change), for the inbox card that writes the same step. Throws a StepError when the spine is not readable.
   */
  function stepView(p: StepPage, step: string) {
    const v = overlay(stepsIn(spineText(p), p.id), savedOf(p.id));
    const s = v.steps[step];
    const c = latestChanges(p.id)[step];
    return {
      pageId: p.id,
      step,
      state: s?.state ?? ("todo" as StepState),
      ...(s?.at ? { at: s.at } : {}),
      ...(s?.words ? { words: s.words } : {}),
      notes: v.notes[step] ?? [],
      ...(c ? { change: { status: c.status, at: c.at, wake: c.wake, ...(c.sha ? { sha: c.sha } : {}), ...(c.reason ? { reason: c.reason } : {}) } } : {}),
    };
  }

  function throttle(id: string) {
    const t = now();
    const list = (recent.get(id) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= STEP_WRITES_PER_MIN) throw new StepError(429, "too_many", "too many ticks on this page in a minute: wait a moment");
    list.push(t);
    recent.set(id, list);
  }

  /** Wait for `p` at most `ms`; past that it goes on in the background and `late` is the answer. */
  const within = <T,>(p: Promise<T>, ms: number, late: T): Promise<T> =>
    Promise.race([p, new Promise<T>((r) => setTimeout(() => r(late), ms).unref?.())]);

  /**
   * A switch or a note: checked, saved as a change in the console db and answered at once ("saved, filing to the
   * repo"); the filer writes it to the owning spine in order in the background, then tells the desk and wakes the owner.
   */
  async function tick(p: StepPage, input: unknown): Promise<TickResult> {
    const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const step = typeof b.step === "string" ? b.step.trim() : "";
    if (!STEP_ID.test(step)) throw new StepError(400, "validation_error", "step must be the step's id (letters, digits, - . _; up to 40)");
    const raw = typeof b.comment === "string" ? b.comment.replace(/\r\n?/g, "\n").trim() : "";
    if (raw.length > NOTE_MAX) throw new StepError(400, "validation_error", `a note holds at most ${NOTE_MAX / 1000} KB of text: send the rest as a second note`);
    // the whole note is kept; the spine line, the desk and the page show its start (shortWords)
    const words = raw || undefined;
    if (b.state !== undefined && !["todo", "done", "stuck"].includes(b.state as string)) throw new StepError(400, "validation_error", "state must be todo, done or stuck");
    if (b.state === undefined && b.done !== undefined && typeof b.done !== "boolean") throw new StepError(400, "validation_error", "done must be true or false");
    if (b.state === undefined && b.done === undefined && !words) throw new StepError(400, "validation_error", "send a state (todo, done, stuck) or a comment");
    const ref = (k: "row" | "ask") => {
      const v = typeof b[k] === "string" ? (b[k] as string).trim() : "";
      if (v && !(k === "ask" ? isAskCode(v) : REF.test(v))) throw new StepError(400, "validation_error", `${k} must be a code like E983-S5 / E983-A7`);
      return v || undefined;
    };
    const title = (typeof b.title === "string" && oneLine(b.title).slice(0, 120)) || step;
    const [rowRef, askRef] = [ref("row"), ref("ask")];
    const before = view(p);
    const from = before.steps[step]?.state ?? "todo";
    const to: StepState = (b.state as StepState | undefined) ?? (typeof b.done === "boolean" ? (b.done ? "done" : "todo") : from);
    const result = (spine: TickResult["spine"], v = before, change?: ChangeView): TickResult => ({
      step,
      state: v.steps[step]?.state ?? "todo",
      done: v.steps[step]?.state === "done",
      spine,
      ...(change ? { change } : {}),
      steps: v.steps,
      notes: v.notes,
      ticks: v.ticks,
      changes: v.changes,
    });
    if (from === to && !words) return result("same");
    throttle(p.id);
    const id = Number(
      d.db
        .prepare("INSERT INTO step_changes (page_id, step, state, words, title, row_ref, ask_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'saved', ?)")
        .run(p.id, step, to, words ?? null, title, rowRef ?? null, askRef ?? null, iso()).lastInsertRowid,
    );
    kick(fileDelay);
    const v = view(p);
    return result("saved", v, v.changes[step]);
  }

  // ----------: the private box ----------

  const tries = new Map<string, number[]>();
  function throttleKey(id: string) {
    const t = now();
    const list = (tries.get(id) ?? []).filter((x) => t - x < 3_600_000);
    if (list.length >= SECRET_TRIES_PER_HOUR) throw new StepError(429, "too_many", "too many keys pasted on this page in an hour: wait, or tell the team");
    list.push(t);
    tries.set(id, list);
  }
  const logKey = (p: StepPage, x: StepSecret, outcome: "stored" | "refused" | "failed", detail?: string) =>
    d.db
      .prepare("INSERT INTO step_secret_log (at, world, page_id, page_title, step, app, name, ask, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(iso(), p.world, p.id, p.title, x.step, x.app, x.name, x.ask, outcome, detail ? oneLine(detail).slice(0, 300) : null);

  /**
   * A key pasted in a step's private box: only a name the page registered, through the ask's key path, then the step is
   * switched Done (one press). The value is checked, handed on and dropped: never in a response, the db or a log line.
   */
  async function paste(p: StepPage, input: unknown): Promise<Omit<TickResult, "change"> & { stored: { app: string; name: string; deployed: boolean }; missing?: string[] }> {
    const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const step = typeof b.step === "string" ? b.step.trim() : "";
    const boxes = secretsOf(p.id).filter((s) => s.step === step);
    const x = typeof b.name === "string" ? boxes.find((s) => s.name === b.name) : boxes.length === 1 ? boxes[0] : undefined;
    if (!x)
      throw new StepError(403, "not_registered", boxes.length ? "this step has several boxes: say which key name" : "this step has no private box: the page registers its key names (secrets on POST /api/steps/pages)");
    const raw = typeof b.value === "string" ? b.value : "";
    // a file box keeps the whole file (only a trailing line break goes, as `secret` reads stdin).
    const value = x.file ? raw.replace(/\r?\n$/, "") : raw.trim();
    const bad = x.file
      ? fileValueProblem(x.name, value)
      : !value ? "paste the key first" : value.length > 20_000 ? "the value is too long for a key" : /[\r\n]/.test(value) ? "a key is one line: the pasted value has several lines" : undefined;
    if (bad) {
      if (x.file) logKey(p, x, "refused", bad);
      throw new StepError(400, "validation_error", bad);
    }
    try {
      throttleKey(p.id);
    } catch (e) {
      logKey(p, x, "refused", "too many tries in an hour");
      throw e;
    }
    const held = d.hasKey?.(p.world, x.app, x.name);
    if (!x.replace && held !== false) {
      const why = held ? `${x.app} ${x.name} holds a value already` : `the console cannot check whether ${x.app} ${x.name} holds a value`;
      logKey(p, x, "refused", why);
      throw new StepError(409, "already_set", `nothing stored: ${why}; this step does not replace a key (ask the team)`);
    }
    if (!d.pasteKey) {
      logKey(p, x, "refused", "the console's key path is off here");
      throw new StepError(503, "keys_off", "nothing stored: this console does not store keys");
    }
    const failed = (e: Error) => ({ ok: false as const, status: 502 as const, code: "secret_put_failed", message: e.message });
    type Stored = { ok: true; stored: { app: string; name: string; deployed: boolean } } | { ok: false; status: 400 | 403 | 404 | 409 | 502 | 503; code: string; message: string };
    let r: Stored = await d.pasteKey({ repo: p.repo, spine: p.spine, ask: x.ask, app: x.app, name: x.name, value, ...(x.file ? { file: true } : {}) }).catch(failed);
    if (!r.ok && r.code === "ask_names_no_key")
      r = d.addKey && p.world === DEFAULT_TENANT
        ? await d.addKey({ app: x.app, name: x.name, value, replace: x.replace, note: `${x.file ? "file given" : "pasted"} on the steps page ${oneLine(p.title).slice(0, 80)} (${p.id}), step ${x.step}, for ask ${x.ask}`, ...(x.file ? { file: true } : {}) }).catch(failed)
        : { ok: false, status: 409, code: "ask_names_no_key", message: `nothing stored: ask ${x.ask} names no key and this console cannot add one` };
    if (!r.ok) {
      const msg = scrub(r.message, value);
      logKey(p, x, r.status === 502 ? "failed" : "refused", msg);
      throw new StepError(r.status, r.code, msg);
    }
    logKey(p, x, "stored", x.file ? "key file stored with secret put, store only" : r.stored.deployed ? `stored with secret put, set in ${deployerName()}` : "stored with secret put");
    const title = (typeof b.title === "string" && oneLine(b.title).slice(0, 120)) || step;
    // Done once every box of the step holds a value (this one just did).
    const missing = boxes.filter((o) => o.name !== x.name && d.hasKey?.(p.world, o.app, o.name) !== true).map((o) => o.name);
    const t = missing.length
      ? { ...view(p), step, state: (view(p).steps[step]?.state ?? "todo") as StepState, done: false, spine: "same" as const }
      : await tick(p, { step, state: "done", title, ask: x.ask, ...(typeof b.row === "string" && REF.test(b.row) ? { row: b.row } : {}) });
    return { ...t, stored: r.stored, ...(missing.length ? { missing } : {}) };
  }

  /** The names-only log of every paste, newest first (the Services page). */
  const keyLog = (world: string, limit = 50) =>
    (d.db.prepare("SELECT * FROM step_secret_log WHERE world = ? ORDER BY id DESC LIMIT ?").all(world, limit) as Record<string, unknown>[]).map((r) => ({
      at: r.at as string,
      page: { id: r.page_id as string, title: r.page_title as string },
      step: r.step as string,
      app: r.app as string,
      name: r.name as string,
      ask: r.ask as string,
      outcome: r.outcome as string,
      ...(r.detail ? { detail: r.detail as string } : {}),
    }));

  // ---------- the filer: changes into the spine, in order, one page at a time ----------

  /** File the page's saved changes that are old enough, oldest first; a change that cannot be filed yet holds the ones after it. */
  async function filePage(p: StepPage): Promise<void> {
    const dir = d.repoDir(p.repo);
    for (;;) {
      if (!d.db.open) return;
      const saved = savedOf(p.id);
      const c = saved[0];
      if (!c) return;
      const t = now();
      if (t - Date.parse(c.createdAt) < fileDelay) return;
      if (c.fileNextAt && Date.parse(c.fileNextAt) > t) return;
      // Taken back before it was filed: a later change of the same step stands for it (his words, if any, still file).
      if (!c.words && saved.some((x) => x.step === c.step && x.id > c.id)) {
        setChange(c.id, { status: "undone", reason: "a later change of the step stands for it", filed_at: iso() });
        continue;
      }
      if (!dir) {
        setChange(c.id, { status: "failed", reason: `the console has no checkout of ${p.repo}`, filed_at: iso() });
        continue;
      }
      const tk: StepTick = { page: p, step: c.step, title: c.title, row: c.row, ask: c.ask };
      let changed = { state: true, note: !!c.words };
      // a long note (pasted terminal output) is filed whole as text first; the spine line quotes its start and names the file
      let words = c.words ? shortWords(c.words) : undefined;
      if (isLongNote(c.words)) {
        const rel = noteFileOf(p.id, c.step, c.id);
        const full = c.words;
        const f: SpineWrite = await d.writer.edit({
          repoDir: dir,
          path: rel,
          label: "step note",
          edit: (text) =>
            text
              ? { skip: "already filed" }
              : {
                  text: `${who(p)}'s note on step ${c.step} (${c.title}) of ${p.title}, ${p.url}, saved ${c.createdAt}:\n\n${full}\n`,
                  msg: `Step note (full text): ${c.title} on ${p.title} (${who(p)}, via steps page)`,
                  body: `a note longer than one spine line is kept whole here; the spine line in ${p.spine} quotes its start.`,
                },
        });
        if (f.status !== "written" && !(f.status === "skipped" && f.reason === "already filed")) {
          const n = c.fileAttempts + 1;
          setChange(c.id, { file_attempts: n, file_next_at: iso(now() + fileBackoffMs(n)), reason: `not filed yet (the full note): ${f.reason ?? f.status}` });
          return;
        }
        words = `${words} [full note, ${full.length} characters: ${p.repo} ${rel}]`;
      }
      const w: SpineWrite = await d.writer.edit({
        repoDir: dir,
        path: p.spine,
        label: `step ${c.state}`,
        edit: (text, date) => {
          const next = applyStep(text, tk, c.state, words, date, c.createdAt);
          if ("skip" in next) return next;
          changed = next.changed;
          const head = headOf(c.state, next.changed.state);
          const by = who(p);
          return {
            text: next.text,
            msg: `Step ${head.toLowerCase()}: ${c.title} on ${p.title}${waitsOf(tk) ? ` (${waitsOf(tk)})` : ""} (${by}, via steps page)`,
            body: `${by} set step ${c.step} of ${p.url} (page ${p.id}) to ${LABEL[c.state]}${words ? ` with the words: "${words}"` : ""}. A steps page's switches write here; the desk is told and the owner woken (saved at ${c.createdAt}, filed in order).`,
          };
        },
      });
      if (w.status === "skipped" && /^already /.test(w.reason ?? "")) {
        setChange(c.id, { status: "undone", reason: `nothing to file: ${w.reason}`, filed_at: iso() });
        continue;
      }
      if (w.status === "skipped") {
        setChange(c.id, { status: "failed", reason: w.reason ?? "skipped", filed_at: iso() });
        continue;
      }
      if (w.status !== "written") {
        // A refused push or a busy repo: try again later, and keep the changes after it waiting (order).
        const n = c.fileAttempts + 1;
        setChange(c.id, { file_attempts: n, file_next_at: iso(now() + fileBackoffMs(n)), reason: `not filed yet: ${w.reason ?? w.status}` });
        return;
      }
      setChange(c.id, { status: "filed", sha: w.sha ?? null, filed_at: iso(), reason: null, state_change: changed.state ? 1 : 0 });
      d.invalidate?.(dir);
      await afterFiled(p, { ...c, ...(words ? { words } : {}), status: "filed", ...(w.sha ? { sha: w.sha } : {}) }, changed.state);
    }
  }

  /** A filed change: older wakes of the step that never started are moot, its own wake is recorded, the desk is told. */
  async function afterFiled(p: StepPage, c: StepChange, stateChange: boolean): Promise<void> {
    if (stateChange)
      d.db
        .prepare("UPDATE step_changes SET wake = 'cancelled', wake_error = ? WHERE page_id = ? AND step = ? AND id < ? AND wake = 'pending'")
        .run(`a newer change of the step (${c.id}) stands for it`, p.id, c.step, c.id);
    const tk: StepTick = { page: p, step: c.step, title: c.title, row: c.row, ask: c.ask };
    const o = { repo: p.repo, spine: p.spine, sha: c.sha, words: c.words, stateChange };
    const mid = await d.milestoneFor(p.repo, p.spine).catch(() => undefined);
    let woke = "nobody to wake: no milestone holds this spine";
    if (mid && d.wake) {
      setChange(c.id, { wake: "pending", wake_mid: mid, wake_note: ownerNote(tk, c.state, o), wake_next_at: iso() });
      const first = await within(tryWake(c.id), ANSWER_WAIT_MS, undefined);
      const now_ = changes("id = ?", c.id)[0];
      woke =
        first === undefined
          ? "the Delivery manager is being woken"
          : now_.wake === "off"
            ? "nobody woken: the Delivery manager is off or paused"
            : now_.wakeRun && (now_.wake === "sent" || now_.wake === "started")
              ? `the Delivery manager was woken (run ${now_.wakeRun})`
              : `the wake is waiting (${now_.wakeError ?? "no run yet"}): the console tries again until a run starts`;
    } else if (mid) woke = "nobody woken: the console's cycle is off";
    if (d.tell) {
      const telling = d.tell(p.world, deskLine(tk, c.state, { ...o, woke }), `step-${p.id}-${c.step}-${c.state}-${c.sha ?? c.id}`).catch((e: Error) => e.message);
      await within<true | string>(telling, ANSWER_WAIT_MS, "being told");
    }
  }

  // ---------- the wake: retried until a run starts, at most one per change ----------

  const inFlight = new Set<Promise<unknown>>();

  /** One try of a change's wake. Claims it first (pending → waking), so two pumps never wake twice. Resolves when done. */
  async function tryWake(id: number): Promise<WakeStatus | undefined> {
    if (!d.db.open) return undefined;
    const claim = d.db.prepare("UPDATE step_changes SET wake = 'waking', wake_at = ? WHERE id = ? AND wake = 'pending'").run(iso(), id);
    if (claim.changes !== 1 || !d.wake) return undefined;
    const r = d.db.prepare("SELECT * FROM step_changes WHERE id = ?").get(id) as Record<string, unknown>;
    const c = changeOf(r);
    const job = (async () => {
      const a: WakeAnswer = await d.wake!(r.wake_mid as string, r.wake_note as string).catch((e: Error) => ({ error: e.message }));
      if (!a) {
        setChange(id, { wake: "off", wake_next_at: null, wake_error: "nobody switched on: the Delivery manager is off or paused" });
        return "off" as const;
      }
      if (!("error" in a)) {
        setChange(id, { wake: "sent", wake_run: a.runId, wake_error: null, wake_next_at: iso(now() + WAKE_CHECK_MS) });
        return "sent" as const;
      }
      return retryLater(c, a.error, a.failedRun);
    })();
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
    return job;
  }

  /** The wake did not start a run: try again with backoff, or give up past WAKE_GIVE_UP_MS (the desk is told once). */
  function retryLater(c: StepChange, error: string, runId?: string): WakeStatus {
    const n = c.wakeAttempts + 1;
    const why = oneLine(error).slice(0, 300);
    if (now() - Date.parse(c.filedAt ?? c.createdAt) > WAKE_GIVE_UP_MS) {
      setChange(c.id, { wake: "gave_up", wake_attempts: n, wake_error: why, wake_next_at: null, ...(runId ? { wake_run: runId } : {}) });
      const p = byId(c.pageId);
      if (p && d.tell)
        void d
          .tell(p.world, `${STEP_DESK_MARKER} ${isTestPage(p) ? `TEST tick (not ${ownerName()}), ` : ""}the wake for "${c.title}" on ${p.title} found no run in ${Math.round(WAKE_GIVE_UP_MS / 3_600_000)} h (${n} tries, last: ${why}); the step is in the repo. This note comes from the console: the Delivery manager acts on it at its next wake.`, `step-gaveup-${c.id}`)
          .catch(() => undefined);
      return "gave_up";
    }
    const at = iso(now() + wakeBackoffMs(n));
    setChange(c.id, { wake: "pending", wake_attempts: n, wake_error: why, wake_next_at: at, ...(runId ? { wake_run: runId } : {}) });
    if (runId) d.noteRun?.(runId, `this wake carried a step change ("${c.title}"); the console tries it again at ${at} until a run starts.`);
    return "pending";
  }

  /** A wake that made a run: did the run start? `Run now failed…` (T3 down, the send retry failed) means no: try again. */
  function checkSent(c: StepChange) {
    const run = c.wakeRun ? d.runOf?.(c.wakeRun) : undefined;
    const later = () => setChange(c.id, { wake_next_at: iso(now() + WAKE_CHECK_MS) });
    if (run && run.outcome === "failed" && /^Run now failed/.test(run.summary)) {
      setChange(c.id, { wake: "waking" });
      retryLater(c, run.summary.replace(/^Run now failed:?\s*/, ""), c.wakeRun);
    } else if (run && (run.outcome === "deferred" || (run.outcome === "running" && /^Run now: (send failed|waiting for the persona to wake)/.test(run.summary)))) later();
    else setChange(c.id, { wake: "started", wake_next_at: null });
  }

  /** At start: a wake that was mid-try when the console stopped either made its run (found) or is tried again. */
  function recover() {
    for (const r of d.db.prepare("SELECT * FROM step_changes WHERE wake = 'waking'").all() as Record<string, unknown>[]) {
      const run = d.findRun?.(r.wake_mid as string, (r.wake_at as string) ?? (r.created_at as string), r.wake_note as string);
      if (run) setChange(r.id as number, { wake: "sent", wake_run: run, wake_next_at: iso(now() + WAKE_CHECK_MS) });
      else setChange(r.id as number, { wake: "pending", wake_next_at: iso() });
    }
  }

  // ---------- the pump ----------

  let pumping: Promise<void> | undefined;
  let again = false;
  async function pumpOnce(): Promise<void> {
    if (!d.db.open) return; // a timer that fires after the console (or a test) closed its database
    const pages = d.db.prepare("SELECT DISTINCT page_id FROM step_changes WHERE status = 'saved'").all() as { page_id: string }[];
    for (const { page_id } of pages) {
      const p = byId(page_id);
      if (!p) {
        d.db.prepare("UPDATE step_changes SET status = 'failed', reason = 'the steps page is gone' WHERE page_id = ? AND status = 'saved'").run(page_id);
        continue;
      }
      await filePage(p).catch((e: Error) => console.error(`steps: filing ${p.id}: ${e.message}`));
    }
    const t = iso();
    if (!d.db.open) return;
    for (const c of changes("wake = 'pending' AND (wake_next_at IS NULL OR wake_next_at <= ?) ORDER BY id", t)) void tryWake(c.id).catch(quiet);
    for (const c of changes("wake = 'sent' AND wake_next_at <= ? ORDER BY id", t)) checkSent(c);
  }
  /** Run the filer and the wakes now (one pass at a time; a call during a pass runs one more pass after it). */
  function pump(): Promise<void> {
    if (pumping) {
      again = true;
      return pumping;
    }
    pumping = (async () => {
      do {
        again = false;
        await pumpOnce();
      } while (again);
    })().finally(() => (pumping = undefined));
    return pumping;
  }
  /** A timer's pass never throws unhandled: after the database closed it is dropped, before that it is logged. */
  function quiet(e: Error): undefined {
    if (d.db.open) console.error(`steps: pump: ${e.message}`);
    return undefined;
  }
  const kick = (ms: number) => {
    if (d.pump === false) return;
    setTimeout(() => void pump().catch(quiet), ms + 50).unref?.();
  };
  /** Tests: pump until nothing is left to do now, the wake tries included. */
  async function drain(): Promise<void> {
    await pump();
    while (inFlight.size) {
      await Promise.all([...inFlight]);
      await pump();
    }
  }

  recover();
  if (d.pump !== false) setInterval(() => void pump().catch(quiet), PUMP_MS).unref?.();

  /** Changes still on their way: filing to the repo, or a wake not started yet (the console's Steps list shows them). */
  const open = () =>
    changes("status = 'saved' OR wake IN ('pending', 'waking', 'sent') ORDER BY id").map((c) => {
      const p = byId(c.pageId);
      return { ...changeView(c), page: p ? { id: p.id, title: p.title, url: p.url } : { id: c.pageId }, step: c.step, title: c.title, state: c.state, ...(c.row ? { row: c.row } : {}), ...(c.ask ? { ask: c.ask } : {}) };
    });

  return {
    register,
    copyPasteCheck,
    boxesAt,
    byToken,
    byId,
    byUrl,
    view,
    stepView,
    tick,
    paste,
    keyLog,
    secretsOf,
    pump,
    drain,
    open,
    /** every page's id, address, title and world, newest first (secureLinks.ts). */
    lite: () => d.db.prepare("SELECT id, url, title, world FROM step_pages ORDER BY created_at DESC").all() as { id: string; url: string; title: string; world: string | null }[],
    list: () =>
      (d.db.prepare("SELECT * FROM step_pages ORDER BY created_at DESC").all() as Record<string, string>[]).map((r) => {
        const p = row(r)!;
        const pending = changes("page_id = ? AND (status = 'saved' OR wake IN ('pending', 'waking', 'sent'))", p.id);
        return { ...p, filing: pending.filter((c) => c.status === "saved").length, wakesPending: pending.filter((c) => c.wake !== "sent" && c.status === "filed").length };
      }),
  };
}

export type Steps = ReturnType<typeof createSteps>;

/** does the home world's store hold `<app> <NAME>`? the infra repo `secret`'s names-only index (0644, no values); undefined = unreadable. */
export function keyInIndex(app: string, name: string, file = process.env.SECRET_INDEX || keyIndexFile()): boolean | undefined {
  try {
    const entries = (JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: { app?: string; name?: string }[] }).entries;
    return Array.isArray(entries) ? entries.some((e) => e.app === app && e.name === name) : undefined;
  } catch {
    return undefined;
  }
}

/** CORS for the kit on a page served elsewhere on the tailnet: no cookie is sent or read, the token is the credential. */
const cors = (c: Context) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Vary", "Origin");
};

async function bodyOf(c: Context): Promise<unknown> {
  // The kit posts text/plain (a "simple" request, no preflight) holding JSON.
  try {
    return JSON.parse(await c.req.text());
  } catch {
    return undefined;
  }
}

/**
 * a note's screenshots: stored like Chat's attachments (desk/attachments.ts) in the page's world, named in the
 * note as one files line of links, opened by the agent who reads it with its console headers.
 */
export interface StepFiles {
  add: (bytes: Uint8Array, declaredType: string, rawName: string, world: string) => { id: string; name: string; mime: string; bytes: number };
  line: (ids: string[], world: string) => string;
}
/** What a note box takes: pictures only (a screenshot, a photo of a screen). */
export const STEP_FILE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"];
const STEP_FILES_MAX = 8;

export function mountSteps(api: Hono, steps: Steps, files?: StepFiles) {
  const fail = (c: Context, e: unknown) => {
    if (e instanceof StepError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
    if (e instanceof AttachError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
    throw e;
  };
  // the note's words with its screenshots' line after them (ids from the files route below, this page's world only)
  const withFiles = (p: StepPage, body: unknown): unknown => {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
    if (!b || b.files === undefined) return body;
    const ids = Array.isArray(b.files) ? [...new Set(b.files.filter((x): x is string => typeof x === "string" && /^att_[a-f0-9]{12}$/.test(x)))] : [];
    if (!ids.length) throw new StepError(400, "validation_error", "files must name the screenshots this page uploaded");
    if (ids.length > STEP_FILES_MAX) throw new StepError(400, "validation_error", `at most ${STEP_FILES_MAX} screenshots in one note`);
    if (!files) throw new StepError(400, "validation_error", "this console takes no screenshots on steps pages");
    const words = typeof b.comment === "string" ? b.comment.trim() : "";
    const { files: _f, ...rest } = b;
    return { ...rest, comment: `${words}${words ? " " : ""}${files.line(ids, p.world || DEFAULT_TENANT)}` };
  };
  const page = (c: Context) => {
    const p = steps.byToken(c.req.param("token") ?? "");
    if (!p) throw new StepError(404, "not_found", "no steps page has this token");
    return p;
  };

  // The kit, from any tailnet page: the page's ticks as the spine has them, and the Done switch.
  api.get("/public/steps/:token", (c) => {
    cors(c);
    try {
      return c.json(steps.view(page(c)));
    } catch (e) {
      return fail(c, e);
    }
  });
  api.post("/public/steps/:token/ticks", async (c) => {
    cors(c);
    try {
      const p = page(c);
      return c.json(await steps.tick(p, withFiles(p, await bodyOf(c))));
    } catch (e) {
      return fail(c, e);
    }
  });
  // a screenshot for a note (attached or pasted in the note box): the raw bytes, `content-type` its type, `x-filename` its
  // name; it answers the id the note's `files` names. A plain POST of an image type is not a simple request, so the kit's
  // preflight is answered too. The page token is the credential, as for the ticks.
  api.options("/public/steps/:token/files", (c) => {
    cors(c);
    c.header("Access-Control-Allow-Methods", "POST");
    c.header("Access-Control-Allow-Headers", "content-type, x-filename");
    c.header("Access-Control-Max-Age", "600");
    return c.body(null, 204);
  });
  api.post("/public/steps/:token/files", async (c) => {
    cors(c);
    try {
      const p = page(c);
      if (!files) throw new StepError(400, "validation_error", "this console takes no screenshots on steps pages");
      const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!STEP_FILE_TYPES.includes(type === "image/jpg" ? "image/jpeg" : type)) throw new AttachError(415, "type_refused", "a note box takes pictures (PNG, JPEG, WebP, GIF, HEIC), not " + (type || "this file"));
      const len = Number(c.req.header("content-length"));
      if (Number.isFinite(len) && len > ATTACH_MAX_BYTES) throw new AttachError(413, "too_big", `a picture is at most ${ATTACH_MAX_BYTES / 1024 / 1024} MB`);
      let name = "screenshot";
      try {
        name = decodeURIComponent(c.req.header("x-filename") ?? "screenshot") || "screenshot";
      } catch {
        /* keep the default */
      }
      const a = files.add(new Uint8Array(await c.req.arrayBuffer()), type, name, p.world || DEFAULT_TENANT);
      return c.json({ file: { id: a.id, name: a.name, mime: a.mime, bytes: a.bytes } }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });
  // a step's private box (write-only): the key goes to the store, the step to Done; the answer names only.
  api.post("/public/steps/:token/secret", async (c) => {
    cors(c);
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await steps.paste(page(c), await bodyOf(c)), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  // Register a page (an agent making it, or the owner): its token goes into the page's `data-steps-token`.
  api.post("/steps/pages", async (c) => {
    try {
      const i = currentAuth()?.identity;
      const b = ((await bodyOf(c)) ?? {}) as Record<string, unknown>;
      // a page that hands the owner terminal lines to copy is refused
      const url = typeof b.url === "string" ? b.url.trim() : "";
      const chk = await steps.copyPasteCheck(url, steps.boxesAt(url, b.secrets));
      const why = copyPasteProblem(chk.found);
      if (why) throw new StepError(422, "copy_paste_steps", `The steps page was not registered: ${why}`);
      const phantom = phantomStepsProblem(chk.phantom);
      if (phantom) throw new StepError(422, "phantom_box", `The steps page was not registered: ${phantom}`);
      const p = steps.register({ ...b, world: i && "tenant" in i ? i.tenant : undefined, by: i?.kind === "session" ? ownerName() : i?.kind === "token" ? "an agent" : "the console" });
      return c.json(p, 201);
    } catch (e) {
      return fail(c, e);
    }
  });
  api.get("/steps/pages", (c) => c.json(steps.list().map(({ token: _t, ...p }) => p)));
  // every registered page read as the owner's browser gets it, with the copy-paste terminal blocks it still holds.
  api.get("/steps/pages/check", async (c) => {
    const pages = steps.list();
    const out = await Promise.all(
      pages.map(async ({ token: _t, ...p }) => {
        const r = await steps.copyPasteCheck(p.url);
        return { id: p.id, title: p.title, url: p.url, repo: p.repo, spine: p.spine, checked: r.checked, found: r.found, phantom: r.phantom };
      }),
    );
    return c.json({ pages: out, failing: out.filter((x) => x.found.length || x.phantom.length).length, unreachable: out.filter((x) => !x.checked).length });
  });
  // every key pasted on a steps page, names and outcome only (the Services page lists them).
  api.get("/steps/secret-log", (c) => {
    const i = currentAuth()?.identity;
    return c.json({ log: steps.keyLog(i && "tenant" in i && i.tenant ? i.tenant : DEFAULT_TENANT) });
  });
  // step changes still on their way (filing to the repo, or a wake that has not started a run yet).
  api.get("/steps/changes", (c) => c.json({ open: steps.open() }));
  // the owner's own session, on a console page: tick by page id. Never an agent token.
  api.post("/steps/pages/:id/ticks", async (c) => {
    try {
      const a = currentAuth();
      if (a && a.mode !== "off" && a.identity?.kind !== "session") throw new StepError(403, "jordi_only", `only ${ownerName()}'s own session ticks a step`);
      const p = steps.byId(c.req.param("id") ?? "");
      if (!p || !PAGE_ID.test(p.id)) throw new StepError(404, "not_found", "no such steps page");
      return c.json(await steps.tick(p, await bodyOf(c)));
    } catch (e) {
      return fail(c, e);
    }
  });
}
