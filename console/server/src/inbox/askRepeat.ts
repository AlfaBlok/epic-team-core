import fs from "node:fs";
import path from "node:path";
import { resolveRepo } from "../adapters/repos.js";
import { homeRepo, ownerName } from "../identity.js";

/**
 * E996-S48 (the owner, 2026-11-14, sending E996-S44 back: "We need to extract insights from it. What categories of failure,
 * count for each, and relentless examine these failures and propose fixes, clear?"). The asks page (scripts/asks_insights.py)
 * found 14 asks that repeated one he had already answered and 6 too long for one sitting. Two gate rules (9 and 10 of
 * inbox/askGate.ts, applied in inbox/waiting.ts where the answered lines and the asks log are at hand) hold them back:
 *
 *  9. an open ask whose question repeats one he already answered (same code answered earlier; same row and most of the
 *     same words; or nearly the same words on any row), against the tree's `[answered …]` lines and the home repo's
 *     docs/asks/log.jsonl: held as "already answered on <date>: <his answer>". An ask that cites the earlier one (its code,
 *     or his answer's words) is a follow-up and passes; a re-ask on the same row with a different question passes.
 * 10. an open ask that takes more than 20 minutes: its `effort:`, else the time its words name, else 3 minutes a numbered
 *     step: held as "too long for one sitting: split it".
 */
export const ASK_LOG_FILE = "docs/asks/log.jsonl";
/** over this many minutes an ask got stuck half way (E983-A7, E959-A5: asks page, "too big for one sitting"). */
export const SITTING_MIN = 20;
/** a numbered step with no time given counts this many minutes. */
export const STEP_MIN = 3;

/** an ask the owner answered: from an `[answered …]` line or the asks log. `on` is YYYY-MM-DD. */
export interface PriorAnswer {
  code?: string | null;
  repo?: string | null;
  row?: string | null;
  question: string;
  answer?: string | null;
  on: string;
  /** where it was answered (a spine line), so the line itself is never its own repeat. */
  at?: string;
  /** E907-S8: what it unblocked (row codes), and its topics (`about:` values), for the FYI rule. */
  unblocks?: string | null;
  topics?: string[];
}

export interface RepeatAsk {
  code?: string | null;
  repo?: string | null;
  row?: string | null;
  question: string;
  since?: string | null;
  contextText?: string | null;
  context?: string | null;
  why?: string | null;
  recommend?: string | null;
  steps?: string | null;
  effort?: string | null;
  at?: string;
  /** E907-S8: its `about:`, its buttons, what it unblocks and its kind, for the FYI rule. */
  about?: string | null;
  aboutAll?: string[];
  options?: string[];
  unblocks?: string | null;
  impact?: string | null;
  risk?: string | null;
}

const STOP = new Set(
  `the a an to of and or in on for is it you your we our at by with this that be as from so can do not are will its his he if when then what which who why
how about all any more each into only own same than too very just now get got make made new may must give take use one two three yes no please open page
step steps team ask asks card mac ticket claude app session paste text minutes minute once there their them they these those have has been want would
could should after before first then also here where while still`.split(/\s+/),
);

/** the content words of a question: lower case, links dropped, stop words out, 3+ letters. */
export function contentWords(s: string | null | undefined): Set<string> {
  const t = (s ?? "").toLowerCase().replace(/https?:\/\/\S+/g, " ");
  return new Set((t.match(/[a-z@][a-z0-9@.-]{2,}/g) ?? []).map((w) => w.replace(/[.-]+$/, "")).filter((w) => w.length >= 3 && !STOP.has(w)));
}

function similarity(a: Set<string>, b: Set<string>): { score: number; shared: number } {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return { score: union ? shared / union : 0, shared };
}

