import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Flag, Plus } from "lucide-react";
import { api, type NodeTree, type TreeNode } from "@/api";
import { mutate, useQuery } from "@/lib/data";
import { milestoneNodeHref, spineViewHref } from "@/lib/nodes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common";
import { EpicTree, FLAG_LABEL, HONESTY_FLAGS, TreeDot } from "@/components/tree";
import { WaitingOnYou } from "@/components/waiting";
import { InlineMd, milestoneDeckHref } from "@/pages/Milestone";
import { runsForMilestone, workedTicketIds } from "@/lib/derive";
import { milestoneName } from "@/lib/format";
import { deckCodeOf, deckHref } from "@/lib/deck";
import { cap, useRoutes, useWords } from "@/lib/skin";
import { EpicDeckLink } from "@/components/epicDeckLink";
import { homeWorld } from "@/lib/identity";

/**
 * any tree node opened as a milestone page: subtree status summary on top, then what waits on the owner from
 * this node down, then the subtree. Spine nodes can be tracked as a real milestone (or link to the one tracking them).
 */
export function MilestoneNodePage() {
  const { id = "", nodeKey = "" } = useParams();
  const m = useQuery(() => api.getMilestone(id), [id]);
  const t = useQuery(() => api.getNodeTree(id, nodeKey), [id, nodeKey]);
  // this milestone's runs only (all runs were ~900 KB, for the few ticket ids being worked on here).
  const { data: runs = [] } = useQuery(() => api.listRuns({ milestoneId: id }), [id]);
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const routes = useRoutes();
  if (m.error || t.error) return <ErrorBox error={(m.error ?? t.error)!} />;
  if (!m.data || !t.data) return <Loading />;
  return (
    <NodeView
      tree={t.data}
      back={
        <Link to={`/milestones/${id}?node=${encodeURIComponent(nodeKey)}`} className="inline-flex items-center gap-1 hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> {milestoneName(m.data)}
        </Link>
      }
      milestoneId={id}
      milestonePath={m.data.path}
      decks={routes("book") && (!m.data.world || m.data.world === homeWorld())}
      waiting={<WaitingOnYou milestoneId={id} nodeKey={nodeKey} scopeLabel={t.data.root.id} />}
      openHref={(n) => milestoneNodeHref(id, n.key)}
      worked={workedTicketIds(runsForMilestone(id, assignments, runs))}
    />
  );
}

/** ad hoc: any spine of any repo, untracked (`/spines/:repo/view?path=&node=`). */
export function SpineViewPage() {
  const { repo = "" } = useParams();
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const node = params.get("node") ?? undefined;
  const title = params.get("title") ?? undefined;
  const t = useQuery(() => api.getSpineTree({ repo, path, title, nodeKey: node }), [repo, path, node]);
  const routes = useRoutes();
  if (!path) return <Empty>No spine path given.</Empty>;
  if (t.error) return <ErrorBox error={t.error} />;
  if (!t.data) return <Loading />;
  return (
    <NodeView
      tree={t.data}
      back={
        <Link to={`/spines#${encodeURIComponent(repo)}`} className="inline-flex items-center gap-1 hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Spines · {repo}
        </Link>
      }
      decks={routes("book")}
      waiting={<WaitingOnYou spine={{ repo, path, title }} nodeKey={t.data.root.key} scopeLabel={t.data.root.id} />}
      openHref={(n) => (n.kind === "spine" && n.path ? spineViewHref({ repo, path: n.path }) : spineViewHref({ repo, path, title, nodeKey: n.key }))}
    />
  );
}

export function NodeView({
  tree,
  back,
  waiting,
  openHref,
  milestoneId,
  milestonePath,
  worked,
  decks,
}: {
  tree: NodeTree;
  back: ReactNode;
  waiting: ReactNode;
  openHref: (n: TreeNode) => string;
  /** The milestone this view belongs to (its own spine links to its page rather than "tracked elsewhere"). */
  milestoneId?: string;
  /** the milestone's own spine (its deck is the Deck tab with no epic). */
  milestonePath?: string;
  /** ticket ids a running child run works on (milestone views only). */
  worked?: Set<string>;
  /** show "Epic deck" on this epic and on each epic below it (the home world's console skin). */
  decks?: boolean;
}) {
  const n = tree.root;
  // an epic's page has no tabs, so its deck links open its milestone's Deck tab on that epic; a spine
  // seen outside any milestone (/spines/…/view) keeps its own deck page.
  const deckFor = (x: TreeNode) =>
    !decks || x.kind !== "spine" || !x.path
      ? undefined
      : milestoneId
        ? milestoneDeckHref(milestoneId, x, milestonePath)
        : tree.repo
          ? deckHref(tree.repo, deckCodeOf(x.code ?? x.id, x.path))
          : undefined;
  const own = deckFor(n);
  return (
    <>
      <div className="mb-2 text-xs text-muted-foreground">{back}</div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <TreeDot node={n} />
            <InlineMd text={n.title} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs">{n.id}</span>
            <span className="text-xs">{n.status}</span>
            {n.path && (
              <span className="font-mono text-xs">
                {tree.repo ? `${tree.repo} · ` : ""}
                {n.path}
              </span>
            )}
          </span>
        }
        actions={
          <span className="flex flex-wrap items-center gap-2 sm:justify-end">
            {own && <EpicDeckLink button href={own} />}
            <TrackAction tree={tree} node={n} milestoneId={milestoneId} />
          </span>
        }
      />
      <RowFacts node={n} />
      {n.children.length > 0 && <SubtreeSummary tree={tree} />}
      {waiting}
      {n.children.length > 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EpicTree
              tree={tree}
              worked={worked}
              openHref={(c) => (c.key === n.key ? undefined : openHref(c))}
              actions={(c) => {
                const href = c.key === n.key ? undefined : deckFor(c);
                return href ? <EpicDeckLink href={href} testId={`tree-deck-${c.id}`} /> : null;
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <LeafFlags node={n} />
      )}
    </>
  );
}

