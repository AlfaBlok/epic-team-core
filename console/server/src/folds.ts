import fs from "node:fs";
import path from "node:path";
import type { SpineNode } from "./adapters/spines.js";

/**
 * View-only folds: a small epic shown inside its parent instead of as its own epic.
 * One file per repo, `docs/epic-folds.json` ({ folds: [{ child, parent, why }] }, repo-relative spine paths). No spine is
 * moved, renamed or closed: the tree views (the Epic Book behind Every epic and each milestone's deck plan, the
 * scorecard tree) read the folds and draw the child under its fold parent, marked folded.
 */
export const FOLDS_FILE = "docs/epic-folds.json";

export interface EpicFold {
  child: string;
  parent: string;
  why?: string;
}

const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");

/** the repo's folds; [] when the file is missing or unreadable (a broken file never breaks a tree). */
export function readFolds(repoDir: string): EpicFold[] {
  try {
    return parseFolds(fs.readFileSync(path.join(repoDir, FOLDS_FILE), "utf8"));
  } catch {
    return [];
  }
}

/** the folds in a `docs/epic-folds.json` text; [] when it is not one. */
export function parseFolds(text: string | undefined): EpicFold[] {
  let raw: unknown;
  try {
    raw = text === undefined ? undefined : JSON.parse(text);
  } catch {
    return [];
  }
  const list = (raw as { folds?: unknown } | undefined)?.folds;
  if (!Array.isArray(list)) return [];
  const out: EpicFold[] = [];
  for (const f of list) {
    const child = typeof f?.child === "string" ? norm(f.child) : "";
    const parent = typeof f?.parent === "string" ? norm(f.parent) : "";
    if (!child || !parent || child === parent) continue;
    out.push({ child, parent, ...(typeof f.why === "string" && f.why.trim() ? { why: f.why.trim() } : {}) });
  }
  return out;
}

/** child path -> fold parent path, keeping only folds whose child and parent are both known and that make no cycle. */
export function foldMap(folds: EpicFold[], known: (p: string) => boolean): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of folds) {
    if (!known(f.child) || !known(f.parent) || map.has(f.child)) continue;
    // a fold whose parent is (through other folds) folded into this child would loop: skip it.
    let at: string | undefined = f.parent;
    const seen = new Set<string>();
    while (at && !seen.has(at) && at !== f.child) (seen.add(at), (at = map.get(at)));
    if (at === f.child) continue;
    map.set(f.child, f.parent);
  }
  return map;
}

export type FoldedNode = SpineNode & { folded_into?: string };

/**
 * spines.py nodes with the folds applied: a folded child's `parent` is its fold parent (it moves to that parent's
 * `children`) and it carries `folded_into`; the folded child's own children climb to the fold parent, so open work under
 * it stays in sight. Nodes come back in tree order (parents first, siblings in their original order).
 */
export function applyFolds(nodes: SpineNode[], folds: EpicFold[]): FoldedNode[] {
  if (!folds.length) return nodes;
  const byPath = new Map(nodes.map((n) => [norm(n.path), n]));
  const map = foldMap(folds, (p) => byPath.has(p));
  if (!map.size) return nodes;
  // the visible parent of a node: its own parent, lifted past any folded ancestor to that fold's parent.
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) {
    const p = norm(n.path);
    parentOf.set(p, map.get(p) ?? (n.parent ? norm(n.parent) : null));
  }
  for (const [p, own] of parentOf) {
    if (map.has(p) || !own) continue;
    let up: string | null | undefined = own;
    const seen = new Set<string>();
    while (up && map.has(up) && !seen.has(up)) (seen.add(up), (up = map.get(up)));
    if (up !== own) parentOf.set(p, up ?? own);
  }
  const order = new Map(nodes.map((n, i) => [norm(n.path), i]));
  const kids = new Map<string, string[]>();
  for (const [p, par] of parentOf) if (par && byPath.has(par)) kids.set(par, [...(kids.get(par) ?? []), p]);
  for (const list of kids.values()) list.sort((a, b) => order.get(a)! - order.get(b)!);
  const out: FoldedNode[] = [];
  const placed = new Set<string>();
  const place = (p: string) => {
    if (placed.has(p)) return;
    placed.add(p);
    const n = byPath.get(p)!;
    const fold = map.get(p);
    out.push({ ...n, parent: parentOf.get(p) ?? null, children: kids.get(p) ?? [], ...(fold ? { folded_into: fold } : {}) });
    for (const k of kids.get(p) ?? []) place(k);
  };
  for (const n of nodes) {
    const p = norm(n.path);
    const par = parentOf.get(p);
    if (!par || !byPath.has(par)) place(p);
  }
  for (const n of nodes) place(norm(n.path)); // anything left (a parent cycle in the input) keeps its place at the end
  return out;
}
