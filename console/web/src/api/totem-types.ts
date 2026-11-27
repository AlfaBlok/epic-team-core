/** Root L-77: the map, one file per product in docs/totems/ (server totemMap.ts). */
export type TotemShape = "page" | "table" | "tree";
export interface Totem {
  id: string;
  name: string;
  shape: TotemShape;
  tab: string;
  lives: { repo?: string; path?: string; section?: string; board?: string; note?: string };
  live?: string;
  read?: string;
  write?: string;
}
export interface ProductMap {
  product: string;
  name: string;
  line?: string;
  repos: string[];
  objectives: string[];
  totems: Totem[];
  grows: { name: string; from: string; lives: string }[];
}
export interface TotemMaps {
  statement: string;
  every: { totems: Totem[]; grows: { name: string; from: string; lives: string }[] };
  products: ProductMap[];
}
export interface TotemView {
  product: string;
  id: string;
  name: string;
  shape: TotemShape;
  where: string;
  live?: string;
  read?: string;
  write?: string;
  empty: boolean;
  markdown?: string;
  headers?: string[];
  rows?: string[][];
  tree?: { label: string; children: { id: string; label: string; status: string }[] }[];
}
/** a wheel's tracker tables (server trackers.ts). */
export interface TrackerTable {
  id: string;
  name: string;
  for?: string;
  columns: string[];
  statuses: string[];
  /** the columns on an entry's folded line; the rest show when it unfolds. None: every column. */
  shown?: string[];
  from: "frame" | "product" | "own";
  open: boolean;
  yes?: string;
  rows: string[][];
  counts: { status: string; n: number }[];
  /** entries kept on the table but out of its count (the team's own test sign-ups), per status. */
  uncounted?: { status: string; n: number }[];
  /** rows read from the console's database, never from the repo (a sign-ups table). */
  source?: string;
  file: string;
}
export interface WheelTrackers {
  wheel: string;
  name: string;
  product?: string;
  tables: TrackerTable[];
}
/** GET /api/persona-log/:wheel: every step an agent took on the wheel, what it did and why, asked by him or
 * chosen by the persona, with his label on the chosen ones. */
export type StepLabel = "correct" | "incorrect";
export interface PersonaStep {
  id: string;
  at: string;
  persona: string;
  worker: boolean;
  objective: string | null;
  objectiveName?: string | null;
  milestone?: string | null;
  kr: string | null;
  row: string | null;
  from: string | null;
  did: string;
  why: string;
  asked: boolean;
  outcome: string;
  costUsd?: number | null;
  label?: StepLabel;
  labelledAt?: string;
}
/** a wheel's Consumption chapter: its share of his whole AI subscription and of what was used, per persona. */
export interface ConsumptionPersona {
  persona: string;
  ofTotal: number;
  ofUsed: number;
  ofWheel?: number;
  runs: number;
  outcomes: number;
  madeTrue: number;
}
export interface ConsumptionWheel {
  key: string;
  name: string;
  kind: string;
  ofTotal: number;
  ofUsed: number;
  runs: number;
  outcomes: number;
  madeTrue: number;
  personas: ConsumptionPersona[];
}
export interface Consumption {
  at: string | null;
  seats: number;
  usedOfTotal: number;
  wheel: ConsumptionWheel | null;
  rank: number | null;
  of: number;
  wheels?: ConsumptionWheel[];
  personas?: ConsumptionPersona[];
  page?: string | null;
  file: string;
}
export interface PersonaLog {
  wheel: string;
  days: number;
  steps: PersonaStep[];
  counts: { steps: number; unasked: number; correct: number; incorrect: number; unlabelled: number };
  file: string;
}
/** GET /api/tenants/:id/campaigns/:mid/trackers: the tracker tables of the wheel a campaign serves (its objective, else
 * each live objective of its product); none for a campaign outside the home product's repos. */
export interface CampaignTrackers {
  product: string | null;
  wheels: WheelTrackers[];
}
/** GET /api/tenants/:id/campaigns/:mid/wheel-plan: the plan of the wheel a campaign serves, per key result (the same
 * plan its objective's Plan tab shows), with each key result's name. */
export interface CampaignWheelPlan {
  product: string | null;
  wheels: { id: string; name: string; plan: import("./pursuit-types").WheelPlan; keyResults: string[] }[];
}
/** GET /api/tenants/:id/campaigns/:mid/wheel: the objective a campaign serves, as an objective's own tabs
 * read it: its key results (now against target), its where-we-are and the pages made for it. */
export interface CampaignKeyResult {
  n: number;
  label: string;
  target?: string;
  value?: string;
  colour?: string;
  note?: string;
  owner?: string;
  measuredAt?: string;
  evidence?: { what?: string; url?: string };
}
export interface CampaignWheel {
  product: string | null;
  wheels: { id: string; name: string; keyResults: CampaignKeyResult[]; where: import("./pursuit-types").WhereWeAre; pages: import("./pages-types").PageView[] }[];
  /** where the list of campaigns (with their key results) and this campaign's chapters live. */
  homes?: CampaignHomes | null;
}
export interface CampaignHomes {
  list: { repo: string; path: string; listed: boolean };
  chapters: { repo: string; folder: string; made: boolean };
  /** the Plan chapter: the plan of each objective the campaign serves, where it is kept. */
  plan?: { repo: string; path: string }[];
}
