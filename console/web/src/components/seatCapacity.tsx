import { api, type CapacityApp, type SeatCapacity } from "@/api";
import { useQuery } from "@/lib/data";
import { Card } from "@/components/ui/card";
import { RelTime } from "@/components/common";
import type { Consumption } from "@/api/totem-types";

/**
 * the seats as a share of their capacity, per app, this week and at the last days' pace, and the one
 * line on how much more load fits. Read live (GET /api/seats/capacity, or a customer's own seats with `world`).
 * Percent only: no dollars, no prices.
 */
// categorical slots in a fixed order (the dataviz reference palette, as on the page he liked); the rest grey, "Not metered" light grey
const HUES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
const REST = "#8a8f98";
const HATCH = "#cdd0d6"; // flat light grey: surfaces stay flat (clean look)

export const pc = (v: number) => (v > 0 && v < 0.095 ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`);

export function hueOf(apps: CapacityApp[], app: string): string {
  if (app === "Not metered") return HATCH;
  const i = apps.filter((a) => a.app !== "Not metered" && a.app !== "Everything else").findIndex((a) => a.app === app);
  return i >= 0 && i < HUES.length ? HUES[i] : REST;
}

function Bar({ apps, k, scale, label, value, testId }: { apps: CapacityApp[]; k: "week" | "pace"; scale: number; label: string; value: number; testId: string }) {
  const full = 1 / scale;
  return (
    <div data-testid={testId}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums text-sm font-semibold text-foreground">{pc(value)}</span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label}: ${pc(value)} of capacity`}>
        <div className="flex h-full">
          {apps.map((a) =>
            a[k] > 0 ? <div key={a.app} title={`${a.app}: ${pc(a[k])}`} style={{ width: `${(a[k] / scale) * 100}%`, background: hueOf(apps, a.app) }} /> : null,
          )}
        </div>
        {scale > 1 && <div className="absolute inset-y-0 border-l-2 border-dashed border-foreground/70" style={{ left: `${full * 100}%` }} title="100%: the seats' limit" />}
      </div>
    </div>
  );
}

export function capacityTone(c: Pick<SeatCapacity, "pace" | "moreFits">): "full" | "tight" | "room" {
  if (c.pace == null) return "room";
  if (c.moreFits == null || c.moreFits < 0.05) return "full";
  return c.moreFits < 0.25 ? "tight" : "room";
}

