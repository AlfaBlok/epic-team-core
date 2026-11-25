import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentWords } from "./askRepeat.js";
import { anthropicJson } from "../textModel.js";

/**
 * E948-S206 (started by the owner when he closed E948-S139): two cards that ask him the same thing in different words are
 * one question too. The word rule (duplicate.ts sameQuestion: 4 words and 60% shared) caught none of the 9 real repeats
 * he called out in the asks log (E996-S44's "asked before" list): they share 1 to 8 words. So a meaning check judges
 * each close pair with the console's small text model (Claude Haiku, its own key) and keeps the verdict:
 *
 *   card A ─┐  share a word, same repo  ┌─▶ same, sure (≥ MEANING_SURE)   → merged like the word rule: the newer waits for its owner to fold it
 *           ├──────────────────────────▶├─▶ same, not sure (≥ MEANING_BORDER) → borderline: shown to him as before, listed for the daily read
 *   card B ─┘                           └─▶ different                     → both reach him
 *
 * The inbox list is built in a worker thread, so nothing here is held in memory alone: the verdicts are one file
 * (CONSOLE_SAME_MEANING_FILE), read by every thread; a builder that meets a pair not yet judged adds it to the wanted
 * file, and the main thread judges the wanted pairs once a minute (startSameMeaningJudge). A pair is judged once.
 * The file is a cache: the daily tap read (scripts/duplicate_taps.py) copies the borderline pairs into the repo.
 */

/** the bars, set from his labeled repeats (docs/inbox/same-meaning-eval.json): sure merges, borderline is listed. */
export const MEANING_SURE = 85;
export const MEANING_BORDER = 50;
/** at most this many earlier cards are judged against one card: the ones sharing the most words. */
export const MEANING_TOP = 6;
/**
 * E948-S206 round 3 (the owner, 25 Nov 18:13Z, vn_e4dbcbce: "there were two cards on the same subject waiting for me, and
 * one was stale ... We didn't detect that the two tickets were about the same subject"): E995-S2 (a tracker whose page
 * also showed our answers on the credit forms) and E995-S22 (the same forms prepared, every field answered) waited at once.
 * Their faces shared no content word ("was"/"were", "recommends"/"recommend"), so the pair never reached the judge, and
 * the judge, asked "the one thing each card is about", called them different anyway (a tracker, a prep: 92 to 97 sure).
 * Cards of ONE epic waiting together are judged as a group on a sharper question, no word gate: does what one asks him
 * to judge overlap the other (his answer on one would change or outdate the other)? Their own prompt, cache key and bar,
 * set on this pair and the open cards of the day (docs/inbox/same-subject-eval.json): overlap at EPIC_SURE or more holds
 * the older card for its owner to fold into the newer one, so he only ever sees the latest.
 */
export const EPIC_SURE = 60;

export interface MeaningVerdict {
  /** `epic`: judged on the one-epic overlap question (EPIC_JUDGE_SYSTEM, bar EPIC_SURE). */
  kind?: "epic";
  same: boolean;
  confidence: number;
  /** when judged (ISO) */
  at: string;
  a?: string;
  b?: string;
  refA?: string;
  refB?: string;
}
export type MeaningCall = "same" | "border" | "different";

export const sameMeaningFile = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CONSOLE_SAME_MEANING_FILE || path.join(os.homedir(), ".local", "state", "agent-team-console", "same-meaning.json");
/** off by CONSOLE_SAME_MEANING=off, and under tests unless a test names its own file. */
const off = (env: NodeJS.ProcessEnv = process.env) => env.CONSOLE_SAME_MEANING === "off" || (!!env.VITEST && !env.CONSOLE_SAME_MEANING_FILE);
const wantedFile = (f: string) => f.replace(/\.json$/, "") + ".wanted.jsonl";

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
const h = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
/** the judge's prompt version: a new prompt judges every pair afresh. */
export const JUDGE_VERSION = 3;
/** one key per pair, the same either way round. */
export const pairKey = (a: string, b: string): string => `v${JUDGE_VERSION}:${[h(norm(a)), h(norm(b))].sort().join(":")}`;
/** the epic judge's prompt version and its own key space (`e<version>:`), so a pair of one epic is judged on its own question. */
export const EPIC_JUDGE_VERSION = 1;
export const epicPairKey = (a: string, b: string): string => `e${EPIC_JUDGE_VERSION}:${[h(norm(a)), h(norm(b))].sort().join(":")}`;
/** a key's judge: `epic` for the one-epic overlap question, else the cross-card meaning one. */
export const kindOfKey = (key: string): "epic" | "meaning" => (key.startsWith("e") ? "epic" : "meaning");

