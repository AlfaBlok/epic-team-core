import type { ClosedGoal, ReviewGoal, ReviewItem, ClosedCard, ClosedCardRef } from "./review-types";
import type { Company, CompanyBuild, CompanyInput, CompanySaved, CompanyOps, CompanyPromo, WheelId, WheelNote, WorldInbox, Experiment, Goal } from "./company-types";
import type { BuildingList } from "./building-types";
import type { PersonaGapsBody, ProductView, ProductsBody, PursuitKitBody, PursuitsBody, ScorecardsBody } from "./pursuit-types";
import type { OneOffsBody } from "./oneoff-types";
import type { TotemMaps, TotemView } from "./totem-types";
import type { OutcomeFilter, OutcomesBody } from "./outcome-types";
import type { AdvisorVerdictBody, TeamCard, TeamCardAnswer, TeamCardKind, TeamCardsBody } from "./teamcard-types";
import type { AskLogSummary, PagesBody, PageView, PinnedStatus, VoiceNotesBody, XStatsBody } from "./pages-types";
import type {
  BookView,
  RunStatsView,
  ActiveAgentsSeries,
  RunHostRange,
  RunHostsSeries,
  CountsView,
  ChatSeenTarget,
  MilestoneBookView,
  Arc,
  BigRocksView,
  EpicDeckView,
  DecksView,
  DeckCard,
  SocialData,
  SocialMetrics,
  SocialKpisBody,
  SiteKpisBody,
  MotionBody,
  PostHistory,
  SocialDigestView,
  SocialWriteAction,
  SocialWriteResult,
  SocialAssetUpload,
  Credits,
  PlanState,
  CreditGrantInput,
  CreditGrantResult,
  Tenant,
  Assignment,
  AuthSite,
  AuthReach,
  EgressStatus,
  SignedInCheck,
  PersonaTemplate,
  AuthSync,
  BootstrapInput,
  BootstrapResult,
  CycleInfo,
  AssignmentInput,
  Milestone,
  MilestoneInput,
  MilestoneTree,
  MilestoneStatusView,
  MarkInput,
  MarkResult,
  NextWakeItem,
  MovingEpic,
  StampResult,
  StopResult,
  PriorityModeView,
  AddInput,
  AddResult,
  AskedNoRowItem,
  OrphanCommitItem,
  LaunchBoardBody,
  TicketSession,
  StampTo,
  StatusBatch,
  NeedsOwner,
  NodeTree,
  SpineListing,
  SpineRef,
  NeedsOwnerStatus,
  Persona,
  Repo,
  RepoDoc,
  PersonaInput,
  Run,
  RunCommit,
  RunInput,
  Seat,
  Me,
  HostsView,
  TeamService,
  TeamServicesView,
  StepKeyPaste,
  TeamLoginsView,
  MemoryCard,
  ConnectCard,
  MemoryNoteFilter,
  TeamSkillsView,
  WhatsAppHolderView,
  TeamSkillPreview,
  TeamSkillAddResult,
  TeamSkillRemoveResult,
  TeamMailView,
  ServiceCapability,
  AddTeamServiceInput,
  TestersView,
  FeedbackLink,
  FeedbackView,
  TesterPayment,
  TesterWorldResult,
  ApprovalsView,
  GrantInput,
  GrantWriteResult,
  HostWake,
  Thread,
  Ticket,
  UsageGroupBy,
  UsageTotals,
  UnblockerStats,
  UnblockerStatsWindow,
  MilestoneFreshness,
  RefreshResult,
  FreshnessSummary,
  ChatRead,
  DeskChat,
  ChatAttachment,
  ChatHistory,
  MessagesView, OnePager, OnePagerKey, CampaignTotems, ProductNote, WorldCounts, Onboarding } from "./types";
import type { CampaignInput, CampaignList, CampaignPlan, CampaignRepo, CampaignResult, JobInput, JobResult, NamedCampaignInput, NamedCampaignResult, CampaignTemplate, MarketingPlan, MarketingPlanWrite } from "./campaign-types";
import type { AskRelay, ConsoleMessage, OwnerActivity, OwnerResponse, LaptopFor, LaptopSession, LaptopView, RedLine, SaveKeyResult, SnoozeDays, SnoozeHours, StepTickInput, WaitingItem, InboxSearchResult, SpokenRead } from "./inbox-types";

/** GET /api/push. */
/**
 * a paid EpicTeam workspace's one first objective, Get set up, and its key results with their lights,
 * shown on its Home above its chat.
 */
export interface FirstObjective {
  milestoneId: string;
  name: string;
  /** what the owner typed at checkout, the first thing to make a project of */
  words?: string;
  keyResults: { id: string; name: string; target: string; green: boolean; state: "green" | "amber" | "red"; note?: string; by?: "measured" | "ticked" }[];
  green: number;
  total: number;
  /** when the server read it (the lights are measured on each read) */
  measuredAt?: string;
}

export interface PushInfo {
  configured: boolean;
  publicKey?: string;
  devices: number;
  endpoints: string[];
  /** Only the owner's own world's logins get the team's notifications. */
  notifies: boolean;
}

export interface ApiClient {
  /** Settled milestones are hidden unless includeSettled. */
  listMilestones(opts?: { includeSettled?: boolean }): Promise<Milestone[]>;
  /** console-only settle / unsettle; never changes the status or the spine. */
  settleMilestone(id: string): Promise<Milestone>;
  unsettleMilestone(id: string): Promise<Milestone>;
  getMilestone(id: string): Promise<Milestone>;
  createMilestone(input: MilestoneInput): Promise<Milestone>;
  updateMilestone(id: string, patch: Partial<MilestoneInput>): Promise<Milestone>;
  deleteMilestone(id: string): Promise<void>;
  /** Creates a milestone with an empty path; an agent in the repo writes the file and sets the path. */
  bootstrapMilestone(input: BootstrapInput): Promise<BootstrapResult>;

