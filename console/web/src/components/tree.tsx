import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, SquareArrowOutUpRight, X } from "lucide-react";
import type { MilestoneTree, TreeColor, TreeNode } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineMd } from "@/pages/Milestone";
import { cn } from "@/lib/utils";
import { HoldWord } from "@/components/planning";
import { ownerLabel } from "@/lib/owner";
import { ownerName } from "@/lib/identity";

/** palette (not the sidebar status dots): the persona's goal is every dot green. */
export const TREE_DOT: Record<TreeColor, string> = {
  grey: "bg-zinc-300 dark:bg-zinc-600",
  blue: "bg-sky-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
  green: "bg-emerald-500",
};

/**
 * `short` is what the counts row prints beside each number; `label` is the full meaning (tooltip).
 * the shorts are the owner's five words (2026-11-01): done / in progress / draft / waiting on you / blocked on a dependency.
 * palette, fixed: red = an open item for the owner (one per item, the same count as the Waiting on you tab), yellow =
 * blocked on a dependency or another persona, blue = open (solid running / in review, hollow ready with nobody on it),
 * grey = draft / deferred / superseded / unknown, green = done. Ancestors of a red node carry a red ring (not counted).
 */
export const TREE_LEGEND: { color: TreeColor; short: string; label: string }[] = [
  { color: "red", short: "waiting on you", label: `an open item for ${ownerName()} (one per item; the same count as Waiting on you)` },
  { color: "yellow", short: "blocked on a dependency", label: "blocked on a dependency (a row not done) or on another persona / agent" },
  { color: "blue", short: "in progress", label: "in progress: ready or active (solid = running or in review, hollow = ready, nobody on it)" },
  { color: "grey", short: "draft", label: "draft / deferred / superseded / unknown" },
  { color: "green", short: "done", label: "done" },
];

/** a ready row with no blocker shows a hollow blue dot until a running child run works on it. */
export const READY_IDLE_LABEL = "ready · nobody on it";

/** "idle" = ready, nothing blocks it, no worker on it; "worked" = ready and a running child run names it. */
export type ReadyState = "idle" | "worked";
export function readyState(n: Pick<TreeNode, "id" | "ready">, worked?: Set<string>): ReadyState | undefined {
  if (!n.ready) return undefined;
  return worked?.has(n.id.toUpperCase()) ? "worked" : "idle";
}

/** Flags that mean the status cannot be trusted (server HONESTY_FLAGS). */
export const HONESTY_FLAGS = ["unknown-status", "dishonest-green", "mismatch", "stale", "done-open-descendants"];
const REF_FLAGS = ["cycle", "repeat"];
export const FLAG_LABEL: Record<string, string> = {
  "unknown-status": "unknown status",
  "dishonest-green": "dishonest green",
  mismatch: "spine map mismatch",
  stale: "stale",
  "done-open-descendants": "done over open work",
  cycle: "cycle",
  repeat: "shown elsewhere",
  "depth-cap": "depth cap",
};

export const isFlaggedGreen = (n: TreeNode) => n.color === "green" && n.flags.some((f) => HONESTY_FLAGS.includes(f));

/** a finished epic (spines.py run_state), folded under its parent; reference nodes to one too. */
export const isFinishedNode = (n: Pick<TreeNode, "runState">) => n.runState === "finished";

/** Subtree needs attention: a non-green or flagged node anywhere below (refs, closed rows and finished epics ignored). */
export function needsWork(n: TreeNode): boolean {
  return n.children.some(
    (c) => !c.flags.some((f) => REF_FLAGS.includes(f)) && !isFinishedNode(c) && ((c.color !== "green" && !c.closed) || c.flags.some((f) => HONESTY_FLAGS.includes(f)) || needsWork(c)),
  );
}

/** a parent's fold of finished children: shown or not, kept per node key in localStorage (default folded). */
const FOLD_STORE = "epicTree.fold.";
const FOLD_PREFIX = "fold:";
function storedFold(key: string): boolean | undefined {
  try {
    const v = window.localStorage.getItem(FOLD_STORE + key);
    return v === "shown" ? true : v === "folded" ? false : undefined;
  } catch {
    return undefined;
  }
}
function storeFold(key: string, shown: boolean) {
  try {
    window.localStorage.setItem(FOLD_STORE + key, shown ? "shown" : "folded");
  } catch {
    /* storage off: the toggle still works for this page */
  }
}

