import path from "node:path";
import { inside, readDoc } from "./doc.js";
import { codeOf, deriveLabel } from "./label.js";
import { stripInline } from "./markdown.js";
import { backlogFor, locate, NOT_LINKED, PLACEHOLDER_ID, type LinkKind, type MilestoneRef, type Ticket } from "./milestone.js";
import type { SpineNode, SpinesJson } from "./spines.js";
import type { Repo } from "./repos.js";
import { asksFor, isJordis, rowMatches, snoozedNow, type HumanAsk, type LocatedAsk } from "../inbox/asks.js";
import { DEFAULT_OWNER, DEFAULT_OWNER_INFO, isDefaultOwner, ownerPatterns, type OwnerInfo } from "../tenancy/owner.js";
import { deployerName, ownerName } from "../identity.js";

/**
 * epic tree: the milestone's spine → child spines (spines.py --json) → Issue Ledger rows (backlogFor) →
 * linked ticket files → their own ledger rows, recursively; unmatched DoD items as leaves. Read-only.
 */
export type TreeColor = "grey" | "blue" | "yellow" | "red" | "green";
export const TREE_COLORS: TreeColor[] = ["red", "yellow", "blue", "grey", "green"];

export interface TreeNode {
  /**
   * Unique within the tree: parent key + "/" + segment, the UI's React key and the node view's address.
   * Segment = the row's (or spine's) id when unique among its siblings, else `#<row number>` (ledgers whose Issue
   * cells are all `draft`); stable across refreshes while the ledger keeps its order.
   */
  key: string;
  id: string;
  kind: "spine" | "ticket" | "dod";
  title: string;
  /** short code the tree row shows (M5, DOD-3, `root`): a spine's id is its long Spine ID slug. */
  code?: string;
  /** short plain label the tree row shows beside the code: a spine's `Label:` line, else derived from the title. */
  label?: string;
  /** Raw status text as written (spine Status word, ledger cell, ticket `Status:`, DoD done/open). */
  status: string;
  color: TreeColor;
  path?: string;
  children: TreeNode[];
  /** Codes: unknown-status, dishonest-green, mismatch, stale, done-open-descendants, cycle, repeat, depth-cap. */
  flags: string[];
  /** One human line per flag that has detail. */
  notes?: string[];
  /** Ledger row's gate cell (`Needs` column) when present, e.g. "the owner go". */
  needs?: string;
  /** ledger row's `Depends on` cell when present, e.g. " (QR scan)". */
  dependsOn?: string;
  /** ledger row's `Next action` cell when present, e.g. "Dispatch when #17-#19 are integrated". */
  nextAction?: string;
  /** ledger row's owner cell (`Owner` / `Who` / `Assignee` column) when present, e.g. "the owner". */
  owner?: string;
  /** ledger row's `Role` cell when present; `Mac agent` = Claude on the owner's Mac does it, never a server worker. */
  role?: string;
  /** open human asks to the owner attached here (skill contract human-asks.md): row-linked asks make the row red. */
  asks?: Pick<HumanAsk, "ask" | "question" | "who" | "since" | "code">[];
  /**
   * a step that can start now: status ready/todo, nothing blocking it (no the owner gate or ask, so still grey;
   * its `Depends on` names no open ask anywhere in the tree). The UI shows it as "ready · nobody on it" unless a running child run works on it.
   */
  ready?: true;
  /** spine nodes: spines.py `run_state` verbatim (planning | ready | running | parked | finished); absent before skill 2026.10.24.9. Reference nodes carry it too (the UI folds finished ones). */
  runState?: string;
  /** closed without done (superseded, cancelled, moved, handed off): drawn muted like done, never "ready". */
  closed?: true;
}

export interface Tree {
  milestoneId: string;
  root: TreeNode;
  counts: Record<TreeColor, number>;
  /**
   * Non-green nodes still to do: excludes superseded/cancelled/moved ones (grey, but closed). Counts, nonGreen,
   * closed and flagged cover open work only: a finished spine below the root and everything under it are left out
   * (`finished` counts those spines; the UI folds them).
   */
  nonGreen: number;
  /** Grey nodes that are closed without done (superseded, cancelled, moved, handed off). */
  closed: number;
  /** spines below the root whose run_state is finished (folded in the UI, not counted above). */
  finished?: number;
  /** counted nodes in Planning (a draft spine or row) and Parked (a deferred one): grey, never "ready". */
  planning?: number;
  parked?: number;
  /** Nodes carrying an honesty flag (HONESTY_FLAGS). */
  flagged: number;
  /** "spines" = spines.py output used; "fallback" = doc parser only (no child spines, no mismatch/stale). */
  source: "spines" | "fallback";
  warnings: string[];
  /** every human ask (open + answered, any human) per repo-relative file in the tree; absent when none. */
  asks?: Record<string, LocatedAsk[]>;
  /** Current State `Owner:` per repo-relative file (spines.py `current_state.owner`, else the markdown parse); absent when none. */
  owners?: Record<string, string>;
  /** D19: spines.py `waits_on[]` (reference lines `[waits on <code> row <id>]`) per repo-relative file; absent when none or before skill 2026.10.22.4. */
  waits?: Record<string, SpinesWait[]>;
  /** the world's owner when it is not the owner (absent for the home world, so its tree is unchanged). */
  owner?: OwnerInfo;
}

/**
 * One `waits_on[]` entry of spines.py: `state` is the target ask's (open/answered/done/superseded) when it resolves, else
 * unresolved. Besides `[waits on <code> row <id>]` lines, spines.py (epicspine-skill ticket-34) reports the ask codes a
 * free-text `Current State` `Waiting on:` line names as entries too: those have no `[waits on …]` line in the file.
 */
export interface SpinesWait {
  ref: string;
  repo: string | null;
  code: string;
  row: string | null;
  state: "open" | "answered" | "done" | "superseded" | "unresolved";
}

export const MAX_DEPTH = 6;
/** Flags that mean "this status is not to be trusted"; a flagged green renders with an amber ring. */
export const HONESTY_FLAGS = ["unknown-status", "dishonest-green", "mismatch", "stale", "done-open-descendants"];
/** Reference nodes (a path already shown elsewhere) are not counted. */
const REF_FLAGS = ["cycle", "repeat"];

// ---------- status → color ----------

