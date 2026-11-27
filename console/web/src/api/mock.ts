import type { ApiClient } from "./client";
import type { ReviewItem } from "./review-types";
import { seed, type MockDb } from "./seed";
import type { AddTeamServiceInput, CountsView, TeamServiceSecret, TeamService, TeamSkill, TicketSession, ChatRead, ChatAttachment, DeskChat, DeskMessage, RepoFreshness, ApprovalGrant, ApprovalsView, GrantInput, Assignment, AuthSite, HostsView, HostWake, AuthSync, Milestone, MilestoneStatus, MilestoneStatusView, MilestoneTree, PendingItem, StatusBatch, Run, Ticket, TreeColor, TreeNode, SocialWriteAction, SocialAssetUpload, TesterPayment, TesterWorldResult, FeedbackLink, FeedbackView } from "./types";
import { nextRunAfter } from "@/lib/format";
import type { PriorityModeView } from "./types";
let mockPriority: PriorityModeView = { on: false, parked: [], log: [], focusRunning: [] };
import { activeSeries, localDay } from "../../../server/src/activeAgents";
import { hostSeries } from "../../../server/src/runHosts";
import { computeLaunch } from "../../../server/src/social/launchCompute";
import { milestoneRunStats, personaRunStats, runsForMilestone, wakesDidSomething } from "@/lib/derive";
import { sampleSocialData } from "@/lib/social";
import { computeKpis } from "../../../server/src/social/kpisCompute";
import { computeSiteKpis } from "../../../server/src/siteKpisCompute";
import { CAMPAIGN_PRODUCT_PARTS, campaignProductFile, campaignTarget, computeMotion, parseProduct } from "../../../server/src/social/motionCompute";
import { sampleCampaignProduct, sampleProduct, sampleMotionSpines, withFeatures, sampleFeatureList } from "@/lib/motionSample";
import { expandFeatures } from "../../../server/src/social/productFeatures";
import { mockTotems } from "@/lib/totems";
import { mockOnboarding, mockSocials } from "@/lib/onboarding";
import { sampleMessages } from "@/lib/messagesSample";
import { sampleDigest } from "@/lib/digest";
import { sampleBook, sampleMilestoneBook } from "@/lib/book";
import { sampleDeck, sampleDeckCards, sampleDeckList, sampleRocks } from "@/lib/deck";
import { usageTotals } from "./mockUsage";
import { unblockerStats } from "./mockUnblocker";
import { mockCredits } from "./mockCredits";
import type { CampaignInput, JobInput, NamedCampaignInput } from "./campaign-types";
import { MOCK_CAMPAIGN_REPOS, mockCampaignCard, mockCampaignPlan } from "./mockCampaigns";
import type { ConsoleMessage, OwnerActivity, OwnerResponse, LaptopSession, WaitingItem } from "./inbox-types";
import { homeWorld, mainHost, ownerName, socialWorld, workerHost } from "@/lib/identity";
// the hosted layer's site numbers (our sites and the catalog's words) when its tree is there; the open core keeps its neutral example
import.meta.glob("../../../../../hosted/console/web/src/hosted/numbers.ts", { eager: true });

export interface MockOptions {
  db?: MockDb;
  now?: () => Date;
  /** How long a "Run now" stays running before it settles. 0 = never settle (tests). */
  simulateRunMs?: number;
  /** Artificial latency per call, to make loading states visible. */
  latencyMs?: number;
  /** GET /api/cycle in mock mode (default on: the mock simulates runs). */
  cycleEnabled?: boolean;
}

export class NotFoundError extends Error {}

/** mock team skills library (the real one: the code repo skills/team-skills.json). */
const TEAM_SKILLS_SYNC_NOTE =
  "Adding or removing commits skills/team-skills.json on home_repo main and syncs every seat on host1 at once; host3 syncs now when it is up, else its team-skills timer picks it up within 10 min of the repo sync.";
const MOCK_SKILLS: Omit<TeamSkill, "usedBy">[] = [
  { name: "diagram", useWhen: "one clean diagram image (PNG + SVG, 1600x900) for a social post or doc, from a small JSON spec: flow, tree or hub", source: { type: "local", path: "skills/diagram" }, url: "https://github.com/Acme/home_repo/tree/main/skills/diagram" },
  { name: "diagram-design", useWhen: "a branded editorial diagram (architecture, flowchart, sequence, timeline, ER, quadrant, chart, ...) as self-contained HTML/SVG, exportable to PNG", source: { type: "github", repo: "cathrynlavery/diagram-design", commit: "0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1", path: "skills/diagram-design" }, url: "https://github.com/cathrynlavery/diagram-design/tree/0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1/skills/diagram-design" },
];

