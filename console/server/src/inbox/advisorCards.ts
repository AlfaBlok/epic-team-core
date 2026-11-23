import { stripInline } from "../adapters/markdown.js";
import { addDecisionRow, addSwitchedOnRow } from "../review/followups.js";
import { splitRow } from "../review/rows.js";

/**
 * E948-S59 (the owner, 2026-11-12: "Did this ever happen? And how do I distinguish this? In the inbox when this guy sends
 * me some suggestions."): the Senior advisor's weekly suggestions reach his inbox as ONE marked set, a team card of kind
 * `advisor` (teamCards.ts, the one card system): a header naming the Senior advisor and the week, each suggestion with
 * Accept and Decline and its own answer box, and Accept all.
 *
 * Accept writes the repo first (root L-45): each accepted suggestion becomes a `ready` row at the end of its spine's Issue
 * Ledger plus a Decisions row naming him and quoting the suggestion (followups.ts addSwitchedOnRow, the switch-on writer).
 * A suggestion the advisor already handed on as a row (`row`) gets the Decisions row, and a `draft` row turns `ready`.
 * Only then is the verdict written to docs/inbox/cards.json; a spine that refuses leaves that suggestion open.
 */

export const ADVISOR_BY = "Senior advisor";
export const ADVISOR_MAX_ITEMS = 10;
/** a spine of the home repo, by its repo-relative path (an EPIC-n spine: its ledger codes are E<n>-S<k>). */
export const SPINE_PATH = /^docs\/spines\/[\w.-]+\.md$/;

export interface AdvisorNote {
  at: string;
  text: string;
  via: "text" | "voice" | "button";
  attachments?: string[];
}
export interface AdvisorItem {
  /** a1, a2, … in the advisor's order */
  id: string;
  title: string;
  /** why it moves his goals, one line */
  why?: string;
  /** what done looks like, one line */
  done?: string;
  /** the spine an accepted suggestion lands on (repo-relative, home repo) */
  spine: string;
  /** a row the advisor already wrote for it (accept readies it instead of adding one) */
  row?: string;
  verdict?: { state: "accepted" | "declined"; at: string; via: "text" | "voice" | "button"; text?: string; row?: string };
  notes?: AdvisorNote[];
}
export interface AdvisorSet {
  /** ISO week, 2026-W46 */
  week: string;
  /** "10 to 16 November" */
  weekLabel?: string;
  /** the advisor's page for that run (docs/status/advisor/<date>.md, a URL) */
  page?: string;
  items: AdvisorItem[];
}

/** the ISO week of a day (YYYY-MM-DD), as 2026-W46. */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7; // Monday 0
  d.setUTCDate(d.getUTCDate() - wd + 3); // the Thursday of that week
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** "10 to 16 November" for an ISO week. */
export function weekLabel(week: string): string | undefined {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return undefined;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const mon = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000 + (Number(m[2]) - 1) * 7 * 86_400_000);
  const sun = new Date(mon.getTime() + 6 * 86_400_000);
  const month = (d: Date) => d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return month(mon) === month(sun) ? `${mon.getUTCDate()} to ${sun.getUTCDate()} ${month(sun)}` : `${mon.getUTCDate()} ${month(mon)} to ${sun.getUTCDate()} ${month(sun)}`;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** the advisor's set as posted, checked; an error names what is wrong. */