  listPersonas(): Promise<Persona[]>;
  /** the generic templates the New persona dialog starts from. */
  listPersonaTemplates(): Promise<PersonaTemplate[]>;
  createPersona(input: PersonaInput): Promise<Persona>;
  updatePersona(id: string, patch: Partial<PersonaInput>): Promise<Persona>;
  deletePersona(id: string): Promise<void>;

  listAssignments(): Promise<Assignment[]>;
  createAssignment(input: AssignmentInput): Promise<Assignment>;
  updateAssignment(id: string, patch: Partial<AssignmentInput>): Promise<Assignment>;
  deleteAssignment(id: string): Promise<void>;
  /** `note` = one-off instructions for this wake only (omitted when empty). */
  /** `clientRequestId` makes a repeat of the same request return the same run (no second wake, no 409). */
  runAssignmentNow(id: string, note?: string, clientRequestId?: string): Promise<Run>;
  /** post a message into the running persona's T3 thread (steer; queued if the turn is not steerable). */
  steerAssignment(id: string, message: string, clientRequestId?: string): Promise<{ run: Run; threadId: string; mode: "steer" | "auto" }>;

  /** steer any running run by its id (a persona wake or a child worker): message into that run's own thread. */
  steerRun(runId: string, message: string, clientRequestId?: string): Promise<{ run: Run; threadId: string; mode: "steer" | "auto" }>;
  /** interrupt a running run now and close it `stopped` with the reason; `withWorkers` also stops its running child runs. */
  stopRun(runId: string, input: { reason: string; withWorkers?: boolean }): Promise<StopResult>;
  /** Priority mode: its state, start it for one or two rows (parks every other running session), resume. */
  getPriorityMode(): Promise<PriorityModeView>;
  startPriorityMode(input: { rows: string[]; reason?: string }): Promise<PriorityModeView>;
  resumePriorityMode(why?: string): Promise<PriorityModeView>;
  /** Add on a tree node: a ledger row, Done-means line or child epic, written to the spine (commit + push); ready unless `draft`. */
  addToTree(milestoneId: string, input: AddInput): Promise<AddResult>;
  /** open Done-means lines in runnable epics no ledger row covers ("Asked, no row yet" on the Team home). */
  /** `limit` = the first n lines (Show 20 / 50 / all); `total` = how many there are. */
  listAskedNoRow(limit?: number): Promise<{ items: AskedNoRowItem[]; total?: number }>;
  listOrphanCommits(limit?: number): Promise<{ items: OrphanCommitItem[]; total?: number }>;
  /** the launch board (every product, or one by id: epicteam, social, memory, epicspine); the home world only. */
  getLaunchBoard(product?: string): Promise<LaunchBoardBody>;
  /** the Company view's companies and their wheels (docs/companies.json of the code repo); the home world only. */
  listCompanies(): Promise<{ companies: Company[] }>;
  /** add a company (its id comes from the name); one commit to docs/companies.json of the code repo. the owner only. */
  addCompany(input: CompanyInput): Promise<CompanySaved>;
  /** change a company's name, line and the repos and spines that feed each wheel; one commit. the owner only. */
  setCompany(id: string, input: CompanyInput): Promise<CompanySaved>;
  /** the open asks and cards of the social product worlds the login belongs to, read only (each opens in its own app). */
  listCompanyWorlds(): Promise<{ worlds: WorldInbox[] }>;
  /** the home repo's live experiments (headline, key results now against goal), read only. */
  listExperiments?(): Promise<{ experiments: Experiment[] }>;
  /** the home repo's goals (docs/goals/*.json): the goal, its key results, a traffic light each, read only. */
  listGoals?(): Promise<{ goals: Goal[] }>;
  /** the Operations wheel's numbers of one company (uptime, down minutes, visits, conversions; support, spend, revenue), read live. */
  getCompanyOps(id: string): Promise<CompanyOps>;
  /** the Build wheel's numbers from the ledgers of one company. */
  getCompanyBuild(id: string): Promise<CompanyBuild>;
  /** the open notes of every wheel (docs/company-notes.jsonl of the code repo). */
  listWheelNotes(): Promise<{ notes: WheelNote[]; handled: number }>;
  /** a typed note for a wheel, posted to its project's desk (or the Team desk) and kept in its inbox; `clientId` makes a resend land once. */
  dropWheelNote(company: string, wheel: WheelId, input: { text: string; clientId: string; milestoneId?: string }): Promise<{ note: WheelNote; again?: boolean }>;
  /** the note leaves the wheel's inbox. */
  markWheelNoteHandled(id: string): Promise<{ note: WheelNote }>;
  /** the Promo wheel's weekly numbers of one company (followers, posts out of planned, clicks), read live. */
  getCompanyPromo(id: string): Promise<CompanyPromo>;
  /** what the owner builds (docs/building.json of the code repo), campaigns and counts read from the spines; the home world only. */
  listBuilding(): Promise<{ lists: BuildingList[] }>;
  /** the owner's pursuits: scorecard, totems, moving or stalled (docs/pursuits.json). */
  listPursuits(): Promise<PursuitsBody>;
  /** the goal sets: the scorecard tree (pursuits, their epics inside), each spine's queue and codes. */
  listScorecards(): Promise<ScorecardsBody>;
  /** every milestone and objective with no Delivery Manager turning it . */
  personaGaps(): Promise<PersonaGapsBody>;
  /** his order of the pursuits (every id once); one commit in docs/pursuits.json. */
  reorderPursuits(ids: string[]): Promise<{ ok: true; sha?: string }>;
  /** park or resume one pursuit (parked: no wakes, no workers); one commit. */
  parkPursuit(id: string, parked: boolean): Promise<{ ok: true; sha?: string }>;
  /** single jobs outside every pursuit, by stage (rows titled `One-off:` and docs/spines/one-offs.md). */
  listOneOffs(): Promise<OneOffsBody>;
  /** the outcome log: one line per real outcome every persona logged at the end of a wake, filtered. */
  listOutcomes(f?: OutcomeFilter): Promise<OutcomesBody>;
  /** the team's own inbox cards: a digest per scorecard a day, strategic ideas, goal conversations (docs/inbox/cards.json). */
  listTeamCards(q?: { scorecard?: string; kind?: TeamCardKind }): Promise<TeamCardsBody>;
  /** his answer on one of them (words, voice, a picked goal); one commit. */
  answerTeamCard(id: string, a: TeamCardAnswer): Promise<{ ok: true; card: TeamCard; sha?: string }>;
  /** his verdict on the Senior advisor's suggestions: accept writes a ready row on each one's spine first. */
  advisorVerdict(id: string, v: AdvisorVerdictBody): Promise<{ ok: true; card: TeamCard; rows?: Record<string, string>; failed?: { item: string; reason: string }[]; sha?: string }>;
  /** every one-off page the team serves, by repo and epic (docs/pages/registry.json). */
  listPages(): Promise<PagesBody>;
  /** when a pinned page last refreshed, and its Refresh button. */
  listPinnedPages(): Promise<{ pinned: PageView[] }>;
  pinnedPageStatus(port: number): Promise<PinnedStatus>;
  refreshPinnedPage(port: number): Promise<PinnedStatus>;
  /** pin, rename or unpin a page by a plain name (one commit to docs/pages/registry.json). */
  pinPage(b: { port?: number; url?: string; pinned: boolean; name?: string }): Promise<{ ok: true; sha?: string }>;
  /** the asks log: asks to the owner this week and by week (docs/asks/log.jsonl). */
  askLogSummary(): Promise<AskLogSummary>;
  /** his one tap on a closed ask: was it clear or confusing. */
  askVerdict(id: string, verdict: "clear" | "confusing"): Promise<{ status?: number; added?: number }>;
  /** his voice notes of the last two days with the rows made from each (docs/voice-notes/index.json); product filters. */
  listVoiceNotes(product?: string): Promise<VoiceNotesBody>;
  /** the team's X accounts: per post likes, replies, reposts and views, one file a day (data/x-stats). */
  getXStats(date?: string): Promise<XStatsBody>;
  /** one pursuit's social kit, shown inside the console on the pursuit's page. */
  getPursuitKit(id: string): Promise<PursuitKitBody>;
  /** the Products section: each product defined once, its deck's parts, its kit and the objectives naming it. */
  listProducts(): Promise<ProductsBody>;
  getProduct(id: string): Promise<ProductView>;
  getProductKit(id: string): Promise<PursuitKitBody>;
  /** the milestone's live ticket sessions from before (no new ones are launched; a row that closed meanwhile is left out). */
  listTicketSessions(milestoneId: string): Promise<TicketSession[]>;
  /** the Team desk chat (user + assistant text read back from its T3 thread; launches the thread on first open). */
  /** `read` = the newest `limit` messages, or (with `before`) only `messages` + `hasEarlier` of the older page. */
  getDeskChat(read?: ChatRead): Promise<DeskChat>;
  /** send the owner's message to the desk; `page` = the page he is looking at (a hint for the desk). `pending` = T3 is still accepting it. */
  /** `attachments` = ids from uploadChatAttachment; the console adds their links to the message. */
  sendDeskMessage(text: string, page?: string, clientRequestId?: string, attachments?: string[]): Promise<{ threadId: string; pending: boolean; queued?: boolean }>;
  /** one file for a chat message (a screenshot from the phone), uploaded before the message is sent. */
  /** `onProgress(sent, total)` as the bytes leave the phone (the bubble shows how far a slow upload is). */
  uploadChatAttachment(file: Blob, name: string, onProgress?: (sent: number, total: number) => void): Promise<{ attachment: ChatAttachment }>;
  /** the line of links of uploaded files, for a box whose own route takes only words (it goes after his words). */
  attachmentLine(ids: string[]): Promise<{ line: string }>;
  /** E948-S127: what his words on a card answer, for each of its asks (read only; the card presses each answer). */
  readSpokenAnswers(words: string, asks: { id: string; code?: string; line: string }[]): Promise<{ reads: SpokenRead[]; judgeError?: string }>;
  /** a milestone's Chat tab, a view on its own repo-desk T3 thread (launched on first open, reused across restarts). */
  getMilestoneChat(milestoneId: string, read?: ChatRead): Promise<DeskChat>;
  /** a world's team desk (the social skin's top-level Chat), one thread across its campaigns: same shape as the Team desk. */
  getWorldDeskChat(tenantId: string, read?: ChatRead): Promise<DeskChat>;
  sendWorldDeskMessage(tenantId: string, text: string, page?: string, clientRequestId?: string, attachments?: string[]): Promise<{ threadId: string; pending: boolean }>;
  /** a paid EpicTeam workspace's one first objective, Get set up, with its key results; 404 no_first_objective elsewhere. */
  getFirstObjective(tenantId: string): Promise<FirstObjective>;
  /** send the owner's message to the milestone's repo desk. */
  sendMilestoneChatMessage(milestoneId: string, text: string, page?: string, clientRequestId?: string, attachments?: string[]): Promise<{ threadId: string; pending: boolean; queued?: boolean }>;

