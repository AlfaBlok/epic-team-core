/** GET /api/pursuits: the owner's pursuits (docs/pursuits.json), each scorecard read from real checks (server/src/pursuits.ts). */
export type PursuitLineState = "green" | "amber" | "red" | "unknown";
export interface PursuitLine {
  label: string;
  state: PursuitLineState;
  value: string;
  note?: string;
}
export interface PursuitTotem {
  label: string;
  url?: string;
  missing?: string;
}
export interface Pursuit {
  id: string;
  name: string;
  /** the product it moves (docs/scorecard/products.json); its kit and words live there once. */
  product?: { id: string; name: string };
  greenWhen: string;
  state: PursuitLineState;
  greens: number;
  total: number;
  lines: PursuitLine[];
  totems: PursuitTotem[];
  motion: "moving" | "stalled" | "unknown";
  lastMove: { at: string; repo: string; subject: string } | null;
  /** it has a social kit, shown on its own page (/pursuits/<id>/social-kit). */
  kit?: boolean;
  /** its place in the owner's order, 1 first; null = parked. Absent on an older server. */
  rank?: number | null;
  parked?: boolean;
  /** what its rank buys (wake pace, worker ceiling, stall watch patience) and the same in plain words. */
  effort?: PursuitEffort;
  /** the goal's one number ("5 testers using SocialApp · 0 of 5"), from its source file. */
  goal?: { now: number; target: number; by?: string };
  /** the epics that carry it, each with its deck code and the milestone that runs it. */
  epics?: PursuitEpic[];
  /** the milestones that run its epics and the teams on each. */
  milestones?: PursuitMilestone[];
}
export interface PursuitEffort {
  tier: string;
  wakeFactor: number;
  maxWorkers: number;
  stallHours: number;
  words: string;
}
export interface PursuitEpic {
  repo: string;
  path: string;
  code?: string;
  title?: string;
  milestoneId?: string;
}
export interface PursuitTeam {
  persona: string;
  enabled: boolean;
  /** auto-parked with nothing to do: it still wakes by itself. */
  parked?: boolean;
  /** the pace as set, and as it runs now that the rank changes it. */
  pace: string;
  paceNow: string;
}
export interface PursuitMilestone {
  id: string;
  title: string;
  via: "own" | "root";
  teams: PursuitTeam[];
}
export interface EffortPolicy {
  tiers: { name: string; upToRank: number; wakeFactor: number; maxWorkers: number; stallHours: number }[];
  minWakeMinutes: number;
  outside: string;
}

/** GET /api/pursuits/<id>/kit: the pursuit's social kit as its kit.json holds it (docs/brand/social-kit/<kit>/kit.json). */
export interface SocialKit {
  id: string;
  name: string;
  link?: string;
  domain?: string;
  tagline?: string;
  taglineSub?: string;
  claim?: string;
  line?: string;
  fonts?: { display?: { family: string; file: string; use?: number }; body?: { family: string; file: string; use?: number } };
  page?: { accent?: string; ink?: string; muted?: string; bg?: string };
  avatar?: { note?: string };
  colours?: { name: string; hex: string; use?: string }[];
  accounts?: { platform: string; handle: string; url?: string; state?: string }[];
  bios?: { where: string; text: string }[];
  templates?: { id: string; title: string; w: number; h: number; for?: string }[];
  postTexts?: { title: string; text: string }[];
  versions?: { version: string; date: string; what: string }[];
}
export interface PursuitKitBody {
  /** the objective it was opened from (absent on a product's own kit, GET /api/products/<id>/kit). */
  pursuit?: { id: string; name: string };
  /** the product the kit belongs to: a kit is written once, on its product. */
  product?: { id: string; name: string };
  kit: SocialKit;
  /** The file store for the full-size downloads. */
  files?: string;
}
export interface PursuitsBody {
  pursuits: Pursuit[];
  effort?: EffortPolicy;
  staleDays: number;
  said?: { source: string; words: string };
  boardAt?: string | null;
}

