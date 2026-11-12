import { useMemo, useState, type PointerEvent } from "react";
import { api, type RunHostKey, type RunHostRange, type RunHostsSeries } from "@/api";
import { useQuery } from "@/lib/data";
import { ErrorBox } from "@/components/common";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { niceMax, viewerTimeZone } from "@/components/activeAgents";
import { cn } from "@/lib/utils";
import { mainHost, workerHost } from "../lib/identity";

/**
 * the Runs page's "Live runs by host" chart. How many runs were live at each moment of the last 24 hours (default)
 * or 7 days, stacked by the host their agent ran on: the main server at the bottom, the worker server on it, runs nothing places ("unknown") on
 * top in gray. Hover (or tap) a moment for its time and the count per host. The server sends one number per host per
 * bucket (GET /api/runs/hosts), never the runs; runHosts.ts on the server says where each run's host comes from.
 *
 * Colors (dataviz skill): categorical slots 1 and 2 of the reference palette, light and dark steps, validated with its
 * validate_palette.js (adjacent CVD ΔE 24.7 light / 26.8 dark); unknown is the neutral gray, never a third hue. Text stays
 * in text tokens; identity is a line key beside each label, and the legend is always shown.
 */
/** the main host, the worker host, then unknown (host ids from the page's identity, lib/identity.ts) */
export const hostOrder = (): RunHostKey[] => [mainHost(), workerHost(), "unknown"];
const HOST_COLOR = (h: RunHostKey): string =>
  h === mainHost() ? "text-[#2a78d6] dark:text-[#3987e5]" : h === workerHost() ? "text-[#eb6834] dark:text-[#d95926]" : "text-[#8a8984] dark:text-[#77766f]";
const RANGE_LABEL: Record<RunHostRange, string> = { "24h": "24 h", "7d": "7 d" };

const H = 140; // plot height in px

