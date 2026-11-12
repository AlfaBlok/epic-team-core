import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenAsk, Run } from "../store.js";
import type { Grant } from "./grants.js";

/**
 * an Unblocker cadence wake with nothing new since its last check is not started. Since "nothing new" is
 * per ask (cycle/askMemory.ts memorySkipDecision): no open ask is new or changed since the run that assessed it; the
 * cap of 12 skips no longer forces a re-check of unchanged asks. `askFingerprint` (all asks + grants) stays on
 * each Unblocker run for Activity and the wake-why.
 */
export const SKIP_PREFIX = "skipped: nothing new since";

export const textHash = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

export function askFingerprint(asks: OpenAsk[], grants: Grant[]): string {
  // the owner's comments and linked evidence count too (absent = "", so fingerprints stay the same without them).
  const a = asks.map((x) => [x.code, x.kind, x.textHash ?? "", ...(x.commentHash || x.evidenceHash ? [x.commentHash ?? "", x.evidenceHash ?? ""] : [])].join("|")).sort();
  const g = grants.map((x) => [x.code, textHash([x.scope, x.limits ?? "", x.expires ?? "", x.source].join("\n"))].join("|")).sort();
  return createHash("sha256").update(JSON.stringify({ a, g })).digest("hex").slice(0, 32);
}

const isSkip = (r: Run) => r.summary.startsWith(SKIP_PREFIX);

/** the run asked to be checked again (monitoring nextCheckAt, or a timed wake retryAt) and that time has come: news. */
export const checkDue = (r: Run, now = Date.now()) => [r.nextCheckAt, r.retryAt].some((t) => !!t && Date.parse(t) <= now);

// ----------: any cadence persona (the Delivery Manager first) ----------

/**
 * the longest a cadence persona skips after its last real wake (anything the fingerprint cannot see). Replaces
 * the cap of 6 skips in a row, which was 12 h at a 2 h cadence but 3 h at 30 min. 24 h (was 12 h).
 */
export const CADENCE_SKIP_MAX_AGE_MS = 24 * 3_600_000;

/** What a cadence persona's wake would see. `spines` hashes every spine file in the milestone's tree at the checkout. */
export interface WakeState {
  spines: string;
  /** Child runs of the assignment still running (ids). */
  running: string[];
  /**
   * The tree has ready rows nobody is on AND the dispatcher has a free seat. Only for a persona that dispatches
   * (the Delivery Manager); always false for the others, which never start rows. Not a fingerprint part (the shared
   * seat pool flips busy ↔ free all day): recorded in wake_parts only, for the seat-freed rule (seatFreed).
   */
  readyAndSeatFree: boolean;
  /** keys of the ready rows nobody is on, dispatching persona only (absent for the others): news when the set changes. */
  ready?: string[];
  /** Newest answer saved in the console for the milestone (jordi_responses id), "" when none. */
  answer: string;
  /** What else the wake prompt is built from: the tree to-do section (incl. answered asks of other epics it references) and the grants. */
  prompt?: string;
  /** hash of the repo's `data/` tree (dataHash), "" when the repo has none. */
  data?: string;
  /** spines of the tree whose Current State lags their children (rollup.ts rollupPart), Delivery Manager only; "" when none. */
  rollup?: string;
}

/** the sorted ready rows nobody is on (a dispatching persona only), whatever the seats do. */
export const readySet = (s: WakeState): string[] => (s.ready?.length ? [...s.ready].sort() : []);
const readyKey = (s: WakeState) => (readySet(s).length ? { q: readySet(s) } : {});

/**
 * the `ready` wake part: "0" no ready rows (or a persona that does not dispatch), "1:<hash>" ready rows + a free
 * seat, "2:<hash>" ready rows and no free seat.
 */
