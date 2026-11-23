import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search as SearchIcon, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ErrorBox, PageHeader } from "@/components/common";
import { keyResultsOf, STATE_FILL, STATUS_SAYS, useGoalSets } from "@/components/goalSets";
import { OBJECTIVE_SEARCH_MIN, searchObjectives, wordsOf } from "@/lib/objectiveSearch";
import type { ScorecardRowState } from "@/api/pursuit-types";

/** how many lines each group shows before "Show all" (a phone stays one short scroll). */
export const GROUP_SHOWN = 8;

/**
 * The owner (vn_de2da36f): one search across his objectives, their key results and the tickets under them.
 * The words live in the address (?q=), so a search can be linked and Back returns to it.
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");
  const q = useDeferredValue(text);
  const { data, error, loading } = useGoalSets();
  const result = useMemo(() => searchObjectives(data?.nodes, q, keyResultsOf), [data, q]);
  const on = wordsOf(q).join("").length >= OBJECTIVE_SEARCH_MIN;
  const type = (t: string) => {
    setText(t);
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (t.trim()) n.set("q", t);
      else n.delete("q");
      return n;
    }, { replace: true });
  };
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4" data-testid="objective-search">
      <PageHeader title="Search" description="Every objective, key result and ticket." />
      <div className="relative" role="search">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={text}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && type("")}
          placeholder="Search objectives, key results and tickets"
          aria-label="Search objectives, key results and tickets"
          autoComplete="off"
          autoFocus
          enterKeyHint="search"
          maxLength={100}
          className="h-11 pl-9 pr-10 text-base [&::-webkit-search-cancel-button]:hidden"
          data-testid="objective-search-input"
        />
        {text && (
          <button type="button" onClick={() => type("")} className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground" aria-label="Clear search" data-testid="objective-search-clear">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {error && <ErrorBox error={error} muted />}
      <p className="-mt-2 text-xs text-muted-foreground" aria-live="polite" data-testid="objective-search-line">
        {!on
          ? "Type a word: a product, a name, a ticket code."
          : loading && !data
            ? "Reading your objectives…"
            : result.total === 0
              ? `Nothing matches “${result.q}”.`
              : `${result.objectives.length} ${result.objectives.length === 1 ? "objective" : "objectives"} · ${result.keyResults.length} key ${result.keyResults.length === 1 ? "result" : "results"} · ${result.tickets.length} ${result.tickets.length === 1 ? "ticket" : "tickets"}`}
      </p>
      {on && (
        <>
          <Group title="Objectives" testId="objectives" items={result.objectives.map((o) => (
            <Hit key={o.id} href={o.href} state={o.state} testId="hit-objective" title={o.name} sub={[o.line, `${o.greens} of ${o.total} key results green`]} />
          ))} />
          <Group title="Key results" testId="key-results" items={result.keyResults.map((k) => (
            <Hit key={k.key} href={k.href} state={k.state} testId="hit-key-result" title={k.label} sub={[`${STATUS_SAYS[k.state]}${k.value ? `: ${k.value}` : ""}${k.target ? ` of ${k.target}` : ""}`, k.objective]} />
          ))} />
          <Group title="Tickets" testId="tickets" items={result.tickets.map((t) => (
            <Hit key={t.key} href={t.href} state={t.state} testId="hit-ticket" code={t.code} title={t.title ?? t.code} sub={[t.status, t.keyResult ? `${t.objective} · ${t.keyResult}` : `${t.objective} · under no key result yet`]} />
          ))} />
        </>
      )}
    </div>
  );
}

function Group({ title, items, testId }: { title: string; items: ReactNode[]; testId: string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, GROUP_SHOWN);
  return (
    <section className="grid gap-1.5" data-testid={`search-group-${testId}`}>
      <h2 className="flex items-baseline gap-2 text-sm font-medium text-muted-foreground">
        {title}
        <span className="tabular-nums">{items.length}</span>
      </h2>
      <ul className="overflow-hidden rounded-xl border bg-card">{shown}</ul>
      {items.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="min-h-11 justify-self-start text-sm text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground" data-testid={`search-more-${testId}`}>
          Show all {items.length}
        </button>
      )}
    </section>
  );
}

function Hit({ href, state, title, sub, code, testId }: { href: string; state: ScorecardRowState; title: string; sub: (string | undefined)[]; code?: string; testId: string }) {
  const lines = sub.filter(Boolean) as string[];
  return (
    <li className="border-b last:border-b-0">
      <Link to={href} className="no-link-look grid min-h-12 grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-3 py-2.5 hover:bg-accent/40" data-testid={testId} data-state={state}>
        <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATE_FILL[state] }} aria-label={STATUS_SAYS[state]} role="img" />
        <span className="min-w-0">
          <span className="block text-[15px] leading-snug text-foreground [overflow-wrap:anywhere]">
            {code && <code className="mr-1.5 text-xs text-muted-foreground">{code}</code>}
            {title}
          </span>
          {lines.map((l, i) => (
            <span key={i} className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {l}
            </span>
          ))}
        </span>
      </Link>
    </li>
  );
}
