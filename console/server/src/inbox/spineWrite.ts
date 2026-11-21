import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inside } from "../adapters/doc.js";
import { field, proseLines, stripInline } from "../adapters/markdown.js";
import { parseAsks, peopleOfTag, SNOOZE_ON_LINE } from "./asks.js";
import { DEFAULT_OWNER } from "../tenancy/owner.js";
import { CONTENTION_RETRY_MS, gitContention, withRepoLock } from "../repoLock.js";
import { localHealRunner, lockHealer, parseRedundant, REDUNDANT, type LockHealer } from "../gitStaleLock.js";
import { cellText, editRowStatus } from "../review/rows.js";
import { sites } from "../identity.js";

/**
 * the owner's answer lives in the spine. The one write the console makes to a repo: edit the ask line (or add an
 * `[answered …]` line under `## Waiting on`), commit and push it on main. Guarded: if any guard fails nothing is
 * written and the reason is returned (the answer stays in the DB; the card shows why and offers Retry).
 */
export interface SpineWrite {
  /** written = the line is in the spine (pushed, or it already was); skipped = a guard refused; failed = git failed. */
  status: "written" | "skipped" | "failed";
  /** Why it was skipped / failed; for `written` with no commit: "already answered in the spine". */
  reason?: string;
  /** Short sha of the commit that carries the answer (absent when nothing was committed). */
  sha?: string;
  path?: string;
  /** on a written flip, the ask line before and the `[answered]` line after (to revert it). */
  before?: string;
  after?: string;
  /** committed in the console's checkout; the push to origin runs in the background (retried until it lands). */
  pushing?: boolean;
  /** milliseconds per step (fetch, commit, push, …), for a `Server-Timing` header; never stored. */
  ms?: Record<string, number>;
  /** the ledger row a feedback write reopened (`active`), and its status before. */
  reopened?: { row: string; was: string };
}

/** What the writer needs to find the line again: the item as the inbox showed it. */
export interface AnswerTarget {
  id: string;
  source: "ask" | "heuristic" | "needs_jordi";
  question: string;
  row?: string;
  /** The ask's code (``), when it has one: matched before the question text. */
  code?: string;
  /** 0-based line of the ask in `path` at read time (a hint; the line is re-found by its text). */
  line?: number;
  path?: string;
}

const MAIN = "main";
const git_timeout = 30_000;
/** how long a checkout's unchanging guard facts are kept (`CONSOLE_GUARD_FACTS_MS`, 0 = read every write). */
export const STATIC_FACTS_MS = Number(process.env.CONSOLE_GUARD_FACTS_MS ?? 300_000);

// ---------- pure text edits ----------

/** One line: no newlines, and no ` — ` / ` -- ` inside (the ask parser splits fields on them). */
export const oneLine = (s: string) =>
  s
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/\s+(?:—|--)\s+/g, " - ")
    .trim();

const ASK_LINE = /^(\s*[-*]\s+)\[ask\b([^\]]*)\](.*)$/i;

/** The ask's code from its tag (`[ask: do @the owner …]` →); v1 tags have none. */
export const askCode = (raw: string): string | undefined => {
  const m = ASK_LINE.exec(raw.replace(/\r$/, ""));
  return m ? /^\s+([^\s:\]]+)\s*:/.exec(m[2])?.[1] : undefined;
};

/**
 * `[ask…]` line → `[answered <code> DATE @the owner] … — answer: …` (`@<owner>`). Undefined when it is not an open ask line.
 * feedback (changes wanted, never an approval) → `[feedback <code> DATE @the owner] … — feedback: <his words>`.
 */
export function flipAskLine(raw: string, answer: string, date: string, owner: string = DEFAULT_OWNER, feedback = false): string | undefined {
  const cr = raw.endsWith("\r") ? "\r" : "";
  const m = ASK_LINE.exec(cr ? raw.slice(0, -1) : raw);
  if (!m) return undefined;
  const code = askCode(raw);
  const tag = feedback ? "feedback" : "answered";
  // an approver other than the one answering keeps the answer waiting on them; who is made aware stays named.
  const p = feedback ? {} : peopleOfTag(m[2]);
  const awaits = p.approveBy && p.approveBy.toLowerCase() !== owner.toLowerCase() ? ` · awaits @${p.approveBy}` : "";
  const aware = p.aware?.length ? ` · aware ${p.aware.map((h) => `@${h}`).join(", ")}` : "";
  return `${m[1]}[${tag}${code ? ` ${code}` : ""} ${date} @${owner}${awaits}${aware}]${m[3].replace(/\s+$/, "")} — ${tag === "feedback" ? "feedback" : "answer"}: ${oneLine(answer)}${cr}`;
}

/** the reopened row's status cell keeps at most this much of his words (the full words are on the ask line). */
export const FEEDBACK_CELL_MAX = 300;
/**
 * feedback on an ask reopens the row it names: `active (feedback <code> by the owner <date>, round <n>: <his words>)`.
 * Round = 1 + the round the cell already names (2 when none). A row already reopened by this very feedback is left alone.
 */
export const feedbackCell = (code: string | undefined, date: string, words: string, who: string = DEFAULT_OWNER) => (status: string): string | { skip: string } => {
  const bare = stripInline(status);
  const label = `feedback${code ? ` ${code}` : ""} by ${who} ${date}`;
  if (bare.includes(label)) return { skip: "the row is already reopened by this feedback" };
  const round = Number(/\bround (\d+)/i.exec(bare)?.[1] ?? 1) + 1;
  let w = cellText(oneLine(words)).replace(/[()]/g, (c) => (c === "(" ? "[" : "]"));
  if (w.length > FEEDBACK_CELL_MAX) w = `${w.slice(0, FEEDBACK_CELL_MAX - 1).trimEnd()}…`;
  return `active (${label}, round ${round}: ${w})`;
};

export type Edit =
  | {
      how: "flip" | "append";
      text: string;
      line: number;
      code?: string;
      /** the row feedback reopened, and its status before. */ reopened?: { row: string; was: string };
      /** the ask answered was replaced; his answer went on this code, the one that replaced it. */ movedFrom?: string;
    }
  | { how: "already"; line: number }
  | { how: "missing" };

const WAITING_H = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const isWaitingHeading = (l: string) => {
  const h = WAITING_H.exec(l);
  return !!h && /^waiting on\b/i.test(stripInline(h[2]));
};

/** Question text as parseAsks stores it (inline markup stripped), whitespace-collapsed, for comparing. */
export const sameText = (s: string) => stripInline(s).replace(/\s+/g, " ").trim();

/** a replaced ask's line (`[superseded <code> <date> by <code>]`, the skill's format): the code that replaced it. */
const SUPERSEDED_LINE = /^\s*[-*]\s+\[superseded\s+([^\s\]]+)\b[^\]]*?\bby\s+(?:[\w.-]+\/)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-A\d+)\s*\]/i;
export function replacedBy(text: string, code: string): string | undefined {
  for (const l of text.split("\n")) {
    const m = SUPERSEDED_LINE.exec(l);
    if (m && m[1] === code) return m[2];
  }
  return undefined;
}

/** an ask code a retire reason names as its replacement (`replaced by E907-A2, which …`). */
export const replacementIn = (why: string): string | undefined => /\breplaced by\s+(?:[\w.-]+\/)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-A\d+)\b/i.exec(why)?.[1];

/** Apply the answer to the spine text: flip the ask's line, or (non-ask item) append an `[answered]` line under `## Waiting on`. */
export function applyAnswer(text: string, t: AnswerTarget, answer: string, date: string, owner: string = DEFAULT_OWNER, feedback = false): Edit {
  const raw = text.split("\n");
  const asks = parseAsks(text);
  const nq = sameText(t.question);
  const byCode = t.code ? asks.filter((a) => a.code === t.code && (!t.row || !a.row || a.row === t.row)) : [];
  const sameQ = (a: { question: string }) => sameText(a.question) === nq;
  // Duplicate codes: the question text tells them apart.
  const same = byCode.length ? (byCode.some(sameQ) && new Set(byCode.map((a) => a.line)).size > 1 ? byCode.filter(sameQ) : byCode) : asks.filter((a) => sameQ(a) && (!t.row || !a.row || a.row === t.row));
  if (t.source === "ask") {
    const open = same.filter((a) => a.state === "open");
    const pick = open.find((a) => a.line === t.line) ?? open[0];
    if (!pick) {
      const done = same.find((a) => a.state === "answered");
      if (done) return { how: "already", line: done.line ?? 0 };
      // the ask was replaced while he answered (19 Nov: replaced 3 min before the answer): the
      // replaced line names the new code, and his answer lands on that ask (a chain followed a few steps, never in a loop)
      const seen = new Set<string>(t.code ? [t.code] : []);
      for (let by = t.code ? replacedBy(text, t.code) : undefined; by && !seen.has(by) && seen.size < 6; by = replacedBy(text, by)) {
        seen.add(by);
        const next = asks.find((a) => a.code === by && a.state === "open");
        if (!next) continue;
        const e = applyAnswer(text, { ...t, code: by, question: next.question, ...(next.line !== undefined ? { line: next.line } : {}), row: next.row ?? undefined }, answer, date, owner, feedback);
        return e.how === "flip" ? { ...e, movedFrom: t.code } : e;
      }
      return { how: "missing" };
    }
    const flipped = flipAskLine(raw[pick.line!], answer, date, owner, feedback);
    if (!flipped) return { how: "missing" };
    const code = askCode(raw[pick.line!]);
    raw[pick.line!] = flipped;
    // the same write takes the code out of Current State's `Waiting on:` (unless another open line still has it).
    const flippedText = raw.join("\n");
    const stillOpen = code && parseAsks(flippedText).some((a) => a.state === "open" && a.code === code);
    let out = code && !stillOpen ? dropFromWaitingField(flippedText, code) : flippedText;
    // feedback reopens the row the ask names, in the same commit (a row not in this spine is the owner's to find).
    let reopened: { row: string; was: string } | undefined;
    if (feedback && pick.row) {
      const e = editRowStatus(out, pick.row, feedbackCell(code, date, answer, owner));
      if ("text" in e) {
        out = e.text;
        reopened = { row: pick.row, was: e.status };
      }
    }
    return { how: "flip", text: out, line: pick.line!, ...(code ? { code } : {}), ...(reopened ? { reopened } : {}) };
  }
  // Not in the human-ask format: a new answered line under `## Waiting on`.
  const done = same.find((a) => a.state === "answered");
  if (done) return { how: "already", line: done.line ?? 0 };
  const entry = feedback ? `- [feedback ${date} @${owner}] ${oneLine(t.question)} — feedback: ${oneLine(answer)}` : `- [answered ${date} @${owner}] ${oneLine(t.question)} — answer: ${oneLine(answer)}`;
  const put = appendUnderWaiting(text, entry);
  return { how: "append", text: put.text, line: put.line };
}