  /**
   * Newest first, 500 rows; with `since` every run started at or after it, no cap. `milestoneId`
   * keeps one milestone's runs (the node and milestone pages: all runs were ~900 KB).
   */
  listRuns(q?: { since?: string; milestoneId?: string }): Promise<Run[]>;
  /** the newest `top` wakes (all when absent) with their child runs, and how many wakes there are. */
  listRunsTop(q: { top?: number; milestoneId?: string }): Promise<{ runs: Run[]; total: number }>;
  /** the Team home's wake numbers per milestone and per persona, from the newest 500 runs (as listRuns). */
  /** `milestones` (the selected project's) narrows the footer's wakes24h to their runs. */
  getRunStats(milestones?: string[]): Promise<RunStatsView>;
  /** the Active agents series of one day (YYYY-MM-DD) in a timezone. */
  getActiveAgents(q: { day?: string; tz: string; bucket?: number }): Promise<ActiveAgentsSeries>;
  /** runs live at each moment of the last 24 h / 7 d, stacked by host. */
  getRunHosts(q: { range: RunHostRange }): Promise<RunHostsSeries>;
  /** the pills (Team red + green, Chat unread, each sidebar milestone) in one small answer. */
  getCounts(): Promise<CountsView>;
  /** the owner opened this chat: its unread goes to 0. */
  markChatSeen(target: ChatSeenTarget): Promise<{ key: string; seenAt: string; unread: number }>;
  /** phone notifications: the console's key and this login's devices. */
  getPush(): Promise<PushInfo>;
  subscribePush(subscription: PushSubscriptionJSON, device?: string): Promise<{ ok: boolean }>;
  unsubscribePush(endpoint: string): Promise<{ ok: boolean; removed: boolean }>;
  /** A test notification to this device only. */
  testPush(endpoint?: string): Promise<{ ok: boolean; sent: number; error?: string }>;
  /** token totals of ended runs started in [from, to) (default: the last 24 h), grouped. */
  getUsage(q: { from?: string; to?: string; groupBy: UsageGroupBy }): Promise<UsageTotals>;
  /** the Unblocker's numbers per milestone for a window (24 h, 7 d, all). */
  getUnblockerStats(q: { window: UnblockerStatsWindow; milestoneId?: string }): Promise<UnblockerStats>;
  getCycle(): Promise<CycleInfo>;
  createRun(input: RunInput): Promise<Run>;

