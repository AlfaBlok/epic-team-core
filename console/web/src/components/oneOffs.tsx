import { Fragment } from "react";
import { ArrowRight, Mic } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/api";
import type { OneOff, OneOffStage, OneOffsBody } from "@/api/oneoff-types";
import { PURSUITS_PATH } from "@/components/pursuits";
import { deckHref } from "@/lib/deck";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { ONE_OFFS_PATH } from "@/lib/routePaths";
export { ONE_OFFS_PATH };

/**
^ * One-offs (the owner's 2026-11-12 20:18Z voice note): single jobs that belong to no pursuit, still run from
 * his voice note to delivered. A one-off is a spine row titled `One-off:` (in the epic it naturally sits in, or in
 * docs/spines/one-offs.md when none fits); GET /api/one-offs reads them (server/src/oneOffs.ts). The page opens with
 * its answer and the lifecycle as boxes (root L-59), then each one-off with its stage, its epic, its card and its note.
 */

export function useOneOffs() {
  return useQuery<OneOffsBody>(() => api.listOneOffs(), [], { tag: "inbox" });
}

/** the lifecycle, left to right; "stuck" is shown inside In work. */
const STEPS: { stage: OneOffStage | "note"; label: string; says: string }[] = [
  { stage: "note", label: "Your voice note", says: "you ask" },
  { stage: "filed", label: "Filed", says: "a row, ready" },
  { stage: "in work", label: "In work", says: "a worker on it" },
  { stage: "your card", label: "Your card", says: "you judge it" },
  { stage: "delivered", label: "Delivered", says: "then it drops off" },
];

const STAGE_WORD: Record<OneOffStage, string> = {
  filed: "filed",
  "in work": "in work",
  stuck: "stuck",
  "your card": "your card",
  delivered: "delivered",
  parked: "parked",
};

/** "2 one-offs open: 1 in work, 1 waiting on your card." */
export function punchline(d: OneOffsBody): string {
  const open = d.oneOffs.filter((o) => o.stage !== "delivered" && o.stage !== "parked").length;
  if (!open) return d.counts.delivered ? `No one-off open. ${d.counts.delivered} delivered this week.` : "No one-off open.";
  const parts = [
    d.counts["your card"] && `${d.counts["your card"]} waiting on your card`,
    d.counts.stuck && `${d.counts.stuck} stuck`,
    d.counts["in work"] && `${d.counts["in work"]} in work`,
    d.counts.filed && `${d.counts.filed} filed, not started`,
  ].filter(Boolean);
  return `${open} one-off${open === 1 ? "" : "s"} open: ${parts.join(", ")}.`;
}

