import type { Hono } from "hono";
import type { Claim } from "../desk/dispatch.js";
import type { WaitingItem } from "../inbox/waiting.js";
import type { HeldAsk } from "../inbox/askGate.js";
import type { ScorecardNode, ScorecardRow, ScorecardsBody, SpineInfo } from "../scorecards.js";
import { repoKey } from "../adapters/repoNames.js";
import { ownerName } from "../identity.js";

/**
 * Objectives in the Delivery Manager's regular wake. The owner, Team desk chat 2026-11-13: "It should
 * be moving untill all green. Wheels spin until green yeah?"; on the first build (2026-11-14): "don't objectives have
 * perdonas that wake up on the regular? Why did we have to do something new here?"
 *
 * They do: every objective (docs/pursuits.json) sits on a milestone, and that milestone's Delivery Manager already wakes on
 * its cadence (the objective's tier sets the pace). What was missing: that wake never read the objectives (its prompt held
 * spines and ready rows only) and a wake with no spine change was skipped as "nothing new" for up to 24 h. So an objective
 * whose key results stayed red while its epics had no ready row sat still. The fix lives in the regular wake:
 * - `objectivesSection`: the wake prompt lists every objective of its milestone below green, the idle ones first, with
 *   the step to take for each (dispatch a ready row of a red key result, else write the row that would move it);
 * - an idle objective is news: the cadence wake is never skipped while one is idle (cycle/service.ts unchangedSkip).
 * Iteration 1's own timer (a Run now every 10 min per owner) is gone; this file keeps the verdict (the idle pill on the
 * sidebar and All objectives, GET /api/idle-watch read-only) and the wake section.
 *
 * Idle = below all-green with no worker on its rows, no open ask of its own and no row in review. Parked and folded
 * objectives are left alone.
 *
 * Two waits the verdict once missed and called idle. (1) An ask the ask gate holds back while a fresh agent dry-runs it
 * (inbox/askDryRun.ts, every 15 min) is on its way to the owner: the objective waits on that check. An ask held for any
 * other reason (needs rewriting, a repeat) is the team's to fix: the objective stays idle and its line names it.
 * (2) A row in `monitoring` on the work of a key result not yet green waits on a scheduled check: not idle.
 */

export interface WheelIdle {
  wheel: string;
  name: string;
  owner: string;
  /** idle: below green, nothing running, nothing waiting on the owner, nothing in review. */
  idle: boolean;
  /** what it is doing now, or why it is idle (one plain line). */
  reason: string;
  milestoneId?: string;
  /** red and amber key results (labels), the note's target. */
  open: string[];
  workers: string[];
  asks: string[];
  review: string[];
  /** its asks the ask gate holds back: `<code>: <reason>`. */
  held?: string[];
  /** rows in monitoring on the work of its open key results. */
  monitoring?: string[];
}

/** a held ask that only waits for its dry run (the sweep reaches it within 15 min): on its way to the owner. */
export const heldForDryRun = (reason: string) => /^waiting for its dry run\b/i.test(reason);

const repoName = (r: string) => repoKey(r.split("/").pop()!);
const key = (repo: string, code: string) => `${repoName(repo)}:${code}`;

/** the wheel's key results (else its rows that take work), the colours the light is made of. */
export function wheelRows(n: Pick<ScorecardNode, "keyResults" | "rows">): ScorecardRow[] {
  if (n.keyResults?.length) return n.keyResults;
  return n.rows.filter((r) => r.kind === "key-result" || r.kind === "health" || r.kind === "check");
}

/** every row and ask code of the wheel: its spines' codes and its key results' work, `repo:code`. */
export function wheelCodes(n: ScorecardNode, spineInfo: Record<string, SpineInfo>): Set<string> {
  const out = new Set<string>();
  for (const k of n.spines) {
    const s = spineInfo[k];
    if (s) for (const c of s.codes) out.add(key(s.repo, c));
  }
  for (const r of wheelRows(n)) for (const w of r.work ?? []) out.add(key(w.repo, w.code));
  return out;
}

/**
 * Pure: one wheel's state. `claims` = running workers (any milestone of the home world), `asks` = open coded asks.
 */