/** the mock's laptop switch. */
let mockLaptop: LaptopSession | null = null;

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory ApiClient seeded with example data. Mutations persist for the session. */
export function createMockClient(opts: MockOptions = {}): ApiClient {
  const now = opts.now ?? (() => new Date());
  const db = opts.db ?? seed(now());
  const simulateRunMs = opts.simulateRunMs ?? 4000;
  const latency = opts.latencyMs ?? 0;
  const listeners = new Set<() => void>();
  const pushEndpoints = new Set<string>();
  let seq = 0;
  let vps3Wake: HostWake = { state: "idle" };
  const ticketSessions = new Map<string, TicketSession>();
  // each mock card carries the approved face (docs/status/e948-s26/real-feed-mockup.html)
  const face = (title: string, url: string, o: Partial<NonNullable<ReviewItem["face"]>> = {}): NonNullable<ReviewItem["face"]> => ({
    project: { name: "The team console", url: "https://team.example.com/" },
    goal: { text: "Show you finished work in one clear list to check", code: "EPIC-948" },
    tasks: { done: 13, total: 27 },
    title,
    taskGoal: "Every finished task reaches you, and what you mark is saved in the plans.",
    delivered: [
      { ok: true, text: "Every finished task now shows up in this list." },
      { ok: true, text: "The number on the badge matches the list, on laptop and on phone." },
      { ok: false, text: "Not yet seen in Safari. Please look once on your Mac." },
    ],
    evidence: { url, label: "Open Team home" },
    tree: [
      { mark: "done", text: "13 earlier tasks are done." },
      { mark: "progress", text: "The new card design you are reading now", sub: "in progress" },
      { mark: "this", text: "This task: the review list from the plans" },
      { mark: "next", text: "Next: a test that proves work from any agent reaches your list" },
    ],
    after: "Next the team adds a test that proves work from any agent reaches this list.",
    next: [],
    closesGoal: false,
    openInGoal: [],
    ...o,
  });
  const reviewItems: ReviewItem[] = [
    {
      id: "rv_mock_book",
      title: "Epic Book: one URL, every lane",
      liveUrl: "https://team.example.com/book",
      ref: "E940-S2",
      state: "review",
      liveStatus: 200,
      checkedAt: now().toISOString(),
      createdAt: now().toISOString(),
      closes: { row: "E940-S2", epic: "EPIC-940", openRows: ["E940-S3"], openAsks: ["E940-A2"] },
      verdict: { kind: "card" },
      face: face("The review list was rebuilt to come straight from the project plans, so no finished task is missed.", "https://team.example.com/"),
    },
    {
      id: "rv_mock_social",
      title: "SocialApp landing prototype v2",
      liveUrl: "http://10.86.141.63:8795/site/social-team/",
      ref: "E910-S5",
      state: "review",
      liveStatus: 200,
      checkedAt: now().toISOString(),
      createdAt: now().toISOString(),
      verdict: { kind: "card" },
      face: face("A list of every part of Memo and how to check it was written down.", "http://10.86.141.63:8795/site/social-team/", {
        next: [
          { title: "Build the health page", recommend: "start" },
          { title: "Add a phone alert when a part goes red", recommend: "park" },
        ],
      }),
    },
    {
      id: "rv_mock_site",
      title: "epicspine.dev is live",
      liveUrl: "https://epicspine.dev/",
      ref: "EPIC-943",
      state: "review",
      liveStatus: 200,
      checkedAt: now().toISOString(),
      createdAt: now().toISOString(),
      verdict: { kind: "card" },
      face: face("The epicspine.dev site was put live so people can read about EpicSpine.", "https://epicspine.dev/", { closesGoal: true, openInGoal: [{ ref: "E943-S4", name: "the product pages" }] }),
    },
  ];

  const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`;
  const stamp = () => now().toISOString();
  // demo freshness: in line with GitHub, synced 40 s ago, until Refresh.
  const fresh: Record<string, RepoFreshness> = {};
  const mockFresh = (mid: string): RepoFreshness =>
    fresh[mid] ?? { repo: db.milestones.find((m) => m.id === mid)?.repo ?? "", sha: "3e563d0a1b2c", syncedAt: new Date(now().getTime() - 40_000).toISOString(), behind: 0, ahead: 0 };
  // the two team services; access defaults like the server (memory every persona, gmail the home world's).
  // rework: services are a list the owner adds to (a remote MCP server or an email account), with secrets set/unset.
  const serviceAccess = new Map<string, boolean>();
  type MockSvc = Omit<TeamService, "personas" | "mail">;
  const secret = (field: string, label: string, name: string, setAt?: string, extra: Partial<TeamServiceSecret> = {}): TeamServiceSecret => ({ field, label, app: "agent-team-console", name, set: !!setAt, ...(setAt ? { setAt } : {}), ...extra });
  let mockSvcs: MockSvc[] = [
    { id: "memo", key: "memo", kind: "remote", kindLabel: "Remote MCP server", world: homeWorld(), builtin: true, config: { url: "https://cloud.memo.example.com/mcp", header: "Authorization" }, capabilities: ["use"], secrets: [secret("token", "Token or API key (sent in the header)", "MEMORY_TOKEN", "2026-10-28T20:17:00Z", { optional: true, managed: "copied to every seat host: rotate it there" })], name: "Memo memory", what: "The team's shared memory.", scope: "search and store memories", server: "memo", enforcement: "wake instruction", connect: "memory token", status: { state: "connected" as const, detail: "memory token works (MCP initialize ok)" } },
    { id: "gmail", key: "gmail", kind: "email", kindLabel: "Email account (catalog server team-gmail)", world: homeWorld(), builtin: true, config: { address: "sam@example.com", catalog: "team-gmail" }, capabilities: ["read", "draft", "send"], secrets: [secret("password", "App password", "GMAIL_APP_PASSWORD")], name: "Gmail", what: "Sam's mailbox: read, draft, send where you switch it on. Mail to the team address reaches the Team desk.", scope: "read, draft, send: per persona (send off until you switch it on)", server: "team-gmail", enforcement: "console server", connect: "a Google app password: paste it below", status: { state: "not_connected" as const, detail: "not signed in: waits on Sam's app password (ask E945-A1)" } },
  ];
  const mockServices = (): TeamService[] =>
    mockSvcs.map((s) => ({
      ...s,
      personas: db.personas.map((p) => {
        const k = `${s.id}:${p.id}`;
        const base = { id: p.id, name: p.name, world: homeWorld(), allowed: serviceAccess.get(k) ?? !!s.builtin, explicit: serviceAccess.has(k) };
        if (s.kind === "email" && !s.builtin) return { ...base, caps: { read: base.allowed, draft: base.allowed && (serviceAccess.get(`${s.id}.draft:${p.id}`) ?? false) } };
        if (s.id !== "gmail") return base;
        const cap = (c: string, d: boolean) => serviceAccess.get(`gmail.${c}:${p.id}`) ?? d;
        return { ...base, mail: { read: base.allowed, draft: cap("draft", true), send: cap("send", false), dailyCap: mailCaps.get(p.id) ?? 10, sentToday: 0 } };
      }),
      ...(s.id === "gmail" ? { mail: mockMail() } : {}),
    }));
  const svc = (id: string) => {
    const s = mockServices().find((x) => x.id === id);
    if (!s) throw new Error(`no service ${id}`);
    return s;
  };
  const mailCaps = new Map<string, number>();
  let mailRecipients: "owner" | "anyone" = "owner";
  /** the Voice notes from the memory service card in mock mode (connected, Team desk, all notes). */
const memoryMock: { state: "not_connected" | "connected" | "revoked"; desk: string; filter: "all" | "team" } = { state: "connected", desk: "team", filter: "all" };
const mockMemory = (world?: string) => ({
  world: world ?? homeWorld(),
  team: world && world !== homeWorld() ? "SocialApp" : "EpicTeam",
  enabled: true,
  state: memoryMock.state,
  account: { email: "sam@example.com", name: "Sam Montes" },
  connectedAt: "2026-11-02T16:00:00Z",
  subscriptionName: world && world !== homeWorld() ? "SocialApp" : "EpicTeam",
  desk: memoryMock.desk,
  filter: memoryMock.filter,
  desks: [{ id: "team", label: "Team desk" }],
  lastNote: { at: new Date().toISOString(), head: "Remind the delivery manager to ship the post page", via: "hook", ms: 300 },
  safety: { everyMs: 1_200_000, at: new Date().toISOString(), result: "nothing missed" },
  skippedToday: 0,
  today: { hooks: 1, safetySearches: 4, pollSearches: 0 },
  canEdit: true,
});
/** a mock chat read: the newest `limit` messages, or the page older than `before` (positions are indexes here). */
function pageOf(c: DeskChat, read?: ChatRead): DeskChat {
  const all = c.messages.map((m, i) => ({ ...m, position: i }));
  const upto = read?.before !== undefined ? all.filter((m) => m.position < read.before!) : all;
  const n = read?.limit ?? 120;
  return { ...c, messages: upto.slice(-n), hasEarlier: upto.length > n };
}
const mockMail = () => ({
    recipients: mailRecipients,
    jordiAddresses: ["sam@example.com"],
    defaultCap: 10,
    sends: [],
    inbox: { address: "sam+desk@example.com", state: "not_connected" as const, detail: "not signed in: waits on Sam's app password (ask E945-A1)", recent: [] },
  });
  const ok = async <T>(v: T): Promise<T> => {
    if (latency) await new Promise((r) => setTimeout(r, latency));
    return clone(v);
  };
  const emit = () => listeners.forEach((l) => l());
  let mockSkills = MOCK_SKILLS.map((x) => ({ ...x }));
  const credits = mockCredits(now);
  // Browser auth (M4): a sync "completes" once polled after simulateRunMs (never when 0).
  const authSites: AuthSite[] = [];
  const syncs = new Map<string, AuthSync>();
  const responses: OwnerResponse[] = [];
  const messages: ConsoleMessage[] = [];
  // mock desk chat: one thread; the desk "replies" at once (never working).
  /** files uploaded for chat messages in this mock session. */
  const mockFiles = new Map<string, ChatAttachment>();
  /** as the console does (attachments.cardText): the links of the files sent with a card's words follow them. */
  const cardWords = (text: string, ids?: string[]) => {
    const urls = (ids ?? []).flatMap((i) => (mockFiles.get(i) ? [mockFiles.get(i)!.path] : []));
    return urls.length ? `${text.trim()}${text.trim() ? " " : ""}📎 Sam attached ${urls.length === 1 ? "a file" : `${urls.length} files`}, open ${urls.length === 1 ? "it" : "each"} with your console headers: ${urls.join(" ")}` : text;
  };
  const desk: DeskMessage[] = [
    { id: "dm-0", role: "user", kind: "seed", text: "", status: "completed", session: 1, at: stamp() },
    { id: "dm-1", role: "assistant", kind: "message", text: "Team desk ready. Tell me about a new idea, or ask what is open.", status: "completed", at: stamp() },
    // his own words, then words his other desk passed in and the console's note of a part passed on, shown apart.
    { id: "dm-2", role: "user", kind: "message", text: "The pipeline page is slow on my phone. And post the launch clip on X tomorrow morning.", status: "completed", at: stamp() },
    {
      id: "dm-3",
      role: "user",
      kind: "message",
      text: '↔ Passed to the SocialApp desk (dx_7e21c0aa): post the launch clip on X tomorrow morning.\nThe console passed this part of Sam\'s newest message to his SocialApp desk (https://social.example/chat), quoting him; it acts on it there.',
      status: "completed",
      at: stamp(),
    },
    { id: "dm-4", role: "assistant", kind: "message", text: "Passed to the SocialApp desk: the launch clip post. I am looking at the slow pipeline page now.", status: "completed", at: stamp() },
    {
      id: "dm-5",
      role: "user",
      kind: "message",
      text: '↔ From the SocialApp desk (dx_3b9f12d4): fix the link tracker on the campaign page.\nSam said this to his SocialApp desk (https://social.example/chat); that desk decided this part belongs to you, the EpicTeam desk, and passed it. The rest stayed there.\nAct on it as on his own words in this chat (his ask is ready), then reply in one line with what you did, links first.\n\nHis words: "The clicks on the campaign page show zero, the tracker is broken, can the builders fix it today?"',
      status: "completed",
      at: stamp(),
    },
    { id: "dm-6", role: "assistant", kind: "message", text: "Added a row for the broken click tracker, a worker starts on it now.", status: "completed", at: stamp() },
  ];
  // mock milestone chats: one thread per milestone, opened lazily.
  const repoDesks = new Map<string, DeskMessage[]>();
  const repoDesk = (mid: string) => {
    if (!repoDesks.has(mid))
      repoDesks.set(mid, [
        { id: `rd-${mid}-0`, role: "user", kind: "seed", text: "", status: "completed", session: 1, at: stamp() },
        { id: `rd-${mid}-1`, role: "assistant", kind: "message", text: "Repo desk ready.", status: "completed", at: stamp() },
      ]);
    return repoDesks.get(mid)!;
  };
  // mock approvals: per milestone, seeded with one own, one inherited and one revoked grant.
  const approvals = new Map<string, ApprovalGrant[]>();
  const grantsOf = (milestoneId: string) => {
    let g = approvals.get(milestoneId);
    if (!g) {
      g = [
        { code: "E901-G1", who: "Sam", scope: "Create, deploy and roll back this milestone's own Deployer app", limits: "no change to other apps", expires: "never", since: "2026-10-20", state: "active", source: "docs/spines/milestone.md", inherited: false, uses: 1,
          useRows: [{ path: "docs/spines/milestone.md", line: 42, date: "2026-10-22", text: "deployed v2 under E901-G1" }] },
        { code: "E900-G1", who: "Sam", scope: "LLM test spend up to EUR 25 per wave", limits: null, expires: "2026-12-31", since: "2026-10-18", state: "active", source: "docs/spines/root.md", inherited: true, uses: 0, useRows: [] },
        { code: "E901-G0", who: "Sam", scope: "Old staging database", state: "revoked", revoked: "2026-10-21", why: "staging retired", source: "docs/spines/milestone.md", inherited: false, uses: 0, useRows: [] },
      ];
      approvals.set(milestoneId, g);
    }
    return g;
  };
  const approvalsView = (milestoneId: string): ApprovalsView => {
    const g = grantsOf(milestoneId);
    const n = Math.max(0, ...g.filter((x) => x.code.startsWith("E1-G")).map((x) => Number(x.code.slice(4)))) + 1;
    return { path: "docs/spines/milestone.md", grants: g, nextCode: `E1-G${n}` };
  };
  const grantWrite = (milestoneId: string, x: ApprovalGrant) =>
    ok({ code: x.code, line: `- [${x.state === "revoked" ? `revoked ${x.code} ${x.revoked}` : `grant ${x.code}`} @${ownerName()}${x.since ? ` since ${x.since}` : ""}] ${x.scope}`, sha: "abc1234", path: x.source, view: approvalsView(milestoneId) });

  function find<T extends { id: string }>(list: T[], key: string, what: string): T {
    const item = list.find((x) => x.id === key);
    if (!item) throw new NotFoundError(`${what} ${key} not found`);
    return item;
  }

  /** Spine path → milestone id for one seeded repo (`tracked`). */
  function trackedPaths(repoName: string): Record<string, string> {
    const r = db.repos.find((x) => x.name === repoName);
    const out: Record<string, string> = {};
    for (const m of db.milestones) if (r && m.path && [r.name, r.remote, r.path].includes(m.repo)) out[m.path] ??= m.id;
    return out;
  }

  function deriveStatus(m: Milestone): MilestoneStatus {
    if (m.paused) return "paused";
    // Mirrors the server: the doc's Status word only (Waiting on / blockedReason never imply blocked);
    // unreadable file or empty path (bootstrap) → active.
    const r = db.repos.find((x) => x.name === m.repo || x.remote === m.repo || x.path === m.repo);
    const doc = r && db.docs[r.name]?.find((d) => d.path === m.path);
    if (!doc) return "active";
    return (doc.status?.split(/\W/)[0] as MilestoneStatus | undefined) || "unknown";
  }

  /** Mock of the server's file read: DoD counts from the seeded repo docs (no item text in mock mode). */
  function mockDerived(repo: string, path: string): Pick<Milestone, "dod" | "stateExcerpt" | "docError"> {
    const r = db.repos.find((x) => x.name === repo || x.remote === repo || x.path === repo);
    const doc = r && db.docs[r.name]?.find((d) => d.path === path);
    if (!doc) return { dod: { done: 0, total: 0, items: [] }, stateExcerpt: "", docError: `file ${path} not found in ${repo} (mock)` };
    return { dod: { ...doc.dod, items: [] }, stateExcerpt: `Mock: ${doc.title}${doc.status ? ` — Status: ${doc.status}` : ""}` };
  }

  function withNext(a: Assignment): Assignment {
    a.nextRunAt = a.enabled
      ? nextRunAfter(a.cadence, now(), a.lastRunAt ? new Date(a.lastRunAt) : undefined).toISOString()
      : undefined;
    return a;
  }

  function pickSeat(): string | undefined {
    const best = [...db.seats]
      .filter((s) => s.status === "ok")
      .sort((x, y) => Math.max(x.usage5h ?? 100, x.usageWeekly ?? 100) - Math.max(y.usage5h ?? 100, y.usageWeekly ?? 100))[0];
    return best?.id;
  }

  // the owner's mark in the spine's ## Outcome.
  const MOCK_VERDICT: Record<string, MilestoneStatusView["outcome"]["word"]> = { accomplished: "accomplished", "partially accomplished": "partially", superseded: "superseded" };
  // the status items come from the waiting list (as on the server), through the client so a test's spy on
  // listWaitingOnOwner feeds them too: open asks / persona requests / ready stamps open, answered ones answered.
  const mockStatus = async (m: Milestone): Promise<MilestoneStatusView> => {
    const waiting = await self.listWaitingOnOwner({ milestoneId: m.id });
    const all: PendingItem[] = waiting
      // a spine line naming the owner with no coded ask (heuristic) is never an item (a defect for the owner).
      .filter((w) => w.state !== "superseded" && w.state !== "done" && !w.decidedBy && w.gate !== "future" && (w.source !== "heuristic" || w.signal === "stamp_ready"))
      .map((w) => {
        const base = { id: w.id, milestoneId: m.id, title: w.title || w.question, ask: w.ask, ...(w.code ? { code: w.code } : {}), ...(w.repo ? { repo: w.repo } : {}), ...(w.nodeKey ? { nodeKey: w.nodeKey } : {}), ...(w.since ? { since: w.since } : {}) };
        if (w.state === "answered" || w.response) return { ...base, kind: "answered" as const, state: "answered" as const };
        if (w.source === "heuristic") return { ...base, kind: "mark_ready" as const, state: "open" as const, ...(w.path ? { path: w.path } : {}) };
        return { ...base, kind: w.source === "needs_jordi" ? ("needs_jordi" as const) : ("ask" as const), state: "open" as const };
      });
    const items = all.filter((i) => i.state === "open");
    const mineA = db.assignments.filter((a) => a.milestoneId === m.id);
    const running = db.runs.find((r) => r.outcome === "running" && mineA.some((a) => a.id === r.assignmentId));
    const sched = mineA.filter((a) => a.enabled && a.nextRunAt);
    const marked = MOCK_VERDICT[m.outcome?.verdict ?? ""];
    const outcome = { word: marked ?? (m.status === "done" ? "ready_to_mark" : m.status === "superseded" ? "superseded" : "not_yet") as MilestoneStatusView["outcome"]["word"], source: "derived" as const };
    const flow: MilestoneStatusView["flow"] = m.settledAt
      ? { word: "settled", reason: "settled" }
      : m.paused
        ? { word: "paused", reason: "paused" }
        : items.length
          ? { word: "needs_you", reason: `${items.length} open for you` }
          : running
            ? { word: "working", reason: "a run is live", run: { id: running.id, assignmentId: running.assignmentId, startedAt: running.startedAt, summary: running.summary } }
            : m.status === "draft" || m.runState === "planning"
              ? { word: "planning", reason: "planning: a draft, no wake works it until Sam stamps it ready" }
            : m.status === "deferred" || m.runState === "parked"
              ? { word: "parked", reason: "parked: deferred, no wake works it" }
            : m.monitoring?.some((x) => x.nextCheckAt || x.until)
              ? { word: "monitoring", reason: "monitoring", monitoring: m.monitoring }
              : sched.length
                ? { word: "queued", reason: "steps ready", nextWakeAt: sched[0].nextRunAt }
                : { word: "stalled", reason: "no persona enabled and scheduled" };
    return { milestoneId: m.id, outcome, flow, items: all, needsYou: items.length, reasons: [flow.reason] };
  };

  const self: ApiClient = {
    async listMilestones(opts) {
      return ok(db.milestones.filter((m) => opts?.includeSettled || !m.settledAt).map((m) => ({ ...m, verdict: mockVerdict(m), nonGreen: mockTree(m, db.tickets.filter((t) => t.milestoneId === m.id)).nonGreen })));
    },
    async getMilestone(mid) {
      const m = find(db.milestones, mid, "milestone");
      return ok({ ...m, outcome: m.outcome ?? null, verdict: mockVerdict(m) });
    },
    async settleMilestone(mid) {
      const m = find(db.milestones, mid, "milestone");
      m.settledAt ??= stamp();
      return ok({ ...m, outcome: m.outcome ?? null, verdict: mockVerdict(m) });
    },
    async unsettleMilestone(mid) {
      const m = find(db.milestones, mid, "milestone");
      delete m.settledAt;
      return ok({ ...m, outcome: m.outcome ?? null, verdict: mockVerdict(m) });
    },
    async createMilestone(input) {
      const m: Milestone = {
        id: id("ms"),
        title: input.title,
        repo: input.repo,
        path: input.path,
        owner: input.owner,
        paused: input.paused ?? false,
        ...(input.bigRoot ? { bigRoot: input.bigRoot } : {}),
        createdAt: stamp(),
        ...mockDerived(input.repo, input.path),
      };
      m.status = deriveStatus(m);
      db.milestones.push(m);
      return ok(m);
    },
    async updateMilestone(mid, patch) {
      const m = find(db.milestones, mid, "milestone");
      const { bigRoot, ...rest } = patch;
      Object.assign(m, rest);
      if (bigRoot === null) delete m.bigRoot;
      else if (bigRoot !== undefined) m.bigRoot = bigRoot;
      if (patch.repo !== undefined || patch.path !== undefined) Object.assign(m, mockDerived(m.repo, m.path));
      m.status = deriveStatus(m);
      return ok(m);
    },
    async bootstrapMilestone(input) {
      const m: Milestone = {
        id: id("ms"),
        title: input.title,
        repo: input.repo,
        path: "",
        owner: input.owner ?? "Sam",
        paused: false,
        createdAt: stamp(),
        dod: { done: 0, total: 0, items: [] },
        stateExcerpt: "",
      };
      m.status = deriveStatus(m);
      db.milestones.push(m);
      const run: Run = {
        id: id("run"),
        assignmentId: `bootstrap:${m.id}`,
        startedAt: stamp(),
        seat: pickSeat(),
        threadId: id("thr"),
        outcome: "running",
        summary: `Bootstrap: creating the ${input.kind} file`,
      };
      db.runs.unshift(run);
      if (simulateRunMs > 0) {
        setTimeout(() => {
          const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          m.path = input.kind === "ticket" ? `tickets/${slug}.md` : `docs/spines/${slug}.md`;
          run.outcome = "progressed";
          run.endedAt = stamp();
          run.summary = `created ${m.path}`;
          emit();
        }, simulateRunMs);
      }
      return ok({ milestone: m, run });
    },
    async deleteMilestone(mid) {
      find(db.milestones, mid, "milestone");
      db.milestones = db.milestones.filter((m) => m.id !== mid);
      db.assignments = db.assignments.filter((a) => a.milestoneId !== mid);
      db.needsOwner = db.needsOwner.filter((n) => n.milestoneId !== mid);
    },

    async listPersonaTemplates() {
      const t = (name: string, model: string, remit: string, reads: string, writes: string) => ({ name, template: name, model, host: "host1", remit, reads, writes, prompt: `${remit}\n\nReads: ${reads}\n\nWrites: ${writes}` });
      return ok([
        t("author", "claude-opus-5-5", "Writes the team's posts from the brief, ideas and priorities. Never publishes.", "The brief, ideas, listening notes, feedback.", "Post drafts."),
        t("engager", "claude-sonnet-5-5", "Proposes engagements in other people's conversations. Never engages on its own.", "Listening notes, the brief.", "Engagement proposals."),
        t("listener", "claude-sonnet-5-5", "Finds posts, threads and mentions worth the team's attention. Never posts.", "The sources the goal names.", "Listening notes and a digest."),
        t("responder", "claude-sonnet-5-5", "Drafts replies on the team's own channels; flags sensitive ones. Never sends.", "Comments, mentions, messages.", "Reply drafts and flags."),
      ]);
    },
    async listPersonas() {
      return ok(db.personas);
    },
    async createPersona(input) {
      const p = { ...input, skills: [...input.skills], id: id("p"), createdAt: stamp() };
      db.personas.push(p);
      return ok(p);
    },
    async updatePersona(pid, patch) {
      const p = find(db.personas, pid, "persona");
      Object.assign(p, patch);
      return ok(p);
    },
    async deletePersona(pid) {
      find(db.personas, pid, "persona");
      db.personas = db.personas.filter((p) => p.id !== pid);
      db.assignments = db.assignments.filter((a) => a.personaId !== pid);
    },

    async listAssignments() {
      return ok(db.assignments);
    },
    async createAssignment(input) {
      find(db.milestones, input.milestoneId, "milestone");
      const persona = find(db.personas, input.personaId, "persona");
      // the persona's may-write is the default for a new assignment; the assignment decides from then on.
      const writeEnabled = input.writeEnabled ?? persona.mayWrite;
      const a = withNext({ ...input, writeEnabled, writeScope: input.writeScope ?? (writeEnabled ? "the writes, restarts and deploys your remit requires" : ""), enabled: input.enabled ?? false, neverOn: !input.enabled, id: id("as") });
      db.assignments.push(a);
      return ok(a);
    },
    async updateAssignment(aid, patch) {
      const a = find(db.assignments, aid, "assignment");
      Object.assign(a, patch, patch.enabled ? { neverOn: false } : {});
      return ok(withNext(a));
    },
    async deleteAssignment(aid) {
      find(db.assignments, aid, "assignment");
      db.assignments = db.assignments.filter((a) => a.id !== aid);
    },
    async runAssignmentNow(aid, note) {
      const a = find(db.assignments, aid, "assignment");
      const run: Run = {
        id: id("run"),
        assignmentId: aid,
        startedAt: stamp(),
        seat: pickSeat(),
        threadId: id("thr"),
        outcome: "running",
        summary: "Manual wake (Run now).",
        ...(note?.trim() ? { instructions: note.trim() } : {}),
      };
      db.runs.unshift(run);
      a.lastRunAt = run.startedAt;
      withNext(a);
      if (simulateRunMs > 0) {
        setTimeout(() => {
          const r = db.runs.find((x) => x.id === run.id);
          if (!r || r.outcome !== "running") return;
          r.outcome = "idle";
          r.endedAt = stamp();
          r.summary = "Manual wake: health ok, nothing new to pick up.";
          emit();
        }, simulateRunMs);
      }
      return ok(run);
    },

    async getDeskChat(read?: ChatRead): Promise<DeskChat> {
      return ok(pageOf({ available: true, threadId: "desk-thread", environmentId: "env-mock", session: 1, status: "idle", working: false, sending: 0, messages: desk, hasEarlier: false }, read));
    },
    async uploadChatAttachment(file, name) {
      const a = { id: id("att"), name, mime: file.type || "application/octet-stream", bytes: file.size, createdAt: stamp(), path: typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : `/mock/${name}` };
      mockFiles.set(a.id, a);
      return ok({ attachment: a });
    },
    // the mock reads "the first one, yes" by order (the console's reader also reads codes and asks a model).
    async readSpokenAnswers(words, asks) {
      const order = ["first", "second", "third", "fourth", "fifth", "sixth"];
      return ok({
        reads: asks.map((a, i) => {
          const m = new RegExp(`\\b(?:the )?${order[i]}(?: one)?\\b[ ,:]*(\\w+)`, "i").exec(words);
          const w = m?.[1]?.toLowerCase() ?? "";
          const kind = /^(yes|ok|okay|sure)$/.test(w) ? ("approve" as const) : /^(no|nope)$/.test(w) ? ("deny" as const) : ("none" as const);
          return { id: a.id, kind, ...(kind !== "none" ? { quote: m![0], how: "order" as const } : {}) };
        }),
      });
    },
    async attachmentLine(ids) {
      const files = ids.map((a) => mockFiles.get(a)).filter((a) => !!a);
      return ok({ line: `📎 Sam attached ${files.length === 1 ? "a file" : `${files.length} files`}, open ${files.length === 1 ? "it" : "each"} with your console headers: ${files.map((f) => f!.path).join(" ")}` });
    },
    async sendDeskMessage(text, page, _crid, attachments) {
      // files go along as the console's block (the bubble shows them again from it)
      const files = (attachments ?? []).map((a) => mockFiles.get(a)).filter((a) => !!a);
      if (files.length) text = [text.trim(), "", `📎 Attachments (${files.length}): Sam attached files.`, ...files.map((f) => `- ${f!.name} · ${f!.mime} · 1 KB · ${f!.path}`)].join("\n").trim();
      if (!text.trim()) throw new Error("message is required");
      // dev check: localStorage mock.sendDelayMs = the console's answer as slow as T3 over the tunnel; mock.sendFail = it fails
      const slow = Number((typeof localStorage !== "undefined" && localStorage.getItem("mock.sendDelayMs")) || 0);
      if (slow) await new Promise((r) => setTimeout(r, slow));
      if (typeof localStorage !== "undefined" && localStorage.getItem("mock.sendFail")) throw new Error(localStorage.getItem("mock.sendFail")!);
      desk.push({ id: id("dm"), role: "user", kind: "message", text: text.trim(), ...(page ? { page } : {}), status: "completed", at: stamp() });
      desk.push({ id: id("dm"), role: "assistant", kind: "message", text: "Noted (mock desk): I would place this in the tree and reply with a link.", status: "completed", at: stamp() });
      emit();
      return ok({ threadId: "desk-thread", pending: false });
    },
    /** the mock world desk is the mock Team desk's transcript (one world here). */
    async getWorldDeskChat(_t, read?: ChatRead): Promise<DeskChat> {
      return ok(pageOf({ available: true, threadId: "world-desk-thread", environmentId: "env-mock", session: 1, status: "idle", working: false, sending: 0, messages: desk, hasEarlier: false }, read));
    },
    async getFirstObjective(t) {
      return Promise.reject(new Error(`${t} has no first objective`)); // only a paid workspace has one
    },
    async newWorkspace(_t, name) {
      return ok({ tenantId: "et-mock-new", name: name || "New workspace", made: true }); //
    },
    async sendWorldDeskMessage(_t, text, page, crid, attachments) {
      return this.sendDeskMessage(text, page, crid, attachments);
    },
    // the sample's objectives have no team, so their Chat chapter says so.
    async objectiveDesk(id: string) {
      return ok({ id, milestoneId: null });
    },
    async getMilestoneChat(mid, read?: ChatRead): Promise<DeskChat> {
      find(db.milestones, mid, "milestone");
      return ok(pageOf({ available: true, threadId: `repo-desk-${mid}`, environmentId: "env-mock", session: 1, status: "idle", working: false, sending: 0, messages: repoDesk(mid), hasEarlier: false }, read));
    },
    async sendMilestoneChatMessage(mid, text, page) {
      find(db.milestones, mid, "milestone");
      if (!text.trim()) throw new Error("message is required");
      const t = repoDesk(mid);
      t.push({ id: id("rd"), role: "user", kind: "message", text: text.trim(), ...(page ? { page } : {}), status: "completed", at: stamp() });
      t.push({ id: id("rd"), role: "assistant", kind: "message", text: "Noted (mock repo desk): I would answer from this milestone's spines and runs.", status: "completed", at: stamp() });
      emit();
      return ok({ threadId: `repo-desk-${mid}`, pending: false });
    },

    async steerAssignment(aid, message) {
      find(db.assignments, aid, "assignment");
      const run = db.runs.find((r) => r.assignmentId === aid && r.outcome === "running" && !r.parentRunId);
      if (!run) throw new Error("this assignment has no running run with a thread to steer");
      if (!message.trim()) throw new Error("message is required");
      run.steers = [...(run.steers ?? []), { at: stamp(), mode: "steer", message: message.trim() }];
      return ok({ run, threadId: run.threadId ?? "", mode: "steer" as const });
    },

    async steerRun(runId, message) {
      const run = find(db.runs, runId, "run");
      if (run.outcome !== "running") throw new Error(`run ${runId} is not running (${run.outcome})`);
      if (!message.trim()) throw new Error("message is required");
      run.steers = [...(run.steers ?? []), { at: stamp(), mode: "steer", message: message.trim() }];
      return ok({ run, threadId: run.threadId ?? "", mode: "steer" as const });
    },
    async getPriorityMode() {
      return ok(mockPriority);
    },
    async startPriorityMode({ rows, reason }) {
      if (mockPriority.on) throw new Error("priority mode is already on");
      if (!rows.length || rows.length > 2) throw new Error("name one or two rows");
      const at = stamp();
      const parked = db.runs
        .filter((r) => r.outcome === "running" && !rows.some((row) => r.summary.startsWith(row)))
        .map((r) => ({ sessionId: "pm_mock", runId: r.id, kind: (r.parentRunId ? "worker" : "wake") as "worker" | "wake", ticket: /^([A-Z][A-Z0-9]*-[A-Z]*\d+)/.exec(r.summary)?.[1], assignmentId: r.assignmentId, rank: null, state: "asked" as const, parkedAt: at }));
      mockPriority = { on: true, session: { id: "pm_mock", rows, by: "Owner", reason: reason ?? "", startedAt: at, assignments: [] }, parked, log: [{ at, event: "on", detail: `gave the machine to ${rows.join(" and ")}` }, ...parked.map((p) => ({ at, event: "park", runId: p.runId, ticket: p.ticket, detail: "asked to save state and stop" }))], focusRunning: [] };
      return ok(mockPriority);
    },
    async resumePriorityMode(why) {
      if (!mockPriority.on || !mockPriority.session) throw new Error("priority mode is off");
      const at = stamp();
      mockPriority = { ...mockPriority, on: false, session: { ...mockPriority.session, endedAt: at, endedBy: "Owner", endWhy: why ?? "Resume pressed" }, parked: mockPriority.parked.map((p) => (p.kind === "worker" ? { ...p, state: "resumed" as const, resumedAt: at } : p)), log: [...mockPriority.log, { at, event: "off", detail: why ?? "Resume pressed" }] };
      return ok(mockPriority);
    },
    async stopRun(runId, { reason, withWorkers }) {
      const run = find(db.runs, runId, "run");
      if (!reason.trim()) throw new Error("a reason is required");
      if (run.outcome !== "running") throw new Error(`run ${runId} is not running (${run.outcome})`);
      const close = (r: Run) => {
        r.outcome = "stopped";
        r.endedAt = stamp();
        r.summary = `Stopped: ${reason.trim()}${r.summary ? ` (was: ${r.summary.slice(0, 200)})` : ""}`;
      };
      const kids = db.runs.filter((r) => r.parentRunId === runId && r.outcome === "running");
      close(run);
      if (withWorkers) kids.forEach(close);
      emit();
      return ok({ run, workers: withWorkers ? kids : [], workersRunning: withWorkers ? 0 : kids.length, workerErrors: [] });
    },
    async addToTree(mid, input) {
      const m = find(db.milestones, mid, "milestone");
      if (!input.title.trim()) throw new Error("title is required");
      const path = input.path ?? m.path;
      return ok({
        kind: input.kind,
        path,
        ready: !input.draft,
        ...(input.draft ? { draftWhy: "Sam chose “just register it”" } : {}),
        ...(input.kind === "epic" ? { newPath: path.replace(/[^/]*$/, "") + input.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".md" } : { id: input.kind === "row" ? "E901-S9" : "E1-9" }),
        ...(input.kind === "done_means" && !input.draft ? { rowId: "E901-S9" } : {}),
      });
    },
    async listAskedNoRow() {
      return ok({ items: [], total: 0 });
    },
    async listOrphanCommits() {
      return ok({ items: [], total: 0 });
    },
    // a marked sample board (the real one is the console's launch board run).
    async getLaunchBoard(product?: string) {
      const products = SAMPLE_LAUNCH.products.filter((p) => !product || p.id === product);
      const greens = products.reduce((n, p) => n + p.greens, 0);
      const total = products.reduce((n, p) => n + p.total, 0);
      return ok({ board: { ...SAMPLE_LAUNCH, products, greens, total }, ranAt: SAMPLE_LAUNCH.checkedAt });
    },
    // a sample company over the mock world's repos.
    async listCompanies() {
      return ok({ companies: SAMPLE_COMPANIES });
    },
    // companies set on screen, kept in this tab (the real save is one commit to docs/companies.json).
    async addCompany(input) {
      const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!id) throw new Error("a company name needs at least one letter or digit");
      if (SAMPLE_COMPANIES.some((c) => c.id === id)) throw new Error(`a company called ${input.name} is already there`);
      const src = (w: "build" | "promo" | "ops") => input.wheels[w]?.sources ?? [];
      const company = {
        id,
        name: input.name,
        ...(input.line ? { line: input.line } : {}),
        lane: "A lane in EpicTeam",
        wheels: {
          build: { sources: src("build"), links: [] },
          promo: { sources: src("promo"), accounts: [], links: [{ label: "SocialApp", url: "https://social.example.com/" }] },
          ops: { sources: src("ops"), links: [{ label: "EpicBooks", url: "https://books.example.com/" }] },
        },
      };
      SAMPLE_COMPANIES.push(company);
      return ok({ company, write: { sha: "mock123", pushing: false } });
    },
    async setCompany(id, input) {
      const c = SAMPLE_COMPANIES.find((x) => x.id === id);
      if (!c) throw new NotFoundError(`no company ${id}`);
      c.name = input.name;
      if (input.line !== undefined) c.line = input.line || undefined;
      for (const w of ["build", "promo", "ops"] as const) if (input.wheels[w]) c.wheels[w] = { ...c.wheels[w], sources: input.wheels[w]!.sources };
      return ok({ company: c, write: { sha: "mock124", pushing: false } });
    },
    // a sample the social product world the login belongs to, its items read only (they open in cloud.social.app).
    async listCompanyWorlds() {
      return ok({ worlds: SAMPLE_WORLDS });
    },
    // a sample goal with its key results and lights, as the home repo's goal file gives it.
    async listGoals() {
      const rule = "Green: on pace for its date. Amber: behind pace. Red: no movement in 3 days, or its date has passed short of the target.";
      return ok({
        goals: [
          {
            id: "sample-testers", name: "5 testers using SocialApp", label: "5 testers using SocialApp", now: 1, target: 5, by: "2026-12-08", light: "amber" as const, why: "behind: pace says 2 by today", lightRule: rule,
            keyResults: [
              { id: "applications", label: "People apply to be testers", now: 4, target: 10, by: "2026-11-17", light: "green" as const, why: "on pace" },
              { id: "visitors", label: "Visitors on the site", now: 120, target: 500, by: "2026-11-22", light: "amber" as const, why: "behind: pace says 180 by today" },
              { id: "followers", label: "Followers on X", now: 0, target: 100, by: "2026-12-08", light: "red" as const, why: "no movement since 9 Nov" },
            ],
          },
        ],
      });
    },
    // a sample three-day experiment, as the home repo's experiment file gives it.
    async listExperiments() {
      return ok({
        experiments: [
          {
            id: "memo",
            headline: "Memo testers, three days: 0 applications from strangers, 1 of 10 testers",
            name: "Memo testers, three days",
            from: "2026-11-13",
            to: "2026-11-15",
            status: "running",
            plan: "https://plan.example/",
            keyResults: [
              { id: "applications", label: "Tester applications from strangers", goal: 3, kind: "total" as const, baseline: 0, now: 0, gained: 0, onTrack: false, source: "public counts", sourceUrl: "https://counts.example/" },
              { id: "replies", label: "Replies to our posts", goal: 30, kind: "gain" as const, baseline: 131, now: 140, gained: 9, onTrack: false, source: "metrics" },
            ],
          },
        ],
      });
    },
    // the Operations numbers as the server shapes them (sample checks; the real ones come from the console's probe).
    async getCompanyOps(id) {
      return ok({ ...SAMPLE_OPS, company: id });
    },
    // the Build numbers as the server shapes them (a sample week of ledger rows).
    async getCompanyBuild(id) {
      return ok({ ...SAMPLE_BUILD, company: id });
    },
    // the wheels' notes, kept in this tab.
    async listWheelNotes() {
      return ok({ notes: SAMPLE_WHEEL_NOTES.filter((n) => !n.handledAt), handled: SAMPLE_WHEEL_NOTES.filter((n) => n.handledAt).length });
    },
    async dropWheelNote(company, wheel, input) {
      const id = `wn_${input.clientId}`;
      const had = SAMPLE_WHEEL_NOTES.find((n) => n.id === id);
      if (had) return ok({ note: had, again: true });
      const note = { id, company, wheel, at: new Date().toISOString(), via: "text" as const, words: input.text, desk: input.milestoneId ?? "team" };
      SAMPLE_WHEEL_NOTES.unshift(note);
      return ok({ note });
    },
    async markWheelNoteHandled(id) {
      const n = SAMPLE_WHEEL_NOTES.find((x) => x.id === id);
      if (!n) throw new Error(`no wheel note ${id}`);
      n.handledAt = new Date().toISOString();
      n.handledBy = "Sam";
      return ok({ note: n });
    },
    // sample Promo numbers: one account read, one not read yet ("?" with why).
    async getCompanyPromo(id) {
      const c = SAMPLE_COMPANIES.find((x) => x.id === id);
      const accounts = (c?.wheels.promo.accounts ?? []).map((a, i) => ({
        repo: a.repo,
        account: a.account,
        platform: a.platform,
        site: a.site ?? null,
        followers: i ? { n: null, change: null, at: null, note: `No follower reading of ${a.account} yet: the console reads it once a day.` } : { n: 41, change: 8, at: "2026-11-11T00:30:00Z", note: `${a.account} on its profile, read 2026-11-11.` },
        posts: { n: i ? 0 : 3, of: i ? 0 : 5, note: i ? "Nothing slotted for this week in the posts ledger (6 drafts in the backlog)." : "This week's posts in the posts ledger: posted, of the ones slotted for this week." },
        clicks: a.site ? { n: 12, change: 4, note: `Visits to ${a.site} from a link in one of its posts, last 7 days.` } : { n: null, change: null, note: `No product page of ${c?.name} is counted yet, so its clicks cannot be read.` },
      }));
      return ok({ company: id, week: { from: "2026-11-09", to: "2026-11-15" }, accounts, ...(accounts.length ? {} : { none: `No account feeds ${c?.name ?? id}'s Promo life cycle yet.` }) });
    },
    // his four building lists, sample counts.
    async listBuilding() {
      return ok({ lists: SAMPLE_BUILDING });
    },
    // the owner's pursuits, sample scorecards.
    async listPursuits() {
      return ok(SAMPLE_PURSUITS);
    },
    // the scorecard tree from the sample pursuits: each pursuit a scorecard, no epics inside.
    async listScorecards() {
      return ok({
        nodes: SAMPLE_PURSUITS.pursuits.map((p) => ({ id: p.id, kind: "pursuit" as const, name: p.name, rank: p.rank ?? null, greens: p.greens, total: p.total, state: p.state, motion: p.motion, spines: [], children: [], rows: p.lines.map((l) => ({ label: l.label, state: l.state, value: l.value, kind: "check" as const })), objective: p.greenWhen, ...(p.group ? { group: p.group } : {}) })),
        spineInfo: {},
      });
    },
    // the sample's where-we-are: one written, the rest none yet.
    async whereWeAre(id: string) {
      return ok({ path: `docs/scorecards/${id}.md`, present: false, open: [], changed: [] });
    },
    // every goal turns in the sample.
    async personaGaps() {
      return ok({ ok: true, gaps: [], checked: { objectives: SAMPLE_PURSUITS.pursuits.length, milestones: 0 }, at: new Date(0).toISOString() });
    },
    // one sample one-off, in work.
    async listOneOffs() {
      return ok(SAMPLE_ONE_OFFS);
    },
    // two sample outcomes, today.
    async listOutcomes(f?: import("./outcome-types").OutcomeFilter) {
      const list = SAMPLE_OUTCOMES.filter((o) => (!f?.kind || o.kind === f.kind) && (!f?.persona || o.persona === f.persona) && (!f?.day || o.day === f.day));
      const counts: Record<string, number> = {};
      for (const o of list) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
      return ok({ outcomes: list, counts, kinds: ["delivered", "learning", "merged", "folded", "superseded", "released", "fixed", "asked", "other"], facets: { persona: ["Delivery manager", "Ticket worker"], product: ["EpicTeam"], kind: ["delivered", "learning"], day: ["2026-11-12"], repo: ["app"] } });
    },
    // the team's own inbox cards, samples (a digest, an idea, a goal conversation).
    async listTeamCards(q: { scorecard?: string; kind?: import("./teamcard-types").TeamCardKind } = {}) {
      const keep = (c: import("./teamcard-types").TeamCard) => (!q.scorecard || c.scorecard === q.scorecard) && (!q.kind || c.kind === q.kind);
      const open = SAMPLE_TEAM_CARDS.filter((c) => !c.answer && keep(c));
      const counts = { digest: 0, idea: 0, goal: 0, advisor: 0, support: 0 };
      for (const c of open) counts[c.kind]++;
      return ok({ open, answered: SAMPLE_TEAM_CARDS.filter((c) => !!c.answer && keep(c)), counts, limits: { digestPerScorecardPerDay: 1, ideasPerDay: 3, openGoalsPerScorecard: 1 }, today: "2026-11-13" });
    },
    async answerTeamCard(id: string, a: import("./teamcard-types").TeamCardAnswer) {
      const c = SAMPLE_TEAM_CARDS.find((x) => x.id === id);
      if (!c) throw new Error("no such card");
      c.answer = { at: new Date().toISOString(), text: a.text ?? "", via: a.via ?? "text", ...(a.pick !== undefined ? { pick: a.pick } : {}) };
      return ok({ ok: true as const, card: c });
    },
    async advisorVerdict(id: string, v: import("./teamcard-types").AdvisorVerdictBody) {
      const c = SAMPLE_TEAM_CARDS.find((x) => x.id === id);
      if (!c?.advisor) throw new Error("no such set");
      const at = new Date().toISOString();
      const rows: Record<string, string> = {};
      c.advisor.items = c.advisor.items.map((i, n) => {
        if ((v.items && !v.items.includes(i.id)) || i.verdict || v.verdict === "note") return i;
        if (v.verdict === "accept") rows[i.id] = i.row ?? `E1-S${90 + n}`;
        return { ...i, verdict: { state: v.verdict === "accept" ? "accepted" : "declined", at, via: v.via ?? "button", ...(rows[i.id] ? { row: rows[i.id] } : {}) } };
      });
      return ok({ ok: true as const, card: c, rows });
    },
    async reorderPursuits(ids: string[]) {
      SAMPLE_PURSUITS.pursuits.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      return ok({ ok: true as const });
    },
    async setPursuitActive(id: string, active: boolean) {
      const body = SAMPLE_PURSUITS;
      if (!active) {
        const p = body.pursuits.find((x) => x.id === id);
        if (p) {
          body.pursuits = body.pursuits.filter((x) => x.id !== id);
          body.inactive = [...(body.inactive ?? []), { id, name: p.name, since: new Date().toISOString().slice(0, 10) }];
        }
      } else body.inactive = (body.inactive ?? []).filter((x) => x.id !== id);
      return ok({ ok: true as const });
    },
    async setPursuitBriefing(id: string, on: boolean) {
      const p = SAMPLE_PURSUITS.pursuits.find((x) => x.id === id);
      if (p) p.briefing = on || undefined;
      return ok({ ok: true as const });
    },
    async setPursuitGroup(id: string, group: import("./pursuit-types").ObjectiveGroup) {
      const p = SAMPLE_PURSUITS.pursuits.find((x) => x.id === id);
      if (p) p.group = group;
      return ok({ ok: true as const });
    },
    async setPursuitDone(id: string, done: boolean) {
      const body = SAMPLE_PURSUITS;
      if (done) {
        const p = body.pursuits.find((x) => x.id === id);
        if (p) {
          body.pursuits = body.pursuits.filter((x) => x.id !== id);
          body.done = [...(body.done ?? []), { id, name: p.name, since: new Date().toISOString().slice(0, 10) }];
        }
      } else body.done = (body.done ?? []).filter((x) => x.id !== id);
      return ok({ ok: true as const });
    },
    async parkPursuit(id: string, parked: boolean) {
      const p = SAMPLE_PURSUITS.pursuits.find((x) => x.id === id);
      if (p) p.parked = parked;
      return ok({ ok: true as const });
    },
    // one-off pages, a sample group.
    async listPages() {
      return ok(SAMPLE_PAGES);
    },
    // the files a tab homes: none in the sample.
    async homeTab(product: string, tab: string) {
      return ok({ product, tab, label: tab, repos: [], patterns: [], homed: 0, covered: 0, entries: [] });
    },
    async listPinnedPages() {
      return ok({ pinned: SAMPLE_PAGES.pinned ?? [] });
    },
    async pinnedPageStatus() {
      return ok({ refreshedAt: new Date(Date.now() - 12 * 60_000).toISOString(), refreshable: true, running: false });
    },
    async refreshPinnedPage() {
      return ok({ refreshedAt: new Date(Date.now() - 12 * 60_000).toISOString(), refreshable: true, running: true });
    },
    async pinPage() {
      return ok({ ok: true as const });
    },
    // the asks log: a sample count, two weeks.
    async askLogSummary() {
      return ok({ thisWeek: { week: "2026-11-09", asked: 3 }, byWeek: [{ week: "2026-11-02", asked: 5, done: 5, confusing: 2, clear: 1 }, { week: "2026-11-09", asked: 3, done: 1, confusing: 1, clear: 0 }], open: 2, page: "https://pages.example.com/asks/" });
    },
    async askVerdict() {
      return ok({ added: 1 });
    },
    // his voice notes, two samples (one per product).
    async listVoiceNotes(product?: string) {
      const notes = SAMPLE_VOICE_NOTES.notes.filter((n) => !product || product === "all" || n.products.includes(product));
      return ok({ ...SAMPLE_VOICE_NOTES, notes });
    },
    // X stats: one sample day, two accounts.
    async getXStats() {
      const totals = { likes: 1, replies: 2, reposts: 0, quotes: 0, views: 14 };
      return ok({
        dates: ["2026-11-13"],
        day: { date: "2026-11-13", readAt: "2026-11-13T00:15:00Z", windowDays: 7, since: "2026-11-06T00:15:00Z", accounts: [
          { handle: "@Alpha", product: "Alpha", state: "read", listedBy: "fxtwitter timeline", followers: 0, postsAllTime: 5, count: 1, totals, notes: [], readAt: "2026-11-13T00:15:00Z",
            posts: [{ id: "1", url: "https://x.com/Alpha/status/1", at: "2026-11-12T20:35:00Z", kind: "post", text: "A first post.", likes: 1, replies: 2, reposts: 0, quotes: 0, views: 14, source: "fxtwitter" }] },
          { handle: "@Beta", product: "Beta", state: "read", listedBy: "fxtwitter timeline", followers: 2, postsAllTime: 0, count: 0, totals: { likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0 }, notes: [], readAt: "2026-11-13T00:15:00Z", posts: [] },
        ] },
        history: [{ date: "2026-11-13", accounts: { "@Alpha": { ...totals, count: 1, followers: 0, state: "read" } } }],
      });
    },
    async getPursuitKit(id: string) {
      const p = SAMPLE_PURSUITS.pursuits.find((x) => x.id === id && x.kit);
      if (!p) throw new Error("no kit");
      return ok({ pursuit: { id: p.id, name: p.name }, kit: SAMPLE_KIT, files: "http://kits.example.com/sample/assets/" });
    },
    async listProducts() {
      return ok({ products: SAMPLE_PRODUCTS });
    },
    async getProduct(id: string) {
      const p = SAMPLE_PRODUCTS.find((x) => x.id === id);
      if (!p) throw new Error("not_found");
      return ok(p);
    },
    async getProductKit(id: string) {
      const p = SAMPLE_PRODUCTS.find((x) => x.id === id && x.kit);
      if (!p) throw new Error("no kit");
      return ok({ product: { id: p.id, name: p.name }, kit: SAMPLE_KIT, files: "http://kits.example.com/sample/assets/" });
    },
    async listTicketSessions(milestoneId) {
      return ok([...ticketSessions.values()].filter((s) => s.milestoneId === milestoneId).map((s) => ({ ...s, launched: false })));
    },
    /** as the server: red = the status batch's needsYou, green = review items in review, no unread in the mock. */
    async getCounts() {
      const st = await self.listStatus();
      const milestones: CountsView["milestones"] = {};
      for (const m of st.milestones) if (m.needsYou) milestones[m.milestoneId] = { needsYou: m.needsYou };
      const reviews = reviewItems.filter((i) => i.state === "review");
      for (const r of reviews) if (r.milestoneId) (milestones[r.milestoneId] ??= {}).review = (milestones[r.milestoneId]?.review ?? 0) + 1;
      return ok({ needsYou: st.needsYou, review: reviews.length, chat: 0, milestones });
    },
    async getPush() {
      return ok({ configured: true, publicKey: "BMockKeyMockKeyMockKeyMockKeyMockKeyMockKeyMockKeyMockKeyMockKeyMockKeyMockKeyMockKeyMockKe", devices: pushEndpoints.size, endpoints: [...pushEndpoints], notifies: true });
    },
    async subscribePush(subscription) {
      if (subscription.endpoint) pushEndpoints.add(subscription.endpoint);
      return ok({ ok: true });
    },
    async unsubscribePush(endpoint) {
      return ok({ ok: true, removed: pushEndpoints.delete(endpoint) });
    },
    async testPush() {
      return ok(pushEndpoints.size ? { ok: true, sent: pushEndpoints.size } : { ok: false, sent: 0, error: "this device is not subscribed" });
    },
    async markChatSeen(target) {
      return ok({ key: target.chat === "desk" ? "team" : `milestone:${target.id}`, seenAt: now().toISOString(), unread: 0 });
    },
    async getRunStats(only) {
      // As the server: the newest 500 runs, the same numbers derive.ts gives the Team home.
      const runs = [...db.runs].sort((x, y) => y.startedAt.localeCompare(x.startedAt)).slice(0, 500);
      const at = now();
      const day = only ? [...new Set(only.flatMap((m) => runsForMilestone(m, db.assignments, db.runs)))] : db.runs;
      return ok({
        milestones: Object.fromEntries(db.milestones.map((m) => [m.id, milestoneRunStats(m.id, db.assignments, runs, at)])),
        personas: Object.fromEntries(db.personas.map((p) => [p.id, personaRunStats(p.id, db.assignments, runs)])),
        wakes24h: wakesDidSomething(day, at),
      });
    },
    async getActiveAgents({ day, tz, bucket }) {
      // As the server (the same function on the mock's runs).
      const at = new Date(now());
      return ok(activeSeries(db.runs, { day: day ?? localDay(at, tz), tz, now: at, bucketMinutes: bucket }));
    },
    async getRunHosts({ range }) {
      // As the server (the same function on the mock's runs; the mock has no T3 environments, so recorded / launch / parent).
      const byId = new Map(db.runs.map((r) => [r.id, r]));
      const rows = db.runs.map((r) => {
        const p = r.parentRunId ? byId.get(r.parentRunId) : undefined;
        return { id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, kind: r.kind, host: r.host, launchHost: r.launchHost, parentHost: p?.host, parentLaunchHost: p?.launchHost, seat: r.seat };
      });
      return ok(hostSeries(rows, { range, now: new Date(now()), hosts: [mainHost(), workerHost()] }));
    },
    async listRunsTop({ top, milestoneId }) {
      const all = [...db.runs].sort((x, y) => y.startedAt.localeCompare(x.startedAt));
      const roots = all.filter((r) => !r.parentRunId && (!milestoneId || r.milestoneId === milestoneId));
      const shown = top ? roots.slice(0, top) : roots;
      const ids = new Set(shown.map((r) => r.id));
      for (let grew = true; grew; ) {
        grew = false;
        for (const r of all) if (r.parentRunId && ids.has(r.parentRunId) && !ids.has(r.id)) (ids.add(r.id), (grew = true));
      }
      return ok({ runs: all.filter((r) => ids.has(r.id)), total: roots.length });
    },
    async listRuns(q) {
      const since = q?.since ? Date.parse(q.since) : undefined;
      return ok([...db.runs].filter((r) => (since === undefined || Date.parse(r.startedAt) >= since) && (!q?.milestoneId || r.milestoneId === q.milestoneId)).sort((x, y) => y.startedAt.localeCompare(x.startedAt)));
    },
    async getUsage({ from, to, groupBy }) {
      return ok(usageTotals(db, { from, to, groupBy }, now()));
    },
    async getUnblockerStats(q) {
      return ok(unblockerStats(db, q, now()));
    },
    async createRun(input) {
      const r: Run = { ...input, id: id("run") };
      db.runs.unshift(r);
      return ok(r);
    },

    async listNeedsOwner() {
      return ok(db.needsOwner);
    },
    async updateNeedsOwner(nid, status) {
      const n = find(db.needsOwner, nid, "needs-owner item");
      n.status = status;
      return ok(n);
    },

    async supersedeNeedsOwner(nid, by) {
      const n = find(db.needsOwner, nid, "needs-owner item");
      if (n.status !== "open" && n.status !== "superseded") throw new Error(`needs-owner item is already ${n.status}`);
      n.status = "superseded";
      n.supersededBy = by || n.supersededBy || "moot";
      n.supersededAt = stamp();
      emit();
      return ok(n);
    },

    // in mock mode: open Needs the owner rows are the waiting items; answers and messages stay in memory.
    async listWaitingOnOwner(f = {}) {
      if (f.repo && !f.milestoneId) return ok([]); // ad hoc spines carry no Needs the owner rows
      const items: WaitingItem[] = db.needsOwner
        .filter((n) => (n.status === "open" || (f.includeSuperseded && n.status === "superseded")) && (f.milestoneId ? n.milestoneId === f.milestoneId : f.includeSettled || !db.milestones.find((m) => m.id === n.milestoneId)?.settledAt))
        .map((n): WaitingItem => {
          const run = db.runs.find((r) => r.id === n.runId && r.outcome === "blocked");
          const as = run && db.assignments.find((a) => a.id === run.assignmentId);
          const persona = as && db.personas.find((p) => p.id === as.personaId);
          return {
          id: n.id,
          source: "needs_jordi" as const,
          state: (n.status === "superseded" ? "superseded" : "open") as WaitingItem["state"],
          ...(n.status === "superseded" ? { supersededBy: n.supersededBy ?? "moot" } : {}),
          milestoneId: n.milestoneId,
          milestoneTitle: db.milestones.find((m) => m.id === n.milestoneId)?.title ?? n.milestoneId,
          title: n.question,
          ...(n.proposedAction ? { detail: n.proposedAction } : {}),
          ...(run ? { blocksRunId: run.id, blocksPersona: persona?.name } : {}),
          ask: "approve",
          question: n.question,
          proposedAction: n.proposedAction,
          contextLinks: [],
          owner: { kind: "none", label: "no one to deliver to, attach a persona or name an owner thread" },
          since: n.createdAt,
          decidable: n.status === "open",
          needsJordiId: n.id,
          response: responses.find((r) => r.itemId === n.id),
          };
        })
        .sort((x, y) => (x.blocksRunId ? 0 : 1) - (y.blocksRunId ? 0 : 1));
      return ok(f.scope === "open" ? items.filter((i) => i.state === "open") : items);
    },
    async respondToWaiting(itemId, input) {
      if (input.relay) {
        // an ask a monitor alert shows (mock mode has no spines): the answer is only recorded.
        const r: OwnerResponse = { id: id("jr"), itemId, milestoneId: input.milestoneId, kind: input.kind, text: cardWords(input.text ?? "", input.attachments), delivery: "sent", createdAt: stamp() };
        responses.unshift(r);
        emit();
        return ok(r);
      }
      const n = find(db.needsOwner, itemId, "waiting item");
      n.status = input.kind === "approve" ? "approved" : input.kind === "deny" ? "denied" : "answered";
      const g = input.grantWrite;
      if (g) {
        const run = db.runs.find((x) => x.id === n.runId);
        const a = run && db.assignments.find((x) => x.id === run.assignmentId);
        if (!a) throw new Error("the run that asked has no attached assignment to grant write to");
        Object.assign(a, { writeEnabled: true, writeScope: g.scope });
      }
      const text = g ? `Granted write, scope: ${g.scope}${input.text?.trim() ? `\n${input.text.trim()}` : ""}` : cardWords(input.text ?? "", input.attachments);
      const r: OwnerResponse = { id: id("jr"), itemId, milestoneId: n.milestoneId, kind: input.kind, text, delivery: "queued", deliveryError: "mock mode", createdAt: stamp() };
      responses.unshift(r);
      emit();
      return ok(r);
    },
    async saveKey(itemId, input) {
      // Mock mode stores nothing: the value is dropped here, only the fixed answer is recorded.
      void input.value;
      const r: OwnerResponse = { id: id("jr"), itemId, milestoneId: input.milestoneId, kind: "answer", text: "key provided in the console (stored with secret put, value never shown)", delivery: "sent", createdAt: stamp() };
      responses.unshift(r);
      emit();
      return ok({ ...r, stored: { app: "mock-app", name: "MOCK_KEY", deployed: true } });
    },
    async snoozeWaiting(itemId, input) {
      // Mock mode has no spines: nothing is written, the answer only echoes the date.
      const until =
        input.until === null
          ? null
          : (input.until ?? (input.hours ? new Date(Date.now() + input.hours * 3_600_000).toISOString().slice(0, 16) + "Z" : new Date(Date.now() + (input.days ?? 3) * 86_400_000).toISOString().slice(0, 10)));
      return ok({ id: itemId, snoozedUntil: until });
    },
    async redeliverResponse(rid) {
      return ok(find(responses, rid, "response"));
    },
    async changeResponse(rid, input) {
      const old = find(responses, rid, "response");
      const r: OwnerResponse = { ...old, id: id("jr"), kind: input.kind, text: cardWords(input.text ?? "", input.attachments), replacesId: old.id, replacedAnswer: old.text, createdAt: stamp() };
      responses.unshift(r);
      emit();
      return ok(r);
    },
    async sendMessage(input) {
      const msg: ConsoleMessage = { id: id("msg"), ...input, delivery: "sent", threadId: "mock-thread", createdAt: stamp() };
      messages.unshift(msg);
      return ok(msg);
    },
    async requestAsks(input) {
      const msg: ConsoleMessage = { id: id("msg"), milestoneId: input.milestoneId, kind: "ask_for_asks", text: `Asked the owner to write human asks for ${input.path}`, delivery: "sent", threadId: "mock-thread", createdAt: stamp() };
      messages.unshift(msg);
      emit();
      return ok(msg);
    },
    async listOwnerActivity(mid) {
      const acts: OwnerActivity[] = [
        ...responses.map((r) => ({ type: "response" as const, id: r.id, at: r.createdAt, milestoneId: r.milestoneId, kind: r.kind, text: r.text, itemId: r.itemId, delivery: r.delivery, deliveryError: r.deliveryError })),
        ...messages.map((m) => ({ type: "message" as const, id: m.id, at: m.createdAt, milestoneId: m.milestoneId, assignmentId: m.assignmentId, threadId: m.threadId, messageKind: m.kind, text: m.text, delivery: m.delivery })),
      ];
      return ok(acts.filter((a) => !mid || a.milestoneId === mid).sort((a, b) => b.at.localeCompare(a.at)));
    },

    // the mock's stand-in for the server status (open Needs the owner rows, a running run, an enabled persona).
    async getMilestoneStatus(mid) {
      const m = find(db.milestones, mid, "milestone");
      return ok(await mockStatus(m));
    },
    async markMilestone(mid, input) {
      const m = find(db.milestones, mid, "milestone");
      const text = { accomplished: "accomplished", partially: "partially accomplished", not_accomplished: "not accomplished", superseded: "superseded" }[input.verdict];
      m.outcome = {
        verdict: text,
        sentence: input.sentence ?? m.outcome?.sentence ?? null,
        risk: input.risk || "none",
        evidence: input.evidence === undefined ? (m.outcome?.evidence ?? []) : input.evidence.map((e) => ({ doneMeans: e.doneMeans, links: e.evidence ? [e.evidence] : [] })),
        closedAt: stamp().slice(0, 10),
        closedBy: "Sam (console)",
      };
      if (input.verdict === "accomplished") m.status = "done";
      return ok({ verdict: input.verdict, path: m.path, status: await mockStatus(m) });
    },
    async stampMilestone(mid, input) {
      const m = find(db.milestones, mid, "milestone");
      if (!input.path || input.path === m.path) {
        if (input.to === "ready" ? m.status !== "draft" : m.status !== "ready") throw new Error(`nothing written: Status is ${m.status}`);
        m.status = input.to;
        m.runState = input.to === "ready" ? "ready" : "planning";
        m.runnable = input.to === "ready";
      }
      return ok({ to: input.to, path: input.path ?? m.path });
    },
    async nextWake(mid) {
      const items = db.milestones
        .filter((m) => !m.settledAt && !m.paused && (!mid || m.id === mid) && m.status === "ready")
        .flatMap((m) => {
          const a = db.assignments.find((x) => x.milestoneId === m.id && x.enabled && x.nextRunAt);
          const persona = a && db.personas.find((p) => p.id === a.personaId);
          return a ? [{ milestoneId: m.id, milestoneTitle: m.title, kind: "epic" as const, id: m.id, title: m.title, nodeKey: m.id, path: m.path, persona: persona?.name ?? a.personaId, at: a.nextRunAt! }] : [];
        });
      return ok({ items, at: stamp() });
    },
    async movingNow(limit) {
      const all = db.milestones
        .filter((m) => !m.settledAt && (m.status === "active" || m.status === "ready"))
        .map((m) => {
          const running = db.runs.filter((r) => r.milestoneId === m.id && r.parentRunId && r.outcome === "running");
          return {
            milestoneId: m.id,
            repo: m.repo,
            path: m.path ?? m.id,
            title: m.title,
            status: m.status ?? "active",
            workers: running.map((r) => ({ ticket: r.summary.split(/\s+/)[0] ?? "", runId: r.id, persona: "Delivery Manager" })),
            lastCommitAt: m.spineCommitAt,
            doneToday: [],
            ready: [],
            rows: [],
          };
        });
      return ok({ epics: limit ? all.slice(0, limit) : all, total: all.length, at: stamp() });
    },
    async listStatus() {
      const ms = await Promise.all(db.milestones.filter((m) => !m.settledAt).map(mockStatus));
      const items = [...new Map(ms.flatMap((x) => x.items).map((i) => [i.id, i])).values()]; // one per id, as on the server
      return ok({ milestones: ms, items, needsYou: items.filter((i) => i.state === "open").length, at: stamp() } satisfies StatusBatch);
    },

    async getTree(mid) {
      return ok(mockTree(find(db.milestones, mid, "milestone"), db.tickets.filter((t) => t.milestoneId === mid)));
    },
    async getNodeTree(mid, nodeKey) {
      const m = find(db.milestones, mid, "milestone");
      const t = mockTree(m, db.tickets.filter((x) => x.milestoneId === mid));
      const r = db.repos.find((x) => x.name === m.repo || x.remote === m.repo || x.path === m.repo);
      return ok({ ...mockSubtree(t, nodeKey), ...(r ? { repo: r.name, remote: r.remote, tracked: trackedPaths(r.name) } : {}) });
    },
    async getSpineTree(ref) {
      const r = db.repos.find((x) => x.name === ref.repo);
      const doc = r && db.docs[r.name]?.find((d) => d.path === ref.path);
      if (!r || !doc) throw new NotFoundError(`spine ${ref.repo}:${ref.path} not found`);
      const m: Milestone = { id: "spine", title: doc.title, repo: r.name, path: doc.path, owner: "", paused: false, createdAt: stamp(), status: (doc.status?.split(/\W/)[0] as MilestoneStatus) || "unknown" };
      return ok({ ...mockSubtree(mockTree(m, []), ref.nodeKey), repo: r.name, remote: r.remote, tracked: trackedPaths(r.name) });
    },
    async listRepoSpines(name) {
      const r = db.repos.find((x) => x.name === name);
      if (!r) throw new NotFoundError(`repo ${name} not found`);
      const tracked = trackedPaths(name);
      const color = (st?: string): TreeColor => (/^done/.test(st ?? "") ? "green" : /^(active|review|testing)/.test(st ?? "") ? "blue" : /^blocked/.test(st ?? "") ? "yellow" : "grey");
      const nodes = (db.docs[name] ?? [])
        .filter((d) => d.kind === "spine")
        .map((d) => ({
          path: d.path,
          id: d.path.split("/").pop()!.replace(/\.md$/, ""),
          title: d.title,
          status: d.status ?? "unknown",
          color: color(d.status),
          rollup: d.rollupStatus ?? d.status ?? "",
          rollupColor: color(d.rollupStatus ?? d.status),
          parent: d.parent ?? null,
          depth: d.depth ?? 0,
          dod: d.dod,
          openAsks: /blocked/.test(d.status ?? "") ? 1 : 0,
          ...(tracked[d.path] ? { milestoneId: tracked[d.path] } : {}),
          ...(d.orphan ? { orphan: d.orphan } : {}),
        }));
      return ok({ repo: name, remote: r.remote, root: nodes[0]?.path ?? null, nodes, fetchedAt: stamp(), refreshing: false });
    },
    // one demo checkout state per milestone; Refresh brings it in line.
    async getFreshness(mid) {
      find(db.milestones, mid, "milestone");
      const f = mockFresh(mid);
      return ok({ ...f, repos: [f], narrative: {} });
    },
    async refreshMilestone(mid) {
      const m = find(db.milestones, mid, "milestone");
      const pulled = (fresh[mid]?.behind ?? 0) > 0;
      fresh[mid] = { repo: m.repo, sha: pulled ? "9f1c2ab4d0e3" : mockFresh(mid).sha, syncedAt: stamp(), behind: 0, ahead: 0 };
      return ok({ ...fresh[mid], pulled });
    },
    async getFreshnessSummary() {
      const repos = db.milestones.map((m) => mockFresh(m.id));
      return ok({ repos, oldestSyncedAt: repos.map((r) => r.syncedAt!).sort()[0] });
    },
    async getRunCommits(mid) {
      find(db.milestones, mid, "milestone");
      // Demo: the newest progressed run of the milestone touched the spine.
      const r = db.runs.filter((x) => x.milestoneId === mid && x.outcome === "progressed" && !x.parentRunId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      return ok(r ? { [r.id]: [{ sha: "3e563d0", subject: "spine: tick the next Definition of Done item", at: r.endedAt ?? r.startedAt }] } : {});
    },
    async getBacklog(mid) {
      find(db.milestones, mid, "milestone");
      return ok(db.tickets.filter((t) => t.milestoneId === mid));
    },
    async listRepos() {
      return ok(db.repos);
    },
    async listRepoDocs(name) {
      if (!db.repos.some((r) => r.name === name)) throw new NotFoundError(`repo ${name} not found`);
      return ok(db.docs[name] ?? []);
    },

    async listThreads() {
      return ok(db.threads);
    },
    async listTickets() {
      return ok(db.tickets.filter((t) => !/^(done|closed)/i.test(t.status)));
    },
    async listTicketsTop(limit) {
      const all = db.tickets.filter((t) => !/^(done|closed)/i.test(t.status));
      return ok({ tickets: limit ? all.slice(0, limit) : all, total: all.length });
    },
    async getCycle() {
      return ok({ enabled: opts.cycleEnabled ?? true });
    },

    async listSeats() {
      return ok(db.seats);
    },

    /** a marked sample of the seats' capacity (the real one is read live from the seats and the runs). */
    async getSeatCapacity(world?: string) {
      return ok({
        of: world ?? "team",
        week: 0.47,
        pace: 0.82,
        moreFits: 0.22,
        runsPerDay: 120,
        moreRunsPerDay: 26,
        apps: [
          { app: "EpicTeam", week: 0.24, pace: 0.42, runsPerDay: 70 },
          { app: "Social", week: 0.15, pace: 0.26, runsPerDay: 38 },
          { app: "Research", week: 0.05, pace: 0.09, runsPerDay: 12 },
          { app: "Not metered", week: 0.03, pace: 0.05, runsPerDay: 0 },
        ],
        seats: { all: db.seats.length, working: db.seats.filter((s) => s.status !== "logged_out").length, signedOut: db.seats.filter((s) => s.status === "logged_out").length, limited: 0, blocked: 0 },
        lost: 0,
        answer: "Your seats are 47% used this week at 82% pace: about 22% more load fits, about 26 more runs a day.",
        at: new Date().toISOString(),
      });
    },

    /** the sample seats as the Seats screen reads them: who ran on each from the sample runs, never padded to 20. */
    async getSeatBoard() {
      const seats = db.seats.map((s) => {
        const mine = db.runs.filter((r) => r.seat === s.id);
        const tally = (rs: typeof mine) => {
          const m = new Map<string, number>();
          for (const r of rs) {
            const name = db.personas.find((p) => p.id === r.personaId)?.name ?? "Unnamed persona";
            m.set(name, (m.get(name) ?? 0) + 1);
          }
          return [...m].map(([name, runs]) => ({ name, world: "EpicTeam", runs })).sort((a, b) => b.runs - a.runs);
        };
        const open = mine.filter((r) => r.outcome === "running");
        const state = s.status === "logged_out" ? "signed_out" : s.status === "limited" ? "limited" : open.length || s.inFlight ? "working" : s.status === "ok" ? "free" : "unknown";
        return {
          id: s.id,
          plan: s.status === "logged_out" ? undefined : "Claude Team",
          state: state as "working" | "free" | "limited" | "signed_out" | "unknown",
          usage5h: s.usage5h,
          usageWeekly: s.usageWeekly,
          limitedUntil: s.resetsAt.limitedUntil,
          running: Math.max(open.length, s.inFlight),
          now: tally(open),
          day: tally(mine),
          runs24h: mine.length,
        };
      });
      const names = new Set(seats.flatMap((s) => s.day.map((p) => p.name)));
      return ok({
        seats,
        target: 20,
        signedIn: seats.filter((s) => s.state !== "signed_out").length,
        workingNow: seats.filter((s) => s.state === "working").length,
        personas: names.size,
        runs24h: seats.reduce((n, s) => n + s.runs24h, 0),
      });
    },

    /** every world reads the sample export (lib/social.ts), marked `sample`. */
    async getSocial(tenantId: string) {
      return ok(sampleSocialData(tenantId));
    },

    /** the sample ledger through the server's own computation, with a few days of follower snapshots. */
    async getSocialKpis(tenantId: string, repo?: string) {
      const today = new Date().toISOString().slice(0, 10);
      const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
      const snaps = [3, 2, 1, 0].flatMap((n, i) => [
        { date: day(n), platform: "x" as const, account: "@MemoryApp", followers: 1 + i, posts: null, repliesSent: null, repliesReceived: null, impressions: null, readAt: null, note: null },
        { date: day(n), platform: "reddit" as const, account: "u/jordimr", followers: 1, posts: null, repliesSent: null, repliesReceived: null, impressions: null, readAt: null, note: null },
      ]);
      return ok({ tenantId, repo: repo ?? socialWorld(), ...computeKpis(sampleSocialData(tenantId).data, snaps, today) });
    },

    /** a few sample sign-ups and views through the server's own computation. */
    async getSocialMotion(tenantId: string, repo?: string, campaign?: string) {
      const today = new Date().toISOString().slice(0, 10);
      const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
      const inp = {
        signups: [{ createdAt: `${day(2)}T10:00:00Z`, offer: "tester-10" }, { createdAt: `${day(1)}T10:00:00Z`, offer: "waitlist-alpha" }],
        siteViews: [{ day: day(1), page: "/testers/", n: 12 }, { day: today, page: "/", n: 7 }],
        snapshots: [{ date: today, platform: "x" as const, account: "@MemoryApp", followers: 4, posts: 0, repliesSent: 0, repliesReceived: 0, impressions: null, readAt: null, note: null }],
        posts: sampleSocialData(tenantId).data.posts ?? [],
      };
      // `campaign` asks for that campaign's own product deck (the sample has one for).
      const own = campaign ? sampleMotionSpines.map((x) => campaignTarget(x.rel, x.text)).find((t) => t.code.toUpperCase() === campaign.toUpperCase()) : undefined;
      const file = own ? campaignProductFile(own.code) : "";
      const campaignProduct = campaign ? (own ? { code: own.code, name: own.name, spine: own.spine, ...parseProduct(own.code === "EPIC-901" ? sampleCampaignProduct : null, file, CAMPAIGN_PRODUCT_PARTS) } : null) : undefined;
      // the sample deck's `Features: social` part draws a sample list (the server reads the code repo's real one).
      const product = expandFeatures(parseProduct(withFeatures(sampleProduct)), (s) => (s === "socialapp" ? sampleFeatureList : undefined));
      return ok({ tenantId, repo: repo ?? "campaign-app", repos: ["campaign-app", socialWorld()], today, product, ...(campaign ? { campaignProduct } : {}), ...computeMotion(inp as never, sampleMotionSpines) });
    },
    /** a sample launch, run through the server's own compute. */
    async getSocialLaunch(tenantId: string) {
      const today = new Date().toISOString().slice(0, 10);
      const cfg = {
        pursuit: "sample-testers",
        callsDir: "data/calls",
        channels: [
          { key: "x" as const, name: "X", account: "@sample", url: "https://x.com/sample" },
          { key: "reddit" as const, name: "Reddit", account: "u/sam", url: null },
          { key: "linkedin" as const, name: "LinkedIn", account: "sample", url: null, why: "no page yet" },
          { key: "tiktok" as const, name: "TikTok", account: "@sample", url: null },
          { key: "youtube" as const, name: "YouTube", account: "@sample", url: null },
        ],
      };
      const pursuitsText = JSON.stringify({ pursuits: [{ id: "sample-testers", name: "SocialApp: 5 testers", numbers: { campaign: "campaign-app", site: "social.example" } }] });
      const scorecardText = JSON.stringify({
        keyResults: [
          { label: "5 testers using SocialApp", value: "1 of 5", colour: "red", target: "5 testers by 8 Dec" },
          { label: "Every day: 5 call posts on X, 5 on Reddit, 1 Short on YouTube and TikTok", value: "0 days in a row of 5", colour: "red", note: "today so far 2/5 X, 1/5 Reddit" },
        ],
      });
      const callsText = JSON.stringify({
        readAt: `${today}T05:30Z`,
        target: { x: 5, reddit: 5, youtube: 1, tiktok: 1 },
        reads: { x: { state: "read" }, reddit: { state: "read" }, youtube: { state: "no account", note: "no channel yet" }, tiktok: { state: "no account", note: "no account yet" } },
        days: { [today]: { x: 2, reddit: 1, youtube: 0, tiktok: 0 } },
      });
      return ok(computeLaunch(cfg, { tenantId, shown: true, pursuitsText, scorecardText, callsText }));
    },
    async getSiteKpis(tenantId: string) {
      const today = new Date().toISOString().slice(0, 10);
      const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
      const signups = [{ createdAt: `${day(5)}T10:00:00Z`, offer: "waitlist-alpha" }, { createdAt: `${day(2)}T10:00:00Z`, offer: "tester-10" }];
      const views = [3, 2, 1, 0].flatMap((n) => [{ day: day(n), page: "/testers/", n: 4 - n }, { day: day(n), page: "github:Acme/epicspine-skill", n: n % 2 }]);
      return ok({ tenantId, shown: true, today, series: computeSiteKpis({ signups, views, today, counterSince: day(3) }) });
    },

    /** the mock reads no platform: no live numbers, the ledger's show. */
    async getSocialMetrics(tenantId: string, repo?: string) {
      return ok({ tenantId, repo: repo ?? socialWorld(), readAt: null, posts: {}, missing: [] });
    },

    /** the mock has no git: the post's row as one "Created" entry. */
    async getSocialPostHistory(tenantId: string, repo: string, id: string) {
      const p = sampleSocialData(tenantId).data.posts.find((x) => x.id === id);
      const row = { status: p?.status ?? "", title: p?.title ?? "", text: p?.text ?? "", slot: p?.slot ?? "", feedback: p?.feedback ?? "", checks: p?.checks ?? "", link: p?.link ?? "" };
      return ok({ tenantId, repo, id, entries: p ? [{ commit: "mock", at: `${p.date}T08:00:00Z`, who: p.persona ?? "Writer", subject: `${p.persona}: draft ${id}`, changes: [`Created (${row.status})`], version: 1, row }] : [] });
    },

    /** the sample's chats (lib/social.ts), grouped like the server; the mock has no git history. */
    async getMessages(tenantId: string) {
      return ok(sampleMessages(tenantId));
    },
    async getChatHistory(tenantId: string, repo: string, id: string) {
      return ok({ tenantId, repo, id, entries: [] });
    },

    /** the mock writes nothing; it answers like the server with the sample export and no commit. */
    async socialWrite(tenantId: string, w: SocialWriteAction) {
      return ok({ ...sampleSocialData(tenantId), action: w.action, id: "", commit: null, push: { state: "skipped" as const, detail: "mock" }, files: [] });
    },

    /** the sample campaign (a social world repo) and a plan computed from the form; the mock writes nothing. */
    async listCampaigns(tenantId: string) {
      return ok({ tenantId, campaigns: [mockCampaignCard()] });
    },
    async listCampaignRepos() {
      return ok(MOCK_CAMPAIGN_REPOS);
    },
    async previewCampaign(tenantId: string, input: CampaignInput) {
      return ok(mockCampaignPlan(tenantId, input));
    },
    /** Add job in the mock: a milestone on the repo (no spine is written here). */
    async addJob(tenantId: string, input: JobInput) {
      const m = await this.createMilestone({ title: input.title, repo: input.repo, path: `docs/spines/job-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`, owner: "Sam" });
      return { tenantId, repo: input.repo, milestoneId: m.id, path: m.path, status: input.draft ? ("draft" as const) : ("ready" as const), commit: "mock", push: { state: "skipped" } };
    },
    /** the mock writes no spine: a pinned milestone named after the campaign. */
    async createNamedCampaign(tenantId: string, input: NamedCampaignInput) {
      const path = `docs/spines/campaign-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      const m = await this.createMilestone({ title: input.name, repo: input.repo, path, owner: "Sam" });
      return { tenantId, repo: input.repo, milestoneId: m.id, campaign: { code: "EPIC-999", name: input.name, path, platform: input.plan?.platform ?? null, period: input.plan?.period ?? null }, commit: "mock", push: { state: "skipped" }, team: [], skipped: [] };
    },
    /** the mock's template: two parts and an empty prefill (the real one is the console's). */
    async campaignTemplate() {
      return {
        source: { name: "The example plan", url: "http://example.com/plan", said: "mock" },
        parts: [
          { key: "frame" as const, title: "Frame", help: "The one idea every post serves", example: "Bring your context home" },
          { key: "cadence" as const, title: "Cadence per channel", help: "The equal test, then lean in", example: "10 posts per message in days 1 to 3" },
        ],
        plan: { frame: "(to fill in: the one idea every post serves)", cadence: "The equal test." },
      };
    },
    async renameCampaign(_t: string, id: string, name: string) {
      return this.updateMilestone(id, { title: name });
    },
    async setCampaignPlan() {
      return ok({});
    },
    async saveOnePager() {
      return ok({ commit: "mock" });
    },
    /** a sample campaign epic (the mock writes nothing; Keep and Undo answer like the server). */
    async getCampaignTotems() {
      return ok(mockTotems());
    },
    /** a campaign's Key results, Context and Pages tabs: the objective it serves. */
    async getCampaignWheel() {
      return ok({
        product: "Notes",
        wheels: [
          {
            id: "notes-channels",
            name: "Notes: Get every channel working",
            keyResults: [{ n: 1, label: "Every channel posted in the last 7 days", target: "5", value: "4", colour: "amber", note: "not yet: LinkedIn", owner: "build" }],
            where: { path: "docs/scorecards/notes-channels.md", present: true, answer: "Four of five channels post; LinkedIn is next.", open: ["When does LinkedIn post?"], changed: [] },
            pages: [],
          },
        ],
      });
    },
    /** a campaign's Plan tab: the plan of the wheel it serves, one key result with two steps. */
    async getCampaignWheelPlan() {
      return ok({
        product: "Notes",
        wheels: [
          {
            id: "notes-channels",
            name: "Notes: Get every channel working",
            keyResults: ["Every channel posted in the last 7 days"],
            plan: {
              id: "notes-channels",
              path: "docs/scorecards/notes-channels.json",
              present: true,
              line: "Get LinkedIn posting, then every channel.",
              keyResults: [{ kr: 1, how: "Post on LinkedIn first, then add X.", steps: [{ do: "LinkedIn posts every day", owner: "Engager", by: "2026-11-25", done: true }, { do: "X posts every day", owner: "Engager", by: "2026-11-28" }], greenWhen: "Every channel posted this week." }],
            },
          },
        ],
      });
    },
    /** a campaign's Trackers tab: its wheel's Influencers shortlist, two entries. */
    async getCampaignTrackers() {
      return ok({
        product: "Notes",
        wheels: [
          {
            wheel: "notes-channels",
            name: "Notes: Get every channel working",
            product: "notes",
            tables: [{ id: "influencers", name: "Influencers", for: "people to invite as testers", columns: ["Name", "Where", "Status"], statuses: ["candidate", "contacted"], from: "own" as const, open: true, rows: [["Ada", "X", "candidate"], ["Bo", "Reddit", "contacted"]], counts: [{ status: "candidate", n: 1 }, { status: "contacted", n: 1 }], file: "docs/trackers/notes-channels/influencers.csv" }],
          },
        ],
      });
    },
    /** an objective's wheel plan: how its first key result gets to green, one step done. */
    async getObjectivePlan(id: string) {
      return ok({
        id,
        path: `docs/scorecards/${id}.json`,
        present: true,
        line: "Get the first key result green this week, then the rest.",
        by: "2026-12-05",
        keyResults: [
          {
            kr: 1,
            how: "Fix the one thing that blocks it first, then prove it on a real day.",
            steps: [
              { do: "Write the first step", changes: "everyone knows what comes first", owner: "Delivery Manager", by: "2026-11-24", done: true },
              { do: "Ship the fix", changes: "the blocker is gone", owner: "Ticket worker", by: "2026-11-26", row: "E907-S3" },
            ],
            greenWhen: "a whole day runs with no miss",
            ifStuck: "ask for the one decision that unblocks it",
          },
        ],
      });
    },
    async getTotems() {
      return ok({
        statement: "Each product's data graph is the known map its personas read from at the start and write back to at the end.",
        every: { totems: [], grows: [] },
        products: [{ product: "notes", name: "Notes", repos: ["notes"], objectives: ["notes-live"], grows: [], totems: [
          { id: "plan", name: "Plan", shape: "page" as const, tab: "plan", lives: {} },
          { id: "pricing", name: "Pricing", shape: "page" as const, tab: "pricing", lives: {} },
          { id: "launch-board", name: "Launch board", shape: "table" as const, tab: "launch", lives: { board: "notes" } },
        ] }],
      });
    },
    async getTotem(product: string, id: string) {
      return ok({ product, id, name: id, shape: "page" as const, where: "not placed yet", empty: true });
    },
    async getTrackers(wheel: string) {
      return ok({ wheel, name: wheel, tables: [{ id: "influencers", name: "Influencers", for: "people to invite as testers", columns: ["Name", "Proposed for first message", "Where", "Status", "Reply"], statuses: ["candidate", "contacted", "replied"], from: "frame" as const, open: true, first: "Proposed for first message", rows: [], counts: [], file: `docs/trackers/${wheel}/influencers.csv` }] });
    },
    async getConsumption(wheel: string) {
      const w = { key: wheel, name: "EpicTeam: Get the team to understand me", kind: "objective", ofTotal: 0.154, ofUsed: 0.333, runs: 649, outcomes: 596, madeTrue: 0.8,
        personas: [{ persona: "Ticket worker", ofTotal: 0.112, ofUsed: 0.243, ofWheel: 0.73, runs: 420, outcomes: 560, madeTrue: 0.9 }, { persona: "Delivery Manager", ofTotal: 0.025, ofUsed: 0.053, ofWheel: 0.16, runs: 200, outcomes: 30, madeTrue: 0.3 }] };
      return ok({ at: "2026-11-25T15:00:00Z", seats: 16, usedOfTotal: 0.46, wheel: wheel === "all" ? null : w, rank: wheel === "all" ? null : 1, of: 30, wheels: wheel === "all" ? [w] : undefined, personas: wheel === "all" ? w.personas : undefined, file: "docs/consumption/latest.json" });
    },
    async getPersonaLog(wheel: string, days?: number) {
      const steps = [
        { id: "run_mock0001-0000-0000-0000-000000000001", at: "2026-11-24T04:25:00Z", persona: "Delivery Manager", worker: false, objective: wheel, kr: "No card of mine was lost", row: "E907-S3", from: "Cards that wait over 2 h reach his inbox", did: "plan written and worker started for key result 1", why: "moves 'No card of mine was lost'", asked: false, outcome: "progressed" },
        { id: "run_mock0001-0000-0000-0000-000000000002", at: "2026-11-24T03:10:00Z", persona: "Ticket worker", worker: true, objective: wheel, kr: null, row: "E907-S4", from: "His phone inbox opens fast", did: "inbox opens in under a second on his phone", why: "serves the objective", asked: true, outcome: "progressed" },
      ];
      return ok({ wheel, days: days ?? 7, steps, counts: { steps: 2, unasked: 1, correct: 0, incorrect: 0, unlabelled: 1 }, file: "docs/persona-log" });
    },
    async labelStep(id: string, label: string) {
      return ok({ id, label });
    },
    async getCampaignPlan() {
      return ok(unwrittenPlan());
    },
    async getCampaignBriefings() {
      return ok({ latest: null, older: [] });
    },
    async saveCampaignPlan(_t: string, _m: string, input: { line?: string; sections: Record<string, string | undefined> }) {
      const p = unwrittenPlan();
      return ok({ ...p, source: "spine" as const, line: input.line ?? null, missing: [], sections: p.sections.map((s) => (input.sections[s.key]?.trim() ? { ...s, written: true, lead: input.sections[s.key]!.trim(), raw: input.sections[s.key]!.trim() } : s)) });
    },
    /** customer zero today ('s path, 2 of 6). */
    async getOnboarding(tenantId: string) {
      return ok(mockOnboarding(tenantId));
    },
    async getSocials(tenantId: string) {
      return ok(mockSocials(tenantId));
    },
    async startSocials(tenantId: string) {
      return ok({ ...mockSocials(tenantId), stage: "make" as const, working: true });
    },
    async fileProductNote(_t: string, _m: string, b: { file: string; slide: string; note: string }) {
      return ok({ n: 1, notes: [{ date: new Date().toISOString().slice(0, 10), file: b.file, slide: b.slide, note: b.note, noteBy: "Sam's" }], commit: "mock" });
    },
    async keepSlide() {
      return ok({ commit: "mock" });
    },
    async undoSlide() {
      return ok({ commit: "mock" });
    },
    async decideProposal() {
      return ok({ commit: "mock" });
    },
    async retireCampaign(_t: string, id: string) {
      return this.updateMilestone(id, { paused: true, bigRoot: null });
    },
    async restoreCampaign(_t: string, id: string) {
      return this.updateMilestone(id, { paused: false });
    },
    async createCampaign(tenantId: string, input: CampaignInput) {
      const p = mockCampaignPlan(tenantId, input);
      return ok({ ...p, milestoneId: p.milestone.id ?? "m-new-campaign", commits: [] });
    },

    /** the mock stores nothing; it answers like the server with the id the upload would get. */
    async socialUpload(tenantId: string, up: SocialAssetUpload) {
      const data = sampleSocialData(tenantId);
      const id = `A-${data.data.assets.length + 1}`;
      return ok({ ...data, action: "asset add", id, commit: null, push: { state: "skipped" as const, detail: "mock" }, files: [], info: { id, file: `data/assets/${id}-${up.file.name}`, kind: up.kind ?? "screenshot" } });
    },

    /** the sample export's day as a digest (nothing is sent from the mock). */
    async getSocialDigest(tenantId: string, date?: string) {
      return ok(sampleDigest(tenantId, date));
    },

    /** the home world metered + unlimited; any other world a founding plan with a sample ledger. */
    /** a small sample book (the real one is built from the spines on the server). */
    /** two finished items waiting for review (the real list is fed by runs and checked live). */
    async listReviewItems(q?: { state?: "snoozed" | "pending" | "backlog" }) {
      const snoozed = (i: ReviewItem) => !!i.snoozedUntil && Date.parse(i.snoozedUntil) > Date.now();
      if (q?.state === "pending") return ok(reviewItems.filter((i) => i.state === "pending_live"));
      if (q?.state === "backlog") return ok(reviewItems.filter((i) => i.state === "review" && !snoozed(i) && !!i.backlogSince));
      return ok(reviewItems.filter((i) => i.state === "review" && !i.backlogSince && snoozed(i) === (q?.state === "snoozed")));
    },
    async snoozeReviewItem(id: string, input: { hours?: number; days?: number; until?: string | null }) {
      const i = reviewItems.find((x) => x.id === id && x.state === "review");
      if (!i) throw new Error("not in review");
      const until = input.until === null ? undefined : (input.until ?? new Date(Date.now() + ((input.hours ?? 0) + (input.days ?? 0) * 24) * 3_600_000).toISOString().slice(0, 16) + "Z");
      Object.assign(i, { snoozedUntil: until });
      emit();
      return ok({ ...i, snoozedUntil: until ?? null });
    },
    async approveReviewItem(id: string) {
      const i = reviewItems.find((x) => x.id === id && x.state === "review");
      if (!i) throw new Error("not in review");
      Object.assign(i, { state: "approved", decidedAt: new Date().toISOString() });
      emit();
      return ok(i);
    },
    async listReviewGoals() {
      return ok([]);
    },
    async listClosedGoals() {
      return ok([]);
    },
    async reopenGoal(key: string) {
      return ok({ goal: { key, code: "EPIC-900", title: "", repo: "", path: "", status: "active", hidden: [] } });
    },
    // the mock keeps no press log: nothing to take back, a comment is only recorded, nothing closed to list.
    async undoPress() {
      throw Object.assign(new Error("mock mode: the press is in already"), { status: 409 });
    },
    async undoAnswer(responseId: string) {
      const at = responses.findIndex((r) => r.id === responseId);
      if (at < 0) throw new Error("mock mode: no such answer");
      const [r] = responses.splice(at, 1);
      const n = db.needsOwner.find((x) => x.id === r.itemId);
      if (n) n.status = "open";
      emit();
      return ok({ undone: true as const, itemId: r.itemId });
    },
    async reopenReviewRow(card: { ref: string }) {
      const i = reviewItems.find((x) => x.ref === card.ref);
      if (i) Object.assign(i, { state: "review", decidedAt: undefined });
      emit();
      return ok({ status: "review" as const });
    },
    async commentClosedCard() {
      return ok({});
    },
    async listClosedCards() {
      return ok([]);
    },
    async listSentBackCards() {
      return ok([]);
    },
    async completeReviewItem(id: string, _pick: { start?: number[]; park?: number[]; why?: string[] }) {
      const i = reviewItems.find((x) => x.id === id && x.state === "review");
      if (!i) throw new Error("not in review");
      Object.assign(i, { state: "approved", decidedAt: new Date().toISOString() });
      emit();
      return ok(i);
    },
    async relaunchReviewItem(id: string, feedback: string, attachments?: string[]) {
      const i = reviewItems.find((x) => x.id === id && x.state === "review");
      if (!i) throw new Error("not in review");
      Object.assign(i, { state: "relaunched", feedback: cardWords(feedback, attachments), decidedAt: new Date().toISOString(), relaunchRunId: "run_mock_relaunch" });
      emit();
      return ok(i);
    },
    async duplicateReviewItem(id: string, note: string) {
      const i = reviewItems.find((x) => x.id === id && x.state === "review");
      if (!i) throw new Error("not in review");
      Object.assign(i, { state: "denied", feedback: note.trim() ? `duplicate or already answered. ${note.trim()}` : "duplicate or already answered", decidedAt: new Date().toISOString() });
      emit();
      return ok(i);
    },
    async denyReviewItem(id: string, reason: string, attachments?: string[]) {
      const i = reviewItems.find((x) => x.id === id && x.state === "review");
      if (!i) throw new Error("not in review");
      Object.assign(i, { state: "denied", feedback: cardWords(reason, attachments), decidedAt: new Date().toISOString() });
      emit();
      return ok(i);
    },
    async getBook() {
      return ok({ book: sampleBook(), building: false });
    },
    /** a sample milestone book (the real one is cut from the server's book). */
    async getMilestoneBook(key: string) {
      return ok({ book: sampleMilestoneBook(key), building: false });
    },
    /** E75: sample decks and big rocks (the real ones are cut from the server's book and docs/big-rocks.md). */
    async getBigRocks() {
      return ok({ rocks: sampleRocks(), file: "docs/big-rocks.md" });
    },
    /** no arc in the mock world. */
    async getMilestoneArc() {
      return ok({ arc: null });
    },
    async listDecks() {
      return ok({ decks: sampleDeckList(), cards: sampleDeckCards() });
    },
    async deckOf(key: string) {
      return ok({ href: `/deck/${encodeURIComponent(/^ms[-_]/.test(key) ? "home_repo" : key)}/EPIC-900`, repo: "home_repo", building: false });
    },
    async getEpicDeck(repo: string, code: string) {
      return ok({ deck: sampleDeck(repo, code), building: false });
    },
    async listDeckCards() {
      return ok({ cards: sampleDeckCards() });
    },
    async deckCardSeen() {
      return ok({ ok: true });
    },
    async getCredits(tenantId: string) {
      return ok(credits.get(tenantId));
    },
    async grantCredits(tenantId, input) {
      const r = credits.grant(tenantId, input);
      emit();
      return ok(r);
    },
    async setCreditsGate(tenantId, on) {
      const r = credits.setGate(tenantId, on);
      emit();
      return ok(r);
    },

    /** auth off, today's world (the home world, console skin), as the live console answers until CONSOLE_AUTH turns on. */
    async getMe() {
      return ok({
        mode: "off" as const,
        identity: { kind: "legacy" as const, tenantId: homeWorld() },
        tenant: { id: homeWorld(), name: homeWorld(), skin: "console", plan: "internal", ownerHandle: "Sam", ownerName: "Sam", secretsBackend: "ops", paused: false, createdAt: "2026-10-26T00:00:00.000Z" },
        worlds: [],
      });
    },

    async logout() {
      return ok({ ok: true as const });
    },
    async switchWorld(): Promise<never> {
      throw new Error("the mock console has one world");
    },
    /** the switcher's rows; the mock shows a second world so the switcher is visible in dev. */
    async getWorldCounts() {
      const needs = db.needsOwner.filter((n) => n.status === "open").length;
      return ok({
        worlds: [
          { tenantId: homeWorld(), tenantName: homeWorld(), role: "owner", current: true, needsYou: needs, review: 0 },
          { tenantId: socialWorld(), tenantName: "Memo social", role: "owner", current: false, needsYou: 2, review: 1 },
        ],
      });
    },

    async getHosts() {
      const live = db.runs.filter((r) => r.outcome === "running").length;
      const waking = vps3Wake.state === "waking";
      return ok({
        generatedAt: now().toISOString(),
        checkedAt: now().toISOString(),
        stale: false,
        checking: false,
        hosts: [
          { id: "host1", state: "up", t3: { state: "reachable" }, agents: { live, wakes: live, workers: 0, unconfirmed: 0 }, note: "The console runs here, so host1 is up by definition." },
          {
            id: "host3",
            state: waking ? "starting" : vps3Wake.state === "ok" ? "up" : "off",
            t3: { state: vps3Wake.state === "ok" ? "reachable" : "not_checked" },
            agents: { live: 0, wakes: 0, workers: 0, unconfirmed: 0 },
            coding: { state: vps3Wake.state === "ok" ? "up" : "off", rawLine: vps3Wake.state === "ok" ? "server: host3 (1) status=running" : "server: none (not running)", raw: "" },
            wake: { ...vps3Wake },
            canWake: !waking,
            idleShutdown: { afterMinutes: 30, note: "ops stops host3 by itself after 30 min idle (idle watchdog on host1); there is no Stop button here." },
          },
        ],
      } as HostsView);
    },
    async redLine() {
      return ok({ redLine: null, redLines: [] });
    },
    async briefingAnswer() {
      return { ok: true as const, filed: ["docs/his-words.json"] };
    },
    async editRedLine() {
      throw new Error("the mock console does not change red lines");
    },
    async deleteRedLine() {
      throw new Error("the mock console does not change red lines");
    },
    async undoRedLine() {
      throw new Error("the mock console does not change red lines");
    },
    async laptop() {
      return ok({ session: mockLaptop, tasks: [], listUrl: "http://worker.tail.example:9196/mac/" });
    },
    async setLaptop(f) {
      const now = Date.now();
      mockLaptop = { id: `lap_${now}`, since: new Date(now).toISOString(), until: f === "open" ? null : new Date(now + (f === "1h" ? 1 : 2) * 3600_000).toISOString(), by: "Sam" };
      return ok({ session: mockLaptop });
    },
    async stepTick(_pageId, body) {
      return ok({ state: body.state ?? "todo", spine: "saved" as const });
    },
    async laptopOff() {
      const ended = !!mockLaptop;
      mockLaptop = null;
      return ok({ ended, session: null as null });
    },
    async listTesters() {
      return ok({ signups: [], page: "https://epicspine.dev/testers/", newCount: 0 });
    },
    async listFeedback() {
      return ok({ links: [], notes: [], filed: [], repo: "home_repo", dir: "feedback/voice", public: false } as FeedbackView);
    },
    async createFeedbackLink(input: { who: string; product?: string; campaign?: string }) {
      const token = "mockMockMockMock";
      return ok({ id: "fbl_mock0000", token, url: `http://localhost/api/public/feedback/${token}`, world: homeWorld(), who: input.who, product: input.product ?? "SocialApp", campaign: input.campaign ?? "testers", createdAt: new Date().toISOString(), createdBy: "Sam", notes: 0 } as FeedbackLink);
    },
    async revokeFeedbackLink(id: string) {
      return ok({ id, token: "x", url: "", world: homeWorld(), who: "", product: "", campaign: "", createdAt: "", createdBy: "", revokedAt: new Date().toISOString(), notes: 0 } as FeedbackLink);
    },
    async markTestersSeen() {
      return ok({ ok: true, marked: 0 });
    },
    async makeTesterWorld(signupId: string, payment?: TesterPayment) {
      return ok({ signupId, worldId: "es-mock-0000", payment: payment ?? "comped", steps: [] } as TesterWorldResult);
    },
    async removeTesterWorld(_id: string, confirm: string) {
      return ok({ worldId: confirm, removed: {} });
    },
    async listTeamServices() {
      return ok({ world: homeWorld(), worlds: [homeWorld()], canEdit: true, catalog: [{ id: "team-gmail", kind: "email" as const, label: "team-gmail: an email account" }], services: mockServices() });
    },
    async addTeamService(input: AddTeamServiceInput) {
      const key = input.key || input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (mockSvcs.some((x) => x.key === key)) throw new Error(`a service called "${key}" exists already in this world: pick another short name`);
      const id = `svc_${Math.random().toString(16).slice(2, 14)}`;
      const name = `MCP_${key.toUpperCase().replace(/-/g, "_")}`;
      mockSvcs.push(
        input.kind === "remote"
          ? { id, key, kind: "remote", kindLabel: "Remote MCP server", world: homeWorld(), builtin: false, config: { url: input.url, header: input.header || "Authorization" }, capabilities: ["use"], secrets: [secret("token", "Token or API key (sent in the header)", `${name}_TOKEN`, undefined, { optional: true })], name: input.name, what: `MCP server at ${input.url}`, scope: "the server's own tools", server: "services-hub", enforcement: "console server", connect: "paste its token below", status: { state: "unchecked" as const, detail: "not checked yet" } }
          : { id, key, kind: "email", kindLabel: "Email account (catalog server team-gmail)", world: homeWorld(), builtin: false, config: { address: input.address, catalog: "team-gmail" }, capabilities: ["read", "draft"], secrets: [secret("password", "App password", `${name}_PASSWORD`)], name: input.name, what: `Email account ${input.address}`, scope: "read, draft", server: "services-hub", enforcement: "console server", connect: "an app password", status: { state: "not_connected" as const, detail: "not signed in: paste the account's app password below" } },
      );
      emit();
      return ok({ service: svc(id) });
    },
    async removeTeamService(id: string) {
      const s = svc(id);
      if (s.builtin) throw new Error(`${s.name} is built in: switch personas off instead`);
      mockSvcs = mockSvcs.filter((x) => x.id !== id);
      emit();
      return ok({ removed: id, secretsRemoved: (s.secrets ?? []).filter((x) => x.set).map((x) => `${x.app} ${x.name}`) });
    },
    async setServiceSecret(id: string, field: string, value: string) {
      if (!value.trim()) throw new Error("paste the secret first");
      const s = mockSvcs.find((x) => x.id === id)!;
      s.secrets = (s.secrets ?? []).map((x) => (x.field === field ? { ...x, set: true, setAt: stamp() } : x));
      s.status = s.kind === "remote" ? { state: "error", detail: "the server answered HTTP 404", checkedAt: stamp() } : { state: "error", detail: "sign-in failed", checkedAt: stamp() };
      emit();
      return ok({ service: svc(id) });
    },
    async removeServiceSecret(id: string, field: string) {
      const s = mockSvcs.find((x) => x.id === id)!;
      s.secrets = (s.secrets ?? []).map((x) => (x.field === field ? { ...x, set: false, setAt: undefined } : x));
      emit();
      return ok({ service: svc(id) });
    },
    async testTeamService(id: string) {
      const s = mockSvcs.find((x) => x.id === id)!;
      s.status = { ...s.status, checkedAt: stamp() };
      return ok(svc(id));
    },
    // the team skills library, as the server serves it (used-by from the mock personas).
    async listTeamSkills() {
      const names = new Set(mockSkills.map((x) => x.name));
      return ok({
        skills: mockSkills.map((x) => ({ ...x, usedBy: db.personas.filter((p) => p.skills.includes(x.name)).map((p) => ({ id: p.id, name: p.name })) })),
        unknown: db.personas.flatMap((p) => p.skills.filter((sk) => !names.has(sk)).map((skill) => ({ skill, persona: { id: p.id, name: p.name } }))),
        canEdit: true,
        syncNote: TEAM_SKILLS_SYNC_NOTE,
      });
    },
    async previewTeamSkill(input: { url: string; name?: string; useWhen?: string }) {
      const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/[^/]+\/(.+))?$/.exec(input.url.trim());
      if (!m) throw new Error("url: a GitHub URL, https://github.com/<owner>/<repo>[/tree/<ref>/<path>]");
      const name = input.name || (m[3] ?? m[2]).split("/").pop()!.toLowerCase();
      const source = { type: "github" as const, repo: `${m[1]}/${m[2]}`, commit: "ca45fc496a3436251f191354091d557da31c15b5", ...(m[3] ? { path: m[3] } : {}) };
      return ok({ skill: { name, use_when: input.useWhen || `${name} work (mock description)`, source }, url: `https://github.com/${source.repo}/tree/${source.commit}${m[3] ? `/${m[3]}` : ""}`, description: `The ${name} skill (mock SKILL.md description).`, action: mockSkills.some((x) => x.name === name) ? ("repinned" as const) : ("added" as const), skillMdName: name });
    },
    async addTeamSkill(input: { url: string; name?: string; useWhen?: string; commit?: string }) {
      const p = await self.previewTeamSkill(input);
      const i = mockSkills.findIndex((x) => x.name === p.skill.name);
      const entry = { name: p.skill.name, useWhen: p.skill.use_when, source: p.skill.source, url: p.url };
      if (i >= 0) mockSkills[i] = entry;
      else mockSkills.push(entry);
      emit();
      return ok({ action: p.action, skill: p.skill, sha: "abc1234", sync: [{ host: "host1" as const, ok: true, note: "synced" }, { host: "host3" as const, ok: true, note: "synced" }], syncNote: TEAM_SKILLS_SYNC_NOTE });
    },
    async removeTeamSkill(name: string, confirm?: boolean) {
      const users = db.personas.filter((p) => p.skills.includes(name));
      if (users.length && !confirm) throw Object.assign(new Error(`${name} is attached to ${users.map((p) => p.name).join(", ")}: confirm to remove it from the library and from them`), { code: "in_use" });
      mockSkills = mockSkills.filter((x) => x.name !== name);
      for (const p of users) p.skills = p.skills.filter((x) => x !== name);
      emit();
      return ok({ removed: name, sha: "abc1235", detachedFrom: users.map((p) => ({ id: p.id, name: p.name })), sync: [{ host: "host1" as const, ok: true, note: "synced" }], syncNote: TEAM_SKILLS_SYNC_NOTE });
    },
    async setServiceAccess(serviceId: string, personaId: string, allowed: boolean, capability?: string) {
      serviceAccess.set(`${capability && capability !== "read" && capability !== "use" ? `${serviceId}.${capability}` : serviceId}:${personaId}`, allowed);
      emit();
      return ok(svc(serviceId));
    },
    async setMailSettings(input: { recipients: "owner" | "anyone" } | { personaId: string; dailyCap: number }) {
      if ("recipients" in input) mailRecipients = input.recipients;
      else mailCaps.set(input.personaId, input.dailyCap);
      return ok(mockMail());
    },
    async pollTeamMailbox() {
      return ok({ posted: 0, ignored: 0, inbox: mockMail().inbox });
    },
    async listStepKeyPastes() {
      return { log: [] };
    },
    async getTeamLogins() {
      return { ask: "T1-A1", app: "agent-team-browser-signin", accounts: [], log: [] };
    },
    async listConnects() {
      return ok({
        connects: [
          {
            id: "sam-youtube",
            title: "Connect Sam YouTube",
            what: "The team posts Sam's approved Shorts and reads their views and comments.",
            account: "sam@example.com",
            channel: { name: "Sam", handle: "@SamShorts", id: "UC0000000000000000000001" },
            gives: ["upload videos", "manage videos and comments", "read the channel", "read the channel's numbers"],
            connected: false,
            startUrl: "about:blank",
            inbox: true,
          },
        ],
      });
    },
    async getMemoryCard(world?: string) {
      return ok(mockMemory(world));
    },
    async connectMemory() {
      return ok({ url: "about:blank" });
    },
    async setMemorySettings(input: { desk?: string; filter?: "all" | "team" }, world?: string) {
      Object.assign(memoryMock, input);
      return ok(mockMemory(world));
    },
    async testMemory(world?: string) {
      return ok({ ok: true, message: "Arrived on Team desk in 0.4 s, marked test", card: mockMemory(world) });
    },
    async disconnectMemory(world?: string) {
      memoryMock.state = "not_connected";
      return ok({ ok: true, message: "disconnected", card: mockMemory(world) });
    },
    async getApprovals(milestoneId: string) {
      return ok(approvalsView(milestoneId));
    },
    async addApproval(milestoneId: string, input: GrantInput) {
      const code = approvalsView(milestoneId).nextCode!;
      const x: ApprovalGrant = { code, who: "Sam", scope: input.scope, limits: input.limits ?? null, expires: input.expires || "never", context: input.context ?? null,
        since: stamp().slice(0, 10), state: "active", source: "docs/spines/milestone.md", inherited: false, uses: 0, useRows: [] };
      grantsOf(milestoneId).splice(grantsOf(milestoneId).filter((g) => !g.inherited).length, 0, x);
      emit();
      return grantWrite(milestoneId, x);
    },
    async editApproval(milestoneId: string, code: string, input: GrantInput) {
      const x = grantsOf(milestoneId).find((g) => g.code === code);
      if (!x) throw new NotFoundError(`grant ${code} is not in force on this milestone`);
      if (x.state === "revoked") throw Object.assign(new Error(`grant ${code} is revoked: add a new grant instead`), { code: "conflict" });
      Object.assign(x, { scope: `${input.scope.replace(/\s*\(edited [\d-]+\)$/, "")} (edited ${stamp().slice(0, 10)})`, limits: input.limits ?? null, expires: input.expires || "never", state: "active" });
      emit();
      return grantWrite(milestoneId, x);
    },
    async revokeApproval(milestoneId: string, code: string, why: string) {
      const x = grantsOf(milestoneId).find((g) => g.code === code);
      if (!x) throw new NotFoundError(`grant ${code} is not in force on this milestone`);
      if (x.state === "revoked") throw Object.assign(new Error(`grant ${code} is revoked already`), { code: "conflict" });
      Object.assign(x, { state: "revoked", revoked: stamp().slice(0, 10), why: why || "revoked by Sam", since: null });
      emit();
      return grantWrite(milestoneId, x);
    },
    async wakeVps3() {
      if (vps3Wake.state === "waking") return ok({ started: false, wake: { ...vps3Wake } });
      const startedAt = now().toISOString();
      vps3Wake = { state: "waking", startedAt };
      if (simulateRunMs > 0)
        setTimeout(() => {
          vps3Wake = { state: "ok", startedAt, finishedAt: now().toISOString() };
          listeners.forEach((l) => l());
        }, simulateRunMs);
      return ok({ started: true, wake: { ...vps3Wake } });
    },

    async listAuthSites() {
      return ok(authSites);
    },
    async authReach() {
      return ok({ sources: [{ world: homeWorld(), own: true, sites: authSites }] });
    },
    async listSignedInCheck() {
      return ok([]);
    },
    async listEgress() {
      return ok([{ name: "laptop", state: "online" as const, since: new Date(Date.now() - 3 * 3600_000).toISOString(), whenDown: "hold" }]);
    },
    async clearAuthSite(sid) {
      const i = authSites.findIndex((x) => x.id === sid);
      if (i < 0) throw new NotFoundError(`site ${sid} not found`);
      authSites.splice(i, 1);
      return ok(undefined);
    },
    async startAuthSync({ patterns, browser, profile }) {
      const token = `as${Date.now().toString(16)}${(seq++).toString(16)}`.padEnd(34, "0");
      const base = typeof location === "undefined" ? "http://127.0.0.1:8750" : location.origin;
      const s: AuthSync = {
        token,
        status: "pending",
        patterns,
        browserHint: browser,
        createdAt: stamp(),
        expiresAt: new Date(now().getTime() + 10 * 60_000).toISOString(),
        command: `curl -sSL ${base}/auth-sync/${token}.sh | sh`,
        scriptUrl: `${base}/auth-sync/${token}.sh`,
        ...(profile ? { targetProfile: profile } : {}),
      };
      syncs.set(token, s);
      return ok(s);
    },
    async getAuthSync(token) {
      const s = syncs.get(token);
      if (!s) throw new NotFoundError("unknown sync token");
      if (s.status === "pending" && simulateRunMs > 0 && now().getTime() - new Date(s.createdAt).getTime() > simulateRunMs) {
        s.status = "synced";
        s.result = { browser: "Chrome", profile: "Profile 3", profileName: homeWorld(), sites: [] };
        for (const pattern of s.patterns) {
          const site: AuthSite = {
            id: `site-${pattern}`,
            pattern,
            domains: [pattern.replace(/^\*\./, "").replace(/\.\*$/, ".com")],
            cookieCount: 12,
            earliestExpiry: new Date(now().getTime() + 30 * 86_400_000).toISOString(),
            sourceBrowser: "Chrome",
            sourceProfile: `${homeWorld()} (Profile 3)`,
            syncedAt: stamp(),
          };
          authSites.splice(0, authSites.length, ...authSites.filter((x) => x.id !== site.id), site);
          s.result.sites.push({ id: site.id, pattern, cookieCount: site.cookieCount, domains: site.domains });
        }
      }
      return ok(s);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return self;
}