  listNeedsOwner(): Promise<NeedsOwner[]>;
  updateNeedsOwner(id: string, status: NeedsOwnerStatus): Promise<NeedsOwner>;
  /** retire an item replaced by a coded ask (`by` = `<repo>/<code>`) or moot. Not an answer: nothing is sent. */
  supersedeNeedsOwner(id: string, by?: string): Promise<NeedsOwner>;

  /** everything blocked on the owner (all milestones, or one milestone's subtree from nodeKey down). */
  listWaitingOnOwner(f?: { milestoneId?: string; nodeKey?: string; includeSettled?: boolean; includeSuperseded?: boolean } & Partial<SpineRef>): Promise<WaitingItem[]>;
  /** one item whole (the card behind a folded Answered row, fetched when it opens). */
  getWaitingItem?(id: string, milestoneId?: string): Promise<WaitingItem>;
  /** the search box on top of the Inbox: which items match every word (titles, card text, his notes). */
  searchInbox?(q: string): Promise<InboxSearchResult>;
  /** grantWrite: approve a Needs the owner item and give the asking run's assignment write, limited to scope. */
  respondToWaiting(
    itemId: string,
    /** `attachments` = ids from uploadChatAttachment; the console adds their links after the words. */
    input: { kind: OwnerResponse["kind"]; text?: string; milestoneId?: string; grantWrite?: { scope: string }; wake?: boolean; clientKey?: string; relay?: AskRelay; attachments?: string[]; asRow?: boolean },
  ): Promise<OwnerResponse>;
  redeliverResponse(responseId: string): Promise<OwnerResponse>;
  /** snooze an open ask for `days` (3 / 7 / 30) or until a date; `until: null` unsnoozes. The date is written on its spine line. */
  snoozeWaiting(itemId: string, input: { hours?: SnoozeHours; days?: SnoozeDays; until?: string | null; milestoneId?: string; relay?: AskRelay; park?: true }): Promise<{ id: string; snoozedUntil: string | null }>;
  /** paste a key into a key ask; the server stores it with `secret put` (the value is never returned or kept). */
  saveKey(itemId: string, input: { value: string; milestoneId?: string; wake?: boolean; relay?: AskRelay }): Promise<SaveKeyResult>;
  /** change an answer before the owner acts on it (rewrites the spine line, or sends a correction to the thread). */
  changeResponse(responseId: string, input: { kind: OwnerResponse["kind"]; text?: string; wake?: boolean; attachments?: string[] }): Promise<OwnerResponse>;
  /** message a persona (assignment) in its home thread. */
  sendMessage(input: { milestoneId: string; assignmentId: string; text: string; refItemId?: string }): Promise<ConsoleMessage>;
  /** "Ask owner to write asks" for one spine's guessed items (fixed request to the owner, logged in Activity). */
  /** `to: "delivery-manager"` = the Pending selector's Rewrite as a coded ask. */
  requestAsks(input: { milestoneId: string; path: string; to?: "delivery-manager" }): Promise<ConsoleMessage>;
  listOwnerActivity(milestoneId?: string): Promise<OwnerActivity[]>;