export function checkAdvisor(a: Record<string, unknown>, day: string): { ok: true; set: AdvisorSet } | { ok: false; code: string; message: string } {
  const week = typeof a.week === "string" && /^\d{4}-W\d{2}$/.test(a.week) ? a.week : isoWeek(day);
  const raw = Array.isArray(a.items) ? a.items : [];
  if (!raw.length || raw.length > ADVISOR_MAX_ITEMS) return { ok: false, code: "bad_items", message: `one to ${ADVISOR_MAX_ITEMS} suggestions` };
  const items: AdvisorItem[] = [];
  for (const [i, r] of raw.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    const title = str(o.title, 240);
    const spine = typeof o.spine === "string" && SPINE_PATH.test(o.spine) ? o.spine : undefined;
    if (!title) return { ok: false, code: "bad_item", message: `suggestion ${i + 1} has no title` };
    if (!spine) return { ok: false, code: "bad_spine", message: `suggestion ${i + 1} names the spine it lands on (docs/spines/<file>.md)` };
    const row = typeof o.row === "string" && /^E\d+-S\d+[a-z]?$/.test(o.row) ? o.row : undefined;
    const why = str(o.why, 400);
    const done = str(o.done, 300);
    items.push({ id: `a${i + 1}`, title, spine, ...(why ? { why } : {}), ...(done ? { done } : {}), ...(row ? { row } : {}) });
  }
  const page = str(a.page, 600);
  return { ok: true, set: { week, weekLabel: str(a.weekLabel, 60) ?? weekLabel(week), ...(page && /^https?:\/\//.test(page) ? { page } : {}), items } };
}

/** open = some suggestion has no verdict yet. */
export const advisorOpen = (s: AdvisorSet | undefined) => !!s && s.items.some((i) => !i.verdict);

/** the spine's goal code from its heading (`# EPIC-948: …`). */
export function goalCodeOf(text: string): string | undefined {
  return /^#\s+(EPIC-\d+)\b/m.exec(text)?.[1];
}

/** set row `ref`'s status cell to `ready` when it is `draft`; the text unchanged otherwise. */
export function readyDraftRow(text: string, ref: string): string {
  const raw = text.split("\n");
  const at = raw.findIndex((l) => l.trim().startsWith("|") && stripInline(splitRow(l.replace(/\r$/, ""))[0] ?? "") === ref);
  if (at < 0) return text;
  let head = at;
  while (head > 0 && !/^\s*\|?\s*:?-{3,}/.test(raw[head])) head--;
  if (head === 0) return text;
  const headers = splitRow(raw[head - 1].replace(/\r$/, "")).map((h) => stripInline(h).toLowerCase());
  const col = headers.findIndex((h) => /^(status|state)$/.test(h));
  const cells = splitRow(raw[at].replace(/\r$/, ""));
  if (col < 0 || !/^draft\b/i.test(stripInline(cells[col] ?? "").trim())) return text;
  cells[col] = "ready";
  raw[at] = `| ${cells.join(" | ")} |${raw[at].endsWith("\r") ? "\r" : ""}`;
  return raw.join("\n");
}

/**
 * The spine edit for one accepted suggestion: a new ready row and its Decisions row (his name, the suggestion quoted),
 * or, for a suggestion that already has a row, that row readied and a Decisions row. `ref` is the row that carries it.
 */
export function acceptOnSpine(text: string, item: AdvisorItem, set: AdvisorSet, o: { date: string; who: string; words?: string; source: string; taken?: string[] }): { text: string; ref: string } | { skip: string } {
  const from = `the ${ADVISOR_BY}'s suggestions for the week of ${set.weekLabel ?? set.week}`;
  const quote = `"${item.title}"${o.words ? `, and his words "${o.words}"` : ""}`;
  if (item.row) {
    if (!text.includes(item.row)) return { skip: `${item.row} is not on ${item.spine}` };
    const readied = readyDraftRow(text, item.row);
    const d = addDecisionRow(readied, {
      date: o.date,
      outcome: "accepted",
      decision: `${o.who} accepted ${from} in his inbox: ${quote}; ${item.row} carries it${readied !== text ? " and is ready now" : ""}`,
      summary: `${o.who} accepted it, so the Delivery manager dispatches ${item.row}`,
      evidence: o.source,
      revisit: `${item.row} review`,
    });
    return d === undefined ? { skip: `${item.spine} has no Decisions table` } : { text: d, ref: item.row };
  }
  const code = goalCodeOf(text);
  if (!code) return { skip: `${item.spine} has no EPIC-n heading` };
  const r = addSwitchedOnRow(text, code, { title: `${ADVISOR_BY}: ${item.title}`, ...(item.why ? { why: item.why } : {}), quote, from: { ref: from, rel: o.source } }, o.date, o.who, o.taken);
  return r;
}

/** the words a search and the persona read for a set. */
export function advisorText(s: AdvisorSet | undefined): string {
  if (!s) return "";
  return [ADVISOR_BY, s.weekLabel, ...s.items.flatMap((i) => [i.title, i.why, i.done, i.verdict?.text, ...(i.notes ?? []).map((n) => n.text)])].filter(Boolean).join(" ");
}