/** Mock tree: the milestone as root, its tickets as leaves (color from the normalised ticket status). */
/** Same fallback order as the server (adapters/outcome.ts deriveVerdict), without the tree / parked inputs. */
export function mockVerdict(m: Milestone): NonNullable<Milestone["verdict"]> {
  if (m.outcome?.verdict) return { word: m.outcome.verdict, source: "outcome" };
  const d = m.dod;
  if (m.status === "done" && d && d.tracked !== false && d.total > 0 && d.done === d.total)
    return { word: "accomplished?", source: "derived", note: "unconfirmed: no ## Outcome written" };
  if (m.status === "superseded") return { word: "superseded", source: "derived", note: "unconfirmed: no ## Outcome written" };
  // text naming the owner alone is not "blocked on the owner" (red); only open items are (the server status).
  return { word: "in progress", source: "derived" };
}

export function mockTree(m: Milestone, tickets: Ticket[]): MilestoneTree {
  const color = (status: string, detail?: string): TreeColor =>
    status === "done" ? "green" : status === "active" || status === "dispatched" ? "blue" : status === "blocked" ? (/sam|approv/i.test(detail ?? "") ? "red" : "yellow") : "grey";
  const children: TreeNode[] = tickets.map((t) => ({
    key: `${m.id}/${t.id}`,
    id: t.id,
    kind: "ticket",
    title: t.title,
    status: t.statusDetail ?? t.status,
    color: color(t.status, t.statusDetail),
    ...(t.path ? { path: t.path } : {}),
    children: [],
    flags: t.status === "—" ? ["unknown-status"] : [],
  }));
  const rootColor = color(m.status === "review" || m.status === "testing" ? "active" : m.status ?? "", m.blockedReason);
  const root: TreeNode = { key: m.id, id: m.id, kind: "spine", title: m.title, status: m.status ?? "unknown", color: rootColor, path: m.path, children, flags: [] };
  const counts: Record<TreeColor, number> = { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 };
  for (const n of [root, ...children]) counts[n.color]++;
  const nonGreen = counts.grey + counts.blue + counts.yellow + counts.red;
  return { milestoneId: m.id, root, counts, nonGreen, closed: 0, flagged: children.filter((c) => c.flags.length).length, source: "fallback", warnings: [] };
}

