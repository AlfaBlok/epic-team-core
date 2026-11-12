import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { CallProvider, CallWidget } from "@/voice/CallProvider";
import { NoteProvider, NoteWidget } from "@/voice/NoteProvider";
import { NewBuild } from "@/components/NewBuild";
import { TeamPage } from "@/pages/Team";
import { SettingsPage } from "@/pages/Settings";
import { SETTINGS_PATH } from "@/lib/settingsPath";
import { MilestonePage } from "@/pages/Milestone";
import { PersonasPage } from "@/pages/Personas";
import { BrowserAuthPage } from "@/pages/BrowserAuth";
import { SeatsPage, ThreadsPage, TicketsPage } from "@/pages/Lists";
import { MilestoneNodePage, SpineViewPage } from "@/pages/Node";
import { SpinesPage } from "@/pages/Spines";
import { FEEDBACK_PATH, VoiceFeedbackPage } from "@/pages/VoiceFeedback";
import { TEAM_SKILLS_PATH, TeamSkillsPage } from "@/pages/TeamSkills";
import { RunsPage } from "@/pages/Runs";
import { ChatPage } from "@/pages/Chat";
import { ReportPage } from "@/pages/Report";
import { YOUR_TEAM_PATH, YourTeamPage } from "@/pages/YourTeam";
import { CalendarPage } from "@/pages/Calendar";
import { SetupPage } from "@/pages/Setup";
import { IDEAS_PATH, IdeasPage } from "@/pages/Ideas";
import { AllPipelinePage, PipelinePage } from "@/pages/social/Pipeline";
import { HistoryPage } from "@/pages/social/History";
import { DirectionsPage } from "@/pages/social/Directions";
import { ALL_PIPELINE_PATH, socialPath } from "@/pages/social/nav";
import { CAMPAIGNS_PATH, CampaignsPage, NEW_CAMPAIGN_PATH, NewCampaignPage } from "@/pages/Campaigns";
import { BRIEF_PATH, BriefPage } from "@/pages/Brief";
import { DigestPage } from "@/pages/Digest";
import { BOOK_PATH, BookPage } from "@/pages/Book";
import { MILESTONE_BOOK_PATH } from "@/pages/MilestoneBook";
import { BookIndexRedirect, BookToDeck } from "@/pages/BookRedirect";
import { DECK_ALL_PATH } from "@/lib/deck";
import { DECK_INDEX_PATH, DeckIndexPage, EPIC_DECK_PATH, EpicDeckPage } from "@/pages/EpicDeck";
import { BigRocksPage, ROCKS_PAGE_PATH } from "@/pages/BigRocks";
import { GOAL_GRAPH_PATH, GoalGraphPage, memoryPagePath } from "@/pages/GoalGraph";
import { GAP_FINDER_PATH, GapFinderPage } from "@/pages/GapFinder";
import { LAUNCH_PATH, LaunchBoardPage } from "@/components/launchBoard";
import { PURSUITS_PATH, PursuitsPage } from "@/components/pursuits";
import { Empty } from "@/components/common";
import { ErrorBoundary, PageBoundary } from "@/components/ErrorBoundary";
import { type ScreenId, type Skin, SkinProvider, skinFromFlag, useRoutes, useSkin, useWords } from "@/lib/skin";
import { ProjectProvider } from "@/lib/project";
import { CampaignRedirect } from "@/pages/social/CampaignRedirect";
import { PRODUCT_PATH, ProductPage } from "@/pages/social/Motion";
import { HOSTED_ROUTES, type ScreenRoute } from "@/lib/hostedPlug";

/** Routes of every screen; a screen the skin neither shows nor reaches has no route (plan §3: presentation only, its API still works). */
const CORE_ROUTES: ScreenRoute[] = [
  { screen: "milestones", path: "milestones/:id", element: <MilestonePage /> },
  { screen: "milestones", path: "milestones/:id/node/:nodeKey", element: <MilestoneNodePage /> },
  { screen: "chat", path: "chat", element: <ChatPage /> },
  // readiness, red lines and What you build, then every operator page (docs/design/console.md).
  { screen: "settings", path: SETTINGS_PATH, element: <SettingsPage /> },
  { screen: "spines", path: "spines", element: <SpinesPage /> },
  { screen: "spines", path: "spines/:repo/view", element: <SpineViewPage /> },
  { screen: "personas", path: "personas", element: <PersonasPage /> },
  { screen: "runs", path: "runs", element: <RunsPage /> },
  { screen: "threads", path: "threads", element: <ThreadsPage /> },
  { screen: "tickets", path: "tickets", element: <TicketsPage /> },
  { screen: "testers", path: FEEDBACK_PATH, element: <VoiceFeedbackPage /> },
  { screen: "teamSkills", path: TEAM_SKILLS_PATH, element: <TeamSkillsPage /> },
  { screen: "seats", path: "seats", element: <SeatsPage /> },
  { screen: "browserAuth", path: "auth", element: <BrowserAuthPage /> },
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
  { screen: "book", path: PURSUITS_PATH, element: <PursuitsPage /> },
  { screen: "book", path: `${GAP_FINDER_PATH}/:date`, element: <GapFinderPage /> },
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
      <Route element={<Layout />}>
        <Route index element={<PageBoundary><TeamPage /></PageBoundary>} />
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