/**
 * a node's own fold, kept per node key in localStorage: below the root every node starts folded and stays
 * as the owner left it (hand toggle, Expand all / Collapse all). The root is always open on load.
 */
const OPEN_STORE = "epicTree.open.";
function storedOpen(key: string): boolean | undefined {
  try {
    const v = window.localStorage.getItem(OPEN_STORE + key);
    return v === "open" ? true : v === "closed" ? false : undefined;
  } catch {
    return undefined;
  }
}
function storeOpen(key: string, open: boolean) {
  try {
    window.localStorage.setItem(OPEN_STORE + key, open ? "open" : "closed");
  } catch {
    /* storage off: the toggle still works for this page */
  }
}

export function TreeDot({ node, ready, className }: { node: Pick<TreeNode, "color" | "flags"> & Partial<Pick<TreeNode, "rollup" | "waiting" | "waitsOn">>; ready?: ReadyState; className?: string }) {
  // a status that names an answered ask ("status stale") rings any color, not only green.
  const flagged = (node.color === "green" || node.flags.includes("stale")) && node.flags.some((f) => HONESTY_FLAGS.includes(f));
  // a row waiting on an open ask counted elsewhere gets the red ring too (never a red dot, never counted).
  const rollup = !flagged && (node.rollup === "red" || !!node.waitsOn?.length) && node.color !== "red";
  return (
    <span
      data-testid="tree-dot"
      data-color={ready ? "blue" : node.color}
      data-flagged={flagged || undefined}
      data-rollup={rollup ? "red" : undefined}
      data-waiting={node.color === "red" && !ready ? (node.waiting ?? 1) : undefined}
      data-waits-on={node.waitsOn?.join(" ") || undefined}
      data-ready={ready}
      className={cn(
        "inline-block h-3.5 w-3.5 shrink-0 rounded-full",
        ready === "idle" ? "border-2 border-sky-500 bg-transparent" : ready === "worked" ? TREE_DOT.blue : TREE_DOT[node.color],
        flagged && "ring-[3px] ring-amber-500 ring-offset-1 ring-offset-background",
        rollup && "ring-2 ring-red-500/70 ring-offset-1 ring-offset-background",
        className,
      )}
    />
  );
}

/** Counted (non-reference) nodes that are ready with nobody on them. */
export function readyIdleCount(root: TreeNode, worked?: Set<string>): number {
  return readyCounts(root, worked).idle;
}

/** Counted (non-reference) ready nodes: all of them, and those nobody works on. The spine's own rows only (a child epic is one line). */
function readyCounts(root: TreeNode, worked?: Set<string>): { all: number; idle: number } {
  const k = { all: 0, idle: 0 };
  const walk = (n: TreeNode) => {
    if (n.flags.some((f) => REF_FLAGS.includes(f)) || (n !== root && isFinishedNode(n))) return;
    const r = readyState(n, worked);
    if (r) k.all++;
    if (r === "idle") k.idle++;
    if (n === root || n.kind !== "spine") n.children.forEach(walk);
  };
  walk(root);
  return k;
}

/**
 * counts per color as the tree draws them. Ready rows are grey on the server but drawn blue, so they count
 * as open (blue) here, not grey.
 */
export function treeTally(tree: MilestoneTree): Record<TreeColor, number> {
  const ready = readyCounts(tree.root).all;
  return { ...tree.counts, blue: tree.counts.blue + ready, grey: Math.max(0, tree.counts.grey - ready) };
}

/** what a counts item filters on: a drawn color, ready with nobody on it, or flagged. */
export type TreeFilterKey = TreeColor | "ready-idle" | "flagged";
const FILTER_KEYS: TreeFilterKey[] = [...TREE_LEGEND.map((l) => l.color), "ready-idle", "flagged"];

/** `?show=red,blue` → keys (unknown ones dropped, order kept). */
export function parseTreeFilter(v: string | null | undefined): TreeFilterKey[] {
  const want = new Set((v ?? "").split(",").map((x) => x.trim()));
  return FILTER_KEYS.filter((k) => want.has(k));
}

/** Does a (non-reference) node match any selected key? Ready rows are drawn blue, so they match blue, not grey. */
export function matchesTreeFilter(n: TreeNode, keys: TreeFilterKey[], worked?: Set<string>): boolean {
  if (n.flags.some((f) => REF_FLAGS.includes(f))) return false;
  const r = readyState(n, worked);
  const drawn: TreeColor = r ? "blue" : n.color;
  return keys.some((k) => (k === "ready-idle" ? r === "idle" : k === "flagged" ? n.flags.some((f) => HONESTY_FLAGS.includes(f)) : k === drawn));
}