/** the tree re-rooted at `nodeKey` with recounted colors (the server's subtree). */
export function mockSubtree(t: MilestoneTree, nodeKey?: string): MilestoneTree {
  if (!nodeKey) return t;
  const findKey = (n: TreeNode): TreeNode | undefined => (n.key === nodeKey ? n : n.children.map(findKey).find(Boolean));
  const root = findKey(t.root);
  if (!root) throw new NotFoundError(`node ${nodeKey} not found`);
  const counts: Record<TreeColor, number> = { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 };
  let flagged = 0;
  const walk = (n: TreeNode) => {
    counts[n.color]++;
    if (n.flags.length) flagged++;
    n.children.forEach(walk);
  };
  walk(root);
  return { ...t, root, counts, nonGreen: counts.grey + counts.blue + counts.yellow + counts.red, closed: 0, flagged };
}

/** the mock's sample launch board (two products, one red each with its owner). */
const SAMPLE_LAUNCH: import("./types").LaunchBoard = {
  checkedAt: "2026-11-10T06:40:00Z",
  nextAt: "2026-11-10T07:10:00Z",
  greens: 3,
  total: 5,
  ownerRule: "Sample. Who fixes a red: the open row or ask named on the light; its epic owns it and its assignee does it.",
  drafts: [],
  products: (["epicteam", "socialapp"] as const).map((id) => ({
    id,
    name: id === "epicteam" ? "EpicTeam" : "SocialApp",
    site: `https://${id}.app/`,
    greens: id === "epicteam" ? 2 : 1,
    total: id === "epicteam" ? 3 : 2,
    lights: [
      { group: "Website", label: `${id}.app answers`, state: "green" as const, seen: "answered 200", kind: "http" },
      ...(id === "epicteam" ? [{ group: "Health", label: "The app says it is healthy", state: "green" as const, seen: "status: ok", kind: "json" }] : []),
      {
        group: "Sign-up and sign-in",
        label: "Google or GitHub sign-in is set up",
        state: "red" as const,
        seen: "signInMethods: none",
        kind: "json",
        fix: "Claude on Sam's Mac makes the two sign-in apps.",
        codes: [{ code: "E988-A1", kind: "ask" as const, text: "E988-A1", state: "open ask, waits on Sam", open: true, who: "Sam" }],
        owner: {
          by: "row" as const,
          who: "Sam, with Claude on his Mac",
          epic: { code: "EPIC-988", title: "Customer one", file: "docs/spines/customer-one.md", deck: "/deck/home_repo/EPIC-988" },
          next: null,
          capability: { key: "product", what: "sign-up", epic: null },
          why: "E988-A1 is Sam's open ask, a Mac agent ticket on his Mac list.",
        },
      },
    ],
  })),
};

