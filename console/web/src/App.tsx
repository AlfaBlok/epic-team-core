import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { CallProvider, CallWidget } from "@/voice/CallProvider";
import { NoteProvider, NoteWidget } from "@/voice/NoteProvider";
import { NewBuild } from "@/components/NewBuild";
import { InPlaceLinks } from "@/components/InPlaceLinks";
import { OurPage } from "@/components/OurPage";
import { OUR_PAGE_PATH } from "@/lib/inPlaceLinks";
import { DASHBOARD_PATH, SETTINGS_PATH } from "@/lib/settingsPath";
import { FEEDBACK_PATH, TEAM_SKILLS_PATH, YOUR_TEAM_PATH, IDEAS_PATH, CAMPAIGNS_PATH, NEW_CAMPAIGN_PATH, BRIEF_PATH, BOOK_PATH, MILESTONE_BOOK_PATH, DECK_INDEX_PATH, EPIC_DECK_PATH, ROCKS_PAGE_PATH, GOAL_GRAPH_PATH, memoryPagePath, GAP_FINDER_PATH, LAUNCH_PATH, PRIORITY_PATH, PAGES_PATH, ONE_OFFS_PATH, OUTCOMES_PATH, VOICE_NOTES_PATH, ON_DEVICE_PATH, X_STATS_PATH, COACH_PATH, BRIEFING_PATH, MARKETING_PATH, STRATEGY_PATH, MADE_OF_PATH } from "@/lib/routePaths";
import { BookIndexRedirect, BookToDeck } from "@/pages/BookRedirect";
import { DECK_ALL_PATH } from "@/lib/deck";
import { ALL_PIPELINE_PATH, PRODUCT_PATH, socialPath } from "@/pages/social/nav";
import { INBOX_PATH } from "@/components/inboxLine";
import { PURSUIT_KIT_PATH, PURSUIT_PATH, PURSUIT_TAB_PATH, PURSUITS_PATH, OldPursuitRoute, PursuitKitRedirect } from "@/lib/pursuitRoutes";
import { PRODUCT_DEF_PATH, PRODUCTS_PATH, SCORECARD_PATH, SCORECARDS_PATH } from "@/lib/scorecards";
import { OBJECTIVE_SEARCH_PATH } from "@/lib/objectiveSearch";
import { Empty } from "@/components/common";
import { ErrorBoundary, PageBoundary } from "@/components/ErrorBoundary";
import { type ScreenId, type Skin, SkinProvider, skinFromFlag, useRoutes, useSkin, useWords } from "@/lib/skin";
import { ProjectProvider } from "@/lib/project";
import { CampaignRedirect } from "@/pages/social/CampaignRedirect";
import { HOSTED_ROUTES, type ScreenRoute } from "@/lib/hostedPlug";
import { lazyPage } from "@/lib/lazyPage";
// in the first download, never fetched later: it must open with no connection.