/** heuristic: the first clause (up to `;` or `. `) names the owner (the owner by default) or an approval → the block is on them. */
export const namesJordi = (text?: string, owner: string = DEFAULT_OWNER) => !!text && ownerPatterns(owner).needsHuman.test(stripInline(text).split(/;|\.\s/)[0]);

export type Word = "draft" | "ready" | "active" | "blocked" | "done" | "superseded" | "deferred";
/** EpicSpine vocabulary (operating-model.md "Status Vocabulary") plus the free-text words ledgers use; earliest match wins. */
const WORDS: [RegExp, Word][] = [
  [/\b(superseded|cancel+ed|won'?t ?fix|retired|dropped|moved to|handed off)\b/i, "superseded"],
  [/\b(done|closed|complete|completed|merged|shipped|accepted)\b/i, "done"],
  [/\b(blocked|waiting|needs|on hold)\b/i, "blocked"],
  [/\b(review|testing|verifying|in[ -]progress|active|wip|ongoing|running|started|dispatched)\b/i, "active"],
  // `queued` (house_decision #20/#21: waits its turn, nobody on it) is ready; `backlog` is not started.
  [/\b(ready|todo|to do|open|queued)\b/i, "ready"],
  [/\b(pending|planned|proposed|draft|not started|backlog)\b/i, "draft"],
  [/\b(paused|parked|deferred)\b/i, "deferred"],
];

export function statusWordOf(raw: string): Word | undefined {
  const text = stripInline(raw);
  let best: { at: number; w: Word } | undefined;
  for (const [re, w] of WORDS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { at: m.index, w };
  }
  return best?.w;
}

/**
 * grey = draft/ready/deferred/superseded/unknown; blue = active/review/testing; yellow = blocked on an agent or
 * dependency; red = blocked and the status (or `Waiting on:`) names the owner/approval; green = done.
 * a not-started row (draft/pending/ready) or a blocked one whose gate cell (`Needs` column) names
 * the owner/approval ("the owner go", "the owner approves drop") is red too: it cannot start without him.
 */
export function colorFor(raw: string | undefined, waitingOn?: string, needs?: string, owner: string = DEFAULT_OWNER): { color: TreeColor; known: boolean } {
  const w = raw ? statusWordOf(raw) : undefined;
  if (!w) return { color: "grey", known: false };
  if (w === "done") return { color: "green", known: true };
  if (w === "active") return { color: "blue", known: true };
  if ((w === "draft" || w === "ready" || w === "blocked") && namesJordi(needs, owner)) return { color: "red", known: true };
  if (w === "blocked") {
    const own = stripInline(raw!).replace(/^[^a-z]*(blocked|waiting|needs|on hold)\b\s*[-—:–,;(]?\s*(on\b)?\s*/i, "");
    return { color: namesJordi(own, owner) || namesJordi(waitingOn, owner) ? "red" : "yellow", known: true };
  }
  return { color: "grey", known: true };
}

// ---------- build ----------

const norm = (p: string) => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
const sameId = (a?: string, b?: string) => !!a && !!b && stripInline(a).toLowerCase() === stripInline(b).toLowerCase();
/** Leading id of a DoD checkbox line ("DOD-1 **CPU** …" → DOD-1, " Epic tree" →). */
const dodIdOf = (text: string) => /^\**([A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)+)\**[\s:]/.exec(text + " ")?.[1];

/** " Epic tree" → "Epic tree" when the text starts with its id (spines.py already strips it; parseDod does not). */
const stripId = (text: string, id?: string) => {
  if (!id) return text;
  const m = /^\**([^\s*]+)\**\s*/.exec(text);
  return m && sameId(m[1], id) ? text.slice(m[0].length) : text;
};

interface DodLike {
  id?: string;
  text: string;
  done: boolean;
}

interface Ctx {
  reposRoot: string;
  repo: string;
  repoDir: string;
  /** the milestone's repo, resolved once per build (per-node lookups rescanned every checkout). */
  repoInfo: Repo;
  milestoneId: string;
  spines?: SpinesJson;
  byPath: Map<string, SpineNode>;
  mismatches: Map<string, string[]>;
  stale: Map<string, number>;
  expanded: Set<string>;
  asks: Map<string, LocatedAsk[]>;
  owners: Map<string, string>;
  waits: Map<string, SpinesWait[]>;
  /** spines.py emits `waiting_on` (skill ≥ 2026.10.21.1); asksFor uses it once it is contract v2 (has `code`), else the markdown. */
  waitingOnFromSpines: boolean;
  /** the world owner's handle (the owner for the home world). */
  owner: string;
}

export function buildTree(reposRoot: string, m: MilestoneRef & { title?: string }, spines?: SpinesJson, owner: OwnerInfo = DEFAULT_OWNER_INFO): Tree {
  const ownerField = isDefaultOwner(owner) ? {} : { owner };
  const warnings: string[] = [];
  const loc = locate(reposRoot, m);
  const empty = (msg: string): Tree => ({
    milestoneId: m.id,
    root: { key: m.id, id: m.id, kind: "spine", title: m.title ?? m.path, code: m.id, label: deriveLabel(m.title ?? m.path ?? m.id, m.id), status: "unknown", color: "grey", path: m.path, children: [], flags: ["unknown-status"], notes: [msg] },
    counts: { grey: 1, blue: 0, yellow: 0, red: 0, green: 0 },
    nonGreen: 1,
    closed: 0,
    finished: 0,
    flagged: 1,
    source: "fallback",
    warnings: [msg],
    ...ownerField,
  });
  if (!m.path) return empty("milestone has no spine path yet (bootstrapping)");
  if ("error" in loc) return empty(loc.error);
  const repoDir = loc.repo.path;
  const rel = norm(path.relative(repoDir, loc.abs).split(path.sep).join("/"));
  const ctx: Ctx = {
    reposRoot,
    repo: m.repo,
    repoDir,
    repoInfo: loc.repo,
    milestoneId: m.id,
    spines,
    byPath: new Map((spines?.nodes ?? []).map((n) => [norm(n.path), n])),
    mismatches: new Map(),
    stale: new Map(),
    expanded: new Set(),
    asks: new Map(),
    owners: new Map(),
    waits: new Map(),
    waitingOnFromSpines: !!spines?.nodes.some((n) => "waiting_on" in n),
    owner: owner.handle,
  };
  for (const x of spines?.mismatches ?? []) ctx.mismatches.set(norm(x.path), [...(ctx.mismatches.get(norm(x.path)) ?? []), x.problem]);
  for (const x of (spines as { stale?: { path: string; days: number }[] } | undefined)?.stale ?? []) ctx.stale.set(norm(x.path), x.days);
  if (!spines) warnings.push("spines.py output unavailable: child spines, mismatches and stale not shown");

  const root = ctx.byPath.has(rel)
    ? spineNode(ctx, rel, m.id, 0, new Set())
    : docNode(ctx, { id: m.id, title: m.title ?? loc.info.title ?? rel, raw: loc.info.statusLine, path: rel, isSpine: !!loc.info.spineId }, m.id, 0, new Set());
  if (!root.title && m.title) root.title = m.title;
  hoistLive(root);
  walk(root, (n) => {
    if (isClosed(n) && !n.flags.some((f) => REF_FLAGS.includes(f))) n.closed = true;
  });
  markDescendants(root);
  markReady(root, readyRules(ctx, root));
  uniqueKeys(root);
  walk(root, (n) => {
    const own = n.kind === "spine" && n.path ? (() => {
      const abs = inside(repoDir, n.path!);
      return abs ? readDoc(abs)?.label : undefined;
    })() : undefined;
    n.code = codeOf(n, !!n.path && ctx.byPath.get(norm(n.path))?.parent === null);
    n.label = own ?? deriveLabel(n.title, n.code);
  });
  const asks = {
    ...(ctx.asks.size ? { asks: Object.fromEntries(ctx.asks) } : {}),
    ...(ctx.owners.size ? { owners: Object.fromEntries(ctx.owners) } : {}),
    ...(ctx.waits.size ? { waits: Object.fromEntries(ctx.waits) } : {}),
  };
  return { milestoneId: m.id, root, ...summarize(root), source: spines ? "spines" : "fallback", warnings, ...asks, ...ownerField };
}

/**
 * Counts per color, non-green (excluding closed), closed and flagged for a subtree; reference nodes not counted.
 * open work only: finished spines below `root` and their subtrees are skipped and counted in `finished`.
 */
export function summarize(root: TreeNode): Pick<Tree, "counts" | "nonGreen" | "closed" | "flagged" | "finished" | "planning" | "parked"> {
  const counts: Record<TreeColor, number> = { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 };
  let flagged = 0;
  let closed = 0;
  let finished = 0;
  let planning = 0;
  let parked = 0;
  walkOwn(root, (n) => {
    if (n.flags.some((f) => REF_FLAGS.includes(f))) return;
    counts[n.color]++;
    if (isClosed(n)) closed++;
    if (n.flags.some((f) => HONESTY_FLAGS.includes(f))) flagged++;
    const h = holdState(n);
    if (h === "planning") planning++;
    else if (h === "parked") parked++;
  }, () => finished++);
  return { counts, nonGreen: counts.grey + counts.blue + counts.yellow + counts.red - closed, closed, flagged, finished, planning, parked };
}

/**
 * how far a goal is, for the owner's big roots ("I'm at 60%"): a done node counts 1, a finished epic (review / done)
 * counts 1, a node with counted children counts the average of them, any other node 0; superseded / cancelled nodes and
 * references are left out. So each level-1 branch weighs the same however many rows it has. `done`/`total` = the
 * level-1 branches done out of those counted (the tooltip). A done root is 100.
 */
export interface Progress {
  pct: number;
  done: number;
  total: number;
}
export function progressOf(root: TreeNode): Progress {
  const counted = (n: TreeNode) => !n.flags.some((f) => REF_FLAGS.includes(f)) && !isClosed(n);
  const frac = (n: TreeNode): number => {
    if (n.color === "green" || isFinished(n)) return 1;
    const kids = n.children.filter(counted);
    return kids.length ? kids.reduce((s, c) => s + frac(c), 0) / kids.length : 0;
  };
  const top = root.children.filter(counted);
  const done = top.filter((c) => frac(c) === 1).length;
  return { pct: root.color === "green" ? 100 : Math.floor(frac(root) * 100), done, total: top.length };
}

/**
 * a spine (or row) that is not meant to run yet: `planning` (spines.py run_state planning, else a draft status) or
 * `parked` (run_state parked, else deferred / paused). Nothing under it is ready, and it is never Stalled.
 */
export function holdState(n: Pick<TreeNode, "kind" | "status" | "runState">): "planning" | "parked" | undefined {
  if (n.kind === "dod") return undefined;
  if (n.runState === "planning" || n.runState === "parked") return n.runState;
  if (n.runState) return undefined;
  const w = statusWordOf(n.status);
  return w === "draft" ? "planning" : w === "deferred" ? "parked" : undefined;
}

/**
 * root-only rows: `root` and its own rows (with their ticket files); a spine below the root is visited as one
 * roll-up line (its state) and not entered: its rows are counted once, in its own tree. Finished ones go to `onFinished`.
 */
export function walkOwn(root: TreeNode, f: (n: TreeNode) => void, onFinished?: (n: TreeNode) => void) {
  const visit = (n: TreeNode) => {
    if (n !== root && isFinished(n)) return onFinished?.(n);
    f(n);
    if (n !== root && n.kind === "spine") return;
    n.children.forEach(visit);
  };
  visit(root);
}

/** a spine node whose spines.py run_state is finished (review / done / superseded epics); reference nodes excluded. */
export const isFinished = (n: Pick<TreeNode, "kind" | "runState" | "flags">) =>
  n.kind === "spine" && n.runState === "finished" && !n.flags.some((f) => REF_FLAGS.includes(f));

/** walk `root` and its live descendants: a finished spine below the root is not visited (`onFinished` is called instead). */
export function walkLive(root: TreeNode, f: (n: TreeNode) => void, onFinished?: (n: TreeNode) => void) {
  const visit = (n: TreeNode) => {
    if (n !== root && isFinished(n)) return onFinished?.(n);
    f(n);
    n.children.forEach(visit);
  };
  visit(root);
}

/**
 * a live spine is expanded where the tree first meets it, which may be inside a finished epic (a closed epic's
 * row naming its successor): then its live copy outside folded work would be a bare "shown elsewhere" reference.
 * Swap the two: the expansion moves to the first reference outside any finished subtree, the other becomes the reference.
 */
function hoistLive(root: TreeNode) {
  const expanded = new Map<string, { n: TreeNode; inFinished: boolean }>();
  const refs = new Map<string, TreeNode>();
  const visit = (n: TreeNode, inFinished: boolean) => {
    const ref = n.flags.some((f) => REF_FLAGS.includes(f));
    if (n.kind === "spine" && n.path) {
      if (!ref && !expanded.has(n.path)) expanded.set(n.path, { n, inFinished });
      if (n.flags.includes("repeat") && !inFinished && !refs.has(n.path)) refs.set(n.path, n);
    }
    const below = inFinished || (n !== root && isFinished(n));
    n.children.forEach((c) => visit(c, below));
  };
  visit(root, false);
  for (const [p, e] of expanded) {
    const r = refs.get(p);
    if (!e.inFinished || !r || e.n.runState === "finished") continue;
    const rekey = (n: TreeNode, from: string, to: string) => {
      n.key = to + n.key.slice(from.length);
      n.children.forEach((c) => rekey(c, from, to));
    };
    const kids = e.n.children;
    kids.forEach((c) => rekey(c, e.n.key, r.key));
    Object.assign(r, { children: kids, flags: e.n.flags, notes: e.n.notes });
    if (!r.notes) delete r.notes;
    Object.assign(e.n, { children: [], flags: ["repeat"], notes: ["shown elsewhere in this tree; not expanded"] });
  }
}

/** node view: the tree re-rooted at `nodeKey` with its own counts (asks/warnings kept); undefined when absent. */
export function subtree(t: Tree, nodeKey: string): Tree | undefined {
  let hit: TreeNode | undefined;
  walk(t.root, (n) => {
    if (!hit && n.key === nodeKey) hit = n;
  });
  return hit && { ...t, root: hit, ...summarize(hit) };
}

/** Safety net under the per-sibling segments: a key seen twice gets `~n`, and its descendants follow the new prefix. */
function uniqueKeys(root: TreeNode) {
  const seen = new Set<string>();
  const rekey = (n: TreeNode, from: string, to: string) => {
    n.key = to + n.key.slice(from.length);
    n.children.forEach((c) => rekey(c, from, to));
  };
  walk(root, (n) => {
    if (seen.has(n.key)) {
      let i = 2;
      while (seen.has(`${n.key}~${i}`)) i++;
      rekey(n, n.key, `${n.key}~${i}`);
    }
    seen.add(n.key);
  });
}

/** codes of every open ask in the tree (`## Waiting on` asks of any file, and open `waits on` references). */
function openAskCodes(ctx: Ctx): string[] {
  const codes = new Set<string>();
  for (const list of ctx.asks.values()) for (const a of list) if (a.state === "open" && a.code) codes.add(a.code);
  for (const list of ctx.waits.values()) for (const w of list) if (w.state === "open") codes.add(w.code);
  return [...codes];
}

/** the `Depends on` cell names one of these codes (whole code: does not match). */
export function dependsOnOpenAsk(dependsOn: string | undefined, codes: string[]): string | undefined {
  if (!dependsOn) return undefined;
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return codes.find((c) => new RegExp(`(?:^|[^A-Za-z0-9-])${esc(c)}(?![A-Za-z0-9])`, "i").test(dependsOn));
}

/** what a row's readiness is judged against (built once per tree by readyRules). */
export interface ReadyRules {
  /** codes of open asks anywhere in the tree. */
  openCodes: string[];
  /** Every ask code the tree knows (any state): one not open is no blocker. */
  askCodes?: Set<string>;
  /** Upper-cased row / spine id → its raw status: this tree's nodes first, then every spine's ledger in the repo. */
  status?: Map<string, string>;
  /** The world owner's owner-cell pattern (`the owner …`): their rows are asks, never worker work. */
  ownerCell?: RegExp;
}

const DEP_ID = String.raw`[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*`;
/** `..S6`, `S1-S4`, `–` (a bare `-` needs the letters again, so `` stays one id). */
const DEP_RANGE = /(?<![A-Za-z0-9-])((?:[A-Za-z0-9]+-)*)([A-Za-z]+)(\d+)(?:\s*(?:\.\.|–|—)\s*(?:\1)?\2?|-\1?\2)(\d+)(?![A-Za-z0-9])/g;
/** Words a `Depends on` cell may carry besides ids without making it a condition. */
const DEP_GLUE = /\b(?:and|or|plus|both|all|after|none|nothing|n\/a|merged|done)\b/gi;

/** the ids a `Depends on` cell names (ranges expanded, upper-cased), and whether text beyond ids is left (a free-text condition). */
export function parseDependsOn(cell: string | undefined): { ids: string[]; freeText: boolean } {
  if (!cell) return { ids: [], freeText: false };
  const ids: string[] = [];
  let text = stripInline(cell).replace(/\([^)]*\)/g, " ");
  text = text.replace(DEP_RANGE, (_m, pre: string, letters: string, a: string, b: string) => {
    const [lo, hi] = [Number(a), Number(b)];
    if (hi >= lo && hi - lo <= 50) for (let i = lo; i <= hi; i++) ids.push(`${pre}${letters}${i}`.toUpperCase());
    return " ";
  });
  text = text.replace(new RegExp(`(?<![A-Za-z0-9-])${DEP_ID}(?![A-Za-z0-9-])`, "g"), (t) => {
    if (!/\d/.test(t)) return t;
    ids.push(t.toUpperCase());
    return " ";
  });
  const left = text.replace(DEP_GLUE, " ").replace(/[^A-Za-z]+/g, " ").trim();
  return { ids: [...new Set(ids)], freeText: left.length > 0 };
}

/**
 * why a ready-status row cannot start now, or undefined when it can. One rule for the tree's `ready`, so for
 * the stall watch, the wake prompt's ready list and the fingerprint's `ready` part alike:
 * (a) every id its `Depends on` names is finished: a row or spine done / merged / superseded (this epic or another);
 *     an open ask code blocks, one answered or closed does not; an id found nowhere blocks;
 * (b) its owner is not the world owner (the owner's steps are asks, not worker work);
 * (c) its `Depends on` holds no free-text condition (text that is not ids or `none`), unless its status says met.
 */
export function notReadyBecause(n: Pick<TreeNode, "status" | "owner" | "dependsOn" | "role">, r: ReadyRules): string | undefined {
  if (n.owner && r.ownerCell?.test(n.owner)) return `owner ${n.owner}`;
  if (isMacAgentRole(n.role)) return "needs Mac agent";
  const ask = dependsOnOpenAsk(n.dependsOn, r.openCodes);
  if (ask) return `open ask ${ask}`;
  const { ids, freeText } = parseDependsOn(n.dependsOn);
  if (freeText && !/\b(met|unblocked|satisfied)\b/i.test(stripInline(n.status))) return `condition: ${stripInline(n.dependsOn!)}`;
  for (const id of ids) {
    const raw = r.status?.get(id);
    if (raw !== undefined) {
      const w = statusWordOf(raw);
      if (w !== "done" && w !== "superseded") return `depends on ${id} (${stripInline(raw) || "no status"})`;
    } else if (!(r.askCodes?.has(id) || /-A\d+$/.test(id))) return `depends on ${id} (not found)`;
  }
  return undefined;
}

/** the row Role of work Claude on the owner's Mac does from its ticket; the one name (asks carry `label: needs Mac agent`). */
export const MAC_AGENT_ROLE = "Mac agent";
export const isMacAgentRole = (role?: string) => !!role && /^(?:needs\s+)?mac\s+agent$/i.test(stripInline(role).trim());

/** the rules for one tree: open/known ask codes, every row and spine status in the repo, the owner's pattern. */
function readyRules(ctx: Ctx, root: TreeNode): ReadyRules {
  const askCodes = new Set<string>();
  for (const list of ctx.asks.values()) for (const a of list) if (a.code) askCodes.add(a.code.toUpperCase());
  for (const list of ctx.waits.values()) for (const w of list) askCodes.add(w.code.toUpperCase());
  const status = new Map<string, string>();
  const put = (id: string | undefined, raw: string | undefined) => {
    const k = id && stripInline(id).toUpperCase();
    if (k && raw !== undefined && !status.has(k) && !PLACEHOLDER_ID.test(k)) status.set(k, raw);
  };
  walk(root, (n) => {
    if (n.kind === "dod" || n.flags.some((f) => REF_FLAGS.includes(f))) return;
    put(n.id, n.status);
    if (n.kind === "spine") put(/^((?:EPIC|M)-?\d+)\b/i.exec(n.title)?.[1], n.status);
  });
  for (const s of ctx.spines?.nodes ?? []) {
    put(/^((?:EPIC|M)-?\d+)\b/i.exec(s.title ?? "")?.[1], s.current_state?.status ?? s.status);
    const abs = inside(ctx.repoDir, norm(s.path));
    for (const row of (abs ? readDoc(abs)?.ledger : undefined) ?? []) put(row.id, row.status);
  }
  return { openCodes: openAskCodes(ctx), askCodes, status, ownerCell: ownerPatterns(ctx.owner).ownerCell };
}

/** a status cell's first word, lower-cased: `ready (…)` → ready, `handed over (… ready for …)` → handed. */
export const firstStatusWord = (raw: string | undefined) => /^[^A-Za-z]*([A-Za-z]+)/.exec(stripInline(raw ?? ""))?.[1]?.toLowerCase();

/**
 * a spine whose rows may start: spines.py's run_state ready or running (its own Status ready, active or
 * blocked); not draft, deferred, review, done or superseded. Without a run_state, the first word of its status.
 */
export const isRunnableSpine = (n: Pick<TreeNode, "status" | "runState">) =>
  n.runState ? n.runState === "ready" || n.runState === "running" : ["ready", "active", "blocked"].includes(firstStatusWord(n.status) ?? "");

/**
 * The one ready test (the tree's `ready`, so the stall watch, the wake check's readyIds, the wake prompt's
 * ready list and the fingerprint alike): a row (never a spine: an epic with Status ready is not work a worker starts,
 * its rows are) whose status cell's first word is `ready`, every spine above it runnable (`spines`: the enclosing
 * spines, root first), still grey (no gate, no ask), not a reference, and nothing notReadyBecause names.
 * grey ready steps; an open ask in `Depends on`; nothing under a Planning / Parked spine;
 * an unfinished dependency, owned by the owner, a free-text condition.
 */
export function isReadyRow(n: TreeNode, spines: Pick<TreeNode, "status" | "runState">[], rules: ReadyRules): boolean {
  if (n.kind !== "ticket" || firstStatusWord(n.status) !== "ready" || !spines.every(isRunnableSpine)) return false;
  if (n.color !== "grey" || n.asks?.length || n.flags.some((f) => REF_FLAGS.includes(f))) return false;
  return !notReadyBecause(n, rules);
}

function markReady(root: TreeNode, rules: ReadyRules) {
  const visit = (n: TreeNode, spines: TreeNode[]) => {
    if (n !== root && isReadyRow(n, spines, rules)) n.ready = true;
    const inner = n.kind === "spine" ? [...spines, n] : spines;
    n.children.forEach((c) => visit(c, inner));
  };
  visit(root, []);
}

/** Superseded / cancelled / moved: grey, but nothing left to do there. */
export const isClosed = (n: Pick<TreeNode, "status" | "kind">) => n.kind !== "dod" && statusWordOf(n.status) === "superseded";

function walk(n: TreeNode, f: (n: TreeNode) => void) {
  f(n);
  for (const c of n.children) walk(c, f);
}

/**
 * Green node with a non-green counted descendant → done-open-descendants. Returns whether the subtree has non-green.
 * Closed (superseded) children are not open work; a finished child spine is closed work too: its own
 * leftovers flag that spine, not its parents.
 */
function markDescendants(n: TreeNode): boolean {
  let open = false;
  for (const c of n.children) {
    const sub = markDescendants(c);
    if (isFinished(c)) continue;
    if (!c.flags.some((f) => REF_FLAGS.includes(f)) && ((c.color !== "green" && !isClosed(c)) || sub)) open = true;
  }
  if (open && n.color === "green") flag(n, "done-open-descendants", "marked done while something under it is not green");
  return open;
}

function flag(n: TreeNode, code: string, note?: string) {
  if (!n.flags.includes(code)) n.flags.push(code);
  if (note) n.notes = [...(n.notes ?? []), note];
}

/** Ref node for a path already in the tree (cycle when it is an ancestor, else repeat). */
function refNode(base: Omit<TreeNode, "children" | "flags">, cycle: boolean): TreeNode {
  return { ...base, children: [], flags: [cycle ? "cycle" : "repeat"], notes: [cycle ? "links back to an ancestor (cycle); not expanded" : "shown elsewhere in this tree; not expanded"] };
}

function baseFlags(ctx: Ctx, n: TreeNode) {
  if (!n.path) return;
  for (const p of ctx.mismatches.get(norm(n.path)) ?? []) flag(n, "mismatch", `spines.py: ${p}`);
  const days = ctx.stale.get(norm(n.path));
  if (days !== undefined) flag(n, "stale", `spines.py: ${n.status} but untouched ${days} days`);
}

/**
 * Spine node. A spine reached through a ledger row (`row`) is that step: its status is the row's Status cell
 * when the row has one (the epic's own Current State `Status:` is noted when it differs), else the epic's.
 */
function spineNode(ctx: Ctx, rel: string, parentKey: string, depth: number, ancestors: Set<string>, seg?: string, row?: { raw?: string; needs?: string; dependsOn?: string }): TreeNode {
  const s = ctx.byPath.get(rel)!;
  const info = (() => {
    const abs = inside(ctx.repoDir, rel);
    return abs ? readDoc(abs) : undefined;
  })();
  const raw = row?.raw ? stripInline(row.raw) : s.status;
  const c = colorFor(raw, info?.waitingOn, row?.needs, ctx.owner);
  const base = { key: `${parentKey}/${seg ?? (s.id || rel)}`, id: s.id || rel, kind: "spine" as const, title: s.title || path.basename(rel, ".md"), status: raw || "unknown", color: c.color, path: s.path, ...(row?.needs ? { needs: row.needs } : {}), ...(row?.dependsOn ? { dependsOn: row.dependsOn } : {}), ...(s.run_state ? { runState: s.run_state } : {}) };
  if (ancestors.has(rel) || ctx.expanded.has(rel)) return refNode(base, ancestors.has(rel));
  const node: TreeNode = { ...base, children: [], flags: [] };
  if (!c.known) flag(node, "unknown-status", `status "${raw}" is not an EpicSpine status word`);
  if (row?.raw && s.status && statusWordOf(s.status) !== statusWordOf(raw))
    node.notes = [...(node.notes ?? []), `ledger row says ${raw}; the epic's own Status is ${s.status}`];
  if (s.rollup_status === "done" && s.status !== "done" && c.color !== "green" && s.children.length)
    node.notes = [...(node.notes ?? []), `rollup says done (all child spines done) but own status is ${s.status || "missing"}`];
  baseFlags(ctx, node);
  ctx.expanded.add(rel);
  if (depth >= MAX_DEPTH) {
    flag(node, "depth-cap", `depth cap ${MAX_DEPTH}: children not expanded`);
    return node;
  }
  const anc = new Set(ancestors).add(rel);
  const dod: DodLike[] = s.dod.map((d) => ({ id: d.id, text: d.text, done: d.done }));
  const childSpines = s.children.map(norm);
  node.children = itemChildren(ctx, rel, node, depth, anc, dod, childSpines);
  return node;
}

function docNode(
  ctx: Ctx,
  t: { id: string; title: string; raw?: string; path?: string; isSpine?: boolean; waitingOn?: string; needs?: string; dependsOn?: string; linkKind?: LinkKind },
  parentKey: string,
  depth: number,
  ancestors: Set<string>,
  seg = t.id,
): TreeNode {
  const rel = t.path ? norm(t.path) : undefined;
  const info = rel ? (() => {
    const abs = inside(ctx.repoDir, rel);
    return abs ? readDoc(abs) : undefined;
  })() : undefined;
  // A linked page's `Waiting on:` is prose, not this row's state: only a ticket's or epic's own counts.
  const c = colorFor(t.raw, t.waitingOn ?? (t.linkKind === "page" ? undefined : info?.waitingOn), t.needs, ctx.owner);
  const base = { key: `${parentKey}/${seg}`, id: t.id, kind: (t.isSpine ? "spine" : "ticket") as TreeNode["kind"], title: t.title, status: t.raw ? stripInline(t.raw) : "unknown", color: c.color, ...(rel ? { path: rel } : {}), ...(t.needs ? { needs: t.needs } : {}), ...(t.dependsOn ? { dependsOn: t.dependsOn } : {}) };
  // Several rows may link one detail page (`[detail](steps.md#step-6)`): each row is still its own counted step,
  // the page is expanded once. Only tickets and epics become reference nodes.
  const seen = !!rel && (ancestors.has(rel) || ctx.expanded.has(rel));
  if (seen && t.linkKind !== "page") return refNode(base, ancestors.has(rel!));
  const node: TreeNode = { ...base, children: [], flags: [] };
  if (!c.known) flag(node, "unknown-status", t.raw ? `status "${stripInline(t.raw)}" has no known status word` : "no status");
  baseFlags(ctx, node);
  if (!rel || !info || seen) return node;
  ctx.expanded.add(rel);
  const dod: DodLike[] = info.dod.items.filter((i) => i.checked !== null).map((i) => ({ id: dodIdOf(i.text), text: i.text, done: !!i.checked }));
  if (c.color === "green" && dod.some((d) => !d.done))
    flag(node, "dishonest-green", `done, but ${dod.filter((d) => !d.done).length} of ${dod.length} DoD/Acceptance boxes unchecked`);
  if (depth >= MAX_DEPTH) {
    if (dod.length || info.ledger.length) flag(node, "depth-cap", `depth cap ${MAX_DEPTH}: children not expanded`);
    return node;
  }
  node.children = itemChildren(ctx, rel, node, depth, new Set(ancestors).add(rel), dod, []);
  return node;
}

/** Children of a spine/ticket file: ledger rows (spine-linked rows become spine nodes), then child spines, then unmatched DoD. */
function itemChildren(ctx: Ctx, rel: string, self: TreeNode, depth: number, anc: Set<string>, dod: DodLike[], childSpines: string[]): TreeNode[] {
  const key = self.key;
  const out: TreeNode[] = [];
  // Open asks to the owner in this file: spines.py `waiting_on` once it is contract v2; until then (v1 list, no
  // field, spines.py failed) the `## Waiting on` markdown parser, which reads v1 and v2 lines.
  const node = ctx.byPath.get(rel) as (SpineNode & { waiting_on?: unknown }) | undefined;
  const waitingOn = ctx.waitingOnFromSpines ? (node?.waiting_on ?? []) : undefined;
  const allAsks = asksFor(ctx.repoDir, rel, waitingOn);
  if (allAsks.length) ctx.asks.set(rel, allAsks);
  const waits = spinesWaits((node as { waits_on?: unknown } | undefined)?.waits_on);
  if (waits.length) ctx.waits.set(rel, waits);
  const stateOwner = (node as { current_state?: { owner?: unknown } | null } | undefined)?.current_state?.owner;
  const docAbs = inside(ctx.repoDir, rel);
  const owner = typeof stateOwner === "string" && stateOwner.trim() ? stateOwner : docAbs ? readDoc(docAbs)?.owner : undefined;
  if (owner) ctx.owners.set(rel, owner);
  const asks = allAsks.filter((a) => a.state === "open" && isJordis(a, ctx.owner) && !snoozedNow(a.snoozedUntil)); // a snoozed ask paints no red
  const usedAsks = new Set<HumanAsk>();
  const attach = (n: TreeNode, list: HumanAsk[]) => {
    if (!list.length || n.flags.some((f) => REF_FLAGS.includes(f))) return;
    n.asks = [...(n.asks ?? []), ...list.map((a) => ({ ask: a.ask, question: a.question, who: a.who, since: a.since, code: a.code }))];
    if (n.color !== "green" && !isClosed(n)) n.color = "red";
  };
  const rows = backlogFor(ctx.reposRoot, { id: ctx.milestoneId, repo: ctx.repo, path: rel, paused: false }, ctx.repoInfo).filter((r) => r.source !== NOT_LINKED);
  const usedDod = new Set<DodLike>();
  const spinesDone = new Set<string>();
  // Key segments: the row's id (a spine row: the spine's id) when no sibling shares it, else the row number (`#3`).
  const lc = (id: string) => stripInline(id).toLowerCase();
  const cand = rows.map((r) => {
    const rp = r.path ? norm(r.path) : undefined;
    return rp && ctx.byPath.has(rp) ? ctx.byPath.get(rp)!.id || rp : r.id;
  });
  const idCount = new Map<string, number>();
  for (const c of cand) idCount.set(lc(c), (idCount.get(lc(c)) ?? 0) + 1);
  const segOf = (i: number) => (cand[i] && idCount.get(lc(cand[i])) === 1 ? cand[i] : `#${i + 1}`);
  for (const [i, r] of rows.entries()) {
    const match = dod.find((d) => !usedDod.has(d) && sameId(d.id, r.id));
    if (match) usedDod.add(match);
    const rp = r.path ? norm(r.path) : undefined;
    let n: TreeNode;
    if (rp && ctx.byPath.has(rp)) {
      spinesDone.add(rp);
      n = spineNode(ctx, rp, key, depth + 1, anc, segOf(i), { raw: rawStatus(r), needs: r.needs, dependsOn: r.dependsOn });
    } else {
      n = docNode(ctx, { id: r.id, title: r.title, raw: rawStatus(r), path: rp, needs: r.needs, dependsOn: r.dependsOn, linkKind: r.linkKind }, key, depth + 1, anc, segOf(i));
    }
    if (r.owner && !n.flags.some((f) => REF_FLAGS.includes(f))) n.owner = stripInline(r.owner);
    if (r.role && !n.flags.some((f) => REF_FLAGS.includes(f))) n.role = stripInline(r.role);
    if (r.nextAction && !n.flags.some((f) => REF_FLAGS.includes(f))) n.nextAction = stripInline(r.nextAction);
    const rowAsks = asks.filter((a) => !usedAsks.has(a) && rowMatches(a.row, r));
    rowAsks.forEach((a) => usedAsks.add(a));
    attach(n, rowAsks);
    if (match) dodHonesty(n, match);
    out.push(n);
  }
  for (const p of childSpines) {
    if (spinesDone.has(p) || !ctx.byPath.has(p)) continue;
    const id = ctx.byPath.get(p)!.id || p;
    out.push(spineNode(ctx, p, key, depth + 1, anc, idCount.has(lc(id)) ? `spine:${p}` : id));
  }
  // Asks with no (matching) row belong to the file's own node; they do not recolor it (its Status does).
  const rest = asks.filter((a) => !usedAsks.has(a));
  if (rest.length) self.asks = [...(self.asks ?? []), ...rest.map((a) => ({ ask: a.ask, question: a.question, who: a.who, since: a.since, code: a.code }))];
  dod.forEach((d, i) => {
    if (usedDod.has(d)) return;
    const id = d.id || `DoD ${i + 1}`;
    out.push({ key: `${key}/dod:${id}:${i}`, id, kind: "dod", title: stripId(d.text, d.id), status: d.done ? "done" : "open", color: d.done ? "green" : "grey", children: [], flags: [] });
  });
  return out;
}

const rawStatus = (t: Ticket) => (t.status === "—" ? t.statusDetail : t.statusDetail ?? t.status);

/** Ledger row ↔ DoD item with the same id disagree → dishonest-green (either direction). */
function dodHonesty(n: TreeNode, d: DodLike) {
  if (n.flags.some((f) => REF_FLAGS.includes(f))) return;
  if (n.color === "green" && !d.done) flag(n, "dishonest-green", `ledger says done but DoD ${d.id} is unchecked`);
  else if (n.color !== "green" && d.done) flag(n, "dishonest-green", `DoD ${d.id} is checked but the ledger says ${n.status}`);
}

// ---------- leaves for the persona ----------

export interface TreeLeaf {
  id: string;
  title: string;
  color: TreeColor;
  status: string;
  path?: string;
  flags: string[];
}

/** Non-green leaves plus any node with an honesty flag, in tree order (red/yellow first). */
export function todoLeaves(t: Tree): TreeLeaf[] {
  const out: TreeLeaf[] = [];
  const visit = (n: TreeNode, parentPath?: string) => {
    if (n.flags.some((f) => REF_FLAGS.includes(f)) || isClosed(n) || (n !== t.root && isFinished(n))) return;
    const honesty = n.flags.filter((f) => HONESTY_FLAGS.includes(f) && f !== "done-open-descendants");
    const leaf = n.children.length === 0;
    if ((leaf && n.color !== "green") || honesty.length)
      out.push({ id: n.id, title: n.title, color: n.color, status: n.status, path: n.path ?? parentPath, flags: honesty });
    for (const c of n.children) visit(c, n.path ?? parentPath);
  };
  visit(t.root);
  const rank = (c: TreeColor) => ["red", "yellow", "blue", "grey", "green"].indexOf(c);
  return out.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l.color) - rank(b.l.color) || a.i - b.i).map((x) => x.l);
}