/** the mock world's wheel notes. */
const SAMPLE_WHEEL_NOTES: import("./company-types").WheelNote[] = [
  { id: "vn_5a1e0c2b", company: "memo", wheel: "build", at: "2026-11-11T06:20:00Z", via: "voice", words: "The memory search should show where each memory came from, the voice note or the chat.", desk: "team" },
  { id: "wn_m0ck0001", company: "memo", wheel: "promo", at: "2026-11-11T05:40:00Z", via: "text", words: "Post the cloud launch thread on Friday morning.", desk: "team" },
];

/** the mock world's companies (the real list is docs/companies.json of the code repo). */
const SAMPLE_COMPANIES: import("./company-types").Company[] = [
  {
    id: "memo",
    name: "Memo",
    line: "Open-source memory for AI agents.",
    first: true,
    lane: "A lane in EpicTeam",
    wheels: {
      build: { sources: [{ repo: "memo" }], links: [] },
      promo: {
        sources: [],
        accounts: [
          { repo: socialWorld(), account: "@MemoryApp", platform: "x", site: "memo.example.com" },
          { repo: socialWorld(), account: "u/jordimr", platform: "reddit" },
        ],
        links: [{ label: "SocialApp", url: "https://social.example.com/" }],
      },
      ops: { sources: [{ repo: "ops" }], links: [{ label: "EpicBooks", url: "https://books.example.com/" }] },
    },
  },
];

