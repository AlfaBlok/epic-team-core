import { useState } from "react";
import { api, type RunUsage, type UsageGroup } from "@/api";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { RelTime } from "@/components/common";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cap, useWords } from "@/lib/skin";

/** 950 → "950", 12_345 → "12.3k", 3_400_000 → "3.4M". */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
export const formatUsd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

/** Tokens read (fresh input + cache writes + cache reads): what the model processed as input. */
export const inputTotal = (u: Pick<RunUsage, "input" | "cacheWrite" | "cacheRead">) => u.input + u.cacheWrite + u.cacheRead;

/** an Activity / Runs row's `in/out tokens · $x.xx est.`; nothing until the usage is collected.
 * a running run shows its tokens so far, marked live. */
export function UsageChip({ usage, live, className }: { usage?: RunUsage; live?: RunUsage; className?: string }) {
  if (!usage && live)
    return (
      <span className={cn("tabular-nums", className)} data-testid="run-usage" title={`Tokens so far (read ${new Date(live.collectedAt).toLocaleTimeString()}); final numbers a few minutes after it ends.`}>
        <span className="text-emerald-600 dark:text-emerald-400">live</span> {compactTokens(inputTotal(live))} in / {compactTokens(live.output)} out
        {live.costUsd !== null && ` · ${formatUsd(live.costUsd)} so far`}
      </span>
    );
  if (!usage) return null;
  if (usage.source.startsWith("same-as:"))
    return (
      <span className={className} data-testid="run-usage" title={`A second record of the same worker session: its tokens are counted on ${usage.source.slice(8)}.`}>
        counted on {usage.source.slice(8, 20)}
      </span>
    );
  if (usage.source === "no-thread" || usage.source === "no-turn")
    return (
      <span className={className} data-testid="run-usage" title="This wake never ran a turn (skipped, or its host was down): no tokens used.">
        0 tokens
      </span>
    );
  const title = [
    `input ${usage.input.toLocaleString()} · cache write ${usage.cacheWrite.toLocaleString()} · cache read ${usage.cacheRead.toLocaleString()} · output ${usage.output.toLocaleString()}`,
    `${usage.turns} API call${usage.turns === 1 ? "" : "s"} · ${Object.keys(usage.byModel ?? { [usage.model]: 0 }).join(", ")}${usage.seat ? ` · ${usage.seat}` : ""}`,
    "Cost is an estimate at API list prices (seats are subscriptions).",
  ].join("\n");
  return (
    <span className={cn("tabular-nums", className)} data-testid="run-usage" title={title}>
      {compactTokens(inputTotal(usage))} in / {compactTokens(usage.output)} out · {usage.costUsd === null ? "cost n/a" : `${formatUsd(usage.costUsd)} est.`}
    </span>
  );
}

const WINDOWS = [
  { key: "24h", label: "Last 24 h", ms: 24 * 3600_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 3600_000 },
] as const;
const GROUPS = ["persona", "milestone", "seat"] as const;
/** a group's word on screen (the milestone group says the skin's word, project on EpicTeam); the API keeps `milestone`. */
const groupWord = (g: (typeof GROUPS)[number], unit: string) => (g === "milestone" ? unit : g);

/** Runs page panel: tokens and estimated cost in the last 24 h / 7 d, per persona, milestone or seat,
 * with each seat's live 5-hour and weekly quota. */
export function UsagePanel({ now = Date.now() }: { now?: number }) {
  const [win, setWin] = useState<(typeof WINDOWS)[number]["key"]>("24h");
  const [groupBy, setGroupBy] = useState<(typeof GROUPS)[number]>("persona");
  const w = useWords();
  const ms = WINDOWS.find((w) => w.key === win)!.ms;
  // Round the window to the minute so re-renders do not refetch.
  const to = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
  const from = new Date(Date.parse(to) - ms).toISOString();
  const { data, error } = useQuery(() => api.getUsage({ from, to, groupBy }), [from, to, groupBy]);
  const tab = (active: boolean) => cn("rounded px-2 py-0.5", active ? "bg-muted font-medium text-foreground" : "hover:text-foreground");
  const live = data?.total.live;
  const reasons = Object.entries(data?.missingReasons ?? {});
  return (
    <Card className="mb-4 p-4" data-testid="usage-panel">
      <SeatQuotaStrip />
      <a href="/seats?focus=capacity#capacity" className="mb-3 inline-block text-xs text-primary hover:underline" data-testid="usage-capacity-link">
        How full your seats are, per app, and how much more fits →
      </a>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="text-sm font-medium text-foreground">Usage</span>
        <span className="flex gap-1">
          {WINDOWS.map((w) => (
            <button key={w.key} type="button" className={tab(win === w.key)} onClick={() => setWin(w.key)}>
              {w.label}
            </button>
          ))}
        </span>
        <span className="flex gap-1">
          {GROUPS.map((g) => (
            <button key={g} type="button" className={tab(groupBy === g)} onClick={() => setGroupBy(g)}>
              per {groupWord(g, w.milestone)}
            </button>
          ))}
        </span>
        {data && (
          <span className="ml-auto tabular-nums" data-testid="usage-total">
            {compactTokens(inputTotal(data.total))} in / {compactTokens(data.total.output)} out · {formatUsd(data.total.costUsd)} est.
          </span>
        )}
      </div>
      {error && <p className="text-xs text-destructive">Usage unavailable: {error.message}</p>}
      {data && data.groups.length === 0 && <p className="text-xs text-muted-foreground">No runs in this window.</p>}
      {data && data.groups.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">{cap(groupWord(groupBy, w.milestone))}</th>
              <th className="py-1 text-right font-normal">Wakes</th>
              <th className="py-1 text-right font-normal">In</th>
              <th className="py-1 text-right font-normal">Out</th>
              <th className="py-1 text-right font-normal">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((g) => (
              <UsageRow key={g.key} g={g} />
            ))}
          </tbody>
        </table>
      )}
      {live && live.runs > 0 && (
        <p className="mt-2 text-xs tabular-nums text-muted-foreground" data-testid="usage-live">
          <span className="text-emerald-600 dark:text-emerald-400">live</span> {live.runs} run{live.runs === 1 ? "" : "s"} working:{" "}
          {compactTokens(live.input)} in / {compactTokens(live.output)} out · {formatUsd(live.costUsd)} so far (not in the totals until they end)
        </p>
      )}
      {data && (data.total.missing ?? 0) > 0 && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="usage-missing">
          Not counted: {data.total.missing} ended run{data.total.missing === 1 ? "" : "s"} with no transcript found
          {reasons.length > 0 && ` (${reasons.map(([r, n]) => `${n} ${r}`).join("; ")})`}, re-checked every 10 min for 7 days.
        </p>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        From each run's Claude Code transcript (every seat dir), read 1 min after it ends and final at 5 min; running wakes every 2 min.
        Wakes that never ran count as 0. Cost is an estimate at API list prices.
        {data?.updatedAt && <> Newest read <RelTime iso={data.updatedAt} />.</>}
      </p>
    </Card>
  );
}