const sameRow = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** the earlier answer this open ask repeats, with how it matched; undefined when it is new. */
export function repeatOf(a: RepeatAsk, answered: PriorAnswer[]): { prior: PriorAnswer; how: "code" | "row" | "words" } | undefined {
  const all = [a.question, a.contextText, a.context, a.why, a.recommend, a.steps].filter(Boolean).join(" — ");
  const mine = contentWords(a.question);
  let best: { prior: PriorAnswer; how: "code" | "row" | "words"; score: number } | undefined;
  for (const p of answered) {
    if (a.at && p.at && a.at === p.at) continue;
    // answered after this ask was raised: this ask is not a repeat of it (an API ask, since undefined, is raised now).
    if (a.since && p.on && p.on > a.since) continue;
    const ownCode = !!a.code && !!p.code && a.code.toUpperCase() === p.code.toUpperCase() && (!a.repo || !p.repo || a.repo === p.repo);
    // a follow-up that cites the earlier ask (its code) or his answer's words builds on it: not a repeat.
    if (!ownCode && p.code && new RegExp(`(^|[^A-Za-z0-9-])${esc(p.code)}($|[^A-Za-z0-9])`, "i").test(all)) continue;
    if (p.answer && p.answer.trim().length >= 12 && all.toLowerCase().includes(p.answer.trim().toLowerCase().slice(0, 40))) continue;
    // the same code answered on an earlier day and open again (`p.on < since`): asked a second time.
    if (ownCode) {
      if (a.since && p.on && p.on < a.since) {
        const s = { prior: p, how: "code" as const, score: 2 };
        if (!best || s.score > best.score) best = s;
      }
      continue;
    }
    const { score, shared } = similarity(mine, contentWords(p.question));
    if (shared < 4) continue;
    const how = sameRow(a.row, p.row) && score >= 0.4 ? "row" : score >= 0.6 ? "words" : undefined;
    if (how && (!best || score > best.score)) best = { prior: p, how, score };
  }
  return best && { prior: best.prior, how: best.how };
}

/**
 * E907-S8 (the owner, 23 Nov, on E907-A4: "Didn't i answer this several times already?"). He said yes to an FYI about his
 * personal LinkedIn (E907-A3); the worker then raised a second FYI on the same topic, and rule 9 let it pass because it cited
 * E907-A3 (a follow-up). Rule 9b: an FYI (its only button "Got it", or recommend "None: FYI", or it opens "FYI") whose row,
 * what it unblocks or its `about:` topic matches an ask he answered in the last 14 days is held as "already answered on
 * <date>: <his answer>", citing the earlier ask or not. A real decision (options to choose from) on the same row passes.
 */
export const FYI_WINDOW_DAYS = 14;
/** an about that names no topic (the console's own `about: FYI`, `about: You decide`). */
const GENERIC_ABOUT = /^(?:fyi|for your information|you decide|decide|decision|a decision|approve|approval|question|update|status|news|none)$/i;
const ABOUT_IN_TEXT = /(?:^|\s)(?:—|--|-)?\s*about\s*:\s*(.+?)\s*(?=\s(?:—|--|-)\s|$)/gi;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@ ]+/g, " ").replace(/\s+/g, " ").trim();

/** the topics a text and its `about:` name, generic ones dropped, normalised. */
export function topicsIn(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    const vals = /about\s*:/i.test(t) ? [...t.matchAll(ABOUT_IN_TEXT)].map((m) => m[1]) : [];
    for (const v of vals.length ? vals : []) {
      const n = norm(v);
      if (n && !GENERIC_ABOUT.test(n)) out.add(n);
    }
  }
  return [...out];
}

/** the given about (a bare value) plus any `about:` glued into the other fields. */
function topicsOfAsk(a: RepeatAsk): string[] {
  const own = [...(a.aboutAll ?? []), ...(a.about ? [a.about] : [])].map(norm).filter((t) => t && !GENERIC_ABOUT.test(t));
  return [...new Set([...own, ...topicsIn(a.question, a.why, a.recommend, a.contextText, a.impact, a.risk, a.unblocks, a.steps)])];
}

/** an FYI: nothing to choose, only to read. */
export function isFyi(a: RepeatAsk): boolean {
  const opts = (a.options ?? []).map((o) => norm(o.split(":")[0] ?? o));
  const onlyAck = opts.length > 0 && opts.every((o) => /^(?:got it|ok|okay|noted|seen|thanks|none|fyi)$/.test(o));
  return onlyAck || /^\s*none\b[^a-z]*fyi\b/i.test(a.recommend ?? "") || /^\s*fyi\b/i.test(a.question);
}

const rowCodes = (...xs: (string | null | undefined)[]) =>
  new Set(xs.flatMap((x) => (x ?? "").toUpperCase().match(/\b(?!EPIC-)[A-Z][A-Z0-9]*-S\d+\b/g) ?? []));

