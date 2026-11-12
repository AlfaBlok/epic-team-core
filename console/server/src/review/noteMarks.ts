import { createHash } from "node:crypto";
import { proseLines, stripInline } from "../adapters/markdown.js";
import { addDecisionRow } from "./followups.js";
import { splitRow } from "./rows.js";

/**
 * (the owner's WhatsApp voice note 2026-11-10 23:08Z, the memory service Log/2026-11-10.md#^e-449504: "you prepared something two
 * hours ago. And then I send a voice note … mark a ticket stale … notify these two agents that were working on this ticket
 * … so that if I go into my inbox, I'm just not going to find things that are stale").
 *
 * After a long note, each card in his inbox it touches (a row in review, an open ask) carries a mark: `updated` (the note
 * adds to it, the card still holds) or `stale` (the note changed what it is about). The mark lives in the repo (L-45): one
 * line in the spine's `## Decisions` table naming the card's code, with a key of the card as it was when marked (the row's
 * status cell, the ask's question). The console shows the mark while the card is unchanged and drops it the moment its
 * owner moves the row or rewrites the ask, so the mark never outlives the action it asks for.
 *
 *   | 2026-11-10 | stale |: your voice note of 2026-11-10 23:08Z changed this: "…his words…" (mark key 1a2b3c4d) | why, plain words | <note ref> | when its owner acts |
 */

export type NoteMarkKind = "stale" | "updated";

export interface NoteMark {
  kind: NoteMarkKind;
  /** The card's code (row or ask). */
  ref: string;
  /** When he spoke, `YYYY-MM-DD HH:MMZ`. */
  at: string;
  /** His words about this card, as he said them. */
  quote: string;
  /** Why, in plain words (may be empty). */
  why: string;
  /** Where the note lives (the memory service ref, a `vn_…` id). */
  note: string;
  /** The card as it was when marked (`markKey`). */
  key: string;
}

const DECISIONS = /^##\s+decisions\b/i;
const HEAD = /^([A-Za-z][\w.-]*\d[\w.-]*):\s+your (?:long )?(?:voice )?note of (\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z) (?:changed|added to) this(?::\s*(.*))?$/i;
const KEY = /\bmark key ([0-9a-f]{8})\b/i;
const QUOTE = /^[“"](.*)[”"]\s*$/s;

/** The card's key: its status cell (a row) or its question (an ask), spacing and inline marks ignored. */
export const markKey = (s: string) =>
  createHash("sha1")
    .update(stripInline(s).replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 8);

const cellOf = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();


/** Every mark line of a spine, in file order (a later line for the same code wins). */
export function noteMarksOf(text: string): NoteMark[] {
  const out: NoteMark[] = [];
  let inSec = false;
  for (const l of proseLines(text)) {
    if (/^##\s+/.test(l)) inSec = DECISIONS.test(l);
    if (!inSec || !l.trim().startsWith("|")) continue;
    const c = splitRow(l.replace(/\r$/, ""));
    const kindAt = c.findIndex((x) => /^(stale|updated)$/i.test(stripInline(x)));
    if (kindAt < 0) continue;
    const at = c.findIndex((x, i) => i > kindAt && HEAD.test(stripInline(x)));
    const head = at > 0 ? HEAD.exec(stripInline(c[at])) : null;
    const key = KEY.exec(l)?.[1];
    if (!head || !key) continue;
    const said = (head[3] ?? "").replace(/\s*\(mark key [0-9a-f]{8}\)\s*$/i, "").trim();
    out.push({
      kind: stripInline(c[kindAt]).toLowerCase() as NoteMarkKind,
      ref: head[1],
      at: head[2],
      quote: (QUOTE.exec(said)?.[1] ?? said).trim(),
      why: stripInline(c[at + 1] ?? "").replace(/^(—|none)$/, ""),
      note: stripInline(c[at + 2] ?? "").replace(/^(—|none)$/, ""),
      key: key.toLowerCase(),
    });
  }
  return out;
}

/** The mark still in force for `ref`: its newest line, and only while the card is as it was (`current` = its key text). */
export function activeMark(marks: NoteMark[], ref: string, current: string): NoteMark | undefined {
  let last: NoteMark | undefined;
  for (const m of marks) if (m.ref === ref) last = m;
  return last && last.key === markKey(current) ? last : undefined;
}

export interface MarkInput {
  ref: string;
  kind: NoteMarkKind;
  /** `YYYY-MM-DD HH:MMZ`. */
  at: string;
  quote: string;
  why: string;
  note: string;
  /** The card's key text now (row status cell, ask question). */
  current: string;
  /** The day written in the Date column. */
  date: string;
}

/** The Decisions line's fields for one mark (followups.ts `addDecisionRow` puts each under its header). */
export function markFields(m: MarkInput): { date: string; outcome: string; decision: string; summary: string; evidence: string; revisit: string } {
  const quote = cellOf(m.quote).replace(/["“”]/g, "'").slice(0, 400);
  return {
    date: m.date,
    outcome: m.kind,
    decision: `${m.ref}: your voice note of ${m.at} ${m.kind === "stale" ? "changed this" : "added to this"}: "${quote}" (mark key ${markKey(m.current)})`,
    summary: cellOf(m.why).slice(0, 300) || "—",
    evidence: cellOf(m.note).slice(0, 200) || "—",
    revisit: "when its owner acts",
  };
}

const TABLE_HEAD = ["| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |", "|---|---|---|---|---|---|"];

/**
 * The spine with the mark lines added at the end of its `## Decisions` table (the section, or its table, is made when the
 * spine has none). A line already there for the same code, note time, kind and key is not written twice.
 */
export function addMarks(text: string, marks: MarkInput[]): { text: string; added: number } {
  const have = noteMarksOf(text);
  const todo = marks.filter((m) => !have.some((h) => h.ref === m.ref && h.at === m.at && h.key === markKey(m.current) && h.kind === m.kind));
  if (!todo.length) return { text, added: 0 };
  let out = text;
  if (addDecisionRow(out, markFields(todo[0])) === undefined) {
    const lines = out.split("\n");
    const sec = lines.findIndex((l) => DECISIONS.test(l));
    if (sec < 0) out = `${out.replace(/\s+$/, "")}\n\n## Decisions\n\n${TABLE_HEAD.join("\n")}\n`;
    else {
      lines.splice(sec + 1, 0, "", ...TABLE_HEAD);
      out = lines.join("\n");
    }
  }
  for (const m of todo) out = addDecisionRow(out, markFields(m)) ?? out;
  return { text: out, added: todo.length };
}
