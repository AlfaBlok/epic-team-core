import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { BundleButtons, SEAT_WORDS, usePlan } from "./buyPlan";
import { splitDecisions } from "@/lib/cardKind";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Activity, BarChart3, Building2, Presentation, Bot, Home, Inbox as InboxIcon, LogOut, Mail, Menu, MessageCircle, Moon, Plug, Plus, Radar, Files, Mic, Settings, Sun, ListChecks, Crosshair, Pin, Armchair, Server, KeyRound, Sparkles, Coins, Globe, Search as SearchIcon } from "lucide-react";
import { PRIORITY_PATH, PriorityLongPress, PriorityModeChip } from "@/components/priorityShortcut";
import { OtherWorldsPill } from "@/components/otherWorlds";
import { api, apiMode, type CountsView, type Milestone, type MilestoneStatusView, type PendingItem, type ReviewItem, type WorldCounts } from "@/api";
import { useQuery, useSharedQuery } from "@/lib/data";
import { blockedItems, milestoneInbox, reviewCards, useBlocked, useReviewCards, useStatusBatch } from "@/lib/inbox";
import { useSnoozes } from "@/lib/snooze";
import { RECONNECTING_MESSAGE, isReconnecting, onReconnecting } from "@/api/real";
import { cn } from "@/lib/utils";
import { GOAL_INBOX_TAB, GoalPills, SetWheel, topObjectives, useGoalSets } from "@/components/goalRing";
import { isVoiceNotesPin, useFold, useStoredFlag } from "@/lib/storedFlag";
import { objectiveOf } from "@/lib/scorecards";
import { INBOX_PATH } from "@/components/inboxLine";
import { INBOX_LAND } from "@/lib/inboxPlace";
import { Button } from "@/components/ui/button";
import { BackArrow } from "@/components/backArrow";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { MILESTONE_PAGE, milestoneWheelRows, pageMilestones, progressLabel, splitBigRoots } from "@/lib/bigRoots";
import { LoadMore } from "@/components/loadMore";
import { statusOf } from "@/lib/status";
import { lazyPage } from "@/lib/lazyPage";
import { keptPart, loadCampaignHome, loadGoalSets, prefetchSidebarScripts, useScriptIn } from "@/lib/sidebarScripts";
import { milestoneName } from "@/lib/format";
import { focusHeading, useShows, useSkin, useWords, type ScreenId } from "@/lib/skin";
import { BRAND_MARKS, BrandMark, brandOf, siblingOf } from "@/components/brand";
import { COMPANY_PATH } from "@/lib/company";
import { GAP_FINDER_PATH, NEW_CAMPAIGN_PATH, OUTCOMES_PATH, PAGES_PATH, VOICE_NOTES_PATH, X_STATS_PATH } from "@/lib/routePaths";
import { SETTINGS_PATH, useOperatorPages, useToolPages } from "@/lib/settingsPath";
import { useCompanyView } from "@/lib/companyView";
import { useGapFinder } from "@/lib/gapFinder";
import { reachSites, setupConnections } from "@/pages/Setup";
import { knownDoor, worldId } from "@/lib/useSocial";
import { campaignMilestones, useCampaigns } from "@/lib/campaign";
import { ALL_PROJECTS, useProject } from "@/lib/project";
import { PERFORMANCE_PATH, PRODUCT_PATH } from "@/pages/social/nav";
import { MESSAGES_PATH, useMessages } from "@/lib/messages";
import { OBJECTIVE_SEARCH_PATH } from "@/lib/objectiveSearch";
import { CountPill, PILL_TITLES } from "@/components/homeSection";
import { AfterCloseNote } from "@/components/afterClose";
import { TopBarVoice } from "@/voice/TopBarVoice";
import { knownWorld } from "@/lib/useSocial";
import { deskVoiceBase } from "@/voice/deskBase";
import { homeWorld } from "@/lib/identity";
import { FoldChevron } from "@/components/foldChevron";

// The New milestone dialog loads its script the first time it opens, not with the first screen.
const MilestoneDialog = lazyPage(() => import("@/components/dialogs"), "MilestoneDialog", null);
// the objectives list and the social campaigns list are their own scripts (lib/sidebarScripts.ts).
const SidebarGoalSetsOf = keptPart(loadGoalSets, "SidebarGoalSetsOf");
const SidebarCampaigns = keptPart(loadCampaignHome, "SidebarCampaigns");

/**
 * the pills' numbers (GET /api/counts, one small answer, polled with the other queries). The Layout reads it once for
 * the top bar and both sidebars; a SidebarNav rendered on its own (tests) reads its own.
 */
const CountsCtx = createContext<{ counts: CountsView | undefined } | undefined>(undefined);
function useCounts(): CountsView | undefined {
  const shared = useContext(CountsCtx);
  const own = useQuery(() => (shared ? Promise.resolve(undefined) : api.getCounts()), [!!shared], { tag: "counts" });
  return shared ? shared.counts : own.data;
}

/**
 * a line's pills, always in this order and each only above 0: red = waiting on you to unblock, green = waiting for
 * your review, dark grey = unread chat replies. The one CountPill, so a colour means the same on every screen.
 */