export function SeatCapacityView({ c }: { c: SeatCapacity }) {
  const scale = Math.max(1, (c.pace ?? 0) * 1.05, c.week);
  const tone = capacityTone(c);
  const more = tone === "full" ? "None" : c.moreFits == null ? "?" : `+${pc(c.moreFits)}`;
  const out = c.seats.signedOut + c.seats.blocked;
  return (
    <div className="space-y-4">
      <p className="text-base font-medium leading-snug" data-testid="capacity-answer">
        {c.answer}
      </p>
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border" data-testid="capacity-numbers">
        {[
          { n: pc(c.week), what: "used this week" },
          { n: c.pace == null ? "?" : pc(c.pace), what: "last days' pace" },
          { n: more, what: "more load fits", warn: tone === "full" },
        ].map((b) => (
          <div key={b.what} className="bg-card px-3 py-2.5">
            <div className={`text-2xl font-semibold tabular-nums ${b.warn ? "text-destructive" : ""}`}>{b.n}</div>
            <div className="text-xs text-muted-foreground">{b.what}</div>
          </div>
        ))}
      </div>
      <Bar apps={c.apps} k="week" scale={scale} label="This week, of the seats' limit" value={c.week} testId="capacity-week" />
      {c.pace != null && <Bar apps={c.apps} k="pace" scale={scale} label="At the last days' pace, of a week's limit" value={c.pace} testId="capacity-pace" />}
      <ul className="divide-y rounded-lg border text-sm" data-testid="capacity-apps">
        {c.apps.map((a) => (
          <li key={a.app} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-2" data-testid="capacity-app">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: hueOf(c.apps, a.app) }} aria-hidden />
              <span className="min-w-0 break-words">{a.app}</span>
            </span>
            <span className="whitespace-nowrap pl-[18px] tabular-nums text-muted-foreground sm:pl-0">
              <span className="text-foreground">{pc(a.week)}</span> this week · <span className="text-foreground">{pc(a.pace)}</span> pace
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground" data-testid="capacity-seats">
        {c.seats.all} {c.seats.all === 1 ? "seat" : "seats"}, {c.seats.working} working
        {c.seats.signedOut ? `, ${c.seats.signedOut} signed out` : ""}
        {c.seats.blocked ? `, ${c.seats.blocked} limited for days` : ""}
        {c.seats.limited ? `, ${c.seats.limited} at a short limit` : ""}
        {out && c.lost > 0 ? ` (${pc(c.lost)} of the capacity out of use)` : ""}. About {Math.round(c.runsPerDay)} runs a day. Read live <RelTime iso={c.at} />.
      </p>
    </div>
  );
}

/** each objective's share of the whole subscription and of what was used this week (the Consumption chapters' file). */
export function ObjectiveSplit({ c, top = 6 }: { c: Consumption; top?: number }) {
  const rows = (c.wheels ?? []).filter((w) => w.ofTotal > 0).slice(0, top);
  if (!rows.length) return null;
  const max = Math.max(...rows.map((w) => w.ofUsed), 0.0001);
  return (
    <div id="objectives" className="scroll-mt-20" data-testid="capacity-objectives">
      <h3 className="mb-1 text-sm font-medium">Per objective, this week</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Share of what was used, then of your whole subscription. {pc(c.usedOfTotal)} of the whole was used.
      </p>
      <ul className="divide-y rounded-lg border text-sm">
        {rows.map((w) => (
          <li key={w.key} className="grid gap-1 px-3 py-2" data-testid="capacity-objective">
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
              {w.kind === "objective" ? (
                <a href={`/sets/${encodeURIComponent(w.key)}?tab=consumption`} className="min-w-0 flex-1 break-words hover:underline">
                  {w.name}
                </a>
              ) : (
                <span className="min-w-0 flex-1 break-words">{w.name}</span>
              )}
              <span className="whitespace-nowrap tabular-nums text-muted-foreground sm:ml-auto">
                <span className="text-foreground">{pc(w.ofUsed)}</span> of used · <span className="text-foreground">{pc(w.ofTotal)}</span> of all
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden>
              <div className="h-1.5 rounded-full" style={{ width: `${(w.ofUsed / max) * 100}%`, background: HUES[0] }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ObjectivesOfTeam() {
  const { data } = useQuery(() => api.getConsumption("all").catch(() => undefined), []);
  return data ? <ObjectiveSplit c={data} /> : null;
}

/** `bare` draws it inside another card (a customer's Your Claude seats card) instead of its own. */
export function SeatCapacityPanel({ world, bare }: { world?: string; bare?: boolean }) {
  const { data, error } = useQuery(() => api.getSeatCapacity(world), [world]);
  const body = (
    <>
      <h2 className="mb-2 text-sm font-medium text-muted-foreground">How full your seats are</h2>
      {error && <p className="text-xs text-muted-foreground">Capacity not read: {error.message}</p>}
      {!data && !error && <p className="text-xs text-muted-foreground">Reading your seats…</p>}
      {data && <SeatCapacityView c={data} />}
      {data && !world && (
        <div className="mt-4">
          <ObjectivesOfTeam />
        </div>
      )}
    </>
  );
  return bare ? (
    <section id="capacity" className="mt-4 scroll-mt-20 border-t pt-4" data-testid="seat-capacity">
      {body}
    </section>
  ) : (
    <Card id="capacity" className="mb-4 scroll-mt-20 p-4" data-testid="seat-capacity">
      {body}
    </Card>
  );
}
