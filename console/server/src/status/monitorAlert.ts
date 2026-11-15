import { createHash } from "node:crypto";
import type { MonitorItem } from "../adapters/monitoring.js";
import type { Tree } from "../adapters/tree.js";
import { snoozedNow, type AskKind, type LocatedAsk, type SecretTarget } from "../inbox/asks.js";
import { askItemId } from "../inbox/waiting.js";
import type { Milestone, Store } from "../store.js";
import { repoKey } from "../adapters/repoNames.js";
import { homeWorld, ownerName, sites } from "../identity.js";

/**
 * a `Monitoring:` item that names a stop or an outage (a 429, a rate limit, a logged-out account, an egress
 * offline, a capability down, "stopped"), or whose next check is more than a day overdue, is not a calm wait: it is an
 * alert in Waiting on you (the milestone reads Needs you). When the item names the ask that unblocks it (any repo, e.g.
 * `the code repo/`), the alert links that ask with its state (snoozed until <date>); with no ask, the next Delivery
 * Manager wake is told to write a coded ask or clear the stale item.
 */

/** Words that say something stopped, not that the epic waits. */
export const STOP_WORDS =
  /\b(?:429|rate[- ]?limit(?:ed)?|logged[- ]out|signed[- ]out|log(?:ged)?[- ]?in (?:expired|lost)|session expired|offline|outage|stopped|halted|suspended|banned|shadow[- ]?banned|locked out|captcha|(?:is|went|capability|service|api|site|egress)\s+down)\b/i;
/** A next check this far in the past means nobody is checking. */
export const OVERDUE_MS = 24 * 3_600_000;

/** An ask code a monitor item names: `the code repo/` (repo given) or `` (the milestone's own repo first). */
export interface AskRef {
  repo?: string;
  code: string;
}

/** The named ask as found in its spine (any world). */
export interface ResolvedAsk {
  code: string;
  repo: string;
  /** open, answered, done (or superseded); missing = no ask has that code. */
  state: "open" | "answered" | "done" | "missing";
  snoozedUntil?: string;
  question?: string;
  milestoneId?: string;
  milestoneTitle?: string;
  /** Where the owner opens it: the console page of its milestone (absolute on another world's host). */
  href?: string;
  /** the waiting item id of the ask in its own world (the inbox's id), and that world. */
  id?: string;
  world?: string;
  /** what the ask's own card needs to show its actions inline on the alert (Approve, Deny, Answer, Save key, Snooze). */
  card?: AlertAskCard;
}

/** the ask's card fields (the inbox's WaitingItem fields of an ask line), for its actions on the alert. */
export interface AlertAskCard {
  ask: AskKind;
  question: string;
  path: string;
  line?: number;
  row?: string;
  options?: string[];
  recommendation?: string;
  contextText?: string;
  impact?: string;
  risk?: string;
  whyYou?: string;
  secret?: SecretTarget;
  since?: string;
}

/**
 * whether an alert is the owner's to act on. open = an ask that unblocks it is open and not snoozed (counted, its
 * actions on the card); snoozed = every open ask it names is snoozed by the owner (it follows the snooze: one quiet line,
 * never counted, back when the snooze ends); alarm = no open ask (none named, missing or answered): the Delivery
 * Manager's defect to fix, never counted and never the owner's answer link.
 */
export function alertState(asks: ResolvedAsk[]): "open" | "snoozed" | "alarm" {
  const open = asks.filter((x) => x.state === "open");
  if (!open.length) return "alarm";
  return open.every((x) => x.snoozedUntil) ? "snoozed" : "open";
}
/** the first snooze to end among a snoozed alert's asks (the alert is counted again from then). */
export const alertSnoozedUntil = (asks: ResolvedAsk[]) => asks.flatMap((x) => (x.state === "open" && x.snoozedUntil ? [x.snoozedUntil] : [])).sort()[0];

export interface MonitorAlert {
  what: string;
  since?: string;
  nextCheckAt?: string;
  nextCheck?: string;
  /** stop = the text names a stop/outage; overdue = the next check is more than a day past. */
  why: ("stop" | "overdue")[];
  /** How long the next check is overdue (ms), when it is. */
  overdueMs?: number;
  /** The asks it names, resolved; empty = none named (the Delivery Manager writes one or clears the item). */
  asks: ResolvedAsk[];
}

const CODE = /(?:^|[^\w/-])(?:([\w.-]+)\/)?((?:EPIC-)?[A-Za-z]*\d+(?:-[A-Za-z0-9]+)*-A\d+)(?![\w-])/gi;
const textOf = (m: MonitorItem) => [m.what, m.nextCheck, m.then].filter(Boolean).join(" ");

