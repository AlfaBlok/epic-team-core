import { createHash } from "node:crypto";
import { sameOpenProblem, sameQuestion } from "../inbox/duplicate.js";
import fs from "node:fs";
import path from "node:path";
import { inside } from "../adapters/doc.js";
import { withArchive } from "../adapters/spineArchive.js";
import { field, firstH1, linkTarget, proseLines, stripInline } from "../adapters/markdown.js";
import { resolveRepo } from "../adapters/repos.js";
import { parseAsks, SNOOZE_ON_LINE, SNOOZE_UNTIL } from "../inbox/asks.js";
import type { Milestone, Store } from "../store.js";
import { parseFollowups, stepState, type StepState, type Suggestion } from "./followups.js";
import { evidenceLabelOf, evidenceProblem, gateProblems } from "./card.js";
import { createAskLogReader, type PriorAnswer } from "../inbox/askRepeat.js";
import { qcFace, qcPicture, qcRequired, qcVerdict, readQc } from "./qc.js";
import { createPagesReader, pageParentProblem } from "../pagesIndex.js";
import { splitCardFiles } from "../desk/attachLimits.js";
import { activeMark, noteMarksOf, type NoteMark } from "./noteMarks.js";
import { pageNotesFor, pageNotesOf, type PageNote } from "./pageNotes.js";
import { cardFor, goalSentenceOf, plainName, plainNamesOf, projectOf, repoCards, screenshotPath, targetGoals, treeOf, type CardFace, type TargetGoal, type Sibling } from "./face.js";
import { ownerName } from "../identity.js";
import { cutUrgentLead, readyOf } from "./ready.js";
import { aboutOf } from "../inbox/about.js";
import { ticketIndex } from "../tickets/ticketIndex.js";

/**
 * "Done, waiting for your review" is a view of the spines. A review card is a spine ledger
 * row whose status cell reads `review`, in any spine of a tracked milestone's repo; its title, summary and live links
 * come from the row (Latest Evidence), and the owner's Approve / Relaunch / Snooze write that row's status cell through the
 * one spine writer. Nothing here touches console.db: the read model stores what `computeReviewRows` returns.
 */

export interface ReviewLink {
  url: string;
  title: string;
}

/** What Approve closes and what stays open in the row's epic (the card's "Approve closes …" line). */
export interface ReviewCloses {
  row: string;
  /** The epic the row sits in (M2, or the file name when the spine has no code). */
  epic: string;
  /** Other rows of that epic still open (not done or superseded), by code. */
  openRows: string[];
  /** Open asks in that epic, by code (or the first words of the question when it has none). */
  openAsks: string[];
}

/** one Done-means line of a goal. */
export interface DoneMeansLine {
  id: string;
  text: string;
  met: boolean;
}

/**
 * the goal a card sits in, its header in the feed (Done-means bar, running / parked / in work,
 * steps that closed by themselves), all read from the epic spine.
 */
export interface ReviewGoal {
  /** repo + spine file. */
  key: string;
  code: string;
  title: string;
  repo: string;
  path: string;
  milestoneId?: string;
  doneMeans: DoneMeansLine[];
  /** `holder` = who claimed the row (`spines.py --claim`), with its lease. */
  running: { ref: string; title: string; holder?: string; leaseUntil?: string }[];
  parked: { ref: string; title: string }[];
  /** New iteration with feedback: rows the owner sent back, in work until they come back. */
  inWork: { ref: string; title: string; iteration: number; words?: string; since?: string }[];
  /** Q1: steps closed `done (no confirm: …)` in the last 7 days: one timeline line, never a card. */
  selfClosed: { ref: string; title: string; why?: string; date?: string }[];
  openAsks: string[];
  /** No Done-means lines: a single ask (case E). */
  standalone: boolean;
}

/** what the card closes: one step, a Done-means line, the whole goal, or the owner's standalone ask. */
export type ReviewTag = "step" | "line" | "goal" | "ask";

export interface ReviewStarted {
  ref: string;
  title: string;
  covers?: string;
  status: string;
  state: StepState;
}

/** One row in review, as the read model keeps it. */
export interface ReviewRow {
  /** Stable from repo + file + row code (the card's id in the API). */
  id: string;
  ref: string;
  title: string;
  summary?: string;
  /** The checkout name and repo-relative spine file the row lives in. */
  repo: string;
  path: string;
  milestoneId?: string;
  /** The status cell as written (`review (deployed c38388a, waits the owner phone check)`). */
  status: string;
  links: ReviewLink[];
  /** A commit the live result must contain (`live <sha>` / `deployed <sha>` / `commit <sha>` in the row). */
  commit?: string;
  /** The row's Last Verified cell when it is a date (YYYY-MM-DD). */
  verifiedAt?: string;
  /** ` — snoozed until: <until>` on the status cell: the card is hidden until then. */
  snoozedUntil?: string;
  /**
   * ` — backlog since: <date>` on the status cell: a row that was in review before the list read the spine and
   * never reached the owner as a card. It waits in the folded "Older rows in review" list, not among his cards or counts.
   */
  backlogSince?: string;
  /** the row says `done` but the owner never reviewed it (DONE_UNREVIEWED): a card until he marks it. */
  doneUnreviewed?: boolean;
  closes: ReviewCloses;
  /** the goal it sits in (ReviewPayload.goals), the Done-means line it serves, what it closes. */
  goalKey?: string;
  line?: DoneMeansLine;
  tag?: ReviewTag;
  /** Rows already started for it (listed in its followups, or whose Depends On names it) and suggestions waiting. */
  started?: ReviewStarted[];
  suggested?: Suggestion[];
  /** `confirm: yes — <why>`: why the owner must confirm it. */
  confirmWhy?: string;
  /** The iteration this is (2 after one New iteration with feedback). */
  iteration?: number;
  /**
   * acceptance fix (manager 2026-11-02): other open cards that complete the same Done-means line. All but the last
   * (row order) read as a step "completes <line> together with <refs>"; only the last ticks the line.
   */
  lineWith?: string[];
  /**
   * what the row is, decided from the spine alone: a `card` for the owner, or (never shown to him) a row that closes
   * itself, one that goes back to the agents as "needs evidence", one whose card "needs rewriting", or a test row.
   */
  verdict: ReviewVerdict;
  /** the card face (also on a row the gate stops, so the agents see what it would show). */
  face?: CardFace;
  /** The card file the fields come from (repo-relative). */
  cardPath?: string;
  /** The repo on GitHub (owner/name), for the Details links. */
  github?: string;
  /** a test goal (TEST repo, T9xx row): on no production list; its buttons still work by id (staging checks). */
  test?: boolean;
  /** a long voice note of the owner's touched it (updated, or stale) and its owner has not acted yet. */
  noteMark?: NoteMark;
}

/** what becomes a card. Only `card` reaches the owner's list and counts. */
/** `fails-qc` (E948-S62): the quality check holds it: not what he asked, a failed look, or not checked yet. */
export type VerdictKind = "card" | "closes-itself" | "needs-evidence" | "needs-rewriting" | "fails-qc" | "test";
export interface ReviewVerdict {
  kind: VerdictKind;
  /** Plain words: why it closes itself, or what the agents must fix. */
  reason?: string;
  problems?: string[];
}

export interface ReviewPayload {
  rows: ReviewRow[];
  /** the goals of those rows and of rows sent back for a new iteration, by key. */
  goals?: ReviewGoal[];
  /** Q3: goals the owner closed (`Status: done (closed by …)`), each with what it hides, so he can reopen one. */
  closedGoals?: ClosedGoal[];
}

export interface ClosedGoal {
  key: string;
  code: string;
  title: string;
  repo: string;
  path: string;
  milestoneId?: string;
  status: string;
  /** Open items it hides (running, parked, in review) by code. */
  hidden: string[];
}

// ---------- the ledger, line by line ----------

const LEDGER_SECTION = /^(issue ledger|phases|child epics|tickets|queue|backlog|sprint|tasks|work items)\b/i;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const STATUS_COL = /^(status|state)$/i;
const TITLE_COL = /^(title|task|item|description|scope|purpose|name|summary)$/i;
const EVIDENCE_COL = /^(latest evidence|evidence)$/i;
const VERIFIED_COL = /^(last verified|verified)$/i;
const NEXT_COL = /^(next action|next step|next)$/i;
const PR_COL = /^(pr\/branch|pr|branch)$/i;
const OWNER_COL = /^(owner|assignee)/i;

