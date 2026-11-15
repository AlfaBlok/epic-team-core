import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import type { DB } from "../db.js";
import type { SpineWriter } from "../inbox/spineWrite.js";

/**
 * The owner on the Team desk 2026-11-13 20:57Z: "I want them to report EACH TIME they ask me to do something,
 * what it was, why only I could do it. Eventially we'll try to go to zero."
 *
 * Every time an agent asks him to act (a coded ask: do, provide, approve, decide; a Mac ticket; a steps page) the log
 * gets one row: what was asked, why only he could (the ask's `why <owner>:`), how many tries and how many minutes from
 * asked to his first press to done, his verdict (clear or confusing: one tap on the card, or read from his own words)
 * and the ask gate's dry-run verdict (docs/asks/dry-runs.json, read only: that gate is never duplicated here).
 *
 * The repo is the record (root L-45): `docs/asks/log.jsonl` of the home repo, one JSON event a line, appended by the
 * console's spine writer. The sweep (every 10 min) rebuilds the events from what the console already knows (the inbox
 * list, the answers table, the steps pages and their ticks) and appends only the new ones, so it is idempotent and a
 * backfill is the same sweep from an earlier day. `GET /api/asks/log` folds the events into rows and weekly counts.
 */
export const ASK_LOG_FILE = "docs/asks/log.jsonl";
export const DRY_RUN_FILE = "docs/asks/dry-runs.json";
/** where the log page is served: `{"page": "<url>"}` in the home repo (the repo is the record, never an address in code). */
export const ASK_PAGE_FILE = "docs/asks/page.json";
/** the first day the log covers: Monday of the week the owner asked for it, so that week's count is whole. */
export const ASK_LOG_FROM = "2026-11-09";

export type AskEntryKind = "ask" | "mac" | "steps";
export type AskVerdict = "clear" | "confusing";

export interface AskEvent {
  ev: "open" | "try" | "close" | "verdict" | "dryrun";
  /** the ask code (E907-A3), the Mac ticket's row (E907-S3) or `steps:<page id>`. */
  id: string;
  /** ISO UTC. */
  at: string;
  kind?: AskEntryKind;
  /** the ask's kind: do, provide, approve, decide. */
  ask?: string;
  what?: string;
  why?: string;
  row?: string;
  repo?: string;
  link?: string;
  /** open: the Mac tickets an ask carried (its ticks are tries on the ask). */
  tickets?: string[];
  /** try: answer, approve, deny, feedback, done, stuck; close: done, answered, superseded. */
  how?: string;
  words?: string;
  verdict?: AskVerdict | "pass" | "fail";
  /** verdict: `tap` (his one tap on the card) or `words` (read from his own words). */
  by?: "tap" | "words";
  reason?: string;
  src?: "console" | "backfill";
}

/** what the sweep reads: the inbox list (GET /waiting-on-owner?includeSettled=1), answers, steps pages and their ticks. */
export interface WaitingLike {
  code?: string;
  source?: string;
  ask?: string;
  state?: string;
  since?: string;
  doneAt?: string;
  row?: string;
  repo?: string;
  whyYou?: string;
  question?: string;
}
export interface ResponseRow {
  created_at: string;
  kind: string;
  text: string | null;
  item: string;
}
export interface PageRow {
  id: string;
  title: string;
  url: string;
  created_at: string;
}
export interface ChangeRow {
  page_id: string;
  step: string;
  state: string;
  words: string | null;
  row_ref: string | null;
  ask_ref: string | null;
  created_at: string;
}
export interface DryRunLike {
  code?: string;
  verdict: "pass" | "fail";
  reason?: string;
  at?: string;
}
export interface SweepInput {
  asks: WaitingLike[];
  responses: ResponseRow[];
  pages: PageRow[];
  changes: ChangeRow[];
  dryRuns: DryRunLike[];
  from?: string;
  now?: string;
}

const MAC = /\/t\/([A-Za-z0-9-]+)\/?/;
const TEST = /^TEST\b|^TEST-/i;
/** a test ask: its words open with TEST or it lives in a test world (a repo named like feedback-test or test-b);
 * it never reached the owner as work, so it is never counted as his. */
