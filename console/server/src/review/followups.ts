import { stripInline } from "../adapters/markdown.js";
import { cellText, splitRow } from "./rows.js";
import { ownerName } from "../identity.js";

/**
 * no review card closes and loses what
 * its work found next. A row in review names its follow-ups in its Next Action cell (the spine is the only source, L-45):
 *
 *   followups: started (F1 + F3), (F2 + F4); start Confirm and fix leads N1-N4 — N1 may write your
 *   secret store; park Isolated box per customer — big, can wait; confirm: yes — a report you read; completes:
 *
 * Items split by `;`. `started <codes>` are rows already opened (each with what it covers); `start <title> — <why>` is a
 * suggestion the team recommends starting now, `park <title> — <why>` one it recommends parking (`propose` reads as
 * start). `confirm: yes|no — <why>` says whether the owner must confirm it (Q1; a `no` row closes itself and never
 * reaches review). `completes: <Done-means id> | goal | ask` names what the row finishes. `none`: no follow-ups.
 * The older `Next steps:` label reads the same.
 */

export interface Suggestion {
  title: string;
  why?: string;
  /** The team's recommendation: the card's Start now / Park switch starts here. */
  recommend: "start" | "park";
  /** another goal this follow-up goes to (card `in:`); its switch is On / Off. */
  target?: string;
  quote?: string;
  targetName?: string;
  /** the follow-up is a drafted new goal (card `new:`): on readies it, off parks it. */
  kind?: "new";
  /** other personas that proposed the same thing. */
  also?: string[];
}

export interface StartedRef {
  ref: string;
  covers?: string;
}

export interface FollowupsCell {
  started: StartedRef[];
  suggested: Suggestion[];
  confirm?: { yes: boolean; why?: string };
  /** A Done-means id, `goal` or `ask`. */
  completes?: string;
}

const LABEL = /\b(?:follow-?ups?|next steps?)\s*:\s*/i;
const SUGGEST = /^(start|park|propose[sd]?)\s*:?\s+(.+)$/i;
const WHY = /\s+(?:—|--|–)\s+/;
const CODE_COVERS = /\b([A-Z][A-Za-z0-9]*(?:-[A-Za-z]*\d+[a-z]?)+)\b(?:\s*\(([^)]*)\))?/g;

/** The follow-ups written in one cell (Next Action), or none. */
export function parseFollowups(cell: string | undefined): FollowupsCell {
  const out: FollowupsCell = { started: [], suggested: [] };
  const m = cell ? LABEL.exec(cell) : null;
  if (!cell || !m) return out;
  for (const raw of cell.slice(m.index + m[0].length).split(/\s*;\s*/)) {
    const item = stripInline(raw).trim().replace(/\.$/, "");
    if (!item || /^none$/i.test(item)) continue;
    const conf = /^confirm\s*:?\s*(yes|no)\b\s*(?:(?:—|--|–|:)\s*)?(.*)$/i.exec(item);
    if (conf) {
      out.confirm = { yes: conf[1].toLowerCase() === "yes", ...(conf[2].trim() ? { why: conf[2].trim() } : {}) };
      continue;
    }
    const comp = /^completes?\s*:?\s*(.+)$/i.exec(item);
    if (comp) {
      const c = comp[1].trim();
      out.completes = /^(the )?goal\b/i.test(c) ? "goal" : /^(your |the )?ask\b/i.test(c) ? "ask" : c.split(/\s+/)[0];
      continue;
    }
    const s = SUGGEST.exec(item);
    if (s) {
      const [title, ...why] = s[2].split(WHY);
      const w = why.join(" — ").trim();
      if (title.trim()) out.suggested.push({ title: title.trim(), ...(w ? { why: w } : {}), recommend: /^park/i.test(s[1]) ? "park" : "start" });
      continue;
    }
    for (const c of item.replace(/^started\s*:?\s*/i, "").matchAll(CODE_COVERS)) {
      if (out.started.some((x) => x.ref === c[1])) continue;
      const covers = c[2]?.trim();
      out.started.push({ ref: c[1], ...(covers ? { covers } : {}) });
    }
  }
  return out;
}

