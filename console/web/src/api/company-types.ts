/** the companies the Company view shows (docs/companies.json of the code repo, GET /api/companies). */
export type WheelId = "build" | "promo" | "ops";
export interface CompanySource {
  repo: string;
  /** A spine file in the repo: only its items (wins over a whole-repo source). */
  path?: string;
}
export interface CompanyWheel {
  sources: CompanySource[];
  links: { label: string; url: string }[];
  /** the social accounts its numbers are read from (the Promo wheel). */
  accounts?: { repo: string; account: string; platform: "x" | "reddit"; site?: string }[];
  /** the web addresses the console checks for uptime and counts visits on. */
  sites?: string[];
}
export interface Company {
  id: string;
  name: string;
  line?: string;
  first?: boolean;
  lane?: string;
  wheels: Record<WheelId, CompanyWheel>;
}

/** a company as the owner sets it on the Company view: its name, line and what feeds each wheel. */
export interface CompanyInput {
  name: string;
  line?: string;
  wheels: Partial<Record<WheelId, { sources: CompanySource[] }>>;
}
/** a save is one commit to docs/companies.json of the code repo (`pushing`: the push to origin runs in the background). */
export interface CompanySaved {
  company: Company;
  write: { sha?: string; pushing: boolean; note?: string };
}

/** a note the owner dropped in a wheel (docs/company-notes.jsonl of the code repo); open until a handled line follows it. */
export interface WheelNote {
  id: string;
  company: string;
  wheel: WheelId;
  at: string;
  via: "voice" | "text";
  words: string;
  audio?: string;
  /** Where it was posted: a milestone id, or "team" (the Team desk). */
  desk: string;
  handledAt?: string;
  handledBy?: string;
}
/** one Promo number, read live; `n` null = it cannot be read, `note` says why (shown as "?", never a zero). */
export interface PromoNumber {
  n: number | null;
  change?: number | null;
  of?: number;
  at?: string | null;
  note: string;
}
export interface PromoAccount {
  repo: string;
  account: string;
  platform: "x" | "reddit";
  site: string | null;
  followers: PromoNumber;
  posts: PromoNumber;
  clicks: PromoNumber;
}
/** GET /api/companies/<id>/promo: the Promo wheel's weekly numbers per account. */
export interface CompanyPromo {
  company: string;
  week: { from: string; to: string };
  accounts: PromoAccount[];
  none?: string;
}

/** one Operations number; null = it cannot be read, `note` says why (shown as "?", never a zero). */
export interface OpsNumber {
  n: number | null;
  change?: number | null;
  note: string;
}
export interface OpsSite {
  url: string;
  host: string;
  uptime: OpsNumber;
  down: OpsNumber;
  last: { at: string; status: number; ok: boolean } | null;
}
/** the Operations wheel's numbers of one company over the last 7 days (GET /api/companies/:id/ops). */
export interface CompanyOps {
  company: string;
  week: { from: string; to: string };
  sites: OpsSite[];
  visits: OpsNumber;
  conversions: OpsNumber;
  support: OpsNumber;
  spend: OpsNumber;
  revenue: OpsNumber;
  none?: string;
}

/** one Build number; null = it cannot be read, `note` says why (shown as "?", never a zero). */
export interface BuildNumber {
  n: number | null;
  note: string;
}
export interface BuildShipped {
  repo: string;
  path: string;
  id: string;
  title: string;
  status: string;
  at: string;
  bug: boolean;
}
/** the Build wheel's numbers of one company from its spines' Issue Ledgers (GET /api/companies/:id/build). */
export interface CompanyBuild {
  company: string;
  week: { from: string; to: string };
  open: BuildNumber & { review?: number };
  shipped: BuildNumber;
  bugs: BuildNumber;
  /** Hours since the newest commit to the ledgers. */
  freshness: BuildNumber & { at?: string };
  rows: BuildShipped[];
  spines: { repo: string; paths: string[] }[];
  none?: string;
}

/**
 * an open ask or card of another product's world the login belongs to (the social product world such as a social world repo),
 * read only through that world's own lists (GET /api/companies/worlds); it opens in its own app (openUrl).
 */
export interface WorldItem {
  key: string;
  kind: "ask" | "review";
  id: string;
  title: string;
  repo?: string;
  path?: string;
  code?: string;
  level?: string;
  priority?: number;
  since?: string;
  milestoneId?: string;
  project?: string;
  liveUrl?: string;
  openUrl: string;
}
export interface WorldInbox {
  tenantId: string;
  tenantName: string;
  /** The product's app (the social product) and its address (https://cloud.social.app). */
  app: string;
  appUrl: string;
  items: WorldItem[];
  error?: string;
}