export const isTestAsk = (what: string | undefined, repo: string | undefined): boolean =>
  /^\W*TEST\b/.test(what ?? "") || /(?:^|[-_])test(?:[-_]|$)/i.test(repo ?? "");
const URLS = /https?:\/\/[^\s<>"')\]]+/g;
const norm = (u: string) => u.replace(/[.,;:]+$/, "").replace(/\/+$/, "");
const short = (s: string | null | undefined, n = 220) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** a day-only `since` (2026-11-13) becomes that day's noon UTC; a full time stays. */
const iso = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00.000Z`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};
/** the words of the ask without the leading link (`http://…/ : You do: …` → `You do: …`). */
export function whatOf(question: string | undefined): string {
  return short((question ?? "").replace(/^\s*(Mac page:\s*)?https?:\/\/\S+\s*:\s*/i, ""));
}

/**
 * His verdict read from his own words: only `confusing` is read (a plain yes or a key pasted says nothing about
 * clarity); `clear` comes from his tap.
 */
const CONFUSED = [
  /\bconfus/i,
  /\bdon'?t understand\b/i,
  /\bwhat exactly\b/i,
  /\bwhich (one|vault|login|browser|account)\b/i,
  /\bnot (being )?(specific|precise|clear)\b/i,
  /\bwhere (do|should|is|to)\b.*\?/i,
  /\?\?\?/,
  /\b(disgusting|terrible|frustrat)/i,
];
export function confusedWords(words: string | null | undefined): boolean {
  const w = (words ?? "").trim();
  return !!w && CONFUSED.some((r) => r.test(w));
}

/** the events the console's own records imply, from `from` on (the sweep and the backfill). */
export function eventsFrom(input: SweepInput): AskEvent[] {
  const from = input.from ?? ASK_LOG_FROM;
  const after = (at: string | undefined) => !!at && at.slice(0, 10) >= from;
  const out: AskEvent[] = [];
  // the coded asks, one entry per code (the newest inbox item of a code wins its words)
  const asks = new Map<string, WaitingLike>();
  const responses = new Map<string, { at: string; kind: string; text: string }[]>();
  const snapshots: WaitingLike[] = [];
  for (const r of input.responses) {
    let item: WaitingLike;
    try {
      item = JSON.parse(r.item) as WaitingLike;
    } catch {
      continue;
    }
    if (item.source !== "ask" || !item.code || TEST.test(item.code)) continue;
    // the item as it was answered: its precise asked time (the inbox's answered copy keeps only the day)
    snapshots.push({ ...item, state: undefined });
    const l = responses.get(item.code) ?? [];
    l.push({ at: r.created_at, kind: r.kind, text: r.text ?? "" });
    responses.set(item.code, l);
  }
  for (const a of [...input.asks, ...snapshots]) {
    if (a.source !== "ask" || !a.code || TEST.test(a.code) || /^TEST/i.test(a.repo ?? "") || isTestAsk(a.question, a.repo)) continue;
    const had = asks.get(a.code);
    if (!had) {
      asks.set(a.code, a);
      continue;
    }
    // one code, two inbox items (the line as asked and its answered copy): the first asked keeps its words and time,
    // still open if either is, and a kind or a why either one names
    const [first, other] = (iso(a.since) ?? "~") < (iso(had.since) ?? "~") ? [a, had] : [had, a];
    const ask = first.ask && first.ask !== "unknown" ? first.ask : other.ask;
    const state = a.state === "open" || had.state === "open" ? "open" : (a.state ?? had.state);
    asks.set(a.code, { ...other, ...first, ask, state, whyYou: first.whyYou ?? other.whyYou, question: other.state && !first.state ? other.question ?? first.question : first.question ?? other.question });
  }
  // an answered ask the inbox no longer lists (done and its line settled) is closed: known only from his answer's copy, its
  // state is unknown, and before this it stayed open in the log for days though he had answered it
  const listed = new Set(input.asks.map((a) => a.code).filter(Boolean));
  for (const [code, a] of asks) if (!listed.has(code) && !a.state && responses.has(code)) a.state = "answered";
  for (const a of asks.values()) if (!a.ask || a.ask === "unknown") a.ask = /\bYou (do|decide|provide|approve)\b/i.exec(a.question ?? "")?.[1]?.toLowerCase() ?? a.ask;
  // a Mac ticket or steps page an ask links to is that ask: its ticks are tries on it, never a second entry
  const askOfUrl = new Map<string, string>();
  // only an ask's own link (its first) makes a page its: an umbrella ask listing every Mac page claims none of them
  for (const [code, a] of asks) {
    const u = (a.question ?? "").match(URLS)?.[0];
    if (u && !askOfUrl.has(norm(u))) askOfUrl.set(norm(u), code);
  }
  const ticks = new Map<string, ChangeRow[]>();
  for (const c of input.changes) {
    const l = ticks.get(c.page_id) ?? [];
    l.push(c);
    ticks.set(c.page_id, l);
  }
  const pageTries = new Map<string, { at: string; how: string; words: string; his: boolean }[]>();
  const pageEntries: { id: string; page: PageRow; mac?: string }[] = [];
  const ticketsOf = new Map<string, Set<string>>();
  for (const p of input.pages) {
    if (TEST.test(p.title)) continue;
    const mac = MAC.exec(p.url)?.[1];
    if (mac && TEST.test(mac)) continue;
    const list = (ticks.get(p.id) ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    const ask = list.find((c) => c.ask_ref && asks.has(c.ask_ref))?.ask_ref ?? askOfUrl.get(norm(p.url)) ?? (mac && asks.has(mac) ? mac : undefined);
    const id = ask ?? (mac ? mac : `steps:${p.id}`);
    const tries = list.filter((c) => c.state === "done" || c.state === "stuck").map((c) => ({ at: c.created_at, how: c.state, words: short(c.words, 300), his: !mac }));
    pageTries.set(id, [...(pageTries.get(id) ?? []), ...tries]);
    if (ask && mac && mac !== ask) ticketsOf.set(ask, (ticketsOf.get(ask) ?? new Set<string>()).add(mac));
    // a steps page with no ask and no tick is an evidence or feedback page, not an ask to act: it enters the log once
    // he acts on it; a Mac ticket is always an ask
    if (!ask && (mac || tries.length) && (after(p.created_at) || tries.some((t) => after(t.at)))) pageEntries.push({ id, page: p, ...(mac ? { mac } : {}) });
  }

  for (const [code, a] of asks) {
    const res = (responses.get(code) ?? []).sort((x, y) => x.at.localeCompare(y.at));
    const pt = pageTries.get(code) ?? [];
    const firstPress = [res[0]?.at, pt[0]?.at].filter((x): x is string => !!x).sort()[0];
    const since = iso(a.since);
    // a day-only time (noon) never comes after his first press
    const opened = since && firstPress && since > firstPress ? firstPress : (since ?? firstPress);
    if (!opened) continue;
    if (!after(opened) && !res.some((r) => after(r.at)) && !pt.some((t) => after(t.at))) continue;
    const link = (a.question ?? "").match(URLS)?.[0];
    out.push({ ev: "open", id: code, at: opened, kind: "ask", ...(a.ask && a.ask !== "unknown" ? { ask: a.ask } : {}), what: whatOf(a.question), ...(a.whyYou ? { why: short(a.whyYou, 300) } : {}), ...(a.row && a.row !== "none" ? { row: a.row } : {}), ...(a.repo ? { repo: a.repo } : {}), ...(link ? { link: norm(link) } : {}), ...(ticketsOf.has(code) ? { tickets: [...ticketsOf.get(code)!].sort() } : {}) });
    for (const r of res) {
      out.push({ ev: "try", id: code, at: r.at, how: r.kind, ...(r.text ? { words: short(r.text, 300) } : {}) });
      if (confusedWords(r.text)) out.push({ ev: "verdict", id: code, at: r.at, verdict: "confusing", by: "words", words: short(r.text, 300) });
    }
    for (const t of pt) out.push({ ev: "try", id: code, at: t.at, how: t.how, ...(t.words ? { words: t.words } : {}) });
    const done = a.state === "answered" || a.state === "done" || a.state === "superseded";
    if (done) {
      const last = [...res.map((r) => r.at), ...pt.filter((t) => t.how === "done").map((t) => t.at)].sort().pop();
      const at = last ?? iso(a.doneAt) ?? input.now ?? new Date().toISOString();
      out.push({ ev: "close", id: code, at, how: a.state });
    }
  }
  for (const e of pageEntries) {
    const pt = (pageTries.get(e.id) ?? []).sort((x, y) => x.at.localeCompare(y.at));
    out.push({ ev: "open", id: e.id, at: new Date(Date.parse(e.page.created_at)).toISOString(), kind: e.mac ? "mac" : "steps", what: short(e.page.title.replace(/^Laptop ticket [A-Za-z0-9-]+:\s*/, "")), ...(e.mac ? { row: e.mac } : {}), link: norm(e.page.url) });
    for (const t of pt) {
      out.push({ ev: "try", id: e.id, at: t.at, how: t.how, ...(t.words ? { words: t.words } : {}) });
      if (t.his && confusedWords(t.words)) out.push({ ev: "verdict", id: e.id, at: t.at, verdict: "confusing", by: "words", words: t.words });
    }
    const last = pt[pt.length - 1];
    if (last?.how === "done") out.push({ ev: "close", id: e.id, at: last.at, how: "done" });
  }
  const opened = new Set(out.filter((e) => e.ev === "open").map((e) => e.id));
  for (const d of input.dryRuns) {
    if (!d.code || !opened.has(d.code)) continue;
    out.push({ ev: "dryrun", id: d.code, at: iso(d.at) ?? input.now ?? new Date().toISOString(), verdict: d.verdict, ...(d.reason ? { reason: short(d.reason, 300) } : {}) });
  }
  return out;
}

/**
 * A coded ask the log holds open that the inbox list (open and settled lines) no longer has at all: its line was settled
 * by a persona (withdrawn, done, dropped) with no press of his, so no answer copy closes it. Closed `settled` at `now`.
 * Only when the inbox still lists other asks of its repo, so a world that could not be read never closes its asks.
 * A Mac ticket the Mac list no longer has (macOpen: its open, done and held rows; undefined = the list was not read) is
 * closed the same way: its row was closed without a Done on its page.
 */
export function settledEvents(logged: AskEvent[], asks: WaitingLike[], now: string, macOpen?: Set<string>): AskEvent[] {
  const listed = new Set(asks.map((a) => a.code).filter(Boolean));
  const repos = new Set(asks.map((a) => a.repo).filter(Boolean));
  const closed = new Set(logged.filter((e) => e.ev === "close").map((e) => e.id));
  const out: AskEvent[] = [];
  for (const e of logged) {
    if (e.ev !== "open" || closed.has(e.id)) continue;
    // a Mac ticket is open while the Mac list has it (open, done on its card but not yet off the list, or held); off the
    // list, its row was closed (done, folded, fed): only when the list was read (macOpen given)
    const mac = e.kind === "mac" && macOpen !== undefined && !macOpen.has(e.id);
    const ask = (e.kind ?? "ask") === "ask" && !listed.has(e.id) && !!e.repo && repos.has(e.repo);
    if (!mac && !ask) continue;
    closed.add(e.id);
    out.push({ ev: "close", id: e.id, at: now, how: "settled" });
  }
  return out;
}

/** an event's identity in the file: one open and one close per entry, each press once, each dry-run verdict once. */
export function keyOf(e: AskEvent): string {
  if (e.ev === "open" || e.ev === "close") return `${e.ev}\0${e.id}`;
  if (e.ev === "dryrun") return `${e.ev}\0${e.id}\0${e.verdict}\0${e.reason ?? ""}`;
  if (e.ev === "verdict") return `${e.ev}\0${e.id}\0${e.by}\0${e.at}`;
  return `${e.ev}\0${e.id}\0${e.at}\0${e.how ?? ""}`;
}

export function parseEvents(text: string): AskEvent[] {
  const out: AskEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as AskEvent;
      if (e && typeof e.ev === "string" && typeof e.id === "string" && typeof e.at === "string") out.push(e);
    } catch {
      /* a broken line is skipped, never the file */
    }
  }
  return out;
}

