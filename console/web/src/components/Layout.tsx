import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Activity, BarChart3, Building2, Presentation, ChevronDown, ChevronRight, Bot, GitFork, Home, LogOut, Mail, Menu, MessageCircle, MessagesSquare, Moon, Plug, Plus, Radar, Settings, Sun, Ticket } from "lucide-react";
import { api, apiMode, type CountsView, type Milestone, type MilestoneStatusView, type PendingItem, type WorldCounts } from "@/api";
import { useQuery } from "@/lib/data";
import { blockedItems, reviewCards, useBlocked, useReviewCards, useStatusBatch } from "@/lib/inbox";
import { useSnoozes } from "@/lib/snooze";
import { RECONNECTING_MESSAGE, isReconnecting, onReconnecting } from "@/api/real";
import { cn } from "@/lib/utils";
import { SidebarPursuits } from "@/components/pursuits";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { liveWorkers } from "@/components/status";
import { MILESTONE_PAGE, pageMilestones, progressLabel, splitBigRoots } from "@/lib/bigRoots";
import { LoadMore } from "@/components/loadMore";
import { milestoneState, statusOf } from "@/lib/status";
import { MilestoneDialog } from "@/components/dialogs";
import { milestoneName } from "@/lib/format";
import { focusHeading, useShows, useSkin, useWords } from "@/lib/skin";
import { BRAND_MARKS, BrandMark, brandOf, siblingOf } from "@/components/brand";
import { NEW_CAMPAIGN_PATH } from "@/pages/Campaigns";
import { GAP_FINDER_PATH } from "@/pages/GapFinder";
import { COMPANY_PATH } from "@/lib/company";
import { SETTINGS_PATH, useOperatorPages } from "@/lib/settingsPath";
import { useCompanyView } from "@/lib/companyView";
import { useGapFinder } from "@/lib/gapFinder";
import { reachSites, setupConnections } from "@/pages/Setup";
import { worldId } from "@/lib/useSocial";
import { repoLevelIds, useCampaigns } from "@/lib/campaign";
import { ALL_PROJECTS, useProject } from "@/lib/project";
import { PERFORMANCE_PATH, PRODUCT_PATH } from "@/pages/social/nav";
import { MESSAGES_PATH, useMessages } from "@/lib/messages";
import { CountPill, PILL_TITLES } from "@/components/homeSection";
import { AfterCloseNote } from "@/components/afterClose";
import { TopBarVoice } from "@/voice/TopBarVoice";
import { knownWorld } from "@/lib/useSocial";
import { deskVoiceBase } from "@/voice/deskBase";
import { homeWorld } from "@/lib/identity";

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
function useStoredFlag(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  return [
    v,
    (next: boolean) => {
      setV(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* storage off: the toggle still works for this page */
      }
    },
  ];
}

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

function BigRootLink({ m, status, counts, onNavigate }: { m: Milestone; status: MilestoneStatusView | undefined; counts?: { review?: number }; onNavigate?: () => void }) {
  const pr = progressLabel(status);
  const blockedHere = useBlocked(status);
  const needs = status?.loading ? 0 : blockedHere.length;
  return (
    <NavLink
      to={`/milestones/${m.id}`}
      className={(s) => cn(itemClass(s), "items-start")}
      onClick={onNavigate}
      title={`${milestoneName(m)} · ${m.repo} ${m.path}`}
      data-testid="big-root"
      data-milestone-id={m.id}
    >
      {/* the name, then one word, running, needs you or idle. */}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="line-clamp-2 min-w-0 break-words font-medium text-foreground">{milestoneName(m)}</span>
        <SidebarState live={liveWorkers(status)} needs={needs} loading={!!status?.loading} title={[`spine status: ${m.status ?? "unknown"}`, pr?.title].filter(Boolean).join(" · ")} />
      </span>
      {status?.loading && <CountLoading className="mt-0.5" />}
      <Pills needsYou={needs} review={counts?.review} milestoneId={m.id} ids={SIDEBAR_IDS} className="mt-0.5" />
    </NavLink>
  );
}

