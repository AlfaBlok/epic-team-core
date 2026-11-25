import { api } from "@/api";
import type { ConsumptionPersona } from "@/api/totem-types";
import { ErrorBox, Loading } from "@/components/common";
import { useQuery } from "@/lib/data";

/**
 * A wheel's Consumption chapter. The owner, WhatsApp voice note 25 Nov 14:34Z
 * (Log/2026-11-25.md#^e-3941fc): "percentage of total subscription and percentage of the used subscription. So of
 * everything that was used, this is the breakdown and that itself is whatever, this portion of the total subscription"
 * and "is this a chapter? I think yes ... you click and you get the breakdown of consumption. Like, which personas have
 * been consuming what and what's been the contribution of the personas? In the context of this wheel".
 * Answer first (this wheel's share of the whole subscription and of what was used), then one bar of the whole
 * subscription, then each persona's part and what it made true. Read from docs/consumption/latest.json.
 */
const pc = (v: number) => (v === 0 ? "0%" : v >= 0.095 ? `${Math.round(v * 100)}%` : v >= 0.001 ? `${(v * 100).toFixed(1)}%` : "under 0.1%");
const read = (at: string | null) => {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
};

function PersonaRow({ p }: { p: ConsumptionPersona }) {
  const part = p.ofWheel ?? 0;
  return (
    <li className="grid gap-1 border-b py-3 last:border-b-0" data-testid="consumption-persona" data-persona={p.persona}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="font-medium">{p.persona}</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          <b className="font-semibold text-foreground">{pc(part)}</b> of this · {pc(p.ofTotal)} of your subscription
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-sm bg-muted" aria-hidden>
        <div className="h-full bg-[#2a78d6]" style={{ width: `${Math.max(0.5, part * 100)}%` }} />
      </div>
      <p className="text-sm text-muted-foreground">
        {p.outcomes} thing{p.outcomes === 1 ? "" : "s"} made true in {p.runs} run{p.runs === 1 ? "" : "s"} · {pc(p.madeTrue)} of its use went into runs that made one
      </p>
    </li>
  );
}

export function ConsumptionTab({ wheel }: { wheel: string }) {
  const { data, error, loading } = useQuery(() => api.getConsumption(wheel), [wheel]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  const w = data.wheel;
  const other = Math.max(0, data.usedOfTotal - (w?.ofTotal ?? 0));
  const free = Math.max(0, 1 - data.usedOfTotal);
  return (
    <section className="grid min-w-0 gap-4" data-testid="consumption-tab" data-wheel={wheel}>
      <div className="grid gap-1 rounded-xl border bg-card p-4" data-testid="consumption-answer">
        {w ? (
          <>
            <p className="text-2xl font-semibold tabular-nums">
              {pc(w.ofTotal)} of your whole subscription · {pc(w.ofUsed)} of what was used
            </p>
            <p className="text-sm text-muted-foreground">
              This week, across your {data.seats} seats. You used {pc(data.usedOfTotal)} of the subscription in all{data.rank ? `; this one is number ${data.rank} of ${data.of} by use` : ""}.
            </p>
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold">Nothing used this week</p>
            <p className="text-sm text-muted-foreground">No run on your seats served this one in the seats&rsquo; current week. You used {pc(data.usedOfTotal)} of the subscription in all.</p>
          </>
        )}
      </div>
      <figure className="grid gap-2" data-testid="consumption-bar">
        <figcaption className="text-sm text-muted-foreground">Your whole subscription this week</figcaption>
        <div className="flex h-7 gap-0.5 overflow-hidden rounded-sm" role="img" aria-label={`This one ${pc(w?.ofTotal ?? 0)}, everything else ${pc(other)}, unused ${pc(free)}`}>
          {(w?.ofTotal ?? 0) > 0 && <span className="block h-full bg-[#2a78d6]" style={{ flex: w!.ofTotal }} title={`This one: ${pc(w!.ofTotal)}`} />}
          {other > 0 && <span className="block h-full bg-[#8b8478]" style={{ flex: other }} title={`Everything else: ${pc(other)}`} />}
          {free > 0 && <span className="block h-full bg-muted" style={{ flex: free }} title={`Unused: ${pc(free)}`} />}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <li><i className="mr-1.5 inline-block h-3 w-3 rounded-sm bg-[#2a78d6] align-[-1px]" />This one <b className="tabular-nums">{pc(w?.ofTotal ?? 0)}</b></li>
          <li><i className="mr-1.5 inline-block h-3 w-3 rounded-sm bg-[#8b8478] align-[-1px]" />Everything else <b className="tabular-nums">{pc(other)}</b></li>
          <li><i className="mr-1.5 inline-block h-3 w-3 rounded-sm bg-muted align-[-1px]" />Unused <b className="tabular-nums">{pc(free)}</b></li>
        </ul>
      </figure>
      {w && w.personas.length > 0 && (
        <div className="grid gap-1">
          <h3 className="text-base font-semibold">Which personas used it, and what they made true</h3>
          <ul className="rounded-xl border bg-card px-4" data-testid="consumption-personas">
            {w.personas.map((p) => (
              <PersonaRow key={p.persona} p={p} />
            ))}
          </ul>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Read {read(data.at)}. Each seat&rsquo;s weekly use, split over the runs it served by their metered tokens; a premium seat counts five standard. A thing made true is an outcome a run logged.{" "}
        {data.page && (
          <a className="underline" href={data.page} data-testid="consumption-page">
            Every objective side by side
          </a>
        )}
      </p>
    </section>
  );
}