export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}
const joinRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

export interface LedgerLine {
  /** 0-based line index in the file. */
  line: number;
  id: string;
  cells: string[];
  headers: string[];
  col: { status: number; title: number; evidence: number; verified: number; next: number; pr: number; owner: number };
}

/** the column of each field a ledger table's headers name (-1: none). */
export function colsOf(headers: string[]): LedgerLine["col"] {
  const find = (re: RegExp) => headers.findIndex((x) => re.test(x.trim()));
  return { status: find(STATUS_COL), title: find(TITLE_COL), evidence: find(EVIDENCE_COL), verified: find(VERIFIED_COL), next: find(NEXT_COL), pr: find(PR_COL), owner: find(OWNER_COL) };
}

/**
 * Every ledger-section table row with its line, raw cells and the column of each field. The screens (Board, Key results,
 * Inbox) read these rows from the ticket index (tickets/ticketIndex.ts), never from here: this parse is for the
 * console's writers and its "as it reads now" checks of one row (rowIn, a claim before dispatch).
 */
export function ledgerLines(text: string): LedgerLine[] {
  const lines = proseLines(text);
  const out: LedgerLine[] = [];
  let inLedger = false;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h) {
      if (inLedger && h[1].length > level) continue;
      inLedger = LEDGER_SECTION.test(stripInline(h[2]));
      level = h[1].length;
      continue;
    }
    if (!inLedger || !lines[i].trim().startsWith("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) continue;
    const headers = splitRow(lines[i]).map(stripInline);
    const col = colsOf(headers);
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const cells = splitRow(lines[j]);
      const id = stripInline(cells[0] ?? "");
      if (id) out.push({ line: j, id, cells, headers, col });
    }
    i = j - 1;
  }
  return out;
}

export const REVIEW_STATUS = /^review\b/i;

/**
 * the owner 2026-11-02: a finished row an agent wrote straight to `done` without his button is still his to
 * review. A `done` cell with none of these marks is "done, not reviewed by you": approved by him, his own words (the owner),
 * fed an ask (L-43), declared `no confirm: <why>` (Q1), folded into the row that keeps the card (root L-51),
 * superseded, or carried as backlog.
 */
export const DONE_MARKED = /approved by|\bjordi\b|\bfed\b|no confirm|folded into|superseded|reviewed by|by you\b/i;
export const DONE_UNREVIEWED = (status: string) => /^done\b/i.test(status) && !DONE_MARKED.test(status);
/** Rows closed this way from this day on are caught (older `done` rows were closed under the earlier rules). */
export const DONE_UNREVIEWED_SINCE = "2026-11-02";
/** A row whose card waits on the owner: in review, or done without his mark (only these take Approve / Relaunch / Snooze). */
export const awaitsReview = (status: string) => REVIEW_STATUS.test(status) || DONE_UNREVIEWED(status);
/** a part parked for later (a follow-up he parked, a deferred idea): it never holds its goal open (E948-S53). */
export const PARKED_STATUS = /^(draft|deferred|parked|dropped|dismissed)\b/i;
export const CLOSED_STATUS = /^(done|superseded|cancelled|canceled|moved)\b/i;

/** The snooze on a status cell (` — snoozed until: 2026-11-05`), if any. */
export function snoozeOfCell(cell: string): string | undefined {
  return new RegExp(String.raw`(?:—|--)\s+snoozed(?:\s+until)?\s*:\s*(${SNOOZE_UNTIL})\b`, "i").exec(cell)?.[1];
}

/** the backlog mark on a status cell (` — backlog since: 2026-11-02`), if any. */
export const BACKLOG_ON_CELL = /\s*(?:—|--)\s+backlog since:\s*(\d{4}-\d{2}-\d{2})\b/i;
export const backlogOfCell = (cell: string) => BACKLOG_ON_CELL.exec(cell)?.[1];

/** one-time reconcile: mark a row in review as backlog (it stays in review; Approve or Relaunch still close it). */
export const backlogCell = (ref: string, date: string) => (status: string) => {
  if (!REVIEW_STATUS.test(stripInline(status))) return notInReview(ref, status);
  if (backlogOfCell(status)) return { skip: `row ${ref} is already marked backlog` };
  return `${status.replace(/\s+$/, "")} — backlog since: ${date}`;
};

/** A table cell holds one line and no pipe. */
export const cellText = (s: string) =>
  s
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/(?<!\\)\|/g, "/")
    .trim();

export type RowEdit = { text: string; before: string; after: string; status: string } | { skip: string };

/**
 * Rewrite row `ref`'s status cell in `text`: `next(current)` returns the new cell, or `{ skip }` to refuse (the row is
 * not in review any more). Only that one line changes.
 */
export function editRowStatus(text: string, ref: string, next: (status: string) => string | { skip: string }): RowEdit {
  const raw = text.split("\n");
  const rows = ledgerLines(text).filter((r) => r.id === ref && r.col.status >= 0);
  if (!rows.length) return { skip: `row ${ref} is not in this spine's ledger any more` };
  const pick = rows.find((r) => awaitsReview(stripInline(r.cells[r.col.status] ?? ""))) ?? rows[0];
  if (pick.cells.length !== pick.headers.length) return outOfColumns(ref, pick);
  const status = pick.cells[pick.col.status] ?? "";
  const n = next(status);
  if (typeof n !== "string") return n;
  const cells = [...pick.cells];
  while (cells.length <= pick.col.status) cells.push("");
  cells[pick.col.status] = cellText(n);
  const old = raw[pick.line];
  const cr = old.endsWith("\r") ? "\r" : "";
  const line = joinRow(cells) + cr;
  raw[pick.line] = line;
  return { text: raw.join("\n"), before: old.replace(/\r$/, ""), after: line.replace(/\r$/, ""), status };
}

/**
 * A claim can never break a ticket's row: a row whose cells no longer line up with its header is never
 * written by column (the value would land in the wrong cell); scripts/ledger_rows.py repair rebuilds it on its timer.
 */
export const outOfColumns = (ref: string, r: Pick<LedgerLine, "cells" | "headers">) => ({
  skip: `row ${ref} has ${r.cells.length} cells but its header has ${r.headers.length}; nothing written until it is repaired (scripts/ledger_rows.py repair)`,
});

const notInReview = (ref: string, status: string) => ({ skip: `row ${ref} is not in review any more (it reads “${stripInline(status).slice(0, 120)}”); nothing written` });

/** Approve: `done (approved by the owner <date>)`. */
export const approveCell = (ref: string, date: string, who = ownerName()) => (status: string) =>
  awaitsReview(stripInline(status)) ? `done (approved by ${who} ${date})` : notInReview(ref, status);

/**
 * His words for a status cell: one line, round brackets made square, at most RELAUNCH_CELL_MAX characters. Round 2:
 * the files line of a card answer (desk/attachments.ts cardText) stays whole after the shortened words, so its links still open.
 */
function cellWords(text: string): string {
  const { words, files } = splitCardFiles(text);
  let w = cellText(words).replace(/[()]/g, (c) => (c === "(" ? "[" : "]"));
  if (w.length > RELAUNCH_CELL_MAX) w = `${w.slice(0, RELAUNCH_CELL_MAX - 1).trimEnd()}…`;
  return files ? `${w}${w ? " " : ""}${cellText(files)}` : w;
}

/** Relaunch: `active (relaunched by the owner <date>: <his words, one line>)`; the full words go in the commit and the wake. */
export const RELAUNCH_CELL_MAX = 300;
export const relaunchCell = (ref: string, date: string, words: string, who = ownerName(), iteration?: number) => (status: string) => {
  if (!awaitsReview(stripInline(status))) return notInReview(ref, status);
  const w = cellWords(words);
  // "New iteration with feedback": the row says which iteration is in work (the card shows "iteration N in work")
  return `active (${iteration ? `iteration ${iteration}, ` : ""}relaunched by ${who} ${date}: ${w})`;
};

