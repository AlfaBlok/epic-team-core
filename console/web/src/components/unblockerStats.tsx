import { useState } from "react";
import { api, type UnblockerCounts, type UnblockerStatsWindow } from "@/api";
import { useQuery } from "@/lib/data";
import { formatMinutes } from "@/lib/format";
import { cap, useSkin, useWords } from "@/lib/skin";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ownerName } from "@/lib/identity";

const WINDOWS: { key: UnblockerStatsWindow; label: string }[] = [
  { key: "24h", label: "Last 24 h" },
  { key: "7d", label: "Last 7 days" },
  { key: "all", label: "All" },
];

/** 40 s → "<1 min", 5 h 10 min → "5 h 10 min"; null → "–". */
export function formatWait(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  return ms < 60_000 ? "<1 min" : formatMinutes(Math.round(ms / 60_000));
}

/** "5 h 10 min / 11 h" with the waiting asks after it; estimated timings are flagged in the title. */
function Timing({ c }: { c: UnblockerCounts }) {
  const t = c.askToVerdict;
  const title = [
    `${t.count} ask${t.count === 1 ? "" : "s"} got a first verdict in this window.`,
    t.estimated ? `${t.estimated} timed from the first Unblocker wake that listed it (no line time recorded).` : "",
    t.waiting ? `${t.waiting} still waiting for a verdict; oldest ${t.oldestWaitingCode} (${formatWait(t.oldestWaitingMs)}).` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span title={title} data-testid="ub-timing">
      {t.count ? `${formatWait(t.medianMs)} / ${formatWait(t.worstMs)}${t.worstCode ? ` (${t.worstCode})` : ""}` : "–"}
      {t.estimated ? "*" : ""}
      {t.waiting ? <span className="text-amber-600"> · {t.waiting} waiting</span> : null}
    </span>
  );
}

function Row({ label, c, strong }: { label: string; c: UnblockerCounts; strong?: boolean }) {
  // counts a split as answered (it answered the parts it could); the split count is in the title.
  const answered = c.answered + c.split;
  return (
    <tr className={cn("border-t", strong && "font-medium")} data-testid="ub-row">
      <td className="max-w-[14rem] truncate py-1 pr-3" title={label}>
        {label}
      </td>
      <td className="pr-3 text-right" title={`${c.wakesFired} wakes ran · ${c.wakesSkipped} skipped (nothing new)`}>
        {c.wakesFired} / {c.wakesSkipped}
      </td>
      <td className="pr-3 text-right">{c.newAsks}</td>
      <td className="pr-3 text-right">{c.assessed}</td>
      <td className="pr-3 text-right" title={c.split ? `${c.split} split (answered in part)` : undefined}>
        {answered}
      </td>
      <td className="pr-3 text-right">{c.left}</td>
      <td className={cn("pr-3 text-right", c.reversed && "text-destructive")}>{c.reversed}</td>
      <td className="pr-3 text-right">
        <Timing c={c} />
      </td>
      <td className="text-right" data-testid="ub-score">
        {c.score ? `${Math.round(c.score.median)}${c.score.threshold !== undefined ? ` / ${c.score.threshold}` : ""}` : "–"}
      </td>
    </tr>
  );
}

/**
 * Runs page panel (console skin): the Unblocker's numbers per milestone for the last 24 h / 7 d / all — wakes
 * fired / skipped, new asks seen, assessed, answered, left, reversed by the owner, time from ask to verdict (median / worst),
 * and the score / threshold when verdicts carry one.
 */
export function UnblockerPanel() {
  return useSkin().id === "console" ? <Panel /> : null;
}

function Panel() {
  const w = useWords();
  const [win, setWin] = useState<UnblockerStatsWindow>("24h");
  const { data, error } = useQuery(() => api.getUnblockerStats({ window: win }), [win]);
  const tab = (active: boolean) => cn("rounded px-2 py-0.5", active ? "bg-muted font-medium text-foreground" : "hover:text-foreground");
  const anyScore = !!data?.milestones.some((m) => m.score);
  return (
    <Card className="mb-4 p-4" data-testid="unblocker-panel">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="text-sm font-medium text-foreground">Unblocker</span>
        <span className="flex gap-1">
          {WINDOWS.map((w) => (
            <button key={w.key} type="button" className={tab(win === w.key)} onClick={() => setWin(w.key)}>
              {w.label}
            </button>
          ))}
        </span>
      </div>
      {error && <p className="text-xs text-destructive">Unblocker numbers unavailable: {error.message}</p>}
      {data && data.milestones.length === 0 && <p className="text-xs text-muted-foreground">No Unblocker wakes in this window.</p>}
      {data && data.milestones.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 text-left font-normal">{cap(w.milestone)}</th>
                <th className="pr-3 text-right font-normal" title="Wakes that ran / wakes skipped (nothing new or changed)">
                  Wakes / skipped
                </th>
                <th className="pr-3 text-right font-normal" title="Asks raised in this window">
                  New asks
                </th>
                <th className="pr-3 text-right font-normal" title="Asks the Unblocker assessed itself (carried verdicts not counted)">
                  Assessed
                </th>
                <th className="pr-3 text-right font-normal">Answered</th>
                <th className="pr-3 text-right font-normal">Left</th>
                <th className="pr-3 text-right font-normal" title={`Decisions the Unblocker took that ${ownerName()} reversed`}>
                  Reversed
                </th>
                <th className="pr-3 text-right font-normal" title="Time from ask (its spine line) to the Unblocker's first verdict: median / worst">
                  Ask → verdict
                </th>
                <th className="text-right font-normal" title={anyScore ? "Median confidence score / threshold" : "Confidence score / threshold, once verdicts carry one"}>
                  Score
                </th>
              </tr>
            </thead>
            <tbody>
              {data.milestones.map((m) => (
                <Row key={m.milestoneId} label={m.milestoneTitle} c={m} />
              ))}
              {data.milestones.length > 1 && <Row label={`All ${w.milestonesWord}`} c={data.total} strong />}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
