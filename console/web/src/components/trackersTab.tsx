import { api } from "@/api";
import type { CampaignTrackers, TrackerTable } from "@/api/totem-types";
import { ErrorBox, Loading } from "@/components/common";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { Fragment, useMemo, useState } from "react";
import { FoldChevron } from "@/components/foldChevron";

/**
 * The owner, 2026-11-18: "the wheel object can have several tracker
 * objects inside of it ... a table with entries and status and whatever quality you can have at columns ... these tables
 * I want them to be accessible at the wheel level. What are the tables this wheel has attached to that? ... some tables
 * we pre-load ... we have the influencer table. So it ships empty."
 * The owner 2026-11-18 20:26Z (vn_1df1364f): "the tracker tab should have tables, no bullshit ... Give me a flag so that
 * I can filter or wave one or whatever. Give me a filter ... Don't mess up the tracker, please."
 * The wheel's Trackers tab holds only its tables: each with a filter on any column's value and a sort on every column.
 * Who goes first is a plain column (Wave); a wave's messages live on their own page, never here.
 * The owner 2026-11-22 (vn_d99286a7): "I should be able to click on the trackers and see testers inside. So,
 * the testers are one of the trackers, and the trackers should be expandable." Each table opens folded (its name and
 * counts) and unfolds on a click; each entry unfolds on a click to every column it holds.
 */

function Cell({ v }: { v: string | undefined }) {
  return /^https?:\/\//.test(v ?? "") ? <a className="underline underline-offset-4" href={v} target="_blank" rel="noreferrer">link</a> : <>{v}</>;
}

/**
 * The owner 2026-11-18 (vn_7ae712dc): click a column to sort, a coloured status pill per row. Colour sits only on the
 * status cell; the rest stays ink and grey.
 */
// "for each one, we should have a color" (the owner, 25 Nov): an application's stage, granted green, applied blue,
// drafted amber (its filled form waits on his yes), refused red; to research stays grey.
const TONES: [RegExp, string][] = [
  [/^(agreed|done|yes|won|paying|live|granted)$/i, "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"],
  [/^(testing|trial|in test)$/i, "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300"],
  [/^(replied|answered|quoted|drafted)$/i, "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"],
  [/^(contacted|asked|sent|invited|applied)$/i, "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300"],
  [/^(declined|lost|no answer|refused)$/i, "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"],
];
export const pillTone = (v: string) => TONES.find(([re]) => re.test(v.trim()))?.[1] ?? "bg-muted text-muted-foreground";

function Pill({ v }: { v: string }) {
  return <span className={cn("inline-block whitespace-nowrap rounded-full px-2 py-px text-xs font-medium", pillTone(v))} data-testid="tracker-pill">{v}</span>;
}

/** a step done or not (the owner: "Is it green or not green?"): a green or a grey disc; a hollow ring when it cannot be read yet. */
export const isStep = (v: string | undefined) => v === "yes" || v === "no" || v === "not read yet";
function Dot({ col, v }: { col: string; v: string }) {
  return (
    <span className="inline-flex items-center" title={`${col}: ${v}`} data-testid="tracker-dot" data-v={v}>
      <span
        aria-hidden
        className={cn("inline-block size-2.5 rounded-full", v === "yes" ? "bg-emerald-500" : v === "no" ? "bg-muted-foreground/25" : "border border-muted-foreground/50")}
      />
      <span className="sr-only">{`${col}: ${v}`}</span>
    </span>
  );
}

/** a cell: the status as a pill, a step as a disc, the rest as text. */
function Value({ t, j, v }: { t: TrackerTable; j: number; v: string | undefined }) {
  if (v && t.columns[j] === "Status") return <Pill v={v} />;
  if (isStep(v)) return <Dot col={t.columns[j]} v={v!} />;
  return <Cell v={v} />;
}

/** an entry id that is an email address (the Testers and Applications trackers). */
export const isEmail = (v: string | undefined) => !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/** the column numbers on an entry's folded line: the table's `shown`, else every column. */
export function shownCols(t: Pick<TrackerTable, "columns" | "shown">): number[] {
  const idx = (t.shown ?? []).map((c) => t.columns.indexOf(c)).filter((j) => j >= 0);
  return idx.length ? idx : t.columns.map((_, j) => j);
}