/**
 * One new line at the end of `## Waiting on` (the section is created right after Current State, before the next heading
 * of its level or higher, else at the end, when the spine has none). An ask raised through the API and an
 * answer to a non-ask item both go in this way. `entry` carries no line ending; the file's CRLF is kept.
 */
export function appendUnderWaiting(text: string, entry: string): { text: string; line: number } {
  const cr = text.includes("\r\n") ? "\r" : "";
  const raw = text.split("\n");
  const lines = proseLines(text);
  const head = lines.findIndex(isWaitingHeading);
  if (head >= 0) {
    const level = WAITING_H.exec(lines[head])![1].length;
    let end = lines.length;
    for (let i = head + 1; i < lines.length; i++) {
      const h = WAITING_H.exec(lines[i]);
      if (h && h[1].length <= level) {
        end = i;
        break;
      }
    }
    let at = end;
    while (at > head + 1 && lines[at - 1].trim() === "") at--;
    raw.splice(at, 0, entry + cr);
    return { text: raw.join("\n"), line: at };
  }
  const cs = lines.findIndex((l) => /^#{1,6}\s+current state\b/i.test(l));
  let at = lines.length;
  if (cs >= 0) {
    const level = WAITING_H.exec(lines[cs])![1].length;
    for (let i = cs + 1; i < lines.length; i++) {
      const h = WAITING_H.exec(lines[i]);
      if (h && h[1].length <= level) {
        at = i;
        break;
      }
    }
  }
  while (at > 0 && raw[at - 1].trim() === "") at--;
  raw.splice(at, 0, cr, `## Waiting on${cr}`, cr, entry + cr);
  return { text: raw.join("\n"), line: at + 3 };
}

const codeRe = (code: string) => new RegExp(`(^|[^\\w-])${code.replace(/[-]/g, "\\-")}($|[^\\w-])`, "i");
/** Any ask code (``, ``). */
const ANY_ASK_CODE = /(^|[^\w-])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-A\d+($|[^\w-])/i;

/** Current State's `Waiting on:` line: its index in the raw lines and its parts (prefix, value, CR). */
function waitingField(text: string): { raw: string[]; i: number; m: RegExpExecArray } | undefined {
  const raw = text.split("\n");
  const lines = proseLines(text);
  const cs = lines.findIndex((l) => /^#{1,6}\s+current state\b/i.test(l));
  if (cs < 0) return undefined;
  for (let i = cs + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) break;
    const m = /^(\s*(?:[-*]\s+)?(?:\*\*)?Waiting on(?:\*\*)?\s*:\s*)(.*?)(\r?)$/i.exec(raw[i]);
    if (m) return { raw, i, m };
  }
  return undefined;
}

/**
 * Current State's `Waiting on:` names the new code (`nobody` / `none` → `<Owner>: <code>`; otherwise the code is added),
 * so the spine never says nobody while an ask is open. A spine without the field is left as it is.
 */
export function addToWaitingField(text: string, code: string, ownerName: string): string {
  const f = waitingField(text);
  if (!f) return text;
  const { raw, i, m } = f;
  const value = m[2].trim();
  if (codeRe(code).test(value)) return text;
  const empty = !value || /^(nobody|none|n\/a|-|—)(\W|$)/i.test(value);
  raw[i] = empty ? `${m[1]}${ownerName}: ${code}${m[3]}` : `${m[1]}${value}; ${ownerName}: ${code}${m[3]}`;
  return raw.join("\n");
}

/**
 * the code now waits on `who`: taken out of whoever's part named it, then added to `who`'s own part
 * (`Leo:; Marta:` + to Marta → `Marta:`), or a new `who: code` part. A spine without
 * the field, or a prose field, is left as it is.
 */
export function waitOnPerson(text: string, code: string, who: string): string {
  const v = waitingField(text)?.m[2].trim();
  if (v === undefined || !(!v || /^(nobody|none|n\/a|-|—)(\W|$)/i.test(v) || ANY_ASK_CODE.test(v))) return text;
  const dropped = dropFromWaitingField(text, code);
  const f = waitingField(dropped)!;
  const value = f.m[2].trim();
  if (/^(nobody|none|n\/a|-|—)(\W|$)/i.test(value) || !value) return addToWaitingField(dropped, code, who);
  const name = who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = splitTop(value, ";");
  const k = parts.findIndex((p) => new RegExp(`^@?${name}\\s*:`, "i").test(p));
  if (k < 0) return addToWaitingField(dropped, code, who);
  parts[k] = `${parts[k]}, ${code}`;
  f.raw[f.i] = `${f.m[1]}${parts.join("; ")}${f.m[3]}`;
  return f.raw.join("\n");
}

/**
 * an answer taken back puts its code back in `Waiting on:` when the field lists codes (or says nobody), the shape
 * `dropFromWaitingField` took it out of; a prose field (`the owner (see Waiting on)`) is left as it is.
 */
export function restoreToWaitingField(text: string, code: string, ownerName: string): string {
  const v = waitingField(text)?.m[2].trim();
  if (v === undefined) return text;
  const coded = !v || /^(nobody|none|n\/a|-|—)(\W|$)/i.test(v) || ANY_ASK_CODE.test(v);
  return coded ? addToWaitingField(text, code, ownerName) : text;
}

/** Split on `sep` outside brackets. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * The ask is gone from Current State's `Waiting on:`. Each `;` part that names it loses the `,` item that names
 * it (`the owner: (buy)` → `the owner: (connect)`); a part left with no ask code goes
 * (`, snoozed until …` with it); nothing left → `nobody`. Parts that never named it stay as they are.
 */
export function dropFromWaitingField(text: string, code: string): string {
  const f = waitingField(text);
  if (!f) return text;
  const { raw, i, m } = f;
  const has = codeRe(code);
  if (!has.test(m[2])) return text;
  const parts = splitTop(m[2], ";").flatMap((p) => {
    if (!has.test(p)) return [p];
    const pm = /^([^:()]*:\s*)(.*)$/.exec(p);
    const items = splitTop(pm ? pm[2] : p, ",").filter((it) => !has.test(it));
    return items.some((it) => ANY_ASK_CODE.test(it)) ? [`${pm ? pm[1] : ""}${items.join(", ")}`] : [];
  });
  raw[i] = `${m[1]}${parts.join("; ").trim() || "nobody"}${m[3]}`;
  return raw.join("\n");
}

export type ChangeEdit =
  | { how: "rewrite"; text: string; line: number; code?: string; /** the row his feedback reopened, and its status before. */ reopened?: { row: string; was: string } }
  | { how: "same"; line: number }
  | { how: "done"; line: number }
  | { how: "missing" }
  | { how: "not_jordi"; who: string; line: number };

const ANSWERED_LINE = /^(\s*[-*]\s+)\[answered\b([^\]]*)\](.*)$/i;
const ANSWER_SEG = /\s+(?:—|--)\s+answer\s*:\s*/gi;
const NEXT_SEG = /\s+(?:—|--)\s+[A-Za-z][\w @.-]*:/;

/**
 * the owner changes an answer before the owner acts on it. The existing `[answered …]` line is rewritten in place:
 * same code, date = `date`, `— answer: <new>`; nothing else in the file changes and no second line is added. Refused
 * (`done`) when the line carries a `· done` marker, `missing` when it is gone, `not_jordi` when a persona answered it.
 * `feedback` (his words on an approve ask he had approved): the line becomes `[feedback <code> DATE @the owner] … —
 * feedback: <his words>` and the row it names reopens for a new round, as a feedback press on the open ask does.
 */
export function changeAnswer(text: string, t: AnswerTarget, answer: string, date: string, owner: string = DEFAULT_OWNER, feedback = false): ChangeEdit {
  const raw = text.split("\n");
  const nq = sameText(t.question);
  const answered = parseAsks(text).filter((a) => a.state === "answered");
  const sameQ = (a: { question: string }) => sameText(a.question) === nq;
  const byCode = t.code ? answered.filter((a) => a.code === t.code) : [];
  const same = byCode.length ? (byCode.length > 1 && byCode.some(sameQ) ? byCode.filter(sameQ) : byCode) : answered.filter(sameQ);
  const pick = same.find((a) => a.doneAt === undefined) ?? same[0];
  if (!pick || pick.line === undefined) return { how: "missing" };
  if (pick.doneAt !== undefined) return { how: "done", line: pick.line };
  if (pick.who && pick.who.toLowerCase() !== owner.toLowerCase()) return { how: "not_jordi", who: pick.who, line: pick.line };
  const old = raw[pick.line];
  const cr = old.endsWith("\r") ? "\r" : "";
  const m = ANSWERED_LINE.exec(cr ? old.slice(0, -1) : old);
  if (!m) return { how: "missing" };
  const code = pick.code ?? undefined;
  let body = m[3];
  const segs = [...body.matchAll(ANSWER_SEG)];
  const last = segs[segs.length - 1];
  const value = oneLine(answer);
  const label = feedback ? "feedback" : "answer";
  if (last) {
    const from = last.index! + last[0].length;
    const next = NEXT_SEG.exec(body.slice(from));
    body = (feedback ? `${body.slice(0, last.index!)} — feedback: ` : body.slice(0, from)) + value + (next ? body.slice(from + next.index) : "");
  } else body = `${body.replace(/\s+$/, "")} — ${label}: ${value}`;
  const line = `${m[1]}[${feedback ? "feedback" : "answered"}${code ? ` ${code}` : ""} ${date} @${owner}]${body}${cr}`;
  if (line === old) return { how: "same", line: pick.line };
  raw[pick.line] = line;
  let out = raw.join("\n");
  // the answered tag dropped the row, so the row comes from the ask as it was answered (the caller's target).
  let reopened: { row: string; was: string } | undefined;
  const row = pick.row ?? t.row;
  if (feedback && row) {
    const e = editRowStatus(out, row, feedbackCell(code, date, answer, owner));
    if ("text" in e) {
      out = e.text;
      reopened = { row, was: e.status };
    }
  }
  return { how: "rewrite", text: out, line: pick.line, ...(code ? { code } : {}), ...(reopened ? { reopened } : {}) };
}

export type SnoozeEdit = { how: "snooze"; text: string; line: number; before: string; after: string } | { how: "same"; line: number } | { how: "missing" } | { how: "not_open"; line: number };

/**
 * the owner snoozes an open ask (or unsnoozes it, `until` undefined). The ask line keeps everything and gets one
 * field at its end, ` — snoozed until: <YYYY-MM-DD>` (an older one is replaced); unsnooze takes the field off. The ask
 * stays open: only the inbox hides it until that day.
 */
