import type { Hono } from "hono";
import type { Store } from "../store.js";
import type { SpineWriter } from "../inbox/spineWrite.js";
import type { GitOut } from "../freshness.js";
import { computeClaims, expireLeaseText, statusBeforeClaimIn, type ClaimedRow } from "./rows.js";

/**
 * A worker claims its row with the EpicSpine
 * `spines.py --claim <row> --by <run>`: the row's Owner cell reads `<by> — claimed <UTC>, lease until <UTC>`. Its later
 * commits that name the row renew the lease (each one moves the end to that commit + the lease's length). When the
 * lease has run out, this sweep gives the row back through the one spine writer (L-45): Owner `unassigned (lease of
 * <by> expired …)`, Status back to what it was when the row was claimed (a fix worker's claim on a row in
 * review must not drop the owner's card), else `ready`; the Delivery Manager's normal wake re-dispatches a ready row. No schedule per project: one
 * console tick for every tracked repo.
 */
export interface ClaimView extends Omit<ClaimedRow, "dir"> {
  /** The lease's end counting the holder's commits that name the row. */
  liveUntil: string;
  /** Newest commit naming the row since the claim (UTC), if any. */
  lastCommitAt?: string;
  expired: boolean;
}

/**
 * only a row someone is working on can lose its lease: `active` or `claimed`. A row `blocked` on an open ask or
 * in `review` waits on someone else (the owner's merge, his verdict), so it never expires (the main server 2026-11-03:,
 * blocked on, was swept back to ready).
 */
export const LEASE_RUNS = /^(?:active|claimed)\b/i;

const ms = (s: string) => Date.parse(s.replace(/Z$/, ":00Z"));
const utc = (t: number) => new Date(t).toISOString().slice(0, 16) + "Z";

/** Newest commit (committer time) since `since` whose message names `ref` as a whole code. */
export async function lastCommitNaming(git: GitOut, dir: string, ref: string, since: string): Promise<number | undefined> {
  const out = await git(dir, ["log", `--since=${since}`, "--format=%ct%x1f%s%x1f%b%x1e"]).catch(() => "");
  const re = new RegExp(`(^|[^\\w-])${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
  let best: number | undefined;
  for (const rec of out.split("\x1e")) {
    const [ct, subj, body] = rec.trim().split("\x1f");
    if (!ct || !re.test(`${subj ?? ""}\n${body ?? ""}`)) continue;
    // the claim commit itself names the row: it renews nothing beyond the lease it wrote
    if (/^(Claim|Renew) /.test(subj ?? "")) continue;
    const t = Number(ct) * 1000;
    if (!best || t > best) best = t;
  }
  return best;
}

/**
 * the row's Status just before `by` claimed it: `spines.py --claim` sets Status `active` in a commit
 * `Claim <ref>: <by> …`; the spine as it stood in that commit's parent holds the status to give back.
 */
export async function statusBeforeClaim(git: GitOut, dir: string, file: string, ref: string, by: string): Promise<string | undefined> {
  const sha = (await git(dir, ["log", "-n", "1", "--format=%H", "-F", `--grep=Claim ${ref}: ${by}`, "--", file]).catch(() => "")).trim();
  if (!/^[0-9a-f]{7,}$/.test(sha)) return undefined;
  const before = await git(dir, ["show", `${sha}^:${file}`]).catch(() => "");
  return before ? statusBeforeClaimIn(before, ref) : undefined;
}

export function createLeases(o: { store: () => Pick<Store, "listMilestones">; reposRoot: string; writer?: SpineWriter; git: GitOut; now?: () => number; log?: (m: string) => void; wrote?: (dir: string) => void }) {
  const now = () => o.now?.() ?? Date.now();
  async function view(): Promise<(ClaimView & { dir: string })[]> {
    const out: (ClaimView & { dir: string })[] = [];
    for (const c of computeClaims(o.store(), o.reposRoot)) {
      const length = Math.max(0, ms(c.until) - ms(c.at));
      const last = await lastCommitNaming(o.git, c.dir, c.ref, c.at.replace(/Z$/, ":00Z"));
      const live = Math.max(ms(c.until), last !== undefined ? last + length : 0);
      out.push({ ...c, liveUntil: utc(live), ...(last !== undefined ? { lastCommitAt: utc(last) } : {}), expired: LEASE_RUNS.test(c.status) && live <= now() });
    }
    return out;
  }
  /** Give back every row whose lease ran out (one spine commit each). Returns what it wrote. */
  async function sweep(): Promise<{ ref: string; path: string; status: string; sha?: string; reason?: string }[]> {
    const done: { ref: string; path: string; status: string; sha?: string; reason?: string }[] = [];
    if (!o.writer) return done;
    for (const c of (await view()).filter((x) => x.expired)) {
      const at = utc(now());
      const back = await statusBeforeClaim(o.git, c.dir, c.path, c.ref, c.by);
      const to = back ?? "ready";
      const w = await o.writer.edit({
        repoDir: c.dir,
        path: c.path,
        label: c.ref,
        edit: (text) => {
          const t = expireLeaseText(text, c.ref, c.by, c.until, at, back);
          const word = to.replace(/[*`]/g, "").trim().split(/\s/)[0];
          return typeof t === "string"
            ? back
              ? { text: t, msg: `Lease expired ${c.ref}: ${c.by} (back to ${word}, as claimed)`, body: `${c.by} claimed ${c.ref} at ${c.at} while it was ${word}; the lease ran out at ${c.liveUntil} with no commit naming the row since${c.lastCommitAt ? ` ${c.lastCommitAt}` : ""}. The row keeps the status it had when it was claimed.` }
              : { text: t, msg: `Lease expired ${c.ref}: ${c.by} (back to ready, re-dispatch)`, body: `${c.by} claimed ${c.ref} at ${c.at}; the lease ran out at ${c.liveUntil} with no commit naming the row since${c.lastCommitAt ? ` ${c.lastCommitAt}` : ""}. The row is ready again; the Delivery Manager's next wake dispatches it.` }
            : t;
        },
      });
      if (w.status === "written" && w.sha) o.wrote?.(c.dir);
      if (w.status !== "written") o.log?.(`leases: ${c.ref} in ${c.repo}/${c.path}: ${w.status} ${w.reason ?? ""}`);
      done.push({ ref: c.ref, path: c.path, status: w.status, ...(w.sha ? { sha: w.sha } : {}), ...(w.reason ? { reason: w.reason } : {}) });
    }
    return done;
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = (everyMs: number) => {
    if (timer || everyMs <= 0) return;
    let busy = false;
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void sweep()
        .catch((e) => o.log?.(`leases: sweep failed: ${(e as Error).message}`))
        .finally(() => (busy = false));
    }, everyMs);
    timer.unref?.();
  };
  const stop = () => (timer && clearInterval(timer), (timer = undefined));
  return { view, sweep, start, stop };
}
export type Leases = ReturnType<typeof createLeases>;

/** GET /api/claims: who holds each row, and until when (the console shows the holder). */
export function mountClaims(api: Hono, leases: () => Leases) {
  api.get("/claims", async (c) => c.json((await leases().view()).map(({ dir: _d, ...x }) => x)));
}
