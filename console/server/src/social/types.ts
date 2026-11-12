/**
 * the social pack export (epicspine-skill `pack.py social --json`, contract in the skill's
 * references/packs.md "JSON export", schemaVersion 1) as typed TS: the console's ONE typed source for social data.
 * Field names are the schema's (not column headers). Every row carries `_line` (1-based line in its file, for the write
 * API). Empty cells are null; `refs` are arrays ([] when empty); enums are lower-cased strings (a value the schema
 * does not allow is kept as written and raised as a warning, so enum fields are typed `string`, with the known values
 * listed beside them). Computed back-links: carried_by, served_by, used_by, became.
 * Same shapes as core/console/web/src/api/types.ts ("Social pack export").
 */

export const SOCIAL_SCHEMA_VERSION = 1;

export type Weight = "over" | "normal" | "under" | "avoid";
/** posts.rows.status lifecycle (schema `lifecycles.post`). */
export const POST_STATES = ["idea", "draft", "scheduled", "posted", "measured", "held", "pulled", "expired"] as const;
export type PostState = (typeof POST_STATES)[number];
/** ideas.rows.state lifecycle (schema `lifecycles.idea`). */
/** ideas never expire, `new → open → spent`; picked up / drafted / posted are legacy, read as open. */
export const IDEA_STATES = ["new", "open", "spent", "picked up", "drafted", "posted", "parked", "epic"] as const;
export type IdeaState = (typeof IDEA_STATES)[number];

export interface PackWarning {
  /** Repo-relative file (or `pack.py` when the export itself failed). */
  file: string;
  /** 1-based line, null for a whole file or section. */
  line: number | null;
  message: string;
}

interface Row {
  _line: number;
}

export interface KeyMessage extends Row {
  id: string | null;
  message: string | null;
  weight: Weight | string | null;
  source: string | null;
  carried_by: string[];
}
export interface TopicWeight extends Row {
  topic: string | null;
  weight: Weight | string | null;
  why: string | null;
  source: string | null;
  since: string | null;
}
export interface FeedbackLogRow extends Row {
  date: string | null;
  from: string | null;
  feedback: string | null;
  landed: string | null;
  applied_by: string | null;
}
export interface FormatShare extends Row {
  /** text | thread | diagram | screenshot | demo clip | video */
  format: string | null;
  /** Percent as a number (40% → 40). */
  share: number | null;
  example: string | null;
}
export interface ExampleRow extends Row {
  link: string | null;
  verdict: "like" | "dislike" | string | null;
  why: string | null;
}
export interface HoldRule extends Row {
  id: string | null;
  match: string | null;
  why: string | null;
}

export interface SocialBrief {
  objective: string | null;
  targets: string | null;
  audience: string | null;
  key_messages: KeyMessage[];
  voice: string[];
  style_rules: string[];
  never_say: string[];
  topic_weights: TopicWeight[];
  feedback_log: FeedbackLogRow[];
  formats: FormatShare[];
  examples: ExampleRow[];
  hold_rules: HoldRule[];
  /** the benefits home, the owner's lines in his order; absent from an older export or a repo with none. */
  benefits?: BenefitLine[];
}

/** One line of the brief's `## Benefits` table: what the user gets, whether it works, the screen that shows it. */
export interface BenefitLine {
  id: string | null;
  benefit: string | null;
  /** works today | half built | not built */
  status: string | null;
  screen: string | null;
}

export interface WeekHighlight extends Row {
  id: string | null;
  highlight: string | null;
  why: string | null;
  until: string | null;
  served_by: string[];
}
export interface DoDont extends Row {
  kind: "do" | "don't" | string | null;
  rule: string | null;
  until: string | null;
}
export interface MonthPriority extends Row {
  id: string | null;
  priority: string | null;
  why: string | null;
  month: string | null;
  served_by: string[];
}
export interface SocialDirections {
  week: WeekHighlight[];
  do_dont: DoDont[];
  voice_note: string | null;
  month: MonthPriority[];
}

export interface Topic extends Row {
  rank: number | null;
  id: string | null;
  topic: string | null;
  where: string | null;
  link: string | null;
  heat: number | null;
  date: string | null;
  reply_target: boolean | null;
  used_by: string[];
}

export interface Idea extends Row {
  id: string | null;
  date: string | null;
  idea: string | null;
  format: string | null;
  platform: string | null;
  from: string | null;
  link: string | null;
  state: IdeaState | string | null;
  why: string | null;
  became: string[];
  /** its posts by platform (`{"Reddit": ["P-0060"]}`); absent from an older export. */
  used_on?: Record<string, string[]>;
  /** the number of the benefit (brief Benefits) the idea shows; empty until the Writer names it. */
  benefit?: string | null;
}

export interface Post extends Row {
  id: string | null;
  date: string | null;
  persona: string | null;
  /** post | reply | outreach */
  kind: "post" | "reply" | "outreach" | string | null;
  platform: string | null;
  /** the campaign this row counts toward (its epic code, e.g. ``); null = the repo itself (skill 2026.11.02.3). */
  campaign?: string | null;
  community: string | null;
  slot: string | null;
  title: string | null;
  text: string | null;
  format: string | null;
  assets: string[];
  topic: string | null;
  highlight: string | null;
  messages: string[];
  idea: string | null;
  checks: string | null;
  link: string | null;
  replies: number | null;
  metrics: string | null;
  result: string | null;
  feedback: string | null;
  status: PostState | string | null;
  /** the number of the one benefit (brief Benefits) the post shows. */
  benefit?: string | null;
  /** a held post whose slot has passed: Schedule gives it this next free slot. */
  nextSlot?: string;
}