  /** the server's status of one milestone (outcome, flow, pending items). */
  getMilestoneStatus(milestoneId: string): Promise<MilestoneStatusView>;
  /** the owner marks the outcome (writes the spine's ## Outcome; Settle opens once it is marked). */
  markMilestone(milestoneId: string, input: MarkInput): Promise<MarkResult>;
  /** the owner stamps a Planning epic ready for delivery (`ready`) or moves it back (`draft`); path = a child epic in its tree. */
  stampMilestone(milestoneId: string, input: { to: StampTo; path?: string }): Promise<StampResult>;
  /** what the next standing wake starts (all milestones, or one). */
  nextWake(milestoneId?: string): Promise<{ items: NextWakeItem[]; at: string }>;
  /** per epic, workers running · last commit · rows done today (Team page "Moving now"). */
  /** `limit` = the first n lines (workers first, then most recent commit; each spine once); `total` = all lines. */
  movingNow(limit?: number): Promise<{ epics: MovingEpic[]; total?: number; at: string }>;
  /** every unsettled milestone's status in one batch (sidebar, Team home, Team badge). */
  listStatus(): Promise<StatusBatch>;

  /** Backlog behind a milestone: ledger/phases rows + Ticket root files (all statuses). */
  getBacklog(milestoneId: string): Promise<Ticket[]>;
  /** epic tree: spine → child spines → ledger tickets → linked ticket files, colored by status. */
  getTree(milestoneId: string): Promise<MilestoneTree>;
  /** node view: the milestone's tree re-rooted at nodeKey (own counts), plus repo and tracked spine paths. */
  getNodeTree(milestoneId: string, nodeKey?: string): Promise<NodeTree>;
  /** ad hoc: any spine's tree (untracked), optionally re-rooted at nodeKey. */
  getSpineTree(ref: SpineRef & { nodeKey?: string }): Promise<NodeTree>;
  /** Spines page: a repo's spines from spines.py (server cache; `refreshing` = read again soon). */
  listRepoSpines(repoName: string): Promise<SpineListing>;
  /** how fresh this milestone's checkout is vs GitHub (sha, synced age, behind, error), and its Current State age. */
  getFreshness(milestoneId: string): Promise<MilestoneFreshness>;
  /** Refresh: fetch + ff-only pull + spines cache drop for the milestone's repo (once per 5 s per repo). */
  refreshMilestone(milestoneId: string): Promise<RefreshResult>;
  /** Team footer: freshness of every repo with an unsettled milestone (no pulls). */
  getFreshnessSummary(): Promise<FreshnessSummary>;
  /** spine commits made during each run, keyed by run id (runs without commits are absent). */
  getRunCommits(milestoneId: string): Promise<Record<string, RunCommit[]>>;

  /** Pickers for the New-milestone dialog. */
  listRepos(): Promise<Repo[]>;
  listRepoDocs(repoName: string): Promise<RepoDoc[]>;

