import type { Hono } from "hono";
import type { DB } from "../db.js";
import { parseUsage, type RunUsage } from "./collector.js";
import { worldArgs, worldGuard, type WorldOf } from "../tenancy/world.js";

/**
 * usage on run objects and `GET /api/usage?from&to&groupBy=persona|milestone|seat|day` totals.
 * per seat (the Claude config dir the transcript was in, else the run row's seat), honest states for runs not
 * counted (pending = not read yet / host asleep; missing = read, no transcript names it, by reason), and runs still
 * working with their tokens so far (live; never in the totals).
 */

/** The run's stored usage (undefined = not collected yet, or an answer run). */
export function runUsageLookup(db: DB) {
  const get = db.prepare(`SELECT usage FROM runs WHERE id = ?`);
  return (runId: string): RunUsage | undefined => parseUsage((get.get(runId) as { usage: string | null } | undefined)?.usage);
}

/** a running run's tokens so far (undefined = none read yet). */
export function runLiveUsageLookup(db: DB) {
  const get = db.prepare(`SELECT usage_live FROM runs WHERE id = ? AND ended_at IS NULL`);
  return (runId: string): RunUsage | undefined => parseUsage((get.get(runId) as { usage_live: string | null } | undefined)?.usage_live);
}

export type GroupBy = "persona" | "milestone" | "seat" | "day";
const GROUP_BYS: GroupBy[] = ["persona", "milestone", "seat", "day"];

export interface UsageGroup {
  key: string;
  label: string;
  /** Ended wake runs in the window (wakes, children, skipped wakes). */
  runs: number;
  /** Of those, how many have usage (skipped wakes count, with 0 tokens). */
  collected: number;
  /** Ended runs not read yet (ended under a minute ago, waiting for the next sweep, or host asleep). */
  pending: number;
  /** ended runs read and not found (no transcript names them); retried every 10 min for 7 days. */
  missing: number;
  /** Runs whose usage is 0 because they never ran a turn (no thread, skipped as unchanged, host down). */
  skipped: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  turns: number;
  /** Sum of the runs' estimates; runs on a model without a price add nothing. */
  costUsd: number;
  /** runs still working in the window, and their tokens so far (not in the numbers above). */
  live: { runs: number; input: number; output: number; costUsd: number };
}

interface Row {
  id: string;
  started_at: string;
  ended_at: string | null;
  milestone_id: string | null;
  persona_id: string | null;
  seat: string | null;
  usage: string | null;
  usage_live: string | null;
  usage_note: string | null;
  persona_name: string | null;
  milestone_title: string | null;
}

/** `missing: no transcript on the worker server names this run` -> `no transcript on the worker server`. */
const reasonOf = (note: string) => note.replace(/^missing:\s*/, "").replace(/ names this run$/, "");