/** Deny: the row closes, not done: `superseded (denied by the owner <date>[: <his reason, one line>])`. */
export const denyCell = (ref: string, date: string, reason: string, who = ownerName()) => (status: string) => {
  if (!awaitsReview(stripInline(status))) return notInReview(ref, status);
  const w = cellWords(reason);
  return `superseded (denied by ${who} ${date}${w ? `: ${w}` : ""})`;
};

/**
 * Bring it back after the press landed: a row the owner's press closed (approved, denied, or sent back with feedback)
 * goes back to `review`; any other status is not his press's and is left alone.
 */
export const CLOSED_BY_PRESS = /^(?:done \(approved by|active \((?:iteration \d+, )?relaunched by|superseded \(denied by) (.+?) \d{4}-\d{2}-\d{2}/;
export const reopenCell = (ref: string, who = ownerName()) => (status: string) => {
  const m = CLOSED_BY_PRESS.exec(stripInline(status).trim());
  return m && m[1] === who ? "review" : { skip: `row ${ref} was not closed by ${who}'s press (it reads “${stripInline(status).slice(0, 120)}”); nothing written` };
};

/** Snooze (until) or unsnooze (undefined): the status cell keeps its words and gets ` — snoozed until: <until>` at its end. */
export const snoozeCell = (ref: string, until: string | undefined) => (status: string) => {
  if (!awaitsReview(stripInline(status))) return notInReview(ref, status);
  const bare = status.replace(new RegExp(SNOOZE_ON_LINE.source, "gi"), "").replace(/\s+$/, "");
  return until ? `${bare} — snoozed until: ${until}` : bare;
};

// ---------- links from the evidence ----------

const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const BARE_URL = /(?<![(\w])https?:\/\/[^\s)<>|]+/g;

/**
 * The live links of a row: every http(s) link in its Latest Evidence cell (`[label](url)` or a bare URL), in order, once
 * each; a link to a file in the repo (`../status/x.md`) becomes its GitHub page when the repo is on GitHub.
 */
export function evidenceLinks(cell: string, o: { github?: string; fileRel: string; repoDir?: string }): ReviewLink[] {
  const out: ReviewLink[] = [];
  const add = (url: string, title: string) => {
    const u = url.replace(/[.,;:]+$/, "");
    if (!out.some((l) => l.url === u)) out.push({ url: u, title: title === url ? u : stripInline(title).trim() || u });
  };
  const rest = cell.replace(MD_LINK, (all, label: string, target: string) => {
    if (/^https?:\/\//i.test(target)) add(target, label);
    else if (o.github && !/^[a-z]+:/i.test(target) && !target.startsWith("#")) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(o.fileRel), target.split("#")[0]));
      if (!rel.startsWith("..") && (!o.repoDir || inside(o.repoDir, rel))) add(`https://github.com/${o.github}/blob/main/${rel.split("/").map(encodeURIComponent).join("/")}`, label || rel);
    }
    return " ";
  });
  for (const m of rest.matchAll(BARE_URL)) add(m[0], m[0]);
  return out;
}

const SHA_IN_ROW = /\b(?:live|deployed|commit)\s+(?:on\s+\w+\s+)?([0-9a-f]{7,40})\b/i;

// ---------- the view ----------

const TITLE_CODE = /^(?:\[[^\]]*\]\s*)?(?:EPIC:\s*)?(EPIC-\d+|M\d+)\b/;

interface FileRead {
  stamp: string;
  /** the file's ledger rows as written now, parsed on first ask: the writers' and one-row checks' read (rowIn, claims). */
  fileRows: () => LedgerLine[];
  title?: string;
  parent?: string;
  openAsks: string[];
  doneMeans: DoneMeansLine[];
  /** The Current State `Status:` value. */
  status?: string;
  /** `Project name:` (once per repo in the root spine; an epic may name its own) and `Goal sentence:`. */
  project?: { name: string; url?: string };
  goalSentence?: string;
  /** `## Plain names`: one plain name per row code, for the card's tree. */
  plainNames: Map<string, string>;
  /** Every coded ask of the spine and whether it is still open (a row that fed an answered ask closes itself). */
  askOpen: Map<string, boolean>;
  /** E907-S76: the asks of this spine he answered, so a card never asks one again (card.ts cardRepeatProblem). */
  answered: PriorAnswer[];
  /** the repo-relative `.md` files it links to (its child spines are among them). */
  links: string[];
  /** the voice-note marks of its `## Decisions` table (noteMarks.ts). */
  noteMarks: NoteMark[];
  /** his notes left in a page's own feedback box (pageNotes.ts). */
  pageNotes: PageNote[];
}

const MD_FILE_LINK = /\]\(\s*<?([^)\s#>]+\.md)(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\s*\)/g;

/** `## Done means` checkboxes: `- [ ] text` / `- [x] …`. */
export function doneMeansOf(text: string): DoneMeansLine[] {
  const out: DoneMeansLine[] = [];
  let inSec = false;
  for (const l of text.split("\n")) {
    if (/^##\s+/.test(l)) inSec = /^##\s+done means\b/i.test(l);
    if (!inSec) continue;
    const m = /^\s*[-*]\s+\[([ xX])\]\s+\**([A-Z][A-Za-z0-9]*-[A-Za-z]*\d+[a-z]?)\**\s*(.*)$/.exec(l);
    if (m) out.push({ id: m[2], text: stripInline(m[3]).replace(/\s*\(spec:.*?\)\s*/, " ").trim().slice(0, 240), met: m[1] !== " " });
  }
  return out;
}

/** The Current State `Status:` value of a spine. */
export function goalStatusOf(text: string): string | undefined {
  let inState = false;
  for (const l of text.split("\n")) {
    if (/^##\s+/.test(l)) inState = /^##\s+current state\b/i.test(l);
    const m = inState ? /^Status:\s*(.*)$/.exec(l) : null;
    if (m) return stripInline(m[1]).trim();
  }
  return undefined;
}
/** A goal the owner closed (or one superseded): its rows stop showing anywhere until it is reopened (Q3). */
export const GOAL_CLOSED = /^(done|closed|superseded|cancell?ed)\b/i;
const files = new Map<string, FileRead>();

function readFile(abs: string): FileRead | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    files.delete(abs);
    return undefined;
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = files.get(abs);
  if (hit && hit.stamp === stamp) return hit;
  const text = fs.readFileSync(abs, "utf8");
  const parentRef = field(text, "Parent spine");
  const parent = parentRef ? linkTarget(parentRef) ?? /([\w./-]+\.md)\b/.exec(parentRef)?.[1] : undefined;
  const all = parseAsks(text);
  const asks = all.filter((a) => a.state === "open");
  const project = projectOf(text);
  const goalSentence = goalSentenceOf(text);
  let rows: LedgerLine[] | undefined;
  const r: FileRead = {
    stamp,
    // parsed only when a writer or a one-row check asks (rowIn, claims); the Inbox reads the index (screenDoc)
    fileRows: () => (rows ??= ledgerLines(text)),
    title: firstH1(text),
    ...(parent ? { parent } : {}),
    openAsks: asks.map((a) => a.code ?? a.question.split(/\s+/).slice(0, 6).join(" ")),
    doneMeans: doneMeansOf(text),
    ...(goalStatusOf(text) ? { status: goalStatusOf(text) } : {}),
    ...(project ? { project } : {}),
    ...(goalSentence ? { goalSentence } : {}),
    plainNames: plainNamesOf(text),
    askOpen: new Map(all.filter((a) => a.code).map((a) => [a.code!, a.state === "open"])),
    answered: all
      .filter((a) => a.state === "answered" && !a.feedback && !a.supersededBy && a.since)
      .map((a) => ({ code: a.code ?? null, row: a.row ?? null, question: a.question, answer: a.answer ?? null, on: a.since! })),
    links: [...new Set([...text.matchAll(MD_FILE_LINK)].map((m) => m[1]).filter((t) => !/^[a-z]+:/i.test(t)))],
    noteMarks: noteMarksOf(text),
    pageNotes: pageNotesOf(text),
  };
  files.set(abs, r);
  return r;
}

/** a spine as the Inbox reads it: the file's own facts, its ticket rows from the ticket index. */
type ScreenDoc = FileRead & { rows: LedgerLine[] };
function screenDoc(abs: string): ScreenDoc | undefined {
  const doc = readFile(abs);
  return doc ? { ...doc, rows: ticketIndex().lines(abs) } : undefined;
}

/** Card id: stable while the row keeps its code and file. */
/** the card id before E948-S182 (repo, spine path, row): a row moved to another epic got a new card. */
export const reviewLegacyId = (repo: string, rel: string, ref: string) => `rv_${createHash("sha1").update(`${repo}\0${rel}\0${ref}`).digest("hex").slice(0, 20)}`;
/** a row code that names its epic (`E948-S182`, `TAX-S3`): unique in its repo, so it alone keys the card. */
const CODED_ROW = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z]*\d+$/;
/**
 * E948-S182 (E906-S228 moved rows from EPIC-906 to EPIC-9105 and their cards got new ids): a review card is keyed by repo and
 * row code, wherever the row sits; a bare row code (`T6`, `S1`, shared by many epics) keeps the path id.
 */
export const reviewId = (repo: string, rel: string, ref: string) =>
  CODED_ROW.test(ref) ? `rv_${createHash("sha1").update(`${repo}\0row\0${ref.toUpperCase()}`).digest("hex").slice(0, 20)}` : reviewLegacyId(repo, rel, ref);

/** Spine files read per repo at most (a guard against a link web, not a real limit: the code repo has about 80). */
const MAX_SPINES = 2000;

/**
 * the folders of a repo's spine tree. A milestone's epics need not sit beside its root spine (tax-assist-research:
 * `docs/EPIC_SPINE.md` with its epics in `docs/spines/`), so the tree is followed down from each milestone spine: a linked
 * `.md` file whose `Parent spine:` points back at the spine that links it is a child, and its folder is read too.
 */
export function spineFolders(dir: string, roots: string[]): Set<string> {
  const folders = new Set(roots.map((r) => path.posix.dirname(r)));
  const seen = new Set(roots);
  const todo = [...roots];
  while (todo.length && seen.size < MAX_SPINES) {
    const at = todo.shift()!;
    const abs = inside(dir, at);
    const doc = abs ? readFile(abs) : undefined;
    for (const target of doc?.links ?? []) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(at), target));
      if (rel.startsWith("..") || seen.has(rel)) continue;
      const cabs = inside(dir, rel);
      const child = cabs ? readFile(cabs) : undefined;
      if (!child?.parent) continue;
      if (path.posix.normalize(path.posix.join(path.posix.dirname(rel), child.parent)) !== at) continue;
      seen.add(rel);
      folders.add(path.posix.dirname(rel));
      todo.push(rel);
    }
  }
  return folders;
}