  listThreads(): Promise<Thread[]>;
  listTickets(): Promise<Ticket[]>;
  /** the first `limit` tickets (all when absent) and how many there are. */
  listTicketsTop(limit?: number): Promise<{ tickets: Ticket[]; total: number }>;
  listSeats(): Promise<Seat[]>;
  /** status of the main server/the worker server (server-cached ~15 s; never starts the worker server). */
  getHosts(): Promise<HostsView>;
  /** the team services (the memory service, Gmail), their status and which personas may use each; refresh re-probes. */
  listTeamServices(refresh?: boolean, world?: string): Promise<TeamServicesView>;
  /** rework: the world's owner adds a service (a remote MCP server by URL, or an email account). */
  addTeamService(input: AddTeamServiceInput, world?: string): Promise<{ service: TeamService }>;
  /** rework: remove an added service and its secrets from the store. */
  removeTeamService(id: string, world?: string): Promise<{ removed: string; secretsRemoved: string[] }>;
  /** rework: paste a service's secret (stored with `secret put`; the answer never carries it). */
  setServiceSecret(id: string, field: string, value: string, world?: string): Promise<{ service: TeamService }>;
  /** rework: remove a service's secret from the store. */
  removeServiceSecret(id: string, field: string, world?: string): Promise<{ service: TeamService }>;
  /** rework: test the connection now (connected / error). */
  testTeamService(id: string, world?: string): Promise<TeamService>;
  /** the team skills library (use_when, pinned source, who uses each) and persona skills it lacks. */
  listTeamSkills(): Promise<TeamSkillsView>;
  /** what adding this GitHub URL would pin (name, description, commit); writes nothing. the owner only. */
  previewTeamSkill(input: { url: string; name?: string; useWhen?: string }): Promise<TeamSkillPreview>;
  /** add it (commit = the previewed one; a moved repo is refused): commits the manifest on main, pushes, syncs. the owner only. */
  addTeamSkill(input: { url: string; name?: string; useWhen?: string; commit?: string }): Promise<TeamSkillAddResult>;
  /** remove it; while personas attach it the server refuses (409 in_use) unless confirm, which also takes it off them. */
  removeTeamSkill(name: string, confirm?: boolean): Promise<TeamSkillRemoveResult>;
  /** every the social product tester signup, newest first (the home world only). */
  listTesters(): Promise<TestersView>;
  /** the owner's red line, the band on top of the Team home (null: none written yet). */
  redLine(): Promise<{ redLine: RedLine | null; redLines?: RedLine[] }>;
  /** his words (typed, or a voice note's) change one red line; `note` is the voice note's vn_ id. */
  editRedLine(input: { name: string; words: string; note?: string }): Promise<{ ok: true; line: RedLine; sha?: string }>;
  /** his briefing: what he said on one objective (or campaign), filed on it: his words file and a Decisions line. */
  briefingAnswer(input: { kind: "objective" | "campaign"; id: string; name?: string; words: string; note?: string }): Promise<{ ok: true; filed: string[]; sha?: string }>;
  /** delete one red line (after his confirm tap); `undoRedLine` brings it back to its place. */
  deleteRedLine(input: { name: string }): Promise<{ ok: true; sha?: string }>;
  undoRedLine(input: { name: string }): Promise<{ ok: true; sha?: string }>;
  /** the "I'm on my laptop" switch and the Mac tasks with their commands (the home world only). */
  laptop(): Promise<LaptopView>;
  /** on for 1 h, 2 h or until he says (tells the Team desk, wakes the runs held on the laptop). */
  setLaptop(f: LaptopFor): Promise<{ session: LaptopSession }>;
  /** off now (tells the Team desk). */
  laptopOff(): Promise<{ ended: boolean; session: null }>;
  /** the owner's press on a Mac task's card writes its ticket page's step (the steps kit's path; his session only). */
  stepTick(pageId: string, body: StepTickInput): Promise<{ state: "todo" | "done" | "stuck"; spine: "saved" | "same" }>;
  /** voice feedback links and the items filed from them. */
  listFeedback(): Promise<FeedbackView>;
  createFeedbackLink(input: { who: string; product?: string; campaign?: string }): Promise<FeedbackLink>;
  revokeFeedbackLink(id: string): Promise<FeedbackLink>;
  /** the owner opened /testers: every row on it is no longer new. */
  markTestersSeen(): Promise<{ ok: boolean; marked: number }>;
  /** turn a signup into a working world (idempotent; a fresh setup link while no password is set). */
  makeTesterWorld(signupId: string, payment?: TesterPayment): Promise<TesterWorldResult>;
  /** remove a tester's world (confirm = its id). */
  removeTesterWorld(signupId: string, confirm: string): Promise<{ worldId: string; removed: Record<string, number>; repo?: string }>;
  /** the owner switches one persona's access to one service. */
  setServiceAccess(serviceId: string, personaId: string, allowed: boolean, capability?: ServiceCapability, world?: string): Promise<TeamService>;
  /** who may receive the team's mail (`anyone` is the owner's own click), or one persona's daily send cap. */
  setMailSettings(input: { recipients: "owner" | "anyone" } | { personaId: string; dailyCap: number }): Promise<TeamMailView>;
  /** poll the team mailbox now (new mail from the owner goes to the Team desk). */
  pollTeamMailbox(): Promise<{ posted: number; ignored: number; inbox: TeamMailView["inbox"] }>;
  /** a world's Voice notes from the memory service card; Connect (the URL of the memory service's consent), settings, test note, Disconnect. */
  getMemoryCard(world?: string): Promise<MemoryCard>;
  /** the one-button connects and whether each is connected. */
  listConnects(): Promise<{ connects: ConnectCard[] }>;
  /** keys pasted on steps pages (names and outcome only). */
  listStepKeyPastes(): Promise<{ log: StepKeyPaste[] }>;
  /** the team logins the browser sign-in act may read and each read. */
  getTeamLogins(): Promise<TeamLoginsView>;
  connectMemory(world?: string): Promise<{ url: string }>;
  setMemorySettings(input: { desk?: string; filter?: MemoryNoteFilter }, world?: string): Promise<MemoryCard>;
  testMemory(world?: string): Promise<{ ok: boolean; message: string; card: MemoryCard }>;
  disconnectMemory(world?: string): Promise<{ ok: boolean; message: string; card: MemoryCard }>;
  /** start the worker server (coding start + tunnel + health). Returns at once; progress and result come from getHosts. */
  wakeVps3(): Promise<{ started: boolean; wake: HostWake }>;

