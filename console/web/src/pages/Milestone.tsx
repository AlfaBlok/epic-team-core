import { MilestonePath } from "@/components/bootstrap";
import { useOwnCall } from "@/voice/OwnCall";
import { NeverOnBadge } from "@/components/neverOn";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Archive, ArrowLeft, ArrowUp, CheckSquare, ChevronRight, ExternalLink, Info, MessageCircle, Settings2, OctagonX, Pencil, Play, Plus, Send, Square, Trash2, Unlink, X } from "lucide-react";
import { AskKindTag } from "@/components/askKind";
import { MilestoneArc } from "@/components/arc";
import { api, needsAnswer, type Assignment, type ChatRead, type Milestone, type MilestoneStatusView, type MilestoneTree, type Persona, type TreeNode, type Repo, type Run, type SpineShape, type WaitingItem } from "@/api";
import { mutate, useQuery } from "@/lib/data";
import { dodCount, formatCadence, formatDateTime, formatRelative, milestoneName, scheduleLabel } from "@/lib/format";
import { assignmentRunStats, canSettle, filterRunsByPersona, isAnswerRun, nextWake, runningOnly, runsForMilestone, timelineGroups, workedTicketIds } from "@/lib/derive";
import { Button } from "@/components/ui/button";
import { ChatView } from "@/pages/Chat";
import { useCallDock } from "@/voice/CallPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MoreTabMenu, useTabFold } from "@/components/tabFold";
import { Badge } from "@/components/ui/badge";
import { EpicDeckLink } from "@/components/epicDeckLink";
import { EpicDeckView } from "@/pages/EpicDeck";
import { deckCodeOf } from "@/lib/deck";
import { cap, useRoutes, useSkin, useWords } from "@/lib/skin";
import { MadeOfLink } from "@/pages/MadeOf";
import { DATA_TABS, FIRST_TAB, FIVE_LABELS, FIVE_TABS, FOLDED_PART, fiveTabFromParams, type FiveTab } from "@/lib/totems";
import { CampaignContextTab, CampaignKeyResultsTab, CampaignPagesTab } from "./social/WheelTabs";
import { ChatIntro, HistoryTab, ObservationsTab, PillarsTab, WaitingTab, WorkTab } from "@/pages/social/Totems";
import { CampaignTrackersTab } from "@/components/trackersTab";
import { PersonaLogTab } from "@/components/personaLogTab";
import { worldId } from "@/lib/useSocial";
import { CampaignProductTab, Crumbs } from "@/pages/social/Motion";
import { brandOfRepo, useProject } from "@/lib/project";
import { CampaignGoalBlock } from "@/components/CampaignGoal";
import { CampaignChannels, ChannelStrip } from "@/components/CampaignChannels";
import { CampaignProvider, campaignsByMilestone, repoLevelIds, useCampaigns } from "@/lib/campaign";
import { CampaignForceReview, PipelinePage } from "@/pages/social/Pipeline";
import { HistoryPage } from "@/pages/social/History";
import { BriefDirectionsTab, CampaignActions } from "@/pages/social/CampaignTabs";
import { Empty, ErrorBox, Field, Loading, OutcomeBadge, PageHeader, RelTime, StatusBadge, ThreadLink } from "@/components/common";
import { FreshnessLine } from "@/components/freshness";
import { FocusPinButton } from "@/components/focusPin";
import { AssignmentDialog, ConfirmDialog, RunNowDialog, SteerDialog, StopDialog } from "@/components/dialogs";
import { AddButton } from "@/components/runControls";
import { chatAboutFromParams, DiscussButton, discussable } from "@/components/ticketSession";
import { cn } from "@/lib/utils";
import { EpicTree, parseTreeFilter, TREE_DOT, TREE_LEGEND, TreeDot, treeTally, type TreeFilterKey } from "@/components/tree";
import { milestoneNodeHref, spineHref } from "@/lib/nodes";
import { OwnerActivityList, WaitingOnYou } from "@/components/waiting";
import { MilestoneTopCard } from "@/components/outcome";
import { ApprovalsTab } from "@/components/approvals";
import { RunTimeline } from "@/components/timeline";
import { BlockedBy, ClampText, waitingAnchor, WriteControl } from "@/components/unblock";
import { MilestoneStrip, OpenAsksContext } from "@/components/status";
import { HeaderMarks, MarkAndSettle, MarkDialog, markHistory } from "@/components/mark";
import { NextWakeList, StampButton } from "@/components/planning";
import { openAskCodes } from "@/lib/status";
import { milestoneInbox, useBlocked, useMilestoneStatus, useReviewCards, useStatusBatch } from "@/lib/inbox";
import { useSnoozes } from "@/lib/snooze";
import { GOAL_INBOX_TAB, GoalHeader, TabStrip, objectiveTab } from "@/components/goalSets";
import { WaitingForReview } from "@/components/review";
import { ObjectiveApprovals, ObjectivePersonas } from "@/components/objectivePersonas";
import { personasOfObjective } from "@/lib/objectivePersonas";
import { milestoneAnswer, milestoneWheelRows } from "@/lib/bigRoots";
import { sameRepo } from "../lib/repoNames";
import { homeWorld } from "@/lib/identity";
import { InlineMd } from "@/components/inlineMd";
import { PlanTab } from "@/pages/social/PlanTab";
import { useWheelPages, WheelPagesTab } from "@/components/wheelPages";
import { pagesOfMilestone } from "@/lib/wheelPages";
import { objectiveOf, productHref, scorecardHref } from "@/lib/scorecards";
export { objectiveOf };
export { InlineMd };

/** a campaign (a milestone whose repo has the social pack) gets three tabs in front; it opens on Pipeline. */
const CAMPAIGN_TABS = ["pipeline", "plan", "brief", "history"] as const;
const TABS = [...CAMPAIGN_TABS, "summary", "waiting", "tree", "chat", "deck", "activity", "personas", "pages", "approvals", "backlog", "definitions", "settings"] as const;
type Tab = (typeof TABS)[number];
/** each tab's name in the More menu (the Waiting and Tree tabs carry counts on the strip). */
const TAB_LABEL: Record<Tab, string> = {
  pipeline: "Pipeline",
  plan: "Plan",
  brief: "Brief & directions",
  history: "History",
  summary: "Summary",
  waiting: "Waiting on you",
  tree: "Tree",
  chat: "Chat",
  deck: "Deck",
  activity: "Activity",
  personas: "Personas",
  pages: "Pages",
  approvals: "Approvals",
  backlog: "Backlog",
  definitions: "Definitions",
  settings: "Settings",
};
/** On a campaign these sit under "more" (mockup note 2). */
const MORE_TABS: { id: Tab; label: string }[] = [
  { id: "approvals", label: "Approvals" },
  { id: "backlog", label: "Backlog" },
  { id: "definitions", label: "Definitions" },
];

/**
 * ?tab= → tab. Old links: overview → definitions; no tab but ?node= (/13 tree links) → tree; else the home tab:
 * summary, or Pipeline on a campaign. A campaign tab on a milestone that is not a campaign is its summary.
 */
export function tabFromParams(params: URLSearchParams, campaign = false): Tab {
  const t = params.get("tab") ?? "";
  if (t === "overview") return "definitions";
  if ((CAMPAIGN_TABS as readonly string[]).includes(t)) return campaign ? (t as Tab) : "summary";
  if ((TABS as readonly string[]).includes(t)) return t as Tab;
  return params.get("node") ? "tree" : campaign ? "pipeline" : "summary";
}

/** Search string for a tab, keeping ?node= (the home tab with no node = bare URL); ?show= is the Tree tab's filter. */
function tabSearch(tab: Tab, node?: string, show?: TreeFilterKey[], home: Tab = "summary"): Record<string, string> {
  // ?epic= (the Deck tab's epic) and ?slide= belong to the Deck tab and leave with it.
  return { ...(tab === home && !node ? {} : { tab }), ...(node ? { node } : {}), ...(tab === "tree" && show?.length ? { show: show.join(",") } : {}) };
}
const tabHref = (tab: Tab, node?: string, show?: TreeFilterKey[]) => `?${new URLSearchParams(tabSearch(tab, node, show))}`;

/**
 * One objective, one screen (the owner, vn_748ec5a1): "It's like we have two
 * contexts, like two dashboards for one objective. That is a total, absolute, utter mess." A milestone that is an
 * objective's (its scorecard node, first in his order, carries its id) opens that objective's screen, on the tab that
 * does the old tab's job now (OLD_TAB_TO_OBJECTIVE); a campaign keeps its page, and a milestone no objective holds
 * (another repo's own milestone) keeps this page until it has one.
 */

export function MilestonePage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const camps = useCampaigns();
  const { data: sets, error } = useQuery(() => api.listScorecards(), []);
  const campaign = campaignsByMilestone(camps.data?.campaigns).has(id);
  if (!sets && !error) return <Loading />;
  if (camps.loading && !camps.data) return <Loading />;
  const objective = campaign ? undefined : objectiveOf(sets?.nodes, id);
  if (objective) {
    const asked = params.get("tab") ?? (params.get("node") ? "tree" : "summary");
    const next = new URLSearchParams(params);
    next.set("tab", asked);
    next.delete("node");
    return <Navigate to={`${scorecardHref(objective.id)}?${next}`} replace />;
  }
  // a goal no objective holds opens the same screen as an objective; a campaign keeps its own page.
  return campaign ? <MilestoneScreen /> : <GoalMilestoneScreen />;
}

/** a goal's tabs, the objective's own names and order (goalSets TABS): one way to open every goal. */
const GOAL_TABS = [
  { id: "table", label: "Key results" },
  { id: "kanban", label: "Board" },
  { id: "inbox", label: "Inbox" },
  { id: "chat", label: "Chat desk" },
  { id: "context", label: "Context" },
  { id: "personas", label: "Personas" },
  { id: "pages", label: "Pages" },
] as const;

/** ?item=<id> (a blocked run's link) scrolls its card into view and rings it for 4 s. */
function useItemHighlight(item: string | null, ready: unknown) {
  useEffect(() => {
    if (!item) return;
    let tries = 0;
    let unmark: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      const el = document.getElementById(waitingAnchor(item));
      if (!el && ++tries < 40) return;
      clearInterval(timer);
      if (!el) return;
      el.scrollIntoView?.({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-sky-500", "ring-offset-2");
      el.setAttribute("data-highlighted", "true");
      unmark = setTimeout(() => {
        el.classList.remove("ring-2", "ring-sky-500", "ring-offset-2");
        el.removeAttribute("data-highlighted");
      }, 4000);
    }, 150);
    return () => {
      clearInterval(timer);
      if (unmark) clearTimeout(unmark);
    };
  }, [item, ready]);
}