export function applySnooze(text: string, t: AnswerTarget, until: string | undefined): SnoozeEdit {
  const raw = text.split("\n");
  const nq = sameText(t.question);
  const asks = parseAsks(text);
  const sameQ = (a: { question: string }) => sameText(a.question) === nq;
  const byCode = t.code ? asks.filter((a) => a.code === t.code && (!t.row || !a.row || a.row === t.row)) : [];
  const same = byCode.length ? (byCode.length > 1 && byCode.some(sameQ) ? byCode.filter(sameQ) : byCode) : asks.filter((a) => sameQ(a) && (!t.row || !a.row || a.row === t.row));
  const open = same.filter((a) => a.state === "open" && a.line !== undefined);
  const pick = open.find((a) => a.line === t.line) ?? open[0];
  if (!pick) return same[0]?.line !== undefined ? { how: "not_open", line: same[0].line! } : { how: "missing" };
  const old = raw[pick.line!];
  const cr = old.endsWith("\r") ? "\r" : "";
  let body = (cr ? old.slice(0, -1) : old).replace(new RegExp(SNOOZE_ON_LINE.source, "gi"), "").replace(/\s+$/, "");
  if (until) body = `${body} — snoozed until: ${until}`;
  const line = body + cr;
  if (line === old) return { how: "same", line: pick.line! };
  raw[pick.line!] = line;
  return { how: "snooze", text: raw.join("\n"), line: pick.line!, before: old.replace(/\r$/, ""), after: body };
}

// ---------- Integration policy ----------

const readIf = (repoDir: string, rel: string) => {
  const abs = inside(repoDir, rel);
  if (!abs) return undefined;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
};

/** Pattern lines ("docs/**", "src/api/") → does `rel` fall under one of them. */
function gateHits(entries: string[], rel: string): string | undefined {
  for (const e of entries) {
    const re = new RegExp(
      "^" + e.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]") + "$",
    );
    if (re.test(rel) || rel === e.replace(/\/+$/, "") || rel.startsWith(e.replace(/\/*$/, "/"))) return e;
  }
  return undefined;
}

const PATHISH = /^[\w@.\-/*?{}[\]]+$/;

/** Every pushPolicy refusal ends with this (reads it: the asker writes the line through its own PR). */
export const NO_PUSH = "the console does not push";

/**
 * Does the repo's Integration policy allow a direct push to main for this file? Read from the spine, its root spine,
 * AGENTS.md (nearest declaring file wins; none declared = main-direct, the skill default). pr-approval, any other
 * policy, a policy text that mentions a PR or CI (unless it pins that on a declared `Deploy gate:`), or a `Deploy gate:` that covers the file (or is not a plain path list)
 * refuses (references/git-doctrine.md: when in doubt, no push).
 */
export function pushPolicy(repoDir: string, rel: string): { ok: true } | { ok: false; reason: string } {
  const spine = readIf(repoDir, rel);
  const rootRef = spine ? field(spine, "Root spine") : undefined;
  const rootRel = rootRef && !/^\s*(self|none)\b/i.test(rootRef) ? /([\w./-]+\.md)/.exec(rootRef)?.[1] : undefined;
  const files = [rel, ...(rootRel ? [path.posix.normalize(path.posix.join(path.posix.dirname(rel), rootRel))] : []), "docs/spines/root.md", "AGENTS.md"];
  const texts = files.map((f) => ({ f, text: f === rel ? spine : readIf(repoDir, f) })).filter((x): x is { f: string; text: string } => !!x.text);
  const policyAt = texts.find((x) => field(x.text, "Integration policy"));
  const policy = policyAt ? stripInline(field(policyAt.text, "Integration policy")!) : "main-direct";
  if (!/^main-direct\b/i.test(policy)) return { ok: false, reason: `Integration policy is “${policy}”, not main-direct: the answer needs a PR, ${NO_PUSH}` };
  // A policy that puts its PR/CI wording on the Deploy gate ("main-direct (Deploy gate applies: gated code paths go via
  // a self-merged PR; docs push straight to main)") is left to the gate check below, when a gate is declared.
  const prOnGate = /\bdeploy gate\b/i.test(policy) && texts.some((x) => field(x.text, "Deploy gate"));
  if (!prOnGate && /\b(pr|prs|pull[- ]requests?|ci)\b/i.test(policy))
    return { ok: false, reason: `Integration policy mentions a PR or CI (“${policy}”): ${NO_PUSH}` };
  for (const x of texts) {
    const gate = field(x.text, "Deploy gate");
    if (!gate) continue;
    const value = stripInline(gate).replace(/\([^)]*\)/g, " ");
    if (/^(none|n\/a|no|-|—)\b/i.test(value.trim())) continue;
    const entries = value.split(/\s*(?:,|;|\|)\s*|\s+and\s+|\s+/).map((e) => e.replace(/^`|`$/g, "").replace(/[.,;]+$/, "")).filter(Boolean);
    if (!entries.length || !entries.every((e) => PATHISH.test(e) && /[/.*]/.test(e)))
      return { ok: false, reason: `Deploy gate “${stripInline(gate)}” is not a plain path list, so pushes to main are gated: ${NO_PUSH}` };
    const hit = gateHits(entries, rel);
    if (hit) return { ok: false, reason: `${rel} is under the Deploy gate (${hit}): the change needs a PR, ${NO_PUSH}` };
  }
  return { ok: true };
}

// ---------- git ----------

/** `err` is the last lines of stderr (for reasons); `stderr` all of it (to tell a rejected push from a broken one). */
type Run = (args: string[], o?: { timeout?: number }) => Promise<{ ok: boolean; out: string; err: string; stderr?: string }>;

/**
 * one git command that always returns. A push over HTTPS starts a credential helper and `git-remote-https`;
 * with `execFile` a timeout killed git alone, a child kept the pipes open, the callback never came and the write hung
 * between its commit and its push (the main server 2026-11-03 07:54Z: `Lease expired` committed, never pushed, never
 * undone, so main stayed diverged). Here git runs in its own process group, the whole group is killed on timeout, and
 * the result is returned on the timeout itself, whatever the children do.
 */
export function runner(dir: string, env: NodeJS.ProcessEnv): Run {
  return (args, o) =>
    new Promise((resolve) => {
      const limit = o?.timeout ?? git_timeout;
      let out = "";
      let err = "";
      let done = false;
      const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      const finish = (ok: boolean, why?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok, out: out.trim(), err: tail(err) || why || "", stderr: err });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("git", ["-C", dir, ...args], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        resolve({ ok: false, out: "", err: (e as Error).message });
        return;
      }
      const cap = 8 * 1024 * 1024;
      child.stdout?.on("data", (d: Buffer) => void (out.length < cap && (out += d.toString())));
      child.stderr?.on("data", (d: Buffer) => void (err.length < cap && (err += d.toString())));
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        err += `${err ? "\n" : ""}git ${args[0]} timed out after ${limit} ms (killed with its children)`;
        finish(false);
      }, limit);
      child.on("error", (e) => finish(false, e.message));
      child.on("exit", (code, signal) => {
        // stdio may still be draining: give it a moment, never wait for a child that holds the pipes
        setTimeout(() => finish(code === 0, `git ${args[0]} exited ${code ?? signal}`), 500).unref?.();
      });
      child.on("close", (code, signal) => finish(code === 0, `git ${args[0]} exited ${code ?? signal}`));
    });
}

type WriteInput = {
  repoDir: string;
  target: AnswerTarget;
  answer: string;
  label: string;
  date?: string;
  /** the owner gave the answer in the Team desk chat (his words, for the commit body). */
  via?: { name: string; chat?: string };
  /** the world owner's handle the answered line is signed with (default the owner). */
  owner?: string;
  /** the owner's words are feedback (changes wanted): the line becomes `[feedback …]` and the row it names reopens. */
  feedback?: boolean;
};
/** put `to` back where the line `from` is (an answer whose follow-up failed is taken back). */
/** `detail`: the failing step's reason, value-free (scrubbed by the caller), kept in the commit body so the
 * git history says why without console.db. */
type RevertInput = WriteInput & { from: string; to: string; why: string; detail?: string };
/** what an `edit` makes of the file's current text (re-read under the lock, after the fast-forward). */
export type FileEdit = { text: string; msg: string; body: string } | { skip: string };
/** any one-file edit with the same guards, lock, commit and push (a missing file is edited from ""). */
export type EditInput = {
  repoDir: string;
  path: string;
  label: string;
  date?: string;
  edit: (text: string, date: string) => FileEdit;
  /**
   * false commits with `--no-verify` (the repo's pre-commit hook is not run). Only for a one-field edit the
   * console computes and checks itself (a snooze date on an existing ask line): the epicspine hook spends 2-6 s scanning
   * the whole epic tree for advisories the console never shows. Default true.
   */
  verify?: boolean;
  /** skip `git fetch` when this checkout fetched or pushed this many ms ago (a push race still rebases once). */
  fetchFreshMs?: number;
  /**
   * a press write that may share one commit and push with other press writes to the same checkout landing close
   * together (groupWrite.ts): the hooks run once for all of them and each gets that commit. Off = a commit of its own.
   */
  group?: boolean;
  /** the press this edit writes (its id goes in the commit as a `Press:` trailer); set from the press worker. */
  press?: string;
};
/**
 * a change that creates or touches several files through a script (a child epic: spine_new.py writes the new spine
 * and registers it in `path`, the parent). Same guards, lock, commit and push; `scaffold` runs in the clean checkout and
 * returns the repo-relative files it wrote, and ONLY those may have changed (anything else is reverted and refused).
 */
export type ScaffoldInput = {
  repoDir: string;
  /** The spine the change hangs off (the Integration policy is read from it); also in `files` when the script edits it. */
  path: string;
  label: string;
  scaffold: (repoDir: string) => Promise<{ ok: true; files: string[] } | { ok: false; error: string }>;
  msg: string;
  body: string;
};
type AnyInput = WriteInput | RevertInput | EditInput | ScaffoldInput;
/** A checkout that passed guards 1-5, and the step timer of the write in it. */
type Ready = { g: Run; ms: Record<string, number>; t0: number; timed: <T>(step: string, p: Promise<T>) => Promise<T>; fetched: boolean };
type Mode = "answer" | "change" | "revert" | "edit" | "scaffold";