export const readyPart = (s: WakeState): string => {
  const set = readySet(s);
  return set.length ? `${s.readyAndSeatFree ? 1 : 2}:${textHash(set.join(","))}` : "0";
};
/** the last real wake saw these same ready rows with no free seat, and now one is free: news (once). */
export const seatFreed = (before: string | undefined, now: string | undefined) => !!before && !!now && before.startsWith("2:") && now === `1:${before.slice(2)}`;
/**
 * a freed seat is news only when the last real wake did not end `blocked`: a blocked wake already looked at those
 * ready rows and could not start them (their epics wait on the owner), and a seat does not change that. Idle, progressed and
 * monitoring ends keep the rule.
 */
export const seatFreedNews = (last: Pick<Run, "outcome" | "wakeParts"> | undefined, now: string | undefined) =>
  !!last && last.outcome !== "blocked" && seatFreed(last.wakeParts?.ready, now);
/**
 * the ready part a wake leaves as its baseline: a wake that saw its ready rows with a free seat keeps "1:" even
 * if the seat is busy when it ends (it had its chance); otherwise the new value.
 */
export const keepSeatSeen = (seen: string | undefined, now: string) => (seen && now.startsWith("2:") && seen === `1:${now.slice(2)}` ? seen : now);

export function wakeFingerprint(s: WakeState): string {
  return createHash("sha256")
    // `d` only when the repo has a data/ tree, so fingerprints of repos without one stay the same.
    // `q` (the ready rows) only when there are some, so other fingerprints stay the same. `f` (ready + a free
    // seat) is always false now: the seat is not a part (it was false whenever there were no ready rows, so unchanged).
    // `u` (a Current State lagging its children) only when one lags, so fingerprints without a lag stay the same.
    .update(JSON.stringify({ s: s.spines, r: [...s.running].sort(), f: false, j: s.answer, p: textHash(s.prompt ?? ""), ...(s.data ? { d: s.data } : {}), ...readyKey(s), ...(s.rollup ? { u: s.rollup } : {}) }))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Current State lines a wake rewrites as bookkeeping (when it last looked, what it saw, where the proof is).
 * A wake that only restamps them has changed nothing another wake needs to see.
 */
export const BOOKKEEPING_PREFIXES = ["Last attempted:", "Result:", "Evidence:", "Verified at:", "Source revision:", "Housekeeping:"];
/** Current State lines that count, but whose time stamps ("re-check 09:16Z", "2026-10-25T09:16Z") do not. */
export const STAMPED_PREFIXES = ["Waiting on:", "Next action:"];

const STAMP = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:Z|UTC|CES?T)?\b/g;
const bare = (line: string) => line.replace(/^\s*(?:[-*]\s+)?(?:\*\*)?/, "").replace(/^([^*]*?)\*\*/, "$1");
const startsWithAny = (line: string, prefixes: string[]) => prefixes.some((x) => line.toLowerCase().startsWith(x.toLowerCase()));

/**
 * the spine text the wake fingerprint hashes. Inside `## Current State` the bookkeeping lines are dropped and
 * time stamps in `Waiting on:` / `Next action:` are blanked; everything else (Status, Approved work, `## Waiting on` asks,
 * Done means, ledger rows) is kept as is.
 */
