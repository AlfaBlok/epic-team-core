import { CODE_KEY, SITE_PAGES, type SiteCount, type SiteWhere } from "../siteKpisCompute.js";
import { remoteSourceId, remoteSourceNames, remoteSourceOf, remoteSourceText, remoteValue, type RemoteReading, type RemoteSourceId } from "./remoteCounts.js";
import { dayOf, isLive, platformOf, type SnapshotRow } from "./kpisCompute.js";

/**
 * The shapes and the computation of three things every social-pack repo carries, served by
 * motion.ts and run by the web mock:
 *  - the product deck, `data/product.md`: one `## ` part per slide (why it exists, who it is for, how it works, what it
 *    does for you, what is included, how much it costs, how you get it, how it differs), separate from each campaign's deck
 *    (its spine's Brief); every persona reads it at each wake (totemsWake);
 *  - the metrics catalog, METRICS below: the one list of numbers a campaign may target, each with its source or "no source
 *    yet". A campaign names its target in its spine's `## Campaign plan` with one line `Metric: <id> <target> by <date>`
 *    (`from <date>` optional: else the plan's `Period:` start), so the target lives in the repo (L-45);
 *  - `data/metrics.md`, written by the console's hourly KPI check (refreshMetrics) only when a number changed: the
 *    catalog with today's values, each campaign's target and where it stands, and one line per role saying which number
 *    it wakes to move and the files it reads. Personas read it at each wake.
 */

export const PRODUCT_FILE = "data/product.md";
export const METRICS_FILE = "data/metrics.md";

/** The product deck's parts, in the owner's order ("Why this exists? How does it work? How can you get it? How much it costs? How is it different …? What is included?"). */
export const PRODUCT_PARTS = ["Why it exists", "Who it is for", "How it works", "What it does for you", "What is included", "How much it costs", "How you get it", "How it differs"] as const;

/**
 * each campaign's
 * own product deck, `docs/campaigns/<epic-n>/product.md` (beside its strategy deck), one `## ` part per slide. Personas read
 * the repo's product deck first, then their campaign's, then the targets and their role's line.
 */
// the campaign's one deck, the strategy deck and the
// one-pager folded in: what we push, why now, who, the offer, proof, the plan, where we stand, what we say.
export const CAMPAIGN_PRODUCT_PARTS = ["What we push", "Why now", "Who it is for", "The offer", "Proof", "The plan", "Where we stand", "What we say and never say"] as const;
export const campaignProductFile = (code: string) => `docs/campaigns/${code.toLowerCase()}/product.md`;
/** The order every persona reads, said in one line on both product pages and in the wake. */
export const READ_ORDER = "the project's product deck first, then its campaign's product deck, then the targets and its role's line";

export type MetricId =
  | "testers"
  | "signups"
  | "site_visitors"
  | "code_views"
  | "x_followers"
  | "reddit_followers"
  | "posts_out"
  | "replies_received"
  | "backlinks"
  | "mcp_listings"
  | "customers";

export interface MetricDef {
  id: MetricId;
  label: string;
  /** What one unit is, in plain words. */
  counts: string;
  /** total: counted over the campaign's period; level: the latest reading. */
  kind: "total" | "level";
  /** Where the number is read, or null: no source yet (shown as such, never a fake zero). */
  source: string | null;
  /** the site and address a visit or sign-up number counts (shown beside it as a link). */
  where?: SiteWhere[];
}

/**
 * The catalog's words and what is ours (config): the metrics' labels and sources name the team's sites, forms and
 * accounts, so the hosted layer sets its own (setMetricSetup) before a number is computed. The defaults are a neutral
 * example over the same ids.
 */