const mdIn = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
};

/**
 * Every row in review across the repos of `store`'s milestones (settled milestones are left out, unless another milestone
 * tracks the same repo). Read from each milestone spine's folder: every spine file beside it. The milestone a row belongs
 * to is the one whose spine is the row's file or its nearest `Parent spine:` ancestor, else the repo's first milestone.
 */
/** the home repo's page list per repos root (docs/pages/registry.json), read again when it changes. */
const pageLists = new Map<string, ReturnType<typeof createPagesReader>>();
/** E948-S180 the hosts whose pages take a deep link: the page hub's (its page list) and the console's own address. */
function ownHosts(reg: { hosts: string[] } | undefined): string[] {
  const pub = (() => {
    try {
      return process.env.CONSOLE_PUBLIC_URL ? [new URL(process.env.CONSOLE_PUBLIC_URL).hostname] : [];
    } catch {
      return [];
    }
  })();
  return [...(reg?.hosts ?? []), ...pub];
}

/** E907-S76: the home repo's asks log folded to what he answered, read again when it changes. */
const askLogReaders = new Map<string, ReturnType<typeof createAskLogReader>>();
function askLogOf(reposRoot: string): PriorAnswer[] {
  if (!askLogReaders.has(reposRoot)) askLogReaders.set(reposRoot, createAskLogReader({ reposRoot }));
  return askLogReaders.get(reposRoot)!();
}

