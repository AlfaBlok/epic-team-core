import type { Hono, MiddlewareHandler } from "hono";
import type { Milestone, Store } from "../store.js";
import { resolveRepo } from "../adapters/repos.js";
import { deriveMilestone } from "../adapters/milestone.js";
import type { Tree, TreeNode } from "../adapters/tree.js";
import { createFreshness, gitOut, narrativeAge, type FreshnessOptions, type GitOut } from "../freshness.js";

/**
 * a push from anywhere (a T3 thread, a wake, the desk, another host) shows in the console (within
 * ~5 min, was 60 s) with no agent API call: `git ls-remote` of every tracked repo every 5 min (was 20 s), a pull at once
 * when main moved, then the read model re-reads that checkout (pulledSpines → readModel.dirty). Worst case ≈ 5 min poll
 * + pull + one read model pass (spines.py 13-23 s on the code repo). The 15-min background sync is only the fallback.
 */
export const FRESHNESS_POLL_MS = 5 * 60_000;
/**
 * the main server's agent slice was pinned by the console's own polling, so a repo is polled at most
 * every 5 min: the ls-remote tick above (was 20 s) and the pull on open (was 60 s; every milestone GET of a page the web
 * keeps polling). A push now shows within ~5 min; the Refresh button still pulls at once.
 */
export const FRESHNESS_OPEN_MAX_AGE_MS = 5 * 60_000;

/** pull on open, GET /milestones/:id/freshness, POST /milestones/:id/refresh, GET /freshness (Team footer). */
export interface FreshnessMount extends FreshnessOptions {
  /** Off (default in tests): no pull on open, no poll; the read endpoints still report what the checkout shows. */
  enabled?: boolean;
  /** ls-remote poll interval (default FRESHNESS_POLL_MS = 5 min; 0 = off). */
  pollMs?: number;
  /** true = GET /waiting-on-owner starts the pull on open but does not wait for it (it answers from the read model). */
  noWaitOn?: () => boolean;
}

export function mountFreshness(
  api: Hono,
  o: FreshnessMount & { store: Store; reposRoot: string; treeFor: (m: Milestone) => Promise<Tree> },
) {
  const git: GitOut = o.git ?? gitOut();
  const pollMs = o.pollMs ?? FRESHNESS_POLL_MS;
  // a repo pulled within the last poll interval (on open, run end, Refresh) is not asked again by the poll.
  // with the real git, HEAD and the upstream come from.git (a test's fake git keeps answering for itself)
  const fresh = createFreshness({ openMaxAgeMs: FRESHNESS_OPEN_MAX_AGE_MS, pollSkipMs: pollMs, ...o, git, headFromFiles: o.headFromFiles ?? !o.git });
  const dirOf = (m: Milestone | undefined) => (m ? resolveRepo(o.reposRoot, m.repo)?.path : undefined);
  /** Repos with an unsettled milestone (one poll per repo, not per milestone). */
  const liveDirs = () => o.store.listMilestones().flatMap((m) => dirOf(m) ?? []);
  if (o.enabled) fresh.start(pollMs, liveDirs);

  // Pull on open: GET of a milestone (summary, tree, waiting, status,...) when its repo's last pull is > 5 min old (was 60 s).
  const onOpen: MiddlewareHandler = async (c, next) => {
    if (o.enabled && c.req.method === "GET") {
      const id = c.req.param("id") ?? c.req.query("milestoneId");
      const dir = id ? dirOf(o.store.getMilestone(id)) : undefined;
      if (dir) await fresh.onOpen(dir);
    }
    await next();
  };
  api.use("/milestones/:id", onOpen);
  api.use("/milestones/:id/*", onOpen);
  api.use("/waiting-on-owner", async (c, next) => {
    if (!o.noWaitOn?.()) return onOpen(c, next);
    const id = o.enabled && c.req.method === "GET" ? c.req.query("milestoneId") : undefined;
    const dir = id ? dirOf(o.store.getMilestone(id)) : undefined;
    if (dir) void fresh.onOpen(dir).catch(() => undefined);
    await next();
  });

  const childPaths = (n: TreeNode, out: string[] = [], root = true): string[] => {
    if (!root && n.path) out.push(n.path);
    for (const c of n.children) childPaths(c, out, false);
    return out;
  };

  api.get("/milestones/:id/freshness", async (c) => {
    const m = o.store.getMilestone(c.req.param("id"));
    if (!m) return c.json({ error: { code: "not_found", message: `milestone ${c.req.param("id")} not found` } }, 404);
    const dir = dirOf(m);
    if (!dir) return c.json({ repos: [] });
    const repo = await fresh.status(dir);
    let narrative = {};
    try {
      const verifiedAt = m.path ? deriveMilestone(o.reposRoot, m).state?.verifiedAt : undefined;
      narrative = await narrativeAge(git, dir, verifiedAt, childPaths((await o.treeFor(m)).root));
    } catch {
      /* no tree: no narrative age */
    }
    return c.json({ ...repo, repos: [repo], narrative });
  });

  // Refresh: this milestone's repo (its child epics live in the same checkout: one tree per repo).
  api.post("/milestones/:id/refresh", async (c) => {
    const m = o.store.getMilestone(c.req.param("id"));
    if (!m) return c.json({ error: { code: "not_found", message: `milestone ${c.req.param("id")} not found` } }, 404);
    const dir = dirOf(m);
    if (!dir) return c.json({ error: { code: "no_repo", message: `repo ${m.repo} has no checkout here` } }, 409);
    const r = await fresh.refresh(dir);
    return c.json(r, r.rateLimited ? 429 : 200);
  });

  // Team footer: no pulls; the oldest 'synced' time over the repos with an unsettled milestone.
  api.get("/freshness", async (c) => {
    const repos = await Promise.all([...new Set(liveDirs())].map((d) => fresh.status(d)));
    const times = repos.flatMap((r) => (r.syncedAt ? [r.syncedAt] : [])).sort();
    return c.json({ repos, ...(times.length ? { oldestSyncedAt: times[0] } : {}) });
  });

  return fresh;
}