let cache: { file: string; mtime: number; checked: number; verdicts: Record<string, MeaningVerdict> } | undefined;
function verdicts(file = sameMeaningFile()): Record<string, MeaningVerdict> {
  // a list build asks thousands of times: look at the file at most once a second
  if (cache && cache.file === file && Date.now() - cache.checked < 1000) return cache.verdicts;
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (cache && cache.file === file && cache.mtime === mtime) {
    cache.checked = Date.now();
    return cache.verdicts;
  }
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as { verdicts?: Record<string, MeaningVerdict> };
    cache = { file, mtime, checked: Date.now(), verdicts: v.verdicts ?? {} };
  } catch {
    cache = { file, mtime, checked: Date.now(), verdicts: cache?.file === file ? cache.verdicts : {} };
  }
  return cache.verdicts;
}

/** the call on a judged verdict. */
export const callOf = (v: Pick<MeaningVerdict, "same" | "confidence">): MeaningCall =>
  v.same && v.confidence >= MEANING_SURE ? "same" : v.same && v.confidence >= MEANING_BORDER ? "border" : "different";

const asked = new Set<string>();
let pending: { file: string; lines: string[] } | undefined;
/** the queued lines, written in one append (a list build meets many pairs at once). */
export function flushWanted(): void {
  const p = pending;
  pending = undefined;
  if (!p?.lines.length) return;
  try {
    fs.mkdirSync(path.dirname(p.file), { recursive: true });
    // the queue is re-filled after each restart: past 4 MB it waits for the judge to catch up
    if ((fs.statSync(wantedFile(p.file), { throwIfNoEntry: false })?.size ?? 0) > 4_000_000) return;
    fs.appendFileSync(wantedFile(p.file), p.lines.join("\n") + "\n");
  } catch {
    /* no state dir: the word rule alone holds */
  }
}
/** a pair not yet judged: queued for the main thread's next judging (once per process). */
function want(key: string, a: string, b: string, refA?: string, refB?: string, file = sameMeaningFile()): void {
  // (the key says which judge: epic pairs carry `e<version>:`)
  if (asked.has(key) || off()) return;
  asked.add(key);
  if (pending && pending.file !== file) flushWanted();
  if (!pending) {
    pending = { file, lines: [] };
    setImmediate(flushWanted);
  }
  pending.lines.push(JSON.stringify({ key, a: norm(a), b: norm(b), refA, refB }));
}

/** do two cards ask the same thing? undefined while the pair waits to be judged (then it is queued). */
export function meaningCall(a: string | null | undefined, b: string | null | undefined, refs: { a?: string; b?: string } = {}): MeaningCall | undefined {
  if (!a?.trim() || !b?.trim() || off()) return undefined;
  const key = pairKey(a, b);
  const v = verdicts()[key];
  if (v) return callOf(v);
  want(key, a, b, refs.a, refs.b);
  return undefined;
}

/**
 * E948-S206 round 3: do two open cards of ONE epic overlap (the same work for him to judge)? Every pair of the epic is
 * judged, no word gate; undefined while the pair waits to be judged (then it is queued for the epic judge).
 */
export function epicCall(a: string | null | undefined, b: string | null | undefined, refs: { a?: string; b?: string } = {}): MeaningCall | undefined {
  if (!a?.trim() || !b?.trim() || off()) return undefined;
  const key = epicPairKey(a, b);
  const v = verdicts()[key];
  if (v) return epicCallOf(v);
  want(key, a, b, refs.a, refs.b);
  return undefined;
}
/** the call on an epic verdict: overlap at EPIC_SURE or more is the same subject. */
export const epicCallOf = (v: Pick<MeaningVerdict, "same" | "confidence">): MeaningCall => (v.same && v.confidence >= EPIC_SURE ? "same" : v.same ? "border" : "different");