/** a sample the social product world's open items, as GET /api/worlds shapes them. */
const SAMPLE_WORLDS: import("./company-types").WorldInbox[] = [
  {
    tenantId: socialWorld(),
    tenantName: "Memo social",
    app: "SocialApp",
    appUrl: "https://cloud.social.example",
    items: [
      { key: "ask:zs_a1", kind: "ask", id: "zs_a1", title: "Which of the two Reddit openings for the tester call?", repo: socialWorld(), code: "EPIC-906-A2", level: "high", since: "2026-11-10", milestoneId: "ms_zs1", project: "Memo testers", openUrl: "https://cloud.social.example/milestones/ms_zs1?tab=waiting&item=zs_a1" },
      { key: "review:zs_r1", kind: "review", id: "zs_r1", title: "Day in the life on Reddit is pinned with its twelve assignments.", repo: socialWorld(), code: "E900-S60", since: "2026-11-11", milestoneId: "ms_zs2", project: "Day in the life", openUrl: "https://cloud.social.example/" },
    ],
    // the world's live campaigns with their one number (the owner's Inbox lines, goal talk and since yesterday).
    campaigns: [
      { name: "Reddit awareness", milestoneId: "ms_zs3", openUrl: "https://cloud.social.example/milestones/ms_zs3", digest: { date: new Date().toISOString().slice(0, 10), line: "3 Reddit replies on our threads and 2 outreach comments went out; no post on X." } },
      { name: "Day in the life", milestoneId: "ms_zs2", sentence: "People see a real day of an AI team at work.", metric: { label: "replies received", target: 100, now: 0, by: "2026-12-10", proposed: true, was: 0 }, openUrl: "https://cloud.social.example/milestones/ms_zs2" },
      { name: "Memo testers", milestoneId: "ms_zs1", sentence: "Ten testers use Memo every day.", metric: { label: "testers signed up", target: 10, now: 1, by: "2026-11-22", proposed: false, was: 0 }, openUrl: "https://cloud.social.example/milestones/ms_zs1", digest: { date: new Date().toISOString().slice(0, 10), line: "3 Reddit replies on our threads and 2 outreach comments went out; no post on X." } },
    ],
  },
];