/**
 * Keys of matching nodes, and of nodes with a match somewhere below (shown as context, forced open). Finished
 * epics below the root are closed work, as in the counts: never matched.
 */
function filterTree(root: TreeNode, keys: TreeFilterKey[], worked?: Set<string>): { match: Set<string>; context: Set<string> } {
  const match = new Set<string>();
  const context = new Set<string>();
  const visit = (n: TreeNode): boolean => {
    if (n !== root && isFinishedNode(n)) return false;
    const below = n.children.map(visit).some(Boolean);
    if (matchesTreeFilter(n, keys, worked)) match.add(n.key);
    if (below) context.add(n.key);
    return below || match.has(n.key);
  };
  visit(root);
  return { match, context };
}

/** One "● 5 blocked" item; the long meaning is the tooltip. */
function CountItem({
  dot,
  value,
  label,
  title,
  testId,
  pressed,
  onToggle,
}: {
  dot: ReactNode;
  value: number;
  label: string;
  title: string;
  testId: string;
  /** set with onToggle → the item is a filter toggle. */
  pressed?: boolean;
  onToggle?: () => void;
}) {
  const body = (
    <>
      {dot}
      <span className="font-medium tabular-nums" data-testid={`${testId}-value`}>
        {value}
      </span>
      <span className={cn(!pressed && "text-muted-foreground")}>{label}</span>
    </>
  );
  if (!onToggle)
    return (
      <span className="flex items-center gap-1.5 text-sm" data-testid={testId} title={title}>
        {body}
      </span>
    );
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pressed ? "border-foreground/40 bg-accent font-medium" : "border-transparent hover:bg-accent/50",
        value === 0 && "cursor-default opacity-50 hover:bg-transparent",
      )}
      data-testid={testId}
      title={title}
      aria-pressed={pressed}
      disabled={value === 0 && !pressed}
      onClick={onToggle}
    >
      {body}
    </button>
  );
}

/** "9 to turn green" + one row of dot · number · label (the legend is folded in, no separate row). */
export function TreeCounts({
  tree,
  worked,
  filter,
  onFilterChange,
}: {
  tree: MilestoneTree;
  worked?: Set<string>;
  /** selected filter keys; with onFilterChange each item is a toggle (counts stay totals). */
  filter?: TreeFilterKey[];
  onFilterChange?: (keys: TreeFilterKey[]) => void;
}) {
  const idle = readyIdleCount(tree.root, worked);
  const tally = treeTally(tree);
  const on = filter ?? [];
  const toggle = (k: TreeFilterKey) =>
    onFilterChange ? { pressed: on.includes(k), onToggle: () => onFilterChange(on.includes(k) ? on.filter((x) => x !== k) : FILTER_KEYS.filter((x) => x === k || on.includes(x))) } : {};
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="tree-counts">
      <span className="text-sm font-medium">{tree.nonGreen === 0 ? "All green" : `${tree.nonGreen} to turn green`}</span>
      {TREE_LEGEND.map(({ color, short, label }) => (
        <CountItem key={color} dot={<TreeDot node={{ color, flags: [] }} />} value={tally[color]} label={short} title={label} testId={`count-${color}`} {...toggle(color)} />
      ))}
      {(idle > 0 || on.includes("ready-idle")) && (
        <CountItem
          dot={<TreeDot node={{ color: "grey", flags: [] }} ready="idle" />}
          value={idle}
          label={READY_IDLE_LABEL}
          title="ready to start, no run works on it (counted in open)"
          testId="count-ready-idle"
          {...toggle("ready-idle")}
        />
      )}
      {(tree.planning ?? 0) > 0 && (
        <CountItem dot={<TreeDot node={{ color: "grey", flags: [] }} />} value={tree.planning!} label="planning" title={`Planning: drafts no wake works until ${ownerName()} stamps them ready (counted in grey)`} testId="count-planning" />
      )}
      {(tree.parked ?? 0) > 0 && (
        <CountItem dot={<TreeDot node={{ color: "grey", flags: [] }} />} value={tree.parked!} label="parked" title="Parked: deferred, no wake works them (counted in grey)" testId="count-parked" />
      )}
      {(tree.flagged > 0 || on.includes("flagged")) && (
        <CountItem
          dot={<TreeDot node={{ color: "green", flags: ["dishonest-green"] }} />}
          value={tree.flagged}
          label="flagged"
          title="flagged: status not trustworthy"
          testId="count-flagged"
          {...toggle("flagged")}
        />
      )}
      {onFilterChange && on.length > 0 && (
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => onFilterChange([])} data-testid="tree-filter-clear">
          <X className="h-3.5 w-3.5" /> Show all
        </Button>
      )}
    </div>
  );
}

