import { execFile } from "../spawnHost.js";
import { originMainSha } from "../gitRefs.js";
import type { Hono } from "hono";
import { movingLimit } from "../cycle/movement.js";
import { ownerPattern } from "../identity.js";

/**
 * every commit names its ticket. A commit on a tracked repo's main whose message
 * names no row or spine code (``, ``, ``, ``, `L-46`) and no spine path (`docs/spines/….md`) is an
 * orphan: work nobody can find from the tree. The EpicSpine commit-msg hook warns at commit time on every host
 * (skill `scripts/commit_msg.py`, same patterns); here the console lists the orphans that reached main, on the Team home
 * and in the Delivery Manager's wake, which attributes each by naming its short sha in the row it belongs to (Latest
 * Evidence, or a Decisions line). A commit some spine of the repo names is attributed and drops off; main's history is
 * never rewritten. The console's own writes and merges are exempt by pattern.
 */

/** A row, ask, Done-means, epic or learning code (``, ``, ``, ``, `L-46`; added `ABC-A12`). */
export const TICKET_CODE = /(?<![A-Za-z0-9-])(?:EPIC-\d+(?:-[A-Z]{0,3}\d+[a-z]?)*|[A-Z]{1,4}-(?:\d+|[A-Z]{1,3}\d+[a-z]?)|[A-Z]{1,4}\d+[a-z]?(?:-[A-Z]{0,3}\d+[a-z]?)*)(?![A-Za-z0-9])/;
/** Trailer lines (`Run: run_…`, `Co-Authored-By: …`) name no ticket. */
const TRAILER = /^(?:Run|Ready|Co-Authored-By|Signed-off-by|Reviewed-by|Change-Id):\s/i;
/** A spine or ticket path: anything under docs/spines/ or docs/tickets/, or a.md file whose name says epic or spine (a root
 * spine like `docs/EPIC_SPINE.md`, `EPIC.md`, `docs/.md`, `docs/travel/TRAVEL_SPINE.md`). */
export const SPINE_PATH = /\bdocs\/(?:spines|tickets)\/[\w./-]+\.md\b|(?<![\w./-])(?:[\w.-]+\/)*[\w.-]*(?:EPIC|Epic|epic|SPINE|Spine|spine)[\w.-]*\.md\b/;
/** Merges and history moves, and the desk-note tool's own traffic (scripts/desk_note.py: the note file is the record): exempt. */
export const EXEMPT_SUBJECT = /^(?:Merge\b|Revert\b|fixup! |squash! |amend! |epicspine[: ]|Desk (?:note from |inbox: ))/i;
/** What the console (buttons, desk chat, voice notes) writes on the owner's behalf: exempt. */
export const EXEMPT_MESSAGE = () => new RegExp(String.raw`\bvia console\b|\((?:console|desk chat)\)|\(${ownerPattern()}, (?:asking the Team desk|his voice note|desk chat)\)`, "i");
export const EXEMPT_AUTHOR = /^(?:Agent Team Console|Team desk)$/i;

export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  message: string;
}

/** The commit names its ticket, or is exempt. */
export function namesTicket(c: Pick<CommitInfo, "author" | "message">): boolean {
  const subject = c.message.split("\n")[0] ?? "";
  if (EXEMPT_SUBJECT.test(subject) || EXEMPT_AUTHOR.test(c.author.trim()) || EXEMPT_MESSAGE().test(c.message)) return true;
  // Trailers (`Run:`, `Co-Authored-By:`) and URLs name no ticket.
  const text = c.message
    .split("\n")
    .filter((l) => !TRAILER.test(l))
    .join("\n")
    .replace(/https?:\/\/\S+/g, "");
  return TICKET_CODE.test(text) || SPINE_PATH.test(text);
}