/** What happened to a started follow-up, from its row's status. */
export type StepState = "live" | "running" | "parked" | "dropped" | "not found";

export function stepState(status: string): StepState {
  const s = stripInline(status).toLowerCase();
  if (!s) return "not found";
  if (/^(done|review|testing|merged|deployed|live)\b/.test(s)) return "live";
  if (/^(draft|deferred|parked)\b/.test(s)) return "parked";
  if (/^(superseded|cancell?ed|moved|dropped)\b/.test(s)) return "dropped";
  return "running";
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The code of the next new row after `ref`: same prefix (→ E59-S), one above the highest number in the text. */
export function nextCode(text: string, ref: string, taken: string[] = []): string {
  const m = /^(.*?)(\d+)[a-z]?$/.exec(ref);
  const prefix = m ? m[1] : `${ref}-`;
  let max = 0;
  for (const x of [text, ...taken].join("\n").matchAll(new RegExp(`(?<![\\w-])${escape(prefix)}(\\d+)[a-z]?(?![\\w-])`, "g"))) max = Math.max(max, Number(x[1]));
  return `${prefix}${max + 1}`;
}

/**
 * The code a follow-up row's number counts from : a row of epic n always takes the epic's next S number
 * (`E907-G20261113` → `E907-S0`, so its follow-ups are E907-S<next>, never the Gap finder's next daily-card id);
 * any other code keeps its own prefix as before.
 */
export function followupBase(ref: string): string {
  const e = /^E(\d+)-[A-Za-z]/.exec(ref);
  return e ? `E${e[1]}-S0` : ref;
}

export interface FollowupPick {
  title: string;
  why?: string;
  /** true: a `ready` row (Start now; the Delivery manager starts it); false: a parked `draft` row on the goal. */
  start: boolean;
}
export type FollowupRow = { ref: string; title: string; status: "ready" | "draft" };
export type FollowupEdit = { text: string; rows: FollowupRow[] } | { skip: string };

const SEP = /^\s*\|?\s*:?-{3,}/;
const joinRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

/**
 * Add one ledger row per pick to the table that holds row `ref` (after its last row), each depending on `ref`, and set
 * `ref`'s followups to the started codes (the suggestions are rows now). Only those lines change; no picks, no edit.
 */
export function writeFollowups(text: string, ref: string, picks: FollowupPick[], date: string, who = ownerName(), taken: string[] = []): FollowupEdit {
  if (!picks.length) return { text, rows: [] };
  const raw = text.split("\n");
  const bare = (i: number) => raw[i].replace(/\r$/, "");
  let at = -1;
  let inFence = false;
  for (let i = 0; i < raw.length; i++) {
    if (/^\s*(```|~~~)/.test(raw[i])) inFence = !inFence;
    if (!inFence && bare(i).trim().startsWith("|") && stripInline(splitRow(bare(i))[0] ?? "") === ref) {
      at = i;
      break;
    }
  }
  if (at < 0) return { skip: `row ${ref} is not in this spine's ledger any more` };
  let head = at;
  while (head > 0 && !SEP.test(bare(head))) head--;
  if (!SEP.test(bare(head)) || head === 0) return { skip: `row ${ref} sits in no table with a header` };
  const headers = splitRow(bare(head - 1)).map((h) => stripInline(h).toLowerCase());
  let end = at;
  while (end + 1 < raw.length && bare(end + 1).trim().startsWith("|")) end++;
  const cNext = headers.findIndex((h) => /^next( action| step)?$/.test(h));
  const cr = raw[at].endsWith("\r") ? "\r" : "";

  const made: FollowupRow[] = [];
  const lines: string[] = [];
  for (const p of picks) {
    const code = nextCode(text, followupBase(ref), [...taken, ...made.map((r) => r.ref)]);
    const status = p.start ? ("ready" as const) : ("draft" as const);
    const title = cellText(`${p.title}${p.why ? ` (${p.why})` : ""}: follow-up of ${ref}`);
    const cells = headers.map((h, i) => {
      if (i === 0) return code;
      if (/^role$/.test(h)) return "Ticket worker";
      if (/^owner/.test(h)) return "unassigned";
      if (/^(title|task|item|description|scope|purpose|name|summary)$/.test(h)) return title;
      if (/^(status|state)$/.test(h)) return status;
      if (/^depends/.test(h)) return ref;
      if (/^base$/.test(h)) return "main";
      if (/evidence/.test(h)) return cellText(p.start ? `${who} started it when closing ${ref} ${date}` : `parked by ${who} when closing ${ref} ${date}`);
      if (/verified/.test(h)) return date;
      if (i === cNext) return p.start ? "worker" : `${who} starts it from the goal when wanted`;
      return "none";
    });
    lines.push(joinRow(cells) + cr);
    made.push({ ref: code, title: p.title, status });
  }
  if (cNext >= 0) {
    const cells = splitRow(bare(at));
    while (cells.length <= cNext) cells.push("");
    const cur = cells[cNext];
    const p = parseFollowups(cur);
    const codes = [...p.started.filter((c) => c.ref !== ref).map((c) => (c.covers ? `${c.ref} (${c.covers})` : c.ref)), ...made.map((r) => r.ref)];
    const m = LABEL.exec(cur);
    const before = m ? cur.slice(0, m.index).replace(/[\s;,.]+$/, "") : cur.trim();
    cells[cNext] = cellText(`${before ? `${before}; ` : ""}followups: started ${codes.join(", ")}`);
    raw[at] = joinRow(cells) + cr;
  }
  raw.splice(end + 1, 0, ...lines);
  return { text: raw.join("\n"), rows: made };
}

/** Tick a Done-means line (`- [ ] …` → `- [x] …`); undefined when the line is not there or already met. */
export function tickDoneMeans(text: string, id: string): string | undefined {
  const re = new RegExp(`^(\\s*[-*]\\s+)\\[ \\](\\s+\\**${escape(id)}\\b)`, "m");
  return re.test(text) ? text.replace(re, "$1[x]$2") : undefined;
}

/**
 * Close the goal: the Current State `Status:` line reads `done (closed by <who> <date>)`, and `## Outcome` carries the
 * `Verdict:` and `Outcome:` a closed spine needs (the EpicSpine pre-commit gate refuses a closed spine without
 * them, so "close the goal" failed with "not trackable: closed spine has no usable ## Outcome"). A worker's Outcome
 * sentence is kept; a missing one is the goal sentence. Its `Closed:` (and a generated `Outcome:`) end in CLOSED_MARK, so
 * a reopen takes out what the close wrote (the Verdict with them; the validator wants a bare Verdict word).
 */
export function closeGoalStatus(text: string, date: string, who = ownerName()): string | undefined {
  const lines = text.split("\n");
  let inState = false;
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) inState = /^##\s+current state\b/i.test(lines[i]);
    if (inState && /^Status:\s*/.test(lines[i])) {
      lines[i] = `Status: done (closed by ${who} ${date})`;
      done = true;
      break;
    }
  }
  return done ? closeOutcome(lines.join("\n"), date, who) : undefined;
}

/** Marks the Outcome lines the console wrote when the owner closed a goal (removed again on reopen). */
export const CLOSED_MARK = "(closed on the console's review list)";
const filled = (v: string | undefined) => !!v && !/^\s*(<[^>]*>|none|n\/a|-|tbd)?\s*$/i.test(v);

function closeOutcome(text: string, date: string, who: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+outcome\s*$/i.test(l));
  const stamp = [`Closed: ${date} by ${who} ${CLOSED_MARK}`];
  if (start < 0) {
    const goal = /^Goal sentence:\s*(.+)$/m.exec(text)?.[1] ?? /^##\s+Goal\s*\n+([^#\n].*)$/m.exec(text)?.[1] ?? /^#\s+(.+)$/m.exec(text)?.[1] ?? "the goal";
    const block = ["## Outcome", "", "Verdict: accomplished", `Outcome: ${goal.trim()} ${CLOSED_MARK}`, ...stamp, ""];
    const at = lines.findIndex((l) => /^##\s+current state\b/i.test(l));
    lines.splice(at < 0 ? lines.length : at, 0, ...block);
    return lines.join("\n");
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end < 0) end = lines.length;
  const field = (k: string) => lines.slice(start + 1, end).find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim();
  const add: string[] = [];
  if (!filled(field("Verdict"))) add.push("Verdict: accomplished");
  if (!filled(field("Outcome"))) {
    const goal = /^Goal sentence:\s*(.+)$/m.exec(text)?.[1] ?? "the goal is met";
    add.push(`Outcome: ${goal.trim()} ${CLOSED_MARK}`);
  }
  if (!filled(field("Closed"))) add.push(...stamp);
  if (!add.length) return text;
  // drop placeholder lines of the fields being written, then put them right under the heading
  const keys = add.map((l) => l.slice(0, l.indexOf(":") + 1));
  const body = lines.slice(start + 1, end).filter((l) => !keys.some((k) => l.startsWith(k)));
  const rest = body[0]?.trim() === "" ? body.slice(1) : body;
  return [...lines.slice(0, start + 1), "", ...add, ...rest, ...lines.slice(end)].join("\n");
}

/** Reopen a goal the owner closed: `Status: active (reopened by <who> <date>)`; undefined when it is not closed by him. */
export function reopenGoalStatus(text: string, date: string, who = ownerName()): string | undefined {
  const lines = text.split("\n");
  let inState = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) inState = /^##\s+current state\b/i.test(lines[i]);
    if (inState && /^Status:\s*/.test(lines[i])) {
      if (!/^Status:\s*done \(closed by /i.test(lines[i])) return undefined;
      lines[i] = `Status: active (reopened by ${who} ${date})`;
      // the Outcome lines the close wrote go again (an active goal has no verdict yet)
      if (!lines.some((l) => /^Closed:/.test(l) && l.endsWith(CLOSED_MARK))) return lines.join("\n");
      return lines.filter((l) => !/^Verdict:/.test(l) && !(/^(Outcome|Closed):/.test(l) && l.endsWith(CLOSED_MARK))).join("\n");
    }
  }
  return undefined;
}

// ----------: follow-ups for another goal (the Gap finder's switches) ----------

/** The rows of the first table under `## <heading>` (header line index, separator, last row), or undefined. */
function tableUnder(raw: string[], heading: RegExp): { head: number; end: number; headers: string[] } | undefined {
  const bare = (i: number) => raw[i].replace(/\r$/, "");
  const at = raw.findIndex((l) => heading.test(l.replace(/\r$/, "")));
  if (at < 0) return undefined;
  for (let i = at + 1; i < raw.length; i++) {
    if (/^##\s/.test(bare(i))) return undefined;
    if (bare(i).trim().startsWith("|") && i + 1 < raw.length && SEP.test(bare(i + 1))) {
      let end = i + 1;
      while (end + 1 < raw.length && bare(end + 1).trim().startsWith("|")) end++;
      return { head: i, end, headers: splitRow(bare(i)).map((h) => stripInline(h).toLowerCase()) };
    }
  }
  return undefined;
}

export interface SwitchOn {
  title: string;
  why?: string;
  quote?: string;
  /** The card's row that offered it and its spine. */
  from: { ref: string; rel: string };
}

/**
 * the owner switched a follow-up on: one `ready` row at the end of the goal's Issue Ledger (his switch is his ready stamp,
 * root L-37), quoting his words, and one Decisions row saying so. Undefined code: the next `E<n>-S<k>` of the goal.
 */
export function addSwitchedOnRow(text: string, goalCode: string, on: SwitchOn, date: string, who = ownerName(), taken: string[] = []): { text: string; ref: string } | { skip: string } {
  const raw = text.split("\n");
  const t = tableUnder(raw, /^##\s+(issue ledger|ledger|backlog)\b/i);
  if (!t) return { skip: `${goalCode} has no Issue Ledger table` };
  const n = /^EPIC-(\d+)$/.exec(goalCode)?.[1];
  const ref = nextCode(text, n ? `E${n}-S0` : `${goalCode}-S0`, taken);
  const quote = on.quote ? ` Your words: ${on.quote}` : "";
  const title = cellText(`${on.title}${on.why ? `. Why: ${on.why}` : ""}.${quote}`);
  const cr = raw[t.end].endsWith("\r") ? "\r" : "";
  const cNext = t.headers.findIndex((h) => /^next( action| step)?$/.test(h));
  const cells = t.headers.map((h, i) => {
    if (i === 0) return ref;
    if (/^role$/.test(h)) return "Ticket worker";
    if (/^owner/.test(h)) return "unassigned";
    if (/^(title|task|item|description|scope|purpose|name|summary)$/.test(h)) return title;
    if (/^(status|state)$/.test(h)) return "ready";
    if (/^depends/.test(h)) return "none";
    if (/^base$/.test(h)) return "main";
    if (/evidence/.test(h)) return cellText(`${who} switched it on in ${on.from.ref} ${date}`);
    if (/verified/.test(h)) return date;
    if (i === cNext) return "worker";
    return "none";
  });
  raw.splice(t.end + 1, 0, joinRow(cells) + cr);
  const withRow = raw.join("\n");
  const d = addDecisionRow(withRow, {
    date,
    outcome: "accepted",
    decision: `${ref} ready on ${who}'s switch in ${on.from.ref} (root L-37): ${on.title}${on.quote ? `, his words ${on.quote}` : ""}`,
    summary: `${who} switched this follow-up on, so it is ready and the Delivery manager dispatches it`,
    evidence: on.from.rel,
    revisit: `${ref} review`,
  });
  return { text: d ?? withRow, ref };
}

/** One row at the end of the `## Decisions` table (cells matched by header), or undefined when there is no such table. */
export function addDecisionRow(text: string, d: { date: string; outcome: string; decision: string; summary: string; evidence: string; revisit: string }): string | undefined {
  const raw = text.split("\n");
  const t = tableUnder(raw, /^##\s+decisions\b/i);
  if (!t) return undefined;
  const cr = raw[t.end].endsWith("\r") ? "\r" : "";
  const cells = t.headers.map((h, i) => {
    if (/date/.test(h) || i === 0) return d.date;
    if (/outcome|status/.test(h)) return d.outcome;
    if (/decision|attempt/.test(h)) return cellText(d.decision);
    if (/summary|why/.test(h)) return cellText(d.summary);
    if (/evidence|source/.test(h)) return cellText(d.evidence);
    if (/revisit/.test(h)) return cellText(d.revisit);
    return "none";
  });
  raw.splice(t.end + 1, 0, joinRow(cells) + cr);
  return raw.join("\n");
}

/** The card row's Next Action after its switches: `followups: started (in); dismissed 2 (…)`. */
export function setSwitchedCell(text: string, ref: string, started: { ref: string; goal: string }[], dismissed: number): string {
  const raw = text.split("\n");
  const bare = (i: number) => raw[i].replace(/\r$/, "");
  const at = raw.findIndex((l) => l.trim().startsWith("|") && stripInline(splitRow(l.replace(/\r$/, ""))[0] ?? "") === ref);
  if (at < 0) return text;
  let head = at;
  while (head > 0 && !SEP.test(bare(head))) head--;
  if (head === 0) return text;
  const headers = splitRow(bare(head - 1)).map((h) => stripInline(h).toLowerCase());
  const cNext = headers.findIndex((h) => /^next( action| step)?$/.test(h));
  if (cNext < 0) return text;
  const cells = splitRow(bare(at));
  while (cells.length <= cNext) cells.push("");
  const parts = [
    ...(started.length ? [`started ${started.map((s) => `${s.ref} (in ${s.goal})`).join(", ")}`] : []),
    ...(dismissed ? [`dismissed ${dismissed} (Decisions)`] : []),
  ];
  cells[cNext] = cellText(`followups: ${parts.join("; ") || "none"}`);
  raw[at] = joinRow(cells) + (raw[at].endsWith("\r") ? "\r" : "");
  return raw.join("\n");
}

// ----------: a proposer persona's drafted new goal, switched on or off on its card ----------

/** Set one `Key: value` line of `## Current State` (added after `Status:` when missing); undefined without that section. */
function setStateField(text: string, key: string, value: string): string | undefined {
  const lines = text.split("\n");
  let inState = false;
  let statusAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      if (inState) break;
      inState = /^##\s+current state\b/i.test(lines[i]);
      continue;
    }
    if (!inState) continue;
    const cr = lines[i].endsWith("\r") ? "\r" : "";
    if (lines[i].startsWith(`${key}:`)) {
      lines[i] = `${key}: ${value}${cr}`;
      return lines.join("\n");
    }
    if (lines[i].startsWith("Status:")) statusAt = i;
  }
  if (statusAt < 0) return undefined;
  lines.splice(statusAt + 1, 0, `${key}: ${value}`);
  return lines.join("\n");
}

/** The `Status:` value of `## Current State`, or undefined. */
export function stateStatus(text: string): string | undefined {
  const s = /^##\s+current state\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(text)?.[1];
  return s ? /^Status:\s*(.*)$/m.exec(s)?.[1]?.trim() : undefined;
}

export interface ProposalSwitch {
  title: string;
  /** The card's row that offered it (E76-I20261109) and its spine. */
  from: { ref: string; rel: string };
  /** Off: his one-line reason. */
  why?: string;
}

/**
 * the owner switched a proposed goal on (his D6 words: "when they come into approval, then they come with next steps,
 * basically, which are dispatch a delivery manager on this ticket"): the draft goal turns ready, its draft rows ready,
 * Next action "dispatch a Delivery Manager on it", with a Decisions row. A goal that is not a draft any more is left as
 * it is (`already`), so a late press never undoes a newer decision.
 */
export function readyProposedGoal(text: string, goalCode: string, on: ProposalSwitch, date: string, who = ownerName()): { text: string; already?: string } | { skip: string } {
  const status = stateStatus(text);
  if (status === undefined) return { skip: `${goalCode} has no Current State Status line` };
  if (!/^(draft|proposed)\b/i.test(status)) return { text, already: status };
  let t = text;
  for (const [k, v] of [
    ["Status", "ready"],
    ["Waiting on", "none"],
    ["Approved work", `all of it (${who} switched it on in ${on.from.ref} ${date})`],
    ["Next action", "dispatch a Delivery Manager on it"],
  ] as const)
    t = setStateField(t, k, v) ?? t;
  // its draft rows turn ready (his switch is his ready stamp, root L-37)
  const raw = t.split("\n");
  const tb = tableUnder(raw, /^##\s+(issue ledger|ledger|backlog)\b/i);
  if (tb) {
    const cStatus = tb.headers.findIndex((h) => /^(status|state)$/.test(h));
    const cNext = tb.headers.findIndex((h) => /^next( action| step)?$/.test(h));
    for (let i = tb.head + 2; i <= tb.end; i++) {
      const cr = raw[i].endsWith("\r") ? "\r" : "";
      const cells = splitRow(raw[i].replace(/\r$/, ""));
      if (cStatus < 0 || !/^draft\b/i.test(stripInline(cells[cStatus] ?? ""))) continue;
      cells[cStatus] = "ready";
      if (cNext >= 0 && cells.length > cNext) cells[cNext] = "worker";
      raw[i] = joinRow(cells) + cr;
    }
    t = raw.join("\n");
  }
  const d = addDecisionRow(t, {
    date,
    outcome: "accepted",
    decision: `${goalCode} ready on ${who}'s switch in ${on.from.ref} (root L-37): ${on.title}`,
    summary: `${who} switched this proposed goal on, so it is ready and a Delivery Manager is dispatched on it`,
    evidence: on.from.rel,
    revisit: `${goalCode} first review`,
  });
  return { text: d ?? t };
}

/** the owner switched a proposed goal off: it is deferred with his reason and never proposed again (a Decisions row says so). */
export function parkProposedGoal(text: string, goalCode: string, off: ProposalSwitch, date: string, who = ownerName()): { text: string; already?: string } | { skip: string } {
  const status = stateStatus(text);
  if (status === undefined) return { skip: `${goalCode} has no Current State Status line` };
  if (!/^(draft|proposed)\b/i.test(status)) return { text, already: status };
  let t = text;
  for (const [k, v] of [
    ["Status", `deferred (switched off by ${who} ${date})`],
    ["Waiting on", "none"],
    ["Next action", `none: ${who} switched it off, never proposed again`],
  ] as const)
    t = setStateField(t, k, v) ?? t;
  const d = addDecisionRow(t, {
    date,
    outcome: "dismissed",
    decision: `${goalCode} switched off by ${who} in ${off.from.ref}, never proposed again: ${off.title}`,
    summary: off.why || `${who} switched it off`,
    evidence: off.from.rel,
    revisit: "never",
  });
  return { text: d ?? t };
}

// ----------: an accepted recommendation becomes a ready row ----------

/** The goal an ask's code belongs to (`` →, `ROOT-A2` → ROOT), the prefix its new row's code takes. */
export function goalOfAsk(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const e = /^E(\d+)-[A-Z]+\d+[a-z]?$/.exec(code);
  if (e) return `EPIC-${e[1]}`;
  const p = /^([A-Z][A-Z0-9]*)-[A-Z]+\d+[a-z]?$/.exec(code);
  return p ? p[1] : undefined;
}

/** What a recommendation asks him to approve, without the L-56 lead (`You approve: …`) or a trailing `?`. */
export function recommendationTitle(question: string): string {
  return stripInline(question)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^you approve\s*:\s*/i, "")
    .replace(/\?+$/, "")
    .trim();
}

/**
 * he accepted
 * the recommendation in ask `code` (one Accept, or Accept all on a persona's set). His accept is the ready stamp (root
 * L-37): one `ready` row at the end of the spine's Issue Ledger naming the ask, and one Decisions row saying so. Skipped
 * (no second row) when a row for this ask is in the ledger already, so a retried answer job never adds two.
 */
export function addAcceptedAskRow(text: string, ask: { code: string; question: string; persona?: string }, date: string, who = ownerName(), taken: string[] = []): { text: string; ref: string } | { skip: string } {
  const goal = goalOfAsk(ask.code);
  if (!goal) return { skip: `${ask.code} names no goal to put the row in` };
  const mark = `${who} accepted ${ask.code}`;
  const raw = text.split("\n");
  const t = tableUnder(raw, /^##\s+(issue ledger|ledger|backlog)\b/i);
  if (!t) return { skip: `the spine of ${ask.code} has no Issue Ledger table` };
  for (let i = t.head + 2; i <= t.end; i++) if (raw[i].includes(`${mark} `)) return { skip: `row ${stripInline(splitRow(raw[i].replace(/\r$/, ""))[0] ?? "")} is there already for ${ask.code}` };
  const n = /^EPIC-(\d+)$/.exec(goal)?.[1];
  const ref = nextCode(text, n ? `E${n}-S0` : `${goal}-S0`, taken);
  const what = recommendationTitle(ask.question);
  const from = ask.persona ? ` (${ask.persona}'s recommendation)` : "";
  const title = cellText(`${what}${from}: ${who} accepted it in ${ask.code}, deliver it.`);
  const cr = raw[t.end].endsWith("\r") ? "\r" : "";
  const cNext = t.headers.findIndex((h) => /^next( action| step)?$/.test(h));
  const cells = t.headers.map((h, i) => {
    if (i === 0) return ref;
    if (/^role$/.test(h)) return "Ticket worker";
    if (/^owner/.test(h)) return "unassigned";
    if (/^(title|task|item|description|scope|purpose|name|summary)$/.test(h)) return title;
    if (/^(status|state)$/.test(h)) return "ready";
    if (/^depends/.test(h)) return "none";
    if (/^base$/.test(h)) return "main";
    if (/evidence/.test(h)) return cellText(`${mark} ${date} on the console`);
    if (/verified/.test(h)) return date;
    if (i === cNext) return "worker";
    return "none";
  });
  raw.splice(t.end + 1, 0, joinRow(cells) + cr);
  const withRow = raw.join("\n");
  const d = addDecisionRow(withRow, {
    date,
    outcome: "accepted",
    decision: `${ref} ready: ${who} accepted ${ask.code}${from} (root L-37): ${what}`,
    summary: `his accept is the ready stamp, so the Delivery manager dispatches it`,
    evidence: `${ask.code} answered line`,
    revisit: `${ref} review`,
  });
  return { text: d ?? withRow, ref };
}
