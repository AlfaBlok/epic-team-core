import { MilestonePath } from "@/components/bootstrap";
import { RedLineBand } from "@/components/ownerPriority";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, Clock, MessageSquare, MessagesSquare, Phone, Pin, PinOff, Plus, Workflow } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { ACTIVE_THREAD_STATUSES, api } from "@/api";
import { useQuery } from "@/lib/data";
import { dodCount, milestoneName } from "@/lib/format";
import { milestoneTiming } from "@/lib/derive";
import { milestoneState, openAskCodes, statusOf } from "@/lib/status";
import { blockedItems, useStatusBatch } from "@/lib/inbox";
import { useSnoozes } from "@/lib/snooze";
import { liveWorkers, OpenAsksContext, StateWord, stripLines, WORD_TONE } from "@/components/status";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Empty, ErrorBox, Loading, OutcomeBadge, PageHeader, RelTime } from "@/components/common";
import { MilestoneDialog } from "@/components/dialogs";
import { WaitingOnYou } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
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
import { campaignsByMilestone, repoLevelIds, useCampaigns } from "@/lib/campaign";
import { CampaignGoalBlock } from "@/components/CampaignGoal";
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
import { SETTINGS_PATH } from "@/lib/settingsPath";

/**
 * the console skin's
 * home holds only his cards, blocked then finished. `section="settings"` is everything else that grew on it, on the
 * Settings page: readiness, red lines and What you build on top, then `between` (the operator pages), then projects and
 * team activity (the owner 2026-11-11 23:48Z: "That section should be Inbox … Don't stuff everything into Team!").
 */
