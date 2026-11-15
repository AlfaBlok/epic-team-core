import fs from "node:fs";
import { noteFile } from "./fileDeps.js";
import path from "node:path";
import { parseDod, type Dod } from "../dod.js";
import { parseMonitoring, type MonitorItem } from "./monitoring.js";
import { field, firstH1, proseLines, section, sections, stripInline, tables } from "./markdown.js";

/** EpicSpine's status vocabulary (references/compact-state.md): the first word of `Status:` in Current State. */
export const SPINE_STATUSES = ["draft", "ready", "active", "blocked", "review", "testing", "done", "superseded", "deferred"] as const;
export type SpineStatus = (typeof SPINE_STATUSES)[number];
/** Badge status: the spine's own word; `paused` = paused in the console; `unknown` = no `Status:` word from the vocabulary. */
export type DocStatus = SpineStatus | "paused" | "unknown";

/** Everything the console reads from one spine or epic ticket file. */
export interface DocInfo {
  title?: string;
  /**
   * Raw own status: the `## Current State` `Status:` line, else a header `Status:` line (before the first `## `
   * heading, ticket front matter). Never a `Status:` line in body prose (a page quoting one has no status).
   */
  statusLine?: string;
  waitingOn?: string;
  spineId?: string;
  /** optional `Label:` line (Current State, else the header): the tree row's short plain label. */
  label?: string;
  ticketId?: string;
  ticketRoot?: string;
  owner?: string;
  dod: Dod;
  stateExcerpt: string;
  /** `## Current State` lines by the fallback parse (absent when the section is missing). */
  state?: CurrentState;
  /** the Current State `Monitoring:` line(s), parsed ([] when absent). */
  monitoring: MonitorItem[];
  /** Work items of this doc: Issue Ledger / Phases / Child Epics rows, then Queue / Backlog / Sprint / Tasks rows, in doc order. */
  ledger: LedgerRow[];
  /** Which machine-read sections the doc has (Overview "Spine shape" hint). */
  shape: SpineShape;
}

/** `## Current State` as spines.py emits it (console contract #latest-state): raw text after `Label:`, null when missing. */
export interface RawCurrentState {
  status: string | null;
  last_attempted: string | null;
  result: string | null;
  evidence: string | null;
  waiting_on: string | null;
  next_action: string | null;
  verified_at: string | null;
}

/** Console API shape (camelCase of RawCurrentState) plus where it was read from. */
export interface CurrentState {
  status: string | null;
  lastAttempted: string | null;
  result: string | null;
  evidence: string | null;
  waitingOn: string | null;
  nextAction: string | null;
  verifiedAt: string | null;
  /** "spines" = spines.py `current_state`; "markdown" = the console's own parse (before the skill release). */
  source: "spines" | "markdown";
}

const LAST_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:Latest|Last)(?:\s*\([^)]*\))?(?::\*\*|\*\*:|:)\s*(.*\S)\s*$/i;

/**
 * Fallback parse of the Current State lines to the contract keys. `last_attempted` falls back to the newest
 * `Last:` / `Latest (…):` line (older spines append those), `next_action` to `Next:`.
 */
export function rawCurrentState(lines: string[]): RawCurrentState {
  let last: string | undefined;
  for (const l of lines) last = LAST_LINE.exec(l)?.[1] ?? last;
  return {
    status: field(lines, "Status") ?? null,
    last_attempted: field(lines, "Last attempted") ?? last ?? null,
    result: field(lines, "Result") ?? null,
    evidence: field(lines, "Evidence") ?? null,
    waiting_on: field(lines, "Waiting on") ?? null,
    next_action: field(lines, "Next action") ?? field(lines, "Next") ?? null,
    verified_at: field(lines, "Verified at") ?? null,
  };
}

