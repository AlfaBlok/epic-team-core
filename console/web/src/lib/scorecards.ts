import type { ScorecardNode, ScorecardQueueRow, ScorecardsBody } from "@/api/pursuit-types";

/**
 * The scorecards' inbox and queue (the owner vn_fe52ef4a 2026-11-12 22:19Z): every
 * sidebar entry is a scorecard, nested; each has its own inbox (open asks and review cards) and queue (rows ready,
 * running, waiting), and one aggregated scorecard on top holds the combined inbox, sortable across scorecards.
 * Pure functions: GET /api/scorecards names each scorecard's spines and each spine's codes; an inbox item belongs
 * to a scorecard when its spine (its path, or the spine that writes its code) is in that scorecard's subtree.
 */

/** "app", "owner/app", "a-p-p" → one key. */
export const repoKey = (r?: string) => (r ?? "").split("/").pop()!.toLowerCase().replace(/[-_]/g, "");
const spineOf = (k: string) => {
  const i = k.indexOf(":");
  return { repo: repoKey(k.slice(0, i)), path: k.slice(i + 1).replace(/^\.\//, "") };
};
const keyOf = (repo: string | undefined, path: string) => `${repoKey(repo)}:${path.replace(/^\.\//, "")}`;

/** what an inbox item says about where it lives (a review card, an open ask, a status row). */
export interface Placeable {
  repo?: string;
  path?: string;
  code?: string;
  ref?: string;
  spine?: { path: string };
}

export interface ScorecardIndex {
  /** "repo:code" → "repo:path" of the spine that writes it. */
  codes: Map<string, string>;
  /** node id → its subtree's spine keys (normalised). */
  scope: Map<string, Set<string>>;
  /** node id → node, and its pursuit (the top-level scorecard). */
  byId: Map<string, ScorecardNode>;
  pursuitOf: Map<string, ScorecardNode>;
  parentOf: Map<string, ScorecardNode>;
}

export function indexScorecards(body: ScorecardsBody | undefined): ScorecardIndex {
  const codes = new Map<string, string>();
  const scope = new Map<string, Set<string>>();
  const byId = new Map<string, ScorecardNode>();
  const pursuitOf = new Map<string, ScorecardNode>();
  const parentOf = new Map<string, ScorecardNode>();
  for (const [k, s] of Object.entries(body?.spineInfo ?? {})) {
    const { repo, path } = spineOf(k);
    for (const c of s.codes) if (!codes.has(`${repo}:${c}`)) codes.set(`${repo}:${c}`, `${repo}:${path}`);
  }
  const walk = (n: ScorecardNode, top: ScorecardNode, parent?: ScorecardNode) => {
    byId.set(n.id, n);
    pursuitOf.set(n.id, top);
    if (parent) parentOf.set(n.id, parent);
    scope.set(
      n.id,
      new Set(
        n.spines.map((k) => {
          const s = spineOf(k);
          return `${s.repo}:${s.path}`;
        }),
      ),
    );
    n.children.forEach((c) => walk(c, top, n));
  };
  (body?.nodes ?? []).forEach((n) => walk(n, n));
  return { codes, scope, byId, pursuitOf, parentOf };
}

/** the spine an item lives in ("repo:path"), or undefined when the scorecards do not know it. */
export function spineOfItem(ix: ScorecardIndex, i: Placeable): string | undefined {
  const path = i.spine?.path ?? i.path;
  if (path && path.endsWith(".md")) {
    const k = keyOf(i.repo, path);
    for (const set of ix.scope.values()) if (set.has(k)) return k;
  }
  const code = i.code ?? i.ref;
  if (code) {
    if (i.repo) return ix.codes.get(`${repoKey(i.repo)}:${code}`);
    for (const [k, v] of ix.codes) if (k.endsWith(`:${code}`)) return v;
  }
  return undefined;
}

/** the item belongs to this scorecard (its spine is in the scorecard's subtree). */
export function inScorecard(ix: ScorecardIndex, nodeId: string, i: Placeable): boolean {
  const k = spineOfItem(ix, i);
  return !!k && !!ix.scope.get(nodeId)?.has(k);
}

/** the first scorecard (in his order) an item belongs to, and the deepest one inside it that holds it. */
export function homeOf(ix: ScorecardIndex, nodes: ScorecardNode[], i: Placeable): { pursuit: ScorecardNode; node: ScorecardNode } | undefined {
  const k = spineOfItem(ix, i);
  if (!k) return undefined;
  for (const p of nodes) {
    if (!ix.scope.get(p.id)?.has(k)) continue;
    let node = p;
    for (;;) {
      const next = node.children.find((c) => ix.scope.get(c.id)?.has(k));
      if (!next) break;
      node = next;
    }
    return { pursuit: p, node };
  }
  return undefined;
}

/** one line of a scorecard's inbox, slim: what it is, where, how long it has waited. */
export interface InboxRow {
  id: string;
  kind: "ask" | "review";
  title: string;
  code?: string;
  /** when it started waiting (ISO); undefined = unknown (sorts last for "longest waiting", first never). */
  since?: string;
  /** the server's priority (the milestone's place, his level); lower first. */
  priority?: number;
  pursuit?: ScorecardNode;
  node?: ScorecardNode;
}

export type InboxSort = "priority" | "newest" | "waiting";
export const INBOX_SORTS: { id: InboxSort; label: string }[] = [
  { id: "priority", label: "Priority" },
  { id: "newest", label: "Newest" },
  { id: "waiting", label: "Longest waiting" },
];

const t = (s?: string) => (s ? Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s) || 0 : 0);
const rankOf = (r: InboxRow) => (r.pursuit ? (r.pursuit.rank ?? 1e6) : 1e7);

/** Priority: his pursuit order first (an item in no scorecard last), then the server's priority, then oldest first. */
export function sortInbox(rows: InboxRow[], sort: InboxSort): InboxRow[] {
  const out = [...rows];
  if (sort === "newest") return out.sort((a, b) => t(b.since) - t(a.since) || a.title.localeCompare(b.title));
  if (sort === "waiting") return out.sort((a, b) => (t(a.since) || 9e15) - (t(b.since) || 9e15) || a.title.localeCompare(b.title));
  return out.sort((a, b) => rankOf(a) - rankOf(b) || (a.priority ?? 9e9) - (b.priority ?? 9e9) || (t(a.since) || 9e15) - (t(b.since) || 9e15));
}

/** a scorecard's queue: its subtree's rows ready, running and waiting, each with the epic that holds it. */
export function queueOf(body: ScorecardsBody | undefined, node: ScorecardNode | undefined): (ScorecardQueueRow & { epic?: string; epicCode?: string; repo: string; path: string })[] {
  if (!body || !node) return [];
  const seen = new Set<string>();
  const out: (ScorecardQueueRow & { epic?: string; epicCode?: string; repo: string; path: string })[] = [];
  for (const k of node.spines) {
    const s = body.spineInfo[k];
    if (!s) continue;
    for (const r of s.queue) {
      const id = `${repoKey(s.repo)}:${r.code}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...r, epic: s.title, epicCode: s.code, repo: s.repo, path: s.path });
    }
  }
  return out;
}

/** how long ago, in plain words ("3 h", "2 d"); empty when unknown. */
export function waitedFor(since: string | undefined, now = Date.now()): string {
  const at = t(since);
  if (!at) return "";
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/**
 * The one name of these goal sets, in both skins (the owner vn_fd4f7a7a: the name is not decided, "scorecard", "OKR" or
 * another; asks him with one decide card). Every screen reads it from here: renaming is this one change.
 */
// the owner 2026-11-13, "A yes, build as shown": the screen shows his objectives, "All objectives" on top, as the
// mock-up named them; the word for a set as a whole stays this one setting until he names it.
export const SET_NAME = { one: "Objective", many: "Objectives", all: "All objectives" } as const;
/** a neutral address that survives the rename. */
export const SCORECARDS_PATH = "sets";
export const SCORECARD_PATH = `${SCORECARDS_PATH}/:id`;
/** the Products section: each product defined once, /products and /products/<id>. */
export const PRODUCTS_PATH = "products";
export const PRODUCT_DEF_PATH = `${PRODUCTS_PATH}/:id`;
export const productHref = (id: string, tab?: "kit") => `/${PRODUCTS_PATH}/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ""}`;
export const scorecardHref = (id?: string, tab?: string) => `/${SCORECARDS_PATH}${id ? `/${encodeURIComponent(id)}` : ""}${tab && tab !== "numbers" ? `?tab=${tab}` : ""}`;
