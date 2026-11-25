import { homeWorld } from "./identity.js";

/**
 * The owner's inbox is fast right after a release too.
 *
 * Releases go out every ~10 min and each restarts the console; one first load after a release took
 * 12.2 s (sidebar 11.7 s, budget 2 s) while the new process built its trees, scorecards and lists cold and its own
 * start-up warmers took the one thread. Now, right after it listens, the console asks itself for exactly the reads
 * the inbox and the sidebar make on their first draw (the same GETs, in parallel, as his browser does) before
 * anything else warms, and repeats that until one whole pass answers under 2 s. Only then do the other warmers (the
 * milestone trees) start. /api/health shows the state; deploy.sh waits for `warm` and times the same reads itself
 * before it calls a release healthy (else it rolls back).
 */

/** the GETs the inbox page and the sidebar make on their first draw (a cold load of /inbox at 1280 px, 22 Nov). */
export function inboxFirstDraw(world = homeWorld()): string[] {
  return [
    "/api/waiting-on-owner?includeSuperseded=true&view=list",
    "/api/status",
    "/api/review-items",
    "/api/review-items?state=snoozed",
    "/api/inbox/team-cards",
    "/api/laptop",
    "/api/priority-mode",
    "/api/me",
    "/api/counts",
    "/api/counts/worlds",
    "/api/milestones",
    "/api/scorecards",
    "/api/presses/answered",
    "/api/pages/pinned",
    "/api/assignments",
    "/api/personas",
    "/api/voice/state",
    `/api/tenants/${world}/campaigns`,
    `/api/tenants/${world}/social/messages`,
  ];
}

export const WARM_BUDGET_MS = 2_000;

export interface InboxWarmState {
  state: "off" | "warming" | "warm" | "slow";
  /** the reads it warms, for deploy.sh to time the same ones */
  paths: string[];
  budgetMs: number;
  /** the last pass: all reads in parallel, wall time */
  lastMs?: number;
  passes: number;
  /** ms from the start of the warm-up until a pass under budget (or until it gave up) */
  tookMs?: number;
  /** reads that failed in the last pass */
  failed?: string[];
  at?: string;
}

let current: InboxWarmState = { state: "off", paths: [], budgetMs: WARM_BUDGET_MS, passes: 0 };
export const inboxWarmHealth = (): InboxWarmState => current;

/**
 * the pause after pass `n` (1-based): 1, 2, 4, 8, 16 s, then 20 s. On a busy host (load 11 to 16 on 4 cores)
 * a pass took 20 to 60 s and the next began 1 s later, so for 3 min after each release the console kept asking itself
 * for 19 reads at once while his browser waited behind them. The first pass fills the caches; later passes only time
 * them, so they back off. `fixed` (tests) replaces the whole schedule.
 */
export const pauseAfter = (n: number, fixed?: number): number => fixed ?? Math.min(20_000, 1_000 * 2 ** Math.max(0, n - 1));

/**
 * warm the first-draw reads: a pass is every path at once; passes repeat (backing off, pauseAfter) until one is under budget or
 * `maxMs` passed. Resolves with the final state (never throws).
 */
export async function warmInbox(o: {
  base: string;
  paths?: string[];
  budgetMs?: number;
  maxMs?: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => number;
  pauseMs?: number;
}): Promise<InboxWarmState> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const paths = o.paths ?? inboxFirstDraw();
  const budget = o.budgetMs ?? WARM_BUDGET_MS;
  const maxMs = o.maxMs ?? 180_000;
  const t0 = now();
  current = { state: "warming", paths, budgetMs: budget, passes: 0 };
  for (;;) {
    const p0 = now();
    const failed: string[] = [];
    await Promise.all(
      paths.map(async (p) => {
        try {
          const r = await f(`${o.base}${p}`, { headers: { "accept-encoding": "gzip" }, signal: AbortSignal.timeout(60_000) });
          await r.arrayBuffer();
          if (!r.ok) failed.push(`${p} ${r.status}`);
        } catch (e) {
          failed.push(`${p} ${(e as Error)?.name ?? "error"}`);
        }
      }),
    );
    const ms = now() - p0;
    const passes = current.passes + 1;
    const ok = ms < budget && !failed.length;
    const done = ok || now() - t0 >= maxMs;
    current = { state: ok ? "warm" : done ? "slow" : "warming", paths, budgetMs: budget, lastMs: ms, passes, ...(failed.length ? { failed } : {}), ...(done ? { tookMs: now() - t0, at: new Date().toISOString() } : {}) };
    if (done) {
      o.log?.(`inbox warm: ${paths.length} first-draw reads in ${ms} ms on pass ${passes}, ${((now() - t0) / 1000).toFixed(1)} s after the start${ok ? "" : ` (over the ${budget} ms budget${failed.length ? `, failed: ${failed.join(", ")}` : ""})`}`);
      return current;
    }
    await new Promise((r) => setTimeout(r, pauseAfter(passes, o.pauseMs)));
  }
}
