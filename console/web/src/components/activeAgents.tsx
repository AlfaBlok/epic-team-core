import { useMemo, useState, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, type ActiveAgentsSeries } from "@/api";
import { useQuery } from "@/lib/data";
import { ErrorBox } from "@/components/common";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { cn } from "@/lib/utils";

/**
 * the Runs page's "Active agents" chart. How many agents (wakes and their child runs) were active at each moment
 * of one day, in the viewer's timezone: one step line, the day's peak marked, hover (or tap) a moment for its count and
 * time. Today by default, stepping back a day at a time. The server sends one number per minute (GET /api/runs/active,
 * a few KB), never the runs. Folds like every other section ('s FoldSection and CountPill: the pill is the peak).
 */
export const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** YYYY-MM-DD of `at` in `tz`. */
export function dayIn(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
export function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}

const H = 120; // plot height in px
export function ActiveAgentsSection() {
  const tz = useMemo(viewerTimeZone, []);
  const today = dayIn(new Date(), tz);
  const [day, setDay] = useState(today);
  const [open, setOpen] = useSectionOpen("runs-active");
  const { data, error, loading } = useQuery(() => api.getActiveAgents({ day, tz }), [day, tz]);
  const s = data && data.day === day ? data : undefined;
  const label = day === today ? "Today" : day === shiftDay(today, -1) ? "Yesterday" : new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const btn = "inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted disabled:opacity-40";
  return (
    <FoldSection
      title="Active agents"
      count={s?.peak.count}
      testId="active-agents"
      open={open}
      onToggle={setOpen}
      meta={
        s?.peak.at ? (
          <span className="text-xs text-muted-foreground" data-testid="active-agents-meta">
            peak {s.peak.count} at {clock(s.peak.at, tz)}
          </span>
        ) : undefined
      }
      actions={
        <div className="ml-auto flex items-center gap-1 text-xs">
          <button type="button" className={btn} onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day" title="Previous day" data-testid="active-agents-prev">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[5.5rem] text-center font-medium" data-testid="active-agents-day">
            {label}
          </span>
          <button type="button" className={btn} onClick={() => setDay(shiftDay(day, 1))} disabled={day >= today} aria-label="Next day" title="Next day" data-testid="active-agents-next">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      }
    >
      {error && <ErrorBox error={error} />}
      {!s && loading && !error && <div className="animate-pulse rounded bg-muted" style={{ height: H + 24 }} aria-busy="true" aria-label="Loading" />}
      {s && <ActiveChart s={s} tz={tz} dayLabel={label} />}
    </FoldSection>
  );
}

const clock = (iso: string, tz: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz });

/** A tidy top for the y axis (1, 2, 5, 10, …) at or above the peak. */
export function niceMax(v: number): number {
  if (v <= 2) return 2;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].map((k) => k * p).find((x) => x >= v) ?? 10 * p);
}

export function stepPath(counts: number[], top: number): { line: string; area: string } {
  if (!counts.length) return { line: "", area: "" };
  const y = (c: number) => H - (c / top) * H;
  let line = `M0 ${y(counts[0])}`;
  counts.forEach((c, i) => {
    if (i > 0 && c !== counts[i - 1]) line += `V${y(c)}`;
    if (i === counts.length - 1 || counts[i + 1] !== c) line += `H${i + 1}`;
  });
  return { line, area: `${line}V${H}H0Z` };
}

