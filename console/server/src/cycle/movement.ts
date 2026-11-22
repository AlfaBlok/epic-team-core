import { execFile } from "node:child_process";
import { headOf } from "../adapters/gitHead.js";
import { parseDoc, isDoneStatus } from "../adapters/doc.js";
import type { Seat } from "../adapters/seats.js";
import { firstStatusWord, isClosed, statusWordOf, type Tree, type TreeNode } from "../adapters/tree.js";
import { rowOf, type Claim } from "../desk/dispatch.js";
import { isDeliveryManager } from "../inbox/asks.js";
import type { WaitingItem } from "../inbox/waiting.js";
import type { Assignment, Milestone, Run } from "../store.js";
import { repoKey } from "../adapters/repoNames.js";
import { ownerName } from "../identity.js";

/**
 * movement you can see.
 * (a) a Delivery manager wake that launches no worker while unclaimed rows read ready must name its one blocker
 *     (`blocker: …`), else the run is flagged `stalled` in Activity;
 * (b) the stall watch: a ready/active epic with ready rows, a free seat and no worker or commit for 2 h gets one
 *     Run now of its milestone's Delivery manager, with a note naming the epic (once per epic per 2 h; never a
 *     switched-off or parked persona, root L-10). Real trigger behind CONSOLE_STALL_WATCH=on; the dry evaluation
 *     (GET /api/stall-watch) always works;
 * (c) the Team page "Moving now" strip: per epic, workers running · last commit age · rows done today.
 */

export const STALL_MS = 2 * 3600_000;
/** Who the stall watch's Run now note is by (`instructionsBy`); also how it finds its own earlier firings. */
export const STALL_WATCH_BY = "Stall watch";

export const BLOCKER_RULE =
  "If this wake launched no worker while unclaimed rows read ready, add one line `blocker: <the one blocker: dependency on <row>, deploy guard, " +
  "no seat (pick's reason), open ask <CODE>, …>`; a Delivery manager wake that launches nothing and names no blocker is flagged stalled (root L-26).";

/** `blocker: …` in a report (first such line), else undefined. */
export function blockerOf(summary: string | undefined): string | undefined {
  const m = /^[\s>*-]*blocker:\s*(\S.*)$/im.exec(summary ?? "");
  return m ? m[1].trim().slice(0, 300) : undefined;
}

/**
 * (a) The stalled flag of a finishing top-level Delivery manager wake, or undefined. `ready` = the milestone's unclaimed
 * ready rows; `launched` = child runs it recorded. A failed wake is already loud; `blocked` cites an open ask (its blocker).
 */
export function stalledWake(i: { persona?: string; outcome: Run["outcome"]; summary: string; ready: string[]; launched: number }): string | undefined {
  if (!isDeliveryManager(i.persona) || i.launched > 0 || !i.ready.length) return undefined;
  if (i.outcome === "failed" || i.outcome === "blocked" || i.outcome === "stopped" || i.outcome === "running") return undefined;
  if (blockerOf(i.summary)) return undefined;
  const shown = i.ready.slice(0, 5).join(", ") + (i.ready.length > 5 ? ", …" : "");
  return `launched no worker and named no blocker while ${i.ready.length} row${i.ready.length === 1 ? "" : "s"} read${i.ready.length === 1 ? "s" : ""} ready: ${shown}`;
}

/**
 * ready work always starts. A finishing top-level Delivery manager wake accounts for every unclaimed ready row:
 * a child run of this wake on it, or a written reason naming it (one summary line with the row id and `not started`,
 * `left ready`, `queued`, `skipped`, `blocker` or `waits on`; the same reason goes on the row's Next action in the spine).
 * A `queued: worker ceiling` / `queued: no seat` line covers every row it does not name (the follow-up wake takes them).
 * The console refuses the first finish that leaves rows unaccounted (400 `ready_unstarted`, the rows listed back into the
 * same wake); a second one is kept, flagged stalled, and the next wake is booked at once with the rows named.
 */
export const READY_ACCOUNT_RULE =
  "Every ready row in your scope ends this wake with a worker or a written reason: for each ready row you did not start, one summary line " +
  "`not started <row>: <reason>` (or `left ready: <ids> (<reason>)`, `skipped <row>: …`, `blocker: <row> …`), and the same reason in that row's Next action in the spine. " +
  "The console refuses a finish that leaves a ready row with neither (400 `ready_unstarted`, the rows listed): start them or write their reasons, then PATCH again.";