/**
 * A goal no objective holds (the house, a server, another repo's milestone), opened the way an objective opens (the
 * owner: "Why sidebar element selection work so different when selecting a goal or a 'project'? What's
 * the difference? Everything"): its circle, name and answer in one box, then the objective's tabs. The old tabs live
 * inside them (OLD_TAB_TO_OBJECTIVE): Summary is Key results, Tree and Backlog the Board, Waiting on you the Inbox (its
 * asks and its review cards, the sidebar's two pills), Chat the Chat desk, Definitions, Deck and Approvals the Context,
 * Activity and Settings the Personas.
 */
function GoalMilestoneScreen() {
  const { id = "" } = useParams();
  const w = useWords();
  const [params, setParams] = useSearchParams();
  const routes = useRoutes();
  const { data: m, error, loading } = useQuery(() => api.getMilestone(id), [id]);
  const decks = !!m && routes("book") && (!m.world || m.world === homeWorld());
  // an old Tree row link (?node= with no tab) opens the Board on that node.
  const asked = params.get("tab") ?? (params.get("node") ? "tree" : null);
  const tab = objectiveTab(asked);
  const node = params.get("node") ?? undefined;
  const show = parseTreeFilter(params.get("show"));
  const { data: waiting } = useQuery(() => api.listWaitingOnOwner({ milestoneId: id, nodeKey: node }), [id, node], { tag: "inbox" });
  const treeQuery = useQuery(() => api.getTree(id), [id]);
  const pagesList = useWheelPages();
  const { data: status } = useMilestoneStatus(id);
  const blocked = useBlocked(status, { nodeKey: node });
  const openIds = status && new Set(blocked.map((i) => i.id));
  const open = (waiting ?? []).filter((i) => (openIds ? openIds.has(i.id) : needsAnswer(i)));
  // the Inbox tab's pills are the sidebar entry's, from the same function on the same batch and review list.
  const { data: batch } = useStatusBatch();
  const { entries: snoozing } = useSnoozes();
  const { cards } = useReviewCards();
  const counts = milestoneInbox(batch, cards, id, snoozing);
  useItemHighlight(tab === "inbox" ? params.get("item") : null, waiting);
  if (error) return <ErrorBox error={error} />;
  if (loading || !m) return <Loading />;
  const scopeLabel = node ? node.split("/").pop() : undefined;
  const nodeSpine = node && treeQuery.data ? spineOf(treeQuery.data.root, node) : undefined;
  const deckEpic = params.get("epic") || (nodeSpine?.path && nodeSpine.path !== m.path ? deckCodeOf(nodeSpine.code ?? nodeSpine.id, nodeSpine.path) : undefined);
  const board = (key?: string, keys?: TreeFilterKey[]) => setParams({ tab: "kanban", ...(key ? { node: key } : {}), ...(keys?.length ? { show: keys.join(",") } : {}) }, { replace: true });
  const myPages = pagesOfMilestone(pagesList.data, m.repo);
  return (
    <OpenAsksContext.Provider value={openAskCodes(waiting)}>
      <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-3" data-testid="goal-milestone-page" data-milestone-id={m.id}>
        <Ancestry m={m} />
        <GoalHeader rows={milestoneWheelRows(status)} title={milestoneName(m)} answer={milestoneAnswer(status)} />
        <TabStrip tabs={GOAL_TABS} tab={tab} keep={{ node }} pills={{ inbox: counts }} counts={pagesList.data ? { pages: myPages.length } : undefined} label={`This ${w.milestone}'s pages`} />
        {tab === "table" && (
          <div className="grid gap-3">
            {/* how it stands (Outcome, Flow, Settled) and whether it leads the sidebar's other goals, one quiet line. */}
            <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="goal-status-line">
              <HeaderMarks m={m} status={status} treeHref="?tab=tree" />
              {m.settledAt && (
                <Badge variant="gray" title={`Settled ${formatRelative(m.settledAt)}: hidden from the sidebar and Team home; the status is unchanged.`} data-testid="settled-badge">
                  Settled
                </Badge>
              )}
              <FocusPinButton m={m} />
            </div>
            <MilestoneStrip status={status} waitingHref={`?tab=${GOAL_INBOX_TAB}`} />
            <SummaryTab m={m} node={node} open={open} scopeLabel={scopeLabel} tree={treeQuery} status={status} />
          </div>
        )}
        {tab === "kanban" && (
          <div className="grid gap-6">
            <TreeTab m={m} tree={treeQuery} selectedKey={node} onSelect={(key) => board(key, show)} filter={show} onFilterChange={(keys) => board(node, keys)} />
            <BacklogTab m={m} />
          </div>
        )}
        {tab === "inbox" && (
          <div className="grid gap-4" data-testid="goal-inbox">
            <WaitingOnYou milestoneId={m.id} nodeKey={node} scopeLabel={scopeLabel} />
            <WaitingForReview only={(c) => c.milestoneId === m.id} title="Ready for your review" />
          </div>
        )}
        {tab === "chat" && <MilestoneChat key={m.id} m={m} />}
        {tab === "context" &&
          (asked === "deck" && decks ? (
            <MilestoneDeckTab m={m} epic={deckEpic} />
          ) : (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2" data-testid="goal-context-actions">
                {decks && (
                  <Button asChild size="sm" variant="outline">
                    <Link to={`?${new URLSearchParams({ tab: "deck", ...(node ? { node } : {}) })}`} data-testid="goal-open-deck">
                      Open its deck
                    </Link>
                  </Button>
                )}
                <span className="font-mono text-xs text-muted-foreground">
                  {m.repo} · <MilestonePath path={m.path} /> · Owner: {m.owner}
                </span>
              </div>
              <FreshnessLine milestoneId={m.id} />
              <Overview m={m} needsYou={(status?.needsYou ?? 0) > 0} />
              <ObjectiveApprovals milestoneId={m.id} />
            </div>
          ))}
        {/* the objective's own Personas tab (switches, pause, their runs), then this goal's settings. */}
        {tab === "personas" && (
          <div className="grid gap-6">
            <ObjectivePersonas milestoneId={m.id} />
            <details className="group rounded-xl border bg-card/50" data-testid="goal-settings">
              <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm text-muted-foreground hover:text-foreground">Settings</summary>
              <div className="p-3 pt-0">
                <SettingsTab m={m} />
              </div>
            </details>
          </div>
        )}
        {tab === "pages" && <WheelPagesTab pages={myPages} loading={pagesList.loading} what={w.milestone} />}
      </div>
    </OpenAsksContext.Provider>
  );
}

