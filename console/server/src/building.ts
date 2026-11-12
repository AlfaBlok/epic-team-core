import fs from "node:fs";
import path from "node:path";
import { resolveRepo } from "./adapters/repos.js";
import { parseAsks, snoozedNow } from "./inbox/asks.js";
import { hooks } from "./plug/hooks.js";
import { DEFAULT_OWNER } from "./tenancy/owner.js";
import { homeRepo } from "./identity.js";

/**
 * the EpicTeam home lists
 * what he builds. `docs/building.json` of the code repo names each list and the repos (or world) where its personas wake; the
 * rest is read from the spines, never typed: the named campaigns under each list (the campaign spines of its campaign repos,
 *) and how much waits on his hands there (open asks to him in `## Waiting on`, rows whose status reads `review`).
 * A list may take its repos from a red line in docs/priorities.json (`redLine`), so the Flywheel follows its items.
 */
export const BUILDING_FILE = "docs/building.json";
const PRIORITIES_FILE = "docs/priorities.json";

export interface BuildingLink {
  label: string;
  url: string;
}
export interface BuildingCount {
  /** Open asks to him (not snoozed). */
  asks: number;
  /** Rows whose status reads `review`: finished work for him to check. */
  review: number;
}
export interface BuildingCampaign {
  repo: string;
  code: string;
  name: string;
  path: string;
  status: string | null;
  platform: string | null;
  deck: string | null;
  waits: BuildingCount;
}
export interface BuildingList {
  id: string;
  name: string;
  line?: string;
  /** Where its personas wake: checkout names. */
  repos: string[];
  /** The world it runs in, when not EpicTeam's own (e.g. "the social product"). */
  world?: string;
  open?: BuildingLink;
  waits: BuildingCount;
  /** Per repo, so the page can link each to its project. */
  repoWaits: Record<string, BuildingCount>;
  campaigns: BuildingCampaign[];
}

interface Declared {
  id: string;
  name: string;
  line?: string;
  repos: string[];
  redLine?: string;
  campaignRepos: string[];
  world?: string;
  open?: BuildingLink;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.flatMap((x) => (str(x) ? [str(x)!] : [])) : []);