export function appendEvents(text: string, list: AskEvent[]): { text: string; added: AskEvent[] } {
  const have = new Set(parseEvents(text).map(keyOf));
  const added = list.filter((e) => {
    const k = keyOf(e);
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  if (!added.length) return { text, added };
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return { text: base + added.map((e) => JSON.stringify(e)).join("\n") + "\n", added };
}

export interface AskRow {
  id: string;
  kind: AskEntryKind;
  ask?: string;
  what: string;
  why?: string;
  row?: string;
  repo?: string;
  link?: string;
  tickets?: string[];
  askedAt: string;
  firstPressAt?: string;
  doneAt?: string;
  state: "open" | "done";
  closedHow?: string;
  tries: number;
  stuck: number;
  minToFirstPress?: number;
  minToDone?: number;
  verdict?: AskVerdict;
  verdictBy?: "tap" | "words";
  verdictWords?: string;
  dryRun?: { verdict: "pass" | "fail"; reason?: string; at: string };
  presses: { at: string; how: string; words?: string }[];
}

/** Monday (UTC) of the week `at` falls in, as YYYY-MM-DD. */
export function weekOf(at: string): string {
  const d = new Date(Date.parse(at));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

const minutes = (a: string, b: string | undefined) => (b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000)) : undefined);

export function fold(events: AskEvent[], now = new Date().toISOString(), from = ASK_LOG_FROM) {
  const rows = new Map<string, AskRow>();
  const sorted = events.slice().sort((a, b) => a.at.localeCompare(b.at));
  for (const e of sorted) {
    if (e.ev !== "open" || rows.has(e.id) || isTestAsk(e.what, e.repo)) continue;
    rows.set(e.id, { id: e.id, kind: e.kind ?? "ask", ...(e.ask ? { ask: e.ask } : {}), what: e.what ?? e.id, ...(e.why ? { why: e.why } : {}), ...(e.row ? { row: e.row } : {}), ...(e.repo ? { repo: e.repo } : {}), ...(e.link ? { link: e.link } : {}), ...(e.tickets ? { tickets: e.tickets } : {}), askedAt: e.at, state: "open", tries: 0, stuck: 0, presses: [] });
  }
  for (const e of sorted) {
    const r = rows.get(e.id);
    if (!r) continue;
    if (e.ev === "try") {
      r.tries++;
      if (e.how === "stuck" || e.how === "deny" || e.how === "feedback") r.stuck++;
      r.firstPressAt ??= e.at;
      r.presses.push({ at: e.at, how: e.how ?? "press", ...(e.words ? { words: e.words } : {}) });
    } else if (e.ev === "close") {
      r.state = "done";
      r.doneAt = e.at;
      if (e.how) r.closedHow = e.how;
    } else if (e.ev === "verdict" && (e.verdict === "clear" || e.verdict === "confusing")) {
      // his tap outranks words read from his notes; the latest of a kind wins
      if (e.by === "tap" || r.verdictBy !== "tap") {
        r.verdict = e.verdict;
        r.verdictBy = e.by ?? "words";
        r.verdictWords = e.words;
      }
    } else if (e.ev === "dryrun" && (e.verdict === "pass" || e.verdict === "fail")) {
      r.dryRun = { verdict: e.verdict, ...(e.reason ? { reason: e.reason } : {}), at: e.at };
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, minToFirstPress: minutes(r.askedAt, r.firstPressAt), minToDone: minutes(r.askedAt, r.doneAt) }));
  list.sort((a, b) => b.askedAt.localeCompare(a.askedAt));
  const weeks = new Map<string, { week: string; asked: number; done: number; confusing: number; clear: number }>();
  // the log starts on `from`: an ask raised before it and still answered after it is carried in, never a week of its own
  // (a part week would read as a count going up)
  const start = weekOf(`${from}T12:00:00.000Z`);
  let carriedIn = 0;
  for (const r of list) {
    const w = weekOf(r.askedAt);
    if (w < start) {
      carriedIn++;
      continue;
    }
    const x = weeks.get(w) ?? { week: w, asked: 0, done: 0, confusing: 0, clear: 0 };
    x.asked++;
    if (r.state === "done") x.done++;
    if (r.verdict === "confusing") x.confusing++;
    if (r.verdict === "clear") x.clear++;
    weeks.set(w, x);
  }
  const thisWeek = weekOf(now);
  if (!weeks.has(thisWeek)) weeks.set(thisWeek, { week: thisWeek, asked: 0, done: 0, confusing: 0, clear: 0 });
  const byWeek = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
  return { thisWeek: { week: thisWeek, asked: weeks.get(thisWeek)!.asked }, byWeek, carriedIn, from, open: list.filter((r) => r.state === "open").length, rows: list };
}
export type AskLogView = ReturnType<typeof fold>;

