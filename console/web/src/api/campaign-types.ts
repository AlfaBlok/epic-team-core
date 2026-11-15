import type { Cadence } from "./types";

/** GET /api/tenants/:id/campaigns, one card per world repo with `Pack: social`. */
export interface CampaignCard {
  repo: string;
  /** GitHub `owner/name` of its origin. */
  remote?: string;
  title: string;
  /** The world's milestone on the repo (its campaign home); null = the pack is on but no milestone tracks it. */
  milestoneId: string | null;
  postsThisWeek: number;
  live: number;
  held: number;
  nextPost: { id: string | null; slot: string; platform: string | null; title: string | null } | null;
  /** Pack export warnings (bad rows); shown as a count. */
  warnings: number;
  /** the newest daily digest, for the focus card's post line. */
  latestDigest?: { date: string; line: string } | null;
  /** a named campaign inside the repo (a child epic with a plan; its numbers count only its rows); absent = the repo itself. */
  campaign?: CampaignRef;
  /** retired (paused, hidden from the sidebar); Restore brings it back. */
  retired?: boolean;
  /** live (posting) or not, and why, in one plain line. */
  posting?: { live: boolean; line: string };
  /** its one goal and the number toward it, read from its spine (server social/campaignGoal.ts). */
  goal?: CampaignGoal;
  /** what waits on the owner here: open asks in its spine and posts held for his Approve. */
  waiting?: { asks: { code: string | null; question: string }[]; held: number; line: string };
  /** per channel the account, its sign-in, cadence, what we post and the summed counts of its posts with the trend. */
  channels?: CampaignChannel[];
  /** the product it is for (the one product list, or its spine's `Product:` line); its words are read there, never copied. */
  product?: { id: string; name: string };
}
export interface ChannelTotals {
  views: number | null;
  likes: number | null;
  replies: number | null;
}
/** one channel of a campaign (server social/campaignRollup.ts). */
export interface CampaignChannel {
  key: string;
  name: string;
  account: string | null;
  signIn: { state: "green" | "amber" | "red" | "grey"; line: string };
  cadence: string | null;
  what: string | null;
  posts: number;
  replyRows: number;
  totals: ChannelTotals | null;
  readLine: string;
  readAt: string | null;
  trend: (ChannelTotals & { since: string }) | null;
  history: (ChannelTotals & { date: string; posts: number })[];
}
/** a campaign's one goal (`Goal sentence:`) and its number (`Metric:` line); the EpicTeam home reads the same. */
export interface CampaignGoal {
  sentence: string | null;
  metric: { label: string; target: number; now: number | null; by: string | null; proposed: boolean; source: string | null } | null;
  line: string;
}
/** a named campaign: its epic code (the ledger's Campaign value, kept on rename), name, spine, platform and period. */
export interface CampaignRef {
  code: string;
  name: string;
  path: string;
  platform: string | null;
  period: string | null;
  /** the campaign's strategy deck (the plan's `Deck:` line), or null. */
  deck?: string | null;
}
export interface CampaignList {
  tenantId: string;
  campaigns: CampaignCard[];
}

/** GET /api/tenants/:id/campaigns/repos: checkouts the console knows that this world may make a campaign of. */
export interface CampaignRepo {
  name: string;
  remote?: string;
  hasPack: boolean;
  campaign: boolean;
}

/** The New campaign form (POST.../campaigns/preview and.../campaigns). */
export interface CampaignInput {
  repo: string;
  title?: string;
  objective?: string;
  keyMessages?: string[];
}

export interface CampaignTeamStep {
  role: string;
  template: string;
  action: "assign" | "exists";
  persona: { name: string; action: "create" | "reuse"; id?: string };
  cadence: Cadence;
  writeScope: string;
  assignmentId?: string;
}

/** What New campaign will do (preview) or did (create). */
export interface CampaignPlan {
  tenantId: string;
  repo: string;
  remote?: string;
  title: string;
  milestone: { action: "create" | "exists"; id?: string; path: string };
  spine: { action: "create" | "exists"; path: string };
  init: { action: "run" | "skip"; reason: string; files: string[] };
  brief: { action: "write" | "skip"; sections: string[] };
  team: CampaignTeamStep[];
  push: "push" | "no-remote" | "policy";
}
export interface CampaignResult extends CampaignPlan {
  milestoneId: string;
  commits: { step: "init" | "brief" | "approval"; commit: string; push: { state: string; detail?: string } }[];
}

/** POST /api/tenants/:id/jobs, a one-off job (Add job): a new spine in one of the world's repos, its milestone, a persona on it. */
export interface JobInput {
  repo: string;
  title: string;
  doneMeans: string[];
  personaId?: string;
  /** Add as draft (else ready: the owner's ask is his ready stamp, L-37). */
  draft?: boolean;
}
export interface JobResult {
  tenantId: string;
  repo: string;
  milestoneId: string;
  path: string;
  status: "ready" | "draft";
  commit: string;
  push: { state: string; detail?: string };
  assignmentId?: string;
}

/** POST /api/tenants/:id/campaigns/named, a named campaign inside a social repo (child epic + plan + milestone). */
export interface CampaignPlanFields {
  platform?: string;
  period?: string;
  keyMessages?: string[];
  voice?: string;
  postingStyle?: string;
  replyStyle?: string;
  /** the brief's set parts the owner named: format, cadence per channel, the action we want readers to take. */
  format?: string;
  cadence?: string;
  readerAction?: string;
  targets?: string;
  personas?: string;
  /** the campaign template's own parts: the frame, who it is for, the offer, two goals, the evening count. */
  frame?: string;
  who?: string;
  offer?: string;
  goals?: string;
  eveningCount?: string;
}
/** GET /api/tenants/:id/campaigns/template: the template every new campaign starts from. */
export interface CampaignTemplate {
  source: { name: string; url: string; said: string };
  parts: { key: keyof CampaignPlanFields; title: string; help: string; example: string }[];
  plan: CampaignPlanFields;
}
export interface NamedCampaignInput {
  repo: string;
  name: string;
  plan?: CampaignPlanFields;
  /** Pack roles that work it: each moves the repo's assignment holding the role (same persona and cadence). */
  roles?: string[];
  move?: boolean;
  /** start from the campaign template: its parts fill what the plan leaves empty, and the campaign gets its brief file. */
  template?: boolean;
}
export interface NamedCampaignResult {
  tenantId: string;
  repo: string;
  milestoneId: string;
  campaign: CampaignRef;
  commit: string;
  push: { state: string; detail?: string };
  team: { role: string; persona: string; assignmentId: string; from?: string; movedOff: boolean }[];
  skipped: string[];
}