export function Pills({
  needsYou,
  review,
  chat,
  ids,
  milestoneId,
  className,
}: {
  needsYou?: number | null;
  review?: number;
  chat?: number | null;
  ids: { needsYou?: string; review?: string; chat?: string };
  milestoneId?: string;
  className?: string;
}) {
  const shown = (
    [
      ["needs-you", needsYou, ids.needsYou],
      ["review", review, ids.review],
      ["unread", chat, ids.chat],
    ] as const
  ).filter(([, n]) => (n ?? 0) > 0);
  if (!shown.length) return null;
  return (
    <span className={cn("ml-auto flex shrink-0 items-center gap-1 normal-case tracking-normal", className)} data-testid="pills">
      {shown.map(([tone, n, id]) => (
        <CountPill key={tone} count={n!} tone={tone} testId={id} milestoneId={milestoneId} title={PILL_TITLES[tone](n!)} />
      ))}
    </span>
  );
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
    // the phone's status and system bars follow the theme (index.html sets the first one).
    document.querySelector<HTMLMetaElement>("meta[data-app-theme]")?.setAttribute("content", dark ? "#09090b" : "#ffffff");
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

// min-w-0 everywhere: grid/flex children default to min-width:auto, which let a long milestone title
// widen the nav past the sidebar and over the page.
/**
 * the Messages entry, only in a world with a social repo (the console's twin of the social
 * skin's, L-5). Its red pill counts the chats that need the owner: a reply waiting for his Send, a chat left by rule, a request
 * he can't read yet (the same pill as Team's: needs you).
 */
function MessagesNav({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useMessages();
  const project = useProject();
  if (!data?.repos.length) return null;
  // the selected project's chats only (the same "waiting for you" rule as the page's first list).
  const mine = project.current ? data.chats.filter((c) => c.repo === project.current!.repo) : undefined;
  const n = mine ? mine.filter((c) => c.group === "you" && c.status !== "drafting").length : data.counts.waiting;
  return (
    <NavLink to={`/${MESSAGES_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-messages">
      <Mail className="h-4 w-4" />
      Messages
      {n > 0 && <CountPill count={n} tone="needs-you" testId="messages-count" title={`${n} chat${n === 1 ? "" : "s"} waiting for you`} className="ml-auto" />}
    </NavLink>
  );
}

const itemClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
    isActive ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );

/** "Other milestones" open or folded, kept in localStorage (default folded). */
const OTHERS_STORE = "sidebar.otherMilestones.open";
/** the social skin's More fold open or folded, kept in localStorage (default folded). */
const MORE_STORE = "sidebar.more.open";
/** the console's Tools and Settings folds, each open or folded in this browser (default folded). */
const TOOLS_STORE = "sidebar.tools.open";
const SETTINGS_STORE = "sidebar.settings.open";
/**
 * one big root in the sidebar: the root's tree color (done / in progress / draft / blocked on you / blocked on
 * a dependency, red ring when something under it waits on the owner), its name, a % done bar and the waiting-on-you count.
 */
/** a count whose spines are not read yet (console just restarted): a quiet mark, never a low number. */
function CountLoading({ className }: { className?: string }) {
  return (
    <span className={cn("shrink-0 px-1 text-[11px] leading-4 text-muted-foreground", className)} title="counting… (the console just restarted)" data-testid="needs-you-loading">
      …
    </span>
  );
}

/** the sidebar's one state word for a project: running (a live worker, green), needs you (ink) or idle (grey). */
export function SidebarState({ live, needs, loading, title }: { live: number; needs: number; loading?: boolean; title?: string }) {
  const word = loading ? "…" : live > 0 ? "running" : needs > 0 ? "needs you" : "idle";
  return (
    <span
      className={cn("text-xs leading-4", live > 0 ? "text-emerald-600 dark:text-emerald-400" : needs > 0 ? "text-foreground" : "text-muted-foreground")}
      title={[title, live > 0 ? `${live} worker${live === 1 ? "" : "s"} running` : undefined].filter(Boolean).join(" · ") || undefined}
      data-testid="sidebar-state"
      data-state={loading ? "loading" : live > 0 ? "running" : needs > 0 ? "needs_you" : "idle"}
    >
      {word}
    </span>
  );
}

export const MILESTONE_INBOX_TAB = GOAL_INBOX_TAB;

/**
 * one goal that no objective holds (the house, a server, another repo's milestone): drawn like an objective's entry
 * (its circle, its name, its inbox pills, the owner: "Why sidebar element selection work so different
 * when selecting a goal or a 'project'?"), opening the same goal screen; a tap on a pill opens its Inbox tab.
 */
function MilestoneGoalLink({ m, status, counts, onNavigate }: { m: Milestone; status: MilestoneStatusView | undefined; counts: { ask: number; review: number }; onNavigate?: () => void }) {
  const pr = progressLabel(status);
  return (
    <NavLink
      to={`/milestones/${m.id}`}
      className={({ isActive }) => cn("grid min-w-0 gap-1.5 rounded-md border-l-[3px] px-2.5 py-2", isActive ? "border-l-foreground bg-card shadow-sm ring-1 ring-border" : "border-l-transparent hover:bg-accent/60")}
      onClick={onNavigate}
      title={!m.docTitle ? milestoneName(m) : m.titleOverride ? `${m.title} (spine title: ${m.docTitle})` : `${m.docTitle} (console title: ${m.title})`}
      data-testid="big-root"
      data-milestone-id={m.id}
    >
      <span className="flex min-w-0 items-start gap-2">
        <SetWheel rows={milestoneWheelRows(status)} size={20} testId="sidebar-goal-wheel" />
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-[14px] font-medium leading-snug text-foreground" title={pr?.title}>{milestoneName(m)}</span>
        {status?.loading ? <CountLoading className="mt-0.5" /> : <GoalPills c={counts} to={`/milestones/${encodeURIComponent(m.id)}?tab=${MILESTONE_INBOX_TAB}`} onNavigate={onNavigate} milestoneId={m.id} ids={SIDEBAR_PILL_IDS} />}
      </span>
    </NavLink>
  );
}

const SIDEBAR_PILL_IDS = { ask: "sidebar-needs-you", review: "sidebar-review" };
/** green per milestone: the review cards (lib/inbox reviewCards, the list the section shows) on that milestone. */
/** the console's words for the goals no objective holds: goals like the objectives, never "projects". */
export const OTHER_GOALS = "Other goals";
export const MORE_GOALS = "More goals";
const reviewOf = (cards: { milestoneId?: string }[] | undefined, id: string) => (cards ?? []).filter((c) => c.milestoneId === id).length;

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { data: allMilestones } = useSharedQuery("sb:milestones", () => api.listMilestones());
  // the social skin shows one project (repo) at a time: its milestones, its asks, its review cards.
  const project = useProject();
  // the social skin lists every project's campaigns, each under its project (byProject below); the console skin narrows.
  const byProject = !!useSkin().campaigns && project.projects.length > 1;
  const campaignSkin = !!useSkin().campaigns;
  // the objectives, read once for their own list and to leave out every milestone an objective holds: that
  // milestone IS the objective, listed above with its wheel, so it never shows twice nor opens a second way.
  const sets = useGoalSets();
  // the Messages entry shows only once its chats are read: it is part of the one frame too (it arrived last on its own).
  const messagesList = useMessages();
  // a milestone he retired leaves the list too; its page still opens by its link.
  const held = (id: string) => !campaignSkin && (!!objectiveOf(sets.data?.nodes, id) || !!sets.data?.retired?.includes(id));
  const listed = allMilestones && (project.current && !byProject ? allMilestones.filter((m) => project.keep(m.id)) : allMilestones);
  const milestones = !listed || campaignSkin || sets.error ? listed : sets.data ? listed.filter((m) => !held(m.id)) : undefined;
  // the dots and the Team badge read the server's status batch (same object as the milestone header).
  // one shared fetch of the status batch and the review cards (lib/inbox): every pill here is the length of the
  // list its section shows, read at the same moment, with this browser's snoozes and presses applied.
  const { data: statuses } = useStatusBatch();
  const { entries: snoozing } = useSnoozes();
  const { cards: allCards } = useReviewCards();
  const [newOpen, setNewOpen] = useState(false);
  // Mounted (and its script fetched) only once it has been opened
  const [newEver, setNewEver] = useState(false);
  useEffect(() => { if (newOpen) setNewEver(true); }, [newOpen]);
  const navigate = useNavigate();
  const { dark, toggle } = useTheme();
  // words and screen set come from the world's skin. Both skins render this one menu in the
  // console's order (Team, Chat, the pinned milestones, Other milestones, the console pages, your account); the social skin
  // differs only by its words (Campaigns), its hidden operator pages and Setup while something is unconnected.
  const w = useWords();
  const shows = useShows();
  const companyView = useCompanyView(); // parked unless the server turns it on
  const gapFinder = useGapFinder();
  const campaigns = !!useSkin().campaigns;
  const blockedHere = useBlocked(statuses, { keep: project.keep });
  // spines not read yet: no number (never a low count), as before
  // E948-S103: a review card that waits on his choice is counted red with Blocked, as the Inbox's Decisions bucket is
  const split = splitDecisions(reviewCards(allCards, { keep: project.keep }));
  const openNeeds = statuses?.loading ? null : blockedHere.length + split.decisions.length;
  const teamReview = split.review.length;
  // the social skin lists real campaigns and their jobs only (campaignMilestones): every other milestone of the world
  // (a house decision, a server, taxes) is team work and stays on the team side.
  const { data: camps } = useCampaigns();
  const { roots, rest } = splitBigRoots(campaigns ? campaignMilestones(camps?.campaigns, milestones) : milestones);
  const [othersOpen, setOthersOpen] = useStoredFlag(OTHERS_STORE);
  // about 20 milestones show in priority order (focus first, his order); Load more shows the next 20.
  const [limit, setLimit] = useState(MILESTONE_PAGE);
  const page = pageMilestones(roots, rest, limit);
  const restShows = roots.length === 0 || othersOpen;
  // Unique open items of the folded milestones (an ask two milestones share counts once, as the Team badge does).
  const restLoading = rest.some((m) => statusOf(statuses, m.id)?.loading);
  const restNeeds = new Set(rest.flatMap((m) => blockedItems(statusOf(statuses, m.id), { snoozing }).map((i) => i.id))).size;
  // Chat's unread pill (quiet dark grey); the milestone lines show red and green only.
  const counts = useCounts();
  // in the social skin Team, Chat, Performance and the project's Product deck; the Pipeline is each campaign's
  // tab (every campaign's board still opens at /pipeline by URL). In the social skin these follow the campaigns.
  const socialPages = (
    <>
      {shows("performance") && campaigns && (
        <NavLink to={`/${PERFORMANCE_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-performance">
          <BarChart3 className="h-4 w-4" />
          Performance
        </NavLink>
      )}
      {shows("performance") && campaigns && (
        <NavLink to={`/${PRODUCT_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-product">
          <Presentation className="h-4 w-4" />
          Product
        </NavLink>
      )}
      {/* Post stats in the social skin too (the owner, 22 Nov: "I don't mind having it in both places"). */}
      {shows("postStats") && campaigns && (
        <NavLink to={`/${X_STATS_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-x-stats">
          <BarChart3 className="h-4 w-4" />
          Post stats
        </NavLink>
      )}
      {/* Messages (DMs) under Pipeline (social) or Chat (console), in a world with a social repo; its pill counts the chats that need the owner. */}
      {shows("messages") && <MessagesNav onNavigate={onNavigate} />}
    </>
  );
  const operatorPages = useOperatorPages();
  // read-only pages (Seats, Hosts, Applications, Voice feedback, Dashboard) sit with the console's pages, never under Settings (settings are only what he changes).
  const toolPages = useToolPages();
  const pinnedPages = useSharedQuery("sb:pinned", () => api.listPinnedPages());
  // the owner, 12 Nov 16:02Z: "I just want to see the thing that I put there": the social skin shows Home, Inbox, Chat
  // and his pinned campaigns; everything else folds into More (default folded). The console skin draws it all, unfolded.
  const [moreOpen, setMoreOpen] = useStoredFlag(MORE_STORE);
  const fold = (body: ReactNode) =>
    !campaigns ? (
      body
    ) : (
      <div className="grid min-w-0 grid-cols-1 gap-4" data-testid="sidebar-more">
        <button
          type="button"
          className="flex items-center gap-2 rounded-md border-t px-2.5 pb-1.5 pt-3 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          aria-expanded={moreOpen}
          data-testid="sidebar-more-toggle"
          onClick={() => setMoreOpen(!moreOpen)}
        >
          <FoldChevron open={moreOpen} />
          More
          <span className="ml-auto text-xs">{moreOpen ? "" : "all else"}</span>
        </button>
        {moreOpen && body}
      </div>
    );
  // one row for every goal no objective holds, pinned or not: its circle, name and the pills its Inbox tab shows.
  const rootLink = (m: Milestone) => <MilestoneGoalLink key={m.id} m={m} status={statusOf(statuses, m.id)} counts={milestoneInbox(statuses, allCards, m.id, snoozing)} onNavigate={onNavigate} />;

  // ---- the console skin's sidebar as the owner approved it ("Yes: build it" on the mock-up):
  // Inbox and Chat, his objectives (one list in his order, no Other goals), Tools folded, Settings
  // folded, Worlds last. Nothing is removed: every page keeps its entry, inside a fold.
  const { pathname } = useLocation();
  const hasObjectives = shows("goalSets") && topObjectives(sets.data?.nodes).length > 0;
  const addGoal = (
    <button
      type="button"
      className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      data-testid="add-milestone"
      onClick={() => setNewOpen(true)}
    >
      <Plus className="h-4 w-4" />
      {hasObjectives ? ADD_OBJECTIVE : w.addMilestone}
    </button>
  );
  // the goal links: shown only while there are no objectives yet (a fresh workspace); with objectives, none.
  const goalLinks = [
    ...page.roots.map(rootLink),
    ...page.rest.map(rootLink),
    ...(page.hidden > 0 ? [<LoadMore key="load-more" hidden={page.hidden} onMore={() => setLimit(limit + MILESTONE_PAGE)} testId="sidebar-load-more" />] : []),
  ];
  // Tools: every page you read, nothing to change there (settings are only what he changes), in his order of 22 Nov
  // (his tool-by-tool note): Runs left for the top, Spines, Threads, Tickets, Voice feedback, Dashboard and Applications
  // left the menu (their pages still open by address), One-offs became an objective, the Company map sits under the objectives.
  const tools: ToolEntry[] = [
    ...consoleTools(shows, !!gapFinder?.on, pinnedPages.data?.pinned),
    ...toolPages.filter((p) => TOOL_KEEP.has(p.testId)).map((p) => ({ to: p.to, label: p.label, icon: TOOL_ICONS[p.testId] ?? Files, testId: `nav-tool-${p.testId.slice(3)}` })),
  ];
  const companyMap = companyMapPin(pinnedPages.data?.pinned);
  // Settings: only what he changes (settings are only what he changes): personas he switches, priority mode, keys, sign-ins, skills, credits.
  const settings: ToolEntry[] = [
    ...(shows("settings") ? [{ to: `/${SETTINGS_PATH}`, label: "All settings", icon: Settings, testId: "nav-settings-link", end: true }] : []),
    ...(shows("personas") ? [{ to: "/personas", label: w.personas, icon: Bot, testId: "nav-personas" }] : []),
    ...(shows("runs") ? [{ to: `/${PRIORITY_PATH}`, label: "Priority mode", icon: Crosshair, testId: "nav-priority" }] : []),
    ...operatorPages.map((p) => ({ to: p.to, label: p.label, icon: SETTING_ICONS[p.testId] ?? Settings, testId: `nav-${p.testId}` })),
  ];
  const here = (list: ToolEntry[]) => list.some((t) => !t.external && (pathname === t.to || pathname.startsWith(`${t.to}/`)));
  // each fold opens by itself on one of its own pages, and a press always opens or folds it.
  const [toolsShown, toggleTools] = useFold(TOOLS_STORE, here(tools));
  const [settingsShown, toggleSettings] = useFold(SETTINGS_STORE, here(settings));
  const consoleMenu = (
    <>
      {hasObjectives ? (
        <>
          <SidebarGoalSetsOf
            data={sets.data}
            onNavigate={onNavigate}
            footer={
              <>
                {addGoal}
                {companyMap && <CompanyMapLink pin={companyMap} onNavigate={onNavigate} />}
              </>
            }
            products={false}
          />
          {/* (the owner, 22 Nov: "I don't want to see a single word, a single objective that doesn't
              have key results"): no Other goals fold. A goal no objective holds is not in the sidebar; each old one became
              a full objective with key results or was retired (docs/pursuits.json retired), its page kept at its link. */}
        </>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-0.5" data-testid="sidebar-milestones">
          <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground" data-testid="sidebar-focus-heading">
            {OTHER_GOALS}
          </div>
          {goalLinks}
          {addGoal}
        </div>
      )}
      <SidebarFold label="Tools" items={tools} open={toolsShown} onToggle={toggleTools} onNavigate={onNavigate} testId="nav-pages" className="border-t" />
      <SidebarFold label="Settings" items={settings} open={settingsShown} onToggle={toggleSettings} onNavigate={onNavigate} testId="nav-settings">
        {shows("setup") && <SetupLink onNavigate={onNavigate} />}
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {dark ? "Light mode" : "Dark mode"}
        </button>
      </SidebarFold>
    </>
  );

  // drawn at once (the owner 18 Nov, vn_1dcd875a: "Fix the loading of the fucking sidebar"): one quiet skeleton until
  // every list the menu shows is in, then the whole menu in one frame, never entries arriving one under another.
  // His objectives are part of that one frame (drawn after the rest, they were the entries arriving late);
  // GET /api/scorecards is kept ready on the server (keptJson), so waiting on it costs a few ms.
  // the objectives and campaigns lists are their own scripts: the one frame waits for them too
  const setsScript = useScriptIn(loadGoalSets, shows("goalSets"));
  const campaignsScript = useScriptIn(loadCampaignHome, campaigns);
  const waitingOn = [
    !setsScript && "goal-sets-script",
    !campaignsScript && "campaigns-script",
    !allMilestones && "milestones",
    !sets.data && !sets.error && "scorecards",
    shows("messages") && !messagesList.data && !messagesList.error && "messages",
    (!statuses || statuses.loading) && "status",
    allCards === undefined && "review-items",
    !pinnedPages.data && !pinnedPages.error && "pinned",
    campaigns && camps === undefined && "campaigns",
  ].filter((x): x is string => !!x);
  return (
    <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto overflow-x-hidden p-3">
    <AtOnce waitingOn={waitingOn}>
      {/* in the console skin the name at the top opens Home (the Home entry left the list). */}
      <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 rounded-md px-2 pt-1" data-testid="brand" aria-label={`${w.appName}: Home`}>
        <BrandMark brand={brandOf(w.appName)} />
        {/* the name alone, centred on the mark. */}
        <span className="min-w-0 truncate font-brand text-lg font-semibold leading-none tracking-[-0.02em]" data-testid="brand-name">
          {w.appName}
        </span>
        {apiMode === "mock" && <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:text-amber-400">mock</span>}
      </Link>
      {/* while priority mode is on, a chip says so and opens /priority (where it is switched off); the console skin only. */}
      {shows("runs") && !campaigns && <PriorityModeChip onNavigate={onNavigate} />}

      {/* in the social skin projects are the
          headings of the campaign list below Home and Chat, no longer the first thing in the menu. */}
      {!byProject && !campaigns && <ProjectSwitcher statuses={statuses} cards={allCards} onNavigate={onNavigate} />}

      <nav className="grid min-w-0 grid-cols-1 gap-0.5" aria-label="Main" data-testid="nav-main">
        {/* in the
            social skin these pages sit under the project's name: every campaign of it together; each campaign's own
            Deck, Product, Waiting on me and Pipeline are its tabs. */}
        {/* first in the social product's menu. */}
        {shows("performance") && !campaigns && (
          <NavLink to={`/${PERFORMANCE_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-performance">
            <BarChart3 className="h-4 w-4" />
            Performance
          </NavLink>
        )}
        {/* the product deck (the landing page as slides), read by every persona at each wake. */}
        {shows("performance") && !campaigns && (
          <NavLink to={`/${PRODUCT_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-product">
            <Presentation className="h-4 w-4" />
            Product
          </NavLink>
        )}
        {/* Home is the goals view (all goal sets), the Inbox its own entry with the pills, in both skins. */}
        {campaigns && (
          <NavLink to="/" end className={itemClass} onClick={onNavigate} data-testid="nav-home">
            <Home className="h-4 w-4" />
            Home
          </NavLink>
        )}
        <NavLink to={`/${INBOX_PATH}`} state={INBOX_LAND} className={itemClass} onClick={onNavigate} data-testid="nav-inbox">
          <InboxIcon className="h-4 w-4" />
          Inbox
          {statuses?.loading && <CountLoading className="ml-auto" />}
          <Pills needsYou={openNeeds} review={teamReview} ids={{ needsYou: "waiting-count", review: "team-review-count" }} />
          {/* the other product worlds' own asks and cards (violet): the social skin only; the owner ("inbox is inbox"):
              the console skin shows nothing of them. */}
          {campaigns && <OtherWorldsPill />}
        </NavLink>
        {/* no global Epic deck entry here;
            each milestone page has a Deck tab (round 3, pages/Milestone.tsx MilestoneDeckTab). /deck stays by URL. */}
        {shows("chat") && (
          <NavLink to="/chat" className={itemClass} onClick={onNavigate}>
            <MessageCircle className="h-4 w-4" />
            Chat
            <Pills chat={counts?.chat} ids={{ chat: "chat-unread" }} />
          </NavLink>
        )}
        {/* Runs high (the owner, 22 Nov: "Runs I would make much higher. That's the one I actually use the most"). */}
        {shows("runs") && !campaigns && (
          <NavLink to="/runs" className={itemClass} onClick={onNavigate} data-testid="nav-runs">
            <Activity className="h-4 w-4" />
            {w.runs}
          </NavLink>
        )}
        {/* the owner (vn_de2da36f): "a search feature ... across all the objectives and all the key results and
            all the tickets attached to them ... in the top left section with inbox, chat, runs, messages": the console skin, after Runs (Inbox stays first). */}
        {shows("goalSets") && !campaigns && (
          <NavLink to={`/${OBJECTIVE_SEARCH_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-search">
            <SearchIcon className="h-4 w-4" />
            Search
          </NavLink>
        )}
        {/* the Company view, an extra lens beside the Team home (his one inbox stays). */}
        {shows("company") && companyView && (
          <NavLink to={`/${COMPANY_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-company">
            <Building2 className="h-4 w-4" />
            Company view
          </NavLink>
        )}
        {/* in the social skin Team, Chat, Performance and the project's Product deck, in that order; the
            Pipeline is each campaign's tab (every campaign's board still opens at /pipeline by URL). */}
        {!campaigns && socialPages}
      </nav>

      {/* The social skin: his pinned campaigns, each its number ring, name and inbox pills, right under Home, Inbox and Chat. */}
      {campaigns && <SidebarCampaigns onNavigate={onNavigate} />}

      {campaigns ? fold(
        <>
      {campaigns && !byProject && <ProjectSwitcher statuses={statuses} cards={allCards} onNavigate={onNavigate} />}
      {/* his pursuits lead the projects: each its name, moving or stalled, and its green lines. */}
      {/* every sidebar entry is a goal set, nested, All goal sets on top; both skins. */}
      {shows("goalSets") && <SidebarGoalSetsOf data={sets.data} onNavigate={onNavigate} />}

      {/* the owner, 2026-11-12 (vn_87528e51): "In there, we only need the quick access to the inbox, the chat, and the
          microphone. The other things are in the sidebar." So every other page sits here, below the goal sets, in his
          order: one-offs, the outcome log, every one-off page the team made, his voice notes, the Gap finder. */}
      <SidebarMorePages onNavigate={onNavigate} gapFinderOn={!!gapFinder?.on} />

      <div className="grid min-w-0 grid-cols-1 gap-0.5" data-testid="sidebar-milestones">
        <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground" data-testid="sidebar-focus-heading">
          {campaigns ? (roots.length ? focusHeading(w) : w.milestones) : OTHER_GOALS}
        </div>
        {/* the owner's big roots lead, each with its color, % done and waiting count; the per-repo milestones fold below. */}
        {byProject ? <ProjectGroups roots={page.roots} statuses={statuses} cards={allCards} onNavigate={onNavigate} link={rootLink} /> : page.roots.map(rootLink)}
        {roots.length > 0 && rest.length > 0 && (
          <button
            type="button"
            className="mt-1 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            aria-expanded={othersOpen}
            data-testid="other-milestones-toggle"
            onClick={() => setOthersOpen(!othersOpen)}
          >
            <FoldChevron open={othersOpen} />
            {campaigns ? `Other ${w.milestonesWord}` : MORE_GOALS} ({rest.length})
            {!othersOpen && restLoading && <CountLoading className="ml-auto" />}
            {!othersOpen && (
              <Pills
                needsYou={restLoading ? 0 : restNeeds}
                review={rest.reduce((n, m) => n + reviewOf(allCards, m.id), 0)}
                ids={{ needsYou: "other-needs-you", review: "other-review" }}
              />
            )}
          </button>
        )}
        {restShows && page.rest.map(rootLink)}
        {(restShows || page.roots.length < roots.length) && <LoadMore hidden={page.hidden} onMore={() => setLimit(limit + MILESTONE_PAGE)} testId="sidebar-load-more" />}
        <button
          type="button"
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          data-testid="add-milestone"
          // in the social skin one dialog offers a campaign (the New campaign wizard) or a one-off job (a milestone).
          onClick={() => setNewOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {campaigns ? ADD_CAMPAIGN_OR_JOB : w.addMilestone}
        </button>
      </div>

      {campaigns && (
        <nav className="grid min-w-0 grid-cols-1 gap-0.5" aria-label="Campaign pages" data-testid="nav-social-pages">
          {socialPages}
        </nav>
      )}

      <nav className="mt-auto grid min-w-0 grid-cols-1 gap-0.5 border-t pt-3" aria-label="Console pages" data-testid="nav-pages">
        {shows("personas") && (
          <NavLink to="/personas" className={itemClass} onClick={onNavigate}>
            <Bot className="h-4 w-4" />
            {w.personas}
          </NavLink>
        )}
        {shows("runs") && (
          <NavLink to="/runs" className={itemClass} onClick={onNavigate}>
            <Activity className="h-4 w-4" />
            {w.runs}
          </NavLink>
        )}
        {/* priority mode one tap away (the Runs page's panel alone), no top-bar button; the console skin only. */}
        {shows("runs") && !campaigns && (
          <NavLink to={`/${PRIORITY_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-priority">
            <Crosshair className="h-4 w-4" />
            Priority mode
          </NavLink>
        )}
        {toolPages.filter((p) => TOOL_KEEP.has(p.testId)).map((p) => {
          const Icon = TOOL_ICONS[p.testId] ?? Files;
          return (
            <NavLink key={p.to} to={p.to} className={itemClass} onClick={onNavigate} data-testid={`nav-tool-${p.testId.slice(3)}`}>
              <Icon className="h-4 w-4" />
              {p.label}
            </NavLink>
          );
        })}
      </nav>

      {/* Settings, then its pages (only what he changes, settings are only what he changes), small and indented under it. */}
      <nav className="grid min-w-0 grid-cols-1 gap-0.5 border-t pt-3" aria-label="Settings" data-testid="nav-settings">
        {shows("settings") && (
          <NavLink to={`/${SETTINGS_PATH}`} end className={itemClass} onClick={onNavigate} data-testid="nav-settings-link">
            <Settings className="h-4 w-4" />
            Settings
          </NavLink>
        )}
        {operatorPages.map((p) => (
          <NavLink key={p.to} to={p.to} className={(s) => cn(itemClass(s), "text-[13px]", shows("settings") && "pl-9")} onClick={onNavigate}>
            {p.label}
          </NavLink>
        ))}
        {shows("setup") && <SetupLink onNavigate={onNavigate} />}
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {dark ? "Light mode" : "Dark mode"}
        </button>
      </nav>
        </>,
      ) : consoleMenu}

      <AccountBlock />
      {/* the worlds come last, in the flow of the menu, seen when you scroll to them. */}
      <WorldSwitcher />

      {(newOpen || newEver) && <MilestoneDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        offerCampaign={campaigns}
        onCampaign={() => {
          setNewOpen(false);
          onNavigate?.();
          navigate(`/${NEW_CAMPAIGN_PATH}`);
        }}
        onCreated={(m) => {
          onNavigate?.();
          navigate(`/milestones/${m.id}`);
        }}
      />}
    </AtOnce>
    </div>
  );
}

/** a phone reads the menu's lists this long after the page opens, once the page's own lists had their turn. */
export const WARM_AFTER_MS = 1_500;
/** a menu that never says ready shows anyway after this (an error path). */
export const SIDEBAR_GIVE_UP_MS = 8_000;
/** the menu's lists, mounted (they fetch) but out of sight under one skeleton until `ready`; once shown it stays shown. */
export function AtOnce({ waitingOn, children }: { waitingOn: string[]; children: ReactNode }) {
  const ready = waitingOn.length === 0;
  const [shown, setShown] = useState(ready);
  useEffect(() => {
    if (ready) setShown(true);
  }, [ready]);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), SIDEBAR_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, []);
  const on = shown || ready;
  return (
    <>
      {!on && (
        <div className="flex min-w-0 flex-col gap-3" data-testid="sidebar-skeleton" data-waiting-on={waitingOn.join(" ")} aria-label="Loading" aria-busy>
          <div className="mb-2 h-7 w-32 animate-pulse rounded-md bg-muted/60" />
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-md bg-muted/50" />
          ))}
        </div>
      )}
      <div className={on ? "contents" : undefined} hidden={!on} data-testid="sidebar-body">
        {children}
      </div>
    </>
  );
}

/**
 * the menu's lists, read ahead and kept fresh while the menu is shut (a phone mounts the menu only when opened): opened,
 * it draws at once from what is already here. Started once the page's own lists had their turn, so the Inbox comes first.
 */
export function SidebarWarm() {
  useSharedQuery("sb:milestones", () => api.listMilestones());
  useSharedQuery("sb:pinned", () => api.listPinnedPages());
  useSharedQuery("sb:me", () => (api.getMe ? api.getMe() : Promise.resolve(undefined)));
  useSharedQuery("sb:world-counts", () => (api.getWorldCounts ? api.getWorldCounts() : Promise.resolve(undefined)), { tag: "counts" });
  useGoalSets();
  useStatusBatch();
  const { cards } = useReviewCards();
  useMessages();
  useCampaigns();
  // the menu's own scripts too, once the inbox's cards are in (they never share the line with them)
  const campaigns = !!useSkin().campaigns;
  const inboxIn = cards !== undefined;
  useEffect(() => {
    if (inboxIn) prefetchSidebarScripts(campaigns);
  }, [inboxIn, campaigns]);
  return null;
}

/** the read-only pages' icons in the menu's tools list (lib/settingsPath useToolPages). */
const TOOL_ICONS: Record<string, typeof Files> = {
  "op-seats": Armchair,
  "op-hosts": Server,
};
/**
 * the read-only pages kept in Tools (the owner, 22 Nov: "Seats, I would leave. Hosts, I would leave"). Applications
 * ("This doesn't belong here ... you need to give me an option for it"), Voice feedback ("I don't get voice feedback") and
 * Dashboard ("a legacy thing") left the menu; their pages still open by address.
 */
export const TOOL_KEEP: ReadonlySet<string> = new Set(["op-seats", "op-hosts"]);

/** the Company map's pin (slug company): it is no tool, it sits under the objectives as the map of all of them. */
export const companyMapPin = <P extends { slug?: string }>(pinned: P[] | undefined): P | undefined => pinned?.find((p) => p.slug === "company");

/** under the objectives: the Company map, named for what it is (his 22 Nov note: "is this a tool? ... more about the full context"). */
function CompanyMapLink({ pin, onNavigate }: { pin: { slug?: string; url: string; title?: string }; onNavigate?: () => void }) {
  return (
    <a
      href={pin.slug ? `/${pin.slug}` : pin.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      onClick={onNavigate}
      data-testid="nav-company-map"
      title="Every product and its goals on one map"
    >
      <Building2 className="h-4 w-4" />
      All products on one map
    </a>
  );
}

/** the console's add button under the objectives ("Add project becomes Add objective"). */
export const ADD_OBJECTIVE = "Add objective";

type ToolEntry = { to: string; label: string; icon: typeof Files; testId: string; end?: boolean; external?: boolean; title?: string };

/**
 * the Tools fold's pages in the owner's order of 22 Nov: Pages, Post stats, the pages he pinned by name
 * (the Company map leaves for the objectives), Persona outcomes, Voice notes (kept, "not make it the first one"; a pinned
 * page named "… voice notes" folds into it), Gap finder. One-offs left: it is the objective "Handle one-offs" now.
 */
export function consoleTools(shows: (s: ScreenId) => boolean, gapFinderOn: boolean, pinned: { name?: string; slug?: string; url: string; title?: string }[] | undefined): ToolEntry[] {
  const pages = morePages(shows, false, gapFinderOn);
  const by = (id: string) => pages.filter((p) => p.testId === id);
  const pins: ToolEntry[] = (pinned ?? [])
    .filter((p) => !isVoiceNotesPin(p) && p.slug !== "company")
    .map((p) => ({ to: p.slug ? `/${p.slug}` : p.url, label: p.name ?? p.title ?? p.url, icon: Pin, testId: "nav-pinned-page", external: true, title: p.title }));
  if (!pages.length) return pins;
  return [...by("nav-pages-list"), ...by("nav-x-stats"), ...pins, ...by("nav-outcomes"), ...by("nav-voice-notes"), ...by("nav-gap-finder")];
}

/** one folded group of the console's sidebar (Tools, Settings): a header with its count, its pages when open. */
function SidebarFold({ label, items, open, onToggle, onNavigate, testId, className, children, count, badge }: { label: string; items: ToolEntry[]; open: boolean; onToggle: () => void; onNavigate?: () => void; testId: string; className?: string; children?: ReactNode; count?: number; badge?: ReactNode }) {
  if (!items.length && !children) return null;
  return (
    <nav className={cn("grid min-w-0 grid-cols-1 gap-0.5 pt-3", className)} aria-label={label} data-testid={testId}>
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        onClick={onToggle}
      >
        <FoldChevron open={open} />
        {label}
        <span className="text-xs tabular-nums" data-testid={`${testId}-count`}>{count ?? items.length}</span>
        {!open && badge}
      </button>
      {open && (
        <div className="grid min-w-0 grid-cols-1 gap-0.5 pl-3" data-testid={`${testId}-list`}>
          {items.map((t) =>
            t.external ? (
              <a key={t.to} href={t.to} target="_blank" rel="noreferrer" className={itemClass({ isActive: false })} onClick={onNavigate} data-testid={t.testId} title={t.title}>
                <t.icon className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
              </a>
            ) : (
              <NavLink key={t.to} to={t.to} end={t.end} className={itemClass} onClick={onNavigate} data-testid={t.testId}>
                <t.icon className="h-4 w-4" />
                {t.label}
              </NavLink>
            ),
          )}
          {children}
        </div>
      )}
    </nav>
  );
}

/** each page in the Settings fold its own icon (the input pages, lib/settingsPath useOperatorPages). */
const SETTING_ICONS: Record<string, typeof Files> = {
  "op-secrets": KeyRound,
  "op-connections": Plug,
  "op-team-skills": Sparkles,
  "op-credits": Coins,
  "op-browser-auth": Globe,
};

/** the social skin's add button (mockup note 6): a standing campaign or a one-off job, one dialog. */
export const ADD_CAMPAIGN_OR_JOB = "Add campaign or job";

/**
 * Setup (repo, X, Reddit, LinkedIn) shows in the menu with its count only while something is
 * unconnected; the page itself stays at /setup. Reads what the Setup page reads (the world's campaigns and sign-ins).
 */
function SetupLink({ onNavigate }: { onNavigate?: () => void }) {
  const campaigns = useQuery(async () => api.listCampaigns(await worldId()), []);
  const reach = useQuery(() => api.authReach(), []);
  if (!campaigns.data || (!reach.data && !reach.error)) return null;
  const signIns = reachSites(reach.data);
  const left = setupConnections({ campaigns: campaigns.data.campaigns, sites: signIns.sites, sitesUnavailable: signIns.unavailable }).filter((c) => c.state !== "connected").length;
  if (!left) return null;
  return (
    <NavLink to="/setup" className={itemClass} onClick={onNavigate} data-testid="nav-setup">
      <Plug className="h-4 w-4" />
      Setup
      <span className="ml-auto text-[11px] text-muted-foreground" data-testid="setup-left">
        {left} to connect
      </span>
    </NavLink>
  );
}

/**
 * who is logged in (email, world, role from /api/me), Switch world (the worlds this login belongs
 * to) and Log out, at the bottom of the menu on both sites. The server routes are's /api/access/{switch,logout}.
 */
export function AccountBlock() {
  const w = useWords();
  const { data: me } = useSharedQuery("sb:me", () => (api.getMe ? api.getMe() : Promise.resolve(undefined)));
  const [busy, setBusy] = useState<"logout">();
  const [err, setErr] = useState<string>();
  if (!me) return null;
  const id = me.identity ?? { kind: "none" as const };
  const world = me.tenant ? me.tenant.name || me.tenant.id : undefined;
  const role = id.kind === "session" ? id.role : undefined;
  const who = id.kind === "session" ? id.email ?? id.name ?? "you" : id.kind === "token" ? `agent token${id.label ? ` ${id.label}` : ""}` : id.kind === "legacy" ? "the console host (no login)" : "not logged in";
  const act = async (what: "logout", fn: () => Promise<unknown>, then: string) => {
    setBusy(what);
    setErr(undefined);
    try {
      await fn();
      window.location.assign(then);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(undefined);
    }
  };
  return (
    <div className="grid min-w-0 gap-1.5 px-2.5 pt-1 text-xs" data-testid="account-block">
      {/* the signed-in person beside an initial, the world under the name. */}
      <div className="grid min-w-0 grid-cols-[28px_minmax(0,1fr)] items-center gap-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-border text-xs font-semibold text-foreground" aria-hidden data-testid="account-initial">
          {initialOf(who)}
        </span>
        <div className="grid min-w-0 leading-tight">
          <span className="truncate text-[13px] font-medium text-foreground" data-testid="account-who" title={who}>
            {who}
          </span>
          {world && (
            <span className="truncate text-muted-foreground" data-testid="account-world">
              Workspace: {world}
              {role ? ` (${role})` : ""}
            </span>
          )}
        </div>
      </div>
      {id.kind === "session" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!!busy} pending={busy === "logout"} pendingLabel="Logging out…" onClick={() => act("logout", () => api.logout!(), "/login")} data-testid="account-logout">
            <LogOut className="h-3.5 w-3.5" /> Log out
          </Button>
        </div>
      ) : (
        id.kind === "none" && (
          <a href="/login" className="underline" data-testid="account-login">
            Log in
          </a>
        )
      )}
      {err && (
        <p className="text-destructive" role="alert">
          {err}
        </p>
      )}
      {showsSibling(me) && <SiblingLink appName={w.appName} />}
    </div>
  );
}

type StatusBatch = { needsYou?: number | null; items?: PendingItem[] } | undefined;
type Cards = Pick<ReviewItem, "id" | "milestoneId" | "ownerPriority" | "face">[] | undefined;

/**
 * the social menu's pinned campaigns under their project's name,
 * in his pinned order within each project. The project's name narrows every page to it (`?project=`,'s select); a
 * campaign of no project sits last under Other. Each heading keeps the switcher's pills and test ids.
 */
function ProjectGroups({ roots, statuses, cards, onNavigate, link }: { roots: Milestone[]; statuses: StatusBatch; cards: Cards; onNavigate?: () => void; link: (m: Milestone) => ReactNode }) {
  const { projects, current, select, keepIn, projectOf } = useProject();
  const { entries: snoozing } = useSnoozes();
  const groups = [...projects.map((p) => ({ p, ms: roots.filter((m) => projectOf(m.id)?.repo === p.repo) })), { p: undefined, ms: roots.filter((m) => !projectOf(m.id)) }];
  return (
    <div className="grid min-w-0 gap-2" data-testid="project-groups">
      {groups.map(({ p, ms }) =>
        !p ? (
          ms.length > 0 && (
            <div key="other" className="grid min-w-0 gap-0.5" data-testid="project-group-other">
              <div className="px-2.5 text-[11px] font-medium text-muted-foreground">Other</div>
              {ms.map(link)}
            </div>
          )
        ) : (
          <div key={p.repo} className="grid min-w-0 gap-0.5" data-testid={`project-group-${p.repo}`}>
            <button
              type="button"
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs max-sm:min-h-11",
                p.repo === current?.repo ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              aria-current={p.repo === current?.repo ? "true" : undefined}
              title={p.repo === current?.repo ? `Showing ${p.name} only: press Home for every project` : `Show ${p.name} only`}
              onClick={() => {
                select(p.repo === current?.repo ? ALL_PROJECTS : p.repo);
                onNavigate?.();
              }}
              data-testid={`project-${p.repo}`}
            >
              <span className={cn("grid h-5 min-w-5 shrink-0 place-items-center rounded px-0.5 text-[10px] font-semibold", worldTint(p.repo))} aria-hidden>
                {worldMark(p.name)}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium uppercase tracking-wider">{p.name}</span>
              <Pills needsYou={blockedItems(statuses, { keep: keepIn(p), snoozing }).length + splitDecisions(reviewCards(cards, { keep: keepIn(p) })).decisions.length} review={splitDecisions(reviewCards(cards, { keep: keepIn(p) })).review.length} ids={{ needsYou: `project-${p.repo}-needs-you`, review: `project-${p.repo}-review` }} />
            </button>
            {ms.map(link)}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * the project switcher at the top of the menu (desktop sidebar and the
 * phone menu). One button per project of the world (a repo with the social pack), the selected one marked, each with what waits
 * on the owner there (red asks, green review cards). Choosing one narrows the whole social UI to that repo and keeps `?project=`.
 */
export function ProjectSwitcher({ statuses, cards, onNavigate }: { statuses: StatusBatch; cards: Cards; onNavigate?: () => void }) {
  const { projects, current, select, keepIn } = useProject();
  // each project's pills are the lengths of the lists its Team home shows (the same functions, the same keep).
  const { entries: snoozing } = useSnoozes();
  if (projects.length < 2) return null;
  return (
    <div className="grid min-w-0 gap-1" data-testid="project-switcher">
      <div className="px-2.5 pb-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground" title="Each project is one repo in this world">
        Projects
      </div>
      <ul className="grid min-w-0 gap-0.5" aria-label="Your projects">
        {projects.map((p) => {
          const on = p.repo === current?.repo;
          return (
            <li key={p.repo}>
              <button
                type="button"
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm max-sm:min-h-11",
                  on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                aria-current={on ? "true" : undefined}
                title={on ? `You are in ${p.name}` : `Show ${p.name}`}
                onClick={() => {
                  select(p.repo);
                  onNavigate?.();
                }}
                data-testid={`project-${p.repo}`}
              >
                <span className={cn("grid h-5 min-w-5 shrink-0 place-items-center rounded px-0.5 text-[10px] font-semibold", worldTint(p.repo))} aria-hidden>
                  {worldMark(p.name)}
                </span>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <Pills needsYou={blockedItems(statuses, { keep: keepIn(p), snoozing }).length + splitDecisions(reviewCards(cards, { keep: keepIn(p) })).decisions.length} review={splitDecisions(reviewCards(cards, { keep: keepIn(p) })).review.length} ids={{ needsYou: `project-${p.repo}-needs-you`, review: `project-${p.repo}-review` }} />
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm max-sm:min-h-11",
              !current ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            aria-current={!current ? "true" : undefined}
            title="Show every project at once"
            onClick={() => {
              select(ALL_PROJECTS);
              onNavigate?.();
            }}
            data-testid="project-all"
          >
            <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded bg-muted px-0.5 text-[10px] font-semibold text-muted-foreground" aria-hidden>
              All
            </span>
            <span className="min-w-0 flex-1 truncate">All projects</span>
            <Pills needsYou={blockedItems(statuses, { snoozing }).length} review={cards?.length ?? 0} ids={{ needsYou: "project-all-needs-you", review: "project-all-review" }} />
          </button>
        </li>
      </ul>
    </div>
  );
}

/**
 * every world this
 * login belongs to, each with its red (blocked asks) and green (review cards) pills, the current one marked; one click on
 * another switches (a new session in that world,'s /api/access/switch) and opens its Team home. Desktop sidebar and
 * the phone menu both render it (SidebarNav). It replaces's Switch world button; shown once a login has two worlds.
 * unpinned, below the account block, and worded apart from the project switcher (projects: repos inside this world,
 * at the top, used often; worlds: separate homes, at the bottom, used rarely).
 */
export function WorldSwitcher() {
  const hasProjects = useProject().projects.length > 1;
  const { data } = useSharedQuery("sb:world-counts", () => (api.getWorldCounts ? api.getWorldCounts() : Promise.resolve(undefined)), { tag: "counts" });
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  // the owner 17 Nov (vn_c149df3a): in a customer EpicTeam workspace the account can make a new
  // workspace (it opens clean, no Get set up), so its workspaces show here even while it has one
  const campaigns = !!useSkin().campaigns;
  const here = useSharedQuery("sb:world", () => worldId()).data ?? knownWorld();
  const customer = !campaigns && !!here && here !== homeWorld() && !knownDoor() && !!api.newWorkspace;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const worlds = data?.worlds ?? [];
  if (worlds.length < 2 && !customer) return null;
  const make = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("new");
    setErr(undefined);
    try {
      const w = await api.newWorkspace!(here!, name.trim());
      const r = await api.switchWorld!(w.tenantId);
      window.location.assign(r?.handoff || "/");
    } catch (x) {
      setErr((x as Error).message);
      setBusy(undefined);
    }
  };
  const go = async (w: WorldCounts) => {
    setBusy(w.tenantId);
    setErr(undefined);
    try {
      const r = await api.switchWorld!(w.tenantId);
      // a world on the other host (the memory service social on the social site) opens there, already signed in.
      window.location.assign(r?.handoff || "/");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(undefined);
    }
  };
  return (
    // not pinned; the last section of the menu (desktop sidebar and phone menu), under the account block.
    <div className="grid min-w-0 gap-1 border-t pt-3" data-testid="world-switcher">
      <div className="px-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{customer ? "Your workspaces" : "Your worlds"}</div>
      <p className="px-2.5 pb-0.5 text-xs text-muted-foreground" data-testid="world-switcher-hint">
        {customer ? "Each workspace is a separate home with its own team." : "Each world is a separate home with its own team."}
        {hasProjects ? " Projects at the top switch inside this one." : ""}
      </p>
      <ul className="grid min-w-0 gap-0.5" aria-label={customer ? "Your workspaces" : "Your worlds"}>
        {worlds.map((w) => (
          <li key={w.tenantId}>
            <button
              type="button"
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                w.current ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              aria-current={w.current ? "true" : undefined}
              disabled={w.current || !!busy}
              title={w.current ? `You are in ${w.tenantName}` : `Switch to ${w.tenantName}`}
              onClick={() => go(w)}
              data-testid={`world-${w.tenantId}`}
            >
              <span className={cn("grid h-5 min-w-5 shrink-0 place-items-center rounded px-0.5 text-[10px] font-semibold", worldTint(w.tenantId))} aria-hidden>
                {worldMark(w.tenantName)}
              </span>
              <span className="min-w-0 flex-1 truncate">{busy === w.tenantId ? "Switching…" : w.tenantName}</span>
              <Pills needsYou={w.needsYou} review={w.review} ids={{ needsYou: `world-${w.tenantId}-needs-you`, review: `world-${w.tenantId}-review` }} />
            </button>
          </li>
        ))}
      </ul>
      {customer &&
        (naming ? (
          <form onSubmit={make} className="grid min-w-0 gap-1.5 px-2.5 pt-1" data-testid="new-workspace-form">
            <input
              className="h-8 min-w-0 rounded-md border bg-background px-2 text-sm"
              placeholder="Its name, e.g. Side project"
              aria-label="New workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
              data-testid="new-workspace-name"
            />
            <p className="text-xs text-muted-foreground">It starts empty, with no Get set up, and has its own plan.</p>
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={!!busy || !name.trim()} data-testid="new-workspace-make">
                {busy === "new" ? "Making…" : "Make it"}
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setNaming(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground" onClick={() => setNaming(true)} data-testid="new-workspace">
            <Plus className="h-4 w-4 shrink-0" aria-hidden />
            New workspace
          </button>
        ))}
      {err && (
        <p className="px-2.5 text-xs text-destructive" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** a world's mark in the switcher: its capitals (the console skin ET, the social product ES, the memory service Z), else its words' first letters. */
export const worldMark = (name: string) => {
  const caps = name.match(/[A-Z]/g) ?? [];
  if (caps.length >= 2 && !/\s/.test(name.trim())) return caps.slice(0, 2).join("");
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  const m = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? "•")[0]).toUpperCase();
  return m || "•";
};
const TINTS = [
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
];
/** one steady colour per world id, so each world looks the same every time. */
export const worldTint = (id: string) => TINTS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];

/** the avatar's letter: the first letter of the name or email, else a dot. */
export const initialOf = (who: string) => (/^[a-z0-9]/i.test(who) ? who[0].toUpperCase() : "•");

/**
 * the "Open the social product / the console skin" link only for a login that uses both products (the owner: several worlds, or the
 * team's own world the home world); a tester with one world never sees a product they have no part in.
 */
export const showsSibling = (me: { tenant?: { id: string } | null; worlds?: unknown[] } | undefined) =>
  !!me && ((me.worlds?.length ?? 0) > 1 || me.tenant?.id === homeWorld());

/** while the console restarts (a deploy), GETs retry quietly; one muted line says so instead of a red error. */
export function Reconnecting() {
  const [on, setOn] = useState(isReconnecting);
  useEffect(() => onReconnecting(setOn), []);
  if (!on) return null;
  return (
    <div role="status" className="mb-3 text-xs text-muted-foreground">
      {RECONNECTING_MESSAGE}
    </div>
  );
}

/**
 * an the console skin sign-up's world before its plan is paid says so on every page, in one line, with the button that pays
 * (the hosted checkout, a monthly plan; its paid event clears this note). Back from Stripe it says the payment is on its way.
 */
export function BillingNote() {
  const { data: me } = useSharedQuery("sb:me", () => (api.getMe ? api.getMe() : Promise.resolve(undefined)));
  const world = me?.billing === "awaiting_payment" ? me?.tenant?.id : undefined;
  const { data: plan } = usePlan(world);
  if (me?.billing !== "awaiting_payment") return null;
  const back = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("checkout") === "done";
  // the seat bundles on sale, the one picked on the product site first
  return (
    <div role="status" className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="billing-note">
      {back ? (
        <p>Thank you. Stripe is confirming your payment. Your team starts as soon as it arrives, refresh in a moment.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="min-w-0">
            Welcome to EpicTeam. Your account is ready. Your team starts working once your plan is paid. {SEAT_WORDS}
          </p>
          {plan && <BundleButtons plan={plan} size="sm" testid="billing-pay" />}
        </div>
      )}
    </div>
  );
}

/** "Open the social product" (or the console skin) with the sibling's mark, for a login that uses both products. */
export function SiblingLink({ appName }: { appName: string }) {
  const sib = siblingOf(brandOf(appName));
  return (
    <a
      href={sib.url}
      className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
      data-testid="sibling-link"
    >
      <BrandMark brand={sib.id} className="h-[18px] w-[18px]" />
      Open {BRAND_MARKS[sib.id].name}
    </a>
  );
}

/** the md breakpoint (768 px), where the desktop sidebar shows; true where the browser cannot tell (tests, old browsers). */
export const WIDE_QUERY = "(min-width: 768px)";
export function useWide(win: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  const mq = win?.matchMedia?.(WIDE_QUERY);
  const [wide, setWide] = useState(() => mq?.matches ?? true);
  useEffect(() => {
    if (!mq) return;
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win]);
  return wide;
}

export function Layout() {
  const w = useWords();
  // the tab title is the world's family name (the console skin / the social product).
  useEffect(() => {
    document.title = w.appName;
  }, [w.appName]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  // one read of the pills for the top bar and both sidebars.
  const { data: counts } = useQuery(() => api.getCounts(), [], { tag: "counts" });
  // the console skin only: the social skin's worlds keep their menu as it was.
  const showsRuns = useShows()("runs") && !useSkin().campaigns;
  const wide = useWide();
  // a phone mounts its menu only when opened: its lists are read ahead (after the page's own first lists) so it opens at once.
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    if (wide) return;
    const t = setTimeout(() => setWarm(true), WARM_AFTER_MS);
    return () => clearTimeout(t);
  }, [wide]);

  return (
    <CountsCtx.Provider value={{ counts }}>
    {/* a held press on a card with a ticket code offers "Give this the machine" (priority mode). */}
    {showsRuns && <PriorityLongPress />}
    <div className="flex min-h-dvh">
      {/* the desktop sidebar exists only at md and up: on a phone it was hidden by CSS yet mounted, so a first visit read
          (and every 30 s re-read) ~150 KB of lists nobody saw, beside the screen's own data. The phone menu
          mounts its own SidebarNav when opened. */}
      {!wide && warm && <SidebarWarm />}
      {wide && (
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 overflow-hidden border-r bg-muted/30 pt-[env(safe-area-inset-top)] md:block" data-testid="desktop-sidebar">
          <SidebarNav />
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* the top bar shows on every screen (desktop too, where the sidebar already carries the menu and the brand),
            and holds only Inbox, Chat and the mic (plus the menu button and the mark on a phone), so it never crowds. */}
        {/* in the installed app the status bar is see-through: the bar pads under it (safe-area), so the clock sits on the
            bar's own background and nothing scrolls under it. */}
        <header className="sticky top-0 z-40 flex h-[calc(52px+env(safe-area-inset-top))] items-center gap-2 border-b bg-background px-3 max-[379px]:gap-1 max-[379px]:px-1.5 pt-[env(safe-area-inset-top)] md:h-[calc(2.75rem+env(safe-area-inset-top))] md:px-4" data-testid="topbar">
          {/* the installed app has no browser back, so a back arrow leads the bar (not on the first screen). */}
          <BackArrow />
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" onClick={() => setMobileOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          {/* the product's mark and name, as in the sidebar. */}
          {/* the mark is the way Home on a phone: the bar itself keeps only Inbox, Chat and the mic (vn_87528e51). */}
          <NavLink to="/" end aria-label={`${w.appName} Home`} className="flex min-h-[40px] min-w-0 items-center gap-2 md:hidden" data-testid="topbar-brand">
            <BrandMark brand={brandOf(w.appName)} className="h-6 w-6" />
            <span className="truncate font-brand text-[17px] font-semibold tracking-[-0.02em]" data-testid="topbar-brand-name">{w.appName}</span>
          </NavLink>
          <TopBarPills counts={counts} />
        </header>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          {/* data-sidebar: the phone's menu is a dialog, and navigation keeps its own look (no link underline, polish.css) */}
          <SheetContent aria-describedby={undefined} className="overflow-hidden" data-sidebar="">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>

        {/* min-w-0 + break-words: no page content can widen the column past the viewport. */}
        {/* the Pipeline pages take the screen's width. */}
        <main className={cn("mx-auto w-full min-w-0 flex-1 break-words px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 lg:px-8", widePage(location.pathname, location.search) ? "max-w-[110rem]" : "max-w-5xl")}>
          <Reconnecting />
          <BillingNote />
          <Outlet />
        </main>
        {/* after a card closes, on any page: Saved, Add a last thought, Bring it back. */}
        <AfterCloseNote />
      </div>
    </div>
    </CountsCtx.Provider>
  );
}

/**
 * the top bar carries Team's red + green and Chat's unread, each a link to its page, so the owner sees what waits
 * without opening the menu. Same pills and order as the sidebar.
 * Home and Chat are always there, on the
 * phone and the desktop, pills or not, so he jumps to Chat or back Home from any page. In the social skin /chat is the
 * selected project's Chat (the menu's Chat sits under the project's name). The dark grey pill is the unread
 * mark: desk replies since he last opened Chat (/counts, cleared by markChatSeen).
 */
export function TopBarPills({ counts }: { counts: CountsView | undefined }) {
  // only Inbox, Chat and the mic, at every width and in both skins (the owner, vn_87528e51); Home is the product mark,
  // every other page is in the sidebar (SidebarMorePages).
  const shows = useShows();
  // inside Epic Social the phone's Team pills are the selected project's, as the menu's Team pills.
  // the same lists and functions as the menu's Team pills and the Team home sections (lib/inbox), never /counts.
  const { keep } = useProject();
  const { data: statuses } = useStatusBatch();
  const blockedHere = useBlocked(statuses, { keep });
  const reviewCardsNow = useReviewCards({ keep }).cards;
  const split = splitDecisions(reviewCardsNow);
  const needsYou = statuses?.loading ? null : blockedHere.length + split.decisions.length;
  const review = reviewCardsNow && split.review.length;
  const unread = counts?.chat ?? 0;
  // the same desk Chat opens (pages/Chat ChatPage): the home world's Team desk, or the world's own desk in its skin.
  const world = useSharedQuery("sb:world", () => worldId());
  const link = ({ isActive }: { isActive: boolean }) =>
    cn("flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground max-[379px]:gap-1 max-[379px]:px-1.5 md:min-h-0", isActive && "bg-accent text-foreground");
  return (
    <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 max-[379px]:gap-0" data-testid="topbar-pills">
      {/* the full aggregated Inbox, one tap from any page, its red (waiting on you) and green (to review) counts on it. */}
      <NavLink to={`/${INBOX_PATH}`} state={INBOX_LAND} className={link} aria-label={`Inbox: ${needsYou ?? 0} waiting on you, ${review ?? 0} to review`} data-testid="topbar-team">
        <InboxIcon className="h-4 w-4" />
        <span className="hidden md:inline">Inbox</span>
        <Pills needsYou={needsYou} review={review} ids={{ needsYou: "topbar-needs-you", review: "topbar-review" }} className="ml-0" />
      </NavLink>
      {shows("chat") && (
        <NavLink to="/chat" className={link} aria-label={unread > 0 ? `Chat: ${unread} unread` : "Chat"} data-testid="topbar-chat">
          <MessageCircle className="h-4 w-4" />
          <span className="hidden md:inline">Chat</span>
          <Pills chat={counts?.chat} ids={{ chat: "topbar-unread" }} className="ml-0" />
        </NavLink>
      )}
      {/* the mic next to Chat: a voice note to the desk from any page, the page stays (voice/TopBarVoice). */}
      {/* the one rule every voice control uses for its desk (voice/deskBase), never a copy here. */}
      {shows("chat") && <TopBarVoice base={deskVoiceBase(world.data ?? knownWorld())} />}
    </span>
  );
}

type MorePage = { to: string; label: string; icon: typeof Home; testId: string };

/**
 * the sidebar's pages below the goal sets, in the owner's order: one-offs (jobs outside every goal set, from his voice
 * note to delivered), the outcome log (what every persona got done), every one-off page the team made (by repo, then
 * epic), his voice notes, the X stats of the team's accounts, the Gap finder while it is on (both skins). They left the top bar, which keeps Inbox, Chat and
 * the mic. The console skin's pages; the social skin shows none of them (its own sit with its campaigns).
 */
export function morePages(shows: (s: ScreenId) => boolean, socialSkin: boolean, gapFinderOn: boolean): MorePage[] {
  if (!shows("book")) return [];
  const gap: MorePage[] = gapFinderOn ? [{ to: `/${GAP_FINDER_PATH}`, label: "Gap finder", icon: Radar, testId: "nav-gap-finder" }] : [];
  if (socialSkin) return gap;
  return [
    // his 22 Nov note: "Outcomes ... remove it. Unless we're using this for persona outcomes": it is, so it says so.
    { to: `/${OUTCOMES_PATH}`, label: "Persona outcomes", icon: ListChecks, testId: "nav-outcomes" },
    { to: `/${PAGES_PATH}`, label: "Pages", icon: Files, testId: "nav-pages-list" },
    { to: `/${VOICE_NOTES_PATH}`, label: "Voice notes", icon: Mic, testId: "nav-voice-notes" },
    { to: `/${X_STATS_PATH}`, label: "Post stats", icon: BarChart3, testId: "nav-x-stats" },
    ...gap,
  ];
}

/**
 * the pages he pinned by name (docs/pages/registry.json `pinned`, `scripts/pages.py pin`), first under More pages,
 * one tap each: the link is the page's short address on the console (the console/scorecard), which opens the page.
 */
function SidebarPinnedPages({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useSharedQuery("sb:pinned", () => api.listPinnedPages());
  const pinned = data?.pinned ?? [];
  if (!pinned.length) return null;
  return (
    <>
      {pinned.map((p) => (
        <a key={p.url} href={p.slug ? `/${p.slug}` : p.url} target="_blank" rel="noreferrer" className={itemClass({ isActive: false })} onClick={onNavigate} data-testid="nav-pinned-page" title={p.title}>
          <Pin className="h-4 w-4" />
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
        </a>
      ))}
    </>
  );
}

function SidebarMorePages({ onNavigate, gapFinderOn }: { onNavigate?: () => void; gapFinderOn: boolean }) {
  const shows = useShows();
  const pages = morePages(shows, !!useSkin().campaigns, gapFinderOn);
  if (!pages.length) return null;
  return (
    <nav className="grid min-w-0 grid-cols-1 gap-0.5" aria-label="More pages" data-testid="sidebar-more-pages">
      <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">More pages</div>
      <SidebarPinnedPages onNavigate={onNavigate} />
      {pages.map((p) => (
        <NavLink key={p.to} to={p.to} className={itemClass} onClick={onNavigate} data-testid={p.testId}>
          <p.icon className="h-4 w-4" />
          {p.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** the pages that use the screen's width: the Pipeline (every campaign's, and a campaign's Pipeline tab). */
export const widePage = (path: string, search = "") => /\/pipeline\/?$/.test(path) || new URLSearchParams(search).get("tab") === "pipeline";