export function spineForFingerprint(text: string): string {
  let inState = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) inState = h[1] === "##" && /^current state\b/i.test(h[2].trim());
    if (inState && !h) {
      const b = bare(line);
      if (startsWithAny(b, BOOKKEEPING_PREFIXES)) continue;
      if (startsWithAny(b, STAMPED_PREFIXES)) {
        out.push(line.replace(STAMP, "<t>"));
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Hash of the spine files (repo-relative path → text, undefined when unreadable), order-independent, bookkeeping left out. */
export function spinesHash(files: Map<string, string | undefined>): string {
  const h = createHash("sha256");
  for (const p of [...files.keys()].sort()) {
    const text = files.get(p);
    h.update(`${p}\0${text === undefined ? "\u0001missing" : spineForFingerprint(text)}\0`);
  }
  return h.digest("hex").slice(0, 32);
}

/** files of `data/` hashed at most (a bigger tree hashes the first ones in path order plus the count). */
export const DATA_FILE_CAP = 5000;

/**
 * hash of every file under `<repoDir>/data/` (repo-relative path + content), order-independent; "" when there
 * is no data/ directory. Personas write typed files there (posts, ideas, feedback), so a change under data/ is news
 * for the next cadence wake, like a spine edit.
 */
export function dataHash(repoDir: string, cap = DATA_FILE_CAP): string {
  const root = path.join(repoDir, "data");
  const files: string[] = [];
  let total = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        total++;
        files.push(path.relative(repoDir, full));
      }
    }
  };
  try {
    if (!fs.statSync(root).isDirectory()) return "";
  } catch {
    return "";
  }
  walk(root);
  const h = createHash("sha256");
  for (const p of files.sort().slice(0, cap)) {
    let body: Buffer | string;
    try {
      body = fs.readFileSync(path.join(repoDir, p));
    } catch {
      body = "\u0001missing";
    }
    h.update(`${p}\0`).update(body).update("\0");
  }
  h.update(`#${total}`);
  return h.digest("hex").slice(0, 32);
}

/** "worked" ids (same rule as the web's workedTicketIds): first word of a running child run's summary with a digit. */
export function workedIds(runs: Run[]): Set<string> {
  const ids = new Set<string>();
  for (const r of runs) {
    if (!r.parentRunId || r.outcome !== "running") continue;
    const id = /^\s*\**([A-Za-z0-9][\w.-]*?)[.:,;)*]*(?:\s|$)/.exec(r.summary)?.[1];
    if (id && /\d/.test(id)) ids.add(id.toUpperCase());
  }
  return ids;
}

/**
 * Decide from the assignment's runs (newest first) whether a cadence wake of a non-Unblocker persona skips. The last
 * real wake (a fingerprinted top-level run that is not a skip) must have the same fingerprint (refreshed when it ended)
 * and have finished idle, progressed, blocked (blocked on a human ask: the answer changes the spine, so the fingerprint)
 * or monitoring (while its nextCheckAt / retryAt is not due; a due one is news, checkDue); never after failed; no child run may have ended since it started; nothing may be running; and
 * the last real wake started less than `maxAgeMs` ago, and no seat freed for ready rows it saw starved
 * (`ready`: the current `ready` wake part, seatFreed; not after a blocked end, seatFreedNews).
 */
/** Outcomes of the last real wake after which an unchanged fingerprint skips (blocked, monitoring). */
export const SKIP_AFTER = ["idle", "progressed", "blocked", "monitoring"];

export function cadenceSkipDecision(
  runs: Run[],
  fingerprint: string,
  maxAgeMs = CADENCE_SKIP_MAX_AGE_MS,
  now = Date.now(),
  ready?: string,
): { skip: false } | { skip: true; sourceRunId: string; summary: string } {
  let last: Run | undefined;
  for (const r of runs) {
    if (r.parentRunId || r.kind === "answer_run" || !r.askFingerprint) continue;
    if (r.outcome === "running") return { skip: false };
    if (r.askFingerprint !== fingerprint) return { skip: false };
    if (!isSkip(r)) {
      last = r;
      break;
    }
  }
  if (!last || !SKIP_AFTER.includes(last.outcome) || checkDue(last, now)) return { skip: false };
  const since = Date.parse(last.startedAt);
  if (now - since >= maxAgeMs) return { skip: false }; // too long since the last real wake
  if (seatFreedNews(last, ready)) return { skip: false }; // a seat freed for rows it saw starved (not after blocked)
  if (runs.some((r) => r.parentRunId && r.endedAt && Date.parse(r.endedAt) >= since)) return { skip: false };
  return { skip: true, sourceRunId: last.id, summary: `${SKIP_PREFIX} ${last.id}` };
}