export interface SpineWriter {
  answer(o: WriteInput): Promise<SpineWrite>;
  /** rewrite the item's `[answered …]` line with a new answer (same guards, commit + push). */
  change(o: WriteInput): Promise<SpineWrite>;
  /** replace the exact line `from` with `to` (same guards, commit + push); skipped when `from` is gone. */
  revert(o: RevertInput): Promise<SpineWrite>;
  /** write the file `o.edit` returns (same guards, commit + push). */
  edit(o: EditInput): Promise<SpineWrite>;
  /** run a scaffolding script and commit + push exactly the files it wrote (same guards). */
  scaffold(o: ScaffoldInput): Promise<SpineWrite>;
  /**
   * several edits to one checkout (all the same `repoDir`) in one commit and one push: the guards and the fetch
   * once, each edit applied in order to the file as the edits before it left it, the hooks once (skipped only when every
   * edit asks `verify: false`). One result per edit, in order: an edit that skips is skipped alone; the rest share the
   * commit. When the commit is refused (a hook), each edit is written on its own instead, so one never sinks the others.
   */
  edits?(list: EditInput[]): Promise<SpineWrite[]>;
  /** background pushes: checkouts with commits not on origin yet, and a wait for them (graceful stop). */
  pushes?: BackgroundPushes;
}

/** the background pusher of a spine writer. */
export interface BackgroundPushes {
  pending(): { repoDir: string; since: string; tries: number; lastError?: string }[];
  /** Pushes on their way now or not tried yet (a deploy waits for these; one waiting for its retry survives a restart). */
  active(): number;
  /** Push `repoDir` now when it holds console commits origin lacks (boot, a kept commit). */
  kick(repoDir: string): void;
  /** Wait (at most `ms`) for every pending push; true when none is left. */
  drain(ms: number): Promise<boolean>;
}

/** the text with the one line equal to `from` (ignoring a trailing CR) replaced by `to`, or undefined. */
export function revertLine(text: string, from: string, to: string): string | undefined {
  const raw = text.split("\n");
  const bare = (l: string) => l.replace(/\r$/, "");
  const at = raw.findIndex((l) => bare(l) === bare(from));
  if (at < 0) return undefined;
  raw[at] = bare(to) + (raw[at].endsWith("\r") ? "\r" : "");
  return raw.join("\n");
}

/** Commit subject + body of an answer / change / revert write. */
function answerMessage(o: WriteInput | RevertInput, mode: Mode, rel: string, commitCode?: string, reopened?: { row: string; was: string }) {
  const verb = /^(APPROVED|DENIED)\b/.exec(o.answer.trim())?.[1] ?? (mode === "change" ? "changed" : "answered");
  const why = "why" in o ? o.why : "";
  const q = stripInline(o.target.question).slice(0, 200);
  const who = o.owner ?? DEFAULT_OWNER;
  // feedback is never an approval: the subject says so, the body names the row it reopened.
  if ((mode === "answer" || mode === "change") && "feedback" in o && o.feedback)
    return {
      msg: `Feedback ${commitCode || o.label}: changes wanted, not approved (${who}, via ${("via" in o && o.via?.name) || "console"})`,
      body:
        (mode === "change" ? `${q}\n\n${who} changed ${who === DEFAULT_OWNER ? "his" : "their"} answer to feedback: the [answered] line is now a [feedback] line in ${rel}; the work stays open` : `${q}\n\n${who}'s feedback, written by the agent-team console into ${rel} as a [feedback] line: the work stays open`) +
        (reopened ? ` (row ${reopened.row} is active again, was “${stripInline(reopened.was).slice(0, 120)}”)` : "") +
        ` and the next round comes back to ${who} as a new ask or review card.\n\nHis words: ${oneLine(o.answer).slice(0, 1500)}`,
    };
  if (mode === "revert") return { msg: `Answer ${commitCode || o.label} taken back: ${why} (console)`, body: `${q}\n\nThe agent-team console put the open ask back in ${rel}: ${why}.${"detail" in o && o.detail ? `\n\nReason: ${o.detail}` : ""}` };
  if (mode === "change")
    return {
      msg: `Answer ${commitCode || o.label} changed: ${verb === "changed" ? "new answer" : verb} (${who}, via console)`,
      body: `${q}\n\n${who} changed ${who === DEFAULT_OWNER ? "his" : "their"} answer before the owner acted on it: the agent-team console rewrote the [answered] line in ${rel} in place (new date and answer).`,
    };
  const via = "via" in o && o.via ? o.via : undefined;
  return {
    msg: `Answer ${commitCode || o.label}: ${verb} (${who}, via ${via?.name ?? "console"})`,
    body:
      `${q}\n\nOne-line answer written by the agent-team console into ${rel}; the owner acts on it and marks the line "· done <date> <sha>".` +
      (via ? `\n\n${who} gave it in the ${via.name} chat${via.chat ? `: ${oneLine(via.chat).slice(0, 500)}` : ""}.` : ""),
  };
}

/** `dir` (symlinks resolved) is inside the OS temp dir. */
export function underTmp(dir: string): boolean {
  try {
    const tmp = fs.realpathSync(os.tmpdir());
    const real = fs.realpathSync(dir);
    return real === tmp || real.startsWith(tmp + path.sep);
  } catch {
    return false;
  }
}

/** The path of a `git status --porcelain` line (the runner trims its output, so the first line may have lost its leading space). */
const porcelainPath = (l: string) => l.trim().replace(/^\S+\s+/, "").replace(/^"|"$/g, "");

/** the trailer on every commit the console's spine writer makes (how it tells its own commits from anyone's). */
export const CONSOLE_TRAILER = "Console-Write: spine-writer";
/** how many times a push refused because origin moved on is rebased and pushed again. */
export const PUSH_RACE_TRIES = 4;
/** the trailer naming the press a console commit carries (several in a batch). */
export const PRESS_TRAILER = "Press";
const pressCtx = new AsyncLocalStorage<string>();
/** run `fn` as the write of press `id` (the press worker); its edits carry the id into the commit. */
export const withPress = <T>(id: string, fn: () => T): T => pressCtx.run(id, fn);
export const currentPress = (): string | undefined => pressCtx.getStore();
/** The press ids named in commit messages (`Press: pr_…` trailers). */
export const pressesIn = (bodies: string): string[] => [...new Set([...bodies.matchAll(/^Press: (pr_[\w-]+)\s*$/gm)].map((m) => m[1]))];

/**
 * the console's own press commits skip the repo's pre-commit hooks (gitleaks alone took 1.3-6 s a commit on a
 * loaded the main server, the epicspine gate scans the whole tree). What such a commit adds is a status cell or a Decisions row the
 * console builds itself, plus the owner's own words (feedback, a reason, a comment): those words could hold a pasted key.
 * So the added lines are checked here, in-process, for the shapes of a secret (the patterns below, the high-signal
 * rules of gitleaks); any hit and the commit runs the full hooks after all, and gitleaks decides as before.
 */
export const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bat_[A-Za-z0-9_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /https?:\/\/[^\s/:@]+:[^\s/@]{6,}@/,
  /\b(?:api[_-]?key|secret|passw(?:or)?d|token|private[_-]?key)\b["']?\s*[:=]\s*["']?[^\s"'|]{12,}/i,
];
export const secretShaped = (text: string): boolean => SECRET_SHAPES.some((re) => re.test(text));

/** staging's refusal of every push (staging.ts NO_PUSH_URL and its pre-push hook). */
const STAGING_REFUSAL = /staging-no-push|staging: git push is off here/;
/** A push refused because origin moved on (another writer pushed first). */
const NON_FF = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|Updates were rejected/i;

/**
 * after a failed push, put the checkout back to the state before the write (`pre`, or origin/main when origin
 * has moved on from it). Only our own commit is
 * dropped: every commit between `pre` and HEAD that origin lacks must carry the console's trailer, else nothing moves.
 */
async function undoOwnCommit(g: Run, pre: string): Promise<boolean> {
  if ((await g(["rev-parse", "-q", "--verify", "REBASE_HEAD"])).ok) await g(["rebase", "--abort"]);
  const local = await g(["log", "--format=%H%x1f%B%x1e", `${pre}..HEAD`, "--not", `origin/${MAIN}`]);
  if (!local.ok) return false;
  const recs = local.out.split("\x1e").map((x) => x.trim()).filter(Boolean);
  if (recs.some((r) => !r.includes(CONSOLE_TRAILER))) return false;
  // origin only moves forward: when it holds `pre`, land on origin/main (main equals origin, nothing to pull)
  const to = (await g(["merge-base", "--is-ancestor", pre, `origin/${MAIN}`])).ok ? `origin/${MAIN}` : pre;
  return (await g(["reset", "-q", "--hard", to])).ok;
}

/**
 * before a write, a checkout ahead of origin is healed only when every local commit is the console's own (its
 * trailer) and was never pushed: HEAD is kept on `backup/console-<sha>`, then main is reset to origin. Any other
 * commit (a person's, an agent's) is left alone and the write is refused.
 */
async function dropOwnStrays(g: Run): Promise<{ ok: true; backup: string; dropped: string[] } | { ok: false; reason: string }> {
  const local = await g(["log", "--format=%H%x1f%s%x1f%B%x1e", `origin/${MAIN}..HEAD`]);
  if (!local.ok) return { ok: false, reason: local.err };
  const recs = local.out.split("\x1e").map((x) => x.trim()).filter(Boolean).map((r) => r.split("\x1f"));
  const foreign = recs.filter((r) => !(r[2] ?? "").includes(CONSOLE_TRAILER));
  if (!recs.length || foreign.length) return { ok: false, reason: `${foreign.length} local commit(s) not made by the console, e.g. ${(foreign[0]?.[0] ?? "").slice(0, 8)} “${foreign[0]?.[1] ?? ""}”: push or rebase them` };
  const head = (await g(["rev-parse", "HEAD"])).out;
  const backup = `backup/console-${head.slice(0, 8)}`;
  const b = await g(["branch", "-f", backup, head]);
  if (!b.ok) return { ok: false, reason: `cannot keep a backup branch: ${b.err}` };
  const r = await g(["reset", "-q", "--hard", `origin/${MAIN}`]);
  if (!r.ok) return { ok: false, reason: `reset to origin/${MAIN} failed: ${r.err}` };
  return { ok: true, backup, dropped: recs.map((x) => `${x[0].slice(0, 8)} ${x[1]}`) };
}

/** the pauses before asking again whether a checkout in a passing git state (rebase, lock, slow git) is back on main. */
export const HEAD_RETRY_MS = [1_000, 3_000, 6_000];

/**
 * whether `dir` is on main, ready for a write. Before, a `symbolic-ref` that failed for any
 * reason (a timeout under load) read as a detached HEAD, and the write gave up at once, never retried. Now:
 * - another git process mid-rebase or holding a lock, or git itself failing: asked again after each HEAD_RETRY_MS pause,
 *   then `transient` (the caller fails, so the answer job and the press worker try again later);
 * - detached at a commit main already has, with a clean tree (a rebase or checkout cut off): put back on main, nothing lost;
 * - detached with commits main lacks, or on another branch: left as is and refused (never moves anyone's work).
 */