/** content words, kept per text: a list build compares the same texts many times. */
const wordsMemo = new Map<string, Set<string>>();
function words(s: string | null | undefined): Set<string> {
  const k = s ?? "";
  let w = wordsMemo.get(k);
  if (!w) {
    if (wordsMemo.size > 20_000) wordsMemo.clear();
    w = contentWords(k);
    wordsMemo.set(k, w);
  }
  return w;
}

/** worth judging: they share at least one content word (a pair with nothing in common is never the same ask). */
export function closeEnough(a: string | null | undefined, b: string | null | undefined): number {
  const x = words(a);
  const y = words(b);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const union = x.size + y.size - shared;
  return shared >= 1 && union ? shared / union : 0;
}

/** the earlier cards worth judging against one: sharing a word, the MEANING_TOP closest first. */
export function nearest<T>(text: string, cands: T[], textOf: (c: T) => string | null | undefined, top = MEANING_TOP): T[] {
  return cands
    .map((c) => ({ c, s: closeEnough(text, textOf(c)) }))
    .filter((x) => x.s > 0)
    .sort((p, q) => q.s - p.s)
    .slice(0, top)
    .map((x) => x.c);
}

/** the hold's words when the earlier card is the same question in other words. */
export const sameMeaningProblem = (ref: string, since?: string | null): string =>
  `it asks the same as ${ref} in other words, still open${since ? ` since ${since.slice(0, 10)}` : ""}: one question, one card. Fold it into ${ref} with the owner's words from both, tell the owners of both rows, then drop this one. If it asks something else, name ${ref.replace(/'s card$/, "")} in it and say how it differs`;

/** a card that names the earlier one builds on it (a follow-up): never merged by meaning. */
export const citesRef = (text: string | null | undefined, ref: string | null | undefined): boolean =>
  !!ref && !!text && new RegExp(`(^|[^A-Za-z0-9-])${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`, "i").test(text);

/** E948-S206 round 3: the question for two cards of one epic, on what each puts in front of him (title, delivered, look, decision). */
export const EPIC_JUDGE_SYSTEM =
  "You check pairs of cards from ONE project that wait for one busy owner at the same time. Each card shows work the team delivered and asks him to judge it.\n" +
  "For each pair, first write in thing_a and thing_b the concrete things each card puts in front of him to judge (the documents, forms, answers, page, plan, feature, number or decision), not its title: " +
  "a title can name an older part of the work, so read what was delivered and what he is asked.\n" +
  "same = true when the two cards overlap: some of what one asks him to judge is also on the other (the same forms or answers, the same page, the same plan, the same decision), even when one card also " +
  "has other parts (a tracker, research, counts) or the wording differs. Then his answer or feedback on one changes or outdates the other, and he would answer the same thing twice. " +
  "Example: card A \"a tracker of our credit applications; one page with the questions the forms ask and our answers\" and card B \"the startup forms prepared, every field answered, for you to send\" " +
  "overlap: both ask him to judge our answers on the same credit forms.\n" +
  "same = false when nothing he judges on one is on the other: another feature, fix, page, plan, use of money or decision, even on the same topic or goal, so that answering one leaves the other fully open.\n" +
  "confidence is how sure you are of your call, 0 to 100.";

// ---- the judge (main thread) -------------------------------------------------------------------------------------

export interface JudgePair {
  a: string;
  b: string;
}
export type PairJudge = (pairs: JudgePair[]) => Promise<{ same: boolean; confidence: number }[]>;