/** an `[answered]` line the owner left in a spine (written by the console), not yet acted on and deleted by the owner. */
export interface AnsweredAsk {
  path: string;
  /** 0-based line in `path` when known. */
  line?: number;
  question: string;
  answer?: string;
  row?: string;
  /** a `[feedback …]` line: changes wanted, never an approval. */
  feedback?: boolean;
  /** the answer is another epic's canonical ask this milestone's spines reference: `waits on <repo>/<code>` and where. */
  reference?: { code: string; at: string };
  /** saved in the console only (a guard refused the spine write): the owner writes the line in itself. */
  unwritten?: { code?: string; reason: string };
}

/** Every `[answered …]` line still present in the spines of the tree (the owner's, or unnamed), in file order. */
export function answeredAsks(t: Tree): AnsweredAsk[] {
  const out: AnsweredAsk[] = [];
  for (const [file, asks] of Object.entries(t.asks ?? {}))
    for (const a of asks)
      if (a.state === "answered" && a.doneAt === undefined && isJordis(a, t.owner?.handle))
        out.push({ path: file, ...(a.line !== undefined ? { line: a.line } : {}), question: a.question, ...(a.answer ? { answer: a.answer } : {}), ...(a.row ? { row: a.row } : {}), ...(a.feedback ? { feedback: true } : {}) });
  return out;
}