function daysBefore(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) ? "" : new Date(t - n * 86_400_000).toISOString().slice(0, 10);
}

/** rule 9b: the answer an FYI repeats (same row, same unblocked row or same topic, answered in the last 14 days). */
export function fyiRepeatOf(a: RepeatAsk, answered: PriorAnswer[], today = new Date().toISOString().slice(0, 10)): { prior: PriorAnswer; how: "row" | "topic" } | undefined {
  if (!isFyi(a)) return undefined;
  const day = (a.since ?? today).slice(0, 10);
  const from = daysBefore(day, FYI_WINDOW_DAYS);
  const mine = topicsOfAsk(a);
  const myRows = rowCodes(a.row, a.unblocks);
  let best: { prior: PriorAnswer; how: "row" | "topic" } | undefined;
  for (const p of answered) {
    if (a.at && p.at && a.at === p.at) continue;
    if (a.code && p.code && a.code.toUpperCase() === p.code.toUpperCase()) continue;
    if (!p.on || p.on > day || (from && p.on < from)) continue;
    const theirs = p.topics ?? [];
    const topic = mine.some((t) => theirs.some((u) => t === u || (similarity(contentWords(t), contentWords(u)).score >= 0.75 && contentWords(t).size >= 2)));
    const pRows = rowCodes(p.row, p.unblocks);
    const row = [...myRows].some((r) => pRows.has(r));
    const how = row ? ("row" as const) : topic ? ("topic" as const) : undefined;
    // the newest answer wins
    if (how && (!best || p.on > best.prior.on)) best = { prior: p, how };
  }
  return best;
}

/** rule 9: why this open ask must not reach the owner (it repeats one he answered); undefined when it is new. */
export function repeatProblem(a: RepeatAsk, answered: PriorAnswer[]): string | undefined {
  const hit = repeatOf(a, answered);
  if (!hit) {
    const f = fyiRepeatOf(a, answered);
    if (!f) return undefined;
    const p = f.prior;
    const said = (p.answer ?? "").replace(/\s+/g, " ").trim();
    const which = p.code ? `${p.code}${p.repo ? ` in ${p.repo}` : ""}` : p.row ? `row ${p.row}` : "an earlier ask";
    return (
      `already answered on ${p.on}: ${said ? `"${short(said)}"` : "answered"} (${which}). ` +
      `An FYI on a ${f.how} he already answered stays off his inbox: record it on the row, never as a new FYI (E907-S8)`
    );
  }
  const p = hit.prior;
  const said = (p.answer ?? "").replace(/\s+/g, " ").trim();
  const which = p.code ? `${p.code}${p.repo ? ` in ${p.repo}` : ""}` : p.row ? `row ${p.row}` : "an earlier ask";
  return (
    `already answered on ${p.on}: ${said ? `"${short(said)}"` : "answered"} (${which}). ` +
    `Act on that answer; ask again only with what is new, citing ${p.code ?? "his answer"} (E996-S48)`
  );
}

const UNIT = String.raw`(\d+(?:\.\d+)?)\s*(?:(?:to|–|-)\s*(\d+(?:\.\d+)?)\s*)?(h(?:ours?|rs?)?|min(?:utes?|s)?)\b|\b(?:an?|one)\s+hour\b|\bhalf\s+an\s+hour\b`;
/** any duration (the `effort:` field is only a duration). */
const DURATION = new RegExp(UNIT, "gi");
/** a duration the ask's words give as its own length ("about 30 minutes", "~45 min", "takes an hour"), never "within 24 hours". */
const SAID_DURATION = new RegExp(String.raw`(?:\babout|\baround|\broughly|~|\btakes?|\bneeds?)\s*(?:${UNIT})`, "gi");

function largest(text: string | null | undefined, re: RegExp): number | undefined {
  let best: number | undefined;
  for (const m of (text ?? "").matchAll(re)) {
    const whole = m[0].toLowerCase();
    let n: number;
    if (/half\s+an\s+hour/.test(whole)) n = 30;
    else if (!m[1]) n = 60;
    else n = Number(m[2] ?? m[1]) * (m[3].toLowerCase().startsWith("h") ? 60 : 1);
    best = Math.max(best ?? 0, n);
  }
  return best;
}