/** GET /api/scorecards: every pursuit a scorecard, the epics that carry it scorecards inside it. */
export type ScorecardQueueState = "ready" | "running" | "waiting";
export interface ScorecardQueueRow {
  code: string;
  title: string;
  state: ScorecardQueueState;
  status: string;
}
export interface ScorecardSpineInfo {
  repo: string;
  path: string;
  code?: string;
  title?: string;
  doneMeans: { done: number; total: number };
  boxes?: { id: string; text: string; done: boolean }[];
  /** codes of the rows and asks written in this spine. */
  codes: string[];
  queue: ScorecardQueueRow[];
}
export type ScorecardRowState = "green" | "amber" | "red" | "unknown";
/** one measurable row of a goal set's table (the owner, vn_fd4f7a7a). */
export interface ScorecardRow {
  label: string;
  state: ScorecardRowState;
  value: string;
  target?: string;
  /** key-result and health come from the set's file (OKR shape); the rest are read live. */
  kind: "key-result" | "health" | "check" | "epic" | "done-means" | "flow" | "inbox";
  note?: string;
  /** the proposal's row shape. */
  group?: string;
  source?: string;
  by?: string;
  /** the epics and tickets trying to turn it green (the owner, vn_c15874bc); empty = nothing works on it. */
  work?: ScorecardWork[];
  /** when it last turned green. */
  greenSince?: string;
  /** a key result: the Done-means box it measures (E907-4), or how it is read ("check", "light"). */
  doneMeans?: string;
  /** when its value was last measured; absent: nothing measures it. Older than a day reads stale. */
  measuredAt?: string;
}
export interface ScorecardWork {
  code: string;
  repo: string;
  title?: string;
  status?: string;
  kind: "epic" | "ticket" | "done-means" | "unknown";
  state?: ScorecardRowState;
  path?: string;
  epicCode?: string;
}
export interface ScorecardNode {
  id: string;
  kind: "pursuit" | "epic";
  name: string;
  rank?: number | null;
  parked?: boolean;
  repo?: string;
  path?: string;
  code?: string;
  milestoneId?: string;
  greens: number;
  total: number;
  state?: PursuitLineState;
  motion?: "moving" | "stalled" | "unknown";
  /** "repo:path" of every spine in its subtree, itself first. */
  spines: string[];
  children: ScorecardNode[];
  rows: ScorecardRow[];
  objective?: string;
  /** the short objective the sidebar and the page lead with, and whether the owner agreed it. */
  headline?: string;
  objectiveStatus?: "proposed" | "agreed";
  objectiveWas?: string;
  /** the file its declared rows come from (docs/scorecards/<id>.json in the home repo). */
  file?: { path: string; present: boolean; proposal?: string };
  teams?: PursuitTeam[];
  /** no persona on it ("none"), or all of them switched off ("off"). */
  noPersona?: "none" | "off";
  /** its 4 to 6 key results; an epic's are its Done means. */
  keyResults?: ScorecardRow[];
  /** the spine whose Goal sentence is this objective. */
  spineRef?: { repo: string; code: string };
  /** the child epics the sidebar shows under it, in short words. */
  sidebar?: { id: string; name: string; greens: number; total: number }[];
  /** shown inside another objective: left out of the sidebar and the all list. */
  foldedInto?: string;
  /** its owner persona when the file names one (else its milestone's Delivery Manager, whose regular wake reads it). */
  owner?: string;
  /** the idle mark: below green with no worker, no ask, no card. */
  idle?: { idle: boolean; reason: string };
}
export interface ScorecardsBody {
  nodes: ScorecardNode[];
  spineInfo: Record<string, ScorecardSpineInfo>;
  /** rows turned green today and this week (UTC, the week from Monday), per set and in all; counted since `since`. */
  progress?: { since: string; today: number; week: number; sets: Record<string, { today: number; week: number }> };
  /** milestones he retired: left out of the sidebar's goals; their pages still open by link. */
  retired?: string[];
}

/** a pursuit's name as the owner reads it: with its goal's number when it has one ("5 testers using SocialApp · 0 of 5"). */
export const pursuitTitle = (p: Pick<Pursuit, "name" | "goal">) => (p.goal ? `${p.name} · ${p.goal.now} of ${p.goal.target}` : p.name);

/** a milestone or objective, in any world, with no Delivery Manager turning it (GET /api/persona-gaps). */
export interface PersonaGap {
  kind: "milestone" | "objective";
  id: string;
  title: string;
  world: string;
  turner: "none" | "off";
  why: string;
  milestoneId?: string;
}
export interface PersonaGapsBody {
  ok: boolean;
  gaps: PersonaGap[];
  checked: { objectives: number; milestones: number };
  at: string;
}

/** GET /api/products: each product defined once: its deck's four parts, its kit, the objectives naming it. */
export interface ProductPart {
  part: string;
  label: string;
  body: string;
  from?: string;
}
export interface ProductView {
  id: string;
  name: string;
  group?: string;
  url?: string;
  tagline?: string;
  accent?: string;
  deck?: { repo: string; path: string; title: string | null; parts: ProductPart[]; missing: string[] };
  kit: boolean;
  wheels: { id: string; name: string; state: PursuitLineState; greens: number; total: number; rank: number | null; parked?: boolean }[];
}
export interface ProductsBody {
  products: ProductView[];
}
