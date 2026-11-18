/** GET /api/pages: every one-off page the team serves, grouped by repo and epic (docs/pages/registry.json, server/src/pagesIndex.ts). */
export interface PageView {
  port?: number;
  url: string;
  title: string;
  row: string;
  repo: string;
  epic: string;
  epicTitle?: string;
  /** an approved page's short plain name (its title on the list and its pin). */
  name?: string;
  pinned?: boolean;
  /** its short address on the console: `/<slug>`. */
  slug?: string;
  /** the unit on the page host that rebuilds it: the pin shows a Refresh button. */
  refresh?: string;
  /** the objective (docs/pursuits.json id) or world it was made for, when its row's spine sits in none. */
  objective?: string;
  /** a world's name (the house) when `objective` names a world, not an objective. */
  objectiveName?: string;
  /** why no objective or world holds it (shown on the Pages list). */
  notPlaced?: string;
}
/** GET /api/pages/pinned/:port/status (and the answer of POST …/refresh). */
export interface PinnedStatus {
  refreshedAt: string | null;
  refreshable: boolean;
  running: boolean;
  error?: string;
}
export interface PageGroup {
  /** the anchor a page's header links up to: `<repo>-<epic>`. */
  id: string;
  repo: string;
  epic: string;
  epicTitle: string;
  pages: PageView[];
}
export interface PagesBody {
  /** named pages pinned above everything else (absent from an older server). */
  pinned?: PageView[];
  groups: PageGroup[];
  total: number;
  rule?: string;
}

/** GET /api/voice-notes: his voice notes of the last two days, each with the rows and epics made from it. */
export interface VoiceNoteRow {
  code: string;
  repo: string;
  spine: string;
  epic: string;
  epicTitle?: string;
  status: string;
  title: string;
  /** "row": a ledger row quotes the note; "decision": a Decisions line does. */
  via: string;
}
export interface VoiceNoteItem {
  ref: string;
  key: string;
  vn?: string;
  source: string;
  app: string;
  at: string;
  words: string;
  chars: number;
  url?: string;
  products: string[];
  /** delivered | in review | open | noted | not linked */
  state: string;
  rows: VoiceNoteRow[];
}
export interface VoiceNotesBody {
  generatedAt: string | null;
  windowHours: number;
  counts: Record<string, number>;
  products: Record<string, number>;
  /** product id → the name the filter shows, in filter order (the first is where the page opens). */
  productNames: Record<string, string>;
  notes: VoiceNoteItem[];
  rule?: string;
}

/** GET /api/x-stats: the team's X accounts, likes, replies, reposts and views per post, one file a day. */
export interface XStatsPost {
  id: string;
  url: string;
  at: string;
  kind: string;
  text: string;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes?: number | null;
  views: number | null;
  source: string;
}
export interface XStatsTotals {
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  views: number;
}
export interface XStatsAccount {
  handle: string;
  /** x, reddit or tiktok (older days have none: x). */
  platform?: string;
  product: string;
  state: string;
  listedBy: string | null;
  followers: number | null;
  postsAllTime: number | null;
  posts: XStatsPost[];
  count: number;
  totals: XStatsTotals;
  notes: string[];
  readAt: string;
}
export interface XStatsBody {
  dates: string[];
  day: { date: string; readAt: string; windowDays: number; since: string; accounts: XStatsAccount[]; note?: string } | null;
  history: { date: string; accounts: Record<string, XStatsTotals & { count: number; followers: number | null; state: string }> }[];
}

/** the asks log: every ask to the owner, counted by week (GET /api/asks/log?summary=1); the count must fall toward zero. */
export interface AskLogSummary {
  thisWeek: { week: string; asked: number };
  byWeek: { week: string; asked: number; done: number; confusing: number; clear: number }[];
  open: number;
  /** the log page (on the page shell). */
  page?: string;
}