export interface OrphanCommit {
  milestoneId: string;
  milestoneTitle: string;
  repo: string;
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

/** Orphans count from here on (the rule went live; older history is not raised) and at most this far back. */
export const ORPHAN_SINCE = "2026-11-03T06:00:00Z";
export const ORPHAN_WINDOW_MS = 7 * 24 * 3_600_000;

export type Git = (repoDir: string, args: string[]) => Promise<string>;
export const gitRun =
  (timeoutMs = 20_000): Git =>
  (repoDir, args) =>
    new Promise((resolve, reject) =>
      execFile("git", ["-C", repoDir, ...args], { timeout: timeoutMs, maxBuffer: 32 << 20 }, (err, out) => (err ? reject(err) : resolve(out))),
    );

const REF = "origin/main";

/**
 * The orphan commits on the checkout's origin/main since `since` (ISO), oldest first: no ticket named, not exempt, and no
 * file under docs/ on main names its short sha (attributed).
 */
export async function orphanCommitsIn(git: Git, repoDir: string, since: string): Promise<CommitInfo[]> {
  // the cadence tick asks every minute for every repo (two git forks each, on the console's main thread); the
  // answer only changes when origin/main moves, so it is kept per checkout until its origin/main sha changes.
  const sha = originMainSha(repoDir);
  const key = `${repoDir}\0${sha}`;
  const hit = sha ? orphanMemo.get(key) : undefined;
  if (hit && Date.parse(hit.since) <= Date.parse(since)) return hit.list.filter((c) => Date.parse(c.date) >= Date.parse(since));
  const list = await readOrphans(git, repoDir, since);
  if (sha) {
    for (const k of orphanMemo.keys()) if (k.startsWith(`${repoDir}\0`)) orphanMemo.delete(k);
    orphanMemo.set(key, { since, list });
  }
  return list;
}

const orphanMemo = new Map<string, { since: string; list: CommitInfo[] }>();

async function readOrphans(git: Git, repoDir: string, since: string): Promise<CommitInfo[]> {
  const log = await git(repoDir, ["log", REF, "--no-merges", `--since=${since}`, "--format=%H%x1f%an%x1f%cI%x1f%B%x1e"]);
  const all = log
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha, author, date, message] = r.split("\x1f");
      return { sha, author, date, message: (message ?? "").trim() };
    })
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha) && !namesTicket(c));
  if (!all.length) return [];
  // Attributed: a spine (any file under docs/) on main names the commit's 7-char sha.
  const named = new Set<string>();
  const args = ["grep", "-o", "-h", "-I", ...all.flatMap((c) => ["-e", c.sha.slice(0, 7)]), REF, "--", "docs"];
  const hits = await git(repoDir, args).catch(() => ""); // exit 1 = no match
  for (const l of hits.split("\n")) {
    const m = /([0-9a-f]{7})\s*$/.exec(l.trim());
    if (m) named.add(m[1]);
  }
  return all.filter((c) => !named.has(c.sha.slice(0, 7))).reverse();
}

export const sinceFor = (now: number, floor = process.env.CONSOLE_ORPHAN_SINCE || ORPHAN_SINCE) =>
  new Date(Math.max(Date.parse(floor) || 0, now - ORPHAN_WINDOW_MS)).toISOString();

export const ORPHAN_MAX = 30;

/** The Delivery Manager's wake section, or undefined when every commit names its ticket. */
export function orphanSection(items: OrphanCommit[]): string | undefined {
  if (!items.length) return undefined;
  return [
    "## Commits that name no ticket",
    "These commits reached main without naming a row code (M2-41…) or a spine path, so nobody can find them from the tree. " +
      "This wake, for each: find the row the work belongs to and name the commit's short sha in that row's Latest Evidence (or a Decisions line when it was a decision); " +
      "if no row covers it, add one (`done` when the work is finished, citing the sha); if you cannot tell what it was, raise a coded ask under `## Waiting on` that names the sha. " +
      "The line is a spine (docs) change on that repo's main, also where a person merges its code branches. Never rewrite main's history. A commit a spine names drops off this list.",
    ...items.slice(0, ORPHAN_MAX).map((i) => `- ${i.repo} ${i.short} ${i.date.slice(0, 16)}Z ${i.author}: ${i.subject}`),
    ...(items.length > ORPHAN_MAX ? [`- …and ${items.length - ORPHAN_MAX} more (GET /api/orphan-commits)`] : []),
  ].join("\n");
}

/** `GET /orphan-commits`: the caller's world's orphan commits, newest first, memoized a minute per world. */
export function mountOrphanCommits(api: Hono, o: { list: (world: string) => Promise<OrphanCommit[]>; world?: () => string; ttlMs?: number; now?: () => number }) {
  const memo = new Map<string, { at: number; items: OrphanCommit[] }>();
  const inFlight = new Map<string, Promise<OrphanCommit[]>>();
  const now = o.now ?? Date.now;
  api.get("/orphan-commits", async (c) => {
    const w = o.world?.() ?? "";
    let m = memo.get(w);
    if (!m || now() - m.at > (o.ttlMs ?? 60_000)) {
      let p = inFlight.get(w);
      if (!p) inFlight.set(w, (p = o.list(w).finally(() => inFlight.delete(w))));
      memo.set(w, (m = { at: now(), items: await p }));
    }
    const items = [...m.items].sort((a, b) => b.date.localeCompare(a.date));
    const limit = movingLimit(c.req.query("limit"));
    return c.json({ items: limit ? items.slice(0, limit) : items, total: items.length });
  });
}