  /** a world's social data, the pack export (read-only; adds the writes). `repo` picks one of its repos. */
  getSocial(tenantId: string, repo?: string, campaign?: string): Promise<SocialData>;
  /** the live numbers of a campaign's posted X posts (Posted / monitoring); Reddit is ledger-only. */
  getSocialMetrics(tenantId: string, repo?: string): Promise<SocialMetrics>;
  /** the performance view (daily KPI series per platform and the best post). */
  getSocialKpis(tenantId: string, repo?: string): Promise<SocialKpisBody>;
  /** the Performance page's site numbers (page views, new users registered, code page views). */
  getSiteKpis(tenantId: string): Promise<SiteKpisBody>;
  /** the product deck (data/product.md), the metrics catalog, each campaign's target and who moves what. */
  getSocialMotion(tenantId: string, repo?: string, campaign?: string): Promise<MotionBody>;
  /** one post's history (the posts ledger's git log) for its page. */
  getSocialPostHistory(tenantId: string, repo: string, id: string): Promise<PostHistory>;
  /** every DM chat of the world's social repos (the Messages page and its menu count). */
  getMessages(tenantId: string): Promise<MessagesView>;
  /** one chat's history (the messages ledger's git log) for its conversation page. */
  getChatHistory(tenantId: string, repo: string, id: string): Promise<ChatHistory>;
  /** every social click: one commit to the campaign repo as the owner, answered with the fresh export. */
  socialWrite(tenantId: string, w: SocialWriteAction, repo?: string): Promise<SocialWriteResult>;
  /** the world's campaigns (repos with the social pack), the checkouts it may start one in, and New campaign. */
  listCampaigns(tenantId: string): Promise<CampaignList>;
  listCampaignRepos(tenantId: string): Promise<CampaignRepo[]>;
  previewCampaign(tenantId: string, input: CampaignInput): Promise<CampaignPlan>;
  createCampaign(tenantId: string, input: CampaignInput): Promise<CampaignResult>;
  /** Add job (a one-off milestone with an end) in one of the world's repos. */
  addJob(tenantId: string, input: JobInput): Promise<JobResult>;
  /** named campaigns inside a repo: create, rename, replace the plan, retire (pause + hide), restore. */
  createNamedCampaign(tenantId: string, input: NamedCampaignInput): Promise<NamedCampaignResult>;
  /** the campaign template every new campaign starts from. */
  campaignTemplate(tenantId: string): Promise<CampaignTemplate>;
  renameCampaign(tenantId: string, milestoneId: string, name: string): Promise<unknown>;
  setCampaignPlan(tenantId: string, milestoneId: string, plan: string): Promise<unknown>;
  /** the owner saves the campaign's one-pager (his lines; a held draft's row closes). */
  saveOnePager(tenantId: string, milestoneId: string, fields: Partial<Record<OnePagerKey, string>>): Promise<{ commit?: string; onePager?: OnePager; closedDraft?: string }>;
  /** the five tabs' read of the campaign's epic file; Keep or Undo a rebuilt slide; a proposal's Add to the brief / Not now. */
  getCampaignTotems(tenantId: string, milestoneId: string): Promise<CampaignTotems>;
  /** the campaign's Plan tab: its marketing plan from the spine's `## Plan` section (docs/campaign-plan.md). */
  getCampaignPlan(tenantId: string, milestoneId: string): Promise<MarketingPlan>;
  /** the owner writes the Plan's line and eight sections into the campaign spine (one commit). */
  saveCampaignPlan(tenantId: string, milestoneId: string, input: MarketingPlanWrite): Promise<MarketingPlan>;
  /** an objective's Plan tab: the same eight sections, read from the campaign spine the objective names. */
  getObjectivePlan(id: string): Promise<MarketingPlan>;
  /** root L-77: every product's map (its hardwired totems) and one totem's content for its tab. */
  getTotems(): Promise<TotemMaps>;
  getTotem(product: string, id: string): Promise<TotemView>;
  /** the world's onboarding scorecard (six ticks read from live state). */
  getOnboarding(tenantId: string): Promise<Onboarding>;
  /** the owner's note on a Product tab slide, filed to the campaign's spine; returns that slide's notes. */
  fileProductNote(tenantId: string, milestoneId: string, note: { file: string; slide: string; note: string }): Promise<{ n: number; notes: ProductNote[]; commit?: string }>;
  keepSlide(tenantId: string, milestoneId: string, slide: { file: string; ref: string }): Promise<{ commit?: string }>;
  undoSlide(tenantId: string, milestoneId: string, slide: { file: string; ref: string }): Promise<{ commit?: string; restored?: string }>;
  decideProposal(tenantId: string, milestoneId: string, input: { file?: string; id: string; action: "add" | "notnow" }): Promise<{ commit?: string; ref?: string }>;
  retireCampaign(tenantId: string, milestoneId: string): Promise<unknown>;
  restoreCampaign(tenantId: string, milestoneId: string): Promise<unknown>;
  /** upload an asset (images, video; ≤ 25 MB), one commit as the owner; `info` = {id, file, kind}. */
  socialUpload(tenantId: string, up: SocialAssetUpload, repo?: string): Promise<SocialWriteResult>;
  /** one day's digest (default today, UTC). */
  getSocialDigest(tenantId: string, date?: string, repo?: string): Promise<SocialDigestView>;

  /** the Epic Book (the home world only): goal, why, timeline, next and stuck of every epic in every repo. */
  getBook(): Promise<BookView>;
  /** one milestone's Epic Book (by milestone id, or a repo name for its root milestone). */
  getMilestoneBook(key: string): Promise<MilestoneBookView>;
  /** the big rocks board (docs/big-rocks.md), each rock with the decks it sits on. */
  getBigRocks(): Promise<BigRocksView>;
  /** the project's arc (docs/arcs.md), null when it has none. */
  getMilestoneArc(id: string): Promise<{ arc: Arc | null }>;
  /** the high-level epics with a deck and the Team home's deck cards. */
  listDecks(): Promise<DecksView>;
  /** one epic deck (`/deck/<repo>/<code>`). */
  getEpicDeck(repo: string, code: string): Promise<EpicDeckView>;
  /** the deck of a milestone's spine (milestone id, or a repo name), where an old /book/<key> link now leads. */
  deckOf(key: string): Promise<{ href: string | null; repo?: string; building?: boolean }>;
  /** the Team home's "Epic decks changed" cards. */
  listDeckCards(): Promise<{ cards: DeckCard[] }>;
  /** the owner saw a deck card (`· seen` on its line in the repo). */
  deckCardSeen(ref: { repo: string; code: string; date: string }): Promise<{ ok: boolean; sha?: string }>;

  /** a world's credits (balance, plan, gate, 30-day burn, ledger). */
  getCredits(tenantId: string): Promise<Credits>;
  /** platform only (the home world): a top-up / grant we make by hand; releases held wakes when back above zero. */
  grantCredits(tenantId: string, input: CreditGrantInput): Promise<CreditGrantResult>;
  /** an owner starts the €49 a month Epic Team checkout for their world; answers the Stripe-hosted page's address. */
  startPlanCheckout?(tenantId: string): Promise<{ url: string }>;
  /** may this world buy the paid plan (the Buy button), and has it paid ("You're on <plan>"). */
  getPlan?(tenantId: string): Promise<PlanState>;
  /** platform only: the per-world gate (the home world is never held either way). */
  setCreditsGate(tenantId: string, on: boolean): Promise<{ credits: Credits }>;
  /** worlds the caller can see (the platform's Credits page picks one). */
  listTenants?(): Promise<Tenant[]>;