export interface MetricSetup {
  metrics: MetricDef[];
  /** our own hosts: a visit referred by one of them (or a subdomain) is no backlink */
  ownHosts: string[];
  /** data/metrics.md's opening paragraph (the record's own words; changing it rewrites the file) */
  fileIntro: string;
  /** who sets a campaign's target, in the Targets table's Set by column */
  owner: string;
  /** the Every site section's opening line (the neutral one when absent) */
  sitesIntro?: string;
}
const NEUTRAL_SITES_INTRO =
  "Visits and sign-ups of every site of ours, one number per site per UTC day (the full record is data/sites-daily.md). Visits: one per visitor, page and day, our own counter, no cookie. Sign-ups: our own records; test visits and sign-ups never count. All sites adds up the site columns.";

export const NEUTRAL_METRIC_SETUP: MetricSetup = {
  metrics: [
    { id: "testers", label: "Tester applications", counts: "one application at example.com/testers/", kind: "total", source: "the testers form (console tester_signups, counts only)", where: [{ name: "Example", address: "example.com/testers/", url: "https://example.com/testers/" }] },
    { id: "signups", label: "New users registered", counts: "one person who applied or joined the waitlist on example.com", kind: "total", source: "the testers form and the waitlist (console tester_signups, counts only)", where: [{ name: "Example", address: "example.com", url: "https://example.com/" }] },
    { id: "site_visitors", label: "Site visitors on example.com", counts: "one view of an example.com page per visitor and day", kind: "total", source: "our own page-view counter on example.com; past days from data/site-daily.md", where: [{ name: "Example", address: "example.com", url: "https://example.com/" }] },
    { id: "code_views", label: "Code page views on GitHub", counts: "one view of the code's GitHub page", kind: "total", source: "GitHub traffic, read hourly" },
    { id: "x_followers", label: "X followers", counts: "one follower of our X account", kind: "level", source: "data/kpi-daily.md (the X profile, read daily)" },
    { id: "reddit_followers", label: "Reddit followers", counts: "one follower of our Reddit account", kind: "level", source: "data/kpi-daily.md (Reddit about.json, read daily)" },
    { id: "posts_out", label: "Posts out", counts: "one post of ours that went live", kind: "total", source: "data/posts-ledger.md (Kind post, posted or measured)" },
    { id: "replies_received", label: "Replies received", counts: "one reply to a post of ours", kind: "total", source: "data/posts-ledger.md (Replies on our live rows)" },
    { id: "backlinks", label: "Backlinks", counts: "one other site linking to ours", kind: "total", source: "the sites our visitors came from and GitHub's referring sites for our code page, read hourly (ours, search engines and post links left out)" },
    { id: "mcp_listings", label: "MCP catalog listings", counts: "one MCP catalog that lists us", kind: "level", source: "this world's own data/mcp_listings.md (one table row per catalog where the listing is live)" },
    { id: "customers", label: "Customers", counts: "one person who paid", kind: "level", source: "the console's tester records: paid or marked paid by the owner, not cancelled (counts only)" },
  ],
  ownHosts: ["example.com"],
  fileIntro:
    "Written by the console at its hourly check, only when a number changed: never edit it by hand. The catalog is the one list of numbers a campaign may target (documented in the social pack). A campaign sets its target in its spine's `## Campaign plan` with one line `Metric: <id> <target> by <YYYY-MM-DD>`; its period's start counts from its `Period:` line (or `from <YYYY-MM-DD>` on the Metric line). Every persona reads this file and data/product.md at each wake. Each number reads the source its Source column names: a world sets its own with one line in its root spine, `Metric sources: <id> <source>, …` (sources: default, the catalog's own; ledger, the world's own `data/<id>.md` with one table row per unit and a Date column; none), and a campaign overrides it with `source <source>` on its Metric line.",
  owner: "the owner",
};

/** the catalog (the same array always: setMetricSetup refills it) */
export const METRICS: MetricDef[] = [];
const DEF = new Map<string, MetricDef>();
let metricSetup: MetricSetup = NEUTRAL_METRIC_SETUP;
/** set the catalog's words and our hosts (the hosted layer, once at load). */
export function setMetricSetup(next: MetricSetup): void {
  metricSetup = next;
  METRICS.splice(0, METRICS.length, ...next.metrics);
  DEF.clear();
  for (const m of next.metrics) DEF.set(m.id, m);
  const own = next.ownHosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  NOT_BACKLINK = new RegExp(`(^|\\.)(${own ? `${own}|` : ""}${NOT_BACKLINK_ALWAYS})$`, "i");
}
export const metricDef = (id: string) => DEF.get(id as MetricId);