export function readDryRuns(dir: string): DryRunLike[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, DRY_RUN_FILE), "utf8")) as { items?: Record<string, unknown> };
    return Object.values(j.items ?? {}).filter((x): x is DryRunLike => !!x && typeof x === "object" && ((x as DryRunLike).verdict === "pass" || (x as DryRunLike).verdict === "fail"));
  } catch {
    return [];
  }
}

/** the log page's address from the home repo's docs/asks/page.json, if any. */
export function pageOf(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, ASK_PAGE_FILE), "utf8")) as { page?: unknown };
    return typeof j.page === "string" && /^https?:\/\//.test(j.page) ? j.page : undefined;
  } catch {
    return undefined;
  }
}

export interface AskLogDeps {
  db: DB;
  /** the home repo checkout the log lives in. */
  dir: () => string | undefined;
  writer?: SpineWriter;
  /** the inbox list with settled items (GET /waiting-on-owner?includeSettled=1). */
  asks: () => Promise<WaitingLike[]>;
  /** the Mac tickets still on the Mac list (open, done, held), by row; undefined = no list or not read. */
  macOpen?: () => Promise<Set<string> | undefined>;
  wrote?: (dir: string) => void;
  now?: () => Date;
  log?: (msg: string) => void;
}

export function createAskLog(d: AskLogDeps) {
  const now = () => (d.now?.() ?? new Date()).toISOString();
  const read = (): AskEvent[] => {
    const dir = d.dir();
    if (!dir) return [];
    try {
      return parseEvents(fs.readFileSync(path.join(dir, ASK_LOG_FILE), "utf8"));
    } catch {
      return [];
    }
  };
  const tableRows = <T>(sql: string, ...args: unknown[]): T[] => {
    try {
      return d.db.prepare(sql).all(...args) as T[];
    } catch {
      return []; // a console without that table (no steps pages yet) logs the rest
    }
  };
  async function write(list: AskEvent[], label: string): Promise<{ added: number; sha?: string }> {
    const dir = d.dir();
    if (!dir || !d.writer || !list.length) return { added: 0 };
    let added: AskEvent[] = [];
    const w = await d.writer.edit({
      repoDir: dir,
      path: ASK_LOG_FILE,
      label,
      group: true,
      edit: (text) => {
        const r = appendEvents(text, list);
        added = r.added;
        if (!added.length) return { skip: "already logged" };
        const ids = [...new Set(added.map((e) => e.id))].slice(0, 8).join(", ");
        return {
          text: r.text,
          msg: `Asks log: ${added.length} event${added.length === 1 ? "" : "s"} (${ids})`,
          body: "Every time an agent asks the owner to act: what, why only him, tries and minutes, his verdict, the dry run.",
        };
      },
    });
    if (w.status === "written") d.wrote?.(dir);
    else if (!(w.status === "skipped" && w.reason === "already logged")) throw new Error(`asks log not written: ${w.status} ${w.reason ?? ""}`.trim());
    return { added: added.length, ...(w.sha ? { sha: w.sha } : {}) };
  }
  async function sweep(from = ASK_LOG_FROM): Promise<{ added: number; sha?: string }> {
    const dir = d.dir();
    if (!dir) return { added: 0 };
    const input: SweepInput = {
      from,
      now: now(),
      asks: await d.asks(),
      responses: tableRows<ResponseRow>("SELECT created_at, kind, text, item FROM jordi_responses WHERE created_at >= ? ORDER BY created_at", from),
      pages: tableRows<PageRow>("SELECT id, title, url, created_at FROM step_pages"),
      changes: tableRows<ChangeRow>("SELECT page_id, step, state, words, row_ref, ask_ref, created_at FROM step_changes ORDER BY created_at"),
      dryRuns: readDryRuns(dir),
    };
    const events = eventsFrom(input);
    const mac = await d.macOpen?.().catch(() => undefined);
    return write([...events, ...settledEvents([...read(), ...events], input.asks, input.now!, mac)], "asks log sweep");
  }
  async function verdict(id: string, v: AskVerdict, words?: string) {
    if (!read().some((e) => e.ev === "open" && e.id === id)) return { status: 404 as const };
    const r = await write([{ ev: "verdict", id, at: now(), verdict: v, by: "tap", ...(words ? { words: short(words, 300) } : {}) }], `asks log verdict ${id}`);
    return { status: 200 as const, ...r };
  }
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void sweep()
      .then((r) => r.added && d.log?.(`asks log: ${r.added} new event(s)${r.sha ? ` ${r.sha.slice(0, 9)}` : ""}`))
      .catch((e) => d.log?.(`asks log: ${e instanceof Error ? e.message : e}`))
      .finally(() => (running = false));
  };
  return {
    read,
    view: () => {
      const page = pageOf(d.dir());
      return { ...fold(read(), now()), ...(page ? { page } : {}) };
    },
    sweep,
    verdict,
    start(everyMs: number) {
      if (timer || everyMs <= 0) return;
      setTimeout(tick, 60_000).unref();
      timer = setInterval(tick, everyMs);
      timer.unref();
    },
  };
}
export type AskLog = ReturnType<typeof createAskLog>;

