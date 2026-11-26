import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { resolveRepo } from "./adapters/repos.js";
import { homeRepo } from "./identity.js";

/**
 * No floating pages: every one-off page the team serves (a summary, a report, a proposal, a mockup) has a parent.
 * `docs/pages/registry.json` of the home repo is the record: one entry per page (its address, title, the row that
 * keeps it, its repo and epic) and the hosts those pages live on. This reads it for the Pages index (GET /api/pages,
 * grouped by repo and epic, each page linking down) and for the review gate: a card whose evidence is a page on one
 * of those hosts with no entry has no parent, so it goes back as "needs evidence". The page itself links up to its
 * epic's group here and to its epic deck (the header the host's page server adds). The repo is the record.
 */
export const PAGES_FILE = "docs/pages/registry.json";

export interface PageEntry {
  port?: number;
  /** where the page sits below the port's root (`/team/`), when not at `/`. */
  path?: string;
  /** a page served elsewhere (no port on the page host) names its address. */
  url?: string;
  title: string;
  row: string;
  repo: string;
  epic: string;
  epicTitle?: string;
  /** an approved page's short plain name, shown as its title on the list and its pin. */
  name?: string;
  /** pinned at the top of the Pages list (scripts/pages.py pin). */
  pinned?: boolean;
  /** its short address on the console, `/<slug>` (redirects to the page). */
  slug?: string;
  /** the user unit on the page host that rebuilds it; the Refresh button runs it through the page server. */
  refresh?: string;
  /** the day it was registered (YYYY-MM-DD): a wheel's Pages tab lists newest first. */
  added?: string;
  /** the objective (docs/pursuits.json id) or world it was made for, when its row's spine sits in none (scripts/pages.py place). */
  objective?: string;
  /** a world's name (the house) when `objective` names a world. */
  objectiveName?: string;
  /** why no objective or world holds it. */
  notPlaced?: string;
}
export interface PagesRegistry {
  rule?: string;
  /** the host names and addresses one-off pages are served on (the page host's tailnet name and IP). */
  hosts: string[];
  pages: PageEntry[];
}
export interface PageView extends PageEntry {
  url: string;
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
  /** the named pages pinned above everything else, in the registry's order. */
  pinned: PageView[];
  groups: PageGroup[];
  total: number;
  rule?: string;
}

export function parsePages(text: string): PagesRegistry {
  const doc = JSON.parse(text) as Partial<PagesRegistry>;
  const pages = (Array.isArray(doc.pages) ? doc.pages : []).filter(
    (p): p is PageEntry => !!p && typeof p === "object" && (typeof p.port === "number" || typeof p.url === "string"),
  );
  return { ...(doc.rule ? { rule: doc.rule } : {}), hosts: Array.isArray(doc.hosts) ? doc.hosts.filter((h) => typeof h === "string") : [], pages };
}

/** The page's address: its own url, else the first host with its port. */
export function pageUrl(p: PageEntry, hosts: string[]): string {
  if (p.url) return p.url;
  const at = p.path ? `/${p.path.replace(/^\/+/, "")}` : "/";
  return `http://${hosts[0] ?? "localhost"}:${p.port}${at}`;
}

const groupId = (repo: string, epic: string) => `${repo}-${epic}`;

/** Every page grouped by repo, then epic (the home repo first, epics by number). */
export function groupPages(reg: PagesRegistry, home = homeRepo()): PagesBody {
  const groups = new Map<string, PageGroup>();
  for (const p of reg.pages) {
    const repo = p.repo || home;
    const epic = p.epic || "no epic";
    const id = groupId(repo, epic);
    const g = groups.get(id) ?? { id, repo, epic, epicTitle: p.epicTitle ?? "", pages: [] };
    if (!g.epicTitle && p.epicTitle) g.epicTitle = p.epicTitle;
    g.pages.push({ ...p, url: pageUrl(p, reg.hosts) });
    groups.set(id, g);
  }
  const num = (e: string) => Number(/(\d+)/.exec(e)?.[1] ?? 1e9);
  const list = [...groups.values()].sort(
    (a, b) => Number(b.repo === home) - Number(a.repo === home) || a.repo.localeCompare(b.repo) || num(a.epic) - num(b.epic),
  );
  for (const g of list) g.pages.sort((a, b) => a.row.localeCompare(b.row, undefined, { numeric: true }) || (a.port ?? 0) - (b.port ?? 0));
  const pinned = reg.pages.filter((p) => p.pinned && p.name).map((p) => ({ ...p, url: pageUrl(p, reg.hosts) }));
  return { pinned, groups: list, total: reg.pages.length, ...(reg.rule ? { rule: reg.rule } : {}) };
}

/**
 * Why a card's evidence page has no parent: it lives on a page host but no entry names it. Undefined when the
 * evidence is elsewhere (a product site, the console) or the page has its entry.
 */