const REASON_WORD = /\b(not started|left ready|queued|skipped|blocker|waits on)\b/i;
const QUEUED_ALL = /\bqueued:\s*(worker ceiling|no seat)/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ready rows a finishing wake left with no child run and no written reason. Pure. */
export function unaccountedReady(i: { ready: string[]; launchedRows: string[]; summary: string }): string[] {
  const lines = (i.summary ?? "").split(/\n|(?<=\.)\s+(?=[a-z`-])|\s\|\s|;\s/i);
  const reasoned = (id: string) => {
    const re = new RegExp(`(^|[^A-Za-z0-9-])${esc(id)}(?![A-Za-z0-9])`, "i");
    return lines.some((l) => re.test(l) && REASON_WORD.test(l));
  };
  const named = (id: string) => new RegExp(`(^|[^A-Za-z0-9-])${esc(id)}(?![A-Za-z0-9])`, "i").test(i.summary ?? "");
  const queuedAll = QUEUED_ALL.test(i.summary ?? "");
  const launched = new Set(i.launchedRows.map((r) => r.toUpperCase()));
  return i.ready.filter((id) => !launched.has(id.toUpperCase()) && !reasoned(id) && !(queuedAll && !named(id)));
}

/** The 400 text that lists the rows back into the same wake. */
export const readyUnstartedText = (rows: string[]) =>
  `${rows.length} ready row${rows.length === 1 ? "" : "s"} in your scope ha${rows.length === 1 ? "s" : "ve"} no worker and no written reason: ${rows.join(", ")}. ` +
  "Start each now (one worker per row), or add one summary line per row `not started <row>: <reason>` and write that reason in the row's Next action, then PATCH again. " +
  "A second finish like this is kept, flagged stalled, and the next wake is booked at once with these rows.";

/** The note a kept second finish carries: the rows go into the next wake, booked now. */
export const READY_REBOOK_MARK = "ready rows left with no worker or reason";

// ---------- epics of a tree ----------

export interface EpicRows {
  path: string;
  title: string;
  status: string;
  /** Row ids of this epic's own ledger (tickets under it, not under a child spine). */
  rows: string[];
  /** Of those, the ones that can start now (tree `ready`). */
  ready: string[];
}

/** Every spine in the tree with work of its own: its ledger rows and its ready rows. Reference (cycle/repeat) nodes skipped. */
export function epicsOf(t: Tree): EpicRows[] {
  const out: EpicRows[] = [];
  const visit = (spine: TreeNode) => {
    if (spine.flags.some((f) => f === "cycle" || f === "repeat")) return;
    const e: EpicRows = { path: (spine.path ?? spine.id).replace(/^\.\//, ""), title: spine.title, status: spine.status, rows: [], ready: [] };
    const rows = (n: TreeNode) => {
      for (const c of n.children) {
        if (c.kind === "spine") visit(c);
        else if (c.kind === "ticket") {
          e.rows.push(c.id);
          if (c.ready) e.ready.push(c.id);
          rows(c);
        }
      }
    };
    rows(spine);
    if (e.rows.length) out.push(e);
  };
  visit(t.root);
  return out;
}

/** Ready or active (the stall watch's word; `blocked` epics wait on something by definition). The status's first word. */
export const isGoing = (status: string) => {
  const w = firstStatusWord(status);
  return w === "ready" || w === "active";
};

// ---------- rows done today ----------

/** One git process; `input` goes to its stdin (cat-file --batch). */
export type Git = (repoDir: string, args: string[], input?: string) => Promise<string>;
export const git: Git = (repoDir, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", repoDir, ...args], { timeout: 5_000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)));
    // stdin closed for every call (git never waits on it); a git that exits before reading it must not throw EPIPE
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });

/**
 * at most `max` git processes at a
 * time. A cold /api/moving-now ran 3-4 git calls per epic of every unsettled milestone at once (hundreds of processes on
 * a 4-CPU host), so every other request on the page, the Pending column's /api/status too, waited past the browser's
 * 30 s. Queued calls run in order; a failed call frees its slot.
 * starting a child is synchronous (23-30 ms each from the console on the main server, up to 67 ms), so at most one call
 * starts per turn of the event loop: requests are served between starts, never behind four in a row.
 */
export function limitGit(g: Git, max = 4): Git {
  let running = 0;
  let pumping = false;
  const queue: (() => void)[] = [];
  const pump = () => {
    pumping = false;
    if (running >= max) return;
    queue.shift()?.();
    next();
  };
  const next = () => {
    if (pumping || running >= max || !queue.length) return;
    pumping = true;
    setImmediate(pump);
  };
  return (repoDir, args, input) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        running++;
        g(repoDir, args, input)
          .then(resolve, reject)
          .finally(() => {
            running--;
            next();
          });
      });
      next();
    });
}

/** Ledger rows of a spine text that read done, by id. */
export const doneRows = (markdown: string) => new Set(parseDoc(markdown).ledger.filter((r) => isDoneStatus(r.status)).map((r) => r.id));

/** doneRows by git object id (content-addressed, so never stale): a spine's blob is parsed once, not per batch. */
const doneByOid = new Map<string, Set<string>>();
const doneRowsOf = (blob: { oid: string; text: string }) => {
  let d = doneByOid.get(blob.oid);
  if (d) return d;
  d = doneRows(blob.text);
  doneByOid.set(blob.oid, d);
  if (doneByOid.size > 2000) doneByOid.delete(doneByOid.keys().next().value!);
  return d;
};

/** UTC midnight of `now`. */
export const dayStart = (now: number) => new Date(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z").toISOString();

/**
 * blobs (object id + text) by `<rev>:<path>` from one `git cat-file --batch` (undefined = missing). Sizes are
 * bytes, so the output is walked as UTF-8 bytes; a header that does not parse ends the walk (the rest read as missing).
 */
export function parseCatFile(out: string, specs: string[]): ({ oid: string; text: string } | undefined)[] {
  const buf = Buffer.from(out, "utf8");
  const blobs: ({ oid: string; text: string } | undefined)[] = [];
  let at = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const header = buf.toString("utf8", at, nl);
    at = nl + 1;
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!m) {
      if (/ (missing|ambiguous)$/.test(header)) {
        blobs.push(undefined);
        continue;
      }
      break;
    }
    const size = Number(m[3]);
    blobs.push(m[2] === "blob" ? { oid: m[1], text: buf.toString("utf8", at, at + size) } : undefined);
    at += size + 1;
  }
  while (blobs.length < specs.length) blobs.push(undefined);
  return blobs;
}

/**
 * last commit and rows done today of many spines of one repo, in three git processes whatever the count: one
 * `git log --cc --name-only -- <every spine>` (the first commit naming a path is its last; `--cc` keeps merges that
 * resolved a spine, same answer as `git log -1 -- <spine>`), one `rev-list --before=<UTC midnight>`, and one
 * `cat-file --batch` for every spine at HEAD and at midnight. Was 3-4 processes per spine: ~190 per cold
 * /api/moving-now, and starting a child from the ~240 MB console is synchronous, so every other request stalled ~4 s
 * (measure 2026-10-28, cause 1).
 */
export async function activityBatch(g: Git, repoDir: string, rels: string[], now: number): Promise<Map<string, { lastCommitAt?: string; doneToday: string[] }>> {
  const [log, beforeOut] = await Promise.all([
    g(repoDir, ["-c", "core.quotePath=false", "log", "--cc", "--format=%x01%cI", "--name-only", "HEAD", "--", ...rels]).catch(() => ""),
    g(repoDir, ["rev-list", "-1", `--before=${dayStart(now)}`, "HEAD"]).catch(() => ""),
  ]);
  const last = new Map<string, string>();
  let date = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("\x01")) date = line.slice(1).trim();
    else if (line.trim() && date && !last.has(line.trim())) last.set(line.trim(), date);
  }
  const before = beforeOut.trim();
  const specs = rels.flatMap((r) => (before ? [`HEAD:${r}`, `${before}:${r}`] : [`HEAD:${r}`]));
  const blobs = parseCatFile(await g(repoDir, ["cat-file", "--batch"], specs.join("\n") + "\n").catch(() => ""), specs);
  const out = new Map<string, { lastCommitAt?: string; doneToday: string[] }>();
  // parsing one large spine takes up to ~90 ms on the main server (A/B 2026-11-01), so requests get a turn after each parse; a spine
  // whose blob is the same at HEAD and at midnight changed nothing today and is not parsed at all (most spines, most days)
  const turn = () => new Promise((r) => setImmediate(r));
  const parse = async (blob: { oid: string; text: string }) => {
    if (doneByOid.has(blob.oid)) return doneByOid.get(blob.oid)!;
    await turn();
    return doneRowsOf(blob);
  };
  for (const [i, rel] of rels.entries()) {
    const head = blobs[before ? 2 * i : i];
    const then = before ? blobs[2 * i + 1] : undefined;
    const lastCommitAt = last.get(rel);
    let doneToday: string[] = [];
    if (head && !(then && then.oid === head.oid)) {
      const was = then ? await parse(then) : new Set<string>();
      doneToday = [...(await parse(head))].filter((id) => !was.has(id));
    }
    out.set(rel, { ...(lastCommitAt ? { lastCommitAt } : {}), doneToday });
  }
  return out;
}

/**
 * Rows of the spine at `rel` that read done now (HEAD) and did not at UTC midnight (the last commit before it; a spine
 * created today counts every done row). Last commit on the spine too.
 * cached per repo HEAD (read from the.git files, no spawn): the same HEAD answers from the cache with no git at
 * all; a moved HEAD costs one `git diff --name-only old new` per repo, and only spines that diff names are recomputed.
 * When HEAD cannot be read, the old TTL applies.
 * the spines to compute are gathered for one turn of the event loop and computed per repo in one
 * `activityBatch` (3 git processes, not 3-4 per spine).
 */
export function spineActivity(g: Git = limitGit(git), ttlMs = 60_000, head: (repoDir: string) => string | undefined = headOf) {
  type Activity = { lastCommitAt?: string; doneToday: string[] };
  const cache = new Map<string, { at: number; head?: string; value: Promise<Activity> }>();
  const diffs = new Map<string, Promise<Set<string> | undefined>>();
  const changedBetween = (repoDir: string, from: string, to: string) => {
    const k = `${repoDir}\0${from}\0${to}`;
    let d = diffs.get(k);
    if (!d) {
      d = g(repoDir, ["diff", "--name-only", from, to])
        .then((out) => new Set(out.split("\n").map((l) => l.trim()).filter(Boolean)))
        .catch(() => undefined);
      diffs.set(k, d);
      if (diffs.size > 200) diffs.delete(diffs.keys().next().value!);
    }
    return d;
  };
  type Pending = { rels: Map<string, { resolve: (a: Activity) => void; reject: (e: unknown) => void }[]> };
  const pending = new Map<string, Pending>();
  const compute = (repoDir: string, rel: string, now: number): Promise<Activity> =>
    new Promise((resolve, reject) => {
      const day = dayStart(now);
      const k = `${repoDir}\0${day}`;
      let p = pending.get(k);
      if (!p) {
        const batch: Pending = { rels: new Map() };
        pending.set(k, batch);
        p = batch;
        setImmediate(() => {
          pending.delete(k);
          const rels = [...batch.rels.keys()];
          activityBatch(g, repoDir, rels, now).then(
            (got) => rels.forEach((r) => batch.rels.get(r)!.forEach((w) => w.resolve(got.get(r) ?? { doneToday: [] }))),
            (e) => rels.forEach((r) => batch.rels.get(r)!.forEach((w) => w.reject(e))),
          );
        });
      }
      const waiters = p.rels.get(rel) ?? [];
      waiters.push({ resolve, reject });
      p.rels.set(rel, waiters);
    });
  return (repoDir: string, relIn: string, now = Date.now()) => {
    const rel = relIn.replace(/^\.\//, "");
    const day = dayStart(now);
    const key = `${repoDir}\0${rel}\0${day}`;
    const h = head(repoDir);
    const hit = cache.get(key);
    let value: Promise<Activity>;
    if (hit && h && hit.head === h) return hit.value;
    if (hit && !h && !hit.head && now - hit.at < ttlMs) return hit.value;
    if (hit && h && hit.head) {
      const prev = hit.value;
      const from = hit.head;
      value = changedBetween(repoDir, from, h).then((changed) => (changed && !changed.has(rel) ? prev : compute(repoDir, rel, now)));
    } else value = compute(repoDir, rel, now);
    cache.set(key, { at: now, head: h, value });
    for (const k of cache.keys()) if (!k.endsWith(`\0${day}`)) cache.delete(k);
    return value;
  };
}

// ---------- (c) Moving now ----------

export interface MovingEpic {
  milestoneId: string;
  repo: string;
  path: string;
  title: string;
  status: string;
  /** Running child runs whose row is in this epic. */
  workers: { ticket: string; runId: string; persona: string }[];
  lastCommitAt?: string;
  doneToday: string[];
  ready: string[];
  /** Every row id of the epic's own ledger. */
  rows: string[];
}

/** The strip's rows of one milestone: its going epics (ready / active), plus any epic with a worker or a row done today. */
export function movingEpics(
  m: Pick<Milestone, "id" | "repo">,
  epics: EpicRows[],
  claims: Claim[],
  activity: Record<string, { lastCommitAt?: string; doneToday: string[] }>,
): MovingEpic[] {
  return epics
    .map((e) => {
      const rows = new Set(e.rows);
      const workers = claims.filter((c) => rows.has(c.ticket)).map((c) => ({ ticket: c.ticket, runId: c.runId, persona: c.persona }));
      const a = activity[e.path] ?? { doneToday: [] };
      const claimed = new Set(workers.map((w) => w.ticket));
      return {
        milestoneId: m.id,
        repo: m.repo,
        path: e.path,
        title: e.title,
        status: statusWordOf(e.status) ?? e.status,
        workers,
        ...(a.lastCommitAt ? { lastCommitAt: a.lastCommitAt } : {}),
        doneToday: a.doneToday.filter((id) => rows.has(id)),
        ready: e.ready.filter((id) => !claimed.has(id)),
        rows: e.rows,
      };
    })
    .filter((e) => isGoing(e.status) || e.workers.length || e.doneToday.length);
}

/**
 * one line per spine. A spine that is both a child in one milestone's tree and the root of its own milestone
 * (under the code repo root milestone and as "the social product launch", 2026-11-01) came back from both. Kept: the
 * line of the milestone whose own spine it is (else the first); workers and rows done today merged from every copy.
 */
export function dedupeMoving(epics: MovingEpic[], milestones: Pick<Milestone, "id" | "path">[] = []): MovingEpic[] {
  const own = new Map(milestones.map((m) => [m.id, plainPath(m.path ?? "")]));
  const byKey = new Map<string, MovingEpic>();
  for (const e of epics) {
    const k = `${e.repo.toLowerCase()}\0${plainPath(e.path)}`;
    const had = byKey.get(k);
    if (!had) {
      byKey.set(k, e);
      continue;
    }
    const keep = own.get(e.milestoneId) === plainPath(e.path) && own.get(had.milestoneId) !== plainPath(had.path) ? e : had;
    const other = keep === e ? had : e;
    const runs = new Set(keep.workers.map((w) => w.runId));
    const claimed = new Set([...keep.workers, ...other.workers].map((w) => w.ticket));
    byKey.set(k, {
      ...keep,
      workers: [...keep.workers, ...other.workers.filter((w) => !runs.has(w.runId))],
      doneToday: [...new Set([...keep.doneToday, ...other.doneToday])],
      ready: keep.ready.filter((id) => !claimed.has(id)),
      ...(keep.lastCommitAt || other.lastCommitAt ? { lastCommitAt: [keep.lastCommitAt, other.lastCommitAt].filter(Boolean).sort().pop() } : {}),
    });
  }
  return [...byKey.values()];
}

/** the strip's order: lines with a worker first (more workers first), then the most recent commit; stable. */
export const sortMoving = (epics: MovingEpic[]) =>
  [...epics].sort((a, b) => b.workers.length - a.workers.length || (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""));

/** `?limit=` of /api/moving-now: a positive whole number, else (absent, `all`, junk) no limit. */
export function movingLimit(q: string | undefined): number | undefined {
  const n = Number(q);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : undefined;
}

// ---------- (b) stall watch ----------

export type StallVerdict = "fire" | "skip";
export interface StallEval {
  milestoneId: string;
  repo: string;
  path: string;
  title: string;
  verdict: StallVerdict;
  reason: string;
  /** the open asks the epic's open rows wait on (its own, or `[waits on …]` references), when it cannot move. */
  waitsOn?: EpicWait[];
  /** The Delivery manager assignment a fire wakes. */
  assignmentId?: string;
}

/** one open ask an epic waits on: its code (`<repo>/<code>` when another repo's), who answers it, the rows it holds. */
export interface EpicWait {
  code: string;
  who: string;
  rows: string[];
}

const repoName = (repo: string) => repoKey(repo.split("/").pop()!); // old and new name of a renamed repo are one
const plainPath = (p: string) => p.replace(/^\.\//, "");

/**
 * per epic path, the open asks its open rows wait on, from the console's one resolver (`waitingOnJordi`, /
 * D19): an open ask in the epic's own file, or an open canonical ask whose `referencedBy` names this milestone's
 * file (`[waits on <code> row <id>]`, interim `waits on <repo>/<CODE>`, or the ask's `unblocks:`). A reference from a
 * closed (superseded or green) row of the tree does not hold anything.
 */
export function epicWaits(m: Pick<Milestone, "id" | "repo">, tree: Tree, items: WaitingItem[]): Record<string, EpicWait[]> {
  const nodes = new Map<string, TreeNode>();
  const index = (n: TreeNode) => {
    nodes.set(n.key, n);
    n.children.forEach(index);
  };
  index(tree.root);
  const done = (key?: string) => {
    const n = key ? nodes.get(key) : undefined;
    return !!n && n.kind === "ticket" && (isClosed(n) || n.color === "green");
  };
  const out: Record<string, EpicWait[]> = {};
  const add = (path: string, it: WaitingItem, row?: string) => {
    const code = it.repo && repoName(it.repo) !== repoName(m.repo) ? `${it.repo}/${it.code}` : it.code!;
    const list = (out[plainPath(path)] ??= []);
    const w = list.find((x) => x.code === code) ?? (list.push({ code, who: it.who || ownerName(), rows: [] }), list[list.length - 1]);
    if (row && !w.rows.includes(row)) w.rows.push(row);
  };
  for (const it of items) {
    if (it.source !== "ask" || it.state !== "open" || !it.code) continue;
    if (it.milestoneId === m.id && it.path) add(it.path, it, it.row);
    for (const r of it.referencedBy ?? []) if (r.milestoneId === m.id && !done(r.nodeKey)) add(r.path, it, r.row);
  }
  return out;
}

/** `waits on (the owner) for; …` */
export const waitsReason = (waits: EpicWait[]) =>
  waits.map((w) => `waits on ${w.code} (${w.who})${w.rows.length ? ` for ${w.rows.join(", ")}` : ""}`).join("; ");

/** A seat a worker could start on now (not limited, logged in). Unknown usage counts: `pick` decides headroom. */
export const freeSeat = (seats: Seat[] | undefined) => !!seats?.some((s) => !s.limited && s.status !== "logged_out");

/** The milestone's Delivery manager assignment, if any (enabled or not). */
export function managerOf(assignments: Assignment[], personaName: (id: string) => string | undefined): Assignment | undefined {
  return assignments.find((a) => isDeliveryManager(personaName(a.personaId)));
}

const lastStallFire = (runs: Run[], epicPath: string) =>
  runs
    .filter((r) => r.instructionsBy === STALL_WATCH_BY && (r.instructions ?? "").includes(epicPath))
    .map((r) => r.startedAt)
    .sort()
    .pop();

/**
 * Rows whose newest worker run (a child run; its summary names the row) reported monitoring with a nextCheckAt still
 * ahead: row → nextCheckAt. A wake's own summary names many rows, so only child runs count.
 */
export function monitoringRows(runs: Pick<Run, "outcome" | "nextCheckAt" | "summary" | "startedAt" | "parentRunId">[], now: number): Map<string, string> {
  const newest = new Map<string, Pick<Run, "outcome" | "nextCheckAt" | "startedAt">>();
  for (const r of runs) {
    if (!r.parentRunId) continue;
    const row = rowOf(r.summary ?? "");
    if (!row) continue;
    const had = newest.get(row);
    if (!had || had.startedAt < r.startedAt) newest.set(row, r);
  }
  const out = new Map<string, string>();
  for (const [row, r] of newest) if (r.outcome === "monitoring" && r.nextCheckAt && Date.parse(r.nextCheckAt) > now) out.set(row, r.nextCheckAt);
  return out;
}

/**
 * Pure: the stall watch's verdict for one epic. `runs` = the milestone's runs (newest first or not); `now` in ms.
 * Fires only when every condition holds; otherwise the first failing one is the reason (the dry list shows it).
 */
export function stallVerdict(
  i: {
    milestone: Pick<Milestone, "id" | "repo" | "paused" | "settledAt">;
    epic: MovingEpic;
    manager?: Assignment;
    managerName?: string;
    runs: Run[];
    seats?: Seat[];
    /** the open asks the epic's open rows wait on (epicWaits), named as the reason it cannot move. */
    waits?: EpicWait[];
    /** effort follows priority: the pursuit carrying this epic sets the patience; parked: never nudged. */
    effort?: { parked: boolean; stallHours: number; pursuitName: string } | null;
  },
  now: number,
): StallEval {
  const ef = i.effort;
  const stallMs = ef && !ef.parked && ef.stallHours > 0 ? ef.stallHours * 3600_000 : STALL_MS;
  const patience = `${Math.round((stallMs / 3600_000) * 10) / 10} h`;
  const { epic: e, manager: a } = i;
  const base = { milestoneId: i.milestone.id, repo: i.milestone.repo, path: e.path, title: e.title };
  const skip = (reason: string): StallEval => ({ ...base, verdict: "skip", reason });
  const waits = i.waits?.length ? i.waits : undefined;
  const held = (reason: string): StallEval => (waits ? { ...skip(`${reason}${reason ? " · " : ""}${waitsReason(waits)}`), waitsOn: waits } : skip(reason || "no unclaimed ready rows"));
  if (!isGoing(e.status)) return held(`status ${e.status}: not ready/active`);
  if (!e.ready.length) return held("");
  if (e.workers.length) return skip(`worker running (${e.workers.map((w) => w.ticket).join(", ")})`);
  // a ready row whose run is monitoring a timed check still ahead is waiting, not idle.
  const watched = monitoringRows(i.runs, now);
  const readyNow = e.ready.filter((id) => !watched.has(id));
  if (!readyNow.length) return skip(`ready rows wait on a timed check (${e.ready.map((id) => `${id} until ${watched.get(id)}`).join(", ")})`);
  if (i.milestone.settledAt || i.milestone.paused) return skip("milestone paused or settled");
  if (ef?.parked) return skip(`pursuit ${ef.pursuitName} is parked: no nudges`);
  if (!a) return skip("no Delivery manager assigned");
  if (!a.enabled || a.parkedAt) return skip(`${i.managerName ?? "Delivery manager"} is switched off or parked: only ${ownerName()}'s Run now wakes it (L-10)`);
  const mine = i.runs.filter((r) => r.milestoneId === i.milestone.id || r.assignmentId === a.id);
  if (mine.some((r) => r.outcome === "running" && !r.parentRunId && r.kind === "wake")) return skip("a wake of this milestone is running");
  const rows = new Set(e.rows);
  const lastWorker = mine
    .filter((r) => r.parentRunId && rows.has(rowOf(r.summary) ?? ""))
    .map((r) => r.endedAt ?? r.startedAt)
    .sort()
    .pop();
  const last = [e.lastCommitAt, lastWorker].filter((x): x is string => !!x).map((x) => Date.parse(x)).filter(Number.isFinite);
  const moved = last.length ? Math.max(...last) : undefined;
  if (moved !== undefined && now - moved < stallMs) return skip(`moved ${Math.round((now - moved) / 60_000)} min ago (commit or worker)`);
  const fired = lastStallFire(mine, e.path);
  if (fired && now - Date.parse(fired) < stallMs) return skip(`stall watch already fired at ${fired} (once per epic per ${patience})`);
  if (!freeSeat(i.seats)) return skip("no free seat");
  const idle = moved === undefined ? "no commit on record" : `no worker or commit for ${Math.round((now - moved) / 3600_000 * 10) / 10} h`;
  const rank = ef ? ` (${ef.pursuitName}: nudged after ${patience})` : "";
  return { ...base, verdict: "fire", reason: `${readyNow.length} ready row${readyNow.length === 1 ? "" : "s"} (${readyNow.slice(0, 5).join(", ")}), ${idle}${rank}`, assignmentId: a.id };
}

/** The Run now note for one milestone's stalled epics (one Run now per milestone per tick). */
export function stallNote(fires: StallEval[]): string {
  return [
    `Stall watch (root L-26): these epics have ready rows, a free seat and no worker or commit for 2 h:`,
    ...fires.map((f) => `- ${f.path} — ${f.title}: ${f.reason}`),
    "Dispatch their ready, unblocked rows now (one worker per row), or name the one blocker per epic in a `blocker:` line.",
  ].join("\n");
}