// Home and the sidebar ship in the first download; every other screen is its own script, fetched the first
// time it opens (lib/lazyPage.tsx). A cold open was one 1.7 MB script (495 KB zipped) holding every screen.
// the notes kept on this device open with their page, not with the inbox
const OnDevicePage = lazyPage(() => import("@/voice/OnDevice"), "OnDevicePage");
const CoachPage = lazyPage(() => import("@/voice/Coach"), "CoachPage");
const BriefingPage = lazyPage(() => import("@/voice/Briefing"), "BriefingPage");
const MarketingPage = lazyPage(() => import("@/voice/Marketing"), "MarketingPage");
const StrategyPage = lazyPage(() => import("@/voice/Strategy"), "StrategyPage");
const CardInventoryPage = lazyPage(() => import("@/components/cardInventory"), "CardInventoryPage");
// Home too (its goals view and the goal-sets code under it): the Inbox opens without them.
const HomePage = lazyPage(() => import("@/components/homeView"), "HomePage");
// the Inbox is the Team page itself, never through Home's script (it holds the goals view and the goal-sets code)
const TeamPage = lazyPage(() => import("@/pages/Team"), "TeamPage");
function InboxPage() {
  return <TeamPage only="inbox" />;
}
const SettingsPage = lazyPage(() => import("@/pages/Settings"), "SettingsPage");
const DashboardPage = lazyPage(() => import("@/pages/Settings"), "DashboardPage");
const MilestonePage = lazyPage(() => import("@/pages/Milestone"), "MilestonePage");
const PersonasPage = lazyPage(() => import("@/pages/Personas"), "PersonasPage");
const BrowserAuthPage = lazyPage(() => import("@/pages/BrowserAuth"), "BrowserAuthPage");
const SocialsPage = lazyPage(() => import("@/pages/Socials"), "SocialsPage");
const SeatsPage = lazyPage(() => import("@/pages/Lists"), "SeatsPage");
const ThreadsPage = lazyPage(() => import("@/pages/Lists"), "ThreadsPage");
const TicketsPage = lazyPage(() => import("@/pages/Lists"), "TicketsPage");
const MilestoneNodePage = lazyPage(() => import("@/pages/Node"), "MilestoneNodePage");
const SpineViewPage = lazyPage(() => import("@/pages/Node"), "SpineViewPage");
const SpinesPage = lazyPage(() => import("@/pages/Spines"), "SpinesPage");
const VoiceFeedbackPage = lazyPage(() => import("@/pages/VoiceFeedback"), "VoiceFeedbackPage");
const TeamSkillsPage = lazyPage(() => import("@/pages/TeamSkills"), "TeamSkillsPage");
const RunsPage = lazyPage(() => import("@/pages/Runs"), "RunsPage");
const SearchPage = lazyPage(() => import("@/pages/Search"), "SearchPage");
const MadeOfPage = lazyPage(() => import("@/pages/MadeOf"), "MadeOfPage");
const PriorityModePage = lazyPage(() => import("@/components/priorityShortcut"), "PriorityModePage");
const ChatPage = lazyPage(() => import("@/pages/Chat"), "ChatPage");
const ReportPage = lazyPage(() => import("@/pages/Report"), "ReportPage");
const YourTeamPage = lazyPage(() => import("@/pages/YourTeam"), "YourTeamPage");
const CalendarPage = lazyPage(() => import("@/pages/Calendar"), "CalendarPage");
const SetupPage = lazyPage(() => import("@/pages/Setup"), "SetupPage");
const IdeasPage = lazyPage(() => import("@/pages/Ideas"), "IdeasPage");
const AllPipelinePage = lazyPage(() => import("@/pages/social/Pipeline"), "AllPipelinePage");
const PipelinePage = lazyPage(() => import("@/pages/social/Pipeline"), "PipelinePage");
const HistoryPage = lazyPage(() => import("@/pages/social/History"), "HistoryPage");
const DirectionsPage = lazyPage(() => import("@/pages/social/Directions"), "DirectionsPage");
const CampaignsPage = lazyPage(() => import("@/pages/Campaigns"), "CampaignsPage");
const NewCampaignPage = lazyPage(() => import("@/pages/Campaigns"), "NewCampaignPage");
const BriefPage = lazyPage(() => import("@/pages/Brief"), "BriefPage");
const DigestPage = lazyPage(() => import("@/pages/Digest"), "DigestPage");
const BookPage = lazyPage(() => import("@/pages/Book"), "BookPage");
const DeckIndexPage = lazyPage(() => import("@/pages/EpicDeck"), "DeckIndexPage");
const EpicDeckPage = lazyPage(() => import("@/pages/EpicDeck"), "EpicDeckPage");
const BigRocksPage = lazyPage(() => import("@/pages/BigRocks"), "BigRocksPage");
const GoalGraphPage = lazyPage(() => import("@/pages/GoalGraph"), "GoalGraphPage");
const GapFinderPage = lazyPage(() => import("@/pages/GapFinder"), "GapFinderPage");
const LaunchBoardPage = lazyPage(() => import("@/components/launchBoard"), "LaunchBoardPage");
const PursuitPage = lazyPage(() => import("@/components/pursuits"), "PursuitPage");
const PagesIndexPage = lazyPage(() => import("@/components/pagesIndex"), "PagesIndexPage");
const GoalSetPage = lazyPage(() => import("@/components/goalSets"), "GoalSetPage");
const GoalSetsPage = lazyPage(() => import("@/components/goalSets"), "GoalSetsPage");
const ProductsPage = lazyPage(() => import("@/components/products"), "ProductsPage");
const ProductDefPage = lazyPage(() => import("@/components/products"), "ProductPage");
const PursuitsListPage = lazyPage(() => import("@/components/pursuitsList"), "PursuitsListPage");
const OneOffsPage = lazyPage(() => import("@/components/oneOffs"), "OneOffsPage");
const OutcomesPage = lazyPage(() => import("@/components/outcomes"), "OutcomesPage");
const VoiceNotesPage = lazyPage(() => import("@/components/voiceNotesIndex"), "VoiceNotesPage");
const XStatsPage = lazyPage(() => import("@/components/xStats"), "XStatsPage");
const ProductPage = lazyPage(() => import("@/pages/social/Motion"), "ProductPage");