/** Wake-prompt section: what the owner answered (file, line, question, answer) and what the owner does with it. Empty when none. */
export function answeredSection(t: Tree, cap = 20, referenced: AnsweredAsk[] = []): string[] {
  const own = answeredAsks(t);
  // answers of canonical asks in other epics that this milestone's spines reference (canonical file:line).
  const list = [...own, ...referenced.filter((r) => !own.some((o) => o.path === r.path && o.line === r.line))];
  if (!list.length) return [];
  const lines = [
    "",
    `## Answered by ${ownerName()}, act on these:`,
    ...list.slice(0, cap).map((a) => `- ${a.path}${a.line !== undefined ? `:${a.line + 1}` : ""} — ${a.question.slice(0, 200)} — ${a.feedback ? "FEEDBACK (changes wanted, NOT approved)" : "answer"}: ${(a.answer ?? "(none written)").slice(0, 300)}${a.row ? ` (row ${a.row})` : ""}${a.reference ? ` [canonical ask ${a.reference.code}, referenced at ${a.reference.at}]` : ""}${a.unwritten ? ` [given in the console, NOT in the spine yet: ${a.unwritten.reason.slice(0, 300)}]` : ""}`),
  ];
  if (list.length > cap) lines.push(`- +${list.length - cap} more answered lines in the spines under this milestone`);
  if (list.some((a) => a.unwritten))
    lines.push(
      "An answer marked NOT in the spine yet was given in the console, which could not write it (reason in brackets): " +
        `write it in yourself first, flipping the open ask line to \`[answered <CODE> <YYYY-MM-DD> @${ownerName()}] … — answer: <the answer>\`, ` +
        "following the repo's Integration policy (a PR when the policy or a Deploy gate requires one; never push around it); it leaves this list once the spine shows it answered.",
    );
  if (list.some((a) => a.feedback))
    lines.push(
      `A FEEDBACK line is ${ownerName()} asking for changes, never an approval (E67): the row it names is active again. Make the next round now ` +
        "(dispatch a worker for a build) and bring it back to him as a NEW ask or review card; only then mark the feedback line ` · done <YYYY-MM-DD> <sha> round <n> <new code>`.",
    );
  lines.push(
    "Do the work each answer unblocks within your remit, add the Decisions row, unblock the row, update Current State, then mark the line consumed: append " +
      `\` · done <YYYY-MM-DD> <sha>\` inside its tag (\`[answered E904-A3 2026-10-22 @${ownerName()} · done 2026-10-23 abc1234]\`; the sha is the commit that did the work, optional) ` +
      "instead of deleting it, commit and push. A line with the marker leaves this list and its card turns done. " +
      `If an answer is itself a question (e.g. \"what are people saying in the ${deployerName()} GitHub?\"), research it, write the findings and a recommendation under the ask, ` +
      "and act if the step is reversible (re-ask with the recommendation only if it is in the ask tier); never leave the answer sitting.",
  );
  return lines;
}