/** snake_case (spines.py or the fallback parse) → console API camelCase; empty strings become null. */
export function camelState(r: Partial<Record<keyof RawCurrentState, unknown>>, source: CurrentState["source"]): CurrentState {
  const v = (x: unknown) => (typeof x === "string" && x.trim() ? x : null);
  return {
    status: v(r.status),
    lastAttempted: v(r.last_attempted),
    result: v(r.result),
    evidence: v(r.evidence),
    waitingOn: v(r.waiting_on),
    nextAction: v(r.next_action),
    verifiedAt: v(r.verified_at),
    source,
  };
}

export interface SpineShape {
  /** A Definition of Done / Acceptance / Exit Test section with list items. */
  dod: boolean;
  currentState: boolean;
  status: boolean;
  waitingOn: boolean;
  issueLedger: boolean;
  queue: boolean;
}

export interface LedgerRow {
  id: string;
  /** Empty when the table has no title column (filled from the linked ticket file). */
  title: string;
  /** Raw status cell. */
  status?: string;
  owner?: string;
  /** raw `Role` cell (e.g. "Ticket worker", "Mac agent"): a `Mac agent` row is never a server worker's. */
  role?: string;
  /** Raw gate cell (a `Needs` / `Gate` / `Blocked by` / `Waiting on` column), e.g. "the owner go". */
  needs?: string;
  /** raw `Depends on` cell (e.g. " (QR scan)"): a step waiting on an open ask is not ready. */
  dependsOn?: string;
  /** raw `Next action` cell (e.g. "Dispatch when #17-#19 are integrated"): the node page shows it. */
  nextAction?: string;
  /** First markdown link to a `.md` file in the row (id cell first), relative to the doc. */
  link?: string;
  /** "ledger" for Issue Ledger / Phases / Child Epics tables, else the lowercased heading keyword ("queue", "backlog", …). */
  source: string;
}

const LEDGER_SECTION = /^(issue ledger|phases|child epics|tickets)\b/i;
const QUEUE_SECTION = /^(queue|backlog|sprint|tasks|work items)\b/i;
/** Looks like a work-item id: S1, E5, E5.1, #12. */
const WORK_ID = /^(#\d+|[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*)$/;
const EXCERPT_LINES = 6;
const EXCERPT_LINE_MAX = 300;

const col = (headers: string[], re: RegExp) => headers.findIndex((h) => re.test(h.trim()));
const TITLE_COL = /^(title|task|item|description|scope|purpose|name|summary)$/i;
const STATUS_COL = /^(status|state)$/i;
const OWNER_COL = /^(owner|who|assignee)\b/i;
const ROLE_COL = /^role$/i;
const NEEDS_COL = /^(needs|gate|gated by|blocked by|waiting on|human gate|approval)$/i;
const DEPENDS_COL = /^(depends on|depends|dependencies|deps|blocked on)$/i;
const NEXT_COL = /^(next action|next step|next)$/i;

function ledgerRows(markdown: string): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const s of sections(markdown)) {
    const isLedger = LEDGER_SECTION.test(s.title);
    const q = !isLedger && QUEUE_SECTION.exec(stripInline(s.title));
    if (!isLedger && !q) continue;
    for (const t of tables(s.lines)) {
      const h = t.headers;
      const iTitle = col(h, TITLE_COL);
      const iStatus = col(h, STATUS_COL);
      const iOwner = col(h, OWNER_COL);
      const iRole = col(h, ROLE_COL);
      const iNeeds = col(h, NEEDS_COL);
      const iDeps = col(h, DEPENDS_COL);
      const iNext = col(h, NEXT_COL);
      for (const r of t.rows) {
        const id = r.cells[0];
        if (!id) continue;
        if (q && !(WORK_ID.test(id) && /\d/.test(id))) continue;
        out.push({
          id,
          title: iTitle >= 0 ? r.cells[iTitle] ?? "" : "",
          status: iStatus >= 0 ? r.cells[iStatus] || undefined : undefined,
          owner: iOwner >= 0 ? r.cells[iOwner] || undefined : undefined,
          ...(iRole >= 0 && r.cells[iRole] ? { role: r.cells[iRole] } : {}),
          ...(iNeeds >= 0 && r.cells[iNeeds] ? { needs: r.cells[iNeeds] } : {}),
          ...(iDeps >= 0 && r.cells[iDeps] ? { dependsOn: r.cells[iDeps] } : {}),
          ...(iNext >= 0 && r.cells[iNext] ? { nextAction: r.cells[iNext] } : {}),
          link: mdLink(r.raw),
          source: isLedger ? "ledger" : q ? q[1].toLowerCase() : "ledger",
        });
      }
    }
  }
  return out;
}