/**
 * a metric's source is
 * set per world or per campaign, never assumed. `default` is the catalog's own source above (the team's form, counter or
 * ledger); `ledger` counts the world's own file `data/<id>.md` (one table row per unit, kept by its personas; a `Date`
 * column, YYYY-MM-DD, lets a period count only its days), for a number only that world can see, like the memory service testers who
 * come in by DM and cloud.memory.dev sign-ups; `none` says the world has no source for it (shown as such, never another
 * world's number). A world sets its defaults with one line in its root spine, `Metric sources: testers ledger, site_visitors
 * none`; a campaign overrides with `source <id>` on its `Metric:` line.
 * a fourth kind reads another product's public counts, `<source>#<field>` (`memory-counts#active_testers`, see
 * remoteCounts.ts; only named sources, never an address a spine writes).
 */
export type SourceId = "default" | "ledger" | "none" | RemoteSourceId;
export const SOURCE_IDS = ["default", "ledger", "none"] as const;
/** The words a spine may write, for messages. */
export const sourceWords = (): string => {
  const remote = remoteSourceNames().map((n) => `${n}#<field>`);
  const all = [...SOURCE_IDS, ...remote];
  return `${all.slice(0, -1).join(", ")} or ${all[all.length - 1]}`;
};
/** A source as a spine writes it, or undefined when it is none we know. */
export function sourceIdOf(raw: string | null | undefined): SourceId | undefined {
  if (!raw) return undefined;
  const s = raw.trim().replace(/^`|`$/g, "");
  if ((SOURCE_IDS as readonly string[]).includes(s.toLowerCase())) return s.toLowerCase() as SourceId;
  return remoteSourceId(s);
}
export const isRemote = (src: SourceId | "unknown" | undefined): src is RemoteSourceId => !!src && src.includes("#");
export const ledgerFile = (id: string) => `data/${id}.md`;
export const SOURCES_LINE = /^Metric sources:\s*(.+)$/m;
/** A world's own sources, from its root spine's `Metric sources:` line (unknown ids and sources are left out). */
export function repoSources(rootText: string | null | undefined): Partial<Record<MetricId, SourceId>> {
  const out: Partial<Record<MetricId, SourceId>> = {};
  const line = rootText ? SOURCES_LINE.exec(rootText)?.[1] : undefined;
  for (const part of (line ?? "").split(/[,;]/)) {
    const m = /^\s*`?([a-z_]+)`?\s*[:=]?\s+(\S+)\s*$/i.exec(part);
    const def = m ? metricDef(m[1].toLowerCase()) : undefined;
    const src = sourceIdOf(m?.[2]);
    if (def && src) out[def.id] = src;
  }
  return out;
}
/** What a metric's number reads, in words, for the source in force (null: no source). */
export function sourceText(def: MetricDef, src: SourceId, remote?: MetricInputs["remote"]): string | null {
  if (src === "none") return null;
  if (isRemote(src)) return remoteSourceText(src, remoteReading(src, remote));
  if (src === "ledger") return `this world's own ${ledgerFile(def.id)} (one table row per unit)`;
  return def.source;
}
/** One row of a world's ledger file: its date when the table has a Date column. */
export interface LedgerRow {
  date: string | null;
}
/** The rows of a ledger file's first table (header and separator left out, empty rows too). */
export function parseLedger(text: string | null | undefined): LedgerRow[] {
  if (!text) return [];
  const rows: LedgerRow[] = [];
  let header: string[] | null = null;
  let dateAt = -1;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      if (header && rows.length) break;
      continue;
    }
    const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      dateAt = header.findIndex((h) => /^(date|day|joined|since)$/.test(h));
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue;
    const d = dateAt >= 0 ? /\d{4}-\d{2}-\d{2}/.exec(cells[dateAt] ?? "")?.[0] ?? null : null;
    rows.push({ date: d });
  }
  return rows;
}