export function usageTotals(
  db: DB,
  q: { from: string; to: string; groupBy: GroupBy; /** one world's runs (undefined = all) */ tenant?: string },
): { from: string; to: string; groupBy: GroupBy; groups: UsageGroup[]; total: UsageGroup; missingReasons: Record<string, number>; updatedAt: string | null } {
  const rows = db
    .prepare(
      `SELECT r.id, r.started_at, r.ended_at, r.milestone_id, r.seat,
              COALESCE(r.persona_id, (SELECT a.persona_id FROM assignments a WHERE a.id = r.assignment_id)) AS persona_id,
              r.usage, r.usage_live, r.usage_note, p.name AS persona_name, m.title AS milestone_title
         FROM runs r
         LEFT JOIN personas p ON p.id = COALESCE(r.persona_id, (SELECT a.persona_id FROM assignments a WHERE a.id = r.assignment_id))
         LEFT JOIN milestones m ON m.id = r.milestone_id
        WHERE r.kind = 'wake' AND r.started_at >= ? AND r.started_at < ? AND ${worldGuard("r.tenant_id")}`,
    )
    .all(q.from, q.to, ...worldArgs(q.tenant)) as Row[];
  const empty = (key: string, label: string): UsageGroup => ({
    key, label, runs: 0, collected: 0, pending: 0, missing: 0, skipped: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, costUsd: 0,
    live: { runs: 0, input: 0, output: 0, costUsd: 0 },
  });
  const groups = new Map<string, UsageGroup>();
  const total = empty("total", "Total");
  const missingReasons: Record<string, number> = {};
  let updatedAt: string | null = null;
  for (const r of rows) {
    const u = parseUsage(r.usage);
    const live = r.ended_at ? undefined : parseUsage(r.usage_live);
    if (!r.ended_at && !live) continue; // running, nothing read yet: shows once it has tokens or ends
    const zero = u?.source === "no-thread" || u?.source === "no-turn";
    const seat = u?.seat ?? live?.seat ?? (zero ? "none" : r.seat ?? "unknown");
    const [key, label] =
      q.groupBy === "persona"
        ? [r.persona_id ?? "none", r.persona_name ?? (r.persona_id ? "deleted persona" : "bootstrap")]
        : q.groupBy === "milestone"
          ? [r.milestone_id ?? "none", r.milestone_title ?? r.milestone_id ?? "no milestone"]
          : q.groupBy === "seat"
            ? [seat, seat === "default" ? "default (~/.claude)" : seat === "none" ? "no seat (never ran)" : seat]
            : [r.started_at.slice(0, 10), r.started_at.slice(0, 10)];
    const g = groups.get(key) ?? empty(key, label);
    groups.set(key, g);
    for (const at of [u?.collectedAt, live?.collectedAt]) if (at && (!updatedAt || at > updatedAt)) updatedAt = at;
    if (!r.ended_at) {
      for (const t of [g, total]) {
        t.live.runs++;
        t.live.input += live!.input + live!.cacheWrite + live!.cacheRead;
        t.live.output += live!.output;
        t.live.costUsd += live!.costUsd ?? 0;
      }
      continue;
    }
    const missing = !u && !!r.usage_note?.startsWith("missing");
    if (missing) missingReasons[reasonOf(r.usage_note!)] = (missingReasons[reasonOf(r.usage_note!)] ?? 0) + 1;
    for (const t of [g, total]) {
      t.runs++;
      if (!u) {
        if (missing) t.missing++;
        else t.pending++;
        continue;
      }
      t.collected++;
      if (u.source === "no-thread" || u.source === "no-turn") t.skipped++;
      t.input += u.input;
      t.cacheWrite += u.cacheWrite;
      t.cacheRead += u.cacheRead;
      t.output += u.output;
      t.turns += u.turns;
      t.costUsd += u.costUsd ?? 0;
    }
  }
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const round = (g: UsageGroup) => ({ ...g, costUsd: r4(g.costUsd), live: { ...g.live, costUsd: r4(g.live.costUsd) } });
  const list = [...groups.values()]
    .map(round)
    .sort((a, b) => (q.groupBy === "day" ? a.key.localeCompare(b.key) : b.costUsd - a.costUsd || b.live.costUsd - a.live.costUsd || b.runs - a.runs));
  return { from: q.from, to: q.to, groupBy: q.groupBy, groups: list, total: round(total), missingReasons, updatedAt };
}

export function mountUsage(api: Hono, db: DB, world: WorldOf = () => undefined) {
  api.get("/usage", (c) => {
    const groupBy = (c.req.query("groupBy") ?? "persona") as GroupBy;
    if (!GROUP_BYS.includes(groupBy))
      return c.json({ error: { code: "validation_error", message: "groupBy must be persona, milestone, seat or day" } }, 400);
    const to = c.req.query("to") ?? new Date().toISOString();
    const from = c.req.query("from") ?? new Date(Date.parse(to) - 24 * 3600_000).toISOString();
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
      return c.json({ error: { code: "validation_error", message: "from and to must be ISO dates" } }, 400);
    return c.json(usageTotals(db, { from: new Date(from).toISOString(), to: new Date(to).toISOString(), groupBy, tenant: world() }));
  });
}