/** First link to a local `.md` file in a row, id cell first. */
function mdLink(raw: string[]): string | undefined {
  for (const cell of raw) {
    const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
    for (let m = re.exec(cell); m; m = re.exec(cell)) {
      const target = m[1].split("#")[0];
      if (/\.md$/i.test(target) && !/^[a-z]+:/i.test(target)) return target;
    }
  }
  return undefined;
}

function excerpt(lines: string[]): string {
  return lines
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(0, EXCERPT_LINES)
    .map((l) => (l.length > EXCERPT_LINE_MAX ? l.slice(0, EXCERPT_LINE_MAX - 1) + "…" : l))
    .join("\n");
}

/** Lines before the first `## ` heading: title, front matter, `Spine ID:` / `Ticket ID:` / `Status:` header lines. */
function headerLines(markdown: string): string[] {
  const lines = proseLines(markdown);
  const end = lines.findIndex((l) => /^#{2,}\s/.test(l));
  return end < 0 ? lines : lines.slice(0, end);
}

export function parseDoc(markdown: string): DocInfo {
  const state = section(markdown, /^current state\b/i);
  const goal = section(markdown, /^(goal|mission|summary)\b/i);
  const dod = parseDod(markdown);
  const ledger = ledgerRows(markdown);
  return {
    title: firstH1(markdown),
    statusLine: (state && field(state.lines, "Status")) ?? field(headerLines(markdown), "Status"),
    waitingOn: (state && field(state.lines, "Waiting on")) ?? field(markdown, "Waiting on"),
    spineId: field(markdown, "Spine ID"),
    ...(() => {
      const label = (state && field(state.lines, "Label")) ?? field(headerLines(markdown), "Label");
      return label ? { label: stripInline(label) } : {};
    })(),
    ticketId: field(markdown, "Ticket ID"),
    ticketRoot: field(markdown, "Ticket root"),
    owner: (state && field(state.lines, "Owner")) ?? field(markdown, "Owner"),
    dod,
    stateExcerpt: excerpt(state?.lines ?? goal?.lines ?? []),
    ...(state ? { state: camelState(rawCurrentState(state.lines), "markdown") } : {}),
    monitoring: state ? parseMonitoring(state.lines.map((l) => field([l], "Monitoring")).filter((v): v is string => !!v)) : [],
    ledger,
    shape: {
      dod: dod.items.length > 0,
      currentState: !!state,
      status: !!(state && field(state.lines, "Status")),
      waitingOn: !!(state && field(state.lines, "Waiting on")),
      issueLedger: ledger.some((r) => r.source === "ledger"),
      queue: ledger.some((r) => r.source !== "ledger"),
    },
  };
}

const NONE = /^(none|nothing|n\/a|-|—)\b/i;

/** First word of a `Status:` line (same rule as spines.py), if it is an EpicSpine status word. */
export function statusWord(line?: string): SpineStatus | undefined {
  const w = /[a-z]+/.exec(stripInline(line ?? "").toLowerCase())?.[0];
  return (SPINE_STATUSES as readonly string[]).includes(w ?? "") ? (w as SpineStatus) : undefined;
}

/**
 * Badge status ("One status word per state"; see hosted/console/README.md):
 * 1. milestone paused in the console → paused
 * 2. else the first word of the `Status:` line (Current State first) when it is an EpicSpine status word
 *    (ready, active, deferred = paused by the owner, blocked, done, …), else unknown.
 * `Waiting on:` is context only: returned as text, never turns the status into blocked. DoD progress does not
 * change the status either. blockedReason (blocked only) = the rest of the Status line, else Waiting on.
 */
export function deriveStatus(doc: Pick<DocInfo, "statusLine" | "waitingOn">, paused: boolean): {
  status: DocStatus;
  blockedReason?: string;
  waitingOn?: string;
} {
  const waitingOn = doc.waitingOn && !NONE.test(stripInline(doc.waitingOn)) ? stripInline(doc.waitingOn) : undefined;
  const w = waitingOn ? { waitingOn } : {};
  if (paused) return { status: "paused", ...w };
  const status = statusWord(doc.statusLine) ?? "unknown";
  if (status !== "blocked") return { status, ...w };
  const own = stripInline(doc.statusLine!.replace(/^[^a-z]*blocked\b\s*[-—:–,;(]?\s*/i, "")).replace(/\)$/, "");
  return { status, blockedReason: own || (waitingOn && `Waiting on: ${waitingOn}`) || "Blocked (per spine status)", ...w };
}

// ---------- files + mtime cache ----------

const cache = new Map<string, { mtimeMs: number; size: number; info: DocInfo }>();

/** Parsed doc for an absolute path, cached by mtime + size. Undefined if the file is missing. */
export function readDoc(abs: string): DocInfo | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    cache.delete(abs);
    noteFile(abs, "-");
    return undefined;
  }
  noteFile(abs, `${st.mtimeMs}:${st.size}`); // memoized trees revalidate on these stamps
  if (!st.isFile()) return undefined;
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;
  const info = parseDoc(fs.readFileSync(abs, "utf8"));
  cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