export async function onMain(g: Run, dir: string, pauses: number[] = HEAD_RETRY_MS): Promise<{ ok: true } | { ok: false; transient: boolean; reason: string }> {
  let last = "";
  for (let i = 0; ; i++) {
    const h = await g(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (h.ok && h.out === MAIN) return { ok: true };
    if (h.ok && h.out) return { ok: false, transient: false, reason: `the checkout is on ${h.out}, not ${MAIN}` };
    // `symbolic-ref -q` exits 1 with nothing on stderr only for a detached HEAD; anything else is git failing
    const detached = !h.ok && /exited 1$/.test(h.err.trim()) && !(h.stderr ?? "").trim();
    const busy = await gitBusy(g, dir);
    if (detached && !busy) {
      const sha = (await g(["rev-parse", "HEAD"])).out;
      const kept = sha && (await g(["merge-base", "--is-ancestor", "HEAD", MAIN])).ok;
      const st = kept ? await g(["status", "--porcelain"]) : undefined;
      const clean = !!st?.ok && !st.out;
      if (!kept) return { ok: false, transient: false, reason: `the checkout is on a detached HEAD${sha ? ` (${sha.slice(0, 8)})` : ""} with commits ${MAIN} lacks, not ${MAIN}; left as is` };
      if (clean && (await g(["checkout", "-q", MAIN])).ok) continue; // back on main: check again
      last = `the checkout is on a detached HEAD at ${sha.slice(0, 8)} and could not be put back on ${MAIN}`;
    } else last = busy ? `another git process is working in the checkout (${busy})` : `git could not read the checkout's branch (${h.err || "no answer"})`;
    if (i >= pauses.length) return { ok: false, transient: true, reason: `${last}; tried ${i + 1} times` };
    await new Promise((r) => setTimeout(r, pauses[i]));
  }
}

/** a rebase, merge or lock another git process holds in `dir` right now, or "" when none. */
async function gitBusy(g: Run, dir: string): Promise<string> {
  const gd = (await g(["rev-parse", "--absolute-git-dir"])).out;
  if (!gd) return "";
  const base = path.isAbsolute(gd) ? gd : path.join(dir, gd);
  for (const [f, what] of [["rebase-merge", "a rebase"], ["rebase-apply", "a rebase"], ["MERGE_HEAD", "a merge"], ["index.lock", "index.lock"], ["HEAD.lock", "HEAD.lock"]] as const)
    if (fs.existsSync(path.join(base, f))) return what;
  return "";
}

/** Writes serialised per repo checkout (a lock chain per directory). */
/** what a commit the background pusher could not land carried, put back so each press is written again. */
export interface DroppedPush {
  repoDir: string;
  presses: string[];
  commits: string[];
  backup?: string;
  reason: string;
}
export interface SpineWriterOptions {
  onHeal?: (h: { repoDir: string; backup: string; dropped: string[] }) => void;
  /**
   * a press write (`group: true`) is committed in the console's checkout and answered at once; the push to origin
   * runs in the background, with the rebase on a race as before and retries until it lands. A commit that cannot be
   * rebased (the same line changed on origin) is kept on a backup branch and its presses go back to the outbox
   * (`onDropped`), which writes them again on the fresh spine: a press is never lost. Default off (tests); the app turns
   * it on unless `CONSOLE_PUSH_BACKGROUND=0`.
   */
  backgroundPush?: boolean;
  /** press commits skip the hooks after an in-process secret check ("scan", default) or always run them ("full"). */
  pressHooks?: "scan" | "full";
  /** Pauses before each new try of a background push that failed for a reason other than a conflict. */
  pushRetryMs?: number[];
  onPushed?: (repoDir: string) => void;
  onDropped?: (d: DroppedPush) => void;
  log?: (msg: string) => void;
  /** the stale-lock healer (tests pass their own); default: lockHealer() of gitStaleLock (10 min, no git running). */
  lockHealer?: LockHealer;
}
export const PUSH_RETRY_MS = [1_000, 3_000, 10_000, 30_000, 60_000, 5 * 60_000];
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15" });

export function createSpineWriter(opts: SpineWriterOptions = {}): SpineWriter {
  /** when each checkout last fetched or pushed origin/main successfully. */
  const synced = new Map<string, number>();
  /**
   * what a checkout's guards read that does not change between presses (a git work tree, its own commit identity
   * or none, an origin remote), kept STATIC_FACTS_MS after a write that got past them; each one was a git call of
   * 100-300 ms on the main server. Branch, cleanliness and origin's state are still read every write.
   */
  const facts = new Map<string, { at: number; email: boolean }>();
  const log = opts.log ?? ((m: string) => console.warn(m));
  const bgOn = !!opts.backgroundPush;
  const healer = opts.lockHealer ?? lockHealer();
  /**
   * a git step refused by a lock file a killed git left in the checkout (a console restart killed a git mid-write and
   * left .git/index.lock; every later write to that checkout failed "fast-forward ... failed" until a person removed
   * it, a world's idea cards and the owner's presses with it). When the lock is older than STALE_LOCK_MS and no git
   * runs in the checkout it is removed, logged, and the caller retries the step once; else the error stands.
   */
  const healLock = async (repoDir: string, r: { ok: boolean; err: string; stderr?: string }, step: string): Promise<boolean> => {
    if (r.ok) return false;
    const h = await healer(repoDir, r.stderr || r.err).catch(() => undefined);
    if (!h?.removed || !("lock" in h)) return false;
    log(`spine write: removed stale ${path.relative(repoDir, h.lock)} in ${repoDir} (${h.ageMin} min old, no git running), retrying the ${step} once`);
    return true;
  };
  const retryMs = opts.pushRetryMs ?? PUSH_RETRY_MS;
  /** checkouts whose console commits origin lacks, and their background push. */
  const pend = new Map<string, { since: number; tries: number; lastError?: string; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; again?: boolean; retryIn?: number }>();
  const pushed = (repoDir: string) => {
    if (!pend.delete(repoDir)) return;
    try {
      opts.onPushed?.(repoDir);
    } catch (e) {
      log(`spine write: after the push of ${repoDir}: ${(e as Error).message}`);
    }
  };
  const dropped = (d: DroppedPush) => {
    log(`spine write: ${d.repoDir}: ${d.commits.length} console commit(s) could not be pushed (${d.reason})${d.backup ? `, kept on ${d.backup}` : ""}; ${d.presses.length} press(es) go back to the outbox to be written again`);
    try {
      opts.onDropped?.(d);
    } catch (e) {
      log(`spine write: putting back the presses of ${d.repoDir}: ${(e as Error).message}`);
    }
  };
  function schedule(repoDir: string, delay = 0): void {
    let p = pend.get(repoDir);
    if (!p) pend.set(repoDir, (p = { since: Date.now(), tries: 0 }));
    if (p.running) {
      p.again = true;
      return;
    }
    if (p.timer) {
      if (delay > 0) return;
      clearTimeout(p.timer);
    }
    const q = p;
    q.timer = setTimeout(() => {
      q.timer = undefined;
      q.running = pushNow(repoDir)
        .catch((e) => {
          q.tries++;
          q.lastError = (e as Error).message;
          q.retryIn = retryMs[Math.min(q.tries - 1, retryMs.length - 1)];
        })
        .finally(() => {
          q.running = undefined;
          if (pend.get(repoDir) !== q) return;
          if (q.again) {
            q.again = false;
            q.retryIn = undefined;
            return schedule(repoDir);
          }
          if (q.retryIn !== undefined) {
            const w = q.retryIn;
            q.retryIn = undefined;
            schedule(repoDir, w);
          }
        });
    }, delay);
    q.timer.unref?.();
  }
  /**
   * push the console commits of `repoDir`: landed, put back (conflict) or tried again later. The push itself runs
   * outside the checkout's lock (it sends a fixed commit; presses keep committing on top meanwhile, and go in the next
   * round): a slow push to GitHub never holds a press. Only the rebase after a race takes the lock.
   */
  async function pushNow(repoDir: string): Promise<void> {
    const p = pend.get(repoDir);
    const g = runner(repoDir, gitEnv());
    const t0 = Date.now();
    for (let round = 0; round < 10; round++) {
      const head = (await g(["rev-parse", "HEAD"])).out.trim();
      const ahead = head ? await g(["rev-list", "--count", `origin/${MAIN}..${head}`]) : { ok: false, out: "", err: "no HEAD" };
      if (ahead.ok && Number(ahead.out) === 0) return pushed(repoDir);
      let push = head ? await g(["push", "origin", `${head}:refs/heads/${MAIN}`], { timeout: 60_000 }) : { ok: false, out: "", err: "no HEAD", stderr: "" };
      let conflict: string | undefined;
      if (!push.ok && NON_FF.test(push.stderr ?? push.err)) {
        // origin moved on: fetch, rebase and push again, under the lock (no press commits in the middle of a rebase)
        const raced = await serial(repoDir, async () => {
          let r = push;
          for (let i = 0; i < PUSH_RACE_TRIES && !r.ok && NON_FF.test(r.stderr ?? r.err); i++) {
            if (i > 0) await new Promise((x) => setTimeout(x, 300 + Math.floor(Math.random() * 700)));
            const refetch = await g(["fetch", "origin", MAIN], { timeout: 45_000 });
            if (!refetch.ok) return { push: refetch };
            const rebase = await g(["rebase", `origin/${MAIN}`], { timeout: 60_000 });
            if (!rebase.ok) {
              await g(["rebase", "--abort"]);
              return { push: r, conflict: `rebase onto origin/${MAIN} failed (the spine changed on origin): ${rebase.err}` };
            }
            r = await g(["push", "origin", `HEAD:${MAIN}`], { timeout: 60_000 });
          }
          return { push: r };
        });
        push = raced.push;
        conflict = raced.conflict;
        if (conflict) return void (await serial(repoDir, () => putBack(g, repoDir, conflict!)));
      }
      if (!push.ok && STAGING_REFUSAL.test(`${push.stderr ?? ""} ${push.err}`)) {
        // staging refuses every push by design; there the local commit is the landing (nothing to retry)
        log(`spine write: ${repoDir}: no push on staging; the press stays in staging's own checkout`);
        return pushed(repoDir);
      }
      if (!push.ok) {
        if (p) {
          p.tries++;
          p.lastError = push.err.slice(0, 300);
          p.retryIn = retryMs[Math.min(p.tries - 1, retryMs.length - 1)];
          log(`spine write: background push of ${repoDir} failed (try ${p.tries}: ${p.lastError}); again in ${Math.round(p.retryIn / 1000)} s, the commit stays in the console's checkout`);
        }
        return;
      }
      synced.set(repoDir, Date.now());
      log(`spine write: pushed ${ahead.out || "the"} console commit(s) of ${repoDir} in the background in ${Date.now() - t0} ms${p?.tries ? ` (try ${p.tries + 1})` : ""}`);
      // presses committed while it was on its way go in the next round
    }
    if (p) p.again = true;
  }
  /** the console commits origin lacks cannot be rebased: keep them on a backup branch, reset, put their presses back. */
  async function putBack(g: Run, repoDir: string, reason: string): Promise<boolean> {
    const local = await g(["log", "--format=%B%x1e", `origin/${MAIN}..HEAD`]);
    const presses = pressesIn(local.out);
    const healed = await dropOwnStrays(g);
    pend.delete(repoDir);
    if (!healed.ok) {
      log(`spine write: ${repoDir}: could not put back the console commits origin lacks (${healed.reason}); left as is`);
      return false;
    }
    dropped({ repoDir, presses, commits: healed.dropped, backup: healed.backup, reason });
    return true;
  }
  /**
   * before a write, a checkout ahead of origin with only console commits keeps them (their background push is
   * pending, or a restart cut it off): rebased onto origin when origin moved on, then pushed with the new commit. A
   * commit that does not rebase is put back (its presses written again); anyone else's commit refuses the write as before.
   */
  async function keepOwn(g: Run, repoDir: string, behind: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const local = await g(["log", "--format=%H%x1f%s%x1f%B%x1e", `origin/${MAIN}..HEAD`]);
    if (!local.ok) return { ok: false, reason: local.err };
    const recs = local.out.split("\x1e").map((x) => x.trim()).filter(Boolean).map((r) => r.split("\x1f"));
    const foreign = recs.filter((r) => !(r[2] ?? "").includes(CONSOLE_TRAILER));
    if (foreign.length) return { ok: false, reason: `${foreign.length} local commit(s) not made by the console, e.g. ${(foreign[0]?.[0] ?? "").slice(0, 8)} “${foreign[0]?.[1] ?? ""}”: push or rebase them` };
    if (behind > 0) {
      const rebase = await g(["rebase", `origin/${MAIN}`], { timeout: 60_000 });
      if (!rebase.ok) {
        await g(["rebase", "--abort"]);
        if (!(await putBack(g, repoDir, `rebase onto origin/${MAIN} failed (the spine changed on origin): ${rebase.err}`))) return { ok: false, reason: "could not put back the console commits origin lacks" };
        return { ok: true };
      }
    }
    schedule(repoDir);
    return { ok: true };
  }
  // the checkout's console-wide git lock (repoLock.ts), so a pull elsewhere in the console never runs in the middle
  // of a write (fetch, commit, push) on the same checkout.
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => withRepoLock(key, fn);

  /**
   * Guards 1-5 for a write to `rel` in `o.repoDir` (the checkout, main, clean, a remote, the Integration policy, then
   * fetched unless it synced within `freshMs`, and fast-forwarded): a ready checkout, or why not (the write's result).
   */
  async function open(o: AnyInput, rel: string, freshMs: number | undefined): Promise<Ready | SpineWrite> {
    const skip = (reason: string): SpineWrite => ({ status: "skipped", reason, path: rel });
    const fail = (reason: string): SpineWrite => ({ status: "failed", reason, path: rel });
    // under the test runner the writer
    // touches only checkouts inside the OS temp dir, never a real one.
    if ((process.env.VITEST || process.env.NODE_ENV === "test") && !underTmp(o.repoDir)) {
      // test/realCheckoutGuard.ts fails the test that asked (a skip alone would let it pass)
      (globalThis as { __e62s9?: { record(what: string): void } }).__e62s9?.record(`spine write to ${o.repoDir}`);
      return skip(`tests write only temp checkouts: ${o.repoDir} is outside ${os.tmpdir()}`);
    }
    if (!inside(o.repoDir, rel)) return skip(`${rel} is outside the repo checkout`);
    const env: NodeJS.ProcessEnv = gitEnv();
    const ms: Record<string, number> = {};
    const t0 = Date.now();
    /** Time one step into `ms` (summed when a step runs twice, e.g. push after a rebase). */
    const timed = async <T>(step: string, p: Promise<T>): Promise<T> => {
      const s = Date.now();
      try {
        return await p;
      } finally {
        ms[step] = (ms[step] ?? 0) + Date.now() - s;
      }
    };
    let g = runner(o.repoDir, env);
    const known = facts.get(o.repoDir);
    const sure = !!known && STATIC_FACTS_MS > 0 && Date.now() - known.at < STATIC_FACTS_MS && fs.existsSync(path.join(o.repoDir, ".git"));
    if (!sure) facts.delete(o.repoDir);
    if (!sure && !(await g(["rev-parse", "--is-inside-work-tree"])).ok) return skip("not a git checkout");
    // Commit identity: the repo's own when set, else the console's.
    const email = sure ? known!.email : !!(await g(["config", "user.email"])).out;
    if (!email) {
      env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "Agent Team Console";
      env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = sites().gitEmail;
      g = runner(o.repoDir, env);
    }

    // Guards 1-3: on main, clean tree, a remote to push to. A passing state (another git mid-rebase, a lock, a
    // git call that timed out on a loaded host) is waited out, and a detached HEAD that holds nothing is put back on main.
    const head = await onMain(g, o.repoDir);
    if (!head.ok) return head.transient ? fail(head.reason) : skip(head.reason);
    let dirty = await g(["status", "--porcelain"]);
    if (!dirty.ok) return fail(`git status failed: ${dirty.err}`);
    // A stale index alone (staged entries, every file equal to HEAD, nothing untracked; seen on the main server after an interrupted
    // commit/rebase: "MM docs/spines/…") holds no work: resync the index to HEAD, losslessly, instead of refusing.
    if (dirty.out && !/^\?\?/m.test(dirty.out) && (await g(["diff", "--quiet", "HEAD"])).ok) {
      await g(["reset", "-q"]);
      dirty = await g(["status", "--porcelain"]);
      if (!dirty.ok) return fail(`git status failed: ${dirty.err}`);
    }
    // tracked files whose edits are already in HEAD or upstream hold no work either: restore them first.
    if (dirty.out && parseRedundant(await localHealRunner(o.repoDir, REDUNDANT, 0).catch(() => "")).removed) {
      dirty = await g(["status", "--porcelain"]);
      if (!dirty.ok) return fail(`git status failed: ${dirty.err}`);
    }
    if (dirty.out) return skip(`the checkout has uncommitted changes (${dirty.out.split("\n")[0].trim()}${dirty.out.includes("\n") ? ", …" : ""})`);
    if (!sure && !(await g(["remote", "get-url", "origin"])).ok) return skip("the checkout has no origin remote to push to");
    if (!sure) facts.set(o.repoDir, { at: Date.now(), email });

    // Guard 4: Integration policy allows a main push for this file.
    const pol = pushPolicy(o.repoDir, rel);
    if (!pol.ok) return skip(pol.reason);

    // Guard 5: fast-forwardable from origin (behind: fast-forward now; ahead or diverged: refuse).
    ms.guards = Date.now() - t0;
    const fresh = freshMs ? Date.now() - (synced.get(o.repoDir) ?? 0) < freshMs : false;
    if (fresh) ms.fresh = 1;
    if (!fresh) {
      let fetched = await timed("fetch", g(["fetch", "origin", MAIN], { timeout: 45_000 }));
      // another git process fetching this checkout at that moment (the host's background sync): once more.
      if (!fetched.ok && gitContention(fetched.err)) {
        await new Promise((r) => setTimeout(r, CONTENTION_RETRY_MS));
        fetched = await timed("fetch", g(["fetch", "origin", MAIN], { timeout: 45_000 }));
      }
      if (await healLock(o.repoDir, fetched, "fetch")) fetched = await timed("fetch", g(["fetch", "origin", MAIN], { timeout: 45_000 }));
      if (!fetched.ok) return fail(`git fetch origin ${MAIN} failed: ${fetched.err}`);
      synced.set(o.repoDir, Date.now());
    }
    const lr = await g(["rev-list", "--left-right", "--count", `HEAD...origin/${MAIN}`]);
    const [ahead, behind] = lr.out.split(/\s+/).map(Number);
    if (!lr.ok || Number.isNaN(ahead) || Number.isNaN(behind)) return fail(`cannot compare with origin/${MAIN}: ${lr.err}`);
    if (ahead > 0 && bgOn) {
      const kept = await keepOwn(g, o.repoDir, behind);
      if (!kept.ok) return skip(`local ${MAIN} is ${behind > 0 ? "diverged from" : `${ahead} commit(s) ahead of`} origin/${MAIN}; not fast-forwardable (${kept.reason})`);
    } else if (ahead > 0) {
      // commits only the console made (a write cut off between its commit and its push, e.g. by a restart) are
      // dropped, kept on a backup branch; anyone else's unpushed commit is never touched: the write is refused.
      const healed = await dropOwnStrays(g);
      if (!healed.ok) return skip(`local ${MAIN} is ${behind > 0 ? "diverged from" : `${ahead} commit(s) ahead of`} origin/${MAIN}; not fast-forwardable (${healed.reason})`);
      opts.onHeal?.({ repoDir: o.repoDir, backup: healed.backup, dropped: healed.dropped });
    } else if (behind > 0) {
      let ff = await g(["merge", "--ff-only", `origin/${MAIN}`]);
      if (await healLock(o.repoDir, ff, "fast-forward")) ff = await g(["merge", "--ff-only", `origin/${MAIN}`]);
      if (!ff.ok) return fail(`fast-forward to origin/${MAIN} failed: ${ff.err}`);
    }
    return { g, ms, t0, timed, fetched: !fresh };
  }

  /** Commit `files` (hooks run unless `verify` is false) and push to main, rebasing on push races; the write's result. */
  async function commitPush(
    c: Ready,
    repoDir: string,
    rel: string,
    files: string[],
    msg: string,
    body: string,
    flip: { before: string; after: string } | undefined,
    verify: boolean | "scan",
    bg = false,
    presses: string[] = [],
  ): Promise<SpineWrite> {
    const { g, ms, t0, timed } = c;
    const fail = (reason: string): SpineWrite => ({ status: "failed", reason, path: rel });
    {
      // the pre-write state; a failed push returns the checkout to exactly this.
      const pre = (await g(["rev-parse", "HEAD"])).out;
      let add = await g(["add", "--", ...files]);
      if (await healLock(repoDir, add, "add")) add = await g(["add", "--", ...files]);
      let noVerify = verify === true ? [] : ["--no-verify"];
      if (add.ok && verify === "scan") {
        // the hooks only when what this commit adds looks like a secret (or cannot be read): gitleaks decides then
        const d = await timed("scan", g(["diff", "--cached", "-U0", "--no-color", "--", ...files]));
        const added = d.out.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
        if (!d.ok || secretShaped(added)) {
          noVerify = [];
          ms.hooks = 1;
        }
      }
      const trailers = [...new Set(presses)].map((id) => `${PRESS_TRAILER}: ${id}`).join("\n");
      const commit = add.ok ? await timed("commit", g(["commit", ...noVerify, "-m", msg, "-m", `${body}\n\n${trailers ? `${trailers}\n` : ""}${CONSOLE_TRAILER}`, "--only", "--", ...files], { timeout: 60_000 })) : add;
      if (!commit.ok) {
        await g(["reset", "-q", "HEAD", "--", ...files]);
        for (const f of files) {
          const known = (await g(["ls-files", "--error-unmatch", f])).ok;
          if (known) await g(["checkout", "--", f]);
          else fs.rmSync(inside(repoDir, f) ?? "", { force: true });
        }
        return fail(`git commit failed: ${commit.err}`);
      }

      if (bg) {
        // in the spine of the console's checkout now; the push follows in the background (pushNow)
        let sha = "";
        for (let i = 0; i < 3 && !sha; i++) {
          const r = await g(["rev-parse", "--short", "HEAD"]);
          sha = r.ok ? r.out.trim() : "";
          if (!sha) await new Promise((res) => setTimeout(res, 300));
        }
        schedule(repoDir);
        ms.total = Date.now() - t0;
        return { status: "written", ...(sha ? { sha } : {}), path: rel, ...(flip ?? {}), ms, pushing: true };
      }
      // Push; rejected because another writer pushed first: fetch fresh, rebase our one commit, push again. Up to
      // PUSH_RACE_TRIES times (workers push to the same main all the time; one more try was not enough on 2026-11-08).
      let push = await timed("push", g(["push", "origin", `HEAD:${MAIN}`], { timeout: 60_000 }));
      for (let i = 0; i < PUSH_RACE_TRIES && !push.ok && NON_FF.test(push.stderr ?? push.err); i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 700)));
        const refetch = await timed("rebase", g(["fetch", "origin", MAIN], { timeout: 45_000 }));
        const rebase = refetch.ok ? await timed("rebase", g(["rebase", `origin/${MAIN}`], { timeout: 60_000 })) : refetch;
        if (rebase.ok) push = await timed("push", g(["push", "origin", `HEAD:${MAIN}`], { timeout: 60_000 }));
        else {
          await g(["rebase", "--abort"]);
          push = { ok: false, out: "", err: `rebase onto origin/${MAIN} failed (the spine changed on origin): ${rebase.err}` };
        }
      }
      if (!push.ok) {
        // drop our own commit so main never stays ahead of (or diverged from) origin; Retry starts clean.
        const undone = await undoOwnCommit(g, pre);
        synced.delete(repoDir);
        return fail(`git push failed: ${push.err}${undone ? "" : ` (the checkout could not be reset to ${pre.slice(0, 8)}: check it)`}`);
      }
      synced.set(repoDir, Date.now());
      // console commits waiting for their background push went out with this one
      if (pend.has(repoDir) && !pend.get(repoDir)!.running) {
        clearTimeout(pend.get(repoDir)!.timer);
        pushed(repoDir);
      }
      // the pushed commit's sha; a rev-parse that fails under load (the main server, 2026-11-08 01:06Z: a reopen landed as
      // c616f6f but answered without its commit) is asked again before the write is reported without one.
      let sha = "";
      for (let i = 0; i < 3 && !sha; i++) {
        const r = await g(["rev-parse", "--short", "HEAD"]);
        sha = r.ok ? r.out.trim() : "";
        if (!sha) {
          console.warn(`spine write: ${repoDir}: rev-parse HEAD after the push failed (try ${i + 1}): ${r.err}`);
          await new Promise((res) => setTimeout(res, 300));
        }
      }
      ms.total = Date.now() - t0;
      return { status: "written", ...(sha ? { sha } : {}), path: rel, ...(flip ?? {}), ms };
    }
  }

  async function attempt(o: AnyInput, mode: Mode, fetch = false): Promise<SpineWrite> {
    const rel = "edit" in o || "scaffold" in o ? o.path : o.target.path;
    const skip = (reason: string): SpineWrite => ({ status: "skipped", reason, ...(rel ? { path: rel } : {}) });
    const fail = (reason: string): SpineWrite => ({ status: "failed", reason, ...(rel ? { path: rel } : {}) });
    if (!rel) return skip("the item has no spine file to write to");
    const c = await open(o, rel, "edit" in o && !fetch ? o.fetchFreshMs : undefined);
    if ("status" in c) return c;
    const { g } = c;
    // a press write (group) skips the hooks after the secret check and pushes in the background
    const press = "edit" in o && !!o.group;
    const commitAndPush = (files: string[], msg: string, body: string, flip: { before: string; after: string } | undefined) =>
      commitPush(c, o.repoDir, rel, files, msg, body, flip, "edit" in o && o.verify === false ? false : press && opts.pressHooks !== "full" ? "scan" : true, press && bgOn, "edit" in o && o.press ? [o.press] : []);

    if ("scaffold" in o) {
      const undo = async () => {
        const st = await g(["status", "--porcelain", "--untracked-files=all"]);
        for (const l of st.out.split("\n").filter(Boolean)) {
          const f = porcelainPath(l);
          if (l.trim().startsWith("??")) fs.rmSync(inside(o.repoDir, f) ?? "", { force: true });
          else await g(["checkout", "HEAD", "--", f]);
        }
      };
      const r = await o.scaffold(o.repoDir);
      if (!r.ok) {
        await undo();
        return skip(r.error);
      }
      let st = await g(["status", "--porcelain", "--untracked-files=all"]);
      if (!st.ok) {
        // a failed status printed nothing; never read that as "changed nothing"
        await new Promise((res) => setTimeout(res, CONTENTION_RETRY_MS));
        st = await g(["status", "--porcelain", "--untracked-files=all"]);
      }
      if (!st.ok) {
        await undo();
        return fail(`git status failed after the script ran: ${st.err || "no answer"}; reverted`);
      }
      const changed = st.out.split("\n").filter(Boolean).map(porcelainPath);
      const extra = changed.filter((f) => !r.files.includes(f));
      if (!changed.length || extra.length) {
        await undo();
        return skip(changed.length ? `the script would change more than ${r.files.join(", ")} (${extra.join(", ")}); reverted` : "the script changed nothing");
      }
      for (const f of changed) {
        const p = pushPolicy(o.repoDir, f);
        if (!p.ok) {
          await undo();
          return skip(p.reason);
        }
      }
      return commitAndPush(changed, o.msg, o.body, undefined);
    }

    // Re-read and re-find the line now (the spine may have changed since the item was listed).
    const abs = inside(o.repoDir, rel)!;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      if (!("edit" in o)) return skip(`${rel} is not in the checkout any more`);
      text = "";
    }
    const date = o.date ?? new Date().toISOString().slice(0, 10);
    let next: string;
    let commitCode: string | undefined;
    let flip: { before: string; after: string } | undefined;
    let given: { msg: string; body: string } | undefined;
    let reopened: { row: string; was: string } | undefined;
    let movedFrom: string | undefined;
    if ("edit" in o) {
      const e = o.edit(text, date);
      // a checkout not fetched (it synced moments ago) may be behind what the press saw: before an edit is
      // refused or found already made, fetch and look again, so a stale copy never answers for origin
      if (("skip" in e || e.text === text) && !c.fetched) return attempt(o, mode, true);
      if ("skip" in e) return skip(e.skip);
      if (e.text === text) return { status: "written", reason: "the file already has this change", path: rel };
      next = e.text;
      given = { msg: e.msg, body: e.body };
    } else if (mode === "revert") {
      const r = o as RevertInput;
      const t = revertLine(text, r.from, r.to);
      if (t === undefined) return skip(`the answered line in ${rel} changed since it was written; nothing reverted`);
      // the ask is open again, so Current State's `Waiting on:` names it again.
      next = r.target.code ? restoreToWaitingField(t, r.target.code, r.owner ?? DEFAULT_OWNER) : t;
      commitCode = r.target.code;
    } else if (mode === "change") {
      const ch = changeAnswer(text, o.target, o.answer, date, o.owner, !!(o as WriteInput).feedback);
      if (ch.how === "missing") return skip(`the answered line is not in ${rel} any more: the owner already acted on the answer; nothing changed`);
      if (ch.how === "done") return skip(`the answered line in ${rel} is marked done: the owner already acted on the answer; nothing changed`);
      if (ch.how === "not_jordi") return skip(`the line in ${rel} is answered by ${ch.who}, not ${o.owner ?? DEFAULT_OWNER}: reverse it instead; nothing changed`);
      if (ch.how === "same") return { status: "written", reason: "the spine already has this answer", path: rel };
      next = ch.text;
      commitCode = ch.code;
      reopened = ch.reopened;
    } else {
      const w = o as WriteInput;
      const edit = applyAnswer(text, w.target, w.answer, date, w.owner, !!w.feedback);
      if (edit.how === "missing") return skip(`the ask is not in ${rel} any more or its text changed (the spine moved on); nothing written`);
      if (edit.how === "already") return { status: "written", reason: "already answered in the spine", path: rel };
      next = edit.text;
      commitCode = edit.how === "flip" ? edit.code : undefined;
      if (edit.how === "flip") flip = { before: text.split("\n")[edit.line].replace(/\r$/, ""), after: next.split("\n")[edit.line].replace(/\r$/, "") };
      reopened = edit.reopened;
      movedFrom = edit.how === "flip" ? edit.movedFrom : undefined;
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next);
    // Guard 6: this one file is the only change. A `git status` that failed (a lock held, a timeout on a loaded
    // host) printed nothing, and the guard refused "would change more than X " for nothing (rv_941196, 2026-11-08
    // 01:28Z): ask again once, and a status that still fails is git trouble (the press retries), never a refusal.
    let after = await g(["status", "--porcelain", "--untracked-files=all"]);
    if (!after.ok) {
      await new Promise((r) => setTimeout(r, CONTENTION_RETRY_MS));
      after = await g(["status", "--porcelain", "--untracked-files=all"]);
    }
    const undo = async () => {
      if (text) await g(["checkout", "--", rel]);
      else fs.rmSync(abs, { force: true });
    };
    if (!after.ok) {
      await undo();
      return fail(`git status failed after writing ${rel}: ${after.err || "no answer"}; reverted`);
    }
    const changed = after.out.split("\n").filter(Boolean);
    if (!changed.length) {
      await undo();
      return fail(`git sees no change in ${rel} after writing it (line endings or a filter?); reverted`);
    }
    if (changed.length !== 1 || !changed[0].endsWith(rel)) {
      await undo();
      return skip(`writing would change more than ${rel} (${changed.join(", ")}); reverted`);
    }

    const said = given ?? answerMessage(o as WriteInput | RevertInput, mode, rel, commitCode, reopened);
    // an answer to a replaced ask, landed on the ask that replaced it: the commit says so
    const { msg, body } = movedFrom ? { msg: `${said.msg} [his answer to ${movedFrom}, which ${commitCode} replaced]`, body: `${said.body}\n\n${movedFrom} was replaced by ${commitCode} before this answer was written; the answer lands on ${commitCode}.` } : said;
    const w = await commitAndPush([rel], msg, body, flip);
    return reopened && w.status === "written" ? { ...w, reopened } : w;
  }

  /**
   * the edits in one commit (see SpineWriter.edits). Each edit keeps every guard it has alone: its file inside
   * the checkout and allowed a main push, its edit function run on the text as it is now (after the edits before it),
   * and only the batch's files changed. `undefined` = the commit was refused: the caller writes them one by one.
   */
  async function attemptEdits(list: EditInput[], fetch = false): Promise<SpineWrite[] | undefined> {
    const out: (SpineWrite | undefined)[] = list.map(() => undefined);
    const skip = (i: number, reason: string) => void (out[i] = { status: "skipped", reason, ...(list[i].path ? { path: list[i].path } : {}) });
    const first = list.find((i) => i.path && inside(i.repoDir, i.path));
    if (!first) return list.map((i) => ({ status: "skipped", reason: i.path ? `${i.path} is outside the repo checkout` : "the item has no spine file to write to", ...(i.path ? { path: i.path } : {}) }));
    // fetch unless every edit accepts a checkout this fresh
    const freshMs = !fetch && list.every((i) => i.fetchFreshMs) ? Math.min(...list.map((i) => i.fetchFreshMs!)) : undefined;
    const c = await open(first, first.path, freshMs);
    if ("status" in c) return list.map((i) => ({ ...c, path: i.path }));
    const { g, ms } = c;
    const before = new Map<string, string>(); // each file's text before the batch ("" = it did not exist)
    const wrote: { i: number; msg: string; body: string }[] = [];
    const restore = async () => {
      for (const [rel, text] of before) {
        if (text) await g(["checkout", "--", rel]);
        else fs.rmSync(inside(first.repoDir, rel) ?? "", { force: true });
      }
    };
    for (const [n, o] of list.entries()) {
      const rel = o.path;
      const abs = rel ? inside(o.repoDir, rel) : undefined;
      if (!rel || !abs) {
        skip(n, rel ? `${rel} is outside the repo checkout` : "the item has no spine file to write to");
        continue;
      }
      const pol = pushPolicy(o.repoDir, rel);
      if (!pol.ok) {
        skip(n, pol.reason);
        continue;
      }
      let text = "";
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        /* a missing file is edited from "" */
      }
      let e: FileEdit;
      try {
        e = o.edit(text, o.date ?? new Date().toISOString().slice(0, 10));
      } catch (err) {
        out[n] = { status: "failed", reason: (err as Error).message, path: rel };
        continue;
      }
      if (("skip" in e || e.text === text) && !c.fetched) {
        // not fetched, and this edit is refused or already made: put the batch back, fetch, and look again
        await restore();
        return attemptEdits(list, true);
      }
      if ("skip" in e) {
        skip(n, e.skip);
        continue;
      }
      if (e.text === text) {
        out[n] = { status: "written", reason: "the file already has this change", path: rel };
        continue;
      }
      if (!before.has(rel)) before.set(rel, text);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.text);
      wrote.push({ i: n, msg: e.msg, body: e.body });
    }
    if (!wrote.length) return out.map((w, n) => w ?? { status: "skipped", reason: "nothing to write", path: list[n].path });
    const undo = restore;
    // Guard 6 for the batch: the batch's files are the only change (a status that fails is asked once more).
    let st = await g(["status", "--porcelain", "--untracked-files=all"]);
    if (!st.ok) {
      await new Promise((r) => setTimeout(r, CONTENTION_RETRY_MS));
      st = await g(["status", "--porcelain", "--untracked-files=all"]);
    }
    if (!st.ok) {
      await undo();
      const reason = `git status failed after writing ${[...before.keys()].join(", ")}: ${st.err || "no answer"}; reverted`;
      for (const w of wrote) out[w.i] = { status: "failed", reason, path: list[w.i].path };
      return out as SpineWrite[];
    }
    const changed = st.out.split("\n").filter(Boolean).map(porcelainPath);
    if (changed.some((f) => !before.has(f))) {
      // something else changed too: write each edit alone, where Guard 6 judges it on its own
      await undo();
      return undefined;
    }
    const files = [...before.keys()].filter((f) => changed.includes(f));
    for (const w of wrote.filter((x) => !files.includes(list[x.i].path))) out[w.i] = { status: "written", reason: "the file already has this change", path: list[w.i].path };
    const landing = wrote.filter((x) => files.includes(list[x.i].path));
    if (!landing.length) return out as SpineWrite[];
    const msgs = landing.map((x) => x.msg);
    const joined = msgs.join(" · ");
    // one change that touches several files (each edit the same message) is one message, not "more presses"
    const one = new Set(msgs).size === 1 && new Set(landing.map((x) => x.body)).size === 1;
    const msg = landing.length === 1 || one ? msgs[0] : joined.length <= 200 ? joined : `${msgs[0]} and ${landing.length - 1} more presses (via console)`;
    const body =
      landing.length === 1 || one
        ? landing[0].body
        : `${landing.length} console writes in one commit:\n\n${landing.map((x) => `${x.msg}\n${x.body}`).join("\n\n")}`;
    const press = landing.every((x) => list[x.i].group);
    const verify = landing.some((x) => list[x.i].verify !== false) ? (press && opts.pressHooks !== "full" ? "scan" : true) : false;
    ms.batch = landing.length;
    const ids = landing.map((x) => list[x.i].press).filter((x): x is string => !!x);
    const w = await commitPush(c, first.repoDir, files[0], files, msg, body, undefined, verify, press && bgOn, ids);
    if (w.status === "failed" && /^git commit failed/.test(w.reason ?? "") && landing.length > 1) return undefined;
    for (const x of landing) out[x.i] = { ...w, path: list[x.i].path };
    return out as SpineWrite[];
  }

  const run = (o: AnyInput, mode: Mode) => {
    const asked = Date.now();
    return serial(o.repoDir, async () => {
      const lock = Date.now() - asked;
      const w = await attempt(o, mode).catch((e): SpineWrite => {
        const rel = "edit" in o || "scaffold" in o ? o.path : o.target.path;
        return { status: "failed", reason: (e as Error).message, ...(rel ? { path: rel } : {}) };
      });
      if (w.status === "failed") facts.delete(o.repoDir);
      noteSteps({ lock, ...w.ms, write: Date.now() - asked });
      return w;
    });
  };
  const edits = async (list: EditInput[]): Promise<SpineWrite[]> => {
    if (list.length < 2) return Promise.all(list.map((o) => run(o, "edit")));
    const asked = Date.now();
    const dir = list[0].repoDir;
    if (list.some((o) => o.repoDir !== dir)) throw new Error("edits: every edit of one batch is in the same checkout");
    const batch = await serial(dir, async () => {
      const lock = Date.now() - asked;
      const ws = await attemptEdits(list).catch((e): SpineWrite[] => list.map((o) => ({ status: "failed", reason: (e as Error).message, ...(o.path ? { path: o.path } : {}) })));
      if (!ws || ws.some((w) => w.status === "failed")) facts.delete(dir);
      noteSteps({ lock, ...ws?.find((w) => w.ms)?.ms, write: Date.now() - asked });
      return ws;
    });
    // the commit was refused, or more than the batch's files changed: each edit on its own, in order
    if (!batch) {
      const one: SpineWrite[] = [];
      for (const o of list) one.push(await run(o, "edit"));
      return one;
    }
    return batch;
  };
  const pushes: BackgroundPushes = {
    pending: () => [...pend.entries()].map(([repoDir, p]) => ({ repoDir, since: new Date(p.since).toISOString(), tries: p.tries, ...(p.lastError ? { lastError: p.lastError } : {}) })),
    active: () => [...pend.values()].filter((p) => p.running || p.tries === 0).length,
    kick: (repoDir) => schedule(repoDir),
    async drain(ms) {
      const until = Date.now() + ms;
      for (const [dir, p] of pend) if (p.timer && !p.running) schedule(dir);
      while (pend.size && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      return pend.size === 0;
    },
  };
  return { answer: (o) => run(o, "answer"), change: (o) => run(o, "change"), revert: (o) => run(o, "revert"), edit: (o) => run(o, "edit"), scaffold: (o) => run(o, "scaffold"), edits, pushes };
}

