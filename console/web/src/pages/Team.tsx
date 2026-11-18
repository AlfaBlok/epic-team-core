import { MilestonePath } from "@/components/bootstrap";
import { Slot, SlotStack, useSlotReady } from "@/components/slot";
import { RedLineBand } from "@/components/ownerPriority";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { InboxLine } from "@/components/inboxLine";
import { ArrowDown, ArrowUp, ChevronDown, Clock, ExternalLink, MessageSquare, MessagesSquare, Phone, Pin, PinOff, Plus, Workflow } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { ACTIVE_THREAD_STATUSES, api } from "@/api";
import { useQuery, useWaitingList } from "@/lib/data";
import { dodCount, milestoneName } from "@/lib/format";
import { milestoneTiming } from "@/lib/derive";
import { milestoneState, openAskCodes, statusOf } from "@/lib/status";
import { blockedItems, useStatusBatch } from "@/lib/inbox";
import { useSnoozes } from "@/lib/snooze";
import { liveWorkers, OpenAsksContext, StateWord, stripLines, WORD_TONE } from "@/components/status";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CardButton } from "@/components/ui/cardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Empty, ErrorBox, Loading, OutcomeBadge, PageHeader, PHONE_TAP, RelTime } from "@/components/common";
import { MilestoneDialog } from "@/components/dialogs";
import { WaitingOnYou } from "@/components/waiting";
import { ClosedGoalsFold, InboxDecisions, InboxDoneForReview, InboxSnoozedReviews } from "@/components/review";
import { FoldSection, InboxPlace, LandFolded, useSectionOpen } from "@/components/homeSection";
import { useInboxPlace } from "@/lib/inboxPlace";
import { OtherWorldsWaiting, useOtherWorlds } from "@/components/otherWorlds";
import { GoalLights } from "@/components/goalLights";
import { SCORECARDS_PATH } from "@/lib/scorecards";
import { DeckCards } from "@/components/deckCards";
import { GoalGraphLinks } from "@/pages/GoalGraph";
import { LaunchLights } from "@/components/launchBoard";
import { ChatsWaitingLine } from "@/components/draftsToApprove";
import { NewApplications } from "@/components/newApplications";
import { AskedNoRow } from "@/components/askedNoRow";
import { OrphanCommits } from "@/components/orphanCommits";
import { OutcomeChip } from "@/components/outcome";
import { ClampText } from "@/components/unblock";
import { Badge } from "@/components/ui/badge";
import { SyncFooter } from "@/components/freshness";
import { NextWakeList } from "@/components/planning";
import { MovingNow } from "@/components/movingNow";
import { focusHeading, useShows, useSkin, useWords } from "@/lib/skin";
import { OnboardingScorecard } from "@/components/OnboardingScorecard";
import { campaignMilestones, campaignsByMilestone, useCampaigns } from "@/lib/campaign";
import { CampaignGoalBlock } from "@/components/CampaignGoal";
import { CampaignChannels } from "@/components/CampaignChannels";
import { ALL_PROJECTS, useProject } from "@/lib/project";
import type { CampaignCard } from "@/api/campaign-types";
import { dayLabel, slotLabel } from "@/pages/social/parts";
import { NEW_CAMPAIGN_PATH } from "@/pages/Campaigns";
import { MILESTONE_PAGE, moveFocus, nextFocusPosition, pageMilestones, progressLabel } from "@/lib/bigRoots";
import { LoadMore } from "@/components/loadMore";
import { useFocusSave } from "@/lib/useFocusSave";
import { RecentlyClosed } from "@/components/afterClose";
import { BuildingLists } from "@/components/buildingLists";
import { homeWorld, socialProduct } from "@/lib/identity";
import { InboxSearchProvider, useInboxSearch } from "@/lib/inboxSearch";
import { InboxSearchBox } from "@/components/inboxSearch";
import { InboxGoalsToSet, InboxShowFilter, InboxIdeasAndDigests, showKeeps, useInboxShow } from "@/components/teamCards";

/**
 * the console skin's
 * home holds only his cards, blocked then finished. `section="settings"` is everything else that grew on it, on the
 * Settings page: readiness, red lines and What you build on top, then `between` (the operator pages), then projects and
 * team activity (the owner 2026-11-11 23:48Z: "That section should be Inbox … Don't stuff everything into Team!").
 */