export function pageParentProblem(url: string | undefined, reg: PagesRegistry | undefined): string | undefined {
  if (!url || !reg?.hosts.length) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!reg.hosts.includes(u.hostname)) return undefined;
  const port = Number(u.port);
  const known = reg.pages.some((p) => (port && p.port === port) || (p.url && sameBase(p.url, u)));
  return known ? undefined : `the evidence page has no parent: add it to the page list so it links up to its epic and the Pages index links to it (${PAGES_FILE})`;
}

function sameBase(a: string, u: URL): boolean {
  try {
    const x = new URL(a);
    return x.host === u.host && u.pathname.startsWith(x.pathname);
  } catch {
    return false;
  }
}

/** The home repo's page list, read again when the file changes. */
export function createPagesReader(o: { reposRoot: string; home?: string }) {
  let cached: { file: string; mtime: number; reg: PagesRegistry } | null = null;
  const read = (): PagesRegistry | undefined => {
    const dir = resolveRepo(o.reposRoot, o.home ?? homeRepo())?.path;
    if (!dir) return undefined;
    const file = path.join(dir, PAGES_FILE);
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    if (cached && cached.file === file && cached.mtime === mtime) return cached.reg;
    try {
      const reg = parsePages(fs.readFileSync(file, "utf8"));
      cached = { file, mtime, reg };
      return reg;
    } catch {
      return undefined;
    }
  };
  return {
    registry: read,
    get(): PagesBody {
      const reg = read();
      return reg ? groupPages(reg, o.home ?? homeRepo()) : { pinned: [], groups: [], total: 0 };
    },
    /** only the pinned pages (the sidebar reads these on every open: a few hundred bytes, not the whole list). */
    pinnedList(): PageView[] {
      const reg = read();
      return reg ? reg.pages.filter((p) => p.pinned && p.name).map((p) => ({ ...p, url: pageUrl(p, reg.hosts) })) : [];
    },
    /** the pinned page with this port, or this short address. */
    pinned(by: { port?: number; slug?: string }): PageView | undefined {
      const reg = read();
      const p = reg?.pages.find((x) => x.pinned && x.name && (by.port !== undefined ? x.port === by.port : !!by.slug && x.slug === by.slug));
      return p && reg ? { ...p, url: pageUrl(p, reg.hosts) } : undefined;
    },
  };
}

/** never let a pinned page's short address take a console screen's (scripts/pages.py RESERVED_SLUGS too). */
export const RESERVED_SLUGS = new Set(
  "api assets auth brief campaigns cards chat connections credits deck feedback gap-finder goal-graph hosts ideas inbox landing launch login logout mac messages milestones objectives one-offs outcomes pages personas pipeline priority releases runs seats secrets sets settings spines steps team-skills testers threads tickets usage voice-notes x-stats your-team".split(" "),
);

export interface PinnedStatus {
  port?: number;
  refreshedAt: string | null;
  refreshable: boolean;
  running: boolean;
  error?: string;
}

/** the page server's own address for its status and refresh (`/_page/status`, `/_page/refresh`, scripts/page_server.py). */
function serverBase(p: PageView): string {
  const u = new URL(p.url);
  return `${u.protocol}//${u.host}`;
}

/** when the pinned page last refreshed and whether it is rebuilding, asked of its page server (2 s at most). */
export async function pinnedStatus(p: PageView, f: typeof fetch = fetch, method: "GET" | "POST" = "GET"): Promise<PinnedStatus> {
  try {
    const r = await f(`${serverBase(p)}${method === "POST" ? "/_page/refresh" : "/_page/status"}`, { method, signal: AbortSignal.timeout(method === "POST" ? 8000 : 2500) });
    const body = (await r.json().catch(() => ({}))) as Partial<PinnedStatus> & { error?: string };
    if (!r.ok && r.status !== 202) return { refreshedAt: null, refreshable: false, running: false, error: body.error ?? `the page server answered ${r.status}` };
    return { port: p.port, refreshedAt: body.refreshedAt ?? null, refreshable: !!body.refreshable, running: !!body.running };
  } catch (e) {
    return { port: p.port, refreshedAt: null, refreshable: false, running: false, error: `the page server did not answer (${(e as Error).name})` };
  }
}

/** `/<slug>` of a pinned page redirects to it (the console/scorecard); every other path falls through to the app. */
export function mountPinnedAddresses(app: Hono, bySlug: (slug: string) => PageView | undefined, link: (url: string) => string = (u) => u) {
  app.get("/:slug{[a-z0-9][a-z0-9-]{1,40}}", async (c, next) => {
    const slug = c.req.param("slug");
    const p = RESERVED_SLUGS.has(slug) ? undefined : bySlug(slug);
    if (!p) return next();
    return c.redirect(link(p.url), 302);
  });
}