export function wheelVerdict(
  i: {
    node: ScorecardNode;
    spineInfo: Record<string, SpineInfo>;
    /** running workers: the row and the repo of the milestone it runs under. */
    claims: { ticket?: string; repo?: string; summary?: string }[];
    asks: Pick<WaitingItem, "code" | "repo" | "path" | "state" | "source">[];
    /** open asks the ask gate holds back from the owner (inbox/askGate.ts). */
    held?: Pick<HeldAsk, "code" | "repo" | "path" | "reason">[];
    ownerName?: string;
    /** the milestone's repo, for claims (a claim names a row, not its repo). */
    repo?: string;
  },
): WheelIdle {
  const n = i.node;
  const owner = n.owner ?? i.ownerName ?? "Delivery Manager";
  const rows = wheelRows(n);
  const open = rows.filter((r) => r.state !== "green").map((r) => r.label);
  const base = { wheel: n.id, name: n.headline ?? n.name, owner, open, ...(n.milestoneId ? { milestoneId: n.milestoneId } : {}) };
  const codes = wheelCodes(n, i.spineInfo);
  const spines = new Set(n.spines);
  const homeRepo = i.repo ?? n.repo ?? n.spines[0]?.split(":")[0] ?? "";
  // a worker on one of its rows, or one the owner started for the wheel itself (its summary names `wheel <id>`, `WHEEL-<id>`)
  const forWheel = new RegExp(`(^|[^\\w-])wheel[ :-]+${n.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`, "i");
  const workers = [
    ...new Set(i.claims.filter((c) => (c.ticket && codes.has(key(c.repo ?? homeRepo, c.ticket))) || forWheel.test(c.summary ?? "")).map((c) => c.ticket ?? `wheel ${n.id}`)),
  ];
  const ours = (a: { code?: string; repo?: string; path?: string }) =>
    !!a.code && ((a.repo && codes.has(key(a.repo, a.code))) || (a.repo && a.path && spines.has(`${a.repo}:${a.path.replace(/^\.\//, "")}`)) || (!a.repo && [...codes].some((c) => c.endsWith(`:${a.code}`))));
  const asks = [...new Set(i.asks.filter((a) => a.source === "ask" && a.state === "open" && ours(a)).map((a) => a.code!))];
  const heldAsks = (i.held ?? []).filter((h) => ours(h) && !asks.includes(h.code!));
  const dryRun = [...new Set(heldAsks.filter((h) => heldForDryRun(h.reason)).map((h) => h.code!))];
  const held = [...new Set(heldAsks.map((h) => `${h.code}: ${h.reason.split(/[:(]/)[0].trim()}`))];
  const monitoring = [...new Set(rows.filter((r) => r.state !== "green").flatMap((r) => r.work ?? []).filter((w) => /^monitoring\b/i.test(w.status ?? "")).map((w) => w.code))];
  // a row in review in its own spines, or a ticket of an open key result's work in review in another epic's spine
  const workInReview = rows.filter((r) => r.state !== "green").flatMap((r) => r.work ?? []).filter((w) => /^review\b/i.test(w.status ?? "")).map((w) => w.code);
  const review = [...new Set([...n.spines.flatMap((k) => i.spineInfo[k]?.review ?? []), ...workInReview])];
  const out = (idle: boolean, reason: string): WheelIdle => ({ ...base, idle, reason, workers, asks, review, ...(held.length ? { held } : {}), ...(monitoring.length ? { monitoring } : {}) });
  if (n.parked) return out(false, `parked: ${ownerName()} parked it, it waits on purpose`);
  if (n.foldedInto) return out(false, `shown inside ${n.foldedInto}`);
  if (!rows.length) return out(false, "no key results yet");
  if (!open.length) return out(false, "all green");
  if (workers.length) return out(false, `moving: worker on ${workers.slice(0, 4).join(", ")}`);
  if (asks.length) return out(false, `waits on ${ownerName()}: ${asks.slice(0, 4).join(", ")}`);
  if (dryRun.length) return out(false, `waits on the ask check: ${dryRun.slice(0, 4).join(", ")} reach${dryRun.length === 1 ? "es" : ""} ${ownerName()} once a fresh agent has done ${dryRun.length === 1 ? "it" : "them"} from the card (every 15 min)`);
  if (review.length) return out(false, `waits on ${ownerName()}'s review: ${review.slice(0, 4).join(", ")}`);
  if (monitoring.length) return out(false, `waits on a scheduled check: ${monitoring.slice(0, 4).join(", ")} in monitoring`);
  const heldWhy = held.length ? `; held from ${ownerName()}, rewrite or withdraw each: ${held.slice(0, 3).join("; ")}` : "";
  return out(true, `idle: ${open.length} key result${open.length === 1 ? "" : "s"} not green, no worker, nothing waiting on ${ownerName()}, nothing in review${heldWhy}`);
}

/**
 * The objectives part of a Delivery Manager wake: every objective of its milestone below green, the idle ones first with
 * the step to take. Undefined when none is below green (nothing to say, the prompt stays as it was).
 */
