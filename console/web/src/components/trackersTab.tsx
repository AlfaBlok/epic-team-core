import { api } from "@/api";
import type { TrackerTable, WheelTrackers } from "@/api/totem-types";
import { ErrorBox, Loading } from "@/components/common";
import { useQuery } from "@/lib/data";

/**
 * The owner, 2026-11-18: "the wheel object can have several tracker
 * objects inside of it ... a table with entries and status and whatever quality you can have at columns ... these tables
 * I want them to be accessible at the wheel level. What are the tables this wheel has attached to that? ... some tables
 * we pre-load ... we have the influencer table. So it ships empty."
 * The wheel's Trackers tab: the answer first (how many tables, how many entries), then each table, its counts by
 * status and its rows; an empty one says so, an asked-for one waits for his yes.
 */

const FROM: Record<TrackerTable["from"], string> = {
  frame: "Comes with every wheel",
  product: "Comes with this product",
  own: "Asked for on this wheel",
};

export function trackersAnswer(t: WheelTrackers): string {
  const entries = t.tables.reduce((n, x) => n + x.rows.length, 0);
  const empty = t.tables.filter((x) => x.open && !x.rows.length).map((x) => x.name);
  const waiting = t.tables.filter((x) => !x.open).length;
  const head = `${t.tables.length} ${t.tables.length === 1 ? "table" : "tables"}, ${entries} ${entries === 1 ? "entry" : "entries"}.`;
  return [head, empty.length ? `Still empty: ${empty.join(", ")}.` : "", waiting ? `${waiting} asked for, waiting for your yes.` : ""].filter(Boolean).join(" ");
}

function Cell({ v }: { v: string | undefined }) {
  return /^https?:\/\//.test(v ?? "") ? <a className="underline underline-offset-4" href={v} target="_blank" rel="noreferrer">link</a> : <>{v}</>;
}

/** On a phone each entry is one stacked block (its name, then each column as a label and value), never a squeezed table. */
function Entries({ t }: { t: TrackerTable }) {
  return (
    <ul className="grid gap-2 sm:hidden" data-testid="tracker-entries">
      {t.rows.map((r, i) => (
        <li key={i} className="grid gap-1 border-b pb-2 text-sm last:border-0">
          <p className="font-medium text-foreground">{r[0]}</p>
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5">
            {t.columns.slice(1).map((h, j) => (r[j + 1] ? [
              <dt key={`h${j}`} className="text-xs leading-5 text-muted-foreground">{h}</dt>,
              <dd key={`v${j}`} className="min-w-0 [overflow-wrap:anywhere]"><Cell v={r[j + 1]} /></dd>,
            ] : null))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

function Table({ t }: { t: TrackerTable }) {
  return (
    <section className="grid min-w-0 gap-2 rounded-xl border bg-card p-3" data-testid="tracker" data-tracker={t.id} data-rows={t.rows.length}>
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-[15px] font-medium text-foreground">{t.name}</h3>
        <span className="text-xs text-muted-foreground">
          {FROM[t.from]} · {t.rows.length} {t.rows.length === 1 ? "entry" : "entries"}
        </span>
      </header>
      {t.for && <p className="text-sm text-muted-foreground">For {t.for}.</p>}
      {t.counts.length > 0 && (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm" data-testid="tracker-counts">
          {t.counts.map((c) => (
            <span key={c.status}>
              <span className="font-semibold tabular-nums text-foreground">{c.n}</span> <span className="text-muted-foreground">{c.status}</span>
            </span>
          ))}
        </p>
      )}
      {!t.open ? (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="tracker-asked">
          Asked for by the team, waiting for your yes. Columns: {t.columns.join(", ")}.
        </div>
      ) : !t.rows.length ? (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="tracker-empty">
          Empty. When the team shortlists someone, it is written here. Columns: {t.columns.join(", ")}.
        </div>
      ) : (
        <>
        <Entries t={t} />
        <div className="hidden min-w-0 overflow-x-auto sm:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                {t.columns.map((h) => (
                  <th key={h} className="whitespace-nowrap py-1.5 pr-3 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r, i) => (
                <tr key={i} className="border-b align-top last:border-0">
                  {t.columns.map((_, j) => (
                    <td key={j} className="py-1.5 pr-3 [overflow-wrap:anywhere]"><Cell v={r[j]} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </section>
  );
}

export function TrackersTab({ wheel }: { wheel: string }) {
  const { data, error, loading } = useQuery(() => api.getTrackers(wheel), [wheel]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  return (
    <section className="grid min-w-0 gap-3" data-testid="trackers-tab" data-wheel={wheel} data-tables={data.tables.length}>
      <div className="grid gap-1 rounded-xl border border-l-[6px] bg-card p-3" style={{ borderLeftColor: "hsl(var(--foreground))" }} data-testid="trackers-answer">
        <p className="text-[15px] font-semibold text-foreground">{trackersAnswer(data)}</p>
        <p className="text-sm text-muted-foreground">This wheel's shortlists. The team writes only into these, and asks you before adding a new one.</p>
      </div>
      {data.tables.map((t) => (
        <Table key={t.id} t={t} />
      ))}
    </section>
  );
}
