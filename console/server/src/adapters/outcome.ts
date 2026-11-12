import { execFile } from "node:child_process";
import type { Dod } from "../dod.js";
import type { Outcome } from "./spines.js";
import { statusWordOf } from "./tree.js";
import { headOf } from "./gitHead.js";
import { ownerName, ownerPattern } from "../identity.js";

/** Verdict words: the contract's four (from `## Outcome`), then the console's fallbacks. */
export type VerdictWord =
  | "accomplished"
  | "partially accomplished"
  | "not accomplished"
  | "superseded"
  | "accomplished?"
  | "parked"
  | `blocked on ${string}`
  | "in progress";

export interface Verdict {
  word: VerdictWord | string;
  /** "outcome" = written in the spine's `## Outcome`; "derived" = the console's fallback. */
  source: "outcome" | "derived";
  note?: string;
}

export const UNCONFIRMED = "unconfirmed: no ## Outcome written";
export const AGENT_VERDICT = `Verdict written by an agent, not marked by ${ownerName()}`;

/**
 * a `Verdict:` is the owner's mark only when the console wrote it (`Closed: <date> by the owner (console)`, status/mark.ts)
 * or the spine already reads done / superseded (marks made before the console mark existed). Any other Verdict was
 * written by an agent (`Closed: … by run_…`, or no Closed line) and reads Ready to mark.
 */
export function markedByJordi(o: Pick<Outcome, "verdict" | "closedBy"> | null | undefined, status?: string): boolean {
  if (!o?.verdict) return false;
  if (o.closedBy && new RegExp(`\\b${ownerPattern()}\\b`, "i").test(o.closedBy)) return true;
  const w = status ? statusWordOf(status) : undefined;
  return w === "done" || w === "superseded";
}

/**
 * Milestone verdict. Order: outcome.verdict; else `accomplished?` when Status is done and every Done-means item is
 * ticked; else superseded (status); parked (an assignment has parkedAt); blocked on the owner (red dots in the
 * tree; Waiting on / blocked text naming the owner alone no longer makes it red: only open items do); else in progress.
 */
export function deriveVerdict(i: {
  outcome?: Outcome | null;
  status?: string;
  dod?: Pick<Dod, "done" | "total"> & { tracked?: boolean };
  /** Doctrine Done means, when spines.py gives them (preferred over the DoD checkboxes). */
  doneMeans?: { done: boolean }[];
  blockedReason?: string;
  waitingOn?: string;
  parked?: boolean;
  redDots?: number;
}): Verdict {
  if (i.outcome?.verdict && markedByJordi(i.outcome, i.status)) return { word: i.outcome.verdict, source: "outcome" };
  if (i.outcome?.verdict) return { word: "accomplished?", source: "derived", note: AGENT_VERDICT };
  const { done, total } = doneMeansCount(i);
  if (i.status === "done" && total > 0 && done === total) return { word: "accomplished?", source: "derived", note: UNCONFIRMED };
  if (i.status === "superseded") return { word: "superseded", source: "derived", note: UNCONFIRMED };
  if (i.parked) return { word: "parked", source: "derived" };
  if ((i.redDots ?? 0) > 0)
    return { word: `blocked on ${ownerName()}`, source: "derived" };
  return { word: "in progress", source: "derived" };
}

/** Done means x/y: doctrine Done means when present, else the tracked DoD checkboxes. */
export function doneMeansCount(i: { dod?: Pick<Dod, "done" | "total"> & { tracked?: boolean }; doneMeans?: { done: boolean }[] }) {
  if (i.doneMeans?.length) return { done: i.doneMeans.filter((d) => d.done).length, total: i.doneMeans.length };
  if (i.dod && i.dod.tracked !== false) return { done: i.dod.done, total: i.dod.total };
  return { done: 0, total: 0 };
}

// ---------- spine commits made during a run ----------

export interface RunCommit {
  sha: string;
  subject: string;
  at: string;
}

export type GitLog = (repoDir: string, args: string[]) => Promise<string>;