/** Key without numbers, for pages that list many trees (Spines). */
export function TreeLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {TREE_LEGEND.map(({ color, short, label }) => (
        <span key={color} className="flex items-center gap-1.5" title={label}>
          <TreeDot node={{ color, flags: [] }} className="h-2.5 w-2.5" />
          {short}
        </span>
      ))}
      <span className="flex items-center gap-1.5" data-testid="legend-ready-idle">
        <TreeDot node={{ color: "grey", flags: [] }} ready="idle" className="h-2.5 w-2.5" />
        {READY_IDLE_LABEL}
      </span>
      <span className="flex items-center gap-1.5" title="status not trustworthy">
        <TreeDot node={{ color: "green", flags: ["dishonest-green"] }} className="h-2.5 w-2.5" />
        flagged
      </span>
    </div>
  );
}

/**
 * Collapsible epic tree. The root and its direct children show, everything below starts folded; each node's
 * fold is kept per node key (localStorage). Expand all / Collapse all set (and store) every node; a filter view opens
 * its matches and their context, and its toggles reset with each filter.
 */
export function EpicTree({
  tree,
  selectedKey,
  onSelect,
  openHref,
  worked,
  filter: filterProp,
  onFilterChange,
  actions,
}: {
  tree: MilestoneTree;
  selectedKey?: string;
  onSelect?: (n: TreeNode) => void;
  /** link of a node's "Open" action (node view); undefined = no action on that node. */
  openHref?: (n: TreeNode) => string | undefined;
  /** upper-cased ticket ids a running child run works on (workedTicketIds); absent = status only. */
  worked?: Set<string>;
  /** controlled filter (e.g. from `?show=`); without it the tree keeps its own. */
  filter?: TreeFilterKey[];
  onFilterChange?: (keys: TreeFilterKey[]) => void;
  /** per-node actions (Mark ready for delivery on a Planning epic). */
  actions?: (n: TreeNode) => ReactNode;
}) {
  const [ownFilter, setOwnFilter] = useState<TreeFilterKey[]>([]);
  const owner = ownerLabel(tree.owner);
  const filter = filterProp ?? ownFilter;
  const setFilter = onFilterChange ?? setOwnFilter;
  const filterId = filter.join(",");
  const view = useMemo(() => (filter.length ? filterTree(tree.root, filter, worked) : undefined), [tree, filterId, worked]);
  // Hand toggles while filtering live apart from the unfiltered ones and reset with each filter (default: open).
  const [normalOpen, setNormalOpen] = useState<Record<string, boolean>>({});
  const [filterOpen, setFilterOpen] = useState<{ id: string; open: Record<string, boolean> }>({ id: "", open: {} });
  const open = view ? (filterOpen.id === filterId ? filterOpen.open : {}) : normalOpen;
  const setOpen = (f: (o: Record<string, boolean>) => Record<string, boolean>) =>
    view ? setFilterOpen((s) => ({ id: filterId, open: f(s.id === filterId ? s.open : {}) })) : setNormalOpen(f);
  const toggleAll = (value: boolean) => {
    const next: Record<string, boolean> = {};
    const walk = (n: TreeNode) => {
      next[n.key] = value;
      if (!view && n !== tree.root && n.children.length) storeOpen(n.key, value);
      if (n.children.some(isFinishedNode)) next[FOLD_PREFIX + n.key] = value;
      n.children.forEach(walk);
    };
    walk(tree.root);
    setOpen(() => next);
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TreeCounts tree={tree} worked={worked} filter={filter} onFilterChange={setFilter} />
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => toggleAll(true)}>
            Expand all
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toggleAll(false)}>
            Collapse all
          </Button>
        </div>
      </div>
      {tree.warnings.map((w) => (
        <p key={w} className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {w}
        </p>
      ))}
      <ul role="tree" className="grid gap-0.5">
        <Row node={tree.root} depth={0} open={open} setOpen={setOpen} sel={{ key: selectedKey ?? tree.root.key, onSelect }} openHref={openHref} worked={worked} view={view} actions={actions} owner={owner} />
      </ul>
      {view && view.match.size === 0 && (
        <p className="px-1 text-sm text-muted-foreground" data-testid="tree-filter-empty">
          Nothing in this tree matches the filter.
        </p>
      )}
    </div>
  );
}