export const JUDGE_SYSTEM =
  "You check pairs of cards sent to one busy owner. When a card comes back to him he taps \"Duplicate or already answered\".\n" +
  "For each pair, first write in thing_a and thing_b the one thing each card is about, in a few words: the exact account, sign-in, key, " +
  "payment, plan, document, message or decision (with its name). Then decide.\n" +
  "It is a repeat (same = true) when it is the same thing on both cards, even when the wording, the reason given, the urgency or the " +
  "small step named differs (a reminder, a renewal, a retry, a new reason, one part of the same ask), or when his answer to one already settles the other.\n" +
  "It is not a repeat (same = false) when the thing differs, even with the same person, site, product or topic: another account, " +
  "another server, another document, another message, another amount, or a new choice his answer to the other does not settle.\n" +
  "confidence is how sure you are of your call, 0 to 100.";

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pair", "thing_a", "thing_b", "same", "confidence"],
        properties: { pair: { type: "integer" }, thing_a: { type: "string" }, thing_b: { type: "string" }, same: { type: "boolean" }, confidence: { type: "integer" } },
      },
    },
  },
};

/** Claude Haiku on the console's credit key: up to 15 pairs a call, strict JSON. */
export function anthropicPairJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch, onCost?: (usd: number) => void, system = JUDGE_SYSTEM): PairJudge {
  return async (pairs) => {
    const out: { same: boolean; confidence: number }[] = [];
    for (let i = 0; i < pairs.length; i += 15) {
      const chunk = pairs.slice(i, i + 15);
      const user = chunk.map((p, n) => `Pair ${n}\nA: ${p.a.slice(0, 700)}\nB: ${p.b.slice(0, 700)}`).join("\n\n");
      const { value, costUsd } = await anthropicJson<{ verdicts: { pair: number; same: boolean; confidence: number }[] }>(key, f, {
        system,
        user,
        schema: JUDGE_SCHEMA,
        maxTokens: 8000,
        timeoutMs: 120_000,
        effort: "medium",
      });
      onCost?.(costUsd);
      const by = new Map(value.verdicts.map((v) => [v.pair, v]));
      for (let n = 0; n < chunk.length; n++) {
        const v = by.get(n);
        out.push(v ? { same: !!v.same, confidence: Math.max(0, Math.min(100, Math.round(v.confidence))) } : { same: false, confidence: 0 });
      }
    }
    return out;
  };
}

function writeVerdicts(file: string, all: Record<string, MeaningVerdict>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ row: "E948-S206", about: "meaning verdicts on pairs of the owner's cards (a cache; borderline pairs are copied into the repo daily)", verdicts: all }));
  fs.renameSync(tmp, file);
  cache = undefined;
}

/** judge pairs now (the route and the wanted queue): known ones from the file, the rest by the judge, all kept. */
export async function judgePairs(
  judge: PairJudge,
  pairs: (JudgePair & { refA?: string; refB?: string })[],
  file = sameMeaningFile(),
  kind: "meaning" | "epic" = "meaning",
): Promise<(MeaningVerdict & { key: string; call: MeaningCall })[]> {
  const keyOf = kind === "epic" ? epicPairKey : pairKey;
  const callOfKind = kind === "epic" ? epicCallOf : callOf;
  const known = { ...verdicts(file) };
  const todo = new Map<string, JudgePair & { refA?: string; refB?: string }>();
  for (const p of pairs) {
    const k = keyOf(p.a, p.b);
    if (!known[k] && !todo.has(k)) todo.set(k, p);
  }
  if (todo.size) {
    const list = [...todo.entries()];
    const got = await judge(list.map(([, p]) => ({ a: norm(p.a), b: norm(p.b) })));
    const at = new Date().toISOString();
    const fresh = { ...verdicts(file) };
    list.forEach(([k, p], i) => {
      const v = got[i];
      if (v) fresh[k] = { ...(kind === "epic" ? { kind: "epic" as const } : {}), same: v.same, confidence: v.confidence, at, a: norm(p.a).slice(0, 300), b: norm(p.b).slice(0, 300), ...(p.refA ? { refA: p.refA } : {}), ...(p.refB ? { refB: p.refB } : {}) };
    });
    writeVerdicts(file, fresh);
    Object.assign(known, fresh);
  }
  return pairs.map((p) => {
    const key = keyOf(p.a, p.b);
    const v = known[key] ?? { same: false, confidence: 0, at: "" };
    return { ...v, key, call: callOfKind(v) };
  });
}