function MilestoneScreen() {
  const { id = "" } = useParams();
  const w = useWords();
  const [params, setParams] = useSearchParams();
  const routes = useRoutes();
  // is this milestone a campaign (its repo has the social pack)? The world's campaign cards say so.
  const camps = useCampaigns();
  const card = campaignsByMilestone(camps.data?.campaigns).get(id);
  // in the social skin a campaign has five fixed tabs (Brief, Work, Observations, History, Chat); the console
  // skin keeps its tabs (L-5: the build team's console changes after the owner's week on these).
  const skinId = useSkin().id;
  const project = useProject();
  const five = !!card && skinId === "social";
  const ftab = fiveTabFromParams(params);
  const home: Tab = card ? "pipeline" : "summary";
  const { data: m, error, loading } = useQuery(() => api.getMilestone(id), [id]);
  // the deck (the home world's console skin only; another world's milestone and the social skin have none). Round 3
  // (the owner: "it's one more tab section, like chat or summary or definitions"): a Deck tab, the deck shown inside it.
  const decks = !!m && routes("book") && (!m.world || m.world === homeWorld());
  const asked = tabFromParams(params, !!card);
  const tab: Tab = asked === "deck" && m && !decks ? home : asked;
  // the Tree tab's selected node (?node=<key>) scopes "Waiting on you"; none = the whole milestone.
  const node = params.get("node") ?? undefined;
  const show = parseTreeFilter(params.get("show"));
  const { data: waiting } = useQuery(() => api.listWaitingOnOwner({ milestoneId: id, nodeKey: node }), [id, node], { tag: "inbox" });
  // one tree fetch feeds the Tree tab's label pills, the Summary tile and the Tree tab.
  const treeQuery = useQuery(() => api.getTree(id), [id]);
  // the pages made for it (vn_dad96778): a milestone no objective holds (the house) keeps its pages in its own tab.
  const pagesList = useWheelPages();
  // the server's status (flow, outcome, pending items): header strip, outcome chip, Settle, Waiting on box.
  // the same fetch its Waiting on you list reads (one per milestone), so the tab and the list never disagree.
  const { data: status } = useMilestoneStatus(id);
  // the tab counts the status items (same list as the Team badge and the Pending selector), scoped to the node.
  // with this browser's snoozes, through the function the list itself shows (lib/inbox blockedItems).
  const blocked = useBlocked(status, { nodeKey: node });
  const openIds = status && new Set(blocked.map((i) => i.id));
  // The open cards (strip, Current State amber row): the waiting items the status counts open (free-text asks too).
  const open = (waiting ?? []).filter((i) => (openIds ? openIds.has(i.id) : needsAnswer(i)));
  const waitingCount = openIds ? openIds.size : open.length;
  // ?tab=waiting&item=<id> (links from blocked runs / nj_ ids) scrolls to that card and highlights it.
  const item = tab === "waiting" ? params.get("item") : null;
  useEffect(() => {
    if (!item) return;
    let tries = 0;
    let unmark: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      const el = document.getElementById(waitingAnchor(item));
      if (!el && ++tries < 40) return;
      clearInterval(timer);
      if (!el) return;
      el.scrollIntoView?.({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-sky-500", "ring-offset-2");
      el.setAttribute("data-highlighted", "true");
      unmark = setTimeout(() => {
        el.classList.remove("ring-2", "ring-sky-500", "ring-offset-2");
        el.removeAttribute("data-highlighted");
      }, 4000);
    }, 150);
    return () => {
      clearInterval(timer);
      if (unmark) clearTimeout(unmark);
    };
  }, [item, waiting]);
  // the tabs stay on one line; what does not fit folds under More (a campaign's More is always there).
  const tabIds: Tab[] = card
    ? ["pipeline", "plan", "brief", "history", "chat", "summary", "waiting", "tree", ...(decks ? (["deck"] as Tab[]) : []), "activity", "personas", "pages", "settings"]
    : ["summary", "waiting", "tree", "chat", ...(decks ? (["deck"] as Tab[]) : []), "activity", "personas", "pages", "approvals", "backlog", "definitions", "settings"];
  const { ref: tabsRef, folded } = useTabFold(tabIds, tab, !!card);
  const fold = (v: Tab, className?: string) => ({ "data-tab-id": v, className: cn(className, folded.has(v) && "hidden") });

  if (error) return <ErrorBox error={error} />;
  if (loading || !m) return <Loading />;
  // The home tab depends on the campaign cards: wait for them (briefly) before choosing it.
  if (camps.loading && !camps.data && !params.get("tab") && !node) return <Loading />;
  const scope = card ? { repo: card.repo, card, milestoneId: m.id, ...(card.campaign ? { campaign: card.campaign.code } : {}) } : undefined;
  const scopeLabel = node ? node.split("/").pop() : undefined;
  // the Deck tab shows ?epic=<code> (a Tree row's deck link), else the epic picked in the Tree, else the milestone's own.
  const nodeSpine = node && treeQuery.data ? spineOf(treeQuery.data.root, node) : undefined;
  const deckEpic = params.get("epic") || (nodeSpine?.path && nodeSpine.path !== m.path ? deckCodeOf(nodeSpine.code ?? nodeSpine.id, nodeSpine.path) : undefined);

  // the quiet lines about the campaign (its marks, repo, owner, product, auto-approve, freshness). In the social skin they
  // sit under the tabs, so the tabs come early as on the objective screen (vn_15aa4467: "the tabs are like very early on on the page").
  const meta = (
          <span className="flex flex-wrap items-center gap-2">
            <HeaderMarks m={m} status={status} treeHref={five ? "?tab=work" : tabHref("tree", node)} />
            {m.settledAt && (
              <Badge variant="gray" title={`Settled ${formatRelative(m.settledAt)}: hidden from the sidebar and Team home; the status is unchanged.`} data-testid="settled-badge">
                Settled
              </Badge>
            )}
            {/* repo, file and owner on one quiet line of their own. */}
            <span className="flex basis-full flex-wrap items-baseline gap-x-3.5 gap-y-0.5 text-xs text-muted-foreground" data-testid="header-meta">
              <span className="font-mono text-xs">
                {m.repo} · <MilestonePath path={m.path} />
              </span>
              <span>Owner: {m.owner}</span>
              {/* the product this campaign is for, its words written once on the product page. */}
              {card?.product && !five && (
                <Link to={productHref(card.product.id)} className="underline decoration-border underline-offset-4 hover:text-foreground" data-testid="campaign-product-name">
                  Product: {card.product.name}
                </Link>
              )}
              {/* the campaign's Auto-approve toggle, in this quiet line, one click away. */}
              {five && scope && (
                <CampaignProvider scope={scope}>
                  <CampaignForceReview />
                </CampaignProvider>
              )}
            </span>
            <FreshnessLine milestoneId={m.id} />
          </span>
  );
  return (
    <OpenAsksContext.Provider value={openAskCodes(waiting)}>
      {/* a named campaign's page does not lead with its repo's own level in the social skin. */}
      {/* (the owner: "We should have project, campaign, and then sections with tabs, all linked to the campaign"):
          a campaign in the social skin shows Project › Campaign › Tab. */}
      {five && card ? (
        <Crumbs
          items={[
            { label: project.projectOf(m.id)?.name ?? brandOfRepo(card.repo), to: `/?project=${encodeURIComponent(card.repo)}` },
            { label: milestoneName(m), to: `/milestones/${encodeURIComponent(m.id)}` },
            { label: FIVE_LABELS[ftab] },
          ]}
        />
      ) : (
        <Ancestry m={m} hidden={card?.campaign ? repoLevelIds(camps.data?.campaigns) : undefined} />
      )}
      <PageHeader
        title={milestoneName(m)}
        actions={
          <span className="flex flex-wrap gap-2 sm:justify-end">
            {/* pin or unpin this milestone in Team home's focus list, from here (both skins). */}
            <FocusPinButton m={m} />
            {/* a campaign is renamed or retired (paused and hidden, nothing deleted) from its page. */}
            {card && <CampaignActions m={m} card={card} />}
            {five && (
              <Button asChild size="sm" variant="outline">
                <Link to="?tab=settings" data-testid="campaign-settings" title="This campaign's settings">
                  <Settings2 /> Settings
                </Link>
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <Link to={five ? "?tab=chat" : tabHref("chat", node)} data-testid="chat-about-this" title={`This ${w.milestone}'s chat with its repo desk`}>
                <MessageCircle /> Chat about this
              </Link>
            </Button>
          </span>
        }
        description={five ? undefined : meta}
      />
      {!five && <MilestoneStrip status={status} waitingHref={tabHref("waiting", node)} />}
      {/* a campaign is tracked by its name and its one goal: the goal, the number toward it, what waits on the owner. */}
      {card?.goal && <CampaignGoalBlock card={card} />}
      {/* per channel the account, its sign-in, cadence, objective, metric and the summed counts with the trend. */}
      {!five && card?.channels?.length ? <CampaignChannels card={card} /> : null}
      {five && scope ? (
        <>
          <CampaignFiveTabs m={m} tab={ftab} scope={scope} waitingCount={waitingCount} onTab={(t) => setParams(t === FIRST_TAB ? {} : { tab: t }, { replace: true })} />
          {/* under the key results: where the campaign runs now, then its quiet lines (its channels are under the Plan). */}
          {ftab === FIRST_TAB && (
            <section className="mt-8 grid gap-4 border-t pt-6" data-testid="campaign-under-plan">
              <MilestoneStrip status={status} waitingHref="?tab=waiting" />
              {meta}
            </section>
          )}
        </>
      ) : (
      <Tabs value={tab} onValueChange={(v) => setParams(tabSearch(v as Tab, node, undefined, home), { replace: true })}>
        {/* one line at every width, every tab reachable: the ones that
            do not fit fold under More (tabFold.tsx), never a sideways scroll. Triggers never shrink. */}
        <TabsList ref={tabsRef} className="h-9 w-full flex-nowrap justify-start overflow-visible [&>button]:shrink-0" data-testid="milestone-tabs">
          {card && (
            <>
              <TabsTrigger value="pipeline" {...fold("pipeline")}>Pipeline</TabsTrigger>
              {/* the campaign's marketing plan, eight fixed sections, one tab. */}
              <TabsTrigger value="plan" {...fold("plan")} data-testid="tab-plan">Plan</TabsTrigger>
              <TabsTrigger value="brief" {...fold("brief")}>Brief &amp; directions</TabsTrigger>
              <TabsTrigger value="history" {...fold("history")}>History</TabsTrigger>
              {/* the campaign's own chat (its context, with Call), next to its tabs, as the console's milestone Chat tab. */}
              <TabsTrigger value="chat" {...fold("chat")}>Chat</TabsTrigger>
            </>
          )}
          <TabsTrigger value="summary" {...fold("summary")}>Summary</TabsTrigger>
          <TabsTrigger value="waiting" {...fold("waiting", "gap-1.5")}>
            Waiting on you
            <span
              data-testid="waiting-count"
              className={cn("rounded-full px-1.5 text-[11px] leading-5", waitingCount > 0 ? "bg-amber-500 text-white" : "bg-background text-muted-foreground")}
            >
              {waitingCount}
            </span>
          </TabsTrigger>
          <TabsTrigger value="tree" {...fold("tree", "gap-1.5")}>
            Tree
            {treeQuery.data && <TreeTabPills tree={treeQuery.data} />}
          </TabsTrigger>
          {!card && <TabsTrigger value="chat" {...fold("chat")}>Chat</TabsTrigger>}
          {decks && (
            <TabsTrigger value="deck" {...fold("deck")} data-testid="tab-deck">
              Deck
            </TabsTrigger>
          )}
          <TabsTrigger value="activity" {...fold("activity")}>Activity</TabsTrigger>
          <TabsTrigger value="personas" {...fold("personas")}>Personas</TabsTrigger>
          <TabsTrigger value="pages" {...fold("pages", "gap-1.5")} data-testid="tab-pages">
            Pages
            {pagesList.data && <span className="rounded-full bg-background px-1.5 text-[11px] leading-5 text-muted-foreground">{pagesOfMilestone(pagesList.data, m.repo).length}</span>}
          </TabsTrigger>
          {!card && (
            <>
              <TabsTrigger value="approvals" {...fold("approvals")}>Approvals</TabsTrigger>
              <TabsTrigger value="backlog" {...fold("backlog")}>Backlog</TabsTrigger>
              <TabsTrigger value="definitions" {...fold("definitions")}>Definitions</TabsTrigger>
            </>
          )}
          <TabsTrigger value="settings" {...fold("settings")}>Settings</TabsTrigger>
          <MoreTabMenu
            items={[...tabIds.filter((t) => folded.has(t)).map((t) => ({ id: t, label: TAB_LABEL[t] })), ...(card ? MORE_TABS : [])]}
            current={tab}
            onPick={(t) => setParams(tabSearch(t as Tab, node, undefined, home), { replace: true })}
          />
        </TabsList>
        {scope && (
          <CampaignProvider scope={scope}>
            <TabsContent value="pipeline">{tab === "pipeline" && <PipelinePage />}</TabsContent>
            <TabsContent value="plan">{tab === "plan" && <PlanTab m={m} />}</TabsContent>
            <TabsContent value="brief">{tab === "brief" && <BriefDirectionsTab card={scope.card} />}</TabsContent>
            <TabsContent value="history">{tab === "history" && <HistoryPage />}</TabsContent>
          </CampaignProvider>
        )}
        <TabsContent value="summary">
          <SummaryTab m={m} node={node} open={open} scopeLabel={scopeLabel} tree={treeQuery} status={status} />
        </TabsContent>
        <TabsContent value="waiting">
          <WaitingOnYou milestoneId={m.id} nodeKey={node} scopeLabel={scopeLabel} />
        </TabsContent>
        <TabsContent value="tree">
          <TreeTab
            m={m}
            tree={treeQuery}
            selectedKey={node}
            onSelect={(key) => setParams(tabSearch("tree", key, show), { replace: true })}
            filter={show}
            onFilterChange={(keys) => setParams(tabSearch("tree", node, keys), { replace: true })}
          />
        </TabsContent>
        <TabsContent value="chat">
          {/* mounted only while open, so the repo desk's thread launches when the owner first opens the tab. */}
          {tab === "chat" && <MilestoneChat key={m.id} m={m} />}
        </TabsContent>
        {decks && (
          <TabsContent value="deck">
            {/* mounted only while open; the deck's own slides and its last, Everything made for this. */}
            {tab === "deck" && <MilestoneDeckTab m={m} epic={deckEpic} />}
          </TabsContent>
        )}
        <TabsContent value="activity">
          <OwnerActivityList milestoneId={m.id} />
          <ActivityTab m={m} />
        </TabsContent>
        <TabsContent value="personas">
          <PersonasTab m={m} />
        </TabsContent>
        <TabsContent value="pages">
          {tab === "pages" && <WheelPagesTab pages={pagesOfMilestone(pagesList.data, m.repo)} loading={pagesList.loading} what={w.milestone} />}
        </TabsContent>
        <TabsContent value="approvals">
          <ApprovalsTab m={m} />
        </TabsContent>
        <TabsContent value="backlog">
          <BacklogTab m={m} />
        </TabsContent>
        <TabsContent value="definitions">
          <Overview m={m} needsYou={(status?.needsYou ?? 0) > 0} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab m={m} />
        </TabsContent>
      </Tabs>
      )}
    </OpenAsksContext.Provider>
  );
}

/**
 * a campaign's fixed tabs in the social skin: one per kind of node of the product's data graph, listed once in its
 * graph file (lib/wheelTabs.ts, lib/totems FIVE_TABS); each id below is how that node is drawn. The owner 24 Nov: "it's
 * the same console is what I'm saying. with slightly different data tabs". Key results first, then the product's data
 * tabs, set apart by a thin rule (Benefits, the anchor and the product's messages, with the product inside it; Plan; Pipeline; History), then the
 * console's engine tabs, the same as an objective's (Inbox, Chat, Personas, Board, Context, Pages, Trackers, Log). The
 * social kit sits under the Plan, the lessons in the Context, as on an objective; an old ?tab=kit, ?tab=observations or
 * ?tab=product link opens the tab that holds it and scrolls to its part. Settings sit behind the header's Settings button.
 */
function CampaignFiveTabs({ m, tab, scope, waitingCount, onTab }: { m: Milestone; tab: FiveTab; scope: Parameters<typeof CampaignProvider>[0]["scope"]; waitingCount: number; onTab: (t: FiveTab) => void }) {
  // the campaign's Trackers tab reads the tables of the wheel it serves.
  const loadTrackers = useCallback(async () => api.getCampaignTrackers(await worldId(), m.id), [m.id]);
  const [params] = useSearchParams();
  const part = FOLDED_PART[params.get("tab") ?? ""];
  // an old link to a tab now folded into another brings that part into view once it has drawn.
  useEffect(() => {
    if (!part) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(part);
      if (!el && ++tries < 40) return;
      clearInterval(timer);
      el?.scrollIntoView?.({ block: "start" });
    }, 150);
    return () => clearInterval(timer);
  }, [part]);
  const oldHistory = (
    <CampaignProvider scope={scope}>
      <HistoryPage />
    </CampaignProvider>
  );
  const runs = (
    <>
      <OwnerActivityList milestoneId={m.id} />
      <ActivityTab m={m} />
    </>
  );
  return (
    <Tabs value={tab === "settings" ? "" : tab} onValueChange={(v) => onTab(v as FiveTab)}>
      <TabsList className="h-auto w-full flex-wrap justify-start gap-y-1 [&>button]:shrink-0" data-testid="five-tabs">
        {FIVE_TABS.map((t, i) => (
          <TabsTrigger
            key={t}
            value={t}
            // the product's own data tabs sit between two thin rules: the rest is the console, the same on every app.
            className={cn("gap-1.5", i > 0 && DATA_TABS.has(t) !== DATA_TABS.has(FIVE_TABS[i - 1]) && "relative ml-2 before:absolute before:-left-1.5 before:inset-y-1.5 before:w-px before:bg-border")}
            data-testid={`tab-${t}`}
            data-kind={DATA_TABS.has(t) ? "data" : "engine"}
          >
            {FIVE_LABELS[t]}
            {t === "waiting" && waitingCount > 0 && (
              <span data-testid="waiting-count" className="rounded-full bg-amber-500 px-1.5 text-[11px] leading-5 text-white">
                {waitingCount}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
      {/* each tab is a property of the campaign; the made-of screen says what each holds and where it lives. */}
      <div className="mt-1 flex justify-end">
        <MadeOfLink kind="campaign" />
      </div>
      <div className="mt-4 min-w-0">
        {tab === "table" && <CampaignKeyResultsTab m={m} />}
        {tab === "plan" && (
          <div className="grid gap-10">
            <PlanTab m={m} />
            {/* the social kit node of the product's graph, under the plan as on an objective: each channel, its account and sign-in, how often it posts. */}
            {scope && (
              <section id="campaign-kit" className="grid scroll-mt-4 gap-3 border-t pt-6" data-testid="campaign-kit">
                <h2 className="text-lg font-semibold">Social kit</h2>
                {scope.card.channels?.length ? (
                  <>
                    {/* drawn first, the accounts and counts fold under it (the card check: a plan section is a diagram). */}
                    <ChannelStrip card={scope.card} />
                    <details className="text-sm" open={part === "campaign-kit"} data-testid="campaign-kit-detail">
                      <summary className="cursor-pointer select-none text-muted-foreground">Accounts, cadence and post counts</summary>
                      <div className="mt-3">
                        <CampaignChannels card={scope.card} />
                      </div>
                    </details>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No channel set up yet. The social kit holds each channel this campaign posts on, its account and how often it posts.</p>
                )}
              </section>
            )}
          </div>
        )}
        {tab === "waiting" && <WaitingTab m={m} />}
        {tab === "personas" && <PersonasTab m={m} />}
        {tab === "pipeline" && (
          <CampaignProvider scope={scope}>
            <PipelinePage approval={false} />
          </CampaignProvider>
        )}
        {tab === "work" && <WorkTab m={m} />}
        {tab === "context" && <CampaignContextTab m={m} lessons={<ObservationsTab m={m} />} />}
        {tab === "pages" && <CampaignPagesTab m={m} repo={scope?.card.repo} />}
        {tab === "benefits" && (
          <div className="grid gap-10">
            <PillarsTab m={m} repo={scope?.card.repo} campaign={scope?.card.campaign?.code} />
            {/* the owner: "The benefits and then the product and everything is kind of embedded": the product deck, price and feature list under the benefits. */}
            {scope && (
              <section id="campaign-product" className="grid scroll-mt-4 gap-3 border-t pt-6" data-testid="benefits-product">
                <h2 className="text-lg font-semibold">Product</h2>
                <CampaignProductTab repo={scope.card.repo} code={scope.card.campaign?.code} m={m} product={scope.card.product} />
              </section>
            )}
          </div>
        )}
        {tab === "trackers" && <CampaignTrackersTab load={loadTrackers} />}
        {tab === "log" && <PersonaLogTab wheel={`milestone:${m.id}`} />}
        {tab === "history" && <HistoryTab m={m} posts={oldHistory} runs={runs} />}
        {tab === "chat" && (
          <>
            <ChatIntro />
            <MilestoneChat key={m.id} m={m} />
          </>
        )}
        {tab === "settings" && (
          <div className="grid gap-6" data-testid="settings-view">
            <Link to="?" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> Back to the key results
            </Link>
            <section className="grid gap-2">
              <h2 className="text-lg font-semibold">Settings</h2>
              <SettingsTab m={m} />
            </section>
          </div>
        )}
      </div>
    </Tabs>
  );
}


// ---------- Chat tab ----------

/** The milestone's own chat: its repo desk's one long-lived T3 thread (the global Chat page stays the Team desk). */
function MilestoneChat({ m }: { m: Milestone }) {
  const w = useWords();
  const [thread, setThread] = useState<{ threadId?: string; environmentId?: string; ownServer?: boolean }>({});
  // a Discuss button (?about=<id>&title=&run=) makes the item the context: chip + `[page: <milestone> · <id>]` on the next message.
  const [params, setParams] = useSearchParams();
  const about = chatAboutFromParams(params);
  const hint = about ? [milestoneName(m), about.id, ...(about.run ? [about.run] : [])].join(" · ") : "";
  const label = about ? `About ${[about.id, ...(about.title ? [about.title] : []), ...(about.run ? [`run ${about.run}`] : [])].join(" · ")}` : undefined;
  const clearHint = useCallback(
    () =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          for (const k of ["about", "title", "run"]) next.delete(k);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const load = useCallback((read?: ChatRead) => api.getMilestoneChat(m.id, read), [m.id]);
  const send = useCallback((text: string, page?: string, id?: string, files?: string[]) => (files?.length ? api.sendMilestoneChatMessage(m.id, text, page, id, files) : api.sendMilestoneChatMessage(m.id, text, page, id)), [m.id]);
  const markSeen = useCallback(() => api.markChatSeen({ chat: "milestone", id: m.id }), [m.id]);
  // the same Call as the desk page (the Chat page of a world is this chat on DeskPage), on this milestone's own voice routes.
  // a Team home card's Call opens this tab with ?call=1: the call starts by itself, then the flag leaves the URL.
  const call = useCallDock({
    base: `/api/milestones/${encodeURIComponent(m.id)}/voice`,
    where: m.title,
    autoStart: params.get("call") === "1",
    onAutoStart: () =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete("call");
          return next;
        },
        { replace: true },
      ),
  });
  // a project of a workspace on its own server and AI calls with the browser's own speech (never our voice key)
  const own = useOwnCall({ load: () => load(), send: (t, page, id) => send(t, page, id) });
  const ownServer = !!thread.ownServer;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="milestone-chat">
      {/* on a phone the description folds away and this row holds Open in T3 and the compact Call (the idle call bar
          folds away there), so the chat starts near the top. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground max-sm:flex-nowrap max-sm:justify-end">
        <span className="min-w-0 [overflow-wrap:anywhere] max-sm:hidden">The repo desk for this {w.milestone}: what happened, what is next, new ideas under it, and running or stopping its personas.</span>
        {thread.threadId && (
          <ThreadLink threadId={thread.threadId} environmentId={thread.environmentId} className="inline-flex items-center gap-1 underline max-sm:min-h-11" title="Open the repo desk's thread in T3">
            <ExternalLink className="h-3.5 w-3.5" /> Open in T3
          </ThreadLink>
        )}
        {!ownServer && call.button}
      </div>
      <ChatView
        voiceBase={ownServer ? "" : `/api/milestones/${encodeURIComponent(m.id)}/voice`}
        top={ownServer ? own.bar : call.bar}
        live={ownServer ? undefined : call.live}
        liveKey={ownServer ? own.phase : call.liveKey}
        who="Repo desk"
        load={load}
        cacheKey={`milestone:${m.id}`}
        sendMessage={send}
        markSeen={markSeen}
        hint={hint}
        hintLabel={label}
        clearHint={clearHint}
        placeholder={about ? `Ask about ${about.id}…` : `Ask about this ${w.milestone}, bring an idea for it…`}
        onThread={setThread}
        attach
      />
    </div>
  );
}

// ---------- Header: ancestry breadcrumb ----------

const spineUrl = (remote: string | undefined, p: string) => (remote ? `https://github.com/${remote}/blob/HEAD/${p.replace(/^\.\//, "")}` : undefined);

/** Checkout a milestone's `repo` points at (name, local path or owner/name), as the server resolves it. */
export const checkoutFor = (repo: string, repos: Repo[]) => repos.find((r) => r.name === repo || r.path === repo || r.remote === repo) ?? repos.find((r) => sameRepo(r.remote, repo));

/**
 * Parent spines from the repo root down to this milestone (doctrine.servesChain is parent → root). A crumb opens the
 * milestone tracking that spine, else its ad hoc spine view; GitHub when the checkout is unknown.
 */
export function Ancestry({ m, hidden }: { m: Milestone; hidden?: ReadonlySet<string> }) {
  const all = [...(m.doctrine?.servesChain ?? [])].reverse();
  const { data: repos } = useQuery(() => (all.length ? api.listRepos() : Promise.resolve([])), [m.id, all.length]);
  const { data: milestones } = useQuery(() => (all.length ? api.listMilestones() : Promise.resolve([])), [m.id, all.length]);
  const tracked = Object.fromEntries((milestones ?? []).filter((x) => sameRepo(x.repo, m.repo) && x.path).map((x) => [x.path.replace(/^\.\//, ""), x.id]));
  // `hidden`: milestones left out of the trail (a campaign's repo level, repoLevelIds); unknown until the list is in.
  const chain = hidden?.size ? (milestones ? all.filter((a) => !hidden.has(tracked[a.path.replace(/^\.\//, "")] ?? "")) : []) : all;
  if (chain.length === 0) return null;
  const checkout = repos && checkoutFor(m.repo, repos);
  return (
    <nav aria-label="Ancestry" className="mb-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
      {chain.map((a) => {
        const path = a.path.replace(/^\.\//, "");
        const inConsole = checkout ? spineHref({ repo: checkout.name, path, title: a.title }, tracked) : undefined;
        const gh = spineUrl(m.remote, a.path);
        return (
          <span key={a.path} className="flex min-w-0 items-center gap-1">
            {inConsole ? (
              <Link className="truncate hover:text-foreground hover:underline" to={inConsole} title={a.path}>
                {a.title}
              </Link>
            ) : gh ? (
              <a className="truncate hover:text-foreground hover:underline" href={gh} target="_blank" rel="noreferrer" title={a.path}>
                {a.title}
              </a>
            ) : (
              <span className="truncate" title={a.path}>
                {a.title}
              </span>
            )}
            <ChevronRight aria-hidden className="h-3 w-3 shrink-0" />
          </span>
        );
      })}
      <span aria-current="page" className="truncate text-foreground">
        {milestoneName(m)}
      </span>
    </nav>
  );
}

// ---------- Summary ----------

type TreeQuery = { data?: MilestoneTree; error?: Error; loading: boolean };

/** red / amber / blue pills on the Tree tab label, the same numbers as the tree's counts; zero pills hidden. */
const TAB_PILLS = [
  { color: "red", noun: "waiting on you" },
  { color: "yellow", noun: "blocked" },
  { color: "blue", noun: "open" },
] as const;
function TreeTabPills({ tree }: { tree: MilestoneTree }) {
  const tally = treeTally(tree);
  return (
    <>
      {TAB_PILLS.filter(({ color }) => tally[color] > 0).map(({ color, noun }) => (
        <span
          key={color}
          data-testid={`tree-tab-${color}`}
          title={`${tally[color]} ${noun}`}
          aria-label={`${tally[color]} ${noun}`}
          className={cn("rounded-full px-1.5 text-[11px] leading-5 tabular-nums text-white", TREE_DOT[color])}
        >
          {tally[color]}
        </span>
      ))}
    </>
  );
}

function SummaryTab({ m, node, open, scopeLabel, tree, status }: { m: Milestone; node?: string; open: WaitingItem[]; scopeLabel?: string; tree: TreeQuery; status?: MilestoneStatusView }) {
  // ?mark=1 (the Ready to mark item's link) opens the mark dialog.
  const [params] = useSearchParams();
  const [marking, setMarking] = useState(params.get("mark") === "1");
  useEffect(() => {
    if (params.get("mark") === "1") setMarking(true);
  }, [params]);
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const { data: runs = [] } = useQuery(() => api.listRuns({ milestoneId: m.id }), [m.id]);
  const mine = runsForMilestone(m.id, assignments, runs);
  return (
    <div className="grid grid-cols-1 gap-4">
      <WaitingStrip open={open} href={tabHref("waiting", node)} scopeLabel={scopeLabel} />
      <MilestoneArc id={m.id} />
      {status?.outcome.word === "reopened" && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm" data-testid="reopened-line">
          <span className="font-semibold">Reopened · {status.outcome.open ?? "some"} open</span> under this spine: not accomplished until that work is done or you re-mark it.{" "}
          <a href={tabHref("tree", node)} className="font-medium underline-offset-2 hover:underline">
            Tree →
          </a>
          {markHistory(m) && <span className="block text-xs text-muted-foreground">History: {markHistory(m)}</span>}
        </div>
      )}
      <MarkAndSettle m={m} status={status} openMark={() => setMarking(true)} />
      {marking && <MarkDialog m={m} onClose={() => setMarking(false)} />}
      <MilestoneTopCard m={m} runs={mine} open={open} waitingHref={tabHref("waiting", node)} outcome={status?.outcome} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TreeTile tree={tree} href={(show) => tabHref("tree", node, show)} />
        <PersonasTile m={m} assignments={assignments.filter((a) => a.milestoneId === m.id)} href={tabHref("personas", node)} />
        <ActivityTile runs={mine} href={tabHref("activity", node)} />
      </div>
    </div>
  );
}

/** Count + the first two asks + "see all"; nothing when no ask is open. */
export function WaitingStrip({ open, href, scopeLabel }: { open: WaitingItem[]; href: string; scopeLabel?: string }) {
  if (open.length === 0) return null;
  return (
    <div data-testid="waiting-strip" className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm sm:flex-row sm:items-center">
      <span className="flex shrink-0 items-center gap-2 font-medium">
        <span className="rounded-full bg-amber-500 px-1.5 text-[11px] leading-5 text-white">{open.length}</span>
        waiting on you{scopeLabel ? ` (from ${scopeLabel} down)` : ""}
      </span>
      <ul className="grid min-w-0 flex-1 gap-1 text-muted-foreground">
        {open.slice(0, 2).map((i) => (
          <li key={i.id} className="flex min-w-0 items-baseline gap-1">
            <AskKindTag kind={i.ask} />
            {i.code ? <span className="shrink-0 font-mono font-semibold">{i.code}</span> : null}
            <ClampText className="flex-1" text={i.question} links={false} />
          </li>
        ))}
      </ul>
      <Link className="shrink-0 font-medium hover:underline" to={href}>
        see all →
      </Link>
    </div>
  );
}

function Tile({ title, href, children }: { title: string; href: string; children: ReactNode }) {
  return (
    <Link to={href} aria-label={`${title} tab`} className="block min-w-0 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50">
      <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title} <ChevronRight className="h-3.5 w-3.5" />
      </div>
      {children}
    </Link>
  );
}

/** not one big link like the other tiles: the header opens the Tree tab, each count opens it filtered to that color. */
function TreeTile({ tree: { data, error }, href }: { tree: TreeQuery; href: (show?: TreeFilterKey[]) => string }) {
  const tally = data && treeTally(data);
  return (
    <div className="min-w-0 rounded-lg border bg-card p-4">
      <Link
        to={href()}
        aria-label="Tree tab"
        className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        Tree <ChevronRight className="h-3.5 w-3.5" />
      </Link>
      {error ? (
        <span className="text-sm text-muted-foreground">Tree not readable.</span>
      ) : !data || !tally ? (
        <span className="text-sm text-muted-foreground">Loading…</span>
      ) : (
        <div className="grid gap-2">
          <Link to={href()} className="text-sm font-medium hover:underline">
            {data.nonGreen === 0 ? "All green" : `${data.nonGreen} to turn green`}
          </Link>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {TREE_LEGEND.map(({ color, short, label }) =>
              tally[color] > 0 ? (
                <Link key={color} to={href([color])} className="flex items-center gap-1 rounded text-sm hover:underline" data-testid={`tile-count-${color}`} title={`${label}: show only these`}>
                  <TreeDot node={{ color, flags: [] }} className="h-2.5 w-2.5" />
                  <span className="font-medium tabular-nums">{tally[color]}</span>
                  <span className="text-xs text-muted-foreground">{short}</span>
                </Link>
              ) : (
                <span key={color} className="flex items-center gap-1 text-sm" data-testid={`tile-count-${color}`} title={label}>
                  <TreeDot node={{ color, flags: [] }} className="h-2.5 w-2.5" />
                  <span className="font-medium tabular-nums">{tally[color]}</span>
                  <span className="text-xs text-muted-foreground">{short}</span>
                </span>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PersonasTile({ m, assignments, href }: { m: Milestone; assignments: Assignment[]; href: string }) {
  const parked = assignments.filter((a) => a.parkedAt && !a.enabled).length;
  const active = assignments.filter((a) => a.enabled).length;
  const next = m.paused ? undefined : assignments.map((a) => nextWake(a).at).filter((x): x is string => !!x).sort()[0];
  return (
    <Tile title="Personas" href={href}>
      {assignments.length === 0 ? (
        <span className="text-sm text-muted-foreground">None attached.</span>
      ) : (
        <div className="grid gap-1 text-sm">
          <span className="font-medium">{assignments.length} attached</span>
          <span className="text-muted-foreground">
            {active} active · {parked} parked
          </span>
          <span className="text-xs text-muted-foreground">next run {m.paused ? "— (paused)" : <RelTime iso={next} />}</span>
        </div>
      )}
    </Tile>
  );
}

function ActivityTile({ runs, href }: { runs: Run[]; href: string }) {
  const last = runs
    .filter((r) => !r.parentRunId) // answer runs included: the tile is a feed, labelled below
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 3);
  return (
    <Tile title="Activity" href={href}>
      {last.length === 0 ? (
        <span className="text-sm text-muted-foreground">No runs yet.</span>
      ) : (
        <ul className="grid gap-1.5">
          {last.map((r) => (
            <li key={r.id} className="grid min-w-0 gap-0.5 text-xs text-muted-foreground">
              {/* Badge + time on their own line: a narrow tile keeps the whole width for the summary. */}
              <span className="flex flex-wrap items-center gap-x-2">
                {isAnswerRun(r) && <Badge variant="blue">answer run</Badge>}
                <OutcomeBadge outcome={r.outcome} run={r} />
                <span><RelTime iso={r.startedAt} /></span>
              </span>
              <ClampText text={r.summary} lines={2} links={false} />
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}

// ---------- Tree ----------

function TreeTab({
  m,
  tree: { data, error, loading },
  selectedKey,
  onSelect,
  filter,
  onFilterChange,
}: {
  m: Milestone;
  tree: TreeQuery;
  selectedKey?: string;
  onSelect: (key?: string) => void;
  /** ?show= keys. */
  filter: TreeFilterKey[];
  onFilterChange: (keys: TreeFilterKey[]) => void;
}) {
  const { data: runs = [] } = useQuery(() => api.listRuns({ milestoneId: m.id }), [m.id]);
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const routes = useRoutes();
  const decks = routes("book") && (!m.world || m.world === homeWorld());
  // the rows that can be discussed (Discuss opens the Chat tab) and their ticket sessions from before (still linked).
  const { data: sessions = [] } = useQuery(() => api.listTicketSessions(m.id), [m.id]);
  const rows = useMemo(() => (data ? discussable(data.root) : new Map<string, string>()), [data]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty>No tree.</Empty>;
  return (
    <Card>
      <CardContent className="pt-6">
        {/* the owner's guard rail: what the next standing wake starts here. */}
        <NextWakeList milestoneId={m.id} />
        <EpicTree
          tree={data}
          selectedKey={selectedKey}
          onSelect={(n) => onSelect(n.key === data.root.key ? undefined : n.key)}
          openHref={(n) => milestoneNodeHref(m.id, n.key)}
          worked={workedTicketIds(runsForMilestone(m.id, assignments, runs))}
          filter={filter}
          onFilterChange={onFilterChange}
          actions={(n) =>
            rows.has(n.key) ? (
              <DiscussButton
                milestoneId={m.id}
                row={n.id}
                {...(n.title && n.title !== n.id ? { title: n.title } : {})}
                session={sessions.find((s) => s.rowId.toLowerCase() === n.id.toLowerCase() && s.path === rows.get(n.key))}
              />
            ) : n.kind === "spine" ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {decks && <EpicDeckLink href={deckTabHref(n, m.path)} testId={`tree-deck-${n.id}`} />}
                {(n.runState === "planning" || n.runState === "ready") && (
                  <StampButton milestoneId={m.id} to={n.runState === "planning" ? "ready" : "draft"} {...(n.path && n.path !== m.path ? { path: n.path } : {})} />
                )}
                <AddButton milestoneId={m.id} nodeTitle={n.title} {...(n.path && n.path !== m.path ? { path: n.path } : {})} />
              </span>
            ) : null
          }
        />
      </CardContent>
    </Card>
  );
}

/** the epic a tree node belongs to: the node when it is a spine, else its nearest spine above it. */
export function spineOf(root: TreeNode, key: string): TreeNode | undefined {
  const walk = (n: TreeNode, up?: TreeNode): TreeNode | undefined => {
    const here = n.kind === "spine" ? n : up;
    if (n.key === key) return here;
    for (const c of n.children) {
      const f = walk(c, here);
      if (f) return f;
    }
    return undefined;
  };
  return walk(root);
}

// ---------- Deck tab ----------

/**
 * A Tree row's deck link: the milestone's Deck tab, on that epic (`?tab=deck&epic=<code>`); the milestone's own spine, its
 * own deck (`?tab=deck`). A spine with no EPIC-n or M<n> code goes by its file name, as `/deck/<repo>/<code>` does.
 */
export function deckTabHref(n: { id: string; code?: string; path?: string }, milestonePath?: string): string {
  if (!n.path || n.path === milestonePath) return "?tab=deck";
  return `?${new URLSearchParams({ tab: "deck", epic: deckCodeOf(n.code ?? n.id, n.path) })}`;
}

/** The milestone's link to its Deck tab on one epic, from anywhere (an epic's own page has no tabs). */
export const milestoneDeckHref = (milestoneId: string, n: { id: string; code?: string; path?: string }, milestonePath?: string) =>
  `/milestones/${encodeURIComponent(milestoneId)}${deckTabHref(n, milestonePath)}`;

/**
 * the owner: "it's one more tab section, like chat or summary or definitions. And then the deck shows inside
 * of it, within the tab". The milestone's deck, or `epic`'s (same repo), shown in the tab; the server names the
 * milestone's repo and its own deck (GET /api/deck-of, the decks may still be building: asked again every 3 s).
 */
export function MilestoneDeckTab({ m, epic }: { m: Milestone; epic?: string }) {
  const [, setParams] = useSearchParams();
  const [ref, setRef] = useState<{ repo: string; code: string } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () =>
      api
        .deckOf(m.id)
        .then((r) => {
          if (!alive) return;
          const at = r.href?.match(/\/([^/]+)\/([^/?#]+)$/);
          if (at) setRef({ repo: decodeURIComponent(at[1]), code: decodeURIComponent(at[2]) });
          else timer = setTimeout(go, 3_000);
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e : new Error(String(e))));
    void go();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [m.id]);
  if (error) return <ErrorBox error={error} />;
  if (!ref) return <Loading />;
  const code = epic || ref.code;
  const other = code.toUpperCase() !== ref.code.toUpperCase();
  return (
    <div className="pt-2" data-testid="milestone-deck">
      <EpicDeckView
        key={`${ref.repo}/${code}`}
        repo={ref.repo}
        code={code}
        embedded={{
          links: other ? (
            <button type="button" className="underline" data-testid="deck-milestone-own" onClick={() => setParams({ tab: "deck" }, { replace: true })}>
              {milestoneName(m)}'s own deck
            </button>
          ) : undefined,
        }}
      />
    </div>
  );
}

// ---------- Overview ----------

export const UNTRACKED_NOTE = "These criteria aren't checkboxes, so progress can't be tracked. Make them `- [ ]` items under `## Definition Of Done` to track them.";

export function DodCard({ m }: { m: Milestone }) {
  const dod = m.dod ?? { done: 0, total: 0, items: [] };
  const untracked = dod.tracked === false;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Definition of Done</CardTitle>
          <span className="text-sm text-muted-foreground">{dodCount(dod)}</span>
        </div>
        {!untracked && <Progress value={dod.total ? (dod.done / dod.total) * 100 : 0} />}
      </CardHeader>
      <CardContent>
        {dod.items.length === 0 ? (
          <Empty>{m.docError ? `Could not read the file: ${m.docError}` : "No Definition of Done / Acceptance / Exit Test list in this file."}</Empty>
        ) : (
          <ul className="grid gap-2">
            {dod.items.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {item.checked === null ? (
                  item.id ? (
                    <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{item.id}.</span>
                  ) : (
                    <span aria-hidden className="mx-1.5 mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                  )
                ) : item.checked ? (
                  <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className={cn(item.checked === true && "text-muted-foreground line-through")}>
                  <InlineMd text={item.text} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {untracked && (
          <p className="mt-4 flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              <InlineMd text={UNTRACKED_NOTE} />
            </span>
          </p>
        )}
        <p className="mt-4 text-xs text-muted-foreground">Read from the spine; edit it in the repo.</p>
      </CardContent>
    </Card>
  );
}

const SHAPE_ROWS: { key: keyof SpineShape; label: string; expects: string }[] = [
  { key: "dod", label: "Definition of Done / Acceptance", expects: "`- [ ]` items under `## Definition Of Done` (or Acceptance / Exit Test)" },
  { key: "currentState", label: "Current State", expects: "a `## Current State` section" },
  { key: "status", label: "Status", expects: "a `Status:` line in Current State" },
  { key: "waitingOn", label: "Waiting on", expects: "a `Waiting on:` line in Current State (context only; the badge reads `Status:`)" },
  { key: "issueLedger", label: "Issue Ledger", expects: "an `## Issue Ledger` table (id | … | Status)" },
  { key: "queue", label: "Queue", expects: "optional `## Queue` / Backlog / Tasks table with ids in the first column" },
];

/** Which sections the console machine-reads, found vs missing (collapsible, closed by default). */
export function SpineShapeHint({ shape }: { shape?: SpineShape }) {
  if (!shape) return null;
  const missing = SHAPE_ROWS.filter((r) => !shape[r.key]).length;
  return (
    <details className="rounded-lg border px-4 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">
        Spine shape: {SHAPE_ROWS.length - missing}/{SHAPE_ROWS.length} sections read{missing ? ` · ${missing} missing` : ""}
      </summary>
      <ul className="mt-2 grid gap-1">
        {SHAPE_ROWS.map((r) => (
          <li key={r.key} className="flex items-start gap-2">
            <span className={cn("w-14 shrink-0 font-medium", shape[r.key] ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
              {shape[r.key] ? "found" : "missing"}
            </span>
            <span>
              <span className="text-foreground">{r.label}</span>
              {!shape[r.key] && (
                <>
                  {" "}
                  — EpicSpine expects <InlineMd text={r.expects} />
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Section card for the Doctrine-2 Overview. */
function Section({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <Card data-section={name}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  );
}

/**
 * Doctrine-2 Overview (console contract order; Title + Status are the PageHeader): Goal, Serves chain,
 * Children, Done means, Pages. Each section renders nothing when its field is absent; nothing at all without
 * `m.doctrine`. Done means is skipped when the Outcome card above the tabs already lists it.
 */
export function DoctrineOverview({ m }: { m: Milestone }) {
  const d = m.doctrine;
  if (!d) return null;
  // Ancestors alone (no serves sentence anywhere) say nothing: no Serves card then.
  const chain = d.servesChain ?? [];
  // the Outcome card lives on Summary now, so Definitions always lists Done means.
  const doneMeans = d.doneMeans;
  return (
    <div className="grid content-start gap-4">
      {d.missingSections && d.missingSections.length > 0 && (
        <p data-section="compliance" className="text-xs text-muted-foreground">
          not yet compliant: {d.missingSections.join(", ")}
        </p>
      )}
      {d.goal && (
        <Section name="goal" title="Goal">
          <p>
            <InlineMd text={d.goal} />
          </p>
        </Section>
      )}
      {(d.serves || chain.some((a) => a.serves)) && (
        <Section name="serves" title="Serves">
          <ol className="grid gap-2">
            {d.serves && (
              <li className="grid gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">This epic</span>
                <span>
                  <InlineMd text={d.serves} />
                </span>
              </li>
            )}
            {chain.map((a) => (
              <li key={a.path} className="grid gap-0.5 border-l-2 pl-3">
                <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <ArrowUp className="h-3 w-3" />
                  {a.title}
                </span>
                {a.serves && (
                  <span>
                    <InlineMd text={a.serves} />
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}
      {d.children && d.children.length > 0 && (
        <Section name="children" title="Children">
          <ul className="grid gap-3">
            {d.children.map((c) => (
              <li key={c.path} className="grid gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.title}</span>
                  {c.status && <StatusBadge status={c.status} />}
                </span>
                {c.contributes && (
                  <span className="text-muted-foreground">
                    <InlineMd text={c.contributes} />
                  </span>
                )}
                <span className="font-mono text-xs text-muted-foreground">{c.path}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {doneMeans && doneMeans.length > 0 && (
        <Card data-section="done-means">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Done means</CardTitle>
              <span className="text-sm text-muted-foreground">
                {doneMeans.filter((i) => i.done).length}/{doneMeans.length}
              </span>
            </div>
            <Progress value={(doneMeans.filter((i) => i.done).length / doneMeans.length) * 100} />
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {doneMeans.map((item, i) => (
                <li key={item.id || i} className="flex items-start gap-2 text-sm">
                  {item.done ? (
                    <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={cn(item.done && "text-muted-foreground line-through")}>
                    <InlineMd text={item.text} />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {d.pages && d.pages.length > 0 && (
        <Section name="pages" title="Pages">
          <ul className="grid gap-2">
            {d.pages.map((pg) => (
              <li key={`${pg.path}|${pg.via}`} className="grid gap-0.5">
                <span className="font-medium">{pg.title || pg.path}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {pg.path}
                  {pg.via && <> · via {pg.via}</>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export function Overview({ m, needsYou = false }: { m: Milestone; needsYou?: boolean }) {
  // Done means (doctrine, here or in the Outcome card) replaces the Definition of Done card; never both.
  const hasDoneMeans = !!m.doctrine?.doneMeans?.length;
  return (
    <div className="grid gap-4">
      <DoctrineOverview m={m} />
      <ExistingOverview m={m} hideDod={hasDoneMeans} needsYou={needsYou} />
    </div>
  );
}

function ExistingOverview({ m, hideDod, needsYou }: { m: Milestone; hideDod: boolean; needsYou: boolean }) {
  return (
    <div data-section="existing" className="grid gap-4 lg:grid-cols-5">
      <div className="grid content-start gap-4 lg:col-span-3">
        {!hideDod && <DodCard m={m} />}
        <SpineShapeHint shape={m.shape} />
      </div>
      <div className="grid content-start gap-4 lg:col-span-2">
        {m.blockedReason && m.status === "blocked" && (
          // amber only while asks are open (Needs you), else a plain card; red stays for failed runs.
          <Card className={cn(needsYou && "border-amber-500/40")} data-testid="blocked-card">
            <CardHeader className="pb-2">
              <CardTitle className={cn("text-base", needsYou && "text-amber-800 dark:text-amber-300")}>Blocked</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">{m.blockedReason}</CardContent>
          </Card>
        )}
        {m.waitingOn && !(m.status === "blocked" && m.blockedReason === `Waiting on: ${m.waitingOn}`) && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Waiting on</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{m.waitingOn}</CardContent>
          </Card>
        )}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Current State</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-muted-foreground">
              {m.stateExcerpt || (m.docError ? "File not readable." : "No Current State or Goal section in this file.")}
            </pre>
          </CardContent>
        </Card>
        <PersonasCard m={m} />
      </div>
    </div>
  );
}

// ---------- Personas ----------

/** Run now goes through the cycle too (cycle/service.ts runNow → 409 cycle_disabled when off). */
export function CycleOffBanner() {
  const { data: cycle } = useQuery(() => api.getCycle(), []);
  if (cycle?.enabled !== false) return null;
  return (
    <p role="status" className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      <Info className="mt-px h-3.5 w-3.5 shrink-0" />
      Scheduler is off — wakes won't fire and Run now is unavailable until it's switched on.
    </p>
  );
}

const personaRunsHref = (personaId: string) => `?tab=activity&persona=${encodeURIComponent(personaId)}`;

function LastRun({ run }: { run?: Run }) {
  if (!run) return <span className="text-xs text-muted-foreground">no runs yet</span>;
  return (
    <span className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground" data-testid="last-run">
      <OutcomeBadge outcome={run.outcome} run={run} />
      <ClampText className="flex-1" text={run.summary} milestoneId={run.milestoneId} />
    </span>
  );
}

/** Overview: who pushes this milestone, on what cadence, and how it went. */
function PersonasCard({ m }: { m: Milestone }) {
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const { data: personas = [] } = useQuery(() => api.listPersonas(), []);
  const { data: runs = [] } = useQuery(() => api.listRuns({ milestoneId: m.id }), [m.id]);
  const [attachOpen, setAttachOpen] = useState(false);
  const mine = assignments.filter((a) => a.milestoneId === m.id);
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Personas</CardTitle>
          {mine.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setAttachOpen(true)}>
              <Plus /> Attach persona
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <CycleOffBanner />
        {mine.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No personas yet —{" "}
            <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => setAttachOpen(true)}>
              Attach persona
            </button>
          </div>
        ) : (
          <ul className="grid gap-3">
            {mine.map((a) => {
              const p = personas.find((x) => x.id === a.personaId);
              const { count, last } = assignmentRunStats(a.id, runs);
              return (
                <li key={a.id} className="grid min-w-0 gap-1 border-b pb-3 text-sm last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p?.name ?? a.personaId}</span>
                    <Badge variant={a.enabled ? "green" : "gray"}>{a.enabled ? "on" : "off"}</Badge>
                    <ParkedBadge a={a} />
                    <NeverOnBadge a={a} />
                    {a.enabled && <span className="text-xs text-muted-foreground">{formatCadence(a.cadence)}</span>}
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>last <RelTime iso={a.lastRunAt ?? last?.startedAt} /></span>
                    <NextWake a={a} paused={m.paused} />
                    <Link className="hover:text-foreground hover:underline" to={personaRunsHref(a.personaId)}>
                      {count} run{count === 1 ? "" : "s"}
                    </Link>
                  </div>
                  <LastRun run={last} />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <AssignmentDialog open={attachOpen} onOpenChange={setAttachOpen} milestoneId={m.id} />
    </Card>
  );
}

/** "next 06:10 UTC (requested by run …)" when a run asked for a timed wake earlier than the cadence. */
export function NextWake({ a, paused }: { a: Assignment; paused: boolean }) {
  const w = nextWake(a);
  if (paused || !w.at) return <span>next —</span>;
  if (!w.retry) return <span>next <RelTime iso={w.at} /></span>;
  return (
    <span data-testid="timed-wake" title={`Timed wake at ${formatDateTime(w.at)}: a run finished asking to be woken then (retryAt).`}>
      next <RelTime iso={w.at} /> (requested by run {w.retry.runId ?? "?"})
    </span>
  );
}

export function PersonasTab({ m, objective }: { m: Milestone; /** shown on an objective's page: only that objective's personas, its Delivery Manager first. */ objective?: { id: string; shared?: boolean } }) {
  const w = useWords();
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const { data: personas = [] } = useQuery(() => api.listPersonas(), []);
  const { data: ownRuns = [] } = useQuery(() => api.listRuns({ milestoneId: m.id }), [m.id]);
  // an objective's personas may wake on other milestones (a second manager from its own world): their runs and that world's name
  const elsewhere = objective ? [...new Set(personasOfObjective(assignments, { id: objective.id, milestoneId: m.id, shared: objective.shared }).map((a) => a.milestoneId))].filter((x) => x !== m.id).sort() : [];
  const { data: otherRuns = [] } = useQuery(() => (elsewhere.length ? Promise.all(elsewhere.map((id) => api.listRuns({ milestoneId: id }))).then((r) => r.flat()) : Promise.resolve([])), [elsewhere.join(",")]);
  const { data: milestones = [] } = useQuery(() => (elsewhere.length ? api.listMilestones() : Promise.resolve([])), [elsewhere.length > 0]);
  const runs = otherRuns.length ? [...ownRuns, ...otherRuns] : ownRuns;
  const { data: cycle } = useQuery(() => api.getCycle(), []);
  const { data: needsOwner = [] } = useQuery(() => api.listNeedsOwner(), []);
  const cycleOff = cycle?.enabled === false;
  const [editing, setEditing] = useState<Assignment | undefined>();
  const [attachOpen, setAttachOpen] = useState(false);
  const [detach, setDetach] = useState<Assignment | undefined>();
  const [runNowFor, setRunNowFor] = useState<Assignment>();
  const [steering, setSteering] = useState<Assignment>();
  const [stopping, setStopping] = useState<Run>();
  const isDm = (a: Assignment) => /delivery manager/i.test(personas.find((x) => x.id === a.personaId)?.name ?? "");
  const listed = objective ? personasOfObjective(assignments, { id: objective.id, milestoneId: m.id, shared: objective.shared }) : assignments.filter((a) => a.milestoneId === m.id);
  // the objective manager is the Delivery Manager on this page's milestone (or the only one, while that one is off); another is a second manager from its own world
  const ownManagerOn = listed.some((x) => isDm(x) && x.enabled && x.milestoneId === m.id);
  const isManager = (a: Assignment) => isDm(a) && (a.milestoneId === m.id || !ownManagerOn);
  const rank = (a: Assignment) => (isManager(a) ? 0 : isDm(a) ? 1 : 2);
  const mine = objective ? [...listed].sort((a, b) => rank(a) - rank(b)) : listed;

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm text-muted-foreground">{objective ? "Who works this objective, its objective manager first: it wakes to turn the key results green." : `Personas wake on their cadence to push this ${w.milestone} forward.`}</p>
        <Button size="sm" onClick={() => setAttachOpen(true)}>
          <Plus /> Attach persona
        </Button>
      </div>
      <CycleOffBanner />
      {m.paused && <p className="text-xs text-amber-700 dark:text-amber-400">{cap(w.milestone)} is paused: no wakes until it is resumed.</p>}
      {mine.length === 0 && <Empty>No personas attached.</Empty>}
      {mine.map((a) => {
        const p = personas.find((x) => x.id === a.personaId);
        const { count, last } = assignmentRunStats(a.id, runs);
        return (
          <Card key={a.id}>
            <CardContent className="flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{objective && isDm(a) ? (isManager(a) ? "Objective manager" : `Second manager · ${milestones.find((x) => x.id === a.milestoneId)?.title ?? "own world"}`) : (p?.name ?? a.personaId)}</span>
                  {p && <Badge variant="outline">{p.model}</Badge>}
                  {p && !a.writeEnabled && <Badge variant="gray">diagnose only</Badge>}
                  <ParkedBadge a={a} />
                  <NeverOnBadge a={a} />
                </div>
                <div className="mt-1 text-sm text-muted-foreground" data-testid="schedule-label" title={a.enabled ? undefined : `switched off (cadence when on: ${formatCadence(a.cadence)})`}>
                  {scheduleLabel(a)}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                  <span>last run <RelTime iso={a.lastRunAt} /></span>
                  <NextWake a={a} paused={m.paused} />
                  <Link className="hover:text-foreground hover:underline" to={personaRunsHref(a.personaId)}>
                    {count} run{count === 1 ? "" : "s"} →
                  </Link>
                  {a.t3ScheduledTaskId && <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{a.t3ScheduledTaskId}</span>}
                </div>
                <div className="mt-1.5">
                  <LastRun run={last} />
                </div>
                <BlockedBy last={last} runs={runs} needsOwner={needsOwner} milestoneId={m.id} />
                <WriteControl a={a} persona={p} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="mr-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={a.enabled} onCheckedChange={(v) => mutate(() => api.updateAssignment(a.id, { enabled: v }))} />
                  {a.enabled ? "on" : "off"}
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cycleOff}
                  title={cycleOff ? "Scheduler is off" : undefined}
                  onClick={() => setRunNowFor(a)}
                >
                  <Play /> Run now
                </Button>
                {last?.outcome === "running" && (
                  <Button size="sm" variant="outline" disabled={cycleOff} onClick={() => setSteering(a)}>
                    <Send /> Steer
                  </Button>
                )}
                {last?.outcome === "running" && (
                  <Button size="sm" variant="outline" className="text-red-700 dark:text-red-400" disabled={cycleOff || !last.threadId} onClick={() => setStopping(last)}>
                    <OctagonX /> Stop
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setEditing(a)} aria-label="Edit">
                  <Pencil /> <span className="sm:sr-only">Edit</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDetach(a)} aria-label="Detach">
                  <Unlink /> <span className="sm:sr-only">Detach</span>
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
      <AssignmentDialog open={attachOpen} onOpenChange={setAttachOpen} milestoneId={m.id} objective={objective?.id} />
      <AssignmentDialog open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} milestoneId={m.id} assignment={editing} />
      <RunNowDialog
        open={!!runNowFor}
        onOpenChange={(o) => !o && setRunNowFor(undefined)}
        assignment={runNowFor}
        personaName={personas.find((x) => x.id === runNowFor?.personaId)?.name}
        milestone={m}
      />
      <SteerDialog
        open={!!steering}
        onOpenChange={(o) => !o && setSteering(undefined)}
        assignment={steering}
        personaName={personas.find((x) => x.id === steering?.personaId)?.name}
      />
      <StopDialog
        open={!!stopping}
        onOpenChange={(o) => !o && setStopping(undefined)}
        run={stopping}
        workers={stopping ? runs.filter((r) => r.parentRunId === stopping.id && r.outcome === "running").length : 0}
        who={personas.find((x) => x.id === assignments.find((a) => a.id === stopping?.assignmentId)?.personaId)?.name}
      />
      <ConfirmDialog
        open={!!detach}
        onOpenChange={(o) => !o && setDetach(undefined)}
        title="Detach persona?"
        description="Its scheduled wakes stop. Past runs stay in Activity."
        confirmLabel="Detach"
        onConfirm={() => api.deleteAssignment(detach!.id)}
      />
    </div>
  );
}

// ---------- Backlog ----------

function BacklogTab({ m }: { m: Milestone }) {
  const { data: mine, error, loading } = useQuery(() => api.getBacklog(m.id), [m.id]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!mine || mine.length === 0)
    return <Empty>No backlog in this file (no Issue Ledger / Phases / Queue table, no Ticket root).</Empty>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Ticket</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Owner</TableHead>
          {/* below sm Source is hidden and Title may narrow, so the table fits a phone without a sideways scroll. */}
          <TableHead className="hidden sm:table-cell">Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mine.map((t, i) => (
          <TableRow key={`${t.source}:${t.id}:${i}`}>
            <TableCell className="whitespace-nowrap font-mono text-xs">
              {t.url ? (
                <a href={t.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {t.id}
                </a>
              ) : (
                t.id
              )}
            </TableCell>
            <TableCell className="min-w-[8rem] sm:min-w-[12rem]">{t.title}</TableCell>
            <TableCell>
              <TicketStatus status={t.status} detail={t.statusDetail} />
              {t.statusDetail && <div className="mt-0.5 max-w-[16rem] truncate text-xs text-muted-foreground" title={t.statusDetail}>{t.statusDetail}</div>}
            </TableCell>
            <TableCell className="text-muted-foreground">{t.owner ?? "—"}</TableCell>
            <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{t.source}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function TicketStatus({ status, detail }: { status: string; detail?: string }) {
  const s = status.toLowerCase();
  const variant = /^(done|closed)\b/.test(s)
    ? "green"
    : /^blocked\b/.test(s)
      ? "red"
      : s.includes("progress") || /^(active|dispatched)\b/.test(s)
        ? "blue"
        : /^(waiting|ready)\b/.test(s)
          ? "amber"
          : "gray";
  return (
    <Badge variant={variant} title={detail ?? status} className="max-w-[16rem]">
      <span className="truncate">{status}</span>
    </Badge>
  );
}

// ---------- Activity ----------

function PersonaFilter({ persona, id, onClear }: { persona?: Persona; id: string; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      Runs by <span className="font-medium text-foreground">{persona?.name ?? id}</span>
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClear}>
        <X /> show all
      </Button>
    </div>
  );
}

export function ActivityTab({ m, only }: { m: Milestone; /** an objective's page: only these assignments' runs. */ only?: string[] }) {
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const { data: personas = [] } = useQuery(() => api.listPersonas(), []);
  const { data: runs, loading } = useQuery(() => api.listRuns({ milestoneId: m.id }), [m.id]);
  // Spine commits per run; failures just hide them.
  const { data: commits } = useQuery(() => api.getRunCommits(m.id).catch(() => ({})), [m.id]);
  const [params, setParams] = useSearchParams();
  const personaId = params.get("persona");
  const kind = params.get("kind") ?? "";
  if (loading) return <Loading />;
  const all = runsForMilestone(m.id, assignments, runs ?? []).filter((r) => !only || only.includes(r.assignmentId)).filter((r) => !kind || kind === "running" || (kind === "answer_run") === isAnswerRun(r));
  const grouped = timelineGroups(personaId ? filterRunsByPersona(all, assignments, personaId) : all, assignments);
  // Running = wakes with a live run or a live child (T3 state from the server's reconciler).
  const groups = kind === "running" ? runningOnly(grouped) : grouped;
  const setKind = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set("kind", v);
    else next.delete("kind");
    setParams(next, { replace: true });
  };
  const filter = (
    <div className="flex flex-wrap items-center gap-3">
      {personaId && (
        <PersonaFilter persona={personas.find((p) => p.id === personaId)} id={personaId} onClear={() => setParams({ tab: "activity" }, { replace: true })} />
      )}
      <select aria-label="Kind" className="h-8 rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="">All runs</option>
        <option value="wake">Wake runs</option>
        <option value="answer_run">Answer runs</option>
        <option value="running">Running</option>
      </select>
    </div>
  );
  if (groups.length === 0)
    return (
      <div className="grid gap-3">
        {filter}
        <Empty>{kind || personaId ? "No runs match this filter." : "No runs yet. Attach a persona or press Run now."}</Empty>
      </div>
    );
  return (
    <div className="grid gap-3">
      {filter}
      <RunTimeline groups={groups} personas={personas} commits={commits ?? {}} remote={m.remote} />
    </div>
  );
}

// ---------- Settings ----------

type SettingsForm = { title: string; repo: string; path: string; owner: string };

export function SettingsTab({ m }: { m: Milestone }) {
  const w = useWords();
  const { data: status } = useQuery(() => api.getMilestoneStatus(m.id), [m.id], { tag: "inbox" });
  // Title starts as the shown name; saving a different one makes it win over the spine's title, clearing it
  // goes back to the spine's title.
  const shown: SettingsForm = { title: milestoneName(m), repo: m.repo, path: m.path, owner: m.owner };
  const [form, setForm] = useState(shown);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();
  // the milestone query polls and hands back a new `m` each time, so the form follows the saved values only
  // when they actually change, and only for fields the user has not edited since the last save.
  const edited = useRef(new Set<keyof SettingsForm>());
  const latest = useRef(shown);
  latest.current = shown;
  const follow = () => setForm((f) => {
    const next = { ...f };
    for (const k of Object.keys(next) as (keyof SettingsForm)[]) if (!edited.current.has(k)) next[k] = latest.current[k];
    return next;
  });
  useEffect(follow, [shown.title, shown.repo, shown.path, shown.owner]);
  const dirty = form.title.trim() !== shown.title || form.repo !== m.repo || form.path !== m.path || form.owner !== m.owner;
  const set = (k: keyof SettingsForm) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    edited.current.add(k);
    setSaved(false);
    setForm((f) => ({ ...f, [k]: value }));
  };

  return (
    <div className="grid max-w-xl gap-4">
      <Card>
        <CardContent className="grid gap-4 p-5">
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              await mutate(() => api.updateMilestone(m.id, form));
              // Saved: every field follows the saved values again (now, and when the refetch lands).
              edited.current.clear();
              follow();
              setSaved(true);
            }}
          >
            <Field
              label="Title"
              hint={m.docTitle && `Shown instead of the spine's own title (${m.docTitle}). Clear to use the spine title.`}
            >
              <Input aria-label="Title" required={!m.docTitle} value={form.title} onChange={set("title")} />
            </Field>
            <Field label="Repo" hint="owner/name or a local checkout path">
              <Input required value={form.repo} onChange={set("repo")} />
            </Field>
            <Field label="Path" hint="Spine or epic ticket file in the repo">
              <Input required value={form.path} onChange={set("path")} />
            </Field>
            <Field label="Owner">
              <Input required value={form.owner} onChange={set("owner")} />
            </Field>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!dirty}>
                Save
              </Button>
              {saved && !dirty && <span className="text-sm text-muted-foreground">Saved.</span>}
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center justify-between gap-4 p-5">
          <div>
            <div className="text-sm font-medium">Pause {w.milestone}</div>
            <div className="text-xs text-muted-foreground">Paused {w.milestonesWord} get no persona wakes.</div>
          </div>
          <Switch checked={m.paused} onCheckedChange={(v) => mutate(() => api.updateMilestone(m.id, { paused: v }))} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center justify-between gap-4 p-5">
          <div>
            <div className="text-sm font-medium">{m.settledAt ? "Settled" : `Settle ${w.milestone}`}</div>
            <div className="text-xs text-muted-foreground" title="the spine's own Status: word" data-testid="spine-status">
              spine: {m.status && m.status !== "unknown" ? m.status : "no status"}
            </div>
            <div className="text-xs text-muted-foreground">
              {m.settledAt
                ? <>Settled <RelTime iso={m.settledAt} />: hidden from the sidebar and Team home, no persona wakes. The status is unchanged.</>
                : canSettle(status)
                  ? "Hide it from the sidebar and Team home once it is done. The status is unchanged; you can unsettle it here."
                  : "Not accomplished yet: available once you mark the outcome (Accomplished, Partially or Superseded) on the Summary tab."}
            </div>
          </div>
          {m.settledAt ? (
            <Button variant="outline" onClick={() => mutate(() => api.unsettleMilestone(m.id))}>
              Unsettle
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={!canSettle(status)}
              onClick={async () => {
                await mutate(() => api.settleMilestone(m.id));
                navigate("/");
              }}
            >
              <Archive /> Settle
            </Button>
          )}
        </CardContent>
      </Card>
      <Card className="border-destructive/40">
        <CardContent className="flex items-center justify-between gap-4 p-5">
          <div>
            <div className="text-sm font-medium">Delete {w.milestone}</div>
            <div className="text-xs text-muted-foreground">Removes it from the console and detaches its personas. The spine is untouched.</div>
          </div>
          <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </Button>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${milestoneName(m)}”?`}
        description="Its assignments are removed too. The spine in the repo is not touched."
        onConfirm={async () => {
          await api.deleteMilestone(m.id);
          navigate("/");
        }}
      />
    </div>
  );
}

/** "Parked — all green · 2h ago"; the assignment's on/off toggle is the resume. */
function ParkedBadge({ a }: { a: Assignment }) {
  if (!a.parkedAt || a.enabled) return null;
  return (
    <Badge variant="amber" title="Auto-parked: nothing actionable. It re-arms by itself when work appears; turn it on to resume now.">
      Parked — {a.parkedReason ?? "nothing actionable"} · <RelTime iso={a.parkedAt} />
    </Badge>
  );
}