/** What one role wakes to move, how, and the files it reads besides the shared ones. */
export interface RoleLever {
  role: string;
  /** Its own number (the lever), from the catalog. */
  lever: MetricId;
  how: string;
  reads: string[];
}
/** Every persona reads these first, at each wake: the product, the root brief, the numbers, its campaign's spine and the root's. */
export const SHARED_READS = [PRODUCT_FILE, "data/brief.md", METRICS_FILE];
/** the site's daily line (visits, top sources, applications), written once a day by the console. */
export const SITE_DAILY_READ = "data/site-daily.md";
export const ROLE_LEVERS: RoleLever[] = [
  { role: "Scout", lever: "replies_received", how: "finds the topics and threads people already talk about, so the Writer's posts land where people answer", reads: ["data/topics.md", "data/threads.md", "data/ideas.md"] },
  { role: "Writer", lever: "posts_out", how: "turns ideas into posts that open on one benefit and end on the campaign's call; a link to our pages carries ?s=<post id>", reads: ["data/ideas.md", "data/posts-ledger.md", "data/assets.md", SITE_DAILY_READ] },
  { role: "Publisher", lever: "posts_out", how: "sends every approved post in its slot, inside the caps, so none is lost", reads: ["data/posts-ledger.md"] },
  { role: "Responder", lever: "replies_received", how: "answers every reply on our posts within hours and points to the call once", reads: ["data/posts-ledger.md", "data/messages-ledger.md"] },
  { role: "Engager", lever: "replies_received", how: "joins other people's threads with a disclosed reply where our call helps", reads: ["data/threads.md", "data/posts-ledger.md"] },
  { role: "Reporter", lever: "posts_out", how: "measures each post after 48 h and says which posts moved the target", reads: ["data/kpi-daily.md", SITE_DAILY_READ, "data/posts-ledger.md", "data/reports/"] },
  { role: "Video Maker", lever: "posts_out", how: "makes the clips and screens the posts show", reads: ["data/assets.md"] },
];

export interface MetricInputs {
  signups: { createdAt: string; offer: string }[];
  siteViews: { day: string; page: string; n: number }[];
  snapshots: SnapshotRow[];
  posts: { date?: string | null; kind?: string | null; platform?: string | null; status?: string | null; replies?: number | null; campaign?: string | null }[];
  /** each referring site and the first day it sent us a visitor (our visit log and GitHub's referring sites). */
  referrers?: { host: string; day: string }[];
  /** the console's tester records that carry a payment (comped ones left out). */
  payments?: { paidAt: string | null; cancelled: boolean }[];
  /** the world's own ledger files (`data/<id>.md`), by metric id; a missing file is no rows. */
  ledgers?: Partial<Record<MetricId, LedgerRow[]>>;
  /** the remote sources' last readings, by source name (`memory-counts`). */
  remote?: Record<string, RemoteReading>;
}
const remoteReading = (src: RemoteSourceId, remote?: MetricInputs["remote"]) => remote?.[remoteSourceOf(src)?.def.name ?? ""];
/** when a remote number was read, or since when its endpoint is not answering (the page shows it, the file does not). */
export function sourceNote(src: SourceId | "unknown" | undefined, remote?: MetricInputs["remote"]): string | undefined {
  if (!isRemote(src)) return undefined;
  const r = remoteReading(src, remote);
  const t = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  if (r?.failedAt) return `Not answering since ${t(r.failedAt)}${r.readAt ? `, last good reading ${t(r.readAt)}` : ""}`;
  return r?.readAt ? `Read ${t(r.readAt)}` : undefined;
}