/** Ask codes an item names, in order, once each. */
export function askRefs(m: MonitorItem): AskRef[] {
  const out: AskRef[] = [];
  for (const x of textOf(m).matchAll(CODE)) {
    const ref = { ...(x[1] ? { repo: x[1] } : {}), code: x[2].toUpperCase() };
    // One code once: `the code repo/ … answered` names one ask (the qualified mention wins).
    const seen = out.findIndex((o) => o.code === ref.code && (!o.repo || !ref.repo || o.repo.toLowerCase() === ref.repo.toLowerCase()));
    if (seen < 0) out.push(ref);
    else if (!out[seen].repo && ref.repo) out[seen] = ref;
  }
  return out;
}

/** Why an item is an alert (empty = ordinary healthy monitoring). */
export function alertReasons(m: MonitorItem, now: number): { why: MonitorAlert["why"]; overdueMs?: number } {
  const why: MonitorAlert["why"] = [];
  if (STOP_WORDS.test(m.what)) why.push("stop");
  const late = m.nextCheckAt ? now - Date.parse(m.nextCheckAt) : 0;
  if (late > OVERDUE_MS) why.push("overdue");
  return { why, ...(late > OVERDUE_MS ? { overdueMs: late } : {}) };
}

/** The alerts among a milestone's monitor items; `asks` resolves the codes each names (absent = none resolved). */
export function monitorAlerts(items: MonitorItem[] | undefined, now: number, asks: (ref: AskRef) => ResolvedAsk | undefined = () => undefined): MonitorAlert[] {
  const out: MonitorAlert[] = [];
  for (const m of items ?? []) {
    const { why, overdueMs } = alertReasons(m, now);
    if (!why.length) continue;
    const resolved = askRefs(m).map((r) => asks(r) ?? { code: r.code, repo: r.repo ?? "", state: "missing" as const });
    out.push({
      what: m.what,
      ...(m.since ? { since: m.since } : {}),
      ...(m.nextCheckAt ? { nextCheckAt: m.nextCheckAt } : {}),
      ...(m.nextCheck ? { nextCheck: m.nextCheck } : {}),
      why,
      ...(overdueMs !== undefined ? { overdueMs } : {}),
      asks: resolved,
    });
  }
  return out;
}