/** the borderline pairs (same, not sure) of the prompt in use, newest first: what the daily read lists instead of merging. */
export function borderlinePairs(file = sameMeaningFile()): (MeaningVerdict & { key: string })[] {
  return Object.entries(verdicts(file))
    .filter(([k, v]) => k.startsWith(`v${JUDGE_VERSION}:`) && callOf(v) === "border")
    .map(([key, v]) => ({ key, ...v }))
    .sort((p, q) => (q.at ?? "").localeCompare(p.at ?? ""));
}

/** the merges it made (same, sure), newest first. */
export function mergedPairs(file = sameMeaningFile()): (MeaningVerdict & { key: string })[] {
  return Object.entries(verdicts(file))
    .filter(([k, v]) => k.startsWith(`v${JUDGE_VERSION}:`) && callOf(v) === "same")
    .map(([key, v]) => ({ key, ...v }))
    .sort((p, q) => (q.at ?? "").localeCompare(p.at ?? ""));
}

/** E948-S206 round 3: the epic pairs judged to overlap (the older card held), newest first. */
export function epicMerged(file = sameMeaningFile()): (MeaningVerdict & { key: string })[] {
  return Object.entries(verdicts(file))
    .filter(([k, v]) => k.startsWith(`e${EPIC_JUDGE_VERSION}:`) && epicCallOf(v) === "same")
    .map(([key, v]) => ({ key, ...v }))
    .sort((p, q) => (q.at ?? "").localeCompare(p.at ?? ""));
}

/** one pass over the wanted queue: judge what is not known yet (at most `max` pairs), then empty the queue. */
export async function judgeWanted(judge: PairJudge, file = sameMeaningFile(), max = 60, epicJudge?: PairJudge): Promise<number> {
  flushWanted();
  const wf = wantedFile(file);
  let text = "";
  try {
    // take the queue first, so lines added while judging wait for the next pass
    const taken = `${wf}.${process.pid}.taking`;
    fs.renameSync(wf, taken);
    text = fs.readFileSync(taken, "utf8");
    fs.rmSync(taken, { force: true });
  } catch {
    return 0;
  }
  const known = verdicts(file);
  const seen = new Set<string>();
  const pairs: (JudgePair & { refA?: string; refB?: string })[] = [];
  for (const line of text.split("\n")) {
    try {
      const w = JSON.parse(line) as { key: string; a: string; b: string; refA?: string; refB?: string };
      if (known[w.key] || seen.has(w.key)) continue;
      seen.add(w.key);
      pairs.push(w);
    } catch {
      /* a torn line */
    }
  }
  const now = pairs.slice(0, max);
  // over the cap: back on the queue for the next pass
  if (pairs.length > max) fs.appendFileSync(wf, pairs.slice(max).map((p) => JSON.stringify(p)).join("\n") + "\n");
  // each pair goes to its own judge (the key says which); epic pairs without an epic judge wait
  const epic = now.filter((p) => kindOfKey((p as { key?: string }).key ?? "") === "epic");
  const meaning = now.filter((p) => !epic.includes(p));
  if (meaning.length) await judgePairs(judge, meaning, file);
  if (epic.length && epicJudge) await judgePairs(epicJudge, epic, file, "epic");
  return meaning.length + (epicJudge ? epic.length : 0);
}

/** the main thread's minute timer over the wanted queue (never under tests). */
export function startSameMeaningJudge(judge: PairJudge, everyMs = 60_000, log: (m: string) => void = () => {}, firstAfterMs = 120_000, epicJudge?: PairJudge): () => void {
  let busy = false;
  // not in the console's first 2 minutes: its inbox warms up then (production restarts every few minutes on busy days)
  const from = Date.now() + firstAfterMs;
  const t = setInterval(() => {
    if (busy || Date.now() < from) return;
    busy = true;
    judgeWanted(judge, sameMeaningFile(), 60, epicJudge)
      .then((n) => n && log(`same-meaning: judged ${n} pair(s)`))
      .catch((e) => log(`same-meaning: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
      .finally(() => (busy = false));
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** tests: forget the per-process queue memory and the file cache. */
export function resetSameMeaning(): void {
  asked.clear();
  pending = undefined;
  wordsMemo.clear();
  cache = undefined;
}