/** One metric's value: over [from, today] for a total (all time without from), the latest reading for a level; null = no source or nothing read yet. */
export function metricValue(id: MetricId, inp: MetricInputs, o: { from?: string | null; campaign?: string | null; source?: SourceId } = {}): number | null {
  const from = o.from ?? "";
  const inPeriod = (d: string | null | undefined) => !!d && d.slice(0, 10) >= from;
  if (o.source === "none") return null;
  if (isRemote(o.source)) return remoteValue(o.source, remoteReading(o.source, inp.remote), from || null);
  // A row with no date counts in every period: the ledger's keeper left the day out.
  if (o.source === "ledger") {
    const rows = inp.ledgers?.[id];
    return rows ? rows.filter((r) => !from || !r.date || r.date >= from).length : null;
  }
  const ours = (p: MetricInputs["posts"][number]) => !o.campaign || String(p.campaign ?? "").trim().toUpperCase() === o.campaign.toUpperCase();
  switch (id) {
    case "testers":
      return inp.signups.filter((s) => /^tester/i.test(s.offer) && inPeriod(s.createdAt)).length;
    case "signups":
      return inp.signups.filter((s) => inPeriod(s.createdAt)).length;
    case "site_visitors":
      return inp.siteViews.filter((v) => v.page in SITE_PAGES && inPeriod(v.day)).reduce((a, v) => a + v.n, 0);
    case "code_views":
      return inp.siteViews.filter((v) => v.page === CODE_KEY && inPeriod(v.day)).reduce((a, v) => a + v.n, 0);
    case "x_followers":
    case "reddit_followers": {
      const plat = id === "x_followers" ? "x" : "reddit";
      const rows = inp.snapshots.filter((s) => s.platform === plat && s.followers !== null);
      return rows.length ? rows[rows.length - 1].followers : null;
    }
    case "posts_out":
      return inp.posts.filter((p) => isLive(p as never) && (p.kind ?? "post") === "post" && ours(p) && inPeriod(dayOf(p.date))).length;
    case "replies_received":
      return inp.posts.filter((p) => isLive(p as never) && ours(p) && inPeriod(dayOf(p.date)) && platformOf(p.platform)).reduce((a, p) => a + (p.replies ?? 0), 0);
    case "backlinks": {
      // A site counts once, on the first day it linked to us; a total counts the sites new in the period.
      if (!inp.referrers) return null;
      const first = new Map<string, string>();
      for (const r of inp.referrers) if (isBacklinkHost(r.host) && (!first.has(r.host) || r.day < first.get(r.host)!)) first.set(r.host, r.day);
      return [...first.values()].filter((d) => inPeriod(d)).length;
    }
    case "customers":
      return inp.payments ? inp.payments.filter((p) => !p.cancelled).length : null;
    case "mcp_listings": {
      const rows = inp.ledgers?.mcp_listings;
      return rows ? rows.length : null;
    }
    default:
      return null;
  }
}

/**
 * which referring hosts are backlinks: another site's page that links to ours. Our own sites, the tailnet,
 * GitHub (our code's own home) and search engines are left out; a visit that came by a post link of ours never reaches
 * here (its source is the post id).
 */
const NOT_BACKLINK_ALWAYS = String.raw`ts\.net|localhost|github\.com|githubusercontent\.com|google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.[a-z.]+|yandex\.[a-z.]+|baidu\.com|ecosia\.org|search\.brave\.com|startpage\.com|qwant\.com`;
let NOT_BACKLINK = /$^/;
export function isBacklinkHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && !/^[\d.]+$/.test(h) && !NOT_BACKLINK.test(h);
}

/** A campaign's target, as its spine states it. */
export interface CampaignTarget {
  /** Repo-relative spine path. */
  spine: string;
  code: string;
  name: string;
  /** The campaign tag its ledger rows carry (``); null = the repo itself (the root counts every row). */
  tag: string | null;
  metric: MetricId | null;
  /** The raw `Metric:` line when it names no catalog metric (shown so it gets fixed). */
  unknown?: string;
  target: number | null;
  by: string | null;
  from: string | null;
  /** The line says "proposed": the owner has not set it yet. */
  proposed: boolean;
  /** `source <id>` on the Metric line (null: the world's own default for the metric). */
  sourceAsked?: string | null;
}

export const METRIC_LINE = /^Metric:\s*(.+)$/m;