export function TeamPage({
  section = "inbox",
  between,
  dashboard = true,
  redLines = true,
  only,
}: {
  section?: "inbox" | "settings";
  between?: ReactNode;
  dashboard?: boolean;
  /** the Dashboard page shows the panels without the red lines (they are Settings: he edits them there). */
  redLines?: boolean;
  /** the social skin: "goals" is Home (the campaigns and widgets, the inbox one tap away), "inbox" the Inbox alone. */
  only?: "goals" | "inbox";
} = {}) {
  const { data: me } = useQuery(() => (api.getMe ? api.getMe() : Promise.resolve(undefined)), []);
  const ms = useQuery(() => api.listMilestones(), []);
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  // the cards' and personas' wake numbers come from /api/runs/stats (same 500 runs, counted on the server),
  // not from the run list itself (~900 KB).
  // inside Epic Social the footer's wake count is the selected project's (its milestones, and any no project owns).
  const project = useProject();
  const projectMs = project.current && ms.data ? ms.data.filter((m) => project.keep(m.id)).map((m) => m.id) : undefined;
  const msKey = projectMs?.join(",");
  const { data: runStats } = useQuery(() => api.getRunStats(msKey === undefined ? undefined : projectMs), [msKey]);
  const { data: threads = [] } = useQuery(() => api.listThreads(), []);
  const { data: personas = [] } = useQuery(() => api.listPersonas(), []);
  // per-card counts of what waits on the owner (same source as "Waiting on you").
  // the same shared list the inbox sections read (one fetch, not three).
  const { data: waiting = [] } = useWaitingList();
  // each card's word, sentence and count come from the server's status batch.
  // the shared fetch the pills and Blocked read; each card's count is its blocked list's length (lib/inbox).
  const { data: statuses } = useStatusBatch();
  const { entries: snoozing } = useSnoozes();
  // the owner: what he was frustrated about or asked for again leads his inbox until answered, inside its own section
  // (each list puts it first, the server's order). The owner, 18 Nov: the sections never change places:
  // Blocked on you, Decisions waiting on you, then Done waiting for your review (the old pressing flip is gone).
  const [newOpen, setNewOpen] = useState(false);
  // E948-S66: the inbox shows all, or one kind (Blocked, Digests, Ideas, Goals, Review), kept in the address as ?show=.
  const [show, setShow] = useInboxShow();
  const keeps = showKeeps(show);
  const scorecardId = useSearchParams()[0].get("scorecard") || undefined;
  const [focusOpen, setFocusOpen] = useState(false);
  const shows = useShows();
  // inside Epic Social the Personas list names those working on the selected project's milestones.
  const shownPersonas = project.current ? personas.filter((p) => assignments.some((a) => a.personaId === p.id && project.keep(a.milestoneId))) : personas;
  const navigate = useNavigate();

  // the owner's big roots lead (in their order); the per-repo milestones follow under Other milestones.
  // they are "Focus milestones", pinned: in the console skin each card is pinned to focus
  // or unpinned, and focus cards move up or down. The save path (PATCH bigRoot, overlay, spinner, note) is
  // useFocusSave, shared with the milestone page header's Pin to focus / Unpin.
  const { list, roots, rest, busy: focusBusy, pressed, note: focusNote, setFocus } = useFocusSave(ms.data);
  // both skins pin, unpin and order their focus milestones (the social skin calls them campaigns);
  //'s guard that hid this in the social skin is gone.
  const campaigns = !!useSkin().campaigns;
  // the home carries the onboarding scorecard. Iteration 2 (the owner 2026-11-11: "continue working until the full
  // model is implemented proper on the multi-tenant versions of epicteam and social"): every world, the EpicTeam side
  // too, the platform's own team included, so he sees what is still red for him as a customer on both.
  const scorecard = !!me?.tenant;
  const w = useWords();
  // milestones whose repo has the social pack (either skin) get the campaign card's post line and a Pipeline button.
  const { data: camps, loading: campsLoading, error: campsError } = useCampaigns();
  // the Team home lists the selected project's campaigns only (project, above).
  const campaignOf = useMemo(() => campaignsByMilestone(camps?.campaigns), [camps]);
  // in the social skin Home lists only real campaigns and their jobs (campaignMilestones), never every milestone of the
  // world: a house decision or a server is EpicTeam's. Until the campaign list is read nothing is listed (no flash).
  const shownHere = useMemo(() => (campaigns ? new Set(campaignMilestones(camps?.campaigns, ms.data).map((m) => m.id)) : undefined), [campaigns, camps, ms.data]);
  const homeMs = (m: { id: string }) => (!shownHere || shownHere.has(m.id)) && project.keep(m.id);
  // about 20 cards show in priority order (focus first, in his order); Load more shows the next 20.
  const [limit, setLimit] = useState(MILESTONE_PAGE);
  const page = pageMilestones(roots.filter(homeMs), rest.filter(homeMs), limit);
  const focusActions = (m: NonNullable<typeof ms.data>[number]) => {
    const i = roots.findIndex((r) => r.id === m.id);
    const name = milestoneName(m);
    const btn = "h-7 px-2 text-xs";
    return (
      <div className="flex flex-wrap items-center gap-1.5" data-testid="focus-actions">
        {i < 0 ? (
          <CardButton variant="outline" className={btn} disabled={focusBusy} pending={pressed === `${m.id}:pin`} pendingLabel="Pinning…" onClick={() => setFocus(`${m.id}:pin`, `${name} pinned to focus at ${nextFocusPosition(list)}`, [{ id: m.id, bigRoot: nextFocusPosition(list) }])}>
            <Pin className="h-3.5 w-3.5" /> Pin to focus
          </CardButton>
        ) : (
          <>
            <CardButton variant="outline" className={btn} disabled={focusBusy || i === 0} pending={pressed === `${m.id}:up`} aria-label={`Move ${name} up`} title="Move up" onClick={() => setFocus(`${m.id}:up`, `${name} moved up`, moveFocus(roots, i, -1))}>
              <ArrowUp className="h-3.5 w-3.5" />
            </CardButton>
            <CardButton variant="outline" className={btn} disabled={focusBusy || i === roots.length - 1} pending={pressed === `${m.id}:down`} aria-label={`Move ${name} down`} title="Move down" onClick={() => setFocus(`${m.id}:down`, `${name} moved down`, moveFocus(roots, i, 1))}>
              <ArrowDown className="h-3.5 w-3.5" />
            </CardButton>
            <CardButton variant="outline" className={btn} disabled={focusBusy} pending={pressed === `${m.id}:unpin`} pendingLabel="Unpinning…" onClick={() => setFocus(`${m.id}:unpin`, `${name} unpinned from focus`, [{ id: m.id, bigRoot: null }])}>
              <PinOff className="h-3.5 w-3.5" /> Unpin
            </CardButton>
          </>
        )}
      </div>
    );
  };
  // a focus card talks to its milestone: Chat opens its chat tab, Call opens it and starts the milestone's own voice.
  const talkActions = (m: NonNullable<typeof ms.data>[number]) => {
    if (m.bigRoot == null) return null;
    const name = milestoneName(m);
    const chat = `/milestones/${encodeURIComponent(m.id)}?tab=chat`;
    return (
      <div className="ml-auto flex items-center gap-1.5" data-testid="card-talk">
        {campaignOf.has(m.id) && (
          <CardButton asChild variant="outline" className="h-7 px-2 text-xs">
            <Link to={`/milestones/${encodeURIComponent(m.id)}`} data-testid="card-pipeline" aria-label={`${name} Pipeline`} title="This campaign's Pipeline: ideas, drafts waiting for you, scheduled, posted">
              <Workflow className="h-3.5 w-3.5" /> Pipeline
            </Link>
          </CardButton>
        )}
        <CardButton asChild variant="outline" className="h-7 px-2 text-xs">
          <Link to={chat} data-testid="card-chat" aria-label={`Chat with ${name}`} title={`This ${w.milestone}'s chat with its repo desk`}>
            <MessageSquare className="h-3.5 w-3.5" /> Chat
          </Link>
        </CardButton>
        <CardButton asChild variant="outline" className="h-7 border-emerald-600/40 px-2 text-xs text-emerald-800 hover:bg-emerald-500/10 dark:text-emerald-300">
          <Link to={`${chat}&call=1`} data-testid="card-call" aria-label={`Call ${name}`} title={`Call this ${w.milestone}'s voice: it knows the tree and this ${w.milestone}'s book`}>
            <Phone className="h-3.5 w-3.5" /> Call
          </Link>
        </CardButton>
      </div>
    );
  };
  const card = (m: NonNullable<typeof ms.data>[number]) => (
    <div key={m.id} className="flex min-w-0 flex-col gap-1.5" data-testid="milestone-card">
      {cardLink(m)}
      <div className="flex flex-wrap items-center gap-1.5">
        {focusActions(m)}
        {talkActions(m)}
      </div>
    </div>
  );
  // the social home's campaign card, compact ('s slim rows, the shared card style while waits on his
  // pick): its name, pinned mark, state and what waits on him on one line, then's goal and progress and the post line,
  // then the pin and talk buttons. The full counts stay on the campaign's own page.
  const socialCard = (m: NonNullable<typeof ms.data>[number]) => {
    const status = statusOf(statuses, m.id);
    const st = milestoneState(status);
    const waits = blockedItems(status, { snoozing }).length;
    const c = campaignOf.get(m.id);
    const sentence = stripLines(st)[0];
    return (
      <Card key={m.id} className="min-w-0 [overflow-wrap:anywhere]" data-testid="milestone-card" data-compact="yes" data-pinned={m.bigRoot != null ? "yes" : "no"}>
        <div className="grid gap-2 p-3">
          <div className="flex min-w-0 items-start gap-2">
            {m.bigRoot != null && <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="pinned" />}
            <Link to={`/milestones/${m.id}`} className="min-w-0 flex-1 font-medium leading-snug hover:underline" data-testid="campaign-name">
              {milestoneName(m)}
            </Link>
            <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 text-xs">
              {waits > 0 && (
                <Badge variant="amber" title="items waiting on you">
                  {waits} waiting on you
                </Badge>
              )}
              <StateWord word={st.word} live={liveWorkers(status)} title={`spine status: ${m.status ?? "unknown"}`} className="rounded-full border px-2 py-0.5" />
            </span>
          </div>
          {c ? (
            <PostLine c={c} />
          ) : (
            sentence && (
              <div className={cn("line-clamp-2 text-xs", WORD_TONE[st.word].text)} data-testid="state-sentence">
                {sentence}
              </div>
            )
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {focusActions(m)}
            {talkActions(m)}
          </div>
        </div>
      </Card>
    );
  };
  const cardLink = (m: NonNullable<typeof ms.data>[number]) => {
    const { last24h, last } = runStats?.milestones[m.id] ?? { last24h: 0 };
    const lastRunAt = last?.startedAt;
    const { nextRunAt } = milestoneTiming(m.id, assignments, []);
    const activeThreads = threads.filter((t) => t.milestoneId === m.id && ACTIVE_THREAD_STATUSES.includes(t.status)).length;
    const pct = m.dod?.total ? Math.round((m.dod.done / m.dod.total) * 100) : 0;
    const status = statusOf(statuses, m.id);
    const waits = blockedItems(status, { snoozing }).length;
    const st = milestoneState(status);
    const sentence = stripLines(st)[0];
    return (
      <Link to={`/milestones/${m.id}`} className="group min-w-0 flex-1">
        <Card className="h-full min-w-0 [overflow-wrap:anywhere] transition-colors group-hover:border-foreground/20">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="text-base leading-snug">{milestoneName(m)}</CardTitle>
              <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                <OutcomeChip outcome={status?.outcome} />
                <StateWord word={st.word} live={liveWorkers(status)} title={`spine status: ${m.status ?? "unknown"}`} className="rounded-full border px-2 py-0.5" />
              </span>
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {m.repo} · <MilestonePath path={m.path} />
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3">
            {/* a big root shows how far the goal is (share of its tree done); other milestones their Done means. */}
            {m.bigRoot != null && status?.progress ? (
              <div className="grid gap-1.5" data-testid="card-progress" title={progressLabel(status)!.title}>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Progress</span>
                  <span>{status.progress.pct}%</span>
                </div>
                <Progress value={status.progress.pct} />
              </div>
            ) : (
              <div className="grid gap-1.5">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Definition of Done</span>
                  <span>{dodCount(m.dod)}</span>
                </div>
                {m.dod?.tracked !== false && <Progress value={pct} />}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 text-xs" data-testid="card-counts">
              {m.nonGreen !== undefined && (
                <Badge variant={m.nonGreen === 0 ? "green" : "gray"} title="nodes in the epic tree not green yet">
                  {m.nonGreen === 0 ? "all green" : `${m.nonGreen} non-green`}
                </Badge>
              )}
              <Badge variant={waits ? "amber" : "gray"} title="items waiting on you">
                {waits} waiting on you
              </Badge>
            </div>
            {campaignOf.get(m.id) && <PostLine c={campaignOf.get(m.id)!} />}
            {sentence && (
              <div className={cn("line-clamp-2 text-xs", WORD_TONE[st.word].text)} data-testid="state-sentence">
                {sentence}
              </div>
            )}
            {m.status === "blocked" && m.blockedReason && st.word !== "needs_you" && (
              <div className="line-clamp-2 text-xs text-muted-foreground">{m.blockedReason}</div>
            )}
            {m.waitingOn && m.status !== "blocked" && (
              <div className="line-clamp-2 text-xs text-muted-foreground">Waiting on: {m.waitingOn}</div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" /> last run <RelTime iso={lastRunAt} />
              </span>
              <span>next wake {m.paused ? "paused" : <RelTime iso={nextRunAt} />}</span>
              <span className="flex items-center gap-1">
                <MessagesSquare className="h-3.5 w-3.5" /> {activeThreads} active thread{activeThreads === 1 ? "" : "s"}
              </span>
              <span>
                {last24h} run{last24h === 1 ? "" : "s"} in 24 h
              </span>
            </div>
            {last && (
              <div className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
                <OutcomeBadge outcome={last.outcome} run={last} />
                {/* The card is a link: no nested nj_ links here. */}
                <ClampText className="flex-1" text={last.summary} links={false} />
              </div>
            )}
          </CardContent>
        </Card>
      </Link>
    );
  };

  const settings = !campaigns && section === "settings";
  // on Settings the dashboard panels show only while their switch is on (SettingsPage passes it, off by default).
  const board = !settings || dashboard;
  const home = !me?.tenant || me.tenant.id === homeWorld();
  // in the social skin a new campaign is the wizard, never a bare milestone or bootstrap.
  const actions = (
    <>
      {/* the owner's "how do I add a new root?": a new milestone (existing spine or new epic) made focus in one step. */}
      {/* the social twins: New campaign (the wizard; the campaign is pinned) and Add job (a one-off milestone). */}
      <Button variant="outline" className={PHONE_TAP} onClick={() => (campaigns ? navigate(`/${NEW_CAMPAIGN_PATH}`) : setFocusOpen(true))} data-testid="new-focus">
        <Pin /> {campaigns ? "New campaign" : `New focus ${w.milestone}`}
      </Button>
      <Button variant="outline" className={PHONE_TAP} onClick={() => setNewOpen(true)} data-testid="add-job">
        <Plus /> {campaigns ? "Add job" : w.addMilestone}
      </Button>
    </>
  );
  // root L-87 (vn_5025a4c5, "The inbox only have sections and cards. Nothing else"): on the Inbox page only the title,
  // the filters on top and the sections with their cards; nothing else is added unless he asks for it.
  const inboxPage = only === "inbox" || (!campaigns && !settings);
  // the Inbox button lands folded at the top; Back returns to the same open sections and scroll place
  const inboxPlace = useInboxPlace();
  return (
    <OpenAsksContext.Provider value={openAskCodes(waiting)}>
      {!settings && (
        <PageHeader
          title={campaigns && only !== "inbox" ? "Home" : campaigns ? "Inbox" : w.team}
          description={inboxPage || only === "goals" ? undefined : "Your campaigns, then what waits on you."}
          actions={!inboxPage && campaigns && only !== "goals" ? actions : undefined}
        />
      )}
      {campaigns ? (
        <>
          {/* the social home opens on every project's campaigns,
              each under its project (pinned first, in his order), then his inbox, then the widgets. */}
          {/* the owner ("I want to see a list of key results and traffic light for each"): Home is the goal and its key
              results with a light each; everything else folds under one line below. */}
          {only === "goals" && <GoalLights />}
          {only === "goals" ? (
            <MoreOnHome label="More: all objectives, campaigns, your Inbox, what the team is doing">
              <InboxLine />
              {shows("goalSets") && (
                <Link to={`/${SCORECARDS_PATH}`} className="mb-3 flex min-h-11 items-center rounded-lg border bg-card px-3 text-sm hover:bg-accent" data-testid="home-all-objectives">
                  All objectives and their key results
                </Link>
              )}
              <div className="mb-4 flex flex-wrap gap-2">{actions}</div>
              <ProjectCampaigns roots={page.roots} rest={page.rest} card={socialCard} note={focusNote} error={ms.error ?? campsError} loading={ms.loading || (campsLoading && !camps)} empty={camps && !camps.campaigns.some((c) => !c.retired) ? <CampaignsElsewhere /> : undefined} />
              <LoadMore hidden={page.hidden} onMore={() => setLimit(limit + MILESTONE_PAGE)} className="mb-6 mt-3" testId="team-load-more" />
              <ChatsWaitingLine className="mb-3 rounded-lg border bg-card px-3 py-2 text-sm" />
              <NewApplications />
              <RedLineBand />
              {scorecard && <OnboardingScorecard />}
              <RecentlyClosed />
              {home && <LaunchLights product={socialProduct().toLowerCase()} />}
              {shows("book") && <DeckCards />}
              {shows("spines") && <AskedNoRow />}
              {shows("spines") && <OrphanCommits />}
              <MovingNow />
              <NextWakeList />
              {board && shownPersonas.length > 0 && personasList(shownPersonas)}
              {board && <WakesDidSomething counts={runStats?.wakes24h} />}
            </MoreOnHome>
          ) : only !== "inbox" && (
            <>
              <ProjectCampaigns roots={page.roots} rest={page.rest} card={socialCard} note={focusNote} error={ms.error ?? campsError} loading={ms.loading || (campsLoading && !camps)} empty={camps && !camps.campaigns.some((c) => !c.retired) ? <CampaignsElsewhere /> : undefined} />
              <LoadMore hidden={page.hidden} onMore={() => setLimit(limit + MILESTONE_PAGE)} className="mb-6 mt-3" testId="team-load-more" />
            </>
          )}
          {/* the social product world's own asks and cards, then blocked, then finished work to review, and only then the
              inbox's history (Mac agent, snoozed, decided for you, coming up, answered), as on the console's Inbox. */}
          {/* Home ("goals") leaves the lists to the Inbox page, one tap away in the top bar. */}
          {/* (the owner 16 Nov 20:27Z: "I don't want to add more sections!!! It should just be at the top on blocked
              waiting for me or top done waiting for your review"): a ready or deadline card leads its own section, a
              question on what comes first leads Blocked on you; no section of their own, every section folds alike. */}
          {only !== "goals" && <InboxShowFilter show={show} onChange={setShow} />}
          {/* the owner: the same few sections as EpicTeam's Inbox, all folded when it opens. */}
          {only !== "goals" && <InboxPlace.Provider value={only === "inbox" ? inboxPlace.place : undefined} key={only === "inbox" ? inboxPlace.visit : undefined}><LandFolded.Provider value={only === "inbox"}><SlotStack name="social-inbox">
            <Slot name="social-other-worlds">
              <OtherWorldsWaiting />
            </Slot>
            {keeps.blocked && (
              <Slot name="social-blocked" fallback={420}>
                {/* the phone Home: no laptop switch here, it is EpicTeam's (the Mac list), as on EpicTeam's quiet Inbox. */}
                <WaitingOnYou title="Blocked on you" fold="blocked" part="blocked" />
              </Slot>
            )}
            {keeps.review && (
              <Slot name="social-decisions" fallback={420}>
                <InboxDecisions />
              </Slot>
            )}
            {keeps.goals && (
              <Slot name="social-goals-to-set">
                <InboxGoalsToSet scorecard={scorecardId} />
              </Slot>
            )}
            {keeps.review && (
              <Slot name="social-review" fallback={420}>
                <InboxDoneForReview />
              </Slot>
            )}
            {keeps.kinds.length > 0 && (
              <Slot name="social-team-cards">
                <InboxIdeasAndDigests kinds={keeps.kinds} scorecard={scorecardId} />
              </Slot>
            )}
            {keeps.rest && (
              <Slot name="social-rest">
                <EverythingElse />
              </Slot>
            )}
            {keeps.review && (
              <Slot name="social-snoozed">
                <InboxSnoozedReviews />
              </Slot>
            )}
          </SlotStack></LandFolded.Provider></InboxPlace.Provider>}
          {only !== "goals" && !inboxPage && <ChatsWaitingLine className="mb-3 rounded-lg border bg-card px-3 py-2 text-sm" />}
          {only !== "inbox" && only !== "goals" && <NewApplications />}
          {/* the phone Home (the owner, "on the mobile, it's just a total mess"): Home is the
              campaigns and what waits on him, like EpicTeam's quiet Inbox; the widgets (red lines, scorecard, recently
              closed, launch lights, what moves, personas) fold under one quiet line at the end, nothing removed. */}
          {only !== "inbox" && only !== "goals" && <MoreOnHome>
            <RedLineBand />
            {scorecard && <OnboardingScorecard />}
            <RecentlyClosed />
            {home && <LaunchLights product={socialProduct().toLowerCase()} />}
            {shows("book") && <DeckCards />}
            {shows("spines") && <AskedNoRow />}
            {shows("spines") && <OrphanCommits />}
            <MovingNow />
            <NextWakeList />
            {board && shownPersonas.length > 0 && personasList(shownPersonas)}
            {board && <WakesDidSomething counts={runStats?.wakes24h} />}
          </MoreOnHome>}
        </>
      ) : !settings ? (
        <>
          {/* the Inbox: what blocks on the owner (the laptop switch on top re-orders it), then finished work. Nothing else. */}
          {/* the owner ("remove the purple section ... inbox is inbox, filters on"): no other-worlds band here, the filters
              then the expanders with nothing between; the social skin keeps its own. */}
          {/* every section fetches at once and shows top to bottom (each once it and all above it are in, the
              next one holding its place with a shimmer), so one that lands late never pushes what is on screen. */}
          <InboxSearchProvider>
          {/* the owner ("land with everything collapsed, and then I expand where I want to look at"). */}
          <InboxPlace.Provider value={inboxPlace.place} key={inboxPlace.visit}>
          <LandFolded.Provider value>
          {/* (the owner 16 Nov 20:27Z: "I don't want to add more sections!!! ... Inbox should have single pattern
              please - sections you can expand, all look the same"): what he waits on leads the section it belongs to
              (vn_cdcf1208 a question on what comes first and an account to connect lead Blocked on you; vn_c95c40ad a
              deadline and "came in too subtly" a ready card lead Decisions or Done, waiting for your review), and that
              section opens by itself. No section of their own, nothing loose between the sections. */}
          {/* the owner, 2026-11-12 21:17Z: one search box on top filters every section at once. */}
          <InboxSearchBox />
          {/* E948-S66 (the owner, vn_fe52ef4a): each kind filterable. */}
          <InboxShowFilter show={show} onChange={setShow} />
          <SlotStack name="inbox">
            {/* E948-S103 (vn_a8293638): cards that wait on his choice sit in their own bucket, above finished work */}
            {keeps.blocked && (
              <Slot name="blocked" fallback={420}>
                <WaitingOnYou title="Blocked on you" fold="blocked" laptop={home} part="blocked" connects />
              </Slot>
            )}
            {/* the owner: "either I'm reviewing something or I am unblocking something". Goals to set is
                one list and waits on him (red); then finished work and the team's ideas and digests for his review (green);
                the rest of his inbox's history (closed goals, Mac agent, snoozed, decided for you, coming up, answered) is
                one folded line. His goals and their numbers live on the objectives screen, not here. */}
            {keeps.review && (
              <Slot name="decisions" fallback={420}>
                <InboxDecisions />
              </Slot>
            )}
            {keeps.goals && (
              <Slot name="goals-to-set">
                <InboxGoalsToSet scorecard={scorecardId} />
              </Slot>
            )}
            {keeps.review && (
              <Slot name="review" fallback={420}>
                <InboxDoneForReview />
              </Slot>
            )}
            {keeps.kinds.length > 0 && (
              <Slot name="team-cards">
                <InboxIdeasAndDigests kinds={keeps.kinds} scorecard={scorecardId} />
              </Slot>
            )}
            {keeps.rest && (
              <Slot name="rest">
                <EverythingElse />
              </Slot>
            )}
            {/* every snoozed card, last, below every section (vn_303babf4). */}
            {keeps.review && (
              <Slot name="snoozed">
                <InboxSnoozedReviews />
              </Slot>
            )}
          </SlotStack>
          </LandFolded.Provider>
          </InboxPlace.Provider>
          </InboxSearchProvider>
        </>
      ) : (
        <>
          {/* Settings, on top: the readiness checklist, the owner's red lines (edit, delete; their cards lead the Inbox),
              what he builds, tester applications he has not opened yet. */}
          {board && scorecard && <OnboardingScorecard list />}
          {redLines && <RedLineBand list />}
          {board && home && <BuildingLists milestones={ms.data} list />}
          {board && <NewApplications />}
          {between}
          <div className="mb-4 mt-8 flex flex-wrap items-center gap-2" data-testid="team-overview-head">
            <h2 className="mr-auto text-[15px] font-semibold">{board ? "Projects and team" : "Projects"}</h2>
            {actions}
          </div>
          {/* every card he closed this week, with Add comment. */}
          {board && <RecentlyClosed />}
          {board && home && <LaunchLights product="epicteam" />}
          {board && shows("book") && <DeckCards />}
          {board && shows("book") && home && <GoalGraphLinks />}
          {board && <ChatsWaitingLine className="mb-3 rounded-lg border bg-card px-3 py-2 text-sm" />}
          {board && shows("spines") && <AskedNoRow />}
          {board && shows("spines") && <OrphanCommits />}
          {board && <MovingNow />}
          {board && <NextWakeList />}

          {/* the project cards (status, last run, pin and order) sit behind the dashboard switch; the menu opens
              each project, and its page keeps Pin to focus and Unpin. */}
          {board && (
            <>
              {/* "Focus milestones" (the owner's big roots, his order) then "Other milestones"; with no focus set the
                  console skin still names both, so the way to make one focus is on the page. */}
              <h2 className="mb-3 text-[15px] font-semibold" data-testid="focus-milestones">
                {focusHeading(w)}
              </h2>
              {focusNote && (
                <p className={cn("mb-3 text-xs", focusNote.ok ? "text-muted-foreground" : "text-destructive")} role="status" data-testid="focus-note">
                  {focusNote.text}
                </p>
              )}
              {ms.error && <ErrorBox error={ms.error} />}
              {ms.loading && <Loading />}
              {ms.data && ms.data.length === 0 && <Empty>No {w.milestonesWord} yet. Add one to point the team at a spine.</Empty>}
              {ms.data && ms.data.length > 0 && !roots.length && (
                <Empty>{`No focus ${w.milestonesWord} yet. Pin one below with Pin to focus, or create one pinned with New focus ${w.milestone} above.`}</Empty>
              )}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {page.roots.map(card)}
              </div>
              {page.rest.length > 0 && (
                <>
                  <h2 className="mb-3 mt-8 text-[15px] font-semibold" data-testid="other-milestones">
                    Other {w.milestonesWord}
                  </h2>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{page.rest.map(card)}</div>
                </>
              )}
              <LoadMore hidden={page.hidden} onMore={() => setLimit(limit + MILESTONE_PAGE)} className="mt-3" testId="team-load-more" />
            </>
          )}
        </>
      )}
      {settings && board && shownPersonas.length > 0 && personasList(shownPersonas)}
      {settings && board && <WakesDidSomething counts={runStats?.wakes24h} />}
      {/* a read-only line, so never on Settings (root L-80: Settings is only what he changes). */}
      {!(settings && !board) && !inboxPage && <SyncFooter />}
      <MilestoneDialog open={newOpen} onOpenChange={setNewOpen} job={campaigns} />
      <MilestoneDialog open={focusOpen} onOpenChange={setFocusOpen} focusAt={nextFocusPosition(list)} />
    </OpenAsksContext.Provider>
  );

  function personasList(shown: typeof shownPersonas) {
    return (
        <section className="mt-8" data-testid="personas-list">
          <h2 className="mb-3 text-[15px] font-semibold">Personas</h2>
          <Card>
            <ul className="divide-y">
              {shown.map((p) => {
                const { count, last } = runStats?.personas[p.id] ?? { count: 0 };
                const on = assignments.filter((a) => a.personaId === p.id && project.keep(a.milestoneId)).length;
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                    <Link to="/personas" className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {count} run{count === 1 ? "" : "s"} · on {on} {on === 1 ? w.milestone : w.milestonesWord}
                    </span>
                    {last && (
                      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                        <OutcomeBadge outcome={last.outcome} run={last} /> <RelTime iso={last.startedAt} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
    );
  }
}

/**
 * the phone Home: the social Home's widgets folded under one quiet line at its end (open state kept), so a phone
 * shows the campaigns and what waits on him, nothing else.
 */
export function MoreOnHome({ children, label }: { children: ReactNode; label?: string }) {
  const key = "social-home-more";
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  return (
    <section className="mt-6 border-t pt-2" data-testid="home-more">
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          try {
            window.localStorage.setItem(key, next ? "1" : "0");
          } catch {
            /* private mode */
          }
        }}
        data-testid="home-more-toggle"
      >
        <ChevronDown className={cn("h-4 w-4 shrink-0", open && "rotate-180")} aria-hidden />
        {open ? "Less" : (label ?? "More: red lines, recently closed, what the team is doing")}
      </button>
      {open && <div className="mt-3" data-testid="home-more-body">{children}</div>}
    </section>
  );
}

type MilestoneRow = { id: string; bigRoot?: number | null };

/**
 * the social home's campaigns, one section per project (all of
 * them unless a link names one), pinned campaigns first in his order, then the project's others; a campaign of no project
 * last under Other. A world with one project shows one Campaigns section, as before.
 */
export function ProjectCampaigns<M extends MilestoneRow>({
  roots,
  rest,
  card,
  note,
  error,
  loading,
  empty,
}: {
  roots: M[];
  rest: M[];
  card: (m: M) => ReactNode;
  note?: { ok: boolean; text: string } | null;
  error?: unknown;
  loading?: boolean;
  /** what an empty list says instead of the default (a world that runs no campaign points to the one that does). */
  empty?: ReactNode;
}) {
  const { projects, current, select, projectOf } = useProject();
  const all = [...roots, ...rest];
  type Group = { key: string; name: string; repo?: string; ms: M[] };
  const groups: Group[] = projects.length
    ? ([
        ...projects.filter((p) => !current || p.repo === current.repo).map((p) => ({ key: p.repo, name: p.name, repo: p.repo, ms: all.filter((m) => projectOf(m.id)?.repo === p.repo) })),
        { key: "other", name: "Other", ms: all.filter((m) => !projectOf(m.id)) },
      ] as Group[]).filter((g) => g.repo || g.ms.length)
    : [{ key: "campaigns", name: "Campaigns", ms: all }];
  return (
    <section className="mb-6 grid gap-5" data-testid="project-campaigns">
      {note && (
        <p className={cn("text-xs", note.ok ? "text-muted-foreground" : "text-destructive")} role="status" data-testid="focus-note">
          {note.text}
        </p>
      )}
      {error ? <ErrorBox error={error as Error} /> : null}
      {loading && <Loading />}
      {groups.map((g) => (
        <div key={g.key} className="grid gap-2" data-testid={`campaigns-of-${g.key}`}>
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground" data-testid={g.key === "campaigns" ? "focus-milestones" : "project-heading"}>
              {g.name}
              {g.repo && <span className="ml-1.5 normal-case tracking-normal">· {g.ms.length} campaign{g.ms.length === 1 ? "" : "s"}</span>}
            </h2>
            {g.repo && (
              <button type="button" className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => select(current ? ALL_PROJECTS : g.repo!)} data-testid={`only-${g.key}`}>
                {current ? "All projects" : "Only this project"}
              </button>
            )}
          </div>
          {g.ms.length ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{g.ms.map(card)}</div>
          ) : (
            !loading && (empty ?? <Empty>No campaigns here yet. Start one with New campaign above.</Empty>)
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * a world that runs no campaign of its own (the home world in the violet skin): its projects are team work, so Home
 * lists none of them and names the owner's real campaigns instead, each opening in the world that runs it (the same
 * read as the Inbox's band, GET /api/worlds).
 */
export function CampaignsElsewhere() {
  const { data, loading } = useOtherWorlds();
  const worlds = (data?.worlds ?? []).filter((w) => w.appUrl);
  const withCampaigns = worlds.filter((w) => w.campaigns?.length);
  if (loading && !data) return <Loading />;
  if (!withCampaigns.length)
    return (
      <Empty>
        <span data-testid="campaigns-elsewhere">
          No campaigns run in this world: its projects are team work and stay on the team side.
          {worlds[0] && (
            <>
              {" "}
              Your campaigns run in {worlds[0].app}:{" "}
              <a href={worlds[0].appUrl} target="_blank" rel="noreferrer" className="underline" data-testid="campaigns-elsewhere-link">
                open {worlds[0].app}
              </a>
              .
            </>
          )}
        </span>
      </Empty>
    );
  return (
    <div className="grid gap-3" data-testid="campaigns-elsewhere">
      {withCampaigns.map((w) => (
        <div key={w.tenantId} className="grid gap-2" data-world={w.tenantId}>
          <p className="text-xs text-muted-foreground" data-testid="campaigns-elsewhere-note">
            Each opens in {w.app}.
          </p>
          {/* the phone Home: on a phone the whole name shows (it wraps, never cut), the goal and whether it posts
              each get their own short line, the open-elsewhere mark is an icon in the corner. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {w.campaigns!.map((c) => {
              const posting = postingWord(c.posting);
              return (
                <a key={c.milestoneId} href={c.openUrl} target="_blank" rel="noreferrer" className="block min-w-0 rounded-xl border bg-card px-4 py-3 [overflow-wrap:anywhere] hover:bg-accent/40" title={`Open in ${w.app}`} data-testid="elsewhere-campaign">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="min-w-0 flex-1 text-[15px] font-semibold leading-snug" data-testid="campaign-name">
                      {c.name}
                    </span>
                    <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={`opens in ${w.app}`} />
                  </div>
                  {c.goal && <div className="mt-1 text-sm text-muted-foreground" data-testid="campaign-goal">{c.goal}</div>}
                  {posting && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-xs" data-testid="campaign-posting">
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", posting.live ? "bg-emerald-500" : "bg-muted-foreground/40")} aria-hidden />
                      <span className={posting.live ? "text-foreground" : "text-muted-foreground"}>{posting.text}</span>
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * the phone Home: a campaign's posting line in a few plain words for a phone. "Live: posting on Reddit and X (its
 * Publisher sends …)" reads "Posting on Reddit and X"; "Not live yet: it starts 2026-12-10" stays whole; the bracketed
 * how goes (it is on the campaign's own page).
 */
export function postingWord(line?: string): { live: boolean; text: string } | undefined {
  if (!line) return undefined;
  const i = line.indexOf(":");
  const head = i > 0 ? line.slice(0, i).trim() : "";
  const rest = (i > 0 ? line.slice(i + 1) : line).replace(/\s*\([^)]*\)?.*$/, "").trim();
  const live = /^live\b/i.test(head);
  const text = live ? rest || "Posting" : [head, rest].filter(Boolean).join(": ");
  return { live, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/**
 * a campaign card's post line: next post (slot, platform), drafts waiting for
 * the owner, live posts, and the latest digest line. Replaces the old social Home and Campaigns pages.
 */
export function PostLine({ c }: { c: CampaignCard }) {
  const n = c.nextPost;
  // a named campaign says plainly whether it is live (posting) or not, and why.
  const [word, why] = c.posting ? [c.posting.line.split(":")[0], c.posting.line.slice(c.posting.line.indexOf(":") + 1).trim()] : [];
  return (
    <div className="grid gap-0.5 text-xs" data-testid="card-post-line">
      {/* the campaign's one goal and the number toward it. */}
      {c.goal && <CampaignGoalBlock card={c} compact />}
      {/* one line per channel: its sign-in, account and the summed counts. */}
      {c.channels?.length ? <CampaignChannels card={c} compact /> : null}
      {c.posting && (
        <div className="flex min-w-0 items-center gap-1.5" data-testid="card-posting" data-live={c.posting.live ? "yes" : "no"} title={c.posting.line}>
          <span className={c.posting.live ? "shrink-0 whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium text-muted-foreground"}>
            {word}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">{why}</span>
        </div>
      )}
      <div className="text-foreground">
        {n ? `Next post ${slotLabel({ slot: n.slot, date: n.slot.slice(0, 10) })}${n.platform ? ` · ${n.platform}` : ""}` : "Nothing scheduled"} ·{" "}
        <span className={c.held ? "font-medium text-amber-700 dark:text-amber-400" : undefined}>
          {c.held} draft{c.held === 1 ? "" : "s"} wait{c.held === 1 ? "s" : ""} for you
        </span>{" "}
        · {c.live} out
      </div>
      {c.latestDigest && (
        <div className="line-clamp-1 text-muted-foreground" title={c.latestDigest.line}>
          Latest digest {dayLabel(c.latestDigest.date)}
          {c.latestDigest.line ? `: ${c.latestDigest.line}` : ""}
        </div>
      )}
    </div>
  );
}

/**
 * of the wakes started in the last 24 h, how many progressed with a new report (idle and repeats do not count).
 * Counted by time (every run since now − 24 h, no row cap). On the server (/api/runs/stats `wakes24h`), so the
 * page no longer loads those runs (~685 KB).
 */
export function WakesDidSomething({ counts }: { counts?: { did: number; total: number } }) {
  if (!counts?.total) return null;
  const { did, total } = counts;
  return (
    <p className="mt-6 text-xs text-muted-foreground" data-testid="wakes-did-something" title="Progressed and not the same report as the wakes before it. Idle wakes and repeated reports do not count.">
      {did} of {total} wake{total === 1 ? "" : "s"} in 24 h did something
    </p>
  );
}

type Leading = { ownerPriority?: { pressing?: unknown; objective?: { n: number } } };
/** an item that leads every list: on his first objective, or pressing (frustrated, said again). */
const leads = (i: Leading) => !!i.ownerPriority?.pressing || i.ownerPriority?.objective?.n === 0;
/** a review card leads and no open ask does: the review list goes first (an open leading ask already leads Blocked). */
export function pressingInReviewOnly(review: Leading[] | undefined, asks: ({ id: string } & Leading)[], blocked: ({ id: string } & Leading)[]): boolean {
  if (!review?.some(leads)) return false;
  const open = new Set(blocked.map((b) => b.id));
  return !blocked.some(leads) && !asks.some((a) => open.has(a.id) && leads(a));
}

/**
 * the owner ("the other sections merge or go"): everything in his inbox that is neither blocked on him,
 * a goal to set nor waiting for his review (closed goals with open items, Mac agent tasks, snoozed, decided for you,
 * coming up, answered) sits under this one folded line at the end, each list still folding on its own inside it.
 * No count: nothing in it waits on him.
 */
function EverythingElse() {
  const [open, setOpen] = useSectionOpen("inbox-everything-else", false);
  const search = useInboxSearch();
  // a folded line with no count: nothing to wait for before the inbox draws (it held every section 10 s when they drew at once).
  useSlotReady(true);
  return (
    <FoldSection title="Everything else" count={0} hideZero testId="inbox-everything-else" open={open || search.active} onToggle={setOpen}>
      <ClosedGoalsFold />
      <WaitingOnYou title="Blocked on you" fold="blocked" part="rest" />
    </FoldSection>
  );
}