export function TeamPage({ section = "inbox", between }: { section?: "inbox" | "settings"; between?: ReactNode } = {}) {
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
  const { data: waiting = [] } = useQuery(() => api.listWaitingOnOwner(), [], { tag: "inbox" });
  // each card's word, sentence and count come from the server's status batch.
  // the shared fetch the pills and Blocked read; each card's count is its blocked list's length (lib/inbox).
  const { data: statuses } = useStatusBatch();
  const { entries: snoozing } = useSnoozes();
  const [newOpen, setNewOpen] = useState(false);
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
  const { data: camps } = useCampaigns();
  // the Team home lists the selected project's campaigns only (project, above).
  const campaignOf = useMemo(() => campaignsByMilestone(camps?.campaigns), [camps]);
  // in the social skin a repo's own level is not a campaign card (repoLevelIds).
  const repoLevel = useMemo(() => (campaigns ? repoLevelIds(camps?.campaigns) : new Set<string>()), [campaigns, camps]);
  // about 20 cards show in priority order (focus first, in his order); Load more shows the next 20.
  const [limit, setLimit] = useState(MILESTONE_PAGE);
  const page = pageMilestones(
    roots.filter((m) => !repoLevel.has(m.id) && project.keep(m.id)),
    rest.filter((m) => !repoLevel.has(m.id) && project.keep(m.id)),
    limit,
  );
  const focusActions = (m: NonNullable<typeof ms.data>[number]) => {
    const i = roots.findIndex((r) => r.id === m.id);
    const name = milestoneName(m);
    const btn = "h-7 px-2 text-xs";
    return (
      <div className="flex flex-wrap items-center gap-1.5" data-testid="focus-actions">
        {i < 0 ? (
          <Button variant="outline" size="sm" className={btn} disabled={focusBusy} pending={pressed === `${m.id}:pin`} pendingLabel="Pinning…" onClick={() => setFocus(`${m.id}:pin`, `${name} pinned to focus at ${nextFocusPosition(list)}`, [{ id: m.id, bigRoot: nextFocusPosition(list) }])}>
            <Pin className="h-3.5 w-3.5" /> Pin to focus
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" className={btn} disabled={focusBusy || i === 0} pending={pressed === `${m.id}:up`} aria-label={`Move ${name} up`} title="Move up" onClick={() => setFocus(`${m.id}:up`, `${name} moved up`, moveFocus(roots, i, -1))}>
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="sm" className={btn} disabled={focusBusy || i === roots.length - 1} pending={pressed === `${m.id}:down`} aria-label={`Move ${name} down`} title="Move down" onClick={() => setFocus(`${m.id}:down`, `${name} moved down`, moveFocus(roots, i, 1))}>
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="sm" className={btn} disabled={focusBusy} pending={pressed === `${m.id}:unpin`} pendingLabel="Unpinning…" onClick={() => setFocus(`${m.id}:unpin`, `${name} unpinned from focus`, [{ id: m.id, bigRoot: null }])}>
              <PinOff className="h-3.5 w-3.5" /> Unpin
            </Button>
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
          <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
            <Link to={`/milestones/${encodeURIComponent(m.id)}`} data-testid="card-pipeline" aria-label={`${name} Pipeline`} title="This campaign's Pipeline: ideas, drafts waiting for you, scheduled, posted">
              <Workflow className="h-3.5 w-3.5" /> Pipeline
            </Link>
          </Button>
        )}
        <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
          <Link to={chat} data-testid="card-chat" aria-label={`Chat with ${name}`} title={`This ${w.milestone}'s chat with its repo desk`}>
            <MessageSquare className="h-3.5 w-3.5" /> Chat
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm" className="h-7 border-emerald-600/40 px-2 text-xs text-emerald-800 hover:bg-emerald-500/10 dark:text-emerald-300">
          <Link to={`${chat}&call=1`} data-testid="card-call" aria-label={`Call ${name}`} title={`Call this ${w.milestone}'s voice: it knows the tree and this ${w.milestone}'s book`}>
            <Phone className="h-3.5 w-3.5" /> Call
          </Link>
        </Button>
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
  const home = !me?.tenant || me.tenant.id === homeWorld();
  // in the social skin a new campaign is the wizard, never a bare milestone or bootstrap.
  const actions = (
    <>
      {/* the owner's "how do I add a new root?": a new milestone (existing spine or new epic) made focus in one step. */}
      {/* the social twins: New campaign (the wizard; the campaign is pinned) and Add job (a one-off milestone). */}
      <Button variant="outline" onClick={() => (campaigns ? navigate(`/${NEW_CAMPAIGN_PATH}`) : setFocusOpen(true))} data-testid="new-focus">
        <Pin /> {campaigns ? "New campaign" : `New focus ${w.milestone}`}
      </Button>
      <Button variant="outline" onClick={() => setNewOpen(true)} data-testid="add-job">
        <Plus /> {campaigns ? "Add job" : w.addMilestone}
      </Button>
    </>
  );
  return (
    <OpenAsksContext.Provider value={openAskCodes(waiting)}>
      {!settings && (
        <PageHeader
          title={campaigns ? "Home" : w.team}
          description={campaigns ? "Every project's campaigns first, then what needs you." : "What waits on you: blocked first, then finished work to review."}
          actions={campaigns ? actions : undefined}
        />
      )}
      {campaigns ? (
        <>
          {/* the social home opens on every project's campaigns,
              each under its project (pinned first, in his order), then his inbox, then the widgets. */}
          <ProjectCampaigns roots={page.roots} rest={page.rest} card={socialCard} note={focusNote} error={ms.error} loading={ms.loading} />
          <LoadMore hidden={page.hidden} onMore={() => setLimit(limit + MILESTONE_PAGE)} className="mb-6 mt-3" testId="team-load-more" />
          {/* the owner's red line on top of the inbox; its items lead both lists below, marked in red. */}
          <RedLineBand />
          <WaitingOnYou title="Blocked, waiting on you" fold="blocked" laptop={home} />
          <WaitingForReview fold="review" />
          <ChatsWaitingLine className="mb-3 rounded-lg border bg-card px-3 py-2 text-sm" />
          {/* The widgets, after the campaigns and the inbox. */}
          <NewApplications />
          {scorecard && <OnboardingScorecard />}
          <RecentlyClosed />
          {home && <LaunchLights product={socialProduct().toLowerCase()} />}
          {shows("book") && <DeckCards />}
          {shows("spines") && <AskedNoRow />}
          {shows("spines") && <OrphanCommits />}
          <MovingNow />
          <NextWakeList />
        </>
      ) : !settings ? (
        <>
          {/* the Inbox: what blocks on the owner (the laptop switch on top re-orders it), then finished work. Nothing else. */}
          <WaitingOnYou title="Blocked on you" fold="blocked" laptop={home} part="blocked" />
          <WaitingForReview fold="review" />
          {/* the rest of his inbox's history (Mac agent, snoozed, decided for you, coming up, answered), folded, after both lists. */}
          <WaitingOnYou title="Blocked on you" fold="blocked" part="rest" />
          {shows("settings") && (
            <p className="mt-6 text-xs text-muted-foreground" data-testid="inbox-rest-moved">
              Red lines, What you build and the readiness checklist moved to{" "}
              <Link to={`/${SETTINGS_PATH}`} className="text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-current">
                Settings
              </Link>
              . Projects open from the menu.
            </p>
          )}
        </>
      ) : (
        <>
          {/* Settings, on top: the readiness checklist, the owner's red lines (edit, delete; their cards lead the Inbox),
              what he builds, tester applications he has not opened yet. */}
          {scorecard && <OnboardingScorecard list />}
          <RedLineBand list />
          {home && <BuildingLists milestones={ms.data} list />}
          <NewApplications />
          {between}
          <div className="mb-4 mt-8 flex flex-wrap items-center gap-2" data-testid="team-overview-head">
            <h2 className="mr-auto text-[15px] font-semibold">Projects and team</h2>
            {actions}
          </div>
          {/* every card he closed this week, with Add comment. */}
          <RecentlyClosed />
          {home && <LaunchLights product="epicteam" />}
          {shows("book") && <DeckCards />}
          {shows("book") && home && <GoalGraphLinks />}
          <ChatsWaitingLine className="mb-3 rounded-lg border bg-card px-3 py-2 text-sm" />
          {shows("spines") && <AskedNoRow />}
          {shows("spines") && <OrphanCommits />}
          <MovingNow />
          <NextWakeList />

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
      {(campaigns || settings) && shownPersonas.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-[15px] font-semibold">Personas</h2>
          <Card>
            <ul className="divide-y">
              {shownPersonas.map((p) => {
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
      )}
      {(campaigns || settings) && <WakesDidSomething counts={runStats?.wakes24h} />}
      <SyncFooter />
      <MilestoneDialog open={newOpen} onOpenChange={setNewOpen} job={campaigns} />
      <MilestoneDialog open={focusOpen} onOpenChange={setFocusOpen} focusAt={nextFocusPosition(list)} />
    </OpenAsksContext.Provider>
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
}: {
  roots: M[];
  rest: M[];
  card: (m: M) => ReactNode;
  note?: { ok: boolean; text: string } | null;
  error?: unknown;
  loading?: boolean;
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
            !loading && <Empty>No campaigns here yet. Start one with New campaign above.</Empty>
          )}
        </div>
      ))}
    </section>
  );
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