/** Wake-prompt section: the owner's answers first, then the milestone's non-green leaves as the to-do (cap 30, then "+N more"). */
export function treeTodoSection(t: Tree, cap = 30, referenced: AnsweredAsk[] = []): string {
  const leaves = todoLeaves(t);
  const c = t.counts;
  const lines = [
    ...answeredSection(t, 20, referenced),
    "",
    "## Epic tree (your to-do)",
    `Objective: turn every node under this milestone green; at the end, report which nodes changed color.`,
    `Now: ${t.nonGreen} to turn green; ${c.green} green · ${c.blue} blue · ${c.yellow} yellow · ${c.red} red (${ownerName()}) · ${c.grey} grey; ${t.flagged} flagged (status not trustworthy).`,
    `Colors: grey = draft/ready/deferred/unknown, blue = active/review/testing, yellow = blocked on an agent/dependency, red = blocked on ${ownerName()}, green = done.`,
    `Red items need ${ownerName()}: raise a Needs ${ownerName()} item, do not work around them. Fix flagged nodes by making the spine honest (tick the DoD, or reopen the row).`,
  ];
  if (!leaves.length) lines.push("Every node is green and honest: verify the evidence, then report idle.");
  for (const l of leaves.slice(0, cap))
    lines.push(`- [${l.color}] ${l.id} — ${l.title.slice(0, 120)} — ${l.status.slice(0, 80)}${l.path ? ` — ${l.path}` : ""}${l.flags.length ? ` — flags: ${l.flags.join(", ")}` : ""}`);
  if (leaves.length > cap) lines.push(`- +${leaves.length - cap} more (GET /api/milestones/${t.milestoneId}/tree)`);
  return lines.join("\n");
}

const WAIT_STATES = ["open", "answered", "done", "superseded", "unresolved"];
/** Normalise spines.py `waits_on[]` (fields may be missing on older output). */
export function spinesWaits(v: unknown): SpinesWait[] {
  if (!Array.isArray(v)) return [];
  const out: SpinesWait[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : typeof x === "number" ? String(x) : null);
    const code = str(o.code);
    if (!code) continue;
    const state = str(o.state);
    out.push({
      ref: str(o.ref) ?? code,
      repo: str(o.repo),
      code,
      row: str(o.row),
      state: (WAIT_STATES.includes(state ?? "") ? state : "unresolved") as SpinesWait["state"],
    });
  }
  return out;
}
