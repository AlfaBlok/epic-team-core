import type { TreeNode } from "../adapters/tree.js";
import { parseVerifiedAt } from "../freshness.js";
import { textHash } from "./skipUnchanged.js";

/**
 * the Delivery Manager rolls a parent spine's Current State up from its children. Found 2026-11-02 on memory
 * "the memory service launch": showed "Current State is 168 h behind its children" for a week while the DM woke every 2 h,
 * because the lag (narrativeAge) was UI-only, the wake prompt never named the root, and child commits that only
 * touched bookkeeping lines were not news. Now every spine in the milestone's tree that has children (the
 * root and any intermediate parent) is checked at wake time; a lagging one is a wake fingerprint part (news when it
 * appears or its children move) and the DM's prompt names it with the lag and the children to roll up from.
 */

/** A parent is due for a roll-up when its `Verified at` is at least this old and a child moved after it (CONSOLE_ROLLUP_LAG_HOURS). */
export const DEFAULT_ROLLUP_LAG_MS = 24 * 3_600_000;
/** A child commit within this of the parent's `Verified at` is the same wake (the parent written, then the child committed): not a lag. */
export const ROLLUP_GRACE_MS = 60 * 60_000;

export function rollupLagMsFromEnv(raw = process.env.CONSOLE_ROLLUP_LAG_HOURS): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n * 3_600_000 : DEFAULT_ROLLUP_LAG_MS;
}

/** Newest commit time (ISO) touching any of `paths` in the checkout `dir`; undefined when none or unreadable. */
export type LastCommitAt = (dir: string, paths: string[]) => Promise<string | undefined>;

export interface SpineLag {
  path: string;
  title: string;
  /** The parent's `Verified at` (ISO), absent when its Current State has none. */
  verifiedAt?: string;
  /** Newest commit on a descendant spine or ticket file (ISO). */
  childCommitAt: string;
  /** Child commit minus Verified at, hours (the console's "N h behind its children"); absent with no Verified at. */
  behindHours?: number;
  /** The direct child spines to roll up from (repo-relative paths). */
  children: string[];
}

