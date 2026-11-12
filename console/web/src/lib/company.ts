import type { Company, WheelId, WorldInbox } from "@/api/company-types";
import type { ClosedCard, ReviewItem } from "@/api/review-types";
import type { Milestone } from "@/api/types";
import type { WaitingItem } from "@/api/inbox-types";
import { socialProduct } from "@/lib/identity";

/**
 * the Company view's logic. Each project shows as a
 * company with three wheels (build in EpicTeam, promo in the social product, operations); the master dashboard folds the inboxes
 * of the repos he picks into one list, most important first. Everything is read from the live lists the Team home reads
 * (open asks, cards to review, closed cards); docs/companies.json says which repo and spine feeds which wheel.
 */
export const COMPANY_PATH = "company";
export const WHEEL_ORDER: WheelId[] = ["build", "promo", "ops"];
export const WHEELS: Record<WheelId, { name: string; app: string; what: string }> = {
  build: { name: "Build", app: "EpicTeam", what: "the product people can buy" },
  promo: { name: "Promo", get app() {
      return socialProduct();
    }, what: "customers in the door" },
  ops: { name: "Operations", app: "EpicBooks and the console", what: "lights on, money counted, customers happy" },
};
export const REPOS_PARAM = "repos";
export const REPOS_STORE = "console.companyRepos";
const WEEK_MS = 7 * 24 * 3600_000;

/** A milestone's or item's repo (`owner/name`, a path or a checkout name) as the checkout name. */
export const repoName = (repo?: string) => (repo ?? "").replace(/\/+$/, "").split("/").pop() ?? "";

/** Every repo the console's projects track, in the projects' order, each once. */
export function consoleRepos(milestones: Pick<Milestone, "repo">[] = []): string[] {
  return [...new Set(milestones.map((m) => repoName(m.repo)).filter(Boolean))];
}

/** The repos the view watches by default: every company's, else every repo. */
export function defaultRepos(companies: Company[], all: string[]): string[] {
  const own = new Set(companies.flatMap((c) => WHEEL_ORDER.flatMap((w) => c.wheels[w].sources.map((s) => s.repo))));
  const picked = all.filter((r) => own.has(r));
  return picked.length ? picked : all;
}

/** The URL's pick (`?repos=a,b`), else this browser's, else the default; names no project tracks are dropped. */
export function chooseRepos(all: string[], fallback: string[], fromUrl?: string | null, stored?: string | null): string[] {
  for (const raw of [fromUrl, stored]) {
    if (raw == null) continue;
    const want = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
    return all.filter((r) => want.has(r));
  }
  return fallback;
}

/** the social product world repos he turned off on this browser (on by default, even over a pick saved before them). */
export const WORLDS_OFF_STORE = "console.companyWorldsOff";
/** The pick plus every the social product world repo not turned off, in the picker's order. */
export function withWorlds(picked: string[], all: string[], worldRepos: string[], off: string[]): string[] {
  const on = new Set([...picked, ...worldRepos.filter((r) => !off.includes(r))]);
  return all.filter((r) => on.has(r));
}

