// The ledger, line by line: the one parse of a spine's ledger tables. The ticket index (scripts/ticket_index.py) is
// built with this same parse; the console's screens read the index, its writers and one-row checks read this.
// A leaf module (markdown helpers only), so a reader anywhere can use it without pulling in the review code.
import { proseLines, stripInline } from "./markdown.js";


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
export const joinRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

/** a Status cell that reads as one (the mend below never leaves a row whose status column holds something else). */
const STATUS_WORD = /^\**\s*(review|done|active|ready|monitoring|waiting|blocked|draft|deferred|parked|superseded|cancell?ed|moved|dropped|dismissed|claimed|open|in progress|todo|closed)\b/i;

/**
 * A row with one cell more than its header, where the extra is an empty cell (`| |`, a hand edit's slip that once got
 * the owner's card press refused with nothing written), is read and written as the row without it, but only when the
 * reading is unambiguous: every empty cell (never the id) removed gives the same row, and its Status cell still reads
 * as a status. Anything else (an unescaped `|` inside a cell, two extra cells) stays out of columns and is refused as
 * before; `scripts/ledger_rows.py repair` rebuilds those from git.
 */
export function mendCells(cells: string[], headers: string[]): { cells: string[]; mended: string } | undefined {
  if (cells.length !== headers.length + 1) return undefined;
  const ways = new Map<string, { cells: string[]; at: number }>();
  for (let i = 1; i < cells.length; i++) {
    if (cells[i].trim()) continue;
    const c = cells.filter((_, j) => j !== i);
    ways.set(JSON.stringify(c), { cells: c, at: i });
  }
  if (ways.size !== 1) return undefined;
  const [{ cells: out, at }] = ways.values();
  const st = colsOf(headers).status;
  if (st >= 0 && !STATUS_WORD.test(stripInline(out[st] ?? ""))) return undefined;
  return { cells: out, mended: `an extra empty cell (cell ${at + 1} of ${cells.length}) dropped: ${cells.length} cells under a ${headers.length}-cell header` };
}

/** where a mended row is logged (the console's log; tests swap it). */
export let rowMendLog: (msg: string) => void = (msg) => console.warn(`[rows] ${msg}`);
export const setRowMendLog = (f: (msg: string) => void) => {
  rowMendLog = f;
};

/** the row's cells as written, or mended (mendCells) with what was repaired. */
export function cellsOf(cells: string[], headers: string[], id: string): { cells: string[]; mended?: string } {
  if (cells.length === headers.length) return { cells };
  const m = mendCells(cells, headers);
  return m ? { cells: m.cells, mended: `row ${id}: ${m.mended}` } : { cells };
}

export interface LedgerLine {
  /** 0-based line index in the file. */
  line: number;
  id: string;
  cells: string[];
  headers: string[];
  col: { status: number; title: number; evidence: number; verified: number; next: number; pr: number; owner: number };
  /** the row as written had one empty cell too many; `cells` is the row without it (a write fixes the line). */
  mended?: string;
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
      const raw = splitRow(lines[j]);
      const id = stripInline(raw[0] ?? "");
      const { cells, mended } = cellsOf(raw, headers, id);
      if (id) out.push({ line: j, id, cells, headers, col, ...(mended ? { mended } : {}) });
    }
    i = j - 1;
  }
  return out;
}

/**
 * the ledger section each line of a file sits in (the same heading walk as `ledgerLines`): its heading's words, by line
 * index; a line outside every ledger section is absent. The goal pages (adapters/doc.ts) take their rows from the ticket
 * index, which holds the line, not the heading: this names the table kind (Issue Ledger, Backlog …) of each.
 */
export function ledgerSections(text: string): Map<number, string> {
  const lines = proseLines(text);
  const out = new Map<number, string>();
  let inLedger = false;
  let level = 0;
  let title = "";
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h && !(inLedger && h[1].length > level)) {
      title = stripInline(h[2]);
      inLedger = LEDGER_SECTION.test(title);
      level = h[1].length;
      continue;
    }
    if (inLedger) out.set(i, title);
  }
  return out;
}