/** "5 days", "3 hours". */
export function span(ms: number): string {
  const h = Math.max(0, Math.round(ms / 3_600_000));
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** One line: how long it has been so, which check is overdue, what unblocks it. */
export function alertDetail(a: MonitorAlert, now: number): string {
  const parts: string[] = [];
  if (a.since) parts.push(`since ${a.since.slice(0, 16).replace("T", " ")}Z (${span(now - Date.parse(a.since))})`);
  if (a.overdueMs !== undefined) parts.push(`next check${a.nextCheck ? ` (${a.nextCheck})` : ""} was due ${a.nextCheckAt!.slice(0, 16).replace("T", " ")}Z, ${span(a.overdueMs)} overdue`);
  return parts.join(" · ");
}

/** What the alert asks of whom: the open ask that unblocks it, else a coded ask or a cleared item from the Delivery Manager. */
export function alertNext(a: MonitorAlert): string {
  const open = a.asks.filter((x) => x.state === "open");
  const label = (x: ResolvedAsk) => `${x.repo ? `${x.repo}/` : ""}${x.code}`;
  // snoozed by the owner: the alert waits with the ask.
  if (alertState(a.asks) === "snoozed") return `Waits on ${open.map((x) => `${label(x)}, snoozed by you until ${x.snoozedUntil}`).join("; ")}`;
  if (open.length) return `Unblocked by ${open.map((x) => `${x.repo ? `${x.repo}/` : ""}${x.code}${x.snoozedUntil ? ` (snoozed until ${x.snoozedUntil})` : ""}`).join(", ")}`;
  const settled = a.asks.filter((x) => x.state === "answered" || x.state === "done");
  if (settled.length) return `${settled.map((x) => x.code).join(", ")} already answered: the Delivery Manager checks it and clears or rewrites the item at its next wake`;
  return "No ask named: the Delivery Manager writes a coded ask for what unblocks it, or clears the item if it is stale, at its next wake";
}

export const alertId = (milestoneId: string, what: string) => "mon_" + createHash("sha1").update(`${milestoneId}\0${what}`).digest("hex").slice(0, 16);

/** the Delivery Manager's wake section for a milestone's monitor alerts (undefined when none). */
export function monitorAlertSection(all: MonitorAlert[], now: number): string | undefined {
  // an alert whose asks the owner snoozed waits with them: nothing for the Delivery Manager to write.
  const alerts = all.filter((a) => alertState(a.asks) !== "snoozed");
  if (!alerts.length) return undefined;
  return [
    "## Monitoring alerts",
    `These \`Monitoring:\` items name a stop or an outage, or their next check is more than a day overdue, so the console shows each to ${ownerName()} as an alert in Waiting on you. ` +
      "This wake, for each: if it is stale (the thing works again), rewrite or remove the item so it reads true; if it still blocks, write the coded ask that unblocks it " +
      "(or name an existing one, `waits on <repo>/<code>`, in the item so the alert links it) and set a next check date ahead. Never leave a stopped item as calm monitoring.",
    ...alerts.map((a) => `- ${a.what}${alertDetail(a, now) ? ` — ${alertDetail(a, now)}` : ""} — ${alertNext(a)}`),
  ].join("\n");
}

// a renamed repo's old and new names give one key (repoNames.ts).
const repoName = (repo: string) => repoKey(repo.trim().replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop()!);

/**
 * Resolve ask codes against every milestone's tree (an unscoped store: the ask may sit in another world, e.g.
 * a social world repo's Reddit item names the code repo/). An unqualified code looks in the milestone's own repo first.
 * `hostOf(world)` is the console origin that serves a world (absolute links across worlds).
 */
export function askLookupIn(
  store: Pick<Store, "listMilestones"> & Partial<Pick<Store, "worldOfMilestone">>,
  treeFor: (m: Milestone) => Promise<Tree>,
  hostOf: (world: string) => string | undefined = () => undefined,
  /** the checkout name of a milestone's repo (the inbox's `repo.name`, part of the ask's waiting item id). */
  checkout: (m: Milestone) => string | undefined = () => undefined,
) {
  return async (from: Milestone, refs: AskRef[]): Promise<Map<string, ResolvedAsk>> => {
    const out = new Map<string, ResolvedAsk>();
    if (!refs.length) return out;
    const all = store.listMilestones({ includeSettled: true });
    const fromWorld = store.worldOfMilestone?.(from.id);
    for (const ref of refs) {
      const want = repoName(ref.repo ?? from.repo);
      const ms = all.filter((m) => repoName(m.repo) === want).sort((a, b) => Number(b.id === from.id) - Number(a.id === from.id));
      // The milestone whose own spine holds the ask (for), else the first tree that lists it (the code repo's root).
      let found: { m: Milestone; hit: LocatedAsk; rel: string } | undefined;
      for (const m of ms) {
        const tree = await treeFor(m).catch(() => undefined);
        const at = Object.entries(tree?.asks ?? {}).flatMap(([rel, list]) => list.filter((a) => a.code?.toUpperCase() === ref.code).map((a) => ({ rel, a })))[0];
        if (!at) continue;
        if (!found || at.rel === m.path) found = { m, hit: at.a, rel: at.rel };
        if (at.rel === m.path) break;
      }
      if (found) {
        const { m, hit } = found;
        const world = store.worldOfMilestone?.(m.id);
        const rel = `/milestones/${encodeURIComponent(m.id)}?tab=waiting`;
        const open = hit.state === "open" && hit.doneAt === undefined;
        const host = world !== fromWorld && world !== undefined ? hostOf(world) : undefined;
        out.set(refKey(ref), {
          code: ref.code,
          repo: ref.repo ?? repoName(m.repo),
          state: hit.doneAt !== undefined ? "done" : hit.state,
          ...(hit.state === "open" && hit.doneAt === undefined && snoozedNow(hit.snoozedUntil) ? { snoozedUntil: hit.snoozedUntil } : {}),
          question: hit.question,
          milestoneId: m.id,
          milestoneTitle: m.title,
          href: host ? host.replace(/\/+$/, "") + rel : rel,
          id: askItemId(checkout(m) ?? checkoutName(m.repo), found.rel, hit.row, hit.question),
          ...(world !== undefined ? { world } : {}),
          ...(open ? { card: cardOf(hit, found.rel) } : {}),
        });
      }
    }
    return out;
  };
}
/** The checkout's directory name, as the inbox names the repo (waiting.ts `repo.name`). */
const checkoutName = (repo: string) => repo.trim().replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop()!;

/** the ask's card fields, as the inbox builds them for its own card (waiting.ts, human asks). */
function cardOf(a: LocatedAsk, rel: string): AlertAskCard {
  return {
    ask: a.ask,
    question: a.question,
    path: rel,
    ...(a.line !== undefined ? { line: a.line } : {}),
    ...(a.row ? { row: a.row } : {}),
    ...(a.options.length ? { options: a.options } : {}),
    ...(a.recommend ? { recommendation: a.recommend } : {}),
    ...(a.contextText ? { contextText: a.contextText } : {}),
    ...(a.impact ? { impact: a.impact } : {}),
    ...(a.risk ? { risk: a.risk } : {}),
    ...(a.why ? { whyYou: a.why } : {}),
    ...(a.secret ? { secret: a.secret } : {}),
    ...(a.since ? { since: a.since } : {}),
  };
}

export const refKey = (r: AskRef) => `${r.repo?.toLowerCase() ?? ""}/${r.code}`;

/** The console origin serving a world: the team skin for the home world, the social skin for the others (none on staging). */
export function worldHost(world: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CONSOLE_STAGING === "1") return undefined;
  return world === homeWorld() ? env.CONSOLE_TEAM_URL || sites().teamUrl : env.CONSOLE_SOCIAL_URL || sites().socialUrl;
}