/** The lifecycle as ONE line of five numbered boxes with arrows on every width (root L-59 rule 2: a sequence is one line), each with its words and count. */
export function Lifecycle({ d }: { d: OneOffsBody }) {
  const count = (s: OneOffStage | "note") => (s === "note" ? undefined : d.counts[s as OneOffStage] + (s === "in work" ? d.counts.stuck : 0));
  return (
    <ol className="-mx-1 flex flex-row items-start sm:mx-0 sm:items-stretch sm:gap-1.5" aria-label="From your voice note to delivered" data-testid="one-offs-lifecycle">
      {STEPS.map((s, i) => {
        const n = count(s.stage);
        const on = !!n;
        return (
          <Fragment key={s.stage}>
            <li
              className={cn(
                // phone: a stepper column (count in a circle, words under it); wide: a box with words then count
                "flex min-h-11 min-w-0 flex-1 flex-col items-center gap-1 text-center sm:items-start sm:justify-start sm:gap-1 sm:rounded-md sm:border sm:px-3 sm:py-2 sm:text-left",
                on ? "sm:border-emerald-700/60 sm:bg-emerald-50 sm:dark:bg-emerald-950/30" : "sm:border-border",
              )}
              data-testid="one-offs-step"
              data-stage={s.stage}
              data-count={n ?? ""}
            >
              <span className="grid min-w-0">
                <span className="text-[11px] font-semibold leading-tight tracking-tight text-foreground [overflow-wrap:normal] sm:text-sm sm:font-medium sm:tracking-normal">{s.label}</span>
                <span className="text-[10px] leading-tight text-muted-foreground sm:text-xs" data-testid="one-offs-step-says">{s.says}</span>
              </span>
              <span
                className={cn(
                  "order-first flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-base font-semibold tabular-nums sm:order-none sm:h-auto sm:w-auto sm:rounded-none sm:border-0 sm:text-lg",
                  on ? "border-emerald-700/60 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400" : "border-border text-muted-foreground",
                  "sm:bg-transparent dark:sm:bg-transparent",
                  n === undefined && "sm:hidden",
                )}
              >
                {n === undefined ? <Mic className="h-4 w-4" aria-label="voice note" /> : n}
              </span>
              {s.stage === "in work" && d.counts.stuck > 0 && <span className="text-[10px] font-medium text-destructive sm:text-xs">{d.counts.stuck} stuck</span>}
            </li>
            {i < STEPS.length - 1 && (
              <li aria-hidden="true" className="flex h-9 w-3 shrink-0 items-center justify-center text-muted-foreground sm:h-auto sm:w-auto" data-testid="one-offs-arrow">
                <ArrowRight className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              </li>
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}

const linkCls = "text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground";

function OneOffItem({ o }: { o: OneOff }) {
  return (
    <li className="grid gap-1.5 rounded-md border px-3 py-3" data-testid="one-off" data-row={o.id} data-stage={o.stage}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">{o.name}</span>
        <span className={cn("shrink-0 text-xs font-medium", o.stage === "stuck" ? "text-destructive" : o.stage === "your card" || o.stage === "delivered" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")} data-testid="one-off-stage">
          {STAGE_WORD[o.stage]}
        </span>
      </div>
      {o.detail && <p className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{o.detail}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {o.card ? (
          <span data-testid="one-off-card">
            Card:{" "}
            {o.stage === "your card" ? (
              <Link to="/" className={linkCls}>
                {o.card.title ?? "open it on Team"}
              </Link>
            ) : (
              <span className="text-foreground">{o.card.title ?? "written"}</span>
            )}
            {o.card.evidenceUrl && (
              <>
                {" · "}
                <a href={o.card.evidenceUrl} target="_blank" rel="noreferrer" className={linkCls}>
                  see it
                </a>
              </>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground" data-testid="one-off-card">
            Card: when it is done
          </span>
        )}
        <span data-testid="one-off-epic">
          In{" "}
          {o.epic.code ? (
            <Link to={deckHref(o.epic.repo, o.epic.code)} className={linkCls}>
              {o.epic.title ?? o.epic.code}
            </Link>
          ) : (
            <span className="text-foreground">{o.epic.title ?? o.epic.path}</span>
          )}
        </span>
        {o.source && (
          <span data-testid="one-off-source">
            {o.source.url ? (
              <a href={o.source.url} target="_blank" rel="noreferrer" className={linkCls}>
                Your voice note
              </a>
            ) : (
              <span className="text-foreground">Your voice note</span>
            )}
            {o.date ? <span className="text-muted-foreground"> · {o.date}</span> : null}
          </span>
        )}
      </div>
      {o.next && o.stage !== "delivered" && <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Next: {o.next}</div>}
    </li>
  );
}

export function OneOffsPage() {
  const { data, error, loading } = useOneOffs();
  const open = data?.oneOffs.filter((o) => o.stage !== "delivered") ?? [];
  const done = data?.oneOffs.filter((o) => o.stage === "delivered") ?? [];
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-3xl gap-4" data-testid="one-offs-page">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">One-offs</h1>
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the one-offs…</div>}
      {error && <div className="text-sm text-destructive">Could not read the one-offs: {error.message}</div>}
      {data && (
        <>
          <div className="grid gap-3 rounded-lg border bg-card px-4 py-3" data-testid="one-offs-answer">
            <p className="text-base font-medium text-foreground" data-testid="one-offs-punchline">
              {punchline(data)}
            </p>
            <Lifecycle d={data} />
            <p className="text-xs text-muted-foreground">
              Jobs that belong to no <Link to={`/${PURSUITS_PATH}`} className={linkCls}>pursuit</Link>, from your voice note to delivered. Each drops off {data.deliveredDays} days after you close it.
            </p>
          </div>
          {open.length > 0 ? (
            <ul className="grid gap-2" data-testid="one-offs-list">
              {open.map((o) => (
                <OneOffItem key={`${o.epic.path}:${o.id}`} o={o} />
              ))}
            </ul>
          ) : (
            <div className="rounded-md border px-3 py-3 text-sm text-muted-foreground" data-testid="one-offs-empty">
              Nothing open. Say a one-off in a voice note and it shows here.
            </div>
          )}
          {done.length > 0 && (
            <>
              <h2 className="text-sm font-semibold text-foreground">Delivered this week</h2>
              <ul className="grid gap-2" data-testid="one-offs-delivered">
                {done.map((o) => (
                  <OneOffItem key={`${o.epic.path}:${o.id}`} o={o} />
                ))}
              </ul>
            </>
          )}
          <p className="text-xs text-muted-foreground" data-testid="one-offs-rule">
            Where they live: a one-off is a row whose title starts with “One-off”. It sits in the epic it needs, or in the One-offs list when none fits, and runs like every task: a worker, a card, your answer.
          </p>
        </>
      )}
    </div>
  );
}