/** Track as milestone (spine nodes): creates a milestone for repo + path; a tracked spine links to its milestone. */
export function TrackAction({ tree, node, milestoneId }: { tree: NodeTree; node: TreeNode; milestoneId?: string }) {
  const navigate = useNavigate();
  const w = useWords();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (node.kind !== "spine" || !node.path) return null;
  const tracked = tree.tracked?.[node.path];
  if (tracked)
    return (
      <Button asChild variant="outline">
        <Link to={`/milestones/${tracked}`}>{tracked === milestoneId ? `${cap(w.milestone)} page` : `Open tracked ${w.milestone}`}</Link>
      </Button>
    );
  if (!tree.repo) return null;
  const track = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const m = await mutate(() => api.createMilestone({ title: node.title, repo: tree.remote ?? tree.repo!, path: node.path!, owner: "" }));
      navigate(`/milestones/${m.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={track} disabled={busy} pending={busy} pendingLabel="Tracking…">
        <Plus /> Track as {w.milestone}
      </Button>
      {error && <span className="text-xs text-red-700 dark:text-red-400">{error}</span>}
    </div>
  );
}

/**
 * the ledger row's own cells (Depends on, Needs, Owner, Next action), so a leaf ticket's page says what it
 * waits for and what comes next. Nothing when the row has none of them.
 */
export function RowFacts({ node }: { node: TreeNode }) {
  const facts: [string, string][] = [];
  for (const [k, v] of [["Depends on", node.dependsOn], ["Needs", node.needs], ["Owner", node.owner], ["Next action", node.nextAction]] as const) if (v) facts.push([k, v]);
  if (!facts.length) return null;
  return (
    <Card className="mb-6" data-testid="row-facts">
      <CardContent className="pt-6">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">
                <InlineMd text={v} />
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** a leaf has no subtree to draw: its honesty flags (with their notes) stand alone, else nothing. */
function LeafFlags({ node }: { node: TreeNode }) {
  const flags = node.flags.filter((f) => HONESTY_FLAGS.includes(f));
  if (!flags.length) return null;
  return (
    <div className="mt-4 grid gap-1 text-xs" data-testid="leaf-flags">
      <span className="flex flex-wrap items-center gap-1.5">
        <Flag className="h-3 w-3 text-amber-600" />
        {flags.map((x) => (
          <Badge key={x} variant="amber">
            {FLAG_LABEL[x] ?? x}
          </Badge>
        ))}
      </span>
      {node.notes?.map((t) => (
        <span key={t} className="text-muted-foreground">
          {t}
        </span>
      ))}
    </div>
  );
}

/**
 * Closed / finished notes and the flagged nodes of the subtree. The counts row is the tree card's (with its
 * filters), not repeated here; the card is left out when it would be empty.
 */
export function SubtreeSummary({ tree }: { tree: NodeTree }) {
  const flagged: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (n.flags.some((f) => f === "cycle" || f === "repeat")) return;
    if (n.flags.some((f) => HONESTY_FLAGS.includes(f))) flagged.push(n);
    n.children.forEach(walk);
  };
  walk(tree.root);
  if (!flagged.length && !tree.closed && !tree.finished) return null;
  return (
    <Card className="mb-6" data-testid="subtree-summary">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">From here down</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {tree.closed > 0 && <span className="text-xs text-muted-foreground">{tree.closed} closed (superseded / cancelled), not counted as to do</span>}
        {(tree.finished ?? 0) > 0 && <span className="text-xs text-muted-foreground">{tree.finished} finished epics folded, not counted</span>}
        {flagged.length > 0 && (
          <ul className="grid gap-1 text-xs" data-testid="subtree-flags">
            {flagged.slice(0, 10).map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-1.5">
                <Flag className="h-3 w-3 text-amber-600" />
                <span className="font-mono">{f.id}</span>
                <span className="min-w-0 truncate text-muted-foreground">{f.title}</span>
                {f.flags
                  .filter((x) => HONESTY_FLAGS.includes(x))
                  .map((x) => (
                    <Badge key={x} variant="amber">
                      {FLAG_LABEL[x] ?? x}
                    </Badge>
                  ))}
              </li>
            ))}
            {flagged.length > 10 && <li className="text-muted-foreground">+{flagged.length - 10} more flagged</li>}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