function ActiveChart({ s, tz, dayLabel }: { s: ActiveAgentsSeries; tz: string; dayLabel: string }) {
  const b = s.bucketMinutes * 60_000;
  const start = Date.parse(s.start);
  const n = Math.round((Date.parse(s.end) - start) / b); // the whole day (23-25 h), so today's line stops at now
  const top = niceMax(Math.max(1, s.peak.count));
  const { line, area } = useMemo(() => stepPath(s.counts, top), [s.counts, top]);
  const [hover, setHover] = useState<number | null>(null);
  const pct = (i: number) => `${(i / n) * 100}%`;
  // Hour marks every 6 h by the viewer's clock (a clock-change day keeps 00/06/12/18 at their real places).
  const ticks = useMemo(() => {
    const out: { i: number; label: string }[] = [];
    for (let i = 0; i < n; i += 60 / s.bucketMinutes) {
      const label = clock(new Date(start + i * b).toISOString(), tz);
      if (/^(00|06|12|18):00$/.test(label)) out.push({ i, label });
    }
    return out;
  }, [n, start, b, tz, s.bucketMinutes]);
  const peakI = s.peak.at ? Math.floor((Date.parse(s.peak.at) - start) / b) : null;
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    setHover(i >= 0 && i < s.counts.length ? i : null);
  };
  const at = (i: number) => clock(new Date(start + i * b).toISOString(), tz);
  const hourly = useMemo(() => {
    const per = 60 / s.bucketMinutes;
    const rows: { label: string; most: number }[] = [];
    for (let i = 0; i < s.counts.length; i += per) rows.push({ label: at(i), most: Math.max(...s.counts.slice(i, i + per)) });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);
  const summary = s.peak.at
    ? `Active agents ${dayLabel.toLowerCase()}: peak ${s.peak.count} at ${clock(s.peak.at, tz)}; ${s.runs} runs.`
    : `Active agents ${dayLabel.toLowerCase()}: none.`;
  return (
    <div className="grid gap-2 pt-5" data-testid="active-agents-chart">
      <div className="flex">
        {/* y axis: 0, half, top */}
        <div className="relative w-6 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground" style={{ height: H }} aria-hidden>
          {[top, top / 2, 0].map((v) => (
            <span key={v} className="absolute right-1 -translate-y-1/2" style={{ top: H - (v / top) * H }}>
              {Number.isInteger(v) ? v : ""}
            </span>
          ))}
        </div>
        <div
          className="relative min-w-0 flex-1 touch-pan-y"
          style={{ height: H }}
          onPointerMove={move}
          onPointerDown={move}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={summary}
          data-testid="active-agents-plot"
        >
          {[top, top / 2].map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: H - (v / top) * H }} aria-hidden />
          ))}
          <div className="absolute inset-x-0 bottom-0 border-t border-border" aria-hidden />
          <svg className="absolute inset-0 h-full w-full overflow-visible text-sky-600 dark:text-sky-400" viewBox={`0 0 ${n} ${H}`} preserveAspectRatio="none" aria-hidden>
            <path d={area} fill="currentColor" fillOpacity={0.14} />
            <path d={line} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" data-testid="active-agents-line" />
          </svg>
          {peakI !== null && (
            <div className="pointer-events-none absolute" style={{ left: pct(peakI + 0.5), top: H - (s.peak.count / top) * H }} data-testid="active-agents-peak">
              <span className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-600 ring-2 ring-card dark:bg-sky-400" />
              <span className={cn("absolute -top-5 whitespace-nowrap text-[11px] font-medium text-foreground", peakI / n > 0.8 ? "right-1" : "left-1.5")}>
                peak {s.peak.count} · {clock(s.peak.at!, tz)}
              </span>
            </div>
          )}
          {hover !== null && (
            <>
              <div className="pointer-events-none absolute inset-y-0 border-l border-foreground/40" style={{ left: pct(hover + 0.5) }} aria-hidden />
              <div
                className={cn("pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm", hover / n > 0.6 ? "-translate-x-[calc(100%+8px)]" : "translate-x-2")}
                style={{ left: pct(hover + 0.5) }}
                data-testid="active-agents-tooltip"
              >
                <span className="font-medium tabular-nums">{s.counts[hover]}</span> {s.counts[hover] === 1 ? "agent" : "agents"} · {at(hover)}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="relative ml-6 h-4 text-[10px] tabular-nums text-muted-foreground" aria-hidden>
        {ticks.map((t) => (
          <span key={t.i} className={cn("absolute", t.i === 0 ? "" : "-translate-x-1/2")} style={{ left: pct(t.i) }}>
            {t.label}
          </span>
        ))}
        <span className="absolute right-0">24:00</span>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">{s.runs} runs this day · as a table</summary>
        <table className="mt-1 tabular-nums" data-testid="active-agents-table">
          <thead>
            <tr>
              <th className="pr-4 text-left font-medium">Hour</th>
              <th className="text-right font-medium">Most active</th>
            </tr>
          </thead>
          <tbody>
            {hourly.map((r) => (
              <tr key={r.label}>
                <td className="pr-4">{r.label}</td>
                <td className="text-right">{r.most}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