export const docCacheSize = () => cache.size;

/** Resolve `rel` inside `root`; undefined if it escapes the root. */
export function inside(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : undefined;
}

const DONE_STATUS = /^(done|closed|complete|completed|cancel+ed|won'?t ?fix|superseded|merged|retired)\b/i;
/** Earliest known status word in free text wins ("**done 10-16**, verified" → done; "waiting on X" → blocked). */
const STATUS_WORDS: [RegExp, string][] = [
  [/\b(done|closed|complete|completed|merged|shipped|cancel+ed|won'?t ?fix|superseded|retired)\b/i, "done"],
  [/\b(blocked|waiting|needs|on hold)\b/i, "blocked"],
  [/\b(review|testing|verifying|in[ -]progress|active|wip|ongoing|running|started)\b/i, "active"],
  [/\b(dispatched)\b/i, "dispatched"],
  [/\b(ready|todo|to do|open|queued)\b/i, "ready"],
  [/\b(pending|planned|proposed|draft|not started|backlog)\b/i, "pending"],
  [/\b(paused|parked|deferred)\b/i, "paused"],
];

/**
 * Normalised status for a ledger/queue cell or a ticket `Status:` line, plus the raw text when it says more.
 * No known word (e.g. "due ~10-17 03:00") → "—" with the raw text as detail.
 */
export function normalizeStatus(raw?: string): { status: string; statusDetail?: string } {
  const text = raw ? stripInline(raw) : "";
  if (!text || /^(—|-|–)$/.test(text)) return { status: "—" };
  let best: { at: number; status: string } | undefined;
  for (const [re, status] of STATUS_WORDS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { at: m.index, status };
  }
  const status = best?.status ?? "—";
  return text.toLowerCase() === status ? { status } : { status, statusDetail: text };
}

export const isDoneStatus = (status?: string) => !!status && DONE_STATUS.test(status.trim());

/** Ticket id from a ticket file: `Ticket ID:` else the filename up to the first word that is not an id part. */
export function ticketIdFor(file: string, info?: DocInfo): string {
  if (info?.ticketId) return stripInline(info.ticketId);
  const stem = path.basename(file, ".md");
  const m = /^([A-Z][A-Z0-9]*(?:-[A-Z]*\d+[A-Z0-9]*)*)(?=-|$)/.exec(stem);
  return m ? m[1] : stem;
}