/** a sample of the Operations numbers (support, spend and revenue unread, as on the real console today). */
const SAMPLE_OPS: import("./company-types").CompanyOps = {
  company: "memo",
  week: { from: "2026-11-05", to: "2026-11-11" },
  sites: [
    { url: "https://memo.example.com/", host: "memo.example.com", uptime: { n: 99.9, note: "2016 checks of memo.example.com, one every 5 minutes." }, down: { n: 5, note: "2016 checks of memo.example.com, one every 5 minutes." }, last: { at: "2026-11-11T07:30:00Z", status: 200, ok: true } },
    { url: "https://cloud.memo.example.com/", host: "cloud.memo.example.com", uptime: { n: 100, note: "2016 checks of cloud.memo.example.com, one every 5 minutes." }, down: { n: 0, note: "2016 checks of cloud.memo.example.com, one every 5 minutes." }, last: { at: "2026-11-11T07:30:00Z", status: 200, ok: true } },
  ],
  visits: { n: 142, change: 31, note: "Our own counter on memo.example.com, crawlers and tests left out." },
  conversions: { n: 6, change: 2, note: "Sign-ups on memo.example.com, tests left out." },
  support: { n: null, note: "No support mailbox is read yet: the read-only mail reader is still being built, so support mails cannot be counted." },
  spend: { n: null, note: "EpicBooks is paused on HOST1 (books.example.com answered 502 at 11 Nov 07:30 UTC), so its spend and revenue cannot be read until it runs again." },
  revenue: { n: null, note: "EpicBooks is paused on HOST1 (books.example.com answered 502 at 11 Nov 07:30 UTC), so its spend and revenue cannot be read until it runs again." },
};

