import { api } from "@/api";
import type { TrackerTable, WheelTrackers } from "@/api/totem-types";
import { ErrorBox, Loading } from "@/components/common";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";

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

/**
 * The owner 2026-11-18 (vn_7ae712dc): click a column to sort, a coloured status pill per row, one clear column
 * "proposed for first message: yes or no". Colour sits only on these two data cells; the rest stays ink and grey.
 */
const TONES: [RegExp, string][] = [
  [/^(agreed|done|yes|won|paying|live)$/i, "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"],
  [/^(testing|trial|in test)$/i, "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300"],
  [/^(replied|answered|quoted)$/i, "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"],
  [/^(contacted|asked|sent|invited)$/i, "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300"],
  [/^(declined|lost|no answer|refused)$/i, "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"],
];
export const pillTone = (v: string) => TONES.find(([re]) => re.test(v.trim()))?.[1] ?? "bg-muted text-muted-foreground";

function Pill({ v }: { v: string }) {
  return <span className={cn("inline-block whitespace-nowrap rounded-full px-2 py-px text-xs font-medium", pillTone(v))} data-testid="tracker-pill">{v}</span>;
}

/** a cell: the status and the first-message yes as pills (a plain grey "no"), the rest as text. */
function Value({ t, j, v }: { t: TrackerTable; j: number; v: string | undefined }) {
  const h = t.columns[j];
  if (v && h === "Status") return <Pill v={v} />;
  if (v && h === t.first) return v.toLowerCase() === "yes" ? <Pill v="yes" /> : <span className="text-muted-foreground">{v}</span>;
  return <Cell v={v} />;
}

/** a number at the start of a cell ("33.6K subscribers", "1.2M"), else null: so Audience sorts by size. */
export function sizeOf(v: string): number | null {
  const m = /^\s*([\d.,]+)\s*([kKmM])?\b/.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  return n * (m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1);
}

export type Sort = { col: number; dir: 1 | -1 } | null;

/**
 * The table's order. No sort chosen: the first-message yes entries on top (wave 1), then the rest, each as written.
 * A column chosen: by that column (status in the table's status order, sizes as numbers, empty cells last).
 */
export function sortRows(t: Pick<TrackerTable, "columns" | "statuses" | "rows" | "first">, sort: Sort): string[][] {
  const fi = t.first ? t.columns.indexOf(t.first) : -1;
  const yes = (r: string[]) => (fi >= 0 && (r[fi] ?? "").toLowerCase() === "yes" ? 0 : 1);
  const idx = t.rows.map((r, i) => ({ r, i }));
  if (!sort) return idx.sort((a, b) => yes(a.r) - yes(b.r) || a.i - b.i).map((x) => x.r);
  const { col, dir } = sort;
  const isStatus = t.columns[col] === "Status";
  const key = (v: string): [number, number | string] => {
    if (!v) return [2, ""];
    if (col === fi) return [0, v.toLowerCase() === "yes" ? 0 : 1];
    if (isStatus) return [0, t.statuses.includes(v) ? t.statuses.indexOf(v) : 99];
    const n = sizeOf(v);
    return n === null ? [1, v.toLowerCase()] : [0, n];
  };
  return idx
    .sort((a, b) => {
      const [ga, ka] = key(a.r[col] ?? ""), [gb, kb] = key(b.r[col] ?? "");
      if (ga === 2 || gb === 2) return ga - gb || a.i - b.i; // empty cells last either way
      if (ga !== gb) return (ga - gb) * dir;
      const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      return c * dir || a.i - b.i;
    })
    .map((x) => x.r);
}