const verdictIn = z.object({ verdict: z.enum(["clear", "confusing"]), words: z.string().trim().max(2000).optional() }).strict();

/** GET /api/asks/log (rows and weekly counts), POST /api/asks/:id/verdict {verdict}, POST /api/asks/log/sweep. */
export function mountAskLog(api: Hono, log: () => AskLog | undefined) {
  api.get("/asks/log", (c) => {
    const l = log();
    if (!l) return c.json({ error: { code: "off", message: "the asks log is off on this console" } }, 503);
    const v = l.view();
    if (c.req.query("summary") === "1") return c.json({ thisWeek: v.thisWeek, byWeek: v.byWeek, open: v.open, ...("page" in v ? { page: v.page } : {}) });
    return c.json(v);
  });
  api.post("/asks/:id/verdict", async (c) => {
    const l = log();
    if (!l) return c.json({ error: { code: "off", message: "the asks log is off on this console" } }, 503);
    const p = verdictIn.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: { code: "validation_error", message: "verdict must be clear or confusing" } }, 400);
    try {
      const r = await l.verdict(c.req.param("id"), p.data.verdict, p.data.words);
      if (r.status === 404) return c.json({ error: { code: "not_found", message: `no ask ${c.req.param("id")} in the asks log` } }, 404);
      return c.json(r);
    } catch (e) {
      return c.json({ error: { code: "not_written", message: e instanceof Error ? e.message : String(e) } }, 409);
    }
  });
  api.post("/asks/log/sweep", async (c) => {
    const l = log();
    if (!l) return c.json({ error: { code: "off", message: "the asks log is off on this console" } }, 503);
    try {
      return c.json(await l.sweep(c.req.query("from") || undefined));
    } catch (e) {
      return c.json({ error: { code: "not_written", message: e instanceof Error ? e.message : String(e) } }, 409);
    }
  });
}