export function computeReviewRows(store: Pick<Store, "listMilestones">, reposRoot: string, only: { repoDir?: string } = {}): ReviewPayload {
  if (!pageLists.has(reposRoot)) pageLists.set(reposRoot, createPagesReader({ reposRoot }));
  const pageList = pageLists.get(reposRoot)?.registry();
  const ms = store.listMilestones({}).filter((m) => !m.settledAt);
  const byRepo = new Map<string, { dir: string; name: string; github?: string; ms: Milestone[]; folders: Set<string> }>();
  for (const m of ms) {
    const repo = resolveRepo(reposRoot, m.repo);
    if (!repo || !m.path) continue;
    const g = byRepo.get(repo.path) ?? { dir: repo.path, name: repo.name, ms: [], folders: new Set<string>() };
    g.github ??= repo.remote ?? (/^[\w.-]+\/[\w.-]+$/.test(m.repo) ? m.repo : undefined);
    g.ms.push(m);
    g.folders.add(path.posix.dirname(m.path));
    byRepo.set(repo.path, g);
  }
  const rows: ReviewRow[] = [];
  /** the unmerged work branch each row names (its PR/Branch cell), for the one-page-one-card pass. */
  const branchOf = new Map<ReviewRow, string>();
  const goals: ReviewGoal[] = [];
  const closedGoals: ClosedGoal[] = [];
  for (const g of byRepo.values()) {
    if (only.repoDir && g.dir !== only.repoDir) continue; // one repo's rows (a press re-reads its own row)
    let targets: Map<string, TargetGoal> | undefined;
    for (const f of spineFolders(g.dir, g.ms.map((m) => path.posix.normalize(m.path)))) g.folders.add(f);
    const msByPath = new Map(g.ms.map((m) => [path.posix.normalize(m.path), m]));
    const milestoneOf = (rel: string): Milestone | undefined => {
      let at = rel;
      for (let hop = 0; hop < 12 && at; hop++) {
        const hit = msByPath.get(at);
        if (hit) return hit;
        const abs = inside(g.dir, at);
        const parent = abs ? readFile(abs)?.parent : undefined;
        if (!parent) break;
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(at), parent));
        if (next === at || next.startsWith("..")) break;
        at = next;
      }
      return g.ms[0];
    };
    // the repo's card files, and the project name: the nearest `Project name:` up the `Parent spine:` chain,
    // else the milestone's root spine's (once per repo)
    const cards = repoCards(g.dir);
    const cardIndex = new Map(cards.map((c) => [c.fields.row ?? "", c.fields]));
    const projectFor = (rel: string): FileRead["project"] => {
      let at = rel;
      for (let hop = 0; hop < 12 && at; hop++) {
        const abs = inside(g.dir, at);
        const d = abs ? readFile(abs) : undefined;
        if (d?.project) return d.project;
        if (!d?.parent) break;
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(at), d.parent));
        if (next === at || next.startsWith("..")) break;
        at = next;
      }
      for (const m of g.ms) {
        const abs = inside(g.dir, m.path);
        const p = abs ? readFile(abs)?.project : undefined;
        if (p) return p;
      }
      return undefined;
    };
    const seen = new Set<string>();
    for (const folder of [...g.folders].sort()) {
      const docs = mdIn(path.join(g.dir, folder)).map((f) => {
        const rel = path.posix.normalize(path.posix.join(folder, f));
        return { rel, doc: screenDoc(path.join(g.dir, rel)) };
      });
      // every row of the folder by code (a card's started follow-ups may sit in another spine beside it)
      const byCode = new Map<string, { title: string; status: string; dependsOn: string }>();
      for (const { doc } of docs)
        for (const r of doc?.rows ?? []) {
          if (byCode.has(r.id)) continue;
          const dep = r.headers.findIndex((h) => /^depends/i.test(h));
          byCode.set(r.id, { title: r.col.title >= 0 ? stripInline(r.cells[r.col.title] ?? "") : "", status: r.col.status >= 0 ? stripInline(r.cells[r.col.status] ?? "") : "", dependsOn: dep >= 0 ? stripInline(r.cells[dep] ?? "") : "" });
        }
      for (const { rel, doc } of docs) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        if (!doc) continue;
        // Q3: a goal the owner closed hides every open item in it (feed, counts, parked lists) until he reopens it
        if (doc.status && GOAL_CLOSED.test(doc.status)) {
          // closed by the owner (not an old done epic): listed so he can reopen it, with what it hides
          if (/closed by /i.test(doc.status)) {
            const epic = TITLE_CODE.exec(stripInline(doc.title ?? ""))?.[1] ?? path.posix.basename(rel, ".md");
            const m = milestoneOf(rel);
            const hidden = [...new Set(doc.rows.filter((x) => /\d/.test(x.id) && x.col.status >= 0 && !CLOSED_STATUS.test(stripInline(x.cells[x.col.status] ?? ""))).map((x) => x.id))];
            closedGoals.push({ key: `${g.name}:${rel}`, code: epic, title: stripInline(doc.title ?? epic).replace(/^(?:EPIC:\s*)?(EPIC-\d+|M\d+)\s*[:·—-]?\s*/, "").trim() || epic, repo: g.name, path: rel, ...(m ? { milestoneId: m.id } : {}), status: doc.status, hidden });
          }
          continue;
        }
        const epic = TITLE_CODE.exec(stripInline(doc.title ?? ""))?.[1] ?? path.posix.basename(rel, ".md");
        const m = milestoneOf(rel);
        const goal = goalOf(doc, { key: `${g.name}:${rel}`, code: epic, repo: g.name, path: rel, ...(m ? { milestoneId: m.id } : {}) });
        let used = goal.inWork.length > 0;
        const once = new Set<string>();
        for (const r of doc.rows) {
          const status = r.col.status >= 0 ? (r.cells[r.col.status] ?? "") : "";
          if (once.has(r.id)) continue;
          const evidence = r.col.evidence >= 0 ? (r.cells[r.col.evidence] ?? "") : "";
          const verified = r.col.verified >= 0 ? /^\d{4}-\d{2}-\d{2}$/.exec(stripInline(r.cells[r.col.verified] ?? ""))?.[0] : undefined;
          // done without the owner's mark, closed from DONE_UNREVIEWED_SINCE on, with a live result to open
          const unreviewed =
            DONE_UNREVIEWED(stripInline(status)) && !!verified && verified >= DONE_UNREVIEWED_SINCE && /https?:\/\//i.test(evidence) && /\d/.test(r.id);
          if (!REVIEW_STATUS.test(stripInline(status)) && !unreviewed) continue;
          once.add(r.id);
          used = true;
          const titleCell = r.col.title >= 0 ? stripInline(r.cells[r.col.title] ?? "") : "";
          const nextCell = r.col.next >= 0 ? (r.cells[r.col.next] ?? "") : "";
          const commit = SHA_IN_ROW.exec(stripInline(evidence))?.[1] ?? SHA_IN_ROW.exec(stripInline(status))?.[1] ?? (r.col.pr >= 0 ? SHA_IN_ROW.exec(stripInline(r.cells[r.col.pr] ?? ""))?.[1] : undefined);
          const until = snoozeOfCell(status);
          const backlog = backlogOfCell(status);
          const summary = stripInline(evidence).replace(/\s+/g, " ").trim();
          const fu = parseFollowups(nextCell);
          const started: ReviewStarted[] = fu.started
            .filter((c) => c.ref !== r.id)
            .map((c) => {
              const x = byCode.get(c.ref);
              return { ref: c.ref, title: x?.title ?? "", ...(c.covers ? { covers: c.covers } : {}), status: x?.status ?? "", state: stepState(x?.status ?? "") };
            });
          for (const [code, x] of byCode)
            if (code !== r.id && !started.some((s) => s.ref === code) && mentions(x.dependsOn, r.id)) started.push({ ref: code, title: x.title, status: x.status, state: stepState(x.status) });
          const iteration = iterationOf(r.cells);
          // the card fields (one card file per row) and the verdict, from the repo only
          const cf = cardFor(g.dir, rel, r.id, r.cells, cards);
          const card = cf?.fields;
          const completes = card?.completes ?? fu.completes;
          const project = projectFor(rel);
          const shot = cf ? screenshotPath(g.dir, cf.rel, card?.screenshot) : undefined;
          // E948-S62: the quality check's result beside the card (his words point by point, the live screens)
          const qc = cf ? readQc(g.dir, r.id) : undefined;
          const qcSeen = qcFace(g.dir, qc);
          const cardRaw = cf ? (() => { try { return fs.readFileSync(path.join(g.dir, cf.rel)); } catch { return undefined; } })() : undefined;
          const siblings: Sibling[] = [];
          const sibSeen = new Set<string>();
          for (const x of doc.rows) {
            if (sibSeen.has(x.id) || !/\d/.test(x.id) || x.col.status < 0) continue;
            sibSeen.add(x.id);
            siblings.push({ ref: x.id, status: x.cells[x.col.status] ?? "", name: doc.plainNames.get(x.id) ?? cardIndex.get(x.id)?.name });
          }
          // E948-S53: the goal closes only from its last open part. Other parts still worked on (ready, active, blocked…)
          // or still waiting for his own review keep this card a plain step; parked drafts do not hold the goal open.
          const { working, reviewing } = goalStillOpen(siblings, r.id);
          const { line, tag } = tagOf(doc, completes, goal, working.length + reviewing.length);
          const thisName = plainName(card?.name) ?? plainName(doc.plainNames.get(r.id)) ?? card?.title ?? titleCell;
          const tree = treeOf(siblings, r.id, thisName);
          // the card's next steps (plain words) win; `next: none` says there are none; else the row's followups
          const next = (card?.next.length ? card.next : card?.nextNone ? [] : fu.suggested).map((n) => {
            // a follow-up for another goal carries that goal's plain name
            if (!("target" in n) || !n.target) return n;
            targets ??= targetGoals(g.dir);
            const t = targets.get(n.target);
            return t ? { ...n, targetName: t.name } : n;
          });
          const face: CardFace | undefined = card
            ? {
                // E948-S172: the topic first, in his words
                ...(() => {
                  const t = aboutOf({ about: card.about, name: plainName(card.name) ?? plainName(doc.plainNames.get(r.id)), title: card.title, goal: doc.goalSentence });
                  return t ? { about: t.about } : {};
                })(),
                project: project ?? { name: g.name },
                goal: { text: (doc.goalSentence ?? stripInline(doc.title ?? epic)).replace(/\.$/, ""), code: epic },
                tasks: tree.tasks,
                // E948-S168: a leading "Urgent." is the label, never the title (the Adeje card showed "Urgent." alone)
                title: cutUrgentLead(card.title ?? "").title,
                taskGoal: card.goal ?? "",
                delivered: card.delivered,
                evidence: { url: card.evidenceUrl ?? "", label: evidenceLabelOf(card), ...(card.look ? { look: card.look } : {}) },
                // his card always shows the thing itself: the check's live screen once it passed, else the worker's picture
                ...((qcPicture(qcSeen) ?? shot) ? { screenshot: qcPicture(qcSeen) ?? shot } : {}),
                ...(qcSeen ? { qc: qcSeen } : {}),
                tree: tree.lines,
                ...(card.after ? { after: card.after } : {}),
                next,
                closesGoal: tag === "goal",
                ...(card.from?.name ? { from: card.from } : {}),
                ...(card.source ? { source: card.source } : {}),
                ...(card.decision ? { decision: card.decision } : {}),
                // a note he left inside the page itself shows here, so he sees it landed
                ...(() => {
                  const urls = [card.evidenceUrl, ...[...evidence.matchAll(/https?:\/\/[^\s)\]|>"]+/g)].map((x) => x[0])];
                  const notes = pageNotesFor(doc.pageNotes, r.id, urls);
                  return notes.length ? { pageNotes: notes.map(({ refs: _r, ...n }) => n) } : {};
                })(),
                ...(card.options?.length ? { options: card.options } : {}),
                ...(card.deadline ? { deadline: card.deadline } : {}),
                // something he waits on (a deadline, urgent, his "send me…", or the card's `ready:`) leads his inbox
                ...(() => {
                  const ready = readyOf({ ready: card.ready, deadline: card.deadline, words: [titleCell, card.source ?? ""], source: card.source ?? "", labelled: !!card.urgent || cutUrgentLead(card.title ?? "").urgent || cutUrgentLead(titleCell).urgent, evidence: { url: card.evidenceUrl ?? "", label: evidenceLabelOf(card) } });
                  return ready ? { ready } : {};
                })(),
                openInGoal: siblings
                  .filter((x) => x.ref !== r.id && !CLOSED_STATUS.test(stripInline(x.status)))
                  .map((x) => ({ ref: x.ref, ...(plainName(x.name) ? { name: plainName(x.name) } : {}) })),
              }
            : undefined;
          const yes = card?.confirm ? card.confirm.yes : fu.confirm?.yes;
          const why = (card?.confirm?.yes === yes ? card?.confirm?.why : undefined) ?? (fu.confirm?.yes === yes ? fu.confirm?.why : undefined);
          const confirm = yes === undefined ? undefined : { yes, ...(why ? { why } : {}) };
          const startedOwn = fu.started.filter((c) => c.ref !== r.id).map((c) => stepState(byCode.get(c.ref)?.status ?? ""));
          // (the owner 23 Nov 00:29Z: "Closed by the team, it should not be possible ... I never ask for this"): a row he sent
          // back (it is in a later iteration) never closes itself. What would have closed it goes back to its worker
          // instead, so the round returns to him as a card and only his press closes it.
          const selfClose = (reason: string): ReviewVerdict =>
            iteration > 1
              ? { kind: "needs-rewriting", reason: "card needs rewriting", problems: [`${ownerName()} sent this card back, so only his press closes it (it would have closed itself: ${reason}). Write its card with \`confirm: yes\` so this round returns to him`] }
              : { kind: "closes-itself", reason };
          const verdict: ReviewVerdict = (() => {
            // the console never closes a ticket by default: a row in review that says neither `confirm: yes` nor
            // `confirm: no` goes back to its worker to say which. (A ticket the owner asked for at 10:06Z on 22 Nov was
            // closed this way 4 minutes after it reached review, and again at 00:03Z after he asked for it back.)
            if (!confirm) return { kind: "needs-rewriting", reason: "card needs rewriting", problems: [`the row says neither \`confirm: yes\` nor \`confirm: no\`: write its card with \`confirm: yes\` so it reaches ${ownerName()}, or \`confirm: no — <why he has nothing to judge>\`; the console no longer closes a ticket by default`] };
            if (!confirm.yes) return selfClose(confirm.why ?? `nothing for ${ownerName()} to open and judge`);
            if (card?.fed && doc.askOpen.get(card.fed) === false) return selfClose(`the ask it fed, ${card.fed}, is answered`);
            if (card?.exampleOf) return selfClose(`an example made for ${card.exampleOf}: that feature's card is the one card`);
            if (startedOwn.length && startedOwn.every((x) => x === "running" || x === "live") && !next.length) return selfClose("its next steps already run");
            // a one-off page with no parent (no entry in the page list) is an island: never his card.
            const ev = card ? (evidenceProblem(card, stripInline(status)) ?? pageParentProblem(card.evidenceUrl, pageList)) : undefined;
            if (ev) return { kind: "needs-evidence", reason: ev };
            const problems = gateProblems({ ...(card ? { card } : {}), ...(project ? { project: project.name } : {}), ...(doc.goalSentence ? { goalSentence: doc.goalSentence } : {}), screenshotFound: !!shot, ownHosts: ownHosts(pageList), answered: [...doc.answered, ...askLogOf(reposRoot)] });
            // E948-S53: a card that says it completes the goal while other parts are still worked on
            // never reaches him; it would offer a close and then warn him against it.
            if (completes === "goal" && working.length)
              problems.push(
                `the card says it completes the goal, but ${working.length} other ${working.length === 1 ? "part is" : "parts are"} still open (${working.map((x) => x.ref).join(", ")}): drop the \`completes: goal\` line, or finish them first`,
              );
            if (problems.length) return { kind: "needs-rewriting", reason: "card needs rewriting", problems };
            // E948-S62: did he get what he asked for, and does it look right at 390 and 1280: else back to its worker
            const q = qcVerdict({ row: r.id, required: qcRequired(g.dir), qc, cardText: cardRaw });
            if (q) return q;
            return { kind: "card" };
          })();
          const branch = r.col.pr >= 0 ? workBranchOf(r.cells[r.col.pr] ?? "") : undefined;
          // a voice note's mark holds while the status cell is the one it was written against
          const noteMark = activeMark(doc.noteMarks, r.id, status);
          rows.push({
            id: reviewId(g.name, rel, r.id),
            ref: r.id,
            title: (cutUrgentLead(titleCell).title || r.id).slice(0, 300),
            ...(summary && summary !== "none" ? { summary: summary.slice(0, 2000) } : {}),
            repo: g.name,
            path: rel,
            ...(m ? { milestoneId: m.id } : {}),
            status: stripInline(status),
            // the live check is the card's evidence link (L-47), never the row's GitHub write-ups
            links: card?.evidenceUrl ? [{ url: card.evidenceUrl, title: evidenceLabelOf(card) }] : evidenceLinks(evidence, { ...(g.github ? { github: g.github } : {}), fileRel: rel, repoDir: g.dir }),
            ...(commit ? { commit: commit.toLowerCase() } : {}),
            ...(verified ? { verifiedAt: verified } : {}),
            ...(until ? { snoozedUntil: until } : {}),
            ...(backlog ? { backlogSince: backlog } : {}),
            ...(unreviewed ? { doneUnreviewed: true } : {}),
            closes: {
              row: r.id,
              epic,
              openRows: [...new Set(doc.rows.filter((x) => x.id !== r.id && x.col.status >= 0 && !CLOSED_STATUS.test(stripInline(x.cells[x.col.status] ?? "")) && /\d/.test(x.id)).map((x) => x.id))],
              openAsks: doc.openAsks,
            },
            goalKey: goal.key,
            ...(line ? { line } : {}),
            tag,
            started,
            suggested: next,
            ...(confirm?.yes && confirm.why ? { confirmWhy: confirm.why } : {}),
            ...(iteration > 1 ? { iteration } : {}),
            verdict,
            ...(TEST_REPO.test(g.name) || TEST_ROW.test(r.id) || /^TEST\b/i.test(stripInline(doc.title ?? "")) ? { test: true } : {}),
            ...(face ? { face } : {}),
            ...(cf ? { cardPath: cf.rel } : {}),
            ...(g.github ? { github: g.github } : {}),
            ...(noteMark ? { noteMark } : {}),
          });
          if (branch) branchOf.set(rows[rows.length - 1], branch);
        }
        // two open cards completing one line (or the goal): only the last, in row
        // order, closes it (case C); the others are tasks of it (case A).
        const fileRows = rows.filter((x) => x.goalKey === goal.key && x.verdict.kind === "card" && (x.tag === "line" || x.tag === "goal"));
        for (const target of new Set(fileRows.map((x) => (x.tag === "goal" && !x.line ? "goal" : x.line?.id ?? "goal")))) {
          const same = fileRows.filter((x) => (x.tag === "goal" && !x.line ? "goal" : x.line?.id ?? "goal") === target);
          if (same.length < 2) continue;
          for (const x of same) x.lineWith = same.filter((y) => y !== x).map((y) => y.ref);
          for (const x of same.slice(0, -1)) {
            x.tag = x.line && !x.line.met ? "line" : "step";
            if (x.face) x.face = { ...x.face, closesGoal: false };
            if (x.tag === "line") x.tag = "step";
          }
        }
        if (used) goals.push(goal);
      }
    }
  }
  // E948-S182: one row code in two spines of a repo (a real duplicate) keeps both cards apart by their path ids
  const ids = new Map<string, number>();
  for (const r of rows) ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
  for (const r of rows) if ((ids.get(r.id) ?? 0) > 1) r.id = reviewLegacyId(r.repo, r.path, r.ref);
  onePageOneCard(rows, branchOf);
  oneQuestionOneCard(rows);
  return { rows, goals, closedGoals };
}