/** a milestone line shows red and green only, no unread. */
const SIDEBAR_IDS = { needsYou: "sidebar-needs-you", review: "sidebar-review" };
/** green per milestone: the review cards (lib/inbox reviewCards, the list the section shows) on that milestone. */
const reviewOf = (cards: { milestoneId?: string }[] | undefined, id: string) => (cards ?? []).filter((c) => c.milestoneId === id).length;

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { data: allMilestones } = useQuery(() => api.listMilestones(), []);
  // the social skin shows one project (repo) at a time: its milestones, its asks, its review cards.
  const project = useProject();
  // the social skin lists every project's campaigns, each under its project (byProject below); the console skin narrows.
  const byProject = !!useSkin().campaigns && project.projects.length > 1;
  const milestones = allMilestones && (project.current && !byProject ? allMilestones.filter((m) => project.keep(m.id)) : allMilestones);
  // the dots and the Team badge read the server's status batch (same object as the milestone header).
  // one shared fetch of the status batch and the review cards (lib/inbox): every pill here is the length of the
  // list its section shows, read at the same moment, with this browser's snoozes and presses applied.
  const { data: statuses } = useStatusBatch();
  const { entries: snoozing } = useSnoozes();
  const { cards: allCards } = useReviewCards();
  const [newOpen, setNewOpen] = useState(false);
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
  const openNeeds = statuses?.loading ? null : blockedHere.length;
  const teamReview = reviewCards(allCards, { keep: project.keep }).length;
  // the social skin lists campaigns and jobs, not a repo's own level (repoLevelIds).
  const { data: camps } = useCampaigns();
  const repoLevel = campaigns ? repoLevelIds(camps?.campaigns) : undefined;
  const { roots, rest } = splitBigRoots(repoLevel?.size ? milestones?.filter((m) => !repoLevel.has(m.id)) : milestones);
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
      {/* Messages (DMs) under Pipeline (social) or Chat (console), in a world with a social repo; its pill counts the chats that need the owner. */}
      {shows("messages") && <MessagesNav onNavigate={onNavigate} />}
    </>
  );
  const operatorPages = useOperatorPages();
  const rootLink = (m: Milestone) => <BigRootLink key={m.id} m={m} status={statusOf(statuses, m.id)} counts={{ review: reviewOf(allCards, m.id) }} onNavigate={onNavigate} />;

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto overflow-x-hidden p-3">
      <div className="flex items-center gap-2.5 px-2 pt-1" data-testid="brand">
        <BrandMark brand={brandOf(w.appName)} />
        {/* the name alone, centred on the mark. */}
        <span className="min-w-0 truncate font-brand text-lg font-semibold leading-none tracking-[-0.02em]" data-testid="brand-name">
          {w.appName}
        </span>
        {apiMode === "mock" && <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:text-amber-400">mock</span>}
      </div>

      {/* in the social skin projects are the
          headings of the campaign list below Home and Chat, no longer the first thing in the menu. */}
      {!byProject && <ProjectSwitcher statuses={statuses} cards={allCards} onNavigate={onNavigate} />}

      <nav className="grid min-w-0 grid-cols-1 gap-0.5" aria-label="Main" data-testid="nav-main">
        {/* in the
            social skin these pages sit under the project's name: every campaign of it together; each campaign's own
            Deck, Product, Waiting on me and Pipeline are its tabs. */}
        {campaigns && project.current && !byProject && (
          <div className="px-2.5 pb-1 text-xs font-medium text-muted-foreground" data-testid="nav-project-heading">
            {project.current.name}: all campaigns
          </div>
        )}
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
        <NavLink to="/" end className={itemClass} onClick={onNavigate}>
          <Home className="h-4 w-4" />
          {/* Home in the social product. */}
          {campaigns ? "Home" : w.team}
          {statuses?.loading && <CountLoading className="ml-auto" />}
          <Pills needsYou={openNeeds} review={teamReview} ids={{ needsYou: "waiting-count", review: "team-review-count" }} />
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
        {/* the Gap finder works across every project,
            so like Team and Chat it sits at the top level; its page lists its runs and says where it lives. */}
        {/* only while the Gap finder is switched on. */}
        {shows("book") && gapFinder?.on && (
          <NavLink to={`/${GAP_FINDER_PATH}`} className={itemClass} onClick={onNavigate} data-testid="nav-gap-finder">
            <Radar className="h-4 w-4" />
            Gap finder
          </NavLink>
        )}
      </nav>

      {/* his pursuits lead the projects: each its name, moving or stalled, and its green lines. */}
      {shows("book") && !campaigns && <SidebarPursuits onNavigate={onNavigate} />}

      <div className="grid min-w-0 grid-cols-1 gap-0.5" data-testid="sidebar-milestones">
        <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground" data-testid="sidebar-focus-heading">
          {roots.length ? focusHeading(w) : w.milestones}
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
            {othersOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Other {w.milestonesWord} ({rest.length})
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
        {restShows &&
          page.rest.map((m) => {
          const st = milestoneState(statusOf(statuses, m.id));
          return (
          <NavLink
            key={m.id}
            to={`/milestones/${m.id}`}
            className={(s) => cn(itemClass(s), "items-start")}
            onClick={onNavigate}
            title={!m.docTitle ? m.title : m.titleOverride ? `${m.title} (spine title: ${m.docTitle})` : `${m.docTitle} (console title: ${m.title})`}
          >
            <span className="grid min-w-0 flex-1">
              <span className="line-clamp-2 min-w-0 break-words">{milestoneName(m)}</span>
              <SidebarState
                live={liveWorkers(statusOf(statuses, m.id))}
                needs={statusOf(statuses, m.id)?.loading ? 0 : blockedItems(statusOf(statuses, m.id), { snoozing }).length}
                loading={!!statusOf(statuses, m.id)?.loading}
                title={`spine status: ${m.status ?? "unknown"} · ${st.word}`}
              />
            </span>
            {/* the inbox count (items the owner can act on now, the server status's needsYou), nothing at 0; open work stays on the Tree counts row. */}
            {statusOf(statuses, m.id)?.loading && <CountLoading className="mt-0.5" />}
            <Pills
              needsYou={statusOf(statuses, m.id)?.loading ? null : blockedItems(statusOf(statuses, m.id), { snoozing }).length}
              review={reviewOf(allCards, m.id)}
              milestoneId={m.id}
              ids={SIDEBAR_IDS}
              className="mt-0.5"
            />
          </NavLink>
          );
        })}
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
        {shows("spines") && (
          <NavLink to="/spines" className={itemClass} onClick={onNavigate}>
            <GitFork className="h-4 w-4" />
            {w.spines}
          </NavLink>
        )}
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
        {shows("threads") && (
          <NavLink to="/threads" className={itemClass} onClick={onNavigate}>
            <MessagesSquare className="h-4 w-4" />
            {w.threads}
          </NavLink>
        )}
        {shows("tickets") && (
          <NavLink to="/tickets" className={itemClass} onClick={onNavigate}>
            <Ticket className="h-4 w-4" />
            {w.tickets}
          </NavLink>
        )}
      </nav>

      {/* Settings, then its pages, small and indented under it. */}
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

      <AccountBlock />
      {/* the worlds come last, in the flow of the menu, seen when you scroll to them. */}
      <WorldSwitcher />

      <MilestoneDialog
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
      />
    </div>
  );
}

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
  const { data: me } = useQuery(() => (api.getMe ? api.getMe() : Promise.resolve(undefined)), []);
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
              World: {world}
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
type Cards = { id: string; milestoneId?: string }[] | undefined;

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
              <Pills needsYou={blockedItems(statuses, { keep: keepIn(p), snoozing }).length} review={reviewCards(cards, { keep: keepIn(p) }).length} ids={{ needsYou: `project-${p.repo}-needs-you`, review: `project-${p.repo}-review` }} />
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
                <Pills needsYou={blockedItems(statuses, { keep: keepIn(p), snoozing }).length} review={reviewCards(cards, { keep: keepIn(p) }).length} ids={{ needsYou: `project-${p.repo}-needs-you`, review: `project-${p.repo}-review` }} />
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
  const { data } = useQuery(() => (api.getWorldCounts ? api.getWorldCounts() : Promise.resolve(undefined)), [], { tag: "counts" });
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const worlds = data?.worlds ?? [];
  if (worlds.length < 2) return null;
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
      <div className="px-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Your worlds</div>
      <p className="px-2.5 pb-0.5 text-xs text-muted-foreground" data-testid="world-switcher-hint">
        Each world is a separate home with its own team.{hasProjects ? " Projects at the top switch inside this one." : ""}
      </p>
      <ul className="grid min-w-0 gap-0.5" aria-label="Your worlds">
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
      {err && (
        <p className="px-2.5 text-xs text-destructive" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** a world's mark in the switcher: its capitals (EpicTeam ET, the social product ES, the memory service Z), else its words' first letters. */
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
 * the "Open the social product / EpicTeam" link only for a login that uses both products (the owner: several worlds, or the
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

/** an EpicTeam sign-up's world before its plan is paid says so on every page, in one line. */
export function BillingNote() {
  const { data: me } = useQuery(() => (api.getMe ? api.getMe() : Promise.resolve(undefined)), []);
  if (me?.billing !== "awaiting_payment") return null;
  return (
    <div role="status" className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="billing-note">
      Welcome to EpicTeam. Your account is ready. Your team starts working once your plan is paid: €49 a month, payment opens here
      soon and we will write to you when it does.
    </div>
  );
}

/** "Open the social product" (or EpicTeam) with the sibling's mark, for a login that uses both products. */
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

export function Layout() {
  const w = useWords();
  // the tab title is the world's family name (EpicTeam / the social product).
  useEffect(() => {
    document.title = w.appName;
  }, [w.appName]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  // one read of the pills for the top bar and both sidebars.
  const { data: counts } = useQuery(() => api.getCounts(), [], { tag: "counts" });

  return (
    <CountsCtx.Provider value={{ counts }}>
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 overflow-hidden border-r bg-muted/30 pt-[env(safe-area-inset-top)] md:block">
        <SidebarNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* the top bar shows on every screen (desktop too, where the sidebar already carries the menu and the brand),
            so Home and Chat are one tap away from anywhere. */}
        {/* in the installed app the status bar is see-through: the bar pads under it (safe-area), so the clock sits on the
            bar's own background and nothing scrolls under it. */}
        <header className="sticky top-0 z-40 flex h-[calc(52px+env(safe-area-inset-top))] items-center gap-2 border-b bg-background px-3 pt-[env(safe-area-inset-top)] md:h-[calc(2.75rem+env(safe-area-inset-top))] md:px-4" data-testid="topbar">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" onClick={() => setMobileOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          {/* the product's mark and name, as in the sidebar. */}
          <span className="flex min-w-0 items-center gap-2 md:hidden" data-testid="topbar-brand">
            <BrandMark brand={brandOf(w.appName)} className="h-6 w-6" />
            <span className="truncate font-brand text-[17px] font-semibold tracking-[-0.02em]">{w.appName}</span>
          </span>
          <TopBarPills counts={counts} />
        </header>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent aria-describedby={undefined} className="overflow-hidden">
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
function TopBarPills({ counts }: { counts: CountsView | undefined }) {
  const words = useWords();
  // the social product's first entry is Home, in the top bar as in the menu.
  const w = useSkin().campaigns ? { ...words, team: "Home" } : words;
  const shows = useShows();
  // inside Epic Social the phone's Team pills are the selected project's, as the menu's Team pills.
  // the same lists and functions as the menu's Team pills and the Team home sections (lib/inbox), never /counts.
  const { keep } = useProject();
  const { data: statuses } = useStatusBatch();
  const blockedHere = useBlocked(statuses, { keep });
  const needsYou = statuses?.loading ? null : blockedHere.length;
  const review = useReviewCards({ keep }).cards?.length;
  const unread = counts?.chat ?? 0;
  // the same desk Chat opens (pages/Chat ChatPage): the home world's Team desk, or the world's own desk in its skin.
  const world = useQuery(() => worldId(), []);
  const link = ({ isActive }: { isActive: boolean }) =>
    cn("flex min-h-[40px] items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground md:min-h-0", isActive && "bg-accent text-foreground");
  return (
    <span className="ml-auto flex min-w-0 items-center gap-1" data-testid="topbar-pills">
      <NavLink to="/" end className={link} aria-label={`${w.team}: ${needsYou ?? 0} waiting on you, ${review ?? 0} to review`} data-testid="topbar-team">
        <Home className="h-4 w-4" />
        <span className="hidden md:inline">{w.team}</span>
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


/** the pages that use the screen's width: the Pipeline (every campaign's, and a campaign's Pipeline tab). */
export const widePage = (path: string, search = "") => /\/pipeline\/?$/.test(path) || new URLSearchParams(search).get("tab") === "pipeline";