/** The file's lists; a list with no id or name is skipped. Bad JSON: none. */
export function parseBuilding(text: string): Declared[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const lists = (doc as { lists?: unknown })?.lists;
  if (!Array.isArray(lists)) return [];
  const seen = new Set<string>();
  return lists.flatMap((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    const open = (o.open ?? {}) as Record<string, unknown>;
    const label = str(open.label);
    const url = str(open.url);
    return [
      {
        id,
        name,
        ...(str(o.line) ? { line: str(o.line) } : {}),
        repos: strs(o.repos),
        ...(str(o.redLine) ? { redLine: str(o.redLine) } : {}),
        campaignRepos: strs(o.campaignRepos),
        ...(str(o.world) ? { world: str(o.world) } : {}),
        ...(label && url && /^https?:\/\//.test(url) ? { open: { label, url } } : {}),
      },
    ];
  });
}

/** The repos a red line's items sit in (docs/priorities.json), in their order. */
export function redLineRepos(prioritiesText: string, name: string): string[] {
  try {
    const doc = JSON.parse(prioritiesText) as { redLines?: { name?: string; items?: { repo?: string }[] }[] };
    const line = (doc.redLines ?? []).find((r) => (r.name ?? "").trim().toLowerCase() === name.trim().toLowerCase());
    return [...new Set((line?.items ?? []).flatMap((i) => (str(i.repo) ? [str(i.repo)!] : [])))];
  } catch {
    return [];
  }
}

const REVIEW_CELL = /^\s*review\b/i;
const strip = (s: string) => s.replace(/`|\*\*|~~/g, "").trim();

/** One spine's count: open asks to the owner (not snoozed) and ledger rows whose status cell reads `review`. */
export function countSpine(markdown: string, owner = DEFAULT_OWNER, now = Date.now()): BuildingCount {
  const me = owner.toLowerCase();
  let asks = 0;
  for (const a of parseAsks(markdown)) {
    if (a.state !== "open" || a.who.replace(/^@/, "").toLowerCase() !== me) continue;
    if (snoozedNow(a.snoozedUntil, now)) continue;
    asks++;
  }
  // a ledger row: `| | … | review (…) | …`; the status cell is any cell after the code that opens with `review`
  let review = 0;
  for (const line of markdown.split("\n")) {
    if (!/^\|\s*[A-Z][\w-]*-[A-Z]?\d+\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(2, -1).map(strip);
    if (cells.some((c) => REVIEW_CELL.test(c) && !/^review\s*(?:inbox|card|cards)\b/i.test(c))) review++;
  }
  return { asks, review };
}

const add = (a: BuildingCount, b: BuildingCount): BuildingCount => ({ asks: a.asks + b.asks, review: a.review + b.review });
const ZERO: BuildingCount = { asks: 0, review: 0 };

const SKIP_DIRS = new Set(["node_modules", ".git", "status", "proposals", "cards", "features", "assets", "img", "images", "media", "fonts"]);
const MAX_BYTES = 600_000;
/** Spine files under docs/: a Markdown file with a `## Current State` section (memory keeps its spines in docs/, most in docs/spines/). */
function spineTexts(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth < 3 && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(r, depth + 1);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      try {
        if (fs.statSync(path.join(dir, r)).size > MAX_BYTES) continue;
        const text = fs.readFileSync(path.join(dir, r), "utf8");
        if (/^##\s+Current State\b/m.test(text)) out.set(r, text);
      } catch {
        /* unreadable: skipped */
      }
    }
  };
  walk("docs", 0);
  return out;
}

const statusOf = (text: string) => /^Status:\s*([^\n(]+)/m.exec(text)?.[1]?.trim().toLowerCase() ?? null;
/** A campaign that no longer runs is not listed under what he builds. */
const GONE = /^(done|superseded|retired|cancelled|canceled|parked|deferred)\b/;

/** A repo's counts per spine file, kept 5 minutes (the console re-scans a changed repo at most every 5 min). */
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; owner: string; perFile: Map<string, BuildingCount>; status: Map<string, string | null> }>();
export function clearBuildingCache(): void {
  cache.clear();
}
function repoCounts(dir: string, owner: string, now: number) {
  const hit = cache.get(dir);
  if (hit && hit.owner === owner && now - hit.at < TTL_MS && now >= hit.at) return hit;
  const perFile = new Map<string, BuildingCount>();
  const status = new Map<string, string | null>();
  for (const [f, text] of spineTexts(dir)) {
    perFile.set(f, countSpine(text, owner, now));
    status.set(f, statusOf(text));
  }
  const out = { at: now, owner, perFile, status };
  cache.set(dir, out);
  return out;
}

/** The home repo's building lists with their campaigns and counts (none when the file is missing). */
export function readBuilding(reposRoot: string, o: { home?: string; owner?: string; now?: number } = {}): BuildingList[] {
  const home = resolveRepo(reposRoot, o.home ?? homeRepo());
  if (!home) return [];
  let declared: Declared[] = [];
  let priorities = "";
  try {
    declared = parseBuilding(fs.readFileSync(path.join(home.path, BUILDING_FILE), "utf8"));
  } catch {
    return [];
  }
  try {
    priorities = fs.readFileSync(path.join(home.path, PRIORITIES_FILE), "utf8");
  } catch {
    /* no red lines */
  }
  const owner = o.owner ?? DEFAULT_OWNER;
  const now = o.now ?? Date.now();
  return declared.map((d) => {
    const repos = [...new Set([...d.repos, ...(d.redLine ? redLineRepos(priorities, d.redLine) : [])])];
    const repoWaits: Record<string, BuildingCount> = {};
    let waits = ZERO;
    for (const name of repos) {
      const r = resolveRepo(reposRoot, name);
      if (!r) continue;
      let sum = ZERO;
      for (const c of repoCounts(r.path, owner, now).perFile.values()) sum = add(sum, c);
      repoWaits[name] = sum;
      waits = add(waits, sum);
    }
    const campaigns: BuildingCampaign[] = [];
    for (const name of d.campaignRepos) {
      const r = resolveRepo(reposRoot, name);
      if (!r) continue;
      const counts = repoCounts(r.path, owner, now);
      for (const c of hooks.campaignSpines(r.path)) {
        if (path.posix.basename(c.path) === "root.md") continue; // the repo itself, not a named campaign
        const status = counts.status.get(c.path) ?? null;
        if (status && GONE.test(status)) continue;
        campaigns.push({ repo: name, code: c.code, name: c.name, path: c.path, status, platform: c.platform, deck: c.deck ?? null, waits: counts.perFile.get(c.path) ?? ZERO });
      }
      // a campaign repo he does not wake in as a list repo still counts toward the list
      if (!repos.includes(name)) {
        let sum = ZERO;
        for (const c of counts.perFile.values()) sum = add(sum, c);
        repoWaits[name] = sum;
        waits = add(waits, sum);
      }
    }
    return {
      id: d.id,
      name: d.name,
      ...(d.line ? { line: d.line } : {}),
      repos: [...repos, ...d.campaignRepos.filter((c) => !repos.includes(c))],
      ...(d.world ? { world: d.world } : {}),
      ...(d.open ? { open: d.open } : {}),
      waits,
      repoWaits,
      campaigns,
    };
  });
}