/** an unfolded entry: every column it holds, as a label and its value. */
function Details({ t, r }: { t: TrackerTable; r: string[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" data-testid="tracker-detail">
      {t.columns.slice(1).map((h, k) =>
        r[k + 1] ? (
          <div key={h} className="grid min-w-0 grid-cols-[8.5rem_1fr] gap-x-2">
            <dt className="text-xs leading-5 text-muted-foreground">{h}</dt>
            <dd className="flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
              <Value t={t} j={k + 1} v={r[k + 1]} />
              {isStep(r[k + 1]) && <span className="text-muted-foreground">{r[k + 1]}</span>}
            </dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

const linkClick = (e: { target: EventTarget }) => !!(e.target as HTMLElement).closest?.("a");

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
 * The table's order. No sort chosen: as written. A column chosen: by that column (status in the table's status order,
 * sizes as numbers, empty cells last).
 */
export function sortRows(t: Pick<TrackerTable, "columns" | "statuses" | "rows">, sort: Sort): string[][] {
  if (!sort) return t.rows;
  const { col, dir } = sort;
  const isStatus = t.columns[col] === "Status";
  const key = (v: string): [number, number | string] => {
    if (!v) return [2, ""];
    if (isStatus) return [0, t.statuses.includes(v) ? t.statuses.indexOf(v) : 99];
    const n = sizeOf(v);
    return n === null ? [1, v.toLowerCase()] : [0, n];
  };
  return t.rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const [ga, ka] = key(a.r[col] ?? ""), [gb, kb] = key(b.r[col] ?? "");
      if (ga === 2 || gb === 2) return ga - gb || a.i - b.i; // empty cells last either way
      if (ga !== gb) return ga - gb; // sizes before words either way
      const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      return c * dir || a.i - b.i;
    })
    .map((x) => x.r);
}

/** a chosen value per column (EMPTY: the cell is blank). */
export type Filters = Record<string, string>;
export const EMPTY = "\u0000empty";

/**
 * The columns he can filter by a value: Wave and Status always (when the table has them), and every other column with a
 * few short values (Where, Kind, Sent ...). Each with its values and how many entries hold each, in the table's order.
 */
export function filterColumns(t: Pick<TrackerTable, "columns" | "statuses" | "rows">): { col: string; values: { v: string; n: number }[] }[] {
  return t.columns.flatMap((col, j) => {
    if (j === 0) return [];
    const by = new Map<string, number>();
    for (const r of t.rows) by.set(r[j] ?? "", (by.get(r[j] ?? "") ?? 0) + 1);
    const vals = [...by.keys()];
    const always = col === "Status" || col === "Wave";
    const filled = vals.filter(Boolean);
    const unique = filled.length >= 3 && filled.every((v) => by.get(v) === 1); // one entry per value: a free-text column
    if (!always && (by.size < 2 || by.size > 12 || unique || vals.some((v) => v.length > 40 || /^https?:\/\//.test(v)))) return [];
    const rank = (v: string) => (v === "" ? 1e4 : col === "Status" && t.statuses.includes(v) ? t.statuses.indexOf(v) : 100);
    const values = vals
      .sort((a, b) => rank(a) - rank(b) || (sizeOf(a) ?? Infinity) - (sizeOf(b) ?? Infinity) || a.localeCompare(b))
      .map((v) => ({ v: v === "" ? EMPTY : v, n: by.get(v)! }));
    return [{ col, values }];
  });
}

/** the rows that hold every chosen value, and the search words anywhere in the row. */
export function filterRows(t: Pick<TrackerTable, "columns" | "rows">, f: Filters, q = ""): string[][] {
  const on = Object.entries(f).filter(([c, v]) => v && t.columns.includes(c));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return t.rows.filter(
    (r) =>
      on.every(([c, v]) => (r[t.columns.indexOf(c)] ?? "") === (v === EMPTY ? "" : v)) &&
      words.every((w) => r.some((x) => x.toLowerCase().includes(w))),
  );
}

/** a link's ?tracker=<id> opens that table unfolded (every table opens folded otherwise). */
export function unfoldFromSearch(search: string): string[] {
  return new URLSearchParams(search).getAll("tracker");
}

/** a link's filters: ?filter=Wave:1&filter=Status:candidate opens the tab already filtered. */
export function filtersFromSearch(search: string): Filters {
  const out: Filters = {};
  for (const x of new URLSearchParams(search).getAll("filter")) {
    const i = x.indexOf(":");
    if (i > 0) out[x.slice(0, i)] = x.slice(i + 1) || EMPTY;
  }
  return out;
}

/** On a phone each entry is one stacked block (its name, then each column as a label and value), never a squeezed table. */
function Entries({ t, rows }: { t: TrackerTable; rows: string[][] }) {
  return (
    <ul className="grid sm:hidden" data-testid="tracker-entries">
      {rows.map((r, i) => (
        <Entry key={`${r[0]}-${i}`} t={t} r={r} />
      ))}
    </ul>
  );
}

/** a phone entry: folded, its name, status and steps as discs; unfolded, every column. */
function Entry({ t, r }: { t: TrackerTable; r: string[] }) {
  const [open, setOpen] = useState(false);
  const si = t.columns.indexOf("Status");
  const folded = t.shown ? shownCols(t).slice(1).filter((j) => j !== si) : [];
  const steps = folded.filter((j) => isStep(r[j]));
  const words = folded.filter((j) => r[j] && !isStep(r[j]));
  return (
    <li className="border-b text-sm last:border-0" data-testid="tracker-row" data-open={open}>
      <button type="button" className="grid w-full gap-1 py-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="flex min-w-0 items-start gap-1.5">
          <FoldChevron open={open} className="mt-[3px]" />
          <span className="min-w-0 flex-1 font-medium text-foreground [overflow-wrap:anywhere]" data-testid="tracker-id">{r[0]}</span>
          {si >= 0 && r[si] && <Pill v={r[si]} />}
        </span>
        {(steps.length > 0 || words.length > 0) && (
          <span className="grid gap-1 pl-[1.375rem]">
            {steps.length > 0 && (
              <span className="flex flex-wrap gap-1.5">
                {steps.map((j) => <Dot key={j} col={t.columns[j]} v={r[j]} />)}
              </span>
            )}
            {words.map((j) => (
              <span key={j} className="text-muted-foreground [overflow-wrap:anywhere]">{r[j]}</span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="pb-3 pl-[1.375rem]">
          <Details t={t} r={r} />
        </div>
      )}
    </li>
  );
}

/** a laptop entry: one line of its shown columns; a click unfolds every column under it. */
function Row({ t, r, cols }: { t: TrackerTable; r: string[]; cols: number[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <tr
        className={cn("cursor-pointer align-top hover:bg-muted/40", !open && "border-b last:border-0")}
        onClick={(e) => !linkClick(e) && setOpen(!open)}
        data-testid="tracker-row"
        data-open={open}
      >
        {cols.map((j, k) => (
          <td key={j} className={cn("py-1.5 pr-3", isStep(r[j]) ? "text-center" : "min-w-[9rem] [overflow-wrap:break-word]", k === 0 && "min-w-[10rem] font-medium text-foreground")}>
            {k === 0 ? (
              <button type="button" className="inline-flex items-start gap-1 text-left" aria-expanded={open} onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
                <FoldChevron open={open} className="mt-[3px]" />
                {/* an email id stays whole on one line, never cut (the table scrolls sideways if it must) */}
                <span className={cn(isEmail(r[j]) && "whitespace-nowrap")} data-testid="tracker-id">{r[j]}</span>
              </button>
            ) : (
              <Value t={t} j={j} v={r[j]} />
            )}
          </td>
        ))}
      </tr>
      {open && (
        <tr className="border-b bg-muted/30">
          <td colSpan={cols.length} className="px-3 py-2">
            <Details t={t} r={r} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function SortHead({ t, cols, sort, setSort }: { t: TrackerTable; cols: number[]; sort: Sort; setSort: (s: Sort) => void }) {
  const steps = new Set(cols.filter((j) => t.rows.length > 0 && t.rows.every((r) => !r[j] || isStep(r[j]))));
  return (
    <tr className="border-b text-left text-xs text-muted-foreground">
      {cols.map((j) => {
        const h = t.columns[j];
        const on = sort?.col === j;
        return (
          <th key={h} className={cn("py-1 pr-3 font-normal", steps.has(j) ? "w-20 text-center leading-tight" : "whitespace-nowrap")} aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}>
            <button
              type="button"
              className={cn("inline-flex items-center gap-1 rounded py-0.5 hover:text-foreground", on && "font-medium text-foreground")}
              onClick={() => setSort(on ? (sort!.dir === 1 ? { col: j, dir: -1 } : null) : { col: j, dir: 1 })}
              data-testid="tracker-sort"
              title={`Sort by ${h}`}
            >
              {h}
              <span aria-hidden className={cn("w-2", !on && "opacity-0")}>{on && sort!.dir === -1 ? "↓" : "↑"}</span>
            </button>
          </th>
        );
      })}
    </tr>
  );
}

function FilterBar({ t, f, setF, q, setQ }: { t: TrackerTable; f: Filters; setF: (f: Filters) => void; q: string; setQ: (q: string) => void }) {
  const cols = useMemo(() => filterColumns(t), [t]);
  const any = Object.values(f).some(Boolean) || !!q;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="tracker-filters">
      {cols.map(({ col, values }) => (
        <select
          key={col}
          aria-label={`Filter by ${col}`}
          className={cn("min-w-0 max-w-full rounded-md border bg-card px-2 py-1", f[col] ? "border-foreground text-foreground" : "text-muted-foreground")}
          value={f[col] ?? ""}
          onChange={(e) => setF({ ...f, [col]: e.target.value })}
          data-testid="tracker-filter"
          data-col={col}
        >
          <option value="">{col}: all</option>
          {values.map(({ v, n }) => (
            <option key={v} value={v}>
              {col}: {v === EMPTY ? "empty" : v} ({n})
            </option>
          ))}
        </select>
      ))}
      <input
        type="search"
        aria-label="Search this table"
        placeholder="Search"
        className="min-w-0 flex-1 basis-32 rounded-md border bg-card px-2 py-1 text-foreground placeholder:text-muted-foreground"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        data-testid="tracker-search"
      />
      {any && (
        <button type="button" className="rounded-md px-2 py-1 text-muted-foreground underline underline-offset-4 hover:text-foreground" onClick={() => (setF({}), setQ(""))} data-testid="tracker-clear">
          Clear
        </button>
      )}
    </div>
  );
}

function Table({ t, initial, unfold }: { t: TrackerTable; initial: Filters; unfold: boolean }) {
  const [open, setOpen] = useState(unfold || Object.keys(initial).some((c) => t.columns.includes(c)));
  const cols = useMemo(() => shownCols(t), [t]);
  const [sort, setSort] = useState<Sort>(null);
  const [f, setF] = useState<Filters>(() => Object.fromEntries(Object.entries(initial).filter(([c]) => t.columns.includes(c))));
  const [q, setQ] = useState("");
  const shown = useMemo(() => filterRows(t, f, q), [t, f, q]);
  const rows = useMemo(() => sortRows({ ...t, rows: shown }, sort), [t, shown, sort]);
  const n = t.rows.length;
  // entries kept on the table but out of its count (the team's own test sign-ups), said in plain words.
  const off = (t.uncounted ?? []).reduce((k, c) => k + c.n, 0);
  return (
    <section className="grid min-w-0 gap-2 rounded-xl border bg-card p-3" data-testid="tracker" data-tracker={t.id} data-rows={n} data-shown={rows.length} data-open={open}>
      <button type="button" className="flex min-w-0 items-start gap-1.5 text-left" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="tracker-toggle">
        <FoldChevron open={open} className="mt-[3px]" />
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h3 className="text-[15px] font-medium text-foreground">{t.name}</h3>
          <span className="text-xs tabular-nums text-muted-foreground" data-testid="tracker-count">
            {rows.length === n ? `${n - off} ${n - off === 1 ? "entry" : "entries"}` : `${rows.length} of ${n} entries`}
            {!open && t.counts.length > 0 && `: ${t.counts.map((c) => `${c.n} ${c.status}`).join(", ")}`}
            {off > 0 && <span data-testid="tracker-uncounted">{`, plus ${off} not counted: ${t.uncounted!.map((c) => `${c.n} ${c.status}`).join(", ")}`}</span>}
          </span>
        </span>
      </button>
      {!open ? null : !t.open ? (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="tracker-asked">
          Asked for by the team, waiting for your yes. Columns: {t.columns.join(", ")}.
        </div>
      ) : !n ? (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="tracker-empty">
          Empty. Columns: {t.columns.join(", ")}.
        </div>
      ) : (
        <>
          <FilterBar t={t} f={f} setF={setF} q={q} setQ={setQ} />
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
              <option value="">As written</option>
              {t.columns.flatMap((h, j) => [
                <option key={`${j}a`} value={`${j}:1`}>{h}, up</option>,
                <option key={`${j}d`} value={`${j}:-1`}>{h}, down</option>,
              ])}
            </select>
          </label>
          {!rows.length ? (
            <p className="py-2 text-sm text-muted-foreground" data-testid="tracker-none">No entry matches this filter.</p>
          ) : (
            <>
              <Entries t={t} rows={rows} />
              <div className="hidden min-w-0 overflow-x-auto sm:block">
                <table className="w-full text-sm">
                  <thead>
                    <SortHead t={t} cols={cols} sort={sort} setSort={setSort} />
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <Row key={`${r[0]}-${i}`} t={t} r={r} cols={cols} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** how any wheel gets a table: asked for by the team, opened by his yes. */
export function addLine(tables: number) {
  return `${tables ? "Another table for this life cycle" : "This life cycle has no tables yet. A table"} is asked for by the team when its work needs one, and opens with your yes.`;
}

export function TrackersTab({ wheel }: { wheel: string }) {
  const { data, error, loading } = useQuery(() => api.getTrackers(wheel), [wheel]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  return (
    <section className="grid min-w-0 gap-3" data-testid="trackers-tab" data-wheel={wheel} data-tables={data.tables.length}>
      <WheelTables tables={data.tables} />
      {/* The owner 2026-11-20 (vn_578b0feb): "I remember recommending having a table capability in
          every wheel." Any wheel can hold tables; nothing is pre-made beyond what he named. */}
      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="trackers-add">
        {addLine(data.tables.length)}
      </p>
    </section>
  );
}

/** a wheel's tables, each folded, with the ?filter / ?open the link carries. */
function WheelTables({ tables }: { tables: TrackerTable[] }) {
  const search = typeof window === "undefined" ? "" : window.location.search;
  const initial = useMemo(() => filtersFromSearch(search), [search]);
  const unfold = useMemo(() => unfoldFromSearch(search), [search]);
  return (
    <>
      {tables.map((t) => (
        <Table key={t.id} t={t} initial={initial} unfold={unfold.includes(t.id)} />
      ))}
    </>
  );
}

/**
 * The owner 22 Nov: "why don't we have a tracker? We need a tracker, man.
 * Trackers are everywhere". A campaign's Trackers tab, the same tables as the Trackers tab of the objective it serves,
 * read from that wheel (server campaignTrackers.ts); each group names its objective.
 */
export function CampaignTrackersTab({ load }: { load: () => Promise<CampaignTrackers> }) {
  const { data, error, loading } = useQuery(load, [load]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  const n = data.wheels.reduce((k, w) => k + w.tables.length, 0);
  return (
    <section className="grid min-w-0 gap-3" data-testid="trackers-tab" data-tables={n}>
      {data.wheels.map((w) => (
        <div key={w.wheel} className="grid min-w-0 gap-2" data-testid="campaign-trackers-wheel" data-wheel={w.wheel}>
          <p className="text-sm text-muted-foreground">
            The shortlists of <span className="font-medium text-foreground">{w.name}</span>
          </p>
          <WheelTables tables={w.tables} />
        </div>
      ))}
      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="trackers-add">
        {n ? "Another table" : "This campaign's objective has no shortlist yet. A table"} is asked for by the team when its work needs one, and opens with your yes.
      </p>
    </section>
  );
}