export function RunHostsSection() {
  const tz = useMemo(viewerTimeZone, []);
  const [range, setRange] = useState<RunHostRange>("24h");
  const [open, setOpen] = useSectionOpen("runs-hosts");
  const { data, error, loading } = useQuery(() => api.getRunHosts({ range }), [range]);
  const s = data && data.range === range ? data : undefined;
  return (
    <FoldSection
      title="Live runs by host"
      count={s?.peak.count}
      testId="run-hosts"
      open={open}
      onToggle={setOpen}
      meta={
        s?.peak.at ? (
          <span className="text-xs text-muted-foreground" data-testid="run-hosts-meta">
            peak {s.peak.count} at {when(s.peak.at, tz, range)}
          </span>
        ) : undefined
      }
      actions={
        <div className="ml-auto inline-flex rounded-md border p-0.5 text-xs" role="group" aria-label="Time range" data-testid="run-hosts-range">
          {(Object.keys(RANGE_LABEL) as RunHostRange[]).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === range}
              onClick={() => setRange(r)}
              className={cn("h-7 rounded px-2.5 font-medium", r === range ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
              data-testid={`run-hosts-range-${r}`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      }
    >
      {error && <ErrorBox error={error} />}
      {!s && loading && !error && <div className="animate-pulse rounded bg-muted" style={{ height: H + 48 }} aria-busy="true" aria-label="Loading" />}
      {s && <HostsChart s={s} tz={tz} />}
    </FoldSection>
  );
}

const clock = (t: number, tz: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz });
/** "Sun 1" in every locale (some put the day first). */
const dayName = (t: number, tz: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat([], { weekday: "short", day: "numeric", timeZone: tz }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day}`;
};
const when = (iso: string, tz: string, range: RunHostRange) => {
  const t = Date.parse(iso);
  return range === "24h" ? clock(t, tz) : `${dayName(t, tz)} ${clock(t, tz)}`;
};

/** One stacked band as a step shape: along `upper` left to right, back along `lower` (bucket i spans x i..i+1). */
export function bandPath(lower: number[], upper: number[], top: number): string {
  const n = upper.length;
  if (!n) return "";
  const y = (c: number) => H - (c / top) * H;
  let d = `M0 ${y(upper[0])}`;
  for (let i = 0; i < n; i++) d += `V${y(upper[i])}H${i + 1}`;
  for (let i = n - 1; i >= 0; i--) d += `V${y(lower[i])}H${i}`;
  return `${d}Z`;
}
/** The top edge of a band (its line), only where the band has runs: a line never runs along another host's edge. */
export function edgePath(lower: number[], upper: number[], top: number): string {
  const y = (c: number) => H - (c / top) * H;
  let d = "";
  let on = false;
  upper.forEach((c, i) => {
    if (c <= lower[i]) return void (on = false);
    d += on ? `V${y(c)}H${i + 1}` : `M${i} ${y(c)}H${i + 1}`;
    on = true;
  });
  return d;
}

function HostsChart({ s, tz }: { s: RunHostsSeries; tz: string }) {
  const b = s.bucketMinutes * 60_000;
  const start = Date.parse(s.start);
  const n = (s.counts[mainHost()] ?? []).length;
  const hosts = hostOrder().filter((h) => h !== "unknown" || s.runs.unknown > 0);
  const totals = useMemo(() => (s.counts[mainHost()] ?? []).map((_, i) => hostOrder().reduce((sum, h) => sum + (s.counts[h]?.[i] ?? 0), 0)), [s]);
  const top = niceMax(Math.max(1, ...totals));
  // Cumulative tops per host, bottom to top.
  const bands = useMemo(() => {
    let lower = new Array<number>(n).fill(0);
    return hosts.map((h) => {
      const upper = lower.map((v, i) => v + s.counts[h][i]);
      const out = { h, area: bandPath(lower, upper, top), line: edgePath(lower, upper, top) };
      lower = upper;
      return out;
    });
  }, [s, hosts, n, top]);
  const [hover, setHover] = useState<number | null>(null);
  const pct = (i: number) => `${(i / n) * 100}%`;
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    setHover(i >= 0 && i < n ? i : null);
  };
  // x ticks: 24 h → every 6 h by the viewer's clock; 7 d → each local midnight, labelled with the day.
  const ticks = useMemo(() => {
    const out: { i: number; label: string }[] = [];
    for (let i = 0; i < n; i++) {
      const t = start + i * b;
      const c = clock(t, tz);
      if (i / n < 0.05) continue; // a label at the very left edge would be cut or run into the next one
      if (s.range === "24h" ? /^(00|06|12|18):00$/.test(c) : c === "00:00") out.push({ i, label: s.range === "24h" ? c : dayName(t, tz) });
    }
    return out;
  }, [n, start, b, tz, s.range]);
  const span = (i: number) => {
    const a = start + i * b;
    const e = Math.min(a + b, Date.parse(s.now));
    return s.range === "24h" ? `${clock(a, tz)}–${clock(e, tz)}` : `${dayName(a, tz)} ${clock(a, tz)}–${clock(e, tz)}`;
  };
  // Table view: the busiest bucket of each hour (24 h) or day (7 d), split by host.
  const table = useMemo(() => {
    const rows: { label: string; i: number }[] = [];
    let cur: { label: string; i: number } | undefined;
    for (let i = 0; i < n; i++) {
      const t = start + i * b;
      const label = s.range === "24h" ? `${dayName(t, tz)} ${clock(t, tz).slice(0, 2)}:00` : dayName(t, tz);
      if (!cur || cur.label !== label) rows.push((cur = { label, i }));
      else if (totals[i] > totals[cur.i]) cur.i = i;
    }
    return rows;
  }, [n, start, b, tz, s.range, totals]);
  const total = hostOrder().reduce((sum, h) => sum + (s.runs[h] ?? 0), 0);
  const summary = `Live runs by host, last ${RANGE_LABEL[s.range]}: ${total} runs (${mainHost()} ${s.runs[mainHost()] ?? 0}, ${workerHost()} ${s.runs[workerHost()] ?? 0}${s.runs.unknown ? `, unknown ${s.runs.unknown}` : ""}); peak ${s.peak.count}${s.peak.at ? ` at ${when(s.peak.at, tz, s.range)}` : ""}.`;
  return (
    <div className="grid min-w-0 gap-2 pt-1" data-testid="run-hosts-chart">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="run-hosts-legend">
        {hosts.map((h) => (
          <li key={h} className="inline-flex items-center gap-1.5">
            <span className={cn("inline-block h-0.5 w-3 rounded-full bg-current", HOST_COLOR(h))} aria-hidden />
            <span className="text-foreground">{h}</span>
            <span className="tabular-nums">{s.runs[h]} runs</span>
          </li>
        ))}
      </ul>
      <div className="flex pt-1">
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
          onPointerLeave={(e) => e.pointerType !== "touch" && setHover(null)} // a tap keeps its readout (touch fires leave on lift)
          role="img"
          aria-label={summary}
          data-testid="run-hosts-plot"
        >
          {[top, top / 2].map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-border/70" style={{ top: H - (v / top) * H }} aria-hidden />
          ))}
          <div className="absolute inset-x-0 bottom-0 border-t border-border" aria-hidden />
          <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${n} ${H}`} preserveAspectRatio="none" aria-hidden>
            {bands.map(({ h, area, line }) => (
              <g key={h} className={HOST_COLOR(h)} data-testid={`run-hosts-band-${h}`}>
                <path d={area} fill="currentColor" fillOpacity={0.28} />
                <path d={line} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </g>
            ))}
          </svg>
          {hover !== null && (
            <>
              <div className="pointer-events-none absolute inset-y-0 border-l border-foreground/40" style={{ left: pct(hover + 0.5) }} aria-hidden />
              <div
                className={cn(
                  "pointer-events-none absolute top-1 z-10 grid gap-0.5 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm",
                  hover / n > 0.5 ? "-translate-x-[calc(100%+8px)]" : "translate-x-2",
                )}
                style={{ left: pct(hover + 0.5) }}
                data-testid="run-hosts-tooltip"
              >
                <span className="text-muted-foreground">{span(hover)}</span>
                {[...hosts].reverse().map((h) => (
                  <span key={h} className="inline-flex items-center gap-1.5">
                    <span className={cn("inline-block h-0.5 w-3 rounded-full bg-current", HOST_COLOR(h))} aria-hidden />
                    <span className="font-medium tabular-nums">{s.counts[h][hover]}</span> {h}
                  </span>
                ))}
                <span className="border-t pt-0.5">
                  <span className="font-medium tabular-nums">{totals[hover]}</span> live in all
                </span>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="relative ml-6 h-4 overflow-hidden text-[10px] tabular-nums text-muted-foreground" aria-hidden>
        {ticks.map((t) => (
          <span key={t.i} className={cn("absolute whitespace-nowrap", t.i / n > 0.92 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: pct(t.i) }}>
            {t.label}
          </span>
        ))}
      </div>
      {s.runs.unknown > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="run-hosts-unknown">
          {s.runs.unknown} of {total} runs have no host on record, so they show as unknown.
        </p>
      )}
      <details className="min-w-0 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">As a table</summary>
        <div className="max-h-64 overflow-y-auto">
          <table className="mt-1 tabular-nums" data-testid="run-hosts-table">
            <thead>
              <tr>
                <th className="pr-4 text-left font-medium">{s.range === "24h" ? "Hour" : "Day"}</th>
                {hosts.map((h) => (
                  <th key={h} className="pr-3 text-right font-medium">
                    {h}
                  </th>
                ))}
                <th className="text-right font-medium">Most live</th>
              </tr>
            </thead>
            <tbody>
              {table.map((r) => (
                <tr key={r.label}>
                  <td className="pr-4">{r.label}</td>
                  {hosts.map((h) => (
                    <td key={h} className="pr-3 text-right">
                      {s.counts[h][r.i]}
                    </td>
                  ))}
                  <td className="text-right">{totals[r.i]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