export function objectivesSection(wheels: WheelIdle[]): string | undefined {
  const below = wheels.filter((w) => w.open.length && !/^(parked|shown inside)/.test(w.reason));
  if (!below.length) return undefined;
  const idle = below.filter((w) => w.idle);
  const rest = below.filter((w) => !w.idle);
  const line = (w: WheelIdle) => `- [objective ${w.wheel}] ${w.name}: ${w.reason}. Not green: ${w.open.slice(0, 6).join("; ")}`;
  return [
    "## Objectives of this milestone below green",
    `${ownerName()}: "It should be moving until all green." You own these objectives: each wake reads them, not only the ready rows.`,
    ...(idle.length
      ? [
          `Idle (nothing running, nothing waiting on ${ownerName()}, nothing in review): start the next step of each in this wake, whatever its tier (the tier sets pace and worker ceiling, never whether it moves).`,
          ...idle.map(line),
          `For each: dispatch the next ready row of a red or amber key result (one worker per row). If none is ready, write the row that would move it: \`ready\` only when it carries ${ownerName()}'s words, else a draft plus the step that unblocks it (an ask or a worker). Name what you did per objective in your summary (\`objective <id>: <row or reason>\`).`,
        ]
      : []),
    ...(rest.length ? ["Moving or waiting (no step needed from you unless its worker failed):", ...rest.map(line)] : []),
  ].join("\n");
}

export interface IdleWatchDeps {
  scorecards: () => Promise<ScorecardsBody>;
  /** running workers of the home world (a row code, or none: a worker started for a wheel names it in its summary). */
  claims: () => (Omit<Claim, "ticket"> & { ticket?: string })[];
  /** open asks of a milestone (waitingFor). */
  waiting: (milestoneId: string) => Promise<WaitingItem[]>;
  /** open asks of a milestone the ask gate holds back from the owner. */
  held?: (milestoneId: string) => Promise<HeldAsk[]>;
  milestoneRepo: (milestoneId: string) => string | undefined;
  now?: () => number;
  log?: (msg: string) => void;
  /** evaluate() is memoised this long (the sidebar reads it with every scorecards poll). */
  memoMs?: number;
}

export function createIdleWatch(d: IdleWatchDeps) {
  const now = d.now ?? Date.now;
  let memo: { at: number; p: Promise<WheelIdle[]> } | undefined;

  async function compute(): Promise<WheelIdle[]> {
    const body = await d.scorecards();
    const claims = d.claims().map((c) => ({ ticket: c.ticket, summary: c.summary, repo: c.milestoneId ? d.milestoneRepo(c.milestoneId) : undefined }));
    const asksBy = new Map<string, Promise<WaitingItem[]>>();
    const asksOf = (id: string) => {
      let p = asksBy.get(id);
      if (!p) asksBy.set(id, (p = d.waiting(id).catch(() => [])));
      return p;
    };
    const ms = [...new Set(body.nodes.flatMap((n) => [n.milestoneId, ...n.children.map((c) => c.milestoneId)]).filter((x): x is string => !!x))];
    const asks = (await Promise.all(ms.map(asksOf))).flat();
    const held = d.held ? (await Promise.all(ms.map((id) => d.held!(id).catch(() => [] as HeldAsk[])))).flat() : [];
    return body.nodes.map((node) => {
      const mid = node.milestoneId;
      return wheelVerdict({ node, spineInfo: body.spineInfo, claims, asks, held, repo: mid ? d.milestoneRepo(mid) : undefined });
    });
  }
  function evaluate(fresh = false): Promise<WheelIdle[]> {
    const memoMs = d.memoMs ?? 60_000;
    if (!fresh && memo && now() - memo.at < memoMs) return memo.p;
    const p = compute();
    memo = { at: now(), p };
    p.catch(() => memo?.p === p && (memo = undefined));
    return p;
  }

  /** the Delivery Manager wake's part for one milestone: its objectives below green (section) and the idle ones (ids). */
  async function forMilestone(milestoneId: string): Promise<{ section?: string; idle: string[] }> {
    const mine = (await evaluate(true)).filter((w) => w.milestoneId === milestoneId);
    return { section: objectivesSection(mine), idle: mine.filter((w) => w.idle).map((w) => w.wheel) };
  }

  /** the scorecards body with each wheel's idle mark (the sidebar and All objectives rows). */
  async function decorate<T extends ScorecardsBody>(body: T): Promise<T> {
    const marks = await evaluate().catch(() => [] as WheelIdle[]);
    const by = new Map(marks.map((m) => [m.wheel, m]));
    return {
      ...body,
      nodes: body.nodes.map((n) => {
        const m = by.get(n.id);
        return m ? { ...n, idle: { idle: m.idle, reason: m.reason } } : n;
      }),
    };
  }

  function mount(api: Hono) {
    api.get("/idle-watch", async (c) => {
      const wheels = await evaluate(c.req.query("fresh") === "1");
      return c.json({ by: "the Delivery Manager's regular wake", wakes: "each idle objective is in its milestone's Delivery Manager wake, which is never skipped while one is idle", idle: wheels.filter((w) => w.idle).length, wheels, at: new Date(now()).toISOString() });
    });
  }

  return { evaluate, forMilestone, decorate, mount };
}