/** Reads one spine's title, campaign tag, `Metric:` line and plan period. */
export function campaignTarget(spine: string, text: string): CampaignTarget {
  const title = /^#\s+(EPIC-\d+):\s*(.+)$/m.exec(text);
  const tag = /^Campaign tag:\s*`?([A-Za-z]+-\d+)`?/m.exec(text)?.[1] ?? null;
  const period = /^Period:\s*(\d{4}-\d{2}-\d{2})/m.exec(text)?.[1] ?? null;
  const line = METRIC_LINE.exec(text)?.[1].trim() ?? "";
  const m = /^`?([a-z_]+)`?\s+(\d+)(?:\s+by\s+(\d{4}-\d{2}-\d{2}))?(?:\s+from\s+(\d{4}-\d{2}-\d{2}))?/i.exec(line);
  const def = m ? metricDef(m[1].toLowerCase()) : undefined;
  return {
    spine,
    code: title?.[1] ?? spine,
    name: title?.[2].trim() ?? spine,
    tag,
    metric: def?.id ?? null,
    ...(line && !def ? { unknown: line } : {}),
    target: def && m ? Number(m[2]) : null,
    by: def && m?.[3] ? m[3] : null,
    from: (def && m?.[4]) || period,
    proposed: /\bproposed\b/i.test(line),
    sourceAsked: /\bsource:?\s+`?([a-z_][^\s`]*)`?/i.exec(line)?.[1].toLowerCase() ?? null,
  };
}

export interface TargetView extends CampaignTarget {
  label: string | null;
  /** the sites and addresses the number counts (the catalog's default source only). */
  where?: SiteWhere[];
  now: number | null;
  source: string | null;
  /** the source in force (the campaign's, else the world's, else default); `unknown` names a source not in SOURCE_IDS. */
  sourceId?: SourceId | "unknown";
  /** when a remote number was read, or that its endpoint is not answering. */
  sourceNote?: string;
}
export interface CatalogRow extends MetricDef {
  now: number | null;
  /** the world's source for this metric. */
  sourceId?: SourceId;
  /** when a remote number was read, or that its endpoint is not answering. */
  sourceNote?: string;
}
export interface PersonaSlide extends RoleLever {
  leverLabel: string;
  leverNow: number | null;
  /** The campaign numbers this role moves (every campaign of the repo with a target). */
  moves: { code: string; name: string; label: string; target: number; now: number | null; by: string | null }[];
  /** Every file it reads at each wake, shared ones first. */
  files: string[];
}
export interface ProductSlide {
  title: string;
  body: string;
  /** a feature list group drawn from the code repo docs/features/<service>.json (a `Features:` part, productFeatures.ts). */
  features?: { service: string; group: string; source: string; items: { id: string; title: string; text: string; since?: string }[] };
  /** the part's own title in the file when the slide was drawn from one (a note is filed against it). */
  part?: string;
}
export interface MotionBody {
  tenantId: string;
  repo: string | null;
  repos: string[];
  today: string;
  product: { file: string; title: string | null; slides: ProductSlide[]; missing: string[] };
  /** `?campaign=EPIC-n`: that campaign's own product deck (null when not asked or no such campaign). */
  campaignProduct?: ({ code: string; name: string; spine: string } & MotionBody["product"]) | null;
  catalog: CatalogRow[];
  targets: TargetView[];
  personas: PersonaSlide[];
}

/** The product deck: the file's title and one slide per `## ` part (an HTML comment is left out); `missing` names the parts not written yet. */
export function parseProduct(text: string | null, file: string = PRODUCT_FILE, parts: readonly string[] = PRODUCT_PARTS): MotionBody["product"] {
  if (!text) return { file, title: null, slides: [], missing: [...parts] };
  const clean = text.replace(/<!--[\s\S]*?-->/g, "");
  const title = /^#\s+(.+)$/m.exec(clean)?.[1].trim() ?? null;
  const slides: ProductSlide[] = [];
  for (const part of clean.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = (nl < 0 ? "" : part.slice(nl + 1)).trim();
    if (head) slides.push({ title: head, body });
  }
  const have = new Set(slides.map((s) => s.title.toLowerCase()));
  return { file, title, slides, missing: parts.filter((p) => !have.has(p.toLowerCase())) };
}