  /** Approvals tab: a milestone's standing approvals (own + inherited); add / edit / revoke one (spine commit + push). */
  getApprovals(milestoneId: string): Promise<ApprovalsView>;
  addApproval(milestoneId: string, input: GrantInput): Promise<GrantWriteResult>;
  editApproval(milestoneId: string, code: string, input: GrantInput): Promise<GrantWriteResult>;
  revokeApproval(milestoneId: string, code: string, why: string): Promise<GrantWriteResult>;

  /** M4 browser auth: synced sites (metadata only), Clear, and the one-time sync flow. */
  listAuthSites(): Promise<AuthSite[]>;
  clearAuthSite(id: string): Promise<void>;
  /** Setup: the sign-ins the world's team can use, from its own browser and any it borrows (metadata only). */
  authReach(): Promise<AuthReach>;
  /** `profile`: a row's Re-sync, "Chrome/Profile 5"; the command stays the same one line. */
  startAuthSync(input: { patterns: string[]; browser: string; profile?: string }): Promise<AuthSync>;
  getAuthSync(token: string): Promise<AuthSync>;
  /** the Team Browser egresses' online state (Sign-ins shows the laptop's). */
  /** `posting`: the egresses the world's posts go out through (its own Team Browser, then the one it borrows). */
  listEgress(posting?: boolean): Promise<EgressStatus[]>;
  /** the hourly signed-in check, one row per site (empty when this world's browser keeps none). */
  listSignedInCheck(): Promise<SignedInCheck[]>;

  /** "done, waiting for your review" (Team home); approve closes an item, relaunch wakes its persona with the feedback. */
  /** `snoozed` = the items in review the owner snoozed (the default list leaves them out). */
  listReviewItems(q?: { state?: "snoozed" | "pending" | "backlog" }): Promise<ReviewItem[]>;
  /** the feed's goal headers (Done-means bar, running / parked / in work, steps closed by themselves). */
  listReviewGoals(): Promise<ReviewGoal[]>;
  /** Q3: goals the owner closed (what each hides), and Reopen (one spine commit). */
  listClosedGoals(): Promise<ClosedGoal[]>;
  /**
   * Bring it back. `undoPress` / `undoAnswer` take back a card press still in its undo window (nothing written;
   * 409 once it is being written or landed); `reopenReviewRow` sets a row his press closed back to review after it landed.
   */
  undoPress(pressId: string): Promise<{ undone: true }>;
  undoAnswer(responseId: string): Promise<{ undone: true; itemId: string }>;
  reopenReviewRow(card: ClosedCardRef & { /** the card's id: it lands after the close it undoes */ id?: string }): Promise<{ status: "review"; sha?: string }>;
  /** Add a last thought / Add comment: his words on a closed card, to its row or ask owner (spine first, then a wake). */
  commentClosedCard(input: ClosedCardRef & { text: string; attachments?: string[]; via?: "text" | "voice" }): Promise<{ sha?: string; woke?: string; wakeError?: string }>;
  /** the cards he closed in the last 30 days (Team home's Recently closed). */
  listClosedCards(): Promise<ClosedCard[]>;
  reopenGoal(key: string): Promise<{ goal: ClosedGoal; sha?: string }>;
  /** Complete a card; `start` / `park` are suggestion indices, together every suggestion (none dropped). */
  /** a held post's card also takes `slot` (UTC), `feedback` (schedule after this change) or `now` (Post now). */
  completeReviewItem(id: string, pick: { start?: number[]; park?: number[]; why?: string[]; slot?: string; feedback?: string; now?: boolean; release?: boolean; choice?: string; plan?: string }): Promise<ReviewItem>;
  /** Snooze on a review card (`hours`, `days` or `until`); `until: null` unsnoozes. */
  snoozeReviewItem(id: string, input: { hours?: SnoozeHours; days?: SnoozeDays; until?: string | null; park?: true }): Promise<Omit<ReviewItem, "snoozedUntil"> & { snoozedUntil: string | null }>;
  approveReviewItem(id: string): Promise<ReviewItem>;
  relaunchReviewItem(id: string, feedback: string, attachments?: string[]): Promise<ReviewItem>;
  /** Deny, the third outcome: the row closes as denied (a held post is not posted). */
  denyReviewItem(id: string, reason: string, attachments?: string[]): Promise<ReviewItem>;

  /** who is calling and their world (`tenant.skin`); optional so older fakes still type-check. */
  getMe?(): Promise<Me>;
  /** who sends the owner WhatsApp, for which milestones, and which path sends now. */
  getWhatsAppHolder?(): Promise<WhatsAppHolderView>;
  /** the owner picks the one persona that holds whatsapp-notify (it leaves every other persona). */
  setWhatsAppHolder?(personaId: string): Promise<WhatsAppHolderView>;
  /** Log out (POST /api/access/logout) and Switch world (POST /api/access/switch {tenant}, a new session), from the account block. */
  logout?(): Promise<{ ok: true }>;
  switchWorld?(tenant: string): Promise<Me>;
  /** the world switcher's rows, every world of this login with its red and green (GET /api/counts/worlds). */
  getWorldCounts?(): Promise<{ worlds: WorldCounts[] }>;

  /** Optional push of out-of-band changes (the mock uses it when a simulated run finishes). */
  subscribe?(listener: () => void): () => void;
}
