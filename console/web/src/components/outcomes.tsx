import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { OutcomeDefinition, OutcomeFilter, OutcomeLine, OutcomesBody } from "@/api/outcome-types";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { OUTCOMES_PATH } from "@/lib/routePaths";
export { OUTCOMES_PATH };

/**
 * The outcome log (the owner's voice note asking each persona to log what it got done): every persona and worker ends its wake by logging
 * what it actually got done, one line per outcome (delivered, learning added, merged, folded, superseded …).
 * The lines live in the repos (docs/outcomes/<day>.jsonl, root L-45); GET /api/outcomes reads them back. The page
 * opens with its answer in a punchline box (the shared page shell's shape: ink border, one deep-green bar, kept in the
 * app's own face, docs/design/console.md), then the count per kind as boxes (root L-59), then the filters and the lines,
 * PAGE at a time so the page ends cleanly on a phone (the card check, rule 4).
 */
const FILTERS = ["day", "persona", "product", "kind"] as const;

/** the kinds in the order they matter to him. */
const KIND_WORD: Record<string, string> = {
  delivered: "Delivered",
  learning: "Learning added",
  merged: "Merged",
  folded: "Folded",
  superseded: "Superseded",
  released: "Released",
  fixed: "Fixed",
  asked: "Asked you",
  other: "Other",
};
const kindWord = (k: string) => KIND_WORD[k] ?? k;

/** lines shown at first and per "Show more". */
export const PAGE = 25;
/** the cap a run summary was cut at when it was written into the log afterwards (scripts/outcome_log.py). */
const CUT_AT = 400;

/** a line that was cut mid-word ends at its last whole word with an ellipsis, so nothing reads as broken off. */
export function tidyText(text: string): string {
  const t = text.trim();
  if (t.length < CUT_AT - 10 || /[.!?)\]"”]$/.test(t)) return t;
  const end = t.lastIndexOf(" ");
  return `${(end > 0 ? t.slice(0, end) : t).replace(/[\s,;:–—-]+$/, "")}…`;
}

export function filterOf(p: URLSearchParams): OutcomeFilter {
  const f: OutcomeFilter = {};
  for (const k of [...FILTERS, "row", "repo"] as const) {
    const v = p.get(k);
    if (v) f[k] = v;
  }
  return f;
}

/** "14 outcomes on 2026-11-12 from 5 personas: 9 delivered, 2 learnings added." */
export function punchline(d: OutcomesBody, f: OutcomeFilter): string {
  const n = d.outcomes.length;
  const where = [f.day ? `on ${f.day}` : "", f.persona ? `by ${f.persona}` : "", f.product ? `in ${f.product}` : "", f.row ? `for ${f.row}` : ""].filter(Boolean).join(" ");
  if (!n) return `No outcome logged${where ? ` ${where}` : ""} yet.`;
  const personas = new Set(d.outcomes.map((o) => o.persona)).size;
  const top = Object.entries(d.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, c]) => `${c} ${kindWord(k).toLowerCase()}`);
  return `${n} outcome${n === 1 ? "" : "s"}${where ? ` ${where}` : ""} from ${personas} persona${personas === 1 ? "" : "s"}: ${top.join(", ")}.`;
}