/** The catalog with today's values, every campaign's target and where it stands, one slide per role. */
export function computeMotion(inp: MetricInputs, spines: { rel: string; text: string }[]): Pick<MotionBody, "catalog" | "targets" | "personas"> {
  const world = repoSources(spines.find((s) => s.rel.endsWith("/root.md"))?.text);
  const srcOf = (id: MetricId): SourceId => world[id] ?? "default";
  // A world's own ledger counts its own units: the catalog's sites and addresses name only the default source; a remote
  // source names the page where its numbers live.
  const whereOf = (def: MetricDef, sourceId: SourceId) => (sourceId === "default" ? def.where : isRemote(sourceId) ? [remoteSourceOf(sourceId)!.def.page] : undefined);
  const note = (sourceId: SourceId) => (isRemote(sourceId) ? { sourceNote: sourceNote(sourceId, inp.remote) } : {});
  const catalog = METRICS.map((m) => {
    const sourceId = srcOf(m.id);
    const source = sourceText(m, sourceId, inp.remote);
    return { ...m, where: whereOf(m, sourceId), source, sourceId, ...note(sourceId), now: source ? metricValue(m.id, inp, { source: sourceId }) : null };
  });
  const targets: TargetView[] = spines
    .map((s) => campaignTarget(s.rel, s.text))
    .filter((t) => t.metric || t.unknown || t.tag)
    .map((t) => {
      const def = t.metric ? metricDef(t.metric) : undefined;
      if (!def) return { ...t, label: null, source: null, now: null };
      const asked = t.sourceAsked;
      const askedId = sourceIdOf(asked);
      if (asked && !askedId) return { ...t, label: def.label, source: `not a source: ${asked} (one of ${sourceWords()})`, sourceId: "unknown" as const, now: null };
      const sourceId = askedId ?? srcOf(def.id);
      const source = sourceText(def, sourceId, inp.remote);
      return {
        ...t,
        label: def.label,
        where: whereOf(def, sourceId),
        source,
        sourceId,
        ...note(sourceId),
        now: source ? metricValue(def.id, inp, { from: def.kind === "total" ? t.from : null, campaign: def.id === "posts_out" || def.id === "replies_received" ? t.tag : null, source: sourceId }) : null,
      };
    });
  const set = targets.filter((t) => t.metric && t.target !== null);
  const personas = ROLE_LEVERS.map((r) => {
    const def = metricDef(r.lever)!;
    return {
      ...r,
      leverLabel: def.label,
      leverNow: srcOf(r.lever) === "none" ? null : metricValue(r.lever, inp, { source: srcOf(r.lever) }),
      moves: set.map((t) => ({ code: t.code, name: t.name, label: t.label!, target: t.target!, now: t.now, by: t.by })),
      files: [...SHARED_READS, ...set.map((t) => t.spine).filter((s, i, a) => a.indexOf(s) === i), ...r.reads],
    };
  });
  return { catalog, targets, personas };
}

const cell = (s: string | number | null | undefined) => (s === null || s === undefined || s === "" ? "" : String(s).replace(/\|/g, "/").replace(/\n/g, " "));
const show = (n: number | null, source: string | null) => (source === null ? "no source yet" : n === null ? "not read yet" : String(n));

/**
 * `data/metrics.md` as the console writes it. It carries no time of day, so the file (and a commit) changes only when a
 * number, a target or the catalog changes; `today` is the day of the reading that changed it.
 */