/** On a phone each entry is one stacked block (its name, then each column as a label and value), never a squeezed table. */
function Entries({ t, rows }: { t: TrackerTable; rows: string[][] }) {
  return (
    <ul className="grid gap-2 sm:hidden" data-testid="tracker-entries">
      {rows.map((r, i) => (
        <li key={i} className="grid gap-1 border-b pb-2 text-sm last:border-0">
          <p className="font-medium text-foreground">{r[0]}</p>
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5">
            {t.columns.slice(1).map((h, j) => (r[j + 1] ? [
              <dt key={`h${j}`} className="text-xs leading-5 text-muted-foreground">{h === t.first ? "First message" : h}</dt>,
              <dd key={`v${j}`} className="min-w-0 [overflow-wrap:anywhere]"><Value t={t} j={j + 1} v={r[j + 1]} /></dd>,
            ] : null))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

/** a message's text with its {placeholders} marked: one still missing (like the apply link) says so in plain words. */
function MessageText({ text, missing }: { text: string; missing: string[] }) {
  return (
    <div className="grid gap-2 text-sm leading-6 text-foreground" data-testid="wave-text">
      {text.split(/\n\n+/).map((para, k) => (
          <p key={k}>
            {para.split(/(\{[^}]+\})/g).map((x, i) =>
              /^\{[^}]+\}$/.test(x) ? (
                missing.some((m) => m.startsWith(x)) ? (
                  <span key={i} className="rounded bg-rose-100 px-1 font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-300" data-testid="wave-missing">
                    {x.slice(1, -1)}: missing
                  </span>
                ) : (
                  <span key={i} className="rounded bg-muted px-1 text-muted-foreground">{x.slice(1, -1)}</span>
                )
              ) : (
                <span key={i}>{x}</span>
              ),
            )}
          </p>
      ))}
    </div>
  );
}

/**
 * The owner 2026-11-18 (vn_741d8adb): "Where are the 10 ones that got selected? ... I don't see
 * what message we're sending them ... what is the wave 1 message?" One box above the table: who gets which message, the
 * messages whole, what is still missing.
 */
export function WaveBox({ wave }: { wave: NonNullable<TrackerTable["wave"]> }) {
  const n = wave.messages.reduce((k, m) => k + m.who.length, 0);
  return (
    <div className="grid gap-3 rounded-lg border p-3" data-testid="tracker-wave" data-people={n}>
      <p className="text-[15px] font-semibold text-foreground">
        {wave.name}: {n} {n === 1 ? "person" : "people"}, {wave.messages.length} {wave.messages.length === 1 ? "message" : "messages"}.{" "}
        <span className="font-normal text-muted-foreground">{wave.state}</span>
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {wave.messages.map((m) => (
          <section key={m.name} className="grid content-start gap-2 rounded-md bg-muted/40 p-3" data-testid="wave-message">
            <h4 className="text-sm font-semibold text-foreground">
              {m.name}
              {m.for && <span className="font-normal text-muted-foreground">, for {m.for}</span>}
            </h4>
            <ol className="flex flex-wrap gap-1.5" data-testid="wave-who">
              {m.who.map((w) => (
                <li key={w} className="rounded-full border bg-card px-2 py-0.5 text-xs text-foreground">{w}</li>
              ))}
            </ol>
            <MessageText text={m.text} missing={wave.missing} />
          </section>
        ))}
      </div>
      {(wave.missing.length > 0 || wave.fill) && (
        <ul className="grid gap-0.5 text-sm text-muted-foreground">
          {wave.missing.map((m) => (
            <li key={m}>Missing: {m.replace(/^\{[^}]+\}:\s*/, "")}</li>
          ))}
          {wave.fill && <li>{wave.fill.replace(/\{([^}]+)\}/g, "$1")}</li>}
        </ul>
      )}
    </div>
  );
}

function SortHead({ t, sort, setSort }: { t: TrackerTable; sort: Sort; setSort: (s: Sort) => void }) {
  return (
    <tr className="border-b text-left text-xs text-muted-foreground">
      {t.columns.map((h, j) => {
        const on = sort?.col === j;
        return (
          <th key={h} className="whitespace-nowrap py-1 pr-3 font-normal" aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}>
            <button
              type="button"
              className={cn("inline-flex items-center gap-1 rounded py-0.5 hover:text-foreground", on && "font-medium text-foreground")}
              onClick={() => setSort(on ? (sort!.dir === 1 ? { col: j, dir: -1 } : null) : { col: j, dir: 1 })}
              data-testid="tracker-sort"
              title={`Sort by ${h}`}
            >
              {h === t.first ? "First message" : h}
              <span aria-hidden className={cn("w-2", !on && "opacity-0")}>{on && sort!.dir === -1 ? "↓" : "↑"}</span>
            </button>
          </th>
        );
      })}
    </tr>
  );
}

function Table({ t }: { t: TrackerTable }) {
  const [sort, setSort] = useState<Sort>(null);
  const rows = useMemo(() => sortRows(t, sort), [t, sort]);
  const fi = t.first ? t.columns.indexOf(t.first) : -1;
  const nYes = fi < 0 ? 0 : t.rows.filter((r) => (r[fi] ?? "").toLowerCase() === "yes").length;
  return (
    <section className="grid min-w-0 gap-2 rounded-xl border bg-card p-3" data-testid="tracker" data-tracker={t.id} data-rows={t.rows.length}>
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-[15px] font-medium text-foreground">{t.name}</h3>
        <span className="text-xs text-muted-foreground">
          {FROM[t.from]} · {t.rows.length} {t.rows.length === 1 ? "entry" : "entries"}
          {nYes > 0 && ` · ${nYes} proposed for the first message`}
        </span>
      </header>
      {t.wave && <WaveBox wave={t.wave} />}
      {t.for && <p className="text-sm text-muted-foreground">For {t.for}.</p>}
      {t.counts.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="tracker-counts">
          {t.counts.map((c) => (
            <span key={c.status} className="inline-flex items-center gap-1">
              <span className="font-semibold tabular-nums text-foreground">{c.n}</span> <Pill v={c.status} />
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
          <label className="flex items-center gap-2 text-sm text-muted-foreground sm:hidden">
            Sort by
            <select
              className="min-w-0 flex-1 rounded-md border bg-card px-2 py-1 text-foreground"
              value={sort ? `${sort.col}:${sort.dir}` : ""}
              onChange={(e) => {
                const [c, d] = e.target.value.split(":").map(Number);
                setSort(e.target.value ? { col: c, dir: d as 1 | -1 } : null);
              }}
              data-testid="tracker-sort-select"
            >
              <option value="">{nYes ? "First message on top" : "As written"}</option>
              {t.columns.flatMap((h, j) => [
                <option key={`${j}a`} value={`${j}:1`}>{h === t.first ? "First message" : h}, up</option>,
                <option key={`${j}d`} value={`${j}:-1`}>{h === t.first ? "First message" : h}, down</option>,
              ])}
            </select>
          </label>
          <Entries t={t} rows={rows} />
          <div className="hidden min-w-0 overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead>
                <SortHead t={t} sort={sort} setSort={setSort} />
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={cn("border-b align-top last:border-0", fi >= 0 && (r[fi] ?? "").toLowerCase() === "yes" && "bg-muted/40")} data-first={fi >= 0 ? r[fi] : undefined}>
                    {t.columns.map((_, j) => (
                      <td key={j} className={cn("py-1.5 pr-3 [overflow-wrap:anywhere]", j === 0 && "min-w-[8rem] font-medium text-foreground")}><Value t={t} j={j} v={r[j]} /></td>
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