/** Routes of every screen; a screen the skin neither shows nor reaches has no route (plan §3: presentation only, its API still works). */
const CORE_ROUTES: ScreenRoute[] = [
  { screen: "milestones", path: "milestones/:id", element: <MilestonePage /> },
  { screen: "milestones", path: "milestones/:id/node/:nodeKey", element: <MilestoneNodePage /> },
  { screen: "chat", path: "chat", element: <ChatPage /> },
  // the voice notes kept on this device: waiting to send (Send now), and the last 5 sent, to play back.
  { screen: "chat", path: ON_DEVICE_PATH, element: <OnDevicePage /> },
  // the objectives coach: one call about his objectives and key results, his words relayed to a desk.
  { screen: "chat", path: COACH_PATH, element: <CoachPage /> },
  // the briefing call: the desk's news since his last briefing, then his notes, each one request on the Team desk.
  { screen: "chat", path: BRIEFING_PATH, element: <BriefingPage /> },
  // the senior marketing call: the social product's strategy, campaign by campaign, his words to the social desk.
  { screen: "chat", path: MARKETING_PATH, element: <MarketingPage /> },
  // the team product's strategy call: its launch strategy question by question, his words to the Team desk.
  { screen: "chat", path: STRATEGY_PATH, element: <StrategyPage /> },
  // readiness, red lines and What you build, then every operator page (docs/design/console.md).
  { screen: "settings", path: SETTINGS_PATH, element: <SettingsPage /> },
  // the read-only dashboard panels that left Settings (root L-80), one page in the menu's tools.
  { screen: "settings", path: DASHBOARD_PATH, element: <DashboardPage /> },
  { screen: "spines", path: "spines", element: <SpinesPage /> },
  { screen: "spines", path: "spines/:repo/view", element: <SpineViewPage /> },
  { screen: "personas", path: "personas", element: <PersonasPage /> },
  { screen: "runs", path: "runs", element: <RunsPage /> },
  { screen: "runs", path: PRIORITY_PATH, element: <PriorityModePage /> },
  { screen: "threads", path: "threads", element: <ThreadsPage /> },
  { screen: "tickets", path: "tickets", element: <TicketsPage /> },
  { screen: "testers", path: FEEDBACK_PATH, element: <VoiceFeedbackPage /> },
  { screen: "teamSkills", path: TEAM_SKILLS_PATH, element: <TeamSkillsPage /> },
  { screen: "seats", path: "seats", element: <SeatsPage /> },
  { screen: "browserAuth", path: "auth", element: <BrowserAuthPage /> },
  // Connect your socials (the customer's logins in their own Bitwarden, one helper invite), the vault step's own screen.
  { screen: "browserAuth", path: "socials", element: <SocialsPage /> },
  { screen: "report", path: "report", element: <ReportPage /> },
  { screen: "yourTeam", path: YOUR_TEAM_PATH, element: <YourTeamPage /> },
  { screen: "calendar", path: "calendar", element: <CalendarPage /> },
  { screen: "setup", path: "setup", element: <SetupPage /> },
  { screen: "ideas", path: IDEAS_PATH, element: <IdeasPage /> },
  // the social screens (social nav; the console skin reaches them from the repo's Spines card).
  { screen: "pipeline", path: socialPath("pipeline").slice(1), element: <PipelinePage /> },
  { screen: "history", path: socialPath("history").slice(1), element: <HistoryPage /> },
  { screen: "directions", path: socialPath("directions").slice(1), element: <DirectionsPage /> },
  // the product deck (data/product.md of the selected project), next to Performance in the menu.
  { screen: "performance", path: PRODUCT_PATH, element: <ProductPage /> },
  { screen: "campaigns", path: CAMPAIGNS_PATH, element: <CampaignsPage /> },
  { screen: "campaigns", path: NEW_CAMPAIGN_PATH, element: <NewCampaignPage /> },
  { screen: "brief", path: BRIEF_PATH, element: <BriefPage /> },
  { screen: "digest", path: "digest", element: <DigestPage /> },
  // the epic deck replaces the Epic Book; every old /book URL leads to a deck, and the old index
  // (every epic of every repo, the capabilities table) lives on as "Every epic" at /deck/all.
  { screen: "book", path: BOOK_PATH, element: <BookIndexRedirect /> },
  { screen: "book", path: MILESTONE_BOOK_PATH, element: <BookToDeck /> },
  { screen: "book", path: DECK_ALL_PATH, element: <BookPage /> },
  // the epic decks and the big rocks board (same screen, the home world only).
  { screen: "book", path: DECK_INDEX_PATH, element: <DeckIndexPage /> },
  { screen: "book", path: EPIC_DECK_PATH, element: <EpicDeckPage /> },
  { screen: "book", path: ROCKS_PAGE_PATH, element: <BigRocksPage /> },
  // the goal graph reports and his the memory service memory's branches (repo pages under /landing/), inside the console.
  { screen: "book", path: `${GOAL_GRAPH_PATH}/*`, element: <GoalGraphPage /> },
  { screen: "book", path: memoryPagePath(), element: <GoalGraphPage /> },
  // the Gap finder's runs (repo pages under /landing/gap-finder/), a main-menu entry, the home world only.
  { screen: "book", path: GAP_FINDER_PATH, element: <GapFinderPage /> },
  // the owner's pursuits: scorecard, totems, moving or stalled (docs/pursuits.json), opened from the sidebar.
  // (a skin without them, the social one, gets All objectives: OldPursuitRoute).
  { screen: "goalSets", path: PURSUITS_PATH, element: <OldPursuitRoute page={<PursuitsListPage />} /> },
  // one-offs: single jobs outside every pursuit, by stage from his voice note to delivered; beside Pursuits.
  { screen: "book", path: ONE_OFFS_PATH, element: <OneOffsPage /> },
  // the outcome log: one line per real outcome every persona logged at the end of a wake, filterable.
  { screen: "book", path: OUTCOMES_PATH, element: <OutcomesPage /> },
  // every one-off page the team made, by repo and epic (docs/pages/registry.json); each page links back here.
  { screen: "book", path: PAGES_PATH, element: <PagesIndexPage /> },
  // his voice notes in one place, a product filter, each with the rows made from it (docs/voice-notes/index.json).
  { screen: "book", path: VOICE_NOTES_PATH, element: <VoiceNotesPage /> },
  // the team's X accounts: likes, replies, reposts and views per post, one file a day (data/x-stats).
  { screen: "postStats", path: X_STATS_PATH, element: <XStatsPage /> },
  // each pursuit's own page: its scorecard and its social kit, under the same top bar.
  // in a skin without them (the social one) an old pursuit link opens its objective, /sets/<id>.
  { screen: "goalSets", path: PURSUIT_PATH, element: <OldPursuitRoute page={<PursuitPage />} /> },
  { screen: "goalSets", path: PURSUIT_TAB_PATH, element: <OldPursuitRoute page={<PursuitPage />} /> },
  { screen: "book", path: `${GAP_FINDER_PATH}/:date`, element: <GapFinderPage /> },
  // the goal sets: every set in one place with the combined inbox and the team desk, and each set's own page.
  { screen: "goalSets", path: SCORECARDS_PATH, element: <GoalSetsPage /> },
  { screen: "goalSets", path: SCORECARD_PATH, element: <GoalSetPage /> },
  // one search across his objectives, key results and tickets (the sidebar's Search).
  { screen: "goalSets", path: OBJECTIVE_SEARCH_PATH, element: <SearchPage /> },
  // what an objective (or a campaign) is made of: the class, its objects, one box per tab (his vn_cdef45cd).
  { screen: "goalSets", path: MADE_OF_PATH, element: <MadeOfPage /> },
  // the Products section: each product defined once (its deck and its kit), the objectives on it name it.
  { screen: "goalSets", path: PRODUCTS_PATH, element: <ProductsPage /> },
  { screen: "goalSets", path: PRODUCT_DEF_PATH, element: <ProductDefPage /> },
  // an old social kit link opens the set's Social kit tab in both skins.
  { screen: "goalSets", path: PURSUIT_KIT_PATH, element: <PursuitKitRedirect /> },
  // the launch board, every product (both skins; the home world only on the server).
  { screen: "team", path: LAUNCH_PATH, element: <LaunchBoardPage /> },
];

