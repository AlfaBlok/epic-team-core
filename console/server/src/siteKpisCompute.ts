/**
 * the site numbers' shapes and computation (siteKpis.ts serves them; the web mock runs the same code).
 */

/** Which site and address a number counts: shown beside it, the address a link to that page. */
export interface SiteWhere {
  name: string;
  address: string;
  url: string;
}

/** One public site of the team whose visits and sign-ups the console counts. */
export interface SiteDef {
  host: string;
  label: string;
  name: string;
  what: string;
  /** a plain note shown beside it ("" for none) */
  note: string;
  /** in plain words, where its numbers come from */
  source: string;
}

/**
 * The team's sites (config): the first is the home site, whose counter counts per page; `codeRepo` is the public code
 * whose GitHub views count. The words name the sites, so they are config too; the hosted layer sets its own
 * (setSiteSetup) before any number is computed. The defaults are a neutral example.
 */
export interface SiteSetup {
  /** the home site's counted pages, path → label ("/testers/" → "example.com testers") */
  homePages: Record<string, string>;
  sites: SiteDef[];
  /** owner/name of the public code repo on GitHub */
  codeRepo: string;
  /** the code repo's product name, shown beside its views */
  codeName: string;
  /** where new users sign up: the words under the chart and the sites */
  newUsersSource: string;
  newUsersWhere: SiteWhere[];
  /** where the home site's page views come from */
  pageViewsSource: string;
  /** the head of data/site-daily.md and of data/sites-daily.md (the record's own words; changing them rewrites the files) */
  siteDailyHead: string;
  sitesDailyHead: string;
  /** the sites-daily head's sign-ups line, when a site counts sign-ups its own way */
  sitesSignupsLine?: string;
}

export const NEUTRAL_SITE_SETUP: SiteSetup = {
  homePages: { "/": "example.com home", "/testers/": "example.com testers" },
  sites: [{ host: "example.com", label: "example.com", name: "Example", what: "Example: home and testers", note: "", source: "Our own counter on every example.com page and our tester form and waitlist." }],
  codeRepo: "example-org/example",
  codeName: "Example code",
  newUsersSource: "Our testers application and waitlist forms on example.com, as the console stores them. Every site below splits them per site.",
  newUsersWhere: [{ name: "Example", address: "example.com", url: "https://example.com/" }],
  pageViewsSource: "Our own counter on the example.com pages example.com/ and /testers/.",
  siteDailyHead: "One line per UTC day for our public pages, written once a day by the console: one commit a day, never one per visit. Nobody edits it by hand.",
  sitesDailyHead: "One line per site and UTC day: visits and sign-ups of every site of ours, written once a day by the console, in the same commit as data/site-daily.md. Nobody edits it by hand.",
};

/** the home site's counted pages (path → label) */
export let SITE_PAGES: Readonly<Record<string, string>> = NEUTRAL_SITE_SETUP.homePages;
export type SitePage = string;
export let SITES: readonly SiteDef[] = NEUTRAL_SITE_SETUP.sites;
export type SiteHost = string;
export let HOME_SITE: SiteHost = NEUTRAL_SITE_SETUP.sites[0].host;
/** the home site, as a number's `where` */
export let HOME_WHERE: SiteWhere = { name: NEUTRAL_SITE_SETUP.sites[0].name, address: HOME_SITE, url: `https://${HOME_SITE}/` };
export let CODE_REPO = NEUTRAL_SITE_SETUP.codeRepo;
export let CODE_KEY = `github:${CODE_REPO}`;
/** what a total of every site adds up, in words ("Example example.com, Other other.example"). */
export let SITES_ADDED = "";
let setup: SiteSetup = NEUTRAL_SITE_SETUP;
let SITE_ORDER = new Map<string, number>();
let SITE_SOURCE: Record<SiteHost, string> = {};