export interface Asset extends Row {
  id: string | null;
  kind: "diagram" | "screenshot" | "clip" | "video" | "logo" | string | null;
  file: string | null;
  made_by: string | null;
  source: string | null;
  cuts: string | null;
  used_by: string[];
}

/** one conversation of `data/messages-ledger.md` › Chats (DMs are not posts). */
export interface ChatRow extends Row {
  id: string | null;
  platform: string | null;
  /** Ours: our own accounts. */
  account: string | null;
  /** The other person: u/name. */
  who: string | null;
  /** dm | chat request | pm */
  kind: string | null;
  link: string | null;
  campaign?: string | null;
  started: string | null;
  /** open | waiting | left | hidden | done (schema lifecycle `chat`). */
  state: string | null;
  reason: string | null;
  feedback: string | null;
  /** Computed: its message ids. */
  messages: string[];
}
/** one message in or out of `data/messages-ledger.md` › Messages. */
export interface MessageRow extends Row {
  id: string | null;
  chat: string | null;
  at: string | null;
  /** them | us */
  from: string | null;
  persona: string | null;
  text: string | null;
  answers: string | null;
  checks: string | null;
  feedback: string | null;
  result: string | null;
  /** received; ours draft → scheduled → posted, pulled, expired (schema lifecycle `message`). */
  status: string | null;
}

/** one line of `data/insights.md` › Insights (the Reporter's weekly pass). */
export interface InsightLine extends Row {
  id: string | null;
  insight: string | null;
  use: string | null;
  evidence: string | null;
  confidence: string | null;
  campaign?: string | null;
  since: string | null;
  /** active | retired */
  state: string | null;
}
/** a proposed My calls line (`data/insights.md` › Proposed calls); only the owner accepts or dismisses it. */
export interface ProposedCall extends Row {
  id: string | null;
  call: string | null;
  evidence: string | null;
  campaign?: string | null;
  since: string | null;
  /** proposed | accepted | dismissed */
  state: string | null;
}
/** one kept hot thread (`data/threads.md`). */
export interface ThreadRow extends Row {
  id: string | null;
  found: string | null;
  platform: string | null;
  community: string | null;
  title: string | null;
  link: string | null;
  why: string | null;
  numbers: string | null;
  visibility: number | null;
  campaign?: string | null;
  reply: string | null;
  /** watch | drafted | sent | skipped | cooled */
  state: string | null;
}

/** One `data/reports/{date}.md` (oldest first). */
export interface Report {
  date: string;
  path: string;
  numbers: string | null;
  best_worst: string | null;
  learned: string | null;
  highlights: string | null;
  feedback: string | null;
  cost: string | null;
}

/** Where each non-`many` section lives (`"brief.objective"`, `"posts.rows"`, …): what the write API saves. */
export interface SectionSource {
  path: string;
  heading: string | null;
  exists: boolean;
}

/** The whole `pack.py social --json` document. */
export interface SocialExport {
  schemaVersion: number;
  pack: "social" | string;
  packVersion: number;
  /** Absolute checkout path the export read. */
  repo: string;
  /** UTC, YYYY-MM-DDTHH:MM:SSZ. */
  generatedAt: string;
  warnings: PackWarning[];
  brief: SocialBrief;
  directions: SocialDirections;
  topics: Topic[];
  ideas: Idea[];
  posts: Post[];
  /** the messages ledger; empty when the repo has none (or an older skill exports none). */
  messages: { chats: ChatRow[]; messages: MessageRow[] };
  /** `data/insights.md`; absent from an older skill's export. */
  insights?: { lines: InsightLine[]; calls: ProposedCall[] };
  /** `data/threads.md`; absent from an older skill's export. */
  threads?: ThreadRow[];
  assets: Asset[];
  reports: Report[];
  sources: Record<string, SectionSource>;
}

/**
 * GET /api/tenants/:id/social[?repo=<name>]: the world's social data. `repo` = the world's repo it came from (null =
 * none of the world's repos is a social one; `data` is then an empty export). `data` is always a full export shape:
 * export failures, timeouts and bad output arrive as `data.warnings`, never as a 500.
 */
export interface SocialData {
  tenantId: string;
  repo: string | null;
  data: SocialExport;
  /** `?campaign=`: the campaign the posts were filtered to (only its rows are in data.posts). */
  campaign?: { code: string; name: string; path: string; platform: string | null; period: string | null; plan: string };
}

/** An export with every section empty: what a missing repo or a failed export reads as (plus its warnings). */
export function emptySocialExport(repo: string, warnings: PackWarning[], generatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z")): SocialExport {
  return {
    schemaVersion: SOCIAL_SCHEMA_VERSION,
    pack: "social",
    packVersion: 0,
    repo,
    generatedAt,
    warnings,
    brief: {
      objective: null,
      targets: null,
      audience: null,
      key_messages: [],
      voice: [],
      style_rules: [],
      never_say: [],
      topic_weights: [],
      feedback_log: [],
      formats: [],
      examples: [],
      hold_rules: [],
    },
    directions: { week: [], do_dont: [], voice_note: null, month: [] },
    topics: [],
    ideas: [],
    posts: [],
    messages: { chats: [], messages: [] },
    assets: [],
    reports: [],
    sources: {},
  };
}