export const gitLog: GitLog = (repoDir, args) =>
  new Promise((resolve, reject) =>
    execFile("git", ["-C", repoDir, "log", ...args], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
  );

/** One `git log` record: fields split by US (\x1f), records start with RS (\x1e); subjects may contain anything else. */
export const LOG_FORMAT = "--format=%x1e%h%x1f%s%x1f%cI%x1f%(trailers:key=Run,valueonly,separator=%x2C)";

export interface LoggedCommit extends RunCommit {
  /** Values of `Run:` trailers, in order. */
  runIds: string[];
}

export function parseCommits(out: string): LoggedCommit[] {
  return out
    .split("\x1e")
    .map((rec) => rec.split("\x1f").map((f) => f.trim()))
    .filter(([sha, , at]) => /^[0-9a-f]{4,40}$/.test(sha ?? "") && !!at)
    .map(([sha, subject = "", at, trailers = ""]) => ({
      sha,
      subject,
      at,
      runIds: trailers
        .split(/[,\n]/)
        .map((v) => v.trim())
        .filter(Boolean),
    }));
}

/** The run fields commit attribution needs. */
export interface CommitRun {
  id: string;
  startedAt: string;
  endedAt?: string;
  parentRunId?: string;
  summary?: string;
}

/** First ticket id in a run summary (`N10-6`, ``, ``, ``); undefined if none. */
export function ticketId(summary?: string): string | undefined {
  return summary?.match(/(?<![A-Za-z0-9-])[A-Z][A-Z0-9]*-\d+(?:-\d+)?(?![A-Za-z0-9]|-\d)/)?.[0];
}

/** `id` appears in `subject` as a whole token (N10-6 does not match N10-60 or N10-6-1). */
export const mentions = (subject: string, id: string) =>
  new RegExp(`(?<![A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9]|-\\d)`).test(subject);

/**
 * Effective end of a run (ms): its endedAt; else, for a child run the persona never closed, its parent's effective
 * end (an unclosed child of an ended wake stops at the wake's end); else now (undefined).
 */
export function effectiveEnd(run: CommitRun, byId: Map<string, CommitRun>, seen = new Set<string>()): string | undefined {
  if (run.endedAt) return run.endedAt;
  const parent = run.parentRunId ? byId.get(run.parentRunId) : undefined;
  if (!parent || seen.has(run.id)) return undefined;
  seen.add(run.id);
  return effectiveEnd(parent, byId, seen);
}

/** Child run whose parent ended but which never got its own endedAt (the persona did not close it). */
export const unclosedChild = (run: CommitRun, byId: Map<string, CommitRun>) =>
  !run.endedAt && !!run.parentRunId && !!effectiveEnd(run, byId);

/**
 * Assign each commit to exactly one run: (a) its `Run:` trailer, when that is a run of this milestone;
 * else (b) the child run whose window contains it and whose summary's ticket id is a token of the subject (deepest,
 * then latest start); else (c) the latest-started top-level wake whose window contains it; else nowhere.
 * Commits arrive newest first; each run keeps at most `cap`.
 */
export function attributeCommits(commits: LoggedCommit[], runs: CommitRun[], nowMs: number, cap = 10): Record<string, RunCommit[]> {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const depth = (r: CommitRun) => {
    let d = 0;
    for (let p = r.parentRunId ? byId.get(r.parentRunId) : undefined; p && d < 50; p = p.parentRunId ? byId.get(p.parentRunId) : undefined) d++;
    return d;
  };
  const win = runs.map((r) => {
    const end = effectiveEnd(r, byId);
    // git dates have second precision: a commit in the run's first second still counts.
    return { r, from: Math.floor(Date.parse(r.startedAt) / 1000) * 1000, to: end ? Date.parse(end) : nowMs, depth: depth(r), ticket: ticketId(r.summary) };
  });
  const innermost = (a: (typeof win)[number], b: (typeof win)[number]) => b.depth - a.depth || b.from - a.from;
  const out: Record<string, RunCommit[]> = {};
  for (const c of commits) {
    const t = Date.parse(c.at);
    const inside = win.filter((w) => t >= w.from && t <= w.to);
    const owner =
      c.runIds.map((id) => byId.get(id)).find(Boolean) ??
      inside.filter((w) => w.r.parentRunId && w.ticket && mentions(c.subject, w.ticket)).sort(innermost)[0]?.r ??
      inside.filter((w) => !w.r.parentRunId).sort(innermost)[0]?.r;
    if (!owner) continue;
    const list = (out[owner.id] ??= []);
    if (list.length < cap) list.push({ sha: c.sha, subject: c.subject, at: c.at });
  }
  return out;
}

/**
 * Spine commits per run of one milestone: ONE `git log` over [earliest start, latest effective end or now]
 * for `paths`, each commit attributed to one run (attributeCommits). Cached per (repo, paths, runs): long for a
 * fully ended window (bounded map), `openTtlMs` (30 s) while any window runs to now. Any git failure → {}.
 */
export function runCommitsLookup(
  git: GitLog = gitLog,
  opts: { cap?: number; openTtlMs?: number; max?: number; now?: () => number; logLimit?: number } = {},
) {
  const cap = opts.cap ?? 10;
  const cache = new Map<string, { at: number; open: boolean; value: Promise<Record<string, RunCommit[]>> }>();
  const now = opts.now ?? Date.now;
  return (repoDir: string, paths: string[], runs: CommitRun[]): Promise<Record<string, RunCommit[]>> => {
    if (!paths.length || !runs.length) return Promise.resolve({});
    const sig = runs.map((r) => [r.id, r.startedAt, r.endedAt ?? null, r.parentRunId ?? null, ticketId(r.summary) ?? null]);
    const key = JSON.stringify([repoDir, paths, sig]);
    const hit = cache.get(key);
    if (hit && (!hit.open || now() - hit.at < (opts.openTtlMs ?? 30_000))) return hit.value;
    const byId = new Map(runs.map((r) => [r.id, r]));
    const ends = runs.map((r) => effectiveEnd(r, byId));
    const open = ends.some((e) => !e);
    const t = now();
    const since = new Date(Math.min(...runs.map((r) => Date.parse(r.startedAt)))).toISOString();
    const until = new Date(open ? t : Math.max(...ends.map((e) => Date.parse(e!)))).toISOString();
    const value = git(repoDir, [LOG_FORMAT, `--since=${since}`, `--until=${until}`, "-n", String(opts.logLimit ?? 1_000), "--", ...paths])
      .then((out) => attributeCommits(parseCommits(out), runs, t, cap))
      .catch(() => ({}));
    cache.delete(key);
    cache.set(key, { at: t, open, value });
    while (cache.size > (opts.max ?? 500)) cache.delete(cache.keys().next().value!);
    return value;
  };
}

/** Last commit time (ISO) touching `rel` in a checkout; cached 30 s; undefined on any git failure. */
export function lastCommitLookup(git: GitLog = gitLog, ttlMs = 30_000, now = () => Date.now()) {
  const cache = new Map<string, { at: number; head?: string; value: Promise<string | undefined> }>();
  return (repoDir: string, rel: string): Promise<string | undefined> => {
    const key = `${repoDir}\0${rel}`;
    const hit = cache.get(key);
    // the last commit on a path only moves with HEAD: same HEAD, no git spawn; a moved HEAD always reads again
    // (inside the TTL it kept the old time after a console write); no HEAD to compare = the TTL, as before.
    const head = headOf(repoDir);
    if (hit && (head ? hit.head === head : now() - hit.at < ttlMs)) return hit.value;
    const value = git(repoDir, ["-1", "--format=%cI", "--", rel])
      .then((out) => out.trim() || undefined)
      .catch(() => undefined);
    cache.set(key, { at: now(), ...(head ? { head } : {}), value });
    return value;
  };
}
