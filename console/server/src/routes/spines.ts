import path from "node:path";
import { Hono } from "hono";
import type { Milestone, Store } from "../store.js";
import { listRepos, resolveRepo, type Repo } from "../adapters/repos.js";
import { spinesIndex, type SpineNode, type SpinesRunner } from "../adapters/spines.js";
import { colorFor, subtree, type Tree, type TreeColor } from "../adapters/tree.js";

/**
 * browse any repo's spines (Spines page) and open any spine ad hoc, untracked, as a node view.
 * Ad hoc trees are built for a synthetic milestone `ADHOC_ID` so their node keys match /waiting-on-owner?repo=&path=.
 */
export const ADHOC_ID = "spine";

export interface SpineListItem {
  path: string;
  id: string;
  title: string;
  status: string;
  color: TreeColor;
  rollup: string;
  rollupColor: TreeColor;
  parent: string | null;
  depth: number;
  dod: { done: number; total: number };
  /** Open human asks (spines.py `waiting_on` entries not answered); 0 when the field is absent. */
  openAsks: number;
  /** Set when a console milestone tracks this spine. */
  milestoneId?: string;
  /** Goal docs spines.py found outside the tree: its reason. */
  orphan?: string;
}

export interface SpineListing {
  repo: string;
  remote?: string;
  root: string | null;
  nodes: SpineListItem[];
  fetchedAt: string;
  /** A background refresh is running: the list may change on the next read. */
  refreshing: boolean;
}

const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");

/** Spine path (repo-relative) → id of the milestone tracking it, for one checkout. */
export function trackedIn(reposRoot: string, store: Store, repo: Repo): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of store.listMilestones({ includeSettled: true })) {
    if (!m.path || resolveRepo(reposRoot, m.repo)?.path !== repo.path) continue;
    out[norm(m.path)] ??= m.id;
  }
  return out;
}

/** Open human asks of a spine: `waiting_on` entries not answered (field absent before skill 2026.10.21.1 → 0). */
export function openAsksOf(n: SpineNode): number {
  const w = (n as { waiting_on?: unknown }).waiting_on;
  return Array.isArray(w) ? w.filter((a: { state?: string } | null) => a && (a.state ?? "open") === "open").length : 0;
}

export function listingFrom(repo: Repo, s: { value: { root: string | null; nodes: SpineNode[]; orphans: { path: string; title: string; reason: string }[] }; at: number; refreshing: boolean }, tracked: Record<string, string>): SpineListing {
  const depth = new Map<string, number>();
  const nodes: SpineListItem[] = s.value.nodes.map((n) => {
    const d = n.parent && depth.has(norm(n.parent)) ? depth.get(norm(n.parent))! + 1 : 0;
    depth.set(norm(n.path), d);
    const rollup = n.rollup_status || n.status || "";
    return {
      path: n.path,
      id: n.id || path.basename(n.path, ".md"),
      title: n.title || path.basename(n.path, ".md"),
      status: n.status || "unknown",
      color: colorFor(n.status).color,
      rollup,
      rollupColor: colorFor(rollup).color,
      parent: n.parent,
      depth: d,
      dod: { done: n.dod.filter((i) => i.done).length, total: n.dod.length },
      openAsks: openAsksOf(n),
      ...(tracked[norm(n.path)] ? { milestoneId: tracked[norm(n.path)] } : {}),
    };
  });
  for (const o of s.value.orphans)
    nodes.push({
      path: o.path,
      id: path.basename(o.path, ".md"),
      title: o.title || path.basename(o.path, ".md"),
      status: "unknown",
      color: "grey",
      rollup: "",
      rollupColor: "grey",
      parent: null,
      depth: 0,
      dod: { done: 0, total: 0 },
      openAsks: 0,
      orphan: o.reason || "orphan",
      ...(tracked[norm(o.path)] ? { milestoneId: tracked[norm(o.path)] } : {}),
    });
  return { repo: repo.name, ...(repo.remote ? { remote: repo.remote } : {}), root: s.value.root, nodes, fetchedAt: new Date(s.at).toISOString(), refreshing: s.refreshing };
}

/** The synthetic milestone an ad hoc view is built for (never stored). */
export const adhocMilestone = (repo: Repo, rel: string, title?: string): Milestone => ({
  id: ADHOC_ID,
  title: title ?? path.basename(rel, ".md"),
  repo: repo.path,
  path: norm(rel),
  owner: "",
  paused: false,
  createdAt: new Date(0).toISOString(),
});

export function spinesRoutes(o: { reposRoot: string; store: Store; run?: SpinesRunner; treeFor: (m: Milestone) => Promise<Tree> }) {
  const r = new Hono();
  const index = o.run ? spinesIndex(o.run) : undefined;
  const err = (code: string, message: string) => ({ error: { code, message } });
  const repoNamed = (name: string) => listRepos(o.reposRoot).find((x) => x.name === name);

  r.get("/repos/:name/spines", async (c) => {
    const repo = repoNamed(c.req.param("name"));
    if (!repo) return c.json(err("not_found", `repo ${c.req.param("name")} not found`), 404);
    if (!index) return c.json(err("spines_unavailable", "EpicSpine spines.py is not installed on the console host"), 503);
    try {
      return c.json(listingFrom(repo, await index(repo.path), trackedIn(o.reposRoot, o.store, repo)));
    } catch (e) {
      return c.json(err("spines_failed", `spines.py failed for ${repo.name}: ${(e as Error).message.slice(0, 300)}`), 502);
    }
  });

  // Ad hoc node view: ?repo=<name>&path=<rel>[&nodeKey=]. Adds `repo` and `tracked` (spine path → milestone id).
  r.get("/spine-tree", async (c) => {
    const repo = repoNamed(c.req.query("repo") ?? "");
    const rel = c.req.query("path");
    if (!repo || !rel) return c.json(err("validation_error", "repo (a checkout name) and path are required"), 400);
    const tree = await o.treeFor(adhocMilestone(repo, rel, c.req.query("title") || undefined));
    const nodeKey = c.req.query("nodeKey");
    const out = nodeKey ? subtree(tree, nodeKey) : tree;
    if (!out) return c.json(err("not_found", `node ${nodeKey} not in this tree`), 404);
    return c.json({ ...out, repo: repo.name, ...(repo.remote ? { remote: repo.remote } : {}), tracked: trackedIn(o.reposRoot, o.store, repo) });
  });
  return r;
}