export function renderMetricsFile(m: Pick<MotionBody, "catalog" | "targets" | "personas"> & { sites?: SiteCount[] }, today: string): string {
  const L = [
    "# Metrics",
    "",
    metricSetup.fileIntro,
    "",
    `Last change: ${today}`,
    "",
    "## Targets",
    "",
    "| Campaign | Metric | Target | By | Now | Counted from | Set by |",
    "|---|---|---|---|---|---|---|",
    ...(m.targets.length
      ? m.targets.map((t) =>
          t.metric
            ? `| ${cell(`${t.code} ${t.name}`)} | ${cell(t.metric)} (${cell(t.label)}${t.sourceId && t.sourceId !== "default" ? `, ${t.sourceId === "unknown" ? cell(t.source) : `source ${t.sourceId}`}` : ""}) | ${t.target ?? ""} | ${cell(t.by)} | ${show(t.now, t.source)} | ${cell(t.from) || "all time"} | ${t.proposed ? `proposed, ${metricSetup.owner} sets it` : metricSetup.owner} |`
            : `| ${cell(`${t.code} ${t.name}`)} | ${t.unknown ? `not in the catalog: ${cell(t.unknown)}` : "no target yet"} |  |  |  |  |  |`,
        )
      : ["| none yet |  |  |  |  |  |  |"]),
    "",
    "## Catalog",
    "",
    "| Id | Metric | One unit is | Kind | Now (all time or latest) | Source |",
    "|---|---|---|---|---|---|",
    ...m.catalog.map((c) => `| ${c.id} | ${cell(c.label)} | ${cell(c.counts)} | ${c.kind} | ${show(c.now, c.source)} | ${cell(c.source ?? "no source yet")} |`),
    "",
    ...sitesSection(m.sites, today),
    "## Who moves what",
    "",
    "Each role wakes to move its campaign's target through its own number, and reads these files first.",
    "",
    "| Role | Moves | Its own number | How | Reads |",
    "|---|---|---|---|---|",
    ...m.personas.map(
      (p) =>
        `| ${p.role} | ${cell(p.moves.map((x) => `${x.code} ${x.label} ${x.now ?? "?"} of ${x.target}`).join(", ") || "no campaign target yet")} | ${cell(`${p.leverLabel}: ${p.leverNow ?? "not read yet"}`)} | ${cell(p.how)} | ${cell(p.files.join(", "))} |`,
    ),
    "",
  ];
  return L.join("\n");
}

/**
 * every site's visits and sign-ups, one number per site per day, for the last seven full UTC days (today is left
 * out so the file changes once a day). The team's own worlds only; a tester's world gets no section.
 */
export function sitesSection(sites: SiteCount[] | undefined, today: string): string[] {
  if (!sites?.length) return [];
  const days = [...new Set(sites.flatMap((s) => s.visits.map((p) => p.date)))].filter((d) => d < today).sort().slice(-7).reverse();
  const at = (pts: { date: string; value: number }[], d: string) => pts.find((p) => p.date === d)?.value ?? 0;
  return [
    "## Every site",
    "",
    metricSetup.sitesIntro ?? NEUTRAL_SITES_INTRO,
    "",
    ...sites.map((s) => `- ${s.name}: [${s.label}](${s.url})${s.pages ? `, pages ${s.pages.map((p) => `[${p.address}](${p.url})`).join(", ")}` : ""}${s.note ? `. ${s.note}` : ""}`),
    "",
    `| Date | ${sites.map((s) => `${s.name} ${s.label} visits | ${s.name} ${s.label} sign-ups`).join(" | ")} | All sites visits | All sites sign-ups |`,
    `|---|${sites.map(() => "---|---").join("|")}|---|---|`,
    ...(days.length
      ? days.map((d) => `| ${d} | ${sites.map((s) => `${at(s.visits, d)} | ${at(s.signups, d)}`).join(" | ")} | ${sites.reduce((a, s) => a + at(s.visits, d), 0)} | ${sites.reduce((a, s) => a + at(s.signups, d), 0)} |`)
      : [`| none yet | ${sites.map(() => " | ").join(" | ")} |  |  |`]),
    "",
  ];
}

/** The file without its `Last change:` line: what decides whether to write. */
export const metricsBody = (text: string) => text.replace(/^Last change: .*$/m, "").trim();

setMetricSetup(NEUTRAL_METRIC_SETUP);