/** Where an item belongs: the company and wheel whose source names its spine, else its repo; undefined = no company. */
export function placeOf(companies: Company[], item: { repo?: string; path?: string }): { company: Company; wheel: WheelId } | undefined {
  const repo = repoName(item.repo);
  let byRepo: { company: Company; wheel: WheelId } | undefined;
  for (const company of companies) {
    for (const wheel of WHEEL_ORDER) {
      for (const s of company.wheels[wheel].sources) {
        if (s.repo !== repo) continue;
        if (s.path) {
          if (item.path && item.path.replace(/^\.?\//, "") === s.path.replace(/^\.?\//, "")) return { company, wheel };
        } else byRepo ??= { company, wheel };
      }
    }
  }
  return byRepo;
}

/**
 * the social product world's item with no wheel source: the one company whose Promo wheel reads that repo's accounts.
 * A repo that feeds several companies (towerwatch-campaign posts for Yield Desk and Towerwatch) places nothing: never a guess.
 */
export function promoPlace(companies: Company[], repo: string): { company: Company; wheel: WheelId } | undefined {
  const hits = companies.filter((c) => (c.wheels.promo.accounts ?? []).some((a) => a.repo === repo));
  return hits.length === 1 ? { company: hits[0], wheel: "promo" } : undefined;
}

/** the social product worlds' repos (their items' repos, else the world's id), each once, with the app it lives in. */
export function worldRepos(worlds: WorldInbox[] = []): { repo: string; app: string }[] {
  const out = new Map<string, string>();
  for (const w of worlds) {
    const repos = w.items.map((i) => repoName(i.repo) || w.tenantId);
    for (const r of repos.length ? repos : [w.tenantId]) if (!out.has(r)) out.set(r, w.app);
  }
  return [...out].map(([repo, app]) => ({ repo, app }));
}

export interface InboxEntry {
  key: string;
  kind: "ask" | "review";
  title: string;
  repo: string;
  path?: string;
  code?: string;
  level?: string;
  priority?: number;
  since?: string;
  milestoneId?: string;
  project?: string;
  liveUrl?: string;
  /** another product's item (the social product world's): it opens there, in its own app, and is answered there. */
  openUrl?: string;
  app?: string;
  company?: Company;
  wheel?: WheelId;
}

const LEVEL_RANK: Record<string, number> = { high: 0, normal: 1, low: 3 };
const levelRank = (l?: string) => (l ? (LEVEL_RANK[l] ?? 2) : 2);

/** the owner's level first (high, normal, none, low), then the lists' own priority, then the oldest. */
export function byWeight(a: InboxEntry, b: InboxEntry): number {
  return levelRank(a.level) - levelRank(b.level) || (a.priority ?? Infinity) - (b.priority ?? Infinity) || (a.since ?? "").localeCompare(b.since ?? "");
}

const snoozed = (w: WaitingItem, now: number) => !!w.snoozedUntil && Date.parse(w.snoozedUntil.length === 10 ? `${w.snoozedUntil}T23:59:59Z` : w.snoozedUntil) > now;

/** One inbox over the picked repos: every open ask (not snoozed, not a Mac-agent job) and every card to review. */
export function foldInbox(
  input: { waiting?: WaitingItem[]; reviews?: ReviewItem[]; milestones?: Milestone[]; worlds?: WorldInbox[] },
  repos: string[],
  companies: Company[],
  now = Date.now(),
): InboxEntry[] {
  const on = new Set(repos);
  const project = new Map((input.milestones ?? []).map((m) => [m.id, m.title]));
  const out: InboxEntry[] = [];
  for (const w of input.waiting ?? []) {
    const repo = repoName(w.repo);
    if (w.state !== "open" || w.macAgent || snoozed(w, now) || !on.has(repo)) continue;
    const place = placeOf(companies, { repo, path: w.path });
    out.push({
      key: `ask:${w.id}`,
      kind: "ask",
      title: w.question || w.title,
      repo,
      ...(w.path ? { path: w.path } : {}),
      ...(w.code ? { code: w.code } : {}),
      ...(w.ownerPriority?.level ? { level: w.ownerPriority.level } : {}),
      ...(w.priority != null ? { priority: w.priority } : {}),
      ...(w.since ? { since: w.since } : {}),
      ...(w.milestoneId ? { milestoneId: w.milestoneId, project: w.milestoneTitle ?? project.get(w.milestoneId) } : {}),
      ...(place ?? {}),
    });
  }
  for (const r of input.reviews ?? []) {
    const repo = repoName(r.repo);
    if (!on.has(repo)) continue;
    const place = placeOf(companies, { repo, path: r.path });
    out.push({
      key: `review:${r.id}`,
      kind: "review",
      title: r.title,
      repo,
      ...(r.path ? { path: r.path } : {}),
      ...(r.ref ? { code: r.ref } : {}),
      ...(r.ownerPriority?.level ? { level: r.ownerPriority.level } : {}),
      ...(r.priority != null ? { priority: r.priority } : {}),
      ...(r.createdAt ? { since: r.createdAt } : {}),
      ...(r.milestoneId ? { milestoneId: r.milestoneId, project: project.get(r.milestoneId) } : {}),
      ...(r.liveUrl ? { liveUrl: r.liveUrl } : {}),
      ...(place ?? {}),
    });
  }
  // the social product worlds' open asks and cards, read only; one already listed (same key) is not listed twice.
  const seen = new Set(out.map((e) => e.key));
  for (const w of input.worlds ?? []) {
    for (const it of w.items) {
      const repo = repoName(it.repo) || w.tenantId;
      const key = `${w.tenantId}:${it.key}`;
      if (!on.has(repo) || seen.has(it.key) || seen.has(key)) continue;
      seen.add(key);
      const place = placeOf(companies, { repo, path: it.path }) ?? promoPlace(companies, repo);
      out.push({
        key,
        kind: it.kind,
        title: it.title,
        repo,
        ...(it.path ? { path: it.path } : {}),
        ...(it.code ? { code: it.code } : {}),
        ...(it.level ? { level: it.level } : {}),
        ...(it.priority != null ? { priority: it.priority } : {}),
        ...(it.since ? { since: it.since } : {}),
        ...(it.project ? { project: it.project } : {}),
        ...(it.liveUrl ? { liveUrl: it.liveUrl } : {}),
        openUrl: it.openUrl,
        app: w.app,
        ...(place ?? {}),
      });
    }
  }
  return out.sort(byWeight);
}

export interface WheelNumbers {
  /** Open asks waiting on the owner. */
  asks: number;
  /** Finished work waiting for his review. */
  cards: number;
  /** Cards he approved in the last 7 days. */
  shipped: number;
  /** Anything of the wheel he closed in the last 7 days (approved, answered, changes, declined). */
  closed: number;
}

/**
 * A wheel's weekly numbers, live: its inbox (asks and cards) and what he closed in the last 7 days. `companies` is the full
 * list, so a closed card counts for the one company and wheel its spine or repo places it in.
 */
export function wheelNumbers(companies: Company[], company: Company, wheel: WheelId, inbox: InboxEntry[], closed: ClosedCard[] = [], now = Date.now()): WheelNumbers {
  const mine = inbox.filter((e) => e.company?.id === company.id && e.wheel === wheel);
  const week = closed.filter((c) => {
    const at = placeOf(companies, c);
    return now - Date.parse(c.at) <= WEEK_MS && at?.company.id === company.id && at.wheel === wheel;
  });
  return {
    asks: mine.filter((e) => e.kind === "ask").length,
    cards: mine.filter((e) => e.kind === "review").length,
    shipped: week.filter((c) => c.outcome === "approved").length,
    closed: week.length,
  };
}

/** The projects (milestones) a wheel's repos carry, for its drill-through links into EpicTeam. */
export function wheelProjects(company: Company, wheel: WheelId, milestones: Milestone[] = []): Milestone[] {
  const repos = new Set(company.wheels[wheel].sources.map((s) => s.repo));
  return milestones.filter((m) => repos.has(repoName(m.repo)) && m.status !== "done");
}

/** The companies whose repos are picked (any wheel source). */
export function visibleCompanies(companies: Company[], repos: string[]): Company[] {
  const on = new Set(repos);
  // a Promo wheel's account repos count too (the social product world's items land in that wheel)
  return companies.filter((c) => WHEEL_ORDER.some((w) => c.wheels[w].sources.some((s) => on.has(s.repo))) || (c.wheels.promo.accounts ?? []).some((a) => on.has(a.repo)));
}