/** the core screens and those the hosted layer adds (lib/hostedPlug.ts: none in a build without src/hosted). */
const SCREEN_ROUTES: ScreenRoute[] = [...CORE_ROUTES, ...HOSTED_ROUTES];

/**
 * in a skin with campaigns (social) the old social screens lead to the campaign's tabs or their new place; the
 * console skin keeps reaching them as pages from a repo's Spines card. The wizard (/campaigns/new) stays a page.
 */
const CAMPAIGN_MOVES: Partial<Record<ScreenId, JSX.Element>> = {
  socialHome: <Navigate to="/" replace />,
  campaigns: <Navigate to="/" replace />,
  yourTeam: <Navigate to="/personas" replace />,
  pipeline: <CampaignRedirect tab="pipeline" />,
  calendar: <CampaignRedirect tab="pipeline" />,
  ideas: <CampaignRedirect tab="pipeline" />,
  topics: <CampaignRedirect tab="pipeline" />,
  directions: <CampaignRedirect tab="brief" />,
  brief: <CampaignRedirect tab="brief" />,
  history: <CampaignRedirect tab="history" />,
  digest: <CampaignRedirect tab="history" />,
  report: <CampaignRedirect tab="history" />,
};

export function AppRoutes() {
  const routes = useRoutes();
  const w = useWords();
  const campaigns = !!useSkin().campaigns;
  const element = (r: (typeof SCREEN_ROUTES)[number]) => (campaigns && r.path !== NEW_CAMPAIGN_PATH && CAMPAIGN_MOVES[r.screen]) || r.element;
  return (
    <ProjectProvider>
    <Routes>
      {/* E948-S60: every card type from samples, at 390 and 1280 px (no app frame, so the iframes show the card alone). */}
      <Route path="cards/inventory" element={<PageBoundary><CardInventoryPage /></PageBoundary>} />
      <Route element={<Layout />}>
        {/* Home is the goals view, the full Inbox its own page one tap away in the top bar (components/homeView). */}
        <Route index element={<PageBoundary><HomePage /></PageBoundary>} />
        <Route path={INBOX_PATH} element={<PageBoundary><InboxPage /></PageBoundary>} />
        {/* a page of ours the app does not draw, inside the installed app with Back (never a second copy of the app) */}
        <Route path={OUR_PAGE_PATH} element={<PageBoundary><OurPage /></PageBoundary>} />
        {campaigns && <Route path={ALL_PIPELINE_PATH} element={<PageBoundary><AllPipelinePage /></PageBoundary>} />}
        {SCREEN_ROUTES.filter((r) => routes(r.screen)).map((r) => (
          // a page that throws shows a clear state under the nav, never a blank screen
          <Route key={r.path} path={r.path} element={<PageBoundary>{element(r)}</PageBoundary>} />
        ))}
        <Route
          path="*"
          element={
            <Empty>
              Not found. <Link to="/" className="underline">Back to {w.team}</Link>
            </Empty>
          }
        />
      </Route>
    </Routes>
    </ProjectProvider>
  );
}

export function App({ skin = skinFromFlag() }: { skin?: Skin }) {
  return (
    // the last line of defence: an error outside a page (nav, call widget) shows a clear state, never the bare background
    <ErrorBoundary scope="app">
      <SkinProvider skin={skin}>
        {/* calls are the tab's, above the router: a page change never ends or orphans one; the widget floats it. */}
        <CallProvider>
          {/* voice notes too: leaving Chat keeps recording, the pill floats Send and Cancel on every page. */}
          <NoteProvider>
            <BrowserRouter>
              <AppRoutes />
              {/* the installed app: a link that would open a new window opens in place, so Back returns to the card. */}
              <InPlaceLinks />
              <CallWidget />
              <NoteWidget />
              {/* an open page (the installed app) picks up a new deploy: reloads when safe, else a Reload bar. */}
              <NewBuild />
            </BrowserRouter>
          </NoteProvider>
        </CallProvider>
      </SkinProvider>
    </ErrorBoundary>
  );
}