function UsageRow({ g }: { g: UsageGroup }) {
  const notes = [
    g.skipped ? `${g.skipped} never ran` : "",
    g.pending ? `${g.pending} pending` : "",
    g.missing ? `${g.missing} missing` : "",
  ].filter(Boolean).join(", ");
  const title = [
    g.skipped ? `${g.skipped} never ran a turn (skipped, host down): 0 tokens` : "",
    g.pending ? `${g.pending} ended, not read yet (read 1 min after the end)` : "",
    g.missing ? `${g.missing} read, no transcript names them (re-checked every 10 min)` : "",
    g.live?.runs ? `${g.live.runs} still working: ${compactTokens(g.live.input)} in / ${compactTokens(g.live.output)} out so far` : "",
  ].filter(Boolean).join("\n");
  return (
    <tr className="border-t tabular-nums" data-testid="usage-row">
      <td className="max-w-[16rem] truncate py-1" title={g.label}>
        {g.label}
        {g.live?.runs ? <span className="ml-1 text-emerald-600 dark:text-emerald-400">· {g.live.runs} live</span> : null}
      </td>
      <td className="py-1 text-right" title={title || undefined}>
        {g.runs}
        {notes && <span className="text-muted-foreground"> ({notes})</span>}
      </td>
      <td className="py-1 text-right">{compactTokens(inputTotal(g))}</td>
      <td className="py-1 text-right">{compactTokens(g.output)}</td>
      <td className="py-1 text-right">{formatUsd(g.costUsd)}</td>
    </tr>
  );
}

/** each seat's live 5-hour and weekly quota (the Seats page's numbers, from seats.json) with reset times. */
export function SeatQuotaStrip() {
  const { data } = useQuery(() => api.listSeats(), []);
  if (!data?.length) return null;
  const pct = (n?: number) => (n === undefined ? "?" : `${Math.round(n)}%`);
  const tone = (n?: number) => (n === undefined ? "" : n >= 90 ? "text-destructive" : n >= 70 ? "text-amber-700 dark:text-amber-400" : "");
  return (
    <div className="mb-3 flex flex-wrap gap-2" data-testid="seat-strip">
      {data.map((s) => {
        const reset5 = s.limited && s.resetsAt.limitedUntil ? s.resetsAt.limitedUntil : s.resetsAt.fiveHour;
        return (
          <div
            key={s.id}
            className="min-w-[9rem] rounded border px-2 py-1 text-xs"
            data-testid="seat-quota"
            title={[
              s.org ? `${s.name} (${s.org})` : s.name,
              s.resetsAt.fiveHour ? `5-hour window resets ${formatDateTime(s.resetsAt.fiveHour)}` : "",
              s.resetsAt.weekly ? `weekly resets ${formatDateTime(s.resetsAt.weekly)}` : "",
              s.reason ?? "",
              s.readAt ? `read ${formatDateTime(s.readAt)}` : "",
            ].filter(Boolean).join("\n")}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{s.name}</span>
              <span className={cn("text-[11px]", s.status === "ok" ? "text-muted-foreground" : s.status === "limited" ? "text-destructive" : "text-muted-foreground")}>
                {s.status === "ok" ? `${s.inFlight} in flight` : s.status.replace("_", " ")}
              </span>
            </div>
            <div className="tabular-nums text-muted-foreground">
              5h <span className={cn("text-foreground", tone(s.usage5h))}>{pct(s.usage5h)}</span>
              {reset5 && <> · resets {formatRelative(reset5)}</>}
            </div>
            <div className="tabular-nums text-muted-foreground">
              week{" "}
              {s.usageWeekly === undefined && s.weeklySource ? (
                <span title="This seat has no general weekly cap">{s.weeklySource}</span>
              ) : (
                <span className={cn("text-foreground", tone(s.usageWeekly))}>{pct(s.usageWeekly)}</span>
              )}
              {s.resetsAt.weekly && <> · {formatRelative(s.resetsAt.weekly)}</>}
            </div>
            {s.modelWeekly?.map((m) => (
              <div key={m.model} className="tabular-nums text-muted-foreground">
                {m.model} week <span className={cn("text-foreground", tone(m.pct))}>{pct(m.pct)}</span>
                {m.resetsAt && <> · {formatRelative(m.resetsAt)}</>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