/**
 * the steps of every spine write a request makes (lock wait, guards,
 * fetch, commit, push, the whole write), summed, so a route can send them as `Server-Timing` and the press log keeps them
 * per try: where a press's seconds go. `timeWrites` opens the tally for one request.
 */
// tallies nest (the press worker's around the review route's); a step counts in every open one, so the worker's own
// tally has it even when the route's Server-Timing header is lost on the way back (production's world filter rebuilds the
// response, and @hono/node-server's response drops a header set on it after it was made).
interface Tally {
  steps: Record<string, number>;
  up?: Tally;
}
const writeSteps = new AsyncLocalStorage<Tally>();
function noteSteps(ms: Record<string, number | undefined>) {
  for (let t = writeSteps.getStore(); t; t = t.up)
    for (const [k, v] of Object.entries(ms)) if (typeof v === "number") t.steps[k] = (t.steps[k] ?? 0) + v;
}
export async function timeWrites<T>(fn: () => Promise<T>): Promise<{ out: T; steps: Record<string, number> }> {
  const steps: Record<string, number> = {};
  const out = await writeSteps.run({ steps, up: writeSteps.getStore() }, fn);
  return { out, steps };
}
/** add a write's steps to the current request's tally (groupWrite.ts: each press of a batch gets its own). */
export const noteWriteSteps = (ms: Record<string, number | undefined>) => noteSteps(ms);
/** run `fn` outside any request's tally (a batch written for several requests is tallied per request). */
export const outsideTally = <T>(fn: () => T): T => writeSteps.exit(fn);
export const serverTimingOf = (steps: Record<string, number>) => Object.entries(steps).map(([k, v]) => `${k};dur=${v}`).join(", ");