/**
 * were two cards for one page, the
 * EpicTeam preview from one unmerged branch; he marked and then met asking about the same page. Cards that
 * open the same page (host and path; `#part` and `?query` ignored) from the same work branch are one deliverable: only one
 * stays a card (the freshest Last Verified, then row order), the others go back to the agents as "card needs rewriting",
 * to fold into that card. A live page on main (the production site) is shared by many features, so the branch is part of the key.
 */
export function onePageOneCard(rows: ReviewRow[], branchOf: Map<ReviewRow, string>): void {
  const groups = new Map<string, ReviewRow[]>();
  for (const x of rows) {
    const branch = branchOf.get(x);
    const page = x.verdict.kind === "card" && !x.test ? pageOf(x.links[0]?.url) : undefined;
    if (!branch || !page) continue;
    const k = `${branch}\0${page}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  for (const same of groups.values()) {
    if (same.length < 2) continue;
    const keep = same.reduce((a, b) => ((b.verifiedAt ?? "") > (a.verifiedAt ?? "") ? b : a));
    for (const x of same) {
      if (x === keep) continue;
      x.verdict = {
        kind: "needs-rewriting",
        reason: "card needs rewriting",
        problems: [
          `it opens the same page as ${keep.ref}'s card, from the same branch ${branchOf.get(x)}: one page, one card. Fold what it delivered into ${keep.ref}'s card and close this row \`done (folded into ${keep.ref})\`, or give it a page of its own`,
        ],
      };
    }
  }
}