/** a sample of the Build numbers read from the ledgers. */
const SAMPLE_BUILD: import("./company-types").CompanyBuild = {
  company: "memo",
  week: { from: "2026-11-04T07:30:00Z", to: "2026-11-11T07:30:00Z" },
  open: { n: 9, review: 2, note: "Rows not done, superseded, cancelled or moved in 12 ledgers of memo." },
  shipped: { n: 3, note: "Rows whose status reached review or done in the last 7 days, by the git log of their spines." },
  bugs: { n: 1, note: "Of those, the rows whose title names a bug or a fix." },
  freshness: { n: 5, at: "2026-11-11T02:30:00Z", note: "The newest change to these ledgers: 11 Nov 02:30 UTC in memo." },
  rows: [
    { repo: "memo", path: "docs/spines/voice.md", id: "Z9-S3", title: "Voice notes without audio are stored as text", status: "review", at: "2026-11-10T21:00:00Z", bug: false },
    { repo: "memo", path: "docs/spines/cloud.md", id: "Z4-S12", title: "Fix the vault count after a restore", status: "done (approved by Sam 2026-11-09)", at: "2026-11-08T12:00:00Z", bug: true },
    { repo: "memo", path: "docs/spines/cloud.md", id: "Z4-S11", title: "Sign-in page shows the plan", status: "done (approved by Sam 2026-11-07)", at: "2026-11-06T10:00:00Z", bug: false },
  ],
  spines: [{ repo: "memo", paths: ["docs/spines/cloud.md", "docs/spines/voice.md"] }],
};

/** his four building lists as the server reads them (docs/building.json + the spines). */
const SAMPLE_VOICE_NOTES: import("./pages-types").VoiceNotesBody = {
  generatedAt: "2026-11-12T20:00:00Z",
  windowHours: 48,
  counts: { delivered: 1, open: 1 },
  products: { alpha: 1, beta: 1 },
  productNames: { alpha: "Alpha", beta: "Beta" },
  notes: [
    {
      ref: "Log/2026-11-12.md#^e-aaaaaa", key: "e-aaaaaa", vn: "vn_sample01", source: "mcp", app: "Chat", at: "2026-11-12T19:00:00Z",
      words: "Can the buttons on the cards say what they do?", chars: 46, products: ["alpha"], state: "open",
      rows: [{ code: "E948-S1", repo: "home_repo", spine: "docs/spines/epic-948.md", epic: "EPIC-948", status: "ready", title: "Card buttons say what they do", via: "row" }],
    },
    {
      ref: "Log/2026-11-12.md#^e-bbbbbb", key: "e-bbbbbb", source: "whatsapp", app: "WhatsApp", at: "2026-11-12T18:00:00Z",
      words: "Posts in Beta should go out on time.", chars: 36, products: ["beta"], state: "delivered",
      rows: [{ code: "E946-S4", repo: "home_repo", spine: "docs/spines/epic-946.md", epic: "EPIC-946", status: "done (approved)", title: "Posts on time", via: "row" }],
    },
  ],
};
const SAMPLE_PAGES: import("./pages-types").PagesBody = {
  total: 2,
  pinned: [{ port: 9242, url: "http://pages.example:9242/", title: "The daily reports", name: "Daily reports", pinned: true, slug: "daily", refresh: "daily.service", row: "E904-S6", repo: "team", epic: "EPIC-904" }],
  groups: [
    {
      id: "team-EPIC-904",
      repo: "team",
      epic: "EPIC-904",
      epicTitle: "Talk to the desk",
      pages: [
        { port: 9241, url: "http://pages.example:9241/", title: "What we did this week", row: "E904-S7", repo: "team", epic: "EPIC-904" },
        { port: 9242, url: "http://pages.example:9242/", title: "The daily reports", row: "E904-S6", repo: "team", epic: "EPIC-904" },
      ],
    },
  ],
};

const SAMPLE_OUTCOMES: import("./outcome-types").OutcomeLine[] = [
  { at: "2026-11-12T22:40:00.000Z", day: "2026-11-12", kind: "delivered", text: "The One-offs page is live beside Pursuits.", row: "E907-S21", product: "EpicTeam", persona: "Ticket worker", repo: "app", source: "run", link: "https://team.example/one-offs" },
  { at: "2026-11-12T21:10:00.000Z", day: "2026-11-12", kind: "learning", text: "L-60 added: one page per deliverable.", row: "E907-S19", product: "EpicTeam", persona: "Delivery manager", repo: "app", source: "backfill" },
];
const SAMPLE_ONE_OFFS: import("./oneoff-types").OneOffsBody = {
  spine: "docs/spines/one-offs.md",
  deliveredDays: 7,
  counts: { filed: 0, "in work": 1, stuck: 0, "your card": 0, delivered: 0, parked: 0 },
  oneOffs: [
    {
      id: "E938-S10",
      name: "Glass dispute, a note to the host and one to the site",
      detail: "Write both notes from his voice note: honest, calm, firm.",
      stage: "in work",
      status: "active",
      epic: { repo: "app", path: "docs/spines/epic-938-rentals.md", code: "EPIC-938", title: "Airbnb acts" },
      source: { ref: "Log/2026-11-12.md#^e-5bc524" },
      next: "worker writes both notes",
      date: "2026-11-12",
    },
  ],
};
const SAMPLE_TEAM_CARDS: import("./teamcard-types").TeamCard[] = [
  {
    id: "tc_sample_digest",
    kind: "digest",
    scorecard: "sample-testers",
    scorecardName: "5 testers using SocialApp",
    by: "Performance",
    at: "2026-11-13T13:00:00Z",
    day: "2026-11-13",
    title: "5 testers using SocialApp went greener: 3 of 7 lines green, up from 2.",
    digest: { greens: 3, total: 7, prevGreens: 2, prevTotal: 7, prevDay: "2026-11-12", trend: "greener", reasons: [{ text: "Two people applied to be testers", url: "https://example.com/testers/" }, { text: "The call went out on X" }] },
  },
  {
    id: "tc_sample_idea",
    kind: "idea",
    scorecard: "sample-testers",
    scorecardName: "5 testers using SocialApp",
    by: "Strategist",
    at: "2026-11-13T13:05:00Z",
    day: "2026-11-13",
    title: "Invite the five people who replied last week straight to a call.",
    idea: { gain: "Testers a week sooner", recommend: "Do it this week: the team writes the invites, you send none." },
  },
  {
    id: "tc_sample_goal",
    kind: "goal",
    scorecard: "sample-memory",
    scorecardName: "Memory live",
    by: "Gap finder",
    at: "2026-11-13T13:10:00Z",
    day: "2026-11-13",
    title: "Memory live has no number for paying users yet.",
    goal: { unset: "How many paying users, by when", options: [{ goal: "3 paying users by December 1", number: "3" }, { goal: "10 paying users by December 15", number: "10" }], recommend: 0 },
  },
];

const SAMPLE_PURSUITS: import("./pursuit-types").PursuitsBody = {
  staleDays: 3,
  said: { source: "Log/2026-11-12.md#^e-1", words: "For me, the worst thing is the stale." },
  boardAt: "2026-11-12T04:30:00Z",
  pursuits: [
    {
      id: "product-live",
      name: "Memory product commercially live",
      greenWhen: "A stranger signs up, pays, and uses it every day.",
      state: "red",
      greens: 2,
      total: 4,
      lines: [
        { label: "The service is healthy", state: "green", value: "yes" },
        { label: "Sign-up works", state: "green", value: "yes" },
        { label: "One real payment went through", state: "red", value: "not yet", note: "One live payment is made." },
        { label: "Launch board", state: "amber", value: "10 of 15 lights" },
      ],
      totems: [
        { label: "Value proposition", url: "https://example.com/" },
        { label: "Product deck", url: "https://example.com/deck" },
        { label: "Social kit", missing: "Only the profile pictures exist so far" },
      ],
      motion: "moving",
      lastMove: { at: "2026-11-12T03:00:00Z", repo: "home_repo", subject: "Payment page built" },
      kit: true,
    },
    {
      id: "vault",
      name: "All secrets in the vault",
      greenWhen: "Every login sits in the vault.",
      state: "red",
      greens: 0,
      total: 2,
      lines: [
        { label: "Logins waiting to go into the vault", state: "red", value: "2 waiting" },
        { label: "Every new login lands in the vault", state: "red", value: "0 of 1 done" },
      ],
      totems: [{ label: "Account registry", url: "https://example.com/registry" }],
      motion: "stalled",
      lastMove: { at: "2026-11-07T10:00:00Z", repo: "home_repo", subject: "Registry updated" },
    },
  ],
};
/** the Products section: one product with its deck's four parts and its kit. */
const SAMPLE_PRODUCTS: import("./pursuit-types").ProductView[] = [
  {
    id: "sample",
    name: "Sample",
    url: "https://sample.example.com",
    tagline: "A sample product",
    deck: {
      repo: "sample-campaign",
      path: "data/product.md",
      title: "Sample: the product deck",
      parts: [
        { part: "Why it exists", label: "The problem it solves", body: "Work gets lost." },
        { part: "Who it is for", label: "Who it is for", body: "- Builders" },
        { part: "How it works", label: "How it works", body: "1. **Say it.**\n2. **Done.**" },
        { part: "What it does for you", label: "What it does for you", body: "- **You stop repeating yourself.**" },
      ],
      missing: [],
    },
    kit: true,
    wheels: [],
  },
];
const SAMPLE_KIT: import("./pursuit-types").SocialKit = {
  id: "sample",
  name: "Sample",
  link: "https://example.com",
  domain: "example.com",
  tagline: "Agents that post for you.",
  taglineSub: "You decide what it keeps.",
  avatar: { note: "The S on white; every platform crops it round." },
  page: { accent: "#7c3bed", ink: "#0e1f2c" },
  colours: [
    { name: "Violet", hex: "#7c3bed", use: "The mark and banners" },
    { name: "Ink", hex: "#0e1f2c", use: "Text on light grounds" },
  ],
  accounts: [{ platform: "X", handle: "@sample", url: "https://x.com/sample", state: "made 9 Nov" }],
  bios: [{ where: "X, 160 letters at most", text: "Agents that post for you." }],
  templates: [{ id: "news", title: "Something new shipped", w: 1600, h: 900, for: "X and LinkedIn" }],
  postTexts: [{ title: "Something new shipped", text: "New in Sample: {the one thing}." }],
  versions: [{ version: "1, current", date: "12 Nov 2026", what: "The first full kit." }],
};
const SAMPLE_BUILDING: import("./building-types").BuildingList[] = [
  {
    id: "memo",
    name: "Memo",
    line: "Open-source memory for AI agents, hosted at cloud.memo.example.com.",
    repos: ["memo", socialWorld()],
    world: "Memo's SocialApp",
    open: { label: "cloud.memo.example.com", url: "https://cloud.memo.example.com/" },
    waits: { asks: 6, review: 5 },
    repoWaits: { memo: { asks: 3, review: 2 }, [socialWorld()]: { asks: 3, review: 3 } },
    campaigns: [
      { repo: socialWorld(), code: "EPIC-906", name: "Memo testers", path: "docs/spines/recruit-testers.md", status: "active", platform: "Reddit", deck: null, waits: { asks: 1, review: 0 } },
      { repo: socialWorld(), code: "EPIC-915", name: "Day in the life on Reddit", path: "docs/spines/campaign-day-in-the-life.md", status: "ready", platform: "Reddit", deck: null, waits: { asks: 0, review: 0 } },
    ],
  },
  { id: "epicteam", name: "EpicTeam", line: "The team of personas that builds with you, in this console.", repos: ["home_repo"], waits: { asks: 12, review: 23 }, repoWaits: { home_repo: { asks: 12, review: 23 } }, campaigns: [] },
  {
    id: "socialapp",
    name: "SocialApp",
    line: "The social team that runs campaigns for a product.",
    repos: ["campaign-app"],
    world: "SocialApp",
    waits: { asks: 0, review: 0 },
    repoWaits: { "campaign-app": { asks: 0, review: 0 } },
    campaigns: [{ repo: "campaign-app", code: "EPIC-901", name: "Get testers", path: "docs/spines/campaign-get-testers.md", status: "ready", platform: null, deck: null, waits: { asks: 0, review: 0 } }],
  },
  { id: "flywheel", name: "The Flywheel", line: "Data products that run on their own.", repos: ["airbnb-observatory", "deal-funnels"], waits: { asks: 1, review: 5 }, repoWaits: { "airbnb-observatory": { asks: 0, review: 4 }, "deal-funnels": { asks: 1, review: 1 } }, campaigns: [] },
];

/** a plan with nothing written: every one of the eight sections, "not written yet". */
function unwrittenPlan() {
  const titles = ["Goal and numbers", "Who", "Messages", "Channels", "Offer", "This week's test", "Budget", "How we measure and change"];
  const keys = ["goal", "who", "messages", "channels", "offer", "test", "budget", "measure"] as const;
  return { source: "none" as const, path: "docs/spines/root.md", repo: "demo", line: null, missing: titles, sections: keys.map((key, i) => ({ key, title: titles[i], written: false, lead: null, boxes: [], table: null, quotes: [] })) };
}