function Row({
  node,
  depth,
  open,
  setOpen,
  sel,
  openHref,
  worked,
  view,
  actions,
  owner,
}: {
  node: TreeNode;
  depth: number;
  open: Record<string, boolean>;
  setOpen: (f: (o: Record<string, boolean>) => Record<string, boolean>) => void;
  /** the selected node scopes "Waiting on you"; clicking a node's id selects it. */
  sel?: { key: string; onSelect?: (n: TreeNode) => void };
  openHref?: (n: TreeNode) => string | undefined;
  worked?: Set<string>;
  /** filter on → only matches and their ancestors (context, muted, open by default). */
  view?: { match: Set<string>; context: Set<string> };
  actions?: (n: TreeNode) => ReactNode;
  /** the world's owner (an ask naming nobody is theirs). */
  owner: string;
}) {
  const ready = readyState(node, worked);
  const all = view ? node.children.filter((c) => view.match.has(c.key) || view.context.has(c.key)) : node.children;
  // live children first, as before; finished epics behind one "N closed · show" line (default folded).
  const kids = all.filter((c) => !isFinishedNode(c));
  const finished = all.filter(isFinishedNode);
  const foldKey = FOLD_PREFIX + node.key;
  // a red item under a finished epic shows its fold, so every red dot is on screen on load.
  const redBelow = (c: TreeNode) => c.color === "red" || c.rollup === "red";
  const shown = finished.length > 0 && (open[foldKey] ?? (finished.some(redBelow) || (storedFold(node.key) ?? false)));
  const toggleFold = () => {
    storeFold(node.key, !shown);
    setOpen((o) => ({ ...o, [foldKey]: !shown }));
  };
  const dimmed = !!view && !view.match.has(node.key);
  const href = node.kind !== "dod" && !node.flags.some((f) => REF_FLAGS.includes(f)) ? openHref?.(node) : undefined;
  const hasKids = kids.length > 0 || finished.length > 0;
  // an ancestor of a red node opens on load (whatever was stored), so every counted red dot is visible.
  const expanded = hasKids && (open[node.key] ?? (!!view || depth === 0 || node.rollup === "red" || (storedOpen(node.key) ?? false)));
  const toggle = () => {
    if (!view && depth > 0) storeOpen(node.key, !expanded);
    setOpen((o) => ({ ...o, [node.key]: !expanded }));
  };
  const code = node.kind === "dod" ? `DoD ${node.id}` : (node.code ?? node.id);
  const tip = [node.title, node.kind !== "dod" ? node.path : undefined, ...(node.notes ?? [])].filter(Boolean).join("\n");
  const ref = node.flags.some((f) => REF_FLAGS.includes(f));
  return (
    <li role="treeitem" aria-expanded={hasKids ? expanded : undefined} data-key={node.key} data-filter={view ? (dimmed ? "context" : "match") : undefined}>
      <div
        data-closed={node.closed || undefined}
        className={cn("flex items-start gap-2 rounded-md py-1 pr-2 text-sm hover:bg-accent/50", (ref || dimmed || node.closed) && "opacity-60", dimmed && "text-muted-foreground", sel?.onSelect && sel.key === node.key && "bg-accent")}
        aria-selected={sel?.onSelect ? sel.key === node.key : undefined}
        style={{ paddingLeft: depth * 20 + 4 }}
        title={tip}
      >
        <button
          type="button"
          aria-label={hasKids ? (expanded ? `Collapse ${node.id}` : `Expand ${node.id}`) : undefined}
          className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground", !hasKids && "invisible")}
          onClick={toggle}
          tabIndex={hasKids ? 0 : -1}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <TreeDot node={node} ready={ready} className="mt-0.5" />
        {(node.waiting ?? 0) > 1 && (
          <span className="mt-0.5 shrink-0 rounded-full bg-red-500 px-1 text-[10px] font-medium leading-[14px] text-white tabular-nums" title={`${node.waiting} items waiting on you here`} data-testid="node-waiting">
            {node.waiting}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {sel?.onSelect && !ref ? (
              <button
                type="button"
                className={cn("shrink-0 font-mono text-xs hover:underline", node.kind === "spine" ? "font-semibold" : "text-muted-foreground")}
                title="Scope “Waiting on you” to this node"
                onClick={() => sel.onSelect!(node)}
              >
                {code}
              </button>
            ) : (
              <span className={cn("shrink-0 font-mono text-xs", node.kind === "spine" ? "font-semibold" : "text-muted-foreground")}>
                {code}
              </span>
            )}
            <span className={cn("min-w-0 break-words", node.kind === "spine" && "font-medium")} data-testid="tree-label">
              {node.label ?? <InlineMd text={node.title} />}
            </span>
            <span className="text-xs text-muted-foreground">{node.status}</span>
            {node.kind === "spine" && !ref && <HoldWord runState={node.runState} />}
            {!ref && actions?.(node)}
            {ready === "idle" && (
              <Badge variant="blue" data-testid="ready-idle" title="Nothing blocks this step and no worker is on it">
                {READY_IDLE_LABEL}
              </Badge>
            )}
            {ready === "worked" && (
              <Badge variant="blue" data-testid="ready-worked" title="A running child run works on this step">
                worker running
              </Badge>
            )}
            {href && (
              <Link
                to={href}
                className="inline-flex items-center gap-0.5 text-xs text-sky-700 hover:underline dark:text-sky-400"
                title="Open this node: its subtree status and what waits on you"
                aria-label={`Open ${node.id}`}
              >
                <SquareArrowOutUpRight className="h-3 w-3" /> Open
              </Link>
            )}
            {hasKids && !expanded && <CollapsedSummary node={node} />}
            {!!node.waitsOn?.length && (
              <Badge variant="red" data-testid="waits-on-ask" title="This row waits on your open ask; the ask is counted once, where it is written">
                waits on {node.waitsOn.join(", ")}
              </Badge>
            )}
            {node.asks?.map((a) => (
              <Badge key={a.question} variant="red" title={`${a.ask} @${a.who || owner}: ${a.question}`}>
                ask: {a.ask}
              </Badge>
            ))}
            {node.flags.map((f) => (
              <Badge key={f} variant={HONESTY_FLAGS.includes(f) ? "amber" : "gray"} title={node.notes?.join("\n")}>
                {FLAG_LABEL[f] ?? f}
              </Badge>
            ))}
          </div>
          {node.notes && node.flags.some((f) => HONESTY_FLAGS.includes(f)) && (
            <div className="text-xs text-amber-700 dark:text-amber-400">{node.notes.join(" · ")}</div>
          )}
        </div>
      </div>
      {expanded && (
        <ul role="group" className="grid gap-0.5">
          {kids.map((c) => (
            <Row key={c.key} node={c} depth={depth + 1} open={open} setOpen={setOpen} sel={sel} openHref={openHref} worked={worked} view={view} actions={actions} owner={owner} />
          ))}
          {finished.length > 0 && (
            <li role="none">
              <button
                type="button"
                className="flex items-center gap-1 rounded-md py-1 pr-2 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                style={{ paddingLeft: (depth + 1) * 20 + 4 }}
                aria-expanded={shown}
                data-testid="finished-fold"
                title="Finished epics (spines.py run_state finished): closed work, not counted"
                onClick={toggleFold}
              >
                {shown ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {finished.length} closed · {shown ? "hide" : "show"}
              </button>
            </li>
          )}
          {shown &&
            finished.map((c) => (
              <Row key={c.key} node={c} depth={depth + 1} open={open} setOpen={setOpen} sel={sel} openHref={openHref} worked={worked} view={view} actions={actions} owner={owner} />
            ))}
        </ul>
      )}
    </li>
  );
}

/**
 * "12 ● 3 ●" next to a collapsed node: what is hidden below it. Red counts items (each red node's `waiting`),
 * the unit of the Tree tab and Waiting on you; the other colors count nodes, as the counts row does.
 */
function CollapsedSummary({ node }: { node: TreeNode }) {
  const counts: Partial<Record<TreeColor, number>> = {};
  const walk = (n: TreeNode) =>
    n.children.forEach((c) => {
      if (c.flags.some((f) => REF_FLAGS.includes(f))) return;
      counts[c.color] = (counts[c.color] ?? 0) + (c.color === "red" ? (c.waiting ?? 1) : 1);
      walk(c);
    });
  walk(node);
  return (
    <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground" data-testid="collapsed-summary">
      {TREE_LEGEND.filter(({ color }) => counts[color]).map(({ color }) => (
        <span key={color} className="flex items-center gap-0.5" data-color={color}>
          <span className={cn("inline-block h-2 w-2 rounded-full", TREE_DOT[color])} />
          {counts[color]}
        </span>
      ))}
    </span>
  );
}