function KindBoxes({ d, f, set }: { d: OutcomesBody; f: OutcomeFilter; set: (k: string, v: string | undefined) => void }) {
  const kinds = d.kinds.filter((k) => d.counts[k] || k === "delivered" || k === "learning");
  return (
    <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label="Outcomes by kind" data-testid="outcomes-kinds">
      {kinds.map((k) => {
        const n = d.counts[k] ?? 0;
        const on = f.kind === k;
        return (
          <li key={k}>
            <button
              type="button"
              onClick={() => set("kind", on ? undefined : k)}
              aria-pressed={on}
              data-testid="outcomes-kind"
              data-kind={k}
              className={cn(
                "flex min-h-11 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left sm:min-h-0",
                n ? "border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/30" : "border-border",
                on && "ring-2 ring-emerald-700",
              )}
            >
              <span className="text-sm text-foreground">{kindWord(k)}</span>
              <span className={cn("text-lg font-semibold tabular-nums", n ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>{n}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const linkCls = "text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground";
const LABEL: Record<(typeof FILTERS)[number], string> = { day: "Day", persona: "Persona", product: "Product", kind: "Kind" };

function Filters({ d, f, set }: { d: OutcomesBody; f: OutcomeFilter; set: (k: string, v: string | undefined) => void }) {
  return (
    <div className="grid grid-cols-2 items-end gap-x-3 gap-y-3 sm:flex sm:flex-wrap sm:gap-2" data-testid="outcomes-filters">
      {FILTERS.map((k) => (
        <label key={k} className="grid min-w-0 gap-0.5 text-xs text-muted-foreground">
          {LABEL[k]}
          <select
            className="h-11 w-full min-w-0 rounded-md border bg-background px-2 text-base text-foreground sm:h-8 sm:w-auto sm:text-sm"
            value={f[k] ?? ""}
            onChange={(e) => set(k, e.target.value || undefined)}
            data-testid={`outcomes-filter-${k}`}
          >
            <option value="">All</option>
            {d.facets[k].map((v) => (
              <option key={v} value={v}>
                {k === "kind" ? kindWord(v) : v}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label className="col-span-2 grid min-w-0 gap-0.5 text-xs text-muted-foreground">
        Row
        <input
          className="h-11 w-full min-w-0 rounded-md border bg-background px-2 text-base text-foreground sm:h-8 sm:w-28 sm:text-sm"
          placeholder="row code"
          defaultValue={f.row ?? ""}
          onKeyDown={(e) => e.key === "Enter" && set("row", (e.target as HTMLInputElement).value.trim() || undefined)}
          onBlur={(e) => set("row", e.target.value.trim() || undefined)}
          data-testid="outcomes-filter-row"
        />
      </label>
    </div>
  );
}

/** the definition of one persona's outcomes (docs/outcomes/what-counts.json): what counts, what does not, one real example. */
function DefBox({ d }: { d: OutcomeDefinition }) {
  const ex = d.examples?.[0];
  return (
    <div className="grid gap-1.5 text-sm" data-testid="outcome-def" data-persona={d.persona}>
      <p className="text-foreground">
        <span className="font-medium text-emerald-700 dark:text-emerald-400">✓ Counts: </span>
        {d.counts}
      </p>
      <p className="text-foreground">
        <span className="font-medium text-muted-foreground">✗ Does not count: </span>
        {d.doesNot}
      </p>
      {ex && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Example: “{ex}”</p>}
    </div>
  );
}

/**
 * What each persona is held to, beside the persona filter: the chosen persona's definition in a box,
 * or, with no persona chosen, every persona's in a closed list (tap a name to filter by it).
 */
function Definitions({ d, f, set }: { d: OutcomesBody; f: OutcomeFilter; set: (k: string, v: string | undefined) => void }) {
  const defs = d.definitions;
  if (!defs?.personas.length) return null;
  const one = f.persona ? defs.personas.find((p) => p.persona.toLowerCase() === f.persona!.toLowerCase()) : undefined;
  if (one)
    return (
      <section className="grid gap-1.5 rounded-md border border-l-[6px] border-l-emerald-800 px-3 py-2 dark:border-l-emerald-500" aria-label={`What counts for ${one.persona}`} data-testid="outcomes-definition">
        <h2 className="text-sm font-semibold text-foreground">What counts as an outcome for {one.persona}</h2>
        <DefBox d={one} />
      </section>
    );
  return (
    <details className="rounded-md border px-3 py-2" data-testid="outcomes-definitions">
      <summary className="cursor-pointer text-sm font-medium text-foreground">What counts as an outcome, per persona ({defs.personas.length})</summary>
      <p className="mt-2 text-xs text-muted-foreground">{defs.rule}</p>
      <ul className="mt-2 grid gap-3">
        {defs.personas.map((p) => (
          <li key={p.persona} className="grid gap-1 border-t pt-2">
            <button type="button" onClick={() => set("persona", p.persona)} className={cn("w-fit text-left text-sm font-semibold", linkCls)}>
              {p.persona}
            </button>
            <DefBox d={p} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function Line({ o }: { o: OutcomeLine }) {
  return (
    <li className="grid gap-1 rounded-md border px-3 py-2" data-testid="outcome" data-kind={o.kind} data-row={o.row ?? ""}>
      <div className="flex min-w-0 flex-col-reverse gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{tidyText(o.text)}</span>
        <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-400">{kindWord(o.kind)}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>{o.at.slice(11, 16)}Z</span>
        <span className="text-foreground">{o.persona}</span>
        <span>{o.product}</span>
        {o.row && <span className="font-mono">{o.row}</span>}
        {o.goalRow && <span>turned green: {o.goalRow}</span>}
        {o.link && (
          <a href={o.link} target="_blank" rel="noreferrer" className={linkCls}>
            see it
          </a>
        )}
        {o.runId && (
          <Link to={`/runs/${o.runId}`} className={linkCls}>
            the run
          </Link>
        )}
        {o.source === "backfill" && <span title="Written afterwards from the run's summary">from its summary</span>}
      </div>
    </li>
  );
}

export function OutcomesPage() {
  const [params, setParams] = useSearchParams();
  const f = filterOf(params);
  const key = JSON.stringify(f);
  const { data, error, loading } = useQuery<OutcomesBody>(() => api.listOutcomes(f), [key], { tag: "inbox" });
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [key]);
  const set = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const rest = data ? data.outcomes.length - shown : 0;
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-3xl gap-4 pb-24" data-testid="outcomes-page">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Outcomes</h1>
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the outcome log…</div>}
      {error && <div className="text-sm text-destructive">Could not read the outcome log: {error.message}</div>}
      {data && (
        <>
          <p
            className="rounded-md border border-foreground/70 border-l-[6px] border-l-emerald-800 bg-card px-4 py-3 text-lg font-medium leading-snug text-foreground sm:text-xl dark:border-l-emerald-500"
            data-testid="outcomes-punchline"
          >
            {punchline(data, f)}
          </p>
          <section className="grid gap-2" aria-label="Count per kind" data-testid="outcomes-answer">
            <KindBoxes d={data} f={f} set={set} />
            <p className="text-xs text-muted-foreground">Every persona ends its wake by logging what it got done, one line each. Tap a kind to see only those.</p>
          </section>
          <Filters d={data} f={f} set={set} />
          <Definitions d={data} f={f} set={set} />
          {data.outcomes.length > 0 ? (
            <>
              <ul className="grid gap-2" data-testid="outcomes-list">
                {data.outcomes.slice(0, shown).map((o, i) => (
                  <Line key={`${o.runId ?? ""}-${o.at}-${i}`} o={o} />
                ))}
              </ul>
              {rest > 0 ? (
                <button
                  type="button"
                  onClick={() => setShown((n) => n + PAGE)}
                  className="h-11 w-full rounded-md border text-sm font-medium text-foreground hover:bg-muted"
                  data-testid="outcomes-more"
                >
                  Show {Math.min(rest, PAGE)} more of {rest}
                </button>
              ) : (
                <p className="text-center text-xs text-muted-foreground" data-testid="outcomes-end">
                  That is all {data.outcomes.length} for this filter.
                </p>
              )}
            </>
          ) : (
            <div className="rounded-md border px-3 py-3 text-sm text-muted-foreground" data-testid="outcomes-empty">
              Nothing logged for this filter.
            </div>
          )}
        </>
      )}
    </div>
  );
}
