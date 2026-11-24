// The goal pages (milestone tree and backlog, adapters/doc.ts readDoc) take their ledger rows from the ticket
// index; doc.ts's own table parse is retired. The same rows before and after: `before` below is that retired parse,
// frozen here as it ran until this change, and every file must give the same work items through the new reading.
// GOAL_PAGES_PARITY_ROOT=<a folder of checkouts> also compares every markdown file of every checkout in it;
// GOAL_PAGES_PARITY_DB=<a built index.db> reads the rows from that index (file on disk against the index).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerOf, parseDoc, type LedgerRow } from "../src/adapters/doc.js";
import { sections, stripInline, tables } from "../src/adapters/markdown.js";
import { ledgerLines } from "../src/review/rows.js";
import { createTicketIndex } from "../src/tickets/ticketIndex.js";

// ---- before: adapters/doc.ts ledgerRows as it was until the goal pages moved to the index, verbatim ----
const LEDGER_SECTION = /^(issue ledger|phases|child epics|tickets)\b/i;
const QUEUE_SECTION = /^(queue|backlog|sprint|tasks|work items)\b/i;
const WORK_ID = /^(#\d+|[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*)$/;
const col = (headers: string[], re: RegExp) => headers.findIndex((h) => re.test(h.trim()));
const TITLE_COL = /^(title|task|item|description|scope|purpose|name|summary)$/i;
const STATUS_COL = /^(status|state)$/i;
const OWNER_COL = /^(owner|who|assignee)\b/i;
const ROLE_COL = /^role$/i;
const NEEDS_COL = /^(needs|gate|gated by|blocked by|waiting on|human gate|approval)$/i;
const DEPENDS_COL = /^(depends on|depends|dependencies|deps|blocked on)$/i;
const NEXT_COL = /^(next action|next step|next)$/i;
const SINCE_COL = /^(last verified|verified|last updated|updated|since)$/i;
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
function before(markdown: string): LedgerRow[] {
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
      const iSince = col(h, SINCE_COL);
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
          ...(iSince >= 0 && r.cells[iSince] ? { since: r.cells[iSince] } : {}),
          link: mdLink(r.raw),
          source: isLedger ? "ledger" : q ? q[1].toLowerCase() : "ledger",
        });
      }
    }
  }
  return out;
}
// ---- end of before ----

/** the work items as a goal page shows them: one per id, first position wins (milestone.ts backlogFor). */
const shown = (rows: LedgerRow[]) => {
  const seen = new Map<string, LedgerRow>();
  for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()].map((r) => JSON.stringify(r));
};

const SPINE = [
  "# EPIC-907: Fixture",
  "",
  "## Issue Ledger",
  "",
  "| Issue | Owner | Role | Title | Status | Needs | Depends on | Next Action | Last Verified |",
  "|---|---|---|---|---|---|---|---|---|",
  "| E907-S1 | run_abc1234 | Ticket worker | Build **it** [page](../x.md) | review (card) | the owner go | E907-S2 | worker | 2026-11-24 |",
  "| [E907-S2](../y.md#a) | — | Mac agent | A \\| pipe in a cell | ready | | | | |",
  "",
  "### Sub heading stays in the ledger",
  "",
  "| ID | Who | Task | State |",
  "|---|---|---|---|",
  "| E907-S4 | w | Under a sub heading | blocked |",
  "",
  "```",
  "| E907-S5 | w | In a fence | ready |",
  "```",
  "",
  "## Decisions",
  "",
  "| Date | By | What | Status |",
  "|---|---|---|---|",
  "| 2026-11-24 | x | Not a ledger | done |",
  "",
  "## Backlog",
  "",
  "| Row | Title | Status |",
  "| :--- | --- | --- |",
  "| E907-S6 | Spaces | queued |",
  "| not an id | Skipped in a queue | ready |",
  "| S7 | Short id | ready |",
  "",
  "## Child Epics",
  "",
  "| Epic | Title | Status |",
  "|---|---|---|",
  "| EPIC-908 | [Child](epic-908.md) | active |",
  "",
].join("\n");

describe("goal pages read their rows from the ticket index", () => {
  it("gives the same work items as the retired parse", () => {
    expect(ledgerOf(SPINE, ledgerLines(SPINE))).toEqual(before(SPINE));
    expect(parseDoc(SPINE).ledger.map((r) => r.id)).toEqual(["E907-S1", "E907-S2", "E907-S4", "E907-S6", "S7", "EPIC-908"]);
    const s1 = parseDoc(SPINE).ledger[0];
    expect(s1).toMatchObject({ title: "Build it page", status: "review (card)", role: "Ticket worker", needs: "the owner go", dependsOn: "E907-S2", since: "2026-11-24", link: "../x.md", source: "ledger" });
    expect(parseDoc(SPINE).ledger.find((r) => r.id === "E907-S6")?.source).toBe("backlog");
  });

  it("takes the rows it is given: the index's, not the text's", () => {
    const rows = ledgerLines(SPINE).filter((l) => l.id !== "E907-S4");
    expect(parseDoc(SPINE, rows).ledger.map((r) => r.id)).not.toContain("E907-S4");
  });

  const root = process.env.GOAL_PAGES_PARITY_ROOT;
  it.skipIf(!root)("every markdown file of every checkout gives the same goal-page rows", () => {
    const index = process.env.GOAL_PAGES_PARITY_DB ? createTicketIndex({ file: process.env.GOAL_PAGES_PARITY_DB, freshMs: Number.MAX_SAFE_INTEGER }) : undefined;
    let files = 0;
    let rows = 0;
    let fromIndex = 0;
    const differ: string[] = [];
    const strict: string[] = [];
    const walk = (d: string, depth: number) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".")) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 8) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith(".md")) {
          const text = fs.readFileSync(p, "utf8");
          if (!text.includes("|")) continue;
          const old = shown(before(text));
          const lines = index?.holds(p) ? (fromIndex++, index.lines(p)) : ledgerLines(text);
          const now = shown(ledgerOf(text, lines));
          files++;
          rows += old.length;
          if (JSON.stringify(old) !== JSON.stringify(now)) differ.push(p);
          if (process.env.GOAL_PAGES_STRICT && JSON.stringify(before(text)) !== JSON.stringify(ledgerOf(text, lines))) strict.push(p);
        }
      }
    };
    for (const c of fs.readdirSync(root!)) {
      const d = path.join(root!, c);
      if (fs.existsSync(path.join(d, ".git"))) walk(d, 0);
    }
    if (strict.length) console.log(`strict (every row, duplicates too): ${strict.length} differ: ${strict.slice(0, 20).join(" ")}`);
    console.log(`goal pages parity: ${files} files, ${rows} rows, ${fromIndex} read from the index, ${differ.length} differ`);
    expect(differ).toEqual([]);
  }, 600_000);
});