/** The `Verified at:` value inside `## Current State` (bold and bulleted forms too); undefined when there is none. */
export function currentStateVerifiedAt(text: string): string | undefined {
  let inState = false;
  for (const line of text.split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      inState = h[1] === "##" && /^current state\b/i.test(h[2].trim());
      continue;
    }
    if (!inState) continue;
    const m = /^\s*(?:[-*]\s+)?(?:\*\*)?verified at(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

export const hasCurrentState = (text: string) => /^##\s+current state\b/im.test(text);

/** A finished or parked spine (first `Status:` line: done, closed, superseded, deferred, parked, archived) is never rolled up. */
const FINISHED = /^\s*(?:[-*]\s+)?(?:\*\*)?status(?:\*\*)?\s*:(?:\*\*)?\s*\**\s*(done|closed|superseded|deferred|parked|archived)\b/im;
export const isFinishedSpine = (text: string) => FINISHED.test(text);

/**
 * Is a parent due for a roll-up? A child moved more than ROLLUP_GRACE_MS after its `Verified at`, and that `Verified at`
 * is at least `lagMs` old (so a parent is rolled up at most about once per lag window, never on every child commit).
 * No `Verified at` at all with a child commit: due.
 */
export function rollupDue(verifiedAt: number | undefined, childCommitAt: number | undefined, now: number, lagMs = DEFAULT_ROLLUP_LAG_MS): boolean {
  if (childCommitAt === undefined) return false;
  if (verifiedAt === undefined) return true;
  return childCommitAt - verifiedAt > ROLLUP_GRACE_MS && now - verifiedAt >= lagMs;
}

const descendantPaths = (n: TreeNode, own: string, out: string[] = []): string[] => {
  for (const c of n.children) {
    if (c.path && c.path !== own) out.push(c.path);
    descendantPaths(c, own, out);
  }
  return out;
};

/** The nearest spine nodes below n with their own file (through grouping nodes and the spine's own rows). */
const childSpines = (n: TreeNode, own: string, out: string[] = []): string[] => {
  for (const c of n.children) {
    if (c.kind === "spine" && c.path && c.path !== own && c.path.endsWith(".md")) {
      if (!out.includes(c.path)) out.push(c.path);
    } else childSpines(c, own, out);
  }
  return out;
};

/**
 * Every spine of the tree with children (root first, then depth first) whose Current State lags them. `files` holds the
 * spine texts already read (repo-relative path → text); a spine without `## Current State`, or finished / parked, is left out.
 */
export async function spineLags(
  root: TreeNode,
  files: Map<string, string | undefined>,
  lastCommitAt: (paths: string[]) => Promise<string | undefined>,
  now = Date.now(),
  lagMs = DEFAULT_ROLLUP_LAG_MS,
): Promise<SpineLag[]> {
  // The tree repeats a spine as a link node (no children) wherever another spine references it; judge each path by
  // its fullest node (most descendants), in first-seen order (root first).
  const size = (n: TreeNode): number => n.children.reduce((k, c) => k + 1 + size(c), 0);
  const best = new Map<string, { node: TreeNode; size: number }>();
  const collect = (n: TreeNode) => {
    const p = n.path;
    if (n.kind === "spine" && p && p.endsWith(".md")) {
      const k = size(n);
      const had = best.get(p);
      if (!had || k > had.size) best.set(p, { node: n, size: k });
    }
    n.children.forEach(collect);
  };
  collect(root);
  const out: SpineLag[] = [];
  for (const [p, { node: n }] of best) {
    const text = files.get(p);
    const below = [...new Set(descendantPaths(n, p))];
    if (!text || !below.length || !hasCurrentState(text) || isFinishedSpine(text)) continue;
    const v = parseVerifiedAt(currentStateVerifiedAt(text));
    const at = await lastCommitAt(below).catch(() => undefined);
    const c = at ? Date.parse(at) : NaN;
    if (Number.isFinite(c) && rollupDue(v, c, now, lagMs))
      out.push({
        path: p,
        title: n.title,
        ...(v !== undefined ? { verifiedAt: new Date(v).toISOString(), behindHours: Math.round((c - v) / 3_600_000) } : {}),
        childCommitAt: new Date(c).toISOString(),
        children: childSpines(n, p),
      });
  }
  return out;
}

/**
 * The `rollup` wake part: "" when nothing lags (so fingerprints without a lag stay as they were), else a hash of the
 * lagging paths and their newest child commit. Not the lag in hours (that grows with the clock): the same lag seen by
 * the last real wake is not news again; a new lag, a child that moved again, or a roll-up done is.
 */
export const rollupPart = (lags: SpineLag[]): string =>
  lags.length ? textHash(lags.map((l) => `${l.path}@${l.childCommitAt}`).sort().join(",")) : "";

const day = (iso: string) => iso.slice(0, 16).replace("T", " ") + "Z";

/** The Delivery Manager's prompt section naming each lagging spine; undefined when none lags. */
export function rollupSection(lags: SpineLag[], milestonePath?: string): string | undefined {
  if (!lags.length) return undefined;
  return [
    "## Roll-up due: these Current States lag their children",
    "The console checked this milestone's tree at wake time. Each spine below has child spines or tickets that moved after its `Verified at`, " +
      "so its `## Current State` (what the console's header and the Epic Book show) no longer says where the work stands:",
    ...lags.map((l) => {
      const which = l.path === milestonePath ? "milestone root" : "parent";
      const lag = l.verifiedAt
        ? `Verified at ${day(l.verifiedAt)}, newest child commit ${day(l.childCommitAt)}: ${l.behindHours} h behind its children`
        : `no \`Verified at:\`, newest child commit ${day(l.childCommitAt)}`;
      return `- ${l.path} (${which}: ${l.title}): ${lag}${l.children.length ? `; children: ${l.children.join(", ")}` : ""}`;
    }),
    "In this wake, whatever else you do, roll each listed spine's `## Current State` up from its children, deepest first (a parent after the child spines under it): " +
      "read each child's Current State and Status, then rewrite the parent's `Last attempted:` / `Result:` as one line per child (its path, Status and where it stands, in a plain sentence a reader understands cold), " +
      "set `Waiting on:` and `Next action:` to what the children now wait on and do next, and `Verified at:` to now (ISO, UTC). " +
      "Your remit's \"update Current State\" means these spines too, not only the child you work. " +
      "When you move a child epic, update that child's own `Last attempted:` and `Verified at:` in the same wake. Commit and push the roll-up in this wake; it is not a restamp (the restamp rule does not apply).",
  ].join("\n");
}