/** the largest duration a text names, in minutes, or undefined (`said`: only the ask's own length, "about 30 minutes"). */
export function minutesIn(text: string | null | undefined, said = false): number | undefined {
  return largest(text, said ? SAID_DURATION : DURATION);
}

/** the numbered steps an ask lists (`1) … 2) …`, `1. … 2. …`, `step 3`): the longest run 1, 2, … n present. */
export function stepCount(text: string | null | undefined): number {
  const seen = new Set<number>();
  for (const m of (text ?? "").matchAll(/(?:^|[\s(;:—])(\d{1,2})[).](?=\s)|\bstep\s+(\d{1,2})\b/gi)) seen.add(Number(m[1] ?? m[2]));
  let n = 0;
  while (seen.has(n + 1)) n++;
  return n;
}

/** how long the ask says it takes, and from what: its `effort:`, the time its words name, or its steps. */
export function askMinutes(a: RepeatAsk): { minutes: number; from: string } | undefined {
  const e = minutesIn(a.effort);
  if (e !== undefined) return { minutes: e, from: `its effort says ${a.effort!.trim()}` };
  const t = minutesIn([a.question, a.contextText, a.why, a.recommend, a.steps].filter(Boolean).join(" — "), true);
  if (t !== undefined) return { minutes: t, from: `it says about ${t} minutes` };
  const n = stepCount(a.steps);
  if (n) return { minutes: n * STEP_MIN, from: `${n} steps, about ${n * STEP_MIN} minutes` };
  return undefined;
}

/** rule 10: why this open ask is too long for one sitting; undefined when it fits. */
export function sizeProblem(a: RepeatAsk): string | undefined {
  const m = askMinutes(a);
  if (!m || m.minutes <= SITTING_MIN) return undefined;
  return (
    `too long for one sitting: split it (${m.from}, over ${SITTING_MIN} minutes). ` +
    `Send ${ownerName()} only the step that blocks now, the rest after (E996-S48)`
  );
}

interface LogEv {
  ev: string;
  id: string;
  at: string;
  how?: string;
  what?: string;
  row?: string;
  repo?: string;
  words?: string;
  why?: string;
}

/** the asks the owner answered, folded from the asks log (one line per event, scripts/ask_log + askLog.ts). */
export function parseAskLog(text: string): PriorAnswer[] {
  const opened = new Map<string, LogEv>();
  const answer = new Map<string, string>();
  const out: PriorAnswer[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: LogEv;
    try {
      e = JSON.parse(line) as LogEv;
    } catch {
      continue;
    }
    if (!e?.id) continue;
    if (e.ev === "open") opened.set(e.id, e);
    else if (e.ev === "try") {
      // his answer: his words, else what he pressed; a stuck or feedback note is not an answer.
      if (e.how === "stuck" || e.how === "feedback") continue;
      const said = e.words ?? (e.how === "approve" ? "approved" : e.how === "deny" ? "no" : e.how === "done" ? "done" : undefined);
      if (said) answer.set(e.id, said);
    } else if (e.ev === "close" && (e.how === "done" || e.how === "answered")) {
      const o = opened.get(e.id);
      if (!o?.what) continue;
      const topics = topicsIn(o.what, o.why);
      out.push({ code: e.id, repo: o.repo ?? null, row: o.row ?? null, question: o.what, answer: answer.get(e.id) ?? null, on: (e.at ?? "").slice(0, 10), ...(topics.length ? { topics } : {}) });
    }
  }
  return out;
}

/** The home repo's asks log, folded, read again when the file changes (like askDryRun.ts). */
export function createAskLogReader(o: { reposRoot: string; home?: string }) {
  let cached: { file: string; mtime: number; list: PriorAnswer[] } | null = null;
  const read = (): PriorAnswer[] => {
    const dir = resolveRepo(o.reposRoot, o.home ?? homeRepo())?.path;
    if (!dir) return [];
    const file = path.join(dir, ASK_LOG_FILE);
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return [];
    }
    if (cached && cached.file === file && cached.mtime === mtime) return cached.list;
    try {
      cached = { file, mtime, list: parseAskLog(fs.readFileSync(file, "utf8")) };
    } catch {
      return cached?.list ?? [];
    }
    return cached.list;
  };
  return Object.assign(read, { stamp: (): number => (read(), cached?.mtime ?? 0) });
}