/** set the team's sites (the hosted layer, once at load; a test may set its own). Every exported value follows it. */
export function setSiteSetup(next: SiteSetup): void {
  setup = next;
  SITE_PAGES = next.homePages;
  SITES = next.sites;
  HOME_SITE = next.sites[0].host;
  HOME_WHERE = { name: next.sites[0].name, address: HOME_SITE, url: `https://${HOME_SITE}/` };
  CODE_REPO = next.codeRepo;
  CODE_KEY = `github:${CODE_REPO}`;
  SITES_ADDED = next.sites.map((s) => `${s.name} ${s.host}`).join(", ");
  SITE_ORDER = new Map(next.sites.map((s, i) => [s.host, i]));
  SITE_SOURCE = Object.fromEntries(next.sites.map((s) => [s.host, s.source]));
  SITE_DAILY_HEAD = siteDailyHead(next);
  SITES_DAILY_HEAD = sitesDailyHead(next);
}
export const siteSetup = (): SiteSetup => setup;

/** a counted page's address, "example.com/testers/". */
export const sitePageAddress = (p: SitePage) => `${HOME_SITE}${p}`;
export const sitePageUrl = (p: SitePage) => `https://${sitePageAddress(p)}`;
export const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|curl|wget|python|httpclient/i;

export type SiteSeriesKey = "pageViews" | "newUsers" | "codeViews";
export interface SiteSeries {
  key: SiteSeriesKey;
  label: string;
  since: string | null;
  points: { date: string; value: number }[];
  kind: "count";
  note: string;
  /** Where the number comes from, in plain words (shown under the chart). */
  source: string;
  /** Per page (pageViews) or per offer (newUsers): the range's split, for the note. */
  parts?: { label: string; points: { date: string; value: number }[] }[];
  /** per source (a post id, a referring site, direct): where the visits or the sign-ups came from. */
  sources?: { label: string; points: { date: string; value: number }[] }[];
  /** the sites and addresses this number counts. */
  where?: SiteWhere[];
}
export interface SiteKpisBody {
  tenantId: string;
  shown: boolean;
  today: string;
  series: SiteSeries[];
  /** test visits (`?s=TEST`) the counter kept today, never counted. */
  testToday?: number;
  /** every site's visits and sign-ups, one number per site per day. */
  sites?: SiteCount[];
}