/**
 * E948-S139 (the owner, 24 Nov: "you were asking me for the same thing several times"): two cards of one repo whose title
 * and decision, and whose rows' own titles, are nearly the same words are one question: the first to reach him stays a card (the older Last Verified,
 * then row order), the newer goes back to its agents as "card needs rewriting" to fold into it, so he never sees it twice.
 */
export function oneQuestionOneCard(rows: ReviewRow[]): void {
  const text = (x: ReviewRow) => [x.face?.title ?? x.title, x.face?.decision].filter(Boolean).join(" ");
  const live = rows.filter((x) => x.verdict.kind === "card" && !x.test);
  for (const x of live) {
    if (x.verdict.kind !== "card") continue;
    const older = live.find((y) => y !== x && y.repo === x.repo && y.verdict.kind === "card" && ((y.verifiedAt ?? "") < (x.verifiedAt ?? "") || ((y.verifiedAt ?? "") === (x.verifiedAt ?? "") && rows.indexOf(y) < rows.indexOf(x))) && sameQuestion(text(x), text(y)) && sameQuestion(x.title, y.title));
    if (older) x.verdict = { kind: "needs-rewriting", reason: "card needs rewriting", problems: [sameOpenProblem(`${older.ref}'s card`)] };
  }
}

/** The page a link opens: host (with port) and path, without `#part`, `?query` or a trailing slash. */
export function pageOf(url: string | undefined): string | undefined {
  try {
    const u = new URL(url ?? "");
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** The unmerged work branch a PR/Branch cell names (`<repo> branch wt/x`, a PR link), never main, master or none. */
export function workBranchOf(cell: string): string | undefined {
  const t = stripInline(cell);
  const pr = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i.exec(t)?.[0];
  if (pr) return pr.toLowerCase();
  const b = /\bbranch\s+`?([\w./-]+)/i.exec(t)?.[1]?.replace(/[.,;:]+$/, "");
  return b && !/^(main|master|none)$/i.test(b) ? b : undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (cell: string | undefined, ref: string) => !!cell && new RegExp(`(^|[^\\w-])${escapeRe(ref)}(?![\\w-])`).test(cell);

const RUNNING = /^(active|ready|running|dispatched|in[ -]progress|blocked|monitoring|testing|queued)\b/i;
const PARKED = /^(draft|parked|deferred)\b/i;
/** a row he sent back (its status keeps `relaunched by` or its `iteration <n>`) that is still being worked on. */
export const SENT_BACK = /^(active|ready|running|dispatched|in[ -]progress|blocked|monitoring|testing|queued|waiting)\b.*\b(relaunched by|iteration \d+)/i;

/** The iteration a row is in: the highest `iteration <n>` in its cells (1 when none). */
export function iterationOf(cells: string[]): number {
  let n = 1;
  for (const c of cells) for (const m of stripInline(c).matchAll(/\biteration\s+(\d+)\b/gi)) n = Math.max(n, Number(m[1]));
  return n;
}

/** a goal's header, read from its spine. */
function goalOf(doc: ScreenDoc, base: Pick<ReviewGoal, "key" | "code" | "repo" | "path" | "milestoneId">): ReviewGoal {
  const title = stripInline(doc.title ?? base.code).replace(/^(?:EPIC:\s*)?(EPIC-\d+|M\d+)\s*[:·—-]?\s*/, "").trim() || base.code;
  const running: ReviewGoal["running"] = [];
  const parked: ReviewGoal["parked"] = [];
  const inWork: ReviewGoal["inWork"] = [];
  const selfClosed: ReviewGoal["selfClosed"] = [];
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const once = new Set<string>();
  for (const r of doc.rows) {
    if (once.has(r.id) || !/\d/.test(r.id)) continue;
    once.add(r.id);
    const st = r.col.status >= 0 ? stripInline(r.cells[r.col.status] ?? "") : "";
    const t = (r.col.title >= 0 ? stripInline(r.cells[r.col.title] ?? "") : "").slice(0, 160);
    // any status still being worked on (ready, queued, blocked, monitoring), not only `active`: a row he sent
    // back that waits for a worker is still his sent-back card
    if (SENT_BACK.test(st)) {
      const words = /relaunched by \w+ (\d{4}-\d{2}-\d{2}):\s*(.*?)\)?$/i.exec(st);
      inWork.push({ ref: r.id, title: t, iteration: Math.max(2, iterationOf(r.cells)), ...(words?.[2] ? { words: words[2].slice(0, 200) } : {}), ...(words?.[1] ? { since: words[1] } : {}) });
    } else if (RUNNING.test(st)) {
      const c = r.col.owner >= 0 ? claimOf(r.cells[r.col.owner] ?? "") : undefined;
      running.push({ ref: r.id, title: t, ...(c ? { holder: c.by, leaseUntil: c.until } : {}) });
    }
    else if (PARKED.test(st)) parked.push({ ref: r.id, title: t });
    else if (/^done\b.*\bno confirm\b/i.test(st)) {
      const v = r.col.verified >= 0 ? /^\d{4}-\d{2}-\d{2}$/.exec(stripInline(r.cells[r.col.verified] ?? ""))?.[0] : undefined;
      if (!v || v >= week) selfClosed.push({ ref: r.id, title: t, ...(/no confirm:\s*([^)]*)/i.exec(st)?.[1] ? { why: /no confirm:\s*([^)]*)/i.exec(st)![1].trim() } : {}), ...(v ? { date: v } : {}) });
    }
  }
  return { ...base, title, doneMeans: doc.doneMeans, running, parked, inWork, selfClosed, openAsks: doc.openAsks, standalone: doc.doneMeans.length === 0 };
}

/**
 * what the row completes comes only from an explicit `completes:` (its card file or its Next
 * Action followups), never from codes in its title text. `goal`, or the epic's last open Done-means line, is case C (the
 * card closes the goal); another open Done-means line is ticked when the card is marked complete; else it is a task.
 */
/**
 * E948-S53: the other parts of a goal that keep it open: `working` (not closed, not parked, not in review) and
 * `reviewing` (in review, each its own card). Parked drafts (a follow-up he parked) never hold a goal open.
 */
export function goalStillOpen(siblings: Pick<Sibling, "ref" | "status">[], self: string): { working: Pick<Sibling, "ref" | "status">[]; reviewing: Pick<Sibling, "ref" | "status">[] } {
  const others = siblings.filter((x) => x.ref !== self && !CLOSED_STATUS.test(stripInline(x.status)));
  const reviewing = others.filter((x) => REVIEW_STATUS.test(stripInline(x.status)));
  const working = others.filter((x) => !REVIEW_STATUS.test(stripInline(x.status)) && !PARKED_STATUS.test(stripInline(x.status)));
  return { working, reviewing };
}

/** `open`: how many other parts of the goal still hold it open; while any do, no card closes the goal (E948-S53). */
export function tagOf(doc: Pick<FileRead, "doneMeans">, completes: string | undefined, goal: Pick<ReviewGoal, "standalone">, open = 0): { line?: DoneMeansLine; tag: ReviewTag } {
  if (!completes) return { tag: "step" };
  if (completes === "ask") return { tag: "goal" };
  if (completes === "goal") return { tag: open ? "step" : "goal" };
  const line = doc.doneMeans.find((d) => d.id === completes);
  if (!line || line.met) return { tag: "step" };
  const lastOpen = doc.doneMeans.every((d) => d.met || d.id === line.id);
  return { line, tag: lastOpen && !goal.standalone && !open ? "goal" : "line" };
}

/** test goals never reach a production list: a TEST repo or a T9xx row. */
export const TEST_REPO = /(^|[-_.])test([-_.]|$)/i;
export const TEST_ROW = /^T9\d\d(\b|-)/;

// ----------: claims and leases ----------

/** `<by> — claimed <UTC>, lease until <UTC>` in a row's Owner cell (written by the EpicSpine `spines.py --claim`). */
export const CLAIM_CELL = /^(.*?)\s*[—-]+\s*claimed (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z), lease until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)/;
export function claimOf(cell: string): { by: string; at: string; until: string } | undefined {
  const m = CLAIM_CELL.exec(stripInline(cell).trim());
  return m && m[1].trim() ? { by: m[1].trim(), at: m[2], until: m[3] } : undefined;
}

export interface ClaimedRow {
  repo: string;
  dir: string;
  path: string;
  ref: string;
  status: string;
  by: string;
  at: string;
  until: string;
}

/** Every claimed, still-open row across the tracked repos (one entry per row code and file). */
export function computeClaims(store: Pick<Store, "listMilestones">, reposRoot: string): ClaimedRow[] {
  const out: ClaimedRow[] = [];
  const seen = new Set<string>();
  for (const m of store.listMilestones({}).filter((x) => !x.settledAt)) {
    const repo = resolveRepo(reposRoot, m.repo);
    if (!repo || !m.path) continue;
    const folder = path.posix.dirname(m.path);
    for (const f of mdIn(path.join(repo.path, folder))) {
      const rel = path.posix.normalize(path.posix.join(folder, f));
      if (seen.has(`${repo.path}\0${rel}`)) continue;
      seen.add(`${repo.path}\0${rel}`);
      const doc = readFile(path.join(repo.path, rel));
      for (const r of doc?.fileRows() ?? []) {
        if (r.col.owner < 0 || r.col.status < 0) continue;
        const c = claimOf(r.cells[r.col.owner] ?? "");
        const status = stripInline(r.cells[r.col.status] ?? "");
        if (!c || CLOSED_STATUS.test(status)) continue;
        out.push({ repo: repo.name, dir: repo.path, path: rel, ref: r.id, status, ...c });
      }
    }
  }
  return out;
}

/**
 * the claim written in row `ref`'s Owner cell in the checkout `dir` (docs/spines/*.md, then docs/*.md, the folders
 * claim.py searches), when the row is not closed: the dispatch-time check reads it before a worker starts.
 */
export function rowClaimIn(dir: string, ref: string): (ClaimedRow & { dir: string }) | undefined {
  for (const folder of ["docs/spines", "docs"])
    for (const f of mdIn(path.join(dir, folder))) {
      const rel = path.posix.join(folder, f);
      const doc = readFile(path.join(dir, rel));
      const r = doc?.fileRows().find((x) => x.id === ref);
      if (!r || r.col.owner < 0) continue;
      const status = r.col.status >= 0 ? stripInline(r.cells[r.col.status] ?? "") : "";
      const c = claimOf(r.cells[r.col.owner] ?? "");
      if (!c || CLOSED_STATUS.test(status)) return undefined;
      return { repo: path.basename(dir), dir, path: rel, ref, status, ...c };
    }
  return undefined;
}

/** row `ref` of spine `rel` in the checkout `dir` as it reads now (status, owner cell, title, iteration). */
export function rowIn(dir: string, rel: string, ref: string): { status: string; owner: string; title: string; iteration: number } | undefined {
  // the ledger first, then the epic's archive: a finished row moved there reads the same
  let r: LedgerLine | undefined;
  for (const f of withArchive(dir, rel)) {
    const abs = inside(dir, f);
    r = abs ? readFile(abs)?.fileRows().find((x) => x.id === ref) : undefined;
    if (r) break;
  }
  if (!r) return undefined;
  const cellOf = (i: number) => (i >= 0 ? stripInline(r.cells[i] ?? "") : "");
  return { status: cellOf(r.col.status), owner: cellOf(r.col.owner), title: cellOf(r.col.title).slice(0, 160), iteration: iterationOf(r.cells) };
}

/**
 * the Status cell row `ref` had in a spine's text before it was claimed: the cell that `spines.py --claim`
 * overwrote with `active`. Undefined when the row is missing, has no status, or was already being worked on (active,
 * claimed) or closed: the lease then gives the row back to `ready` as before.
 */
export function statusBeforeClaimIn(text: string, ref: string): string | undefined {
  const r = ledgerLines(text).find((x) => x.id === ref && x.col.status >= 0);
  const cell = r ? (r.cells[r.col.status] ?? "").trim() : "";
  const st = stripInline(cell);
  if (!st || /^(?:active|claimed|ready)\b/i.test(st) || CLOSED_STATUS.test(st)) return undefined;
  return cell;
}

/**
 * a lease expired: Owner `unassigned (lease of <by> expired <UTC>: …)`, and an `active` Status goes back to the status
 * the row had when it was claimed (`back`: review stays review, monitoring stays monitoring), else `ready`. With `wait`
 * (the claiming run reported monitoring with a check still due) the row goes to `waiting (… until <at>, <run>)`.
 */
export function expireLeaseText(text: string, ref: string, by: string, until: string, at: string, back?: string, wait?: { until: string }): string | { skip: string } {
  const raw = text.split("\n");
  const r = ledgerLines(text).find((x) => x.id === ref && x.col.owner >= 0);
  if (!r) return { skip: `row ${ref} is not in this spine any more` };
  if (r.cells.length !== r.headers.length) return outOfColumns(ref, r);
  const c = claimOf(r.cells[r.col.owner] ?? "");
  if (!c || c.by !== by || c.until !== until) return { skip: `row ${ref}'s claim changed (renewed, released or taken); nothing written` };
  // re-checked on the text under the writer's lock: a row that is no longer worked on keeps its claim.
  const st = r.col.status >= 0 ? stripInline(r.cells[r.col.status] ?? "") : "";
  if (!/^(?:active|claimed)\b/i.test(st)) return { skip: `row ${ref} is ${st || "without a status"}, not active: a lease expires only on a row being worked on` };
  const cells = [...r.cells];
  // the claiming run ended its turn monitoring a timed check (nextCheckAt ahead): the row waits, it is not idle.
  // The run stays in the Owner cell (no claim form, so no lease to sweep again); the Status says until when.
  if (wait && !back?.trim()) {
    cells[r.col.owner] = cellText(`${by} (monitoring until ${wait.until}; lease ended ${at})`);
    if (r.col.status >= 0) cells[r.col.status] = cellText(`waiting (monitoring a timed check until ${wait.until}, ${by})`);
    raw[r.line] = joinRow(cells) + (raw[r.line].endsWith("\r") ? "\r" : "");
    return raw.join("\n");
  }
  const to = back?.trim() || "ready";
  const isReady = /^ready\b/i.test(stripInline(to));
  cells[r.col.owner] = cellText(`unassigned (lease of ${by} expired ${at}: ${isReady ? "re-dispatch" : `back to ${stripInline(to).split(/\s/)[0]}`})`);
  if (r.col.status >= 0 && /^active\b/i.test(stripInline(cells[r.col.status] ?? ""))) cells[r.col.status] = to.replace(/\|/g, "/");
  raw[r.line] = joinRow(cells) + (raw[r.line].endsWith("\r") ? "\r" : "");
  return raw.join("\n");
}
