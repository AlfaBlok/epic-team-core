import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { OpenAsk, Run } from "../store.js";
import type { Grant } from "./grants.js";
import { newsPart } from "./wakeNews.js";
import { stateDir } from "../identity.js";

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
  /** the open faults the repo's home Delivery Manager owns (wakeNews.ts: red server-wheel key results, open desk notes), one line each. */
  news?: string[];
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
    // `n` (open faults, wakeNews.ts) only when there are some, so fingerprints without any stay the same.
    .update(JSON.stringify({ s: s.spines, r: [...s.running].sort(), f: false, j: s.answer, p: textHash(s.prompt ?? ""), ...(s.data ? { d: s.data } : {}), ...readyKey(s), ...(s.rollup ? { u: s.rollup } : {}), ...(s.news?.length ? { n: newsPart(s.news) } : {}) }))
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
 *
 * A social world's data/ held 809 MB in 732 files, and every wake check read and hashed all of it on the console's
 * one thread (a 9.3 s freeze in a 200 s profile; the owner's inbox waited behind it). Now the files'
 * stat (path, size, mtime, ctime, inode) is checked first and an unchanged tree returns the hash it had (kept in memory
 * and in a small file, so a restart does not read it all again); a changed tree is read with async reads that yield
 * between files and chunks. The hash itself is the same as before, so no wake sees news from this change.
 */
export function dataHash(repoDir: string, cap = DATA_FILE_CAP): string {
  const t = dataTree(repoDir, cap);
  if (!t) return "";
  const memo = memoGet(repoDir, t.sig);
  if (memo) return memo;
  const h = createHash("sha256");
  for (const p of t.files) {
    let body: Buffer | string;
    try {
      body = fs.readFileSync(path.join(repoDir, p));
    } catch {
      body = "\u0001missing";
    }
    h.update(`${p}\0`).update(body).update("\0");
  }
  h.update(`#${t.total}`);
  return memoSet(repoDir, t.sig, h.digest("hex").slice(0, 32));
}

/**
 * the same hash as dataHash, made in a worker thread: sha256 over a changed social data tree (hundreds of MB) was the
 * console's biggest thread user left (4.2 s of a 90 s production profile, all `Hash.update`). Same bytes in the same
 * order, so the hash is the one dataHash makes. One worker, one hash at a time; undefined when it cannot run.
 */
const HASH_WORKER = `
const { parentPort } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
parentPort.on("message", ({ id, repoDir, files, total }) => {
  try {
    const h = createHash("sha256");
    for (const p of files) {
      let body;
      try { body = fs.readFileSync(path.join(repoDir, p)); } catch { body = "\\u0001missing"; }
      h.update(p + "\\0").update(body).update("\\0");
    }
    h.update("#" + total);
    parentPort.postMessage({ id, hash: h.digest("hex").slice(0, 32) });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e && e.message || e) });
  }
});
`;
let hashWorker: Worker | undefined;
let hashWorkerOff = process.env.CONSOLE_DATA_HASH_WORKER === "off";
let hashSeq = 0;
const hashWaits = new Map<number, (hash: string | undefined) => void>();
function hashOff(repoDir: string, files: string[], total: number): Promise<string | undefined> {
  if (hashWorkerOff) return Promise.resolve(undefined);
  try {
    if (!hashWorker) {
      const w = new Worker(HASH_WORKER, { eval: true });
      w.unref();
      w.on("message", (m: { id: number; hash?: string }) => {
        hashWaits.get(m.id)?.(m.hash);
        hashWaits.delete(m.id);
      });
      const down = () => {
        if (hashWorker === w) hashWorker = undefined;
        for (const r of hashWaits.values()) r(undefined);
        hashWaits.clear();
      };
      w.on("error", (e) => {
        console.warn(`data hash worker: ${e.message}`);
        down();
      });
      w.on("exit", down);
      hashWorker = w;
    }
    const id = ++hashSeq;
    return new Promise((resolve) => {
      hashWaits.set(id, resolve);
      hashWorker!.postMessage({ id, repoDir, files, total });
    });
  } catch (e) {
    console.warn(`data hash worker: ${(e as Error).message}; hashing on this thread`);
    hashWorkerOff = true;
    return Promise.resolve(undefined);
  }
}

/** dataHash without blocking the event loop: the same hash, made in a worker thread (else async reads with yields). */
export async function dataHashAsync(repoDir: string, cap = DATA_FILE_CAP): Promise<string> {
  const t = dataTree(repoDir, cap);
  if (!t) return "";
  const memo = memoGet(repoDir, t.sig);
  if (memo) return memo;
  const inFlight = hashing.get(repoDir);
  if (inFlight && inFlight.sig === t.sig) return inFlight.p;
  const p = (async () => {
    const off = await hashOff(repoDir, t.files, t.total);
    if (off) return memoSet(repoDir, t.sig, off);
    const h = createHash("sha256");
    const CHUNK = 8 << 20;
    for (const rel of t.files) {
      let body: Buffer | string;
      try {
        body = await fs.promises.readFile(path.join(repoDir, rel));
      } catch {
        body = "\u0001missing";
      }
      h.update(`${rel}\0`);
      if (typeof body === "string" || body.length <= CHUNK) h.update(body);
      else
        for (let i = 0; i < body.length; i += CHUNK) {
          h.update(body.subarray(i, i + CHUNK));
          await new Promise((r) => setImmediate(r));
        }
      h.update("\0");
      await new Promise((r) => setImmediate(r));
    }
    h.update(`#${t.total}`);
    return memoSet(repoDir, t.sig, h.digest("hex").slice(0, 32));
  })().finally(() => hashing.delete(repoDir));
  hashing.set(repoDir, { sig: t.sig, p });
  return p;
}

const hashing = new Map<string, { sig: string; p: Promise<string> }>();

/** the data/ files in hash order (capped), their count and a signature of their stat; undefined without data/. */
function dataTree(repoDir: string, cap: number): { files: string[]; total: number; sig: string } | undefined {
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
    if (!fs.statSync(root).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  walk(root);
  const kept = files.sort().slice(0, cap);
  const sig = createHash("sha256");
  for (const p of kept) {
    try {
      const st = fs.statSync(path.join(repoDir, p), { bigint: true });
      sig.update(`${p}\0${st.size}\0${st.mtimeNs}\0${st.ctimeNs}\0${st.ino}\n`);
    } catch {
      sig.update(`${p}\0missing\n`);
    }
  }
  sig.update(`#${total}`);
  return { files: kept, total, sig: sig.digest("hex") };
}

/** repo dir → { stat signature, hash }; kept in a small JSON file so the first wake check after a restart is cheap too. */
let memo: Map<string, { sig: string; hash: string }> | undefined;
const memoFile = () => process.env.CONSOLE_DATA_HASH_MEMO ?? path.join(stateDir(), "data-hash.json");
function memoMap() {
  if (memo) return memo;
  memo = new Map();
  if (process.env.CONSOLE_DATA_HASH_MEMO === "off") return memo;
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(memoFile(), "utf8")) as Record<string, { sig: string; hash: string }>)) memo.set(k, v);
  } catch {
    /* no memo yet */
  }
  return memo;
}
function memoGet(repoDir: string, sig: string): string | undefined {
  const m = memoMap().get(repoDir);
  return m && m.sig === sig ? m.hash : undefined;
}
function memoSet(repoDir: string, sig: string, hash: string): string {
  const m = memoMap();
  m.delete(repoDir);
  m.set(repoDir, { sig, hash });
  while (m.size > 200) m.delete(m.keys().next().value as string); // test repos come and go; keep the newest
  if (process.env.CONSOLE_DATA_HASH_MEMO !== "off")
    try {
      const f = memoFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(Object.fromEntries(m)));
      fs.renameSync(`${f}.tmp`, f);
    } catch {
      /* the memo is only a speed-up */
    }
  return hash;
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