/** Normalises a counted page: "/testers", "/testers/index.html", "https://<home site>/testers/?x" → "/testers/"; else null. */
export function sitePageOf(raw: string | undefined | null): SitePage | null {
  let p = (raw ?? "").trim().slice(0, 300);
  if (!p) return null;
  try {
    if (/^https?:\/\//i.test(p)) {
      const u = new URL(p);
      if (u.hostname.toLowerCase().replace(/^www\./, "") !== HOME_SITE) return null;
      p = u.pathname;
    }
  } catch {
    return null;
  }
  p = p.split(/[?#]/)[0].replace(/index\.html$/i, "");
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.endsWith("/")) p = `${p}/`;
  return p in SITE_PAGES ? (p as SitePage) : null;
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** One point per day from `since` to `today` (zero on a quiet day). */
function fill(by: Map<string, number>, since: string | null, today: string) {
  const out: { date: string; value: number }[] = [];
  if (!since) return out;
  for (let d = since; d <= today && out.length < 3000; d = addDays(d, 1)) out.push({ date: d, value: by.get(d) ?? 0 });
  return out;
}

export function computeSiteKpis(o: {
  signups: { createdAt: string; offer: string; visitSource?: string | null }[];
  views: { day: string; page: string; n: number }[];
  today: string;
  counterSince: string | null;
  codeError?: string | null;
  /** non-test visits per day and source (console.db site_visits). */
  visits?: { day: string; source: string; n: number }[];
  /** the repo's daily lines (data/site-daily.md): past days read from there. */
  daily?: SiteDailyRow[];
}): SiteSeries[] {
  const { today } = o;
  const daily = o.daily ?? [];
  const views = mergeDailyViews(o.views, daily);
  const raw: SiteRaw = { views, visits: o.visits ?? [], signups: o.signups };
  const written = new Map(daily.map((r) => [r.date, r]));
  const rowOf = (d: string) => written.get(d) ?? dailyRowOf(raw, d);
  /** Per source, one point a day over [since, today]; undefined when no source was ever recorded. */
  const bySource = (since: string | null, pick: (r: SiteDailyRow) => DailySource[]) => {
    if (!since || (!o.visits && !daily.length)) return undefined;
    const rows = fill(new Map(), since, today).map((p) => rowOf(p.date));
    const labels = [...new Set(rows.flatMap((r) => pick(r).map((x) => x.label)))];
    return labels.map((label) => ({ label, points: rows.map((r) => ({ date: r.date, value: pick(r).find((x) => x.label === label)?.n ?? 0 })) }));
  };
  const byDay = (rows: { day: string; n: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.day, (m.get(r.day) ?? 0) + r.n);
    return m;
  };
  const first = (m: Map<string, number>) => ([...m.keys()].sort()[0] ?? null);
  // New users: one per email on its first day; the offer split for the note.
  const su = o.signups.map((s) => ({ day: s.createdAt.slice(0, 10), n: 1, offer: /tester-10/.test(s.offer) ? "tester" : "waitlist" }));
  const suBy = byDay(su);
  const suSince = first(suBy);
  const newUsers: SiteSeries = {
    key: "newUsers",
    label: "New users registered, all our sites",
    since: suSince,
    points: fill(suBy, suSince, today),
    kind: "count",
    note: suSince ? "People who signed up on our pages, each counted once on the day of their first signup." : "Nobody has signed up yet.",
    source: setup.newUsersSource,
    parts: (["tester", "waitlist"] as const).map((k) => ({ label: k === "tester" ? "tester applications" : "waitlist", points: fill(byDay(su.filter((s) => s.offer === k)), suSince, today) })),
    sources: bySource(suSince, (r) => r.applicationSources),
    where: setup.newUsersWhere,
  };
  // Page views of the home site: our counter, per page.
  const pv = views.filter((v) => v.page in SITE_PAGES);
  const pvBy = byDay(pv);
  const pvSince = o.counterSince ?? first(pvBy);
  const pageViews: SiteSeries = {
    key: "pageViews",
    label: `Page views on ${HOME_SITE}`,
    since: pvSince,
    points: fill(pvBy, pvSince, today),
    kind: "count",
    note: pvSince ? "One view per visitor, page and day. No cookie, crawlers skipped." : "Not counting yet: the counter waits for the pages to call it.",
    source: setup.pageViewsSource,
    parts: (Object.keys(SITE_PAGES) as SitePage[]).map((p) => ({ label: sitePageAddress(p), points: fill(byDay(pv.filter((v) => v.page === p)), pvSince, today) })),
    sources: bySource(pvSince, (r) => r.sources),
    where: [HOME_WHERE],
  };
  // Views of the public code on GitHub.
  const cv = views.filter((v) => v.page === CODE_KEY);
  const cvBy = byDay(cv);
  const cvSince = first(cvBy);
  const codeViews: SiteSeries = {
    key: "codeViews",
    label: "Code page views on GitHub",
    since: cvSince,
    points: fill(cvBy, cvSince, today),
    kind: "count",
    note: o.codeError ? `GitHub could not be read: ${o.codeError}` : cvSince ? "Views GitHub counted, read every hour." : "No reading yet.",
    source: `GitHub traffic of github.com/${CODE_REPO}, kept here day by day since GitHub keeps only 14 days.`,
    where: [{ name: setup.codeName, address: `github.com/${CODE_REPO}`, url: `https://github.com/${CODE_REPO}` }],
  };
  return [pageViews, newUsers, codeViews];
}


// ---------------------------------------------------------------------------------------------------- sources

/**
 * Where a visit came from, and the one daily line per world in `data/site-daily.md`:
 *  - a post link carries `?s=<post id>` (the posts ledger's id, e.g. P-0042); the page passes it to the counter with the
 *    referring site's host name only (never the full address). The source of a visit is that id, else the referring
 *    host, else `direct`. `?s=TEST` (any case) marks a test visit: kept as a row, never counted.
 *  - each visit is one row in console.db `site_visits` (time, page, source, referring host, test); nothing about the visitor.
 *  - once a day the console writes ONE line per world to `data/site-daily.md` (date, visits, top sources, applications and
 *    their sources): one commit a day per repo, however many people come. Past days read from that file (the repo is the
 *    source, L-45); today reads from the database.
 */

export const SITE_DAILY_FILE = "data/site-daily.md";
export const DIRECT = "direct";
/** Where a source is unknown: a visit or sign-up from before sources were recorded. */
export const NOT_RECORDED = "not recorded";

/** The host name of a referrer ("https://t.co/abc" or "t.co" → "t.co"), lower case, no www; "" when none or not a host. */
export function refHostOf(raw: string | undefined | null): string {
  let s = (raw ?? "").trim().slice(0, 300);
  if (!s) return "";
  try {
    s = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? new URL(s).hostname : s.split(/[/?#:]/)[0];
  } catch {
    return "";
  }
  s = s.toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) && s.length <= 100 ? s : "";
}

/** A post id from `?s=` ("P-0042"), else null: letters, digits, `-`, `_`, `.`, at most 40. */
export function sourceTagOf(raw: string | undefined | null): string | null {
  const s = (raw ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(s) ? s : null;
}

/** A visit's (or a sign-up's) source: the post id, else the referring host, else `direct`; `TEST` marks a test. */
export function visitSourceOf(s: string | undefined | null, ref: string | undefined | null): { source: string; referrer: string; test: boolean } {
  const tag = sourceTagOf(s);
  const referrer = refHostOf(ref);
  const test = !!tag && /^test$/i.test(tag);
  return { source: test ? "TEST" : tag || referrer || DIRECT, referrer, test };
}

export interface DailySource {
  label: string;
  n: number;
}
/** One line of `data/site-daily.md`. */
export interface SiteDailyRow {
  date: string;
  visits: number;
  sources: DailySource[];
  applications: number;
  applicationSources: DailySource[];
}

const siteDailyHead = (o: SiteSetup) => [
  "# Site daily",
  "",
  o.siteDailyHead,
  "",
  "- Visits: one per visitor, page and day, from our own counter (no cookie, nothing about the visitor kept, crawlers and test visits skipped).",
  "- Top sources: the post id a link carried (`?s=P-0042`), else the site the visitor came from, else direct. `not recorded`: before sources were kept (8 Nov 2026).",
  "- Applications: tester applications and waitlist sign-ups that day, with the source of the visit that led to them.",
  "",
  "| Date | Visits | Top sources | Applications | Application sources |",
  "|---|---|---|---|---|",
].join("\n");
export let SITE_DAILY_HEAD = siteDailyHead(NEUTRAL_SITE_SETUP);

const TOP = 5;
const fmtSources = (l: DailySource[]) => (l.length ? l.map((s) => `${s.label} ${s.n}`).join(", ") : "none");
const parseSources = (cell: string): DailySource[] =>
  cell.trim() === "none"
    ? []
    : cell
        .split(",")
        .map((p) => /^(.+?)\s+(\d+)$/.exec(p.trim()))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ label: m[1], n: Number(m[2]) }));

/** Sources sorted by count (then name), the first five kept and the rest summed as `other`. */
export function topSources(by: Map<string, number>): DailySource[] {
  const all = [...by].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = all.slice(0, TOP).map(([label, n]) => ({ label, n }));
  const rest = all.slice(TOP).reduce((a, [, n]) => a + n, 0);
  return rest ? [...top, { label: "other", n: rest }] : top;
}

export const renderDailyRow = (r: SiteDailyRow) => `| ${r.date} | ${r.visits} | ${fmtSources(r.sources)} | ${r.applications} | ${fmtSources(r.applicationSources)} |`;

/** The file's lines, oldest first; lines that do not parse are skipped. */
export function parseSiteDaily(text: string | null | undefined): SiteDailyRow[] {
  const out: SiteDailyRow[] = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d+)\s*\|([^|]*)\|\s*(\d+)\s*\|([^|]*)\|\s*$/.exec(line.trim());
    if (m) out.push({ date: m[1], visits: Number(m[2]), sources: parseSources(m[3]), applications: Number(m[4]), applicationSources: parseSources(m[5]) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** The whole file: the head, then one line per day (oldest first, one per date; a given date keeps its first line). */
export function renderSiteDaily(rows: SiteDailyRow[]): string {
  const seen = new Set<string>();
  const keep = [...rows].sort((a, b) => a.date.localeCompare(b.date)).filter((r) => !seen.has(r.date) && seen.add(r.date));
  return `${SITE_DAILY_HEAD}\n${keep.map(renderDailyRow).join("\n")}${keep.length ? "\n" : ""}`;
}

/** The console's raw site rows for the daily line (non-test visits per day and source; sign-ups with their source). */
export interface SiteRaw {
  /** site_views of the counted pages: the visit counts. */
  views: { day: string; page: string; n: number }[];
  /** site_visits, test visits left out, grouped: the sources. */
  visits: { day: string; source: string; n: number }[];
  signups: { createdAt: string; visitSource?: string | null }[];
}

/** One day's line from the console's rows: visits from the counter, sources from the visit rows (the rest `not recorded`). */
export function dailyRowOf(raw: SiteRaw, date: string): SiteDailyRow {
  const visits = raw.views.filter((v) => v.day === date && v.page in SITE_PAGES).reduce((a, v) => a + v.n, 0);
  const by = new Map<string, number>();
  for (const v of raw.visits) if (v.day === date) by.set(v.source, (by.get(v.source) ?? 0) + v.n);
  const tagged = [...by.values()].reduce((a, n) => a + n, 0);
  if (visits > tagged) by.set(NOT_RECORDED, (by.get(NOT_RECORDED) ?? 0) + visits - tagged);
  const apps = raw.signups.filter((s) => s.createdAt.slice(0, 10) === date);
  const ab = new Map<string, number>();
  for (const s of apps) ab.set(s.visitSource || NOT_RECORDED, (ab.get(s.visitSource || NOT_RECORDED) ?? 0) + 1);
  return { date, visits, sources: topSources(by), applications: apps.length, applicationSources: topSources(ab) };
}

/** The days a daily line is due for: from the first counted day (or `since`) to yesterday, minus the days written. */
export function dueDays(raw: SiteRaw, written: SiteDailyRow[], today: string): string[] {
  const days = raw.views.filter((v) => v.page in SITE_PAGES).map((v) => v.day).sort();
  if (!days.length) return [];
  const have = new Set(written.map((r) => r.date));
  const out: string[] = [];
  for (let d = days[0]; d < today && out.length < 400; d = addDays(d, 1)) if (!have.has(d)) out.push(d);
  return out;
}

/** Past days from the repo's daily lines, today (and any day not written yet) from the database: the counted pages' views. */
export function mergeDailyViews(views: { day: string; page: string; n: number }[], daily: SiteDailyRow[]): { day: string; page: string; n: number }[] {
  if (!daily.length) return views;
  const written = new Map(daily.map((r) => [r.date, r.visits]));
  const pagesDb = views.filter((v) => !(v.page in SITE_PAGES) || !written.has(v.day));
  // A written day keeps its per-page split from the database when it agrees with the line (the line wins on a difference or a lost database).
  const out = [...pagesDb];
  for (const [day, n] of written) {
    const db = views.filter((v) => v.day === day && v.page in SITE_PAGES);
    if (db.reduce((a, v) => a + v.n, 0) === n) out.push(...db);
    else if (n > 0) out.push({ day, page: "/", n });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}


// ---------------------------------------------------------------------------------------------------- every site

/**
 * every site of ours reports its visits and sign-ups, one number per site per day, counted by
 * our own counter and our own records (no third-party tracker, no cookie).
 *  - Visits: a page asks the same 1x1 image (GET /api/public/pv) with `h=<its host>`. The home site keeps its per-page
 *    counts (SITE_PAGES, the numbers, unchanged); another site counts under one key `site:<host>`, whatever page.
 *    A host not in SITES (a preview, the tailnet) is read as the home site, as before.
 *  - Sign-ups: our tester form stores the site it was sent from (tester_signups.site, from the form's `site` field or its
 *    Origin); a site whose sign-ups land in its own system (memory.dev: cloud.memory.dev) sends the image once with
 *    `e=signup` when someone signs up (table site_signups, nothing about the person). `s=TEST` is a test either way:
 *    kept, shown as a test, never counted.
 *  - The record: once a day the console writes one line per site and day to the world's data/sites-daily.md (with the
 *    data/site-daily.md, same commit) and the last seven days into data/metrics.md, the catalog every campaign reads.
 */
export const siteKey = (host: SiteHost) => `site:${host}`;

/** A known site from a host name ("www.example.com" → "example.com"); null when it is not one of ours. */
export function siteOf(raw: string | undefined | null): SiteHost | null {
  let h = (raw ?? "").trim().toLowerCase().slice(0, 200);
  try {
    if (/^https?:\/\//.test(h)) h = new URL(h).hostname;
  } catch {
    return null;
  }
  h = h.replace(/^www\./, "").replace(/\.$/, "");
  return SITES.find((s) => s.host === h)?.host ?? null;
}

/** The site a site_views or site_visits page key belongs to (the home site's pages, `site:<host>`), else null. */
export function siteOfPage(page: string): SiteHost | null {
  if (page in SITE_PAGES) return HOME_SITE;
  return page.startsWith("site:") ? siteOf(page.slice(5)) : null;
}

export interface SiteCount {
  host: SiteHost;
  label: string;
  what: string;
  /** the product's name, its home page and, when it applies, a plain note (a site that serves another product's page). */
  name: string;
  url: string;
  note: string;
  /** the home site only: its visits per counted page, each with its address. */
  pages?: { address: string; url: string; visits: { date: string; value: number }[] }[];
  /** One point a day, oldest first, from the first counted day of any site to today. */
  visits: { date: string; value: number }[];
  signups: { date: string; value: number }[];
  /** Test visits and test sign-ups (`s=TEST`) today: kept and shown, never counted. */
  testVisitsToday: number;
  testSignupsToday: number;
  /** Plain words on where the numbers come from (or why there are none yet). */
  source: string;
}

/** The raw rows every site's count reads (console.db, test rows kept apart). */
export interface SitesRaw {
  views: { day: string; page: string; n: number }[];
  /** Tester form sign-ups with their site (null: before, the home site) and visit source (TEST = a test). */
  formSignups: { createdAt: string; site: string | null; visitSource: string | null }[];
  /** Sign-up beacons from sites whose sign-ups live elsewhere (site_signups). */
  beacons: { day: string; site: string; test: number; n: number }[];
  /** Test visits per day and page (site_visits test = 1). */
  testVisits: { day: string; page: string; n: number }[];
}

/** One line of data/sites-daily.md. */
export interface SitesDailyRow {
  date: string;
  site: SiteHost;
  visits: number;
  signups: number;
}


/** One site's visits and sign-ups on one day (test rows left out). */
export function siteDay(raw: SitesRaw, host: SiteHost, date: string): { visits: number; signups: number } {
  const visits = raw.views.filter((v) => v.day === date && siteOfPage(v.page) === host).reduce((a, v) => a + v.n, 0);
  const form = raw.formSignups.filter((s) => s.createdAt.slice(0, 10) === date && (siteOf(s.site) ?? HOME_SITE) === host && !/^test$/i.test(s.visitSource ?? "")).length;
  const beacon = raw.beacons.filter((b) => b.day === date && b.site === host && !b.test).reduce((a, b) => a + b.n, 0);
  return { visits, signups: form + beacon };
}

/** The first day any site counted a visit or a sign-up (null: nothing yet). */
export function sitesSince(raw: SitesRaw): string | null {
  const days = [
    ...raw.views.filter((v) => siteOfPage(v.page)).map((v) => v.day),
    ...raw.formSignups.filter((s) => !/^test$/i.test(s.visitSource ?? "")).map((s) => s.createdAt.slice(0, 10)),
    ...raw.beacons.filter((b) => !b.test).map((b) => b.day),
  ].sort();
  return days[0] ?? null;
}

/** Every site's daily numbers over [since, today]; a written day reads from data/sites-daily.md (the record). */
export function computeSites(raw: SitesRaw, today: string, written: SitesDailyRow[] = []): SiteCount[] {
  const since = [sitesSince(raw), ...written.map((r) => r.date)].filter((d): d is string => !!d).sort()[0] ?? today;
  const rec = new Map(written.map((r) => [`${r.date}|${r.site}`, r]));
  const days = fill(new Map(), since, today).map((p) => p.date);
  return SITES.map((s) => {
    const per = days.map((d) => rec.get(`${d}|${s.host}`) ?? { date: d, ...siteDay(raw, s.host, d) });
    const testVisitsToday = raw.testVisits.filter((v) => v.day === today && siteOfPage(v.page) === s.host).reduce((a, v) => a + v.n, 0);
    const testSignupsToday =
      raw.formSignups.filter((f) => f.createdAt.slice(0, 10) === today && (siteOf(f.site) ?? HOME_SITE) === s.host && /^test$/i.test(f.visitSource ?? "")).length +
      raw.beacons.filter((b) => b.day === today && b.site === s.host && b.test).reduce((a, b) => a + b.n, 0);
    return {
      host: s.host,
      label: s.label,
      what: s.what,
      visits: per.map((r, i) => ({ date: days[i], value: r.visits })),
      signups: per.map((r, i) => ({ date: days[i], value: r.signups })),
      testVisitsToday,
      testSignupsToday,
      source: SITE_SOURCE[s.host],
      name: s.name,
      url: `https://${s.host}/`,
      note: s.note,
      ...(s.host === HOME_SITE
        ? {
            pages: (Object.keys(SITE_PAGES) as SitePage[]).map((p) => ({
              address: sitePageAddress(p),
              url: sitePageUrl(p),
              visits: days.map((d) => ({ date: d, value: raw.views.filter((v) => v.day === d && v.page === p).reduce((a, v) => a + v.n, 0) })),
            })),
          }
        : {}),
    };
  });
}

export const SITES_DAILY_FILE = "data/sites-daily.md";
const sitesDailyHead = (o: SiteSetup) => [
  "# Every site, per day",
  "",
  o.sitesDailyHead,
  "",
  "- Visits: one per visitor, page and day, from our own counter (no cookie, nothing about the visitor kept, crawlers and test visits skipped).",
  ...(o.sitesSignupsLine ? [o.sitesSignupsLine] : ["- Sign-ups: our tester form and waitlist sent from that site. Test sign-ups are never counted."]),
  "",
  "| Date | Site | Visits | Sign-ups |",
  "|---|---|---|---|",
].join("\n");
export let SITES_DAILY_HEAD = sitesDailyHead(NEUTRAL_SITE_SETUP);

export function parseSitesDaily(text: string | null | undefined): SitesDailyRow[] {
  const out: SitesDailyRow[] = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([a-z0-9.-]+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$/.exec(line.trim());
    const site = m ? siteOf(m[2]) : null;
    if (m && site) out.push({ date: m[1], site, visits: Number(m[3]), signups: Number(m[4]) });
  }
  return out;
}

export function renderSitesDaily(rows: SitesDailyRow[]): string {
  const seen = new Set<string>();
  const keep = [...rows]
    .sort((a, b) => a.date.localeCompare(b.date) || (SITE_ORDER.get(a.site) ?? 9) - (SITE_ORDER.get(b.site) ?? 9))
    .filter((r) => !seen.has(`${r.date}|${r.site}`) && seen.add(`${r.date}|${r.site}`));
  return `${SITES_DAILY_HEAD}\n${keep.map((r) => `| ${r.date} | ${r.site} | ${r.visits} | ${r.signups} |`).join("\n")}${keep.length ? "\n" : ""}`;
}

/** The lines due: every site for each day from the first counted day to yesterday that the file does not hold yet. */
export function dueSitesDaily(raw: SitesRaw, written: SitesDailyRow[], today: string): SitesDailyRow[] {
  const since = sitesSince(raw);
  if (!since) return [];
  const have = new Set(written.map((r) => `${r.date}|${r.site}`));
  const out: SitesDailyRow[] = [];
  for (let d = since; d < today && out.length < 4 * 400; d = addDays(d, 1))
    for (const s of SITES) if (!have.has(`${d}|${s.host}`)) out.push({ date: d, site: s.host, ...siteDay(raw, s.host, d) });
  return out;
}

setSiteSetup(NEUTRAL_SITE_SETUP);
