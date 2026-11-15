import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { Link, NavLink, useLocation, useParams, useSearchParams } from "react-router-dom";
import { api, type ChatRead, type DeskChat, type PendingItem, type ReviewItem } from "@/api";
import type { ScorecardNode, ScorecardRow, ScorecardRowState, ScorecardsBody, ScorecardWork } from "@/api/pursuit-types";
import { CountPill, PILL_SHAPE, PILL_TITLES, SortControl, useSectionSort, type SectionSort } from "@/components/homeSection";
import { InboxSearchBox } from "@/components/inboxSearch";
import { TeamCardsSections } from "@/components/teamCards";
import { epicDeckHref } from "@/components/pursuitsMap";
import { usePursuits } from "@/components/pursuits";
import { SET_KIT_TAB, SocialKitView, kitPursuitOf, setKitHref } from "@/components/socialKit";
import { useQuery } from "@/lib/data";
import { useBlocked, useReviewCards, useStatusBatch } from "@/lib/inbox";
import { InboxSearchProvider, useInboxSearch } from "@/lib/inboxSearch";
import {
  SCORECARDS_PATH,
  SET_NAME,
  homeOf,
  inScorecard,
  indexScorecards,
  queueOf,
  scorecardHref,
  sortInbox,
  waitedFor,
  type InboxRow,
  type InboxSort,
  type Placeable,
  type ScorecardIndex,
} from "@/lib/scorecards";
import { cn } from "@/lib/utils";
import { lazyPage } from "@/lib/lazyPage";

// The chat and inbox tabs load their scripts when opened, so Home's first download holds only the goals view.
const ChatView = lazyPage(() => import("@/pages/Chat"), "ChatView");
const WaitingForReview = lazyPage(() => import("@/components/review"), "WaitingForReview");
const WaitingOnYou = lazyPage(() => import("@/components/waiting"), "WaitingOnYou");

/**
 * Goal sets (the name is one setting, SET_NAME, until the owner picks one).
 * the owner vn_fe52ef4a 22:19Z: "for each entry on the left, on the sidebar, is a scorecard ... They can be inside of each
 * other ... when you click on it, you should see the scorecard. You should be able to chat. You should be able to see
 * the queues, the inbox for that entry. And then at the top ... the aggregated inbox ... I can sort across all".
 * vn_fd4f7a7a: "Each pursuit is a table of measurable rows (12-26) coloured green/amber/red, with its own kanban, chat
 * desk and personas; the team desk spans all." Same in both skins (the sidebar shows it in both products).
 */

export function useGoalSets() {
  return useQuery<ScorecardsBody>(() => api.listScorecards(), [], { tag: "inbox" });
}

/** the whole inbox (open asks of the status batch, review cards), each line placed in its goal set. */
export function useSetInbox(body: ScorecardsBody | undefined) {
  const { data: statuses } = useStatusBatch();
  const blocked = useBlocked(statuses);
  const { cards } = useReviewCards();
  const ix = useMemo(() => indexScorecards(body), [body]);
  const rows = useMemo(() => {
    const nodes = body?.nodes ?? [];
    const out: (InboxRow & { item: Placeable })[] = [];
    for (const i of blocked as PendingItem[]) {
      const home = homeOf(ix, nodes, i);
      out.push({ id: i.id, kind: "ask", title: i.title, code: i.code, since: i.since, priority: i.priority, pursuit: home?.pursuit, node: home?.node, item: i });
    }
    for (const c of (cards ?? []) as ReviewItem[]) {
      const home = homeOf(ix, nodes, c);
      out.push({ id: c.id, kind: "review", title: c.face?.title ?? c.title, code: c.ref, since: c.checkedAt || c.createdAt || undefined, priority: c.priority, pursuit: home?.pursuit, node: home?.node, item: c });
    }
    return out;
  }, [blocked, cards, ix, body]);
  const loading = !statuses || !!statuses.loading || !cards;
  const countFor = useCallback(
    (id: string) => {
      let ask = 0;
      let review = 0;
      for (const r of rows) if (inScorecard(ix, id, r.item)) r.kind === "ask" ? ask++ : review++;
      return { ask, review };
    },
    [rows, ix],
  );
  return { rows, ix, countFor, loading };
}

// ---------- the wheel and the table ----------

export const STATE_FILL: Record<ScorecardRowState, string> = {
  green: "hsl(142 72% 29%)",
  amber: "hsl(38 92% 50%)",
  red: "hsl(0 72% 51%)",
  unknown: "hsl(var(--border))",
};
const STATE_WORD: Record<ScorecardRowState, string> = { green: "green", amber: "amber", red: "red", unknown: "no data yet" };

/** the set as a wheel: one segment per row, in its colour (a wheel is a circle); greens of rows inside. */
export function SetWheel({ rows, size = 40, testId = "set-wheel" }: { rows: Pick<ScorecardRow, "state">[]; size?: number; testId?: string }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const n = rows.length;
  const gap = n > 1 ? Math.min(2, c / n / 4) : 0;
  const seg = n ? c / n : 0;
  const greens = rows.filter((x) => x.state === "green").length;
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} data-testid={testId} role="img" aria-label={`${greens} of ${n} rows green`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        {n === 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="4" />}
        {rows.map((x, i) => (
          <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={STATE_FILL[x.state]} strokeWidth="4" strokeDasharray={`${Math.max(0.5, seg - gap)} ${c}`} strokeDashoffset={-i * seg} />
        ))}
      </svg>
      {size >= 36 && (
        <span className="absolute text-[11px] font-medium tabular-nums text-foreground">
          {greens}/{n}
        </span>
      )}
    </span>
  );
}


function Dot({ state }: { state: ScorecardRowState }) {
  return <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATE_FILL[state] }} aria-hidden="true" />;
}

/** rows that carry work: everything but the flow and inbox rows, which measure the work itself. */
const TAKES_WORK = new Set<ScorecardRow["kind"]>(["key-result", "health", "check", "epic", "done-means"]);
const CLOSED_WORK = /^(done|superseded|cancelled|canceled|moved|dropped|parked)\b/i;
/** the work still open on a row (a done ticket no longer works on it). */
export const openWork = (r: Pick<ScorecardRow, "work">) => (r.work ?? []).filter((w) => w.kind !== "unknown" && !CLOSED_WORK.test(w.status ?? ""));

const WORK_KIND: Record<ScorecardWork["kind"], string> = { epic: "epic", ticket: "ticket", "done-means": "done means", unknown: "not found" };
const stateOfWork = (w: ScorecardWork): ScorecardRowState => w.state ?? (CLOSED_WORK.test(w.status ?? "") ? "green" : w.kind === "unknown" ? "unknown" : "amber");

/** under a key result, one line: how many things work on it, by colour, or the mark when nothing does. */
function WorkSummary({ r }: { r: ScorecardRow }) {
  if (!TAKES_WORK.has(r.kind)) return null;
  const open = openWork(r);
  const all = r.work ?? [];
  // a green row needs no work on it: the mark is only for rows not yet green.
  if (!open.length && r.state === "green") return null;
  if (!open.length)
    return (
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs" data-testid="set-row-no-work">
        <span className="text-[hsl(0_72%_45%)]">Nothing working on this</span>
        {all.length > 0 && <span className="text-muted-foreground">{all.length} done or not found</span>}
      </span>
    );
  const by = { green: 0, amber: 0, red: 0, unknown: 0 };
  all.forEach((w) => by[stateOfWork(w)]++);
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground" data-testid="set-row-work-summary">
      <span>
        {all.length} {all.length === 1 ? "thing" : "things"} under it:
      </span>
      {(["green", "amber", "red", "unknown"] as const).map((k) =>
        by[k] ? (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATE_FILL[k] }} aria-hidden="true" />
            {by[k]} {STATE_WORD[k]}
          </span>
        ) : null,
      )}
    </span>
  );
}

/** a key result opened: the list of things under it (epics, tickets, Done-means items), each in its colour. */
function WorkDetail({ r, setId }: { r: ScorecardRow; setId: string }) {
  const all = r.work ?? [];
  return (
    <div className="col-span-2 mt-2 grid gap-1 rounded-lg border bg-muted/30 p-2 sm:col-span-3" data-testid="set-row-detail">
      {!all.length && <p className="px-1 text-xs text-muted-foreground">Nothing works on this yet: no epic, ticket or Done-means item names it.</p>}
      {all.map((w) => {
        const st = stateOfWork(w);
        const href = w.epicCode ? epicDeckHref(w.repo, w.epicCode, setId) : undefined;
        const body = (
          <>
            <Dot state={st} />
            <span className="min-w-0">
              <span className="block text-sm text-foreground [overflow-wrap:anywhere]">
                <span className="font-medium">{w.code}</span> {w.title ?? ""}
              </span>
              <span className="block text-xs text-muted-foreground">
                {WORK_KIND[w.kind]}
                {w.status ? ` · ${w.status}` : ""}
              </span>
            </span>
          </>
        );
        return href ? (
          <Link key={`${w.repo}:${w.code}`} to={href} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-md px-1 py-1 hover:bg-accent/50" data-testid="set-row-work-item" data-state={st}>
            {body}
          </Link>
        ) : (
          <div key={`${w.repo}:${w.code}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 px-1 py-1" data-testid="set-row-work-item" data-state={st}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** the table of measurable rows, by group: are we progressing, what are we stuck on, and what works on each row. */
export function RowsTable({ rows, setId = "", open, onOpen, kitHref }: { rows: ScorecardRow[]; setId?: string; open?: string | null; onOpen?: (label: string | null) => void; kitHref?: string }) {
  const counts = { green: 0, amber: 0, red: 0, unknown: 0 };
  rows.forEach((r) => counts[r.state]++);
  const groups: { name: string; rows: ScorecardRow[] }[] = [];
  for (const r of rows) {
    const name = r.group ?? GROUP_OF[r.kind];
    const g = groups.find((x) => x.name === name);
    if (g) g.rows.push(r);
    else groups.push({ name, rows: [r] });
  }
  return (
    <div className="grid gap-2" data-testid="set-rows">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="set-rows-counts">
        {(["green", "amber", "red", "unknown"] as const).map((s) =>
          counts[s] ? (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATE_FILL[s] }} aria-hidden="true" />
              {counts[s]} {STATE_WORD[s]}
            </span>
          ) : null,
        )}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card" role="table" aria-label="Measurable rows">
        {groups.map((g) => (
          <div key={g.name} role="rowgroup" data-testid="set-row-group">
            <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground" role="row">
              {g.name}
            </div>
            <ul className="divide-y border-b last:border-b-0">
              {g.rows.map((r, i) => (
                <li
                  key={`${r.label}-${i}`}
                  id={`kr-${encodeURIComponent(r.label)}`}
                  role="row"
                  className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]", TAKES_WORK.has(r.kind) && "cursor-pointer hover:bg-accent/30", open === r.label && "bg-accent/40")}
                  data-testid="set-row"
                  data-state={r.state}
                  data-kind={r.kind}
                  aria-expanded={TAKES_WORK.has(r.kind) ? open === r.label : undefined}
                  tabIndex={TAKES_WORK.has(r.kind) ? 0 : undefined}
                  onClick={(e) => TAKES_WORK.has(r.kind) && !(e.target as HTMLElement).closest("a") && onOpen?.(open === r.label ? null : r.label)}
                  onKeyDown={(e) => TAKES_WORK.has(r.kind) && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen?.(open === r.label ? null : r.label))}
                >
                  <Dot state={r.state} />
                  <span className="min-w-0" role="cell">
                    <span className="flex items-start gap-1 text-sm text-foreground [overflow-wrap:anywhere]">
                      {TAKES_WORK.has(r.kind) && (open === r.label ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />)}
                      <span className="min-w-0">{r.label}</span>
                    </span>
                    {(r.source || r.note) && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{r.note ?? r.source}</span>}
                    {kitHref && /social kit/i.test(r.label) && (
                      <Link to={kitHref} className="mt-0.5 inline-block text-xs text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground" data-testid="set-row-kit">
                        Open the social kit
                      </Link>
                    )}
                    <WorkSummary r={r} />
                  </span>
                  {/* on a phone the value sits under the label (the label keeps the full width); beside it from sm up. */}
                  <span className="col-start-2 flex flex-wrap items-baseline gap-x-2 sm:col-start-auto sm:grid sm:justify-items-end sm:text-right" role="cell">
                    <span className="text-sm font-medium tabular-nums text-foreground">{r.value}</span>
                    {(r.target || r.by) && <span className="text-xs text-muted-foreground">{[r.target && `target ${r.target}`, r.by && `by ${r.by}`].filter(Boolean).join(" ")}</span>}
                    {r.greenSince && <span className="text-xs text-[hsl(142_72%_29%)]">green since {r.greenSince.slice(5, 10)}</span>}
                  </span>
                  {open === r.label && <WorkDetail r={r} setId={setId} />}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

const GROUP_OF: Record<ScorecardRow["kind"], string> = {
  "key-result": "Key results",
  health: "Health",
  check: "Checks",
  epic: "Epics",
  "done-means": "Done means",
  flow: "Is it moving",
  inbox: "Waiting on you",
};

/** not green and no open epic or ticket on it: what nobody is turning green. */
export const idle = (rows: ScorecardRow[]) => rows.filter((r) => TAKES_WORK.has(r.kind) && r.state !== "green" && !openWork(r).length).length;

/** progress (the owner vn_c15874bc): rows turned green today and this week. */
export function Progress({ today, week, since }: { today?: number; week?: number; since?: string }) {
  if (today === undefined || week === undefined) return null;
  return (
    <div className="grid grid-cols-2 items-stretch gap-2 sm:flex sm:flex-wrap" data-testid="set-progress">
      {[
        ["today", today, "turned green today"],
        ["week", week, "turned green this week"],
      ].map(([id, n, words]) => (
        <div key={id as string} className="flex min-w-0 items-baseline gap-2 rounded-xl border bg-card px-3 py-2 sm:min-w-[9rem]" data-testid={`set-progress-${id}`}>
          <span className={cn("text-2xl font-semibold tabular-nums", (n as number) > 0 ? "text-[hsl(142_72%_29%)]" : "text-foreground")}>{n as number}</span>
          <span className="text-xs text-muted-foreground">rows {words as string}</span>
        </div>
      ))}
      {since && <span className="col-span-2 self-end text-xs text-muted-foreground">counted since {since.slice(0, 10)}</span>}
    </div>
  );
}

/** the same progress in one quiet line, under the key results. */
export function ProgressLine({ today, week, since }: { today?: number; week?: number; since?: string }) {
  if (today === undefined || week === undefined) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="set-progress">
      <span className={cn("font-semibold tabular-nums", today > 0 ? "text-[hsl(142_72%_29%)]" : "text-foreground")} data-testid="set-progress-today">
        {today}
      </span>{" "}
      turned green today ·{" "}
      <span className={cn("font-semibold tabular-nums", week > 0 ? "text-[hsl(142_72%_29%)]" : "text-foreground")} data-testid="set-progress-week">
        {week}
      </span>{" "}
      this week{since ? ` · counted since ${since.slice(0, 10)}` : ""}
    </p>
  );
}

/** the set's rows plus its two inbox rows (asks waiting on you, finished work waiting for your review). */
export function rowsWithInbox(node: ScorecardNode, n: { ask: number; review: number } | undefined): ScorecardRow[] {
  if (!n) return node.rows;
  return [
    ...node.rows,
    { label: "Asks waiting on you", kind: "inbox", state: n.ask ? "red" : "green", value: String(n.ask) },
    { label: "Finished work waiting for your review", kind: "inbox", state: n.review > 3 ? "red" : n.review ? "amber" : "green", value: String(n.review) },
  ];
}

/** what a set is called on screen: its short objective when its file gives one, else its name. */
export const titleOf = (n: Pick<ScorecardNode, "headline" | "name">) => n.headline ?? n.name;

export function ProposedMark() {
  return (
    <span className="ml-2 inline-block rounded-full border px-2 py-0.5 align-middle text-xs font-normal text-muted-foreground" title="Proposed: it becomes the goal when you agree" data-testid="objective-proposed">
      proposed
    </span>
  );
}

/** an objective's key results: its file's 4 to 6, or an epic's Done means; else its rows that take work. */
export function keyResultsOf(node: ScorecardNode): ScorecardRow[] {
  if (node.keyResults?.length) return node.keyResults;
  const boxes = node.rows.filter((r) => r.kind === "done-means");
  if (boxes.length) return boxes.map((r) => ({ ...r, doneMeans: r.note, note: undefined, state: r.state === "amber" && !openWork(r).length ? "red" : r.state }));
  return node.rows.filter((r) => TAKES_WORK.has(r.kind));
}

/** one block per key result, in its colour: the objective's strip (the sidebar and the all list). */
export function KrStrip({ rows, className }: { rows: Pick<ScorecardRow, "state" | "label">[]; className?: string }) {
  return (
    <span className={cn("flex flex-wrap gap-[3px]", className)} role="img" aria-label={`${rows.filter((r) => r.state === "green").length} of ${rows.length} key results green`} data-testid="kr-strip">
      {rows.map((r, i) => (
        <i key={i} className="block h-1.5 w-5 rounded-[1px]" style={{ background: STATE_FILL[r.state] }} title={`${r.label}: ${STATE_WORD[r.state]}`} data-state={r.state} />
      ))}
    </span>
  );
}

/** the one-line answer a page opens on, boxed and edged by its light (root L-59; the card check wants a box, not a paragraph). */
export function AnswerBox({ light, title, answer, testId }: { light: Light; title: string; answer: string; testId: string }) {
  return (
    <header className="grid min-w-0 gap-1 rounded-xl border border-l-[6px] bg-card px-3 py-2.5 shadow-sm sm:px-4 sm:py-3" style={{ borderLeftColor: STATE_FILL[light] }} data-testid={`${testId}-box`}>
      <h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl">{title}</h1>
      <p className="text-[15px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]" data-testid={testId}>
        {answer}
      </p>
    </header>
  );
}

/** the answer the page opens with, in one line: how many key results are green, what is red, what nobody works on. */
export function krAnswer(krs: ScorecardRow[]): string {
  const by = { green: 0, amber: 0, red: 0, unknown: 0 };
  krs.forEach((r) => by[r.state]++);
  const rest = [by.red && `${by.red} red`, by.amber && `${by.amber} amber`, by.unknown && `${by.unknown} with no data yet`].filter(Boolean).join(", ");
  const none = idle(krs);
  return `${by.green} of ${krs.length} key results are green${rest ? `, ${rest}` : ""}.${none ? ` ${none} ${none === 1 ? "has" : "have"} nothing working on ${none === 1 ? "it" : "them"}.` : ""}`;
}

/**
 * How an objective lives in its spine, drawn as one line of boxes with arrows at every width (a sequence is a line; the
 * card check: "drawn as one line with arrows"): the spine, its Goal sentence (the objective), its Done means (the key
 * results, coloured) and the rows under them (the work).
 */
export function SpineLine({ node, krs }: { node: ScorecardNode; krs: ScorecardRow[] }) {
  const work = new Set(krs.flatMap((r) => (r.work ?? []).map((w) => `${w.repo}:${w.code}`))).size;
  const ref = node.spineRef ?? (node.children[0]?.code && node.children[0]?.repo ? { repo: node.children[0].repo, code: node.children[0].code } : undefined);
  const steps: { k: string; top: ReactNode; sub: string; subShort?: string }[] = [
    { k: "spine", top: ref ? ref.code : "no spine", sub: ref ? `${ref.repo} spine` : "spine", subShort: "its spine" },
    { k: "objective", top: SET_NAME.one, sub: "its Goal sentence" },
    { k: "krs", top: <>{krs.length} key results<KrStrip rows={krs} className="mt-1 gap-[2px] [&>i]:w-2.5" /></>, sub: "its Done means" },
    { k: "work", top: `${work} ${work === 1 ? "thing" : "things"}`, sub: "its rows, the work" },
  ];
  return (
    <ol className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-x-0.5 sm:gap-x-1.5" aria-label="How this lives in its spine: spine, objective, key results, work" data-testid="spine-line">
      {steps.map((s, i) => (
        <Fragment key={s.k}>
          <li className="grid min-w-0 content-start rounded-lg border bg-card px-1.5 py-1.5 sm:px-3" data-testid={`spine-line-${s.k}`}>
            <span className="text-xs font-medium leading-tight text-foreground [overflow-wrap:anywhere] sm:text-sm">{s.top}</span>
            {s.subShort ? (
              <span className="text-xs leading-tight text-muted-foreground">
                <span className="sm:hidden">{s.subShort}</span>
                <span className="hidden sm:inline">{s.sub}</span>
              </span>
            ) : (
              <span className="text-xs leading-tight text-muted-foreground [overflow-wrap:anywhere]">{s.sub}</span>
            )}
          </li>
          {i < steps.length - 1 && (
            <li aria-hidden="true" className="grid place-items-center text-sm text-muted-foreground" data-testid="spine-line-arrow">
              →
            </li>
          )}
        </Fragment>
      ))}
    </ol>
  );
}

export type Light = "green" | "amber" | "red" | "unknown";
const LAMPS = ["red", "amber", "green"] as const;
/** a pursuit's light: red when any key result is red, green when all are, amber otherwise, unlit with none. */
export function lightOf(krs: Pick<ScorecardRow, "state">[]): Light {
  if (!krs.length) return "unknown";
  if (krs.some((r) => r.state === "red")) return "red";
  if (krs.every((r) => r.state === "green")) return "green";
  if (krs.every((r) => r.state === "unknown")) return "unknown";
  return "amber";
}
/** a small traffic light: red, amber, green lamps, the one that applies lit, none lit when there is no data yet. */
export function TrafficLight({ light, size = "md", testId = "traffic-light" }: { light: Light; size?: "sm" | "md"; testId?: string }) {
  const d = size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-[3px] rounded-full bg-zinc-900", size === "sm" ? "px-1 py-[3px]" : "px-1.5 py-1")} role="img" aria-label={`traffic light: ${STATE_WORD[light]}`} data-testid={testId} data-state={light}>
      {LAMPS.map((k) => (
        <i key={k} className={cn("block rounded-full", d)} style={{ background: STATE_FILL[k], opacity: light === k ? 1 : 0.2 }} />
      ))}
    </span>
  );
}

/** a key result's target in plain words, or "no target yet" in grey (the owner, 17:57Z: "what is the target?"). */
function KrTarget({ r, label }: { r: ScorecardRow; label?: boolean }) {
  return r.target ? (
    <span className="text-foreground [overflow-wrap:anywhere]" data-testid="kr-target-text">
      {label && <span className="text-muted-foreground">Target </span>}
      {r.target}
    </span>
  ) : (
    <span className="text-muted-foreground/70" data-testid="kr-no-target">
      {label && "Target: "}no target yet
    </span>
  );
}

/** where it stands now: the value, its note (when it was read, the due date), a dot in its colour. */
function KrNow({ r, label }: { r: ScorecardRow; label?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5" data-testid="kr-now-text">
      <span className="translate-y-[1px] self-center">
        <TrafficLight light={r.state} size="sm" testId="kr-light" />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {label && <span className="text-muted-foreground">Now </span>}
        <span className="font-semibold tabular-nums text-foreground">{r.value}</span>
        {r.note && <span className="text-muted-foreground"> · {r.note}</span>}
      </span>
    </span>
  );
}

/** the key results as the mock-up drew them: a colour bar, the name, how much work is under it, the value; one opens its work. */
export function KeyResultSheet({ krs, setId, open, onOpen }: { krs: ScorecardRow[]; setId: string; open?: string | null; onOpen?: (label: string | null) => void }) {
  const by = { green: 0, amber: 0, red: 0, unknown: 0 };
  krs.forEach((r) => by[r.state]++);
  return (
    <div className="grid gap-2" data-testid="kr-sheet-wrap">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-muted-foreground" data-testid="kr-summary">
        <span className="text-lg font-semibold text-foreground">
          {by.green} of {krs.length} green
        </span>
        <span>
          {by.amber} amber · {by.red} red{by.unknown ? ` · ${by.unknown} no data yet` : ""}
        </span>
        <span>tap a key result for the work under it</span>
      </p>
      <ul className="overflow-hidden rounded-xl border bg-card" data-testid="kr-sheet">
        <li aria-hidden="true" className="hidden grid-cols-[6px_minmax(0,1fr)_minmax(0,11rem)_minmax(0,11rem)_auto] gap-x-3 border-b bg-muted/30 pr-3 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid" data-testid="kr-sheet-head">
          <i />
          <span className="py-2">Key result</span>
          <span className="py-2">Target</span>
          <span className="py-2">Status now</span>
          <span className="w-4" />
        </li>
        {krs.map((r) => {
          const isOpen = open === r.label;
          const all = r.work ?? [];
          const toggle = () => onOpen?.(isOpen ? null : r.label);
          return (
            <li key={r.label} id={`kr-${encodeURIComponent(r.label)}`} className="border-b last:border-b-0" data-testid="kr-item" data-state={r.state}>
              <button type="button" onClick={toggle} aria-expanded={isOpen} className={cn("grid w-full grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-x-3 pr-3 text-left hover:bg-accent/30 sm:grid-cols-[6px_minmax(0,1fr)_minmax(0,11rem)_minmax(0,11rem)_auto]", isOpen && "bg-accent/40")} data-testid="kr-row">
                <i className="block self-stretch" style={{ background: STATE_FILL[r.state] }} aria-hidden="true" />
                <span className="grid min-w-0 gap-0.5 py-3">
                  <span className="text-[15px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="kr-name">
                    {r.label}
                    <span className="sr-only"> ({STATE_WORD[r.state]})</span>
                  </span>
                  {/* on a phone the target and the status sit under the name, one line each. */}
                  <span className="grid gap-0.5 text-xs sm:hidden" data-testid="kr-target-status-phone">
                    <KrTarget r={r} label />
                    <KrNow r={r} label />
                  </span>
                  {all.length ? (
                    <span className="text-xs text-muted-foreground" data-testid="kr-things">
                      {all.length} {all.length === 1 ? "thing" : "things"} under it
                    </span>
                  ) : (
                    <span className={cn("text-xs", r.state === "green" ? "text-muted-foreground" : "text-[hsl(0_72%_45%)]")} data-testid="kr-no-work">
                      nothing working on this
                    </span>
                  )}
                </span>
                <span className="hidden min-w-0 py-3 text-sm sm:grid" data-testid="kr-target">
                  <KrTarget r={r} />
                </span>
                <span className="hidden min-w-0 py-3 text-sm sm:grid" data-testid="kr-now">
                  <KrNow r={r} />
                </span>
                <span className="text-muted-foreground" aria-hidden="true">
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
              </button>
              {isOpen && (
                <div className="grid gap-1.5 border-t bg-muted/20 px-3 py-3 sm:px-5" data-testid="kr-detail">
                  <p className="text-sm text-foreground">Work under this key result</p>
                  {!all.length && <p className="text-xs text-muted-foreground">Nothing is working on this yet. The Delivery Manager opens a row for it on the next wake.</p>}
                  {all.map((w) => {
                    const st = stateOfWork(w);
                    const href = w.epicCode ? epicDeckHref(w.repo, w.epicCode, setId) : undefined;
                    const inner = (
                      <>
                        <i className="mt-1 block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: STATE_FILL[st] }} aria-hidden="true" />
                        <span className="grid min-w-0 gap-0.5 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-x-3">
                          <code className="text-xs text-muted-foreground">{w.code}</code>
                          <span className="text-sm text-foreground [overflow-wrap:anywhere]">{w.title ?? WORK_KIND[w.kind]}</span>
                          <span className="text-xs text-muted-foreground sm:text-right">{w.status ?? WORK_KIND[w.kind]}</span>
                        </span>
                      </>
                    );
                    const cls = "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-md border bg-card px-2.5 py-2";
                    return href ? (
                      <Link key={`${w.repo}:${w.code}`} to={href} className={cn(cls, "hover:bg-accent/40")} data-testid="kr-work-item" data-state={st}>
                        {inner}
                      </Link>
                    ) : (
                      <div key={`${w.repo}:${w.code}`} className={cls} data-testid="kr-work-item" data-state={st}>
                        {inner}
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="kr-legend">
        {(
          [
            ["green", "green: at target"],
            ["amber", "amber: on its way"],
            ["red", "red: behind or stuck"],
            ["unknown", "no data yet"],
          ] as const
        ).map(([k, w]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <i className="block h-2.5 w-3.5 rounded-[2px]" style={{ background: STATE_FILL[k] }} aria-hidden="true" />
            {w}
          </span>
        ))}
      </p>
    </div>
  );
}

// ---------- the sidebar ----------

/**
 * the idle mark (the owner: "It should be moving untill all green"): a wheel below green with
 * no worker, nothing waiting on him and nothing in review. A pill, never grey text (lean rows); its title
 * says why and who starts its next step (its milestone's Delivery Manager, on its regular wake).
 */
export function IdlePill({ n, testId = "wheel-idle" }: { n: Pick<ScorecardNode, "idle" | "owner">; testId?: string }) {
  if (!n.idle?.idle) return null;
  const woke = ` ${n.owner ?? "Its Delivery Manager"} starts its next step on its next regular wake.`;
  return (
    <span className={cn(PILL_SHAPE, "border border-[hsl(0_72%_51%)] bg-transparent text-[hsl(0_72%_45%)] dark:text-[hsl(0_80%_70%)]")} title={`${n.idle.reason}.${woke}`} data-testid={testId}>
      idle
    </span>
  );
}

/** the top objectives in his order, less the ones shown inside another (their file's `foldedInto`). */
export const topObjectives = (nodes: ScorecardNode[] | undefined) => (nodes ?? []).filter((n) => !n.foldedInto);

/**
 * One objective in the sidebar: only its name, its inbox pills and its colour circle (the owner 2026-11-13 20:03Z:
 * "Too much info on sidebar - we only need name, inbox and circle"); the strip and the child epics live on its page. The open one adds
 * nothing under its name: its Board, Inbox, Chat desk and Social kit are the tabs on its page (card check 2026-11-13).
 */
function SidebarObjective({ n, countFor, onNavigate, activeId }: { n: ScorecardNode; countFor: (id: string) => { ask: number; review: number }; onNavigate?: () => void; activeId?: string }) {
  const c = countFor(n.id);
  const krs = keyResultsOf(n);
  const active = activeId === n.id;
  return (
    <li className="grid min-w-0 gap-0.5" data-testid="sidebar-set" data-set={n.id} data-depth={0}>
      <Link
        to={scorecardHref(n.id)}
        onClick={onNavigate}
        className={cn("grid min-w-0 gap-1.5 rounded-md border-l-[3px] px-2.5 py-2", active ? "border-l-foreground bg-card shadow-sm ring-1 ring-border" : "border-l-transparent hover:bg-accent/60")}
        title={`${titleOf(n)}: ${krs.filter((r) => r.state === "green").length} of ${krs.length} key results green`}
        aria-current={active ? "page" : undefined}
        data-testid="sidebar-set-link"
      >
        <span className="flex min-w-0 items-start gap-2">
          <SetWheel rows={krs} size={20} testId="sidebar-set-wheel" />
          <span className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{titleOf(n)}</span>
          <span className="flex shrink-0 items-center gap-1">
            <IdlePill n={n} testId="sidebar-set-idle" />
            {c.ask > 0 && <CountPill count={c.ask} tone="needs-you" title={PILL_TITLES["needs-you"](c.ask)} testId="sidebar-set-asks" />}
            {c.review > 0 && <CountPill count={c.review} tone="review" title={PILL_TITLES.review(c.review)} testId="sidebar-set-review" />}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** the sidebar, both skins: All objectives on top (every key result, the combined inbox), then each objective in his order, nested. */
export function SidebarGoalSets({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useGoalSets();
  const { countFor, rows } = useSetInbox(data);
  const { pathname } = useLocation();
  const activeId = pathname.startsWith(`/${SCORECARDS_PATH}/`) ? decodeURIComponent(pathname.slice(SCORECARDS_PATH.length + 2).split("/")[0]) : undefined;
  const top = topObjectives(data?.nodes);
  if (!top.length) return null;
  const asks = rows.filter((r) => r.kind === "ask").length;
  const reviews = rows.length - asks;
  const krs = top.flatMap(keyResultsOf);
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1" data-testid="sidebar-goal-sets">
      <NavLink
        to={`/${SCORECARDS_PATH}`}
        end
        onClick={onNavigate}
        className={({ isActive }) => cn("mt-1 flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-sm", isActive ? "bg-card font-semibold text-foreground shadow-sm ring-1 ring-border" : "bg-card/60 font-medium text-foreground hover:bg-accent/60")}
        data-testid="sidebar-goal-sets-all"
      >
        <span className="min-w-0 flex-1">{SET_NAME.all}</span>
        {/* every key result of every objective; the inbox's own pills sit on Inbox above. */}
        <span className="shrink-0 text-xs font-normal text-muted-foreground" data-testid="sidebar-all-counts" title={`${asks} asks and ${reviews} cards wait on you across them`}>
          {krs.filter((r) => r.state === "green").length} green · {krs.filter((r) => r.state === "red").length} red
        </span>
      </NavLink>
      <div className="px-2.5 pb-0.5 pt-2 text-xs font-medium text-muted-foreground">{SET_NAME.many} · by priority</div>
      <ul className="grid min-w-0 gap-1">
        {top.map((n) => (
          <SidebarObjective key={n.id} n={n} countFor={countFor} onNavigate={onNavigate} activeId={activeId} />
        ))}
      </ul>
    </div>
  );
}

// ---------- the slim, sortable inbox ----------

// the same Sort as the Inbox's sections (the sections' SortControl, labels Highest priority, Most recent, Longest
// standing), remembered per tab as teamHome.sort.<tab> (the owner 2026-11-12 "I want to be able to do sorting").
const INBOX_SORT_OF: Record<SectionSort, InboxSort> = { priority: "priority", recent: "newest", oldest: "waiting" };

/** every line of the inbox in one list: what it is, which set, how long it waited; sorted across the sets. */
export function SlimInbox({ rows, showSet = true, loading, sortKey }: { rows: InboxRow[]; showSet?: boolean; loading?: boolean; sortKey: string }) {
  const [sort, setSort] = useSectionSort(sortKey);
  const search = useInboxSearch();
  const shown = sortInbox(search.active && search.hits ? rows.filter((r) => search.hits!.has(r.id)) : rows, INBOX_SORT_OF[sort]);
  return (
    <section className="grid gap-2" data-testid="slim-inbox">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          Inbox <span className="font-normal text-muted-foreground">· {shown.length}</span>
        </h2>
        <SortControl value={sort} onChange={setSort} testId="slim-inbox" />
      </div>
      {loading && !rows.length && <p className="text-sm text-muted-foreground">Reading the inbox…</p>}
      {!loading && !shown.length && <p className="text-sm text-muted-foreground">Nothing waits on you here.</p>}
      {shown.length > 0 && (
        <ul className="divide-y rounded-xl border bg-card">
          {shown.map((r) => (
            <li key={r.id} data-testid="slim-inbox-row" data-kind={r.kind}>
              <Link to={r.node ? scorecardHref(r.node.id, "inbox") : "/"} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 hover:bg-accent/40">
                <Dot state={r.kind === "ask" ? "red" : "green"} />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground [overflow-wrap:anywhere]">{r.title}</span>
                  <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {r.kind === "ask" ? "waiting on you" : "ready for your review"}
                    {showSet ? ` · ${r.pursuit ? (r.node && r.node !== r.pursuit ? `${titleOf(r.pursuit)} › ${titleOf(r.node)}` : titleOf(r.pursuit)) : `outside every ${SET_NAME.one.toLowerCase()}`}` : r.node ? ` · ${r.node.name}` : ""}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">{waitedFor(r.since)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- tabs ----------

const TABS = [
  { id: "table", label: "Key results" },
  { id: "kanban", label: "Board" },
  { id: "inbox", label: "Inbox" },
  { id: "chat", label: "Chat desk" },
  { id: "context", label: "Context" },
  { id: "personas", label: "Personas" },
  // the set's social kit (only on a set that has one): the owner reaches "these totems" from the set.
  { id: SET_KIT_TAB, label: "Social kit" },
] as const;
type Tab = (typeof TABS)[number]["id"];
const ALL_TABS = [
  { id: "table", label: "Key results" },
  { id: "inbox", label: "Combined inbox" },
  { id: "chat", label: "Team desk" },
] as const;

/** `links`: tabs that open another page (the social skin's Home: Inbox), drawn after the page's own tabs. */
export function TabStrip({ tabs, tab, counts, links, label = `${SET_NAME.one} pages` }: { tabs: readonly { id: string; label: string }[]; tab: string; counts?: Partial<Record<string, number>>; links?: Record<string, { label: string; to: string; count?: number }>; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = ref.current;
    const on = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !on || nav.scrollWidth <= nav.clientWidth) return;
    const right = on.offsetLeft + on.offsetWidth - nav.clientWidth;
    if (on.offsetLeft < nav.scrollLeft) nav.scrollLeft = on.offsetLeft;
    else if (right > nav.scrollLeft) nav.scrollLeft = right + 24;
  }, [tab, tabs.length]);
  return (
    // phone: one line that scrolls sideways, 44 px taps, the open tab scrolled into view; wider: the line wraps.
    <nav
      ref={ref}
      className="relative -mx-1 flex overflow-x-auto overscroll-x-contain border-b px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:gap-x-4 sm:overflow-visible"
      aria-label={label}
      data-testid="set-tabs"
    >
      {tabs.map((t) => (
        <Link
          key={t.id}
          to={t.id === "table" ? "?" : `?tab=${t.id}`}
          replace
          className={cn("-mb-px flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm sm:min-h-10 sm:px-1", tab === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          aria-current={tab === t.id ? "page" : undefined}
          data-testid={`set-tab-${t.id}`}
        >
          {t.label}
          {counts?.[t.id] ? <span className="text-xs text-muted-foreground">{counts[t.id]}</span> : null}
        </Link>
      ))}
      {Object.entries(links ?? {}).map(([id, l]) => (
        <Link key={id} to={l.to} className="-mb-px flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground sm:min-h-10 sm:px-1" data-testid={`set-tab-${id}`}>
          {l.label}
          {l.count ? <span className="text-xs text-muted-foreground">{l.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

// ---------- one set ----------

function Crumbs({ ix, node }: { ix: ScorecardIndex; node: ScorecardNode }) {
  const chain: ScorecardNode[] = [];
  for (let n: ScorecardNode | undefined = ix.parentOf.get(node.id); n; n = ix.parentOf.get(n.id)) chain.unshift(n);
  const link = "text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground";
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm" aria-label="Where you are" data-testid="set-crumbs">
      <Link to={`/${SCORECARDS_PATH}`} className={link}>
        {SET_NAME.all}
      </Link>
      {chain.map((n) => (
        <span key={n.id} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <Link to={scorecardHref(n.id)} className={cn(link, "[overflow-wrap:anywhere]")}>
            {titleOf(n)}
          </Link>
        </span>
      ))}
    </nav>
  );
}

/** Kanban: Ready, Running, Waiting from the spines' ledgers, Review from the inbox's cards. */
function Kanban({ body, node, reviews }: { body: ScorecardsBody; node: ScorecardNode; reviews: InboxRow[] }) {
  const q = queueOf(body, node);
  const cols: { id: string; title: string; items: { key: string; code?: string; title: string; sub?: string; href?: string }[] }[] = [
    { id: "ready", title: "Ready", items: q.filter((r) => r.state === "ready").map((r) => ({ key: `${r.repo}:${r.code}`, code: r.code, title: r.title, sub: r.epicCode ?? r.epic })) },
    { id: "running", title: "Running", items: q.filter((r) => r.state === "running").map((r) => ({ key: `${r.repo}:${r.code}`, code: r.code, title: r.title, sub: r.status })) },
    { id: "waiting", title: "Waiting", items: q.filter((r) => r.state === "waiting").map((r) => ({ key: `${r.repo}:${r.code}`, code: r.code, title: r.title, sub: r.status })) },
    { id: "review", title: "Your review", items: reviews.map((r) => ({ key: r.id, code: r.code, title: r.title, href: scorecardHref(node.id, "inbox") })) },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="set-kanban">
      {cols.map((c) => (
        <section key={c.id} className="grid content-start gap-2 rounded-xl border bg-muted/30 p-2.5" data-testid={`kanban-${c.id}`}>
          <h3 className="flex items-center justify-between px-1 text-sm font-medium">
            {c.title} <span className="text-xs text-muted-foreground">{c.items.length}</span>
          </h3>
          {!c.items.length && <p className="px-1 text-xs text-muted-foreground">Nothing here.</p>}
          {c.items.map((i) => {
            const inner = (
              <>
                <span className="block text-sm text-foreground [overflow-wrap:anywhere]">{i.title}</span>
                <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{[i.code, i.sub].filter(Boolean).join(" · ")}</span>
              </>
            );
            return i.href ? (
              <Link key={i.key} to={i.href} className="rounded-lg border bg-card px-2.5 py-2 hover:border-foreground/40" data-testid="kanban-card" data-row={i.code}>
                {inner}
              </Link>
            ) : (
              <div key={i.key} className="rounded-lg border bg-card px-2.5 py-2" data-testid="kanban-card" data-row={i.code}>
                {inner}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** the codes this set's chat lines name: its epics' codes and their row prefixes (EPIC-n → En-). */
function chatMarks(node: ScorecardNode): string[] {
  const marks = new Set<string>();
  const add = (n: ScorecardNode) => {
    if (n.code) {
      marks.add(n.code);
      const num = /^EPIC-(\d+)/.exec(n.code)?.[1];
      if (num) marks.add(`E${num}-`);
    }
    n.children.forEach(add);
  };
  add(node);
  return [...marks];
}

/** keep his lines sent from this set (or naming its codes) and the desk's answers to them. */
export function filterChat(chat: DeskChat, tag: string, marks: string[]): DeskChat {
  const out: DeskChat["messages"] = [];
  let keep = false;
  for (const m of chat.messages) {
    if (m.kind === "seed") continue;
    if (m.role === "user") keep = (m.page ?? "").includes(tag) || marks.some((k) => m.text.includes(k));
    if (keep) out.push(m);
  }
  return { ...chat, messages: out };
}

function SetChat({ node }: { node: ScorecardNode }) {
  const [all, setAll] = useState(false);
  const tag = `${SET_NAME.one} · ${node.name}`;
  const marks = useMemo(() => chatMarks(node), [node]);
  const id = node.milestoneId;
  const load = useCallback(
    async (read?: ChatRead) => {
      const chat = await api.getMilestoneChat(id!, read);
      return all ? chat : filterChat(chat, tag, marks);
    },
    [id, all, tag, marks],
  );
  // every line he sends here carries the set's name, so this chat finds it again.
  const send = useCallback((text: string, _page?: string, rid?: string, files?: string[]) => (files?.length ? api.sendMilestoneChatMessage(id!, text, tag, rid, files) : api.sendMilestoneChatMessage(id!, text, tag, rid)), [id, tag]);
  const markSeen = useCallback(() => api.markChatSeen({ chat: "milestone", id: id! }), [id]);
  if (!id) return <p className="text-sm text-muted-foreground">No team runs this {SET_NAME.one.toLowerCase()} yet, so it has no desk to talk to.</p>;
  return (
    <div className="grid min-w-0 gap-2" data-testid="set-chat">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>The desk of the team that runs it. Showing</span>
        <button type="button" aria-pressed={!all} onClick={() => setAll(false)} className={cn("min-h-8 rounded-md border px-2", !all && "border-foreground text-foreground")} data-testid="set-chat-only">
          this {SET_NAME.one.toLowerCase()}
        </button>
        <button type="button" aria-pressed={all} onClick={() => setAll(true)} className={cn("min-h-8 rounded-md border px-2", all && "border-foreground text-foreground")} data-testid="set-chat-all">
          the whole desk
        </button>
      </div>
      <ChatView key={`${node.id}:${all}`} who="Desk" load={load} sendMessage={send} markSeen={markSeen} cacheKey={`set:${node.id}:${all ? "all" : "only"}`} placeholder={`Talk about ${node.name}…`} voiceBase={`/api/milestones/${encodeURIComponent(id)}/voice`} attach />
    </div>
  );
}

function Context({ node, pursuit }: { node: ScorecardNode; pursuit: ScorecardNode }) {
  const { data: pursuitsBody } = usePursuits();
  const effort = pursuitsBody?.pursuits.find((p) => p.id === pursuit.id)?.effort;
  const link = "text-sm text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground";
  const epics = node.kind === "epic" ? [node, ...node.children] : node.children;
  return (
    <div className="grid gap-4" data-testid="set-context">
      {(node.objective ?? pursuit.objective) && (
        <section className="rounded-xl border bg-card p-3">
          <div className="text-xs text-muted-foreground">Objective{node.kind === "epic" ? ", the epic's Goal sentence" : ""}</div>
          <p className="text-sm text-foreground [overflow-wrap:anywhere]">
            {node.headline ?? node.objective ?? pursuit.objective}
            {node.objectiveStatus === "proposed" && <ProposedMark />}
          </p>
          {node.objectiveWas && <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="objective-was">It replaces: {node.objectiveWas}</p>}
        </section>
      )}
      <section className="grid gap-1.5">
        <h3 className="text-sm font-medium">Where its rows come from</h3>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]" data-testid="set-file">
          {pursuit.file?.present
            ? `Its own file, ${pursuit.file.path}${pursuit.file.proposal ? ` (shape from ${pursuit.file.proposal})` : ""}, then the rows read live from its spines.`
            : `Read live from its checks and spines. Its own key results go in ${pursuit.file?.path ?? "its file"} once you pick the shape.`}
        </p>
      </section>
      {epics.length > 0 && (
        <section className="grid gap-1.5">
          <h3 className="text-sm font-medium">Epics, each opens its deck</h3>
          <ul className="grid gap-1">
            {epics.map((e) => (
              <li key={e.id} className="min-w-0">
                {e.code && e.repo ? (
                  <Link to={epicDeckHref(e.repo, e.code, pursuit.id)} className={link}>
                    {e.code}: {e.name}
                  </Link>
                ) : (
                  <span className="text-sm">{e.name}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {node.children.length > 0 && (
        <section className="grid gap-1.5">
          <h3 className="text-sm font-medium">{SET_NAME.many} inside it</h3>
          <ul className="grid gap-1.5">
            {node.children.map((c) => (
              <li key={c.id}>
                <Link to={scorecardHref(c.id)} className="flex min-w-0 items-center gap-2 hover:underline" data-testid="set-child">
                  <SetWheel rows={c.rows} size={20} testId="set-child-wheel" />
                  <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{c.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {node.kind === "pursuit" && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="set-effort">
          {/* the order lives in docs/pursuits.json (the drag left /pursuits with the plain list, iteration 4). */}
          {effort ? (
            <>
              <span className="font-medium text-foreground">Effort: {effort.tier}.</span> {effort.words} Its place follows your order of{" "}
            </>
          ) : (
            "Its place and effort follow your order of "
          )}
          <Link to="/pursuits" className="underline underline-offset-4">
            the pursuits
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function Personas({ node }: { node: ScorecardNode }) {
  const teams = node.teams ?? [];
  return (
    <div className="grid gap-2" data-testid="set-personas">
      {!teams.length && <p className="text-sm text-muted-foreground">No persona works on it yet.</p>}
      {teams.length > 0 && (
        <ul className="divide-y rounded-xl border bg-card">
          {teams.map((t) => (
            <li key={t.persona} className="flex min-w-0 items-baseline justify-between gap-3 px-3 py-2.5" data-testid="set-persona">
              <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{t.persona}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{t.enabled ? `wakes ${t.paceNow}${t.paceNow !== t.pace ? ` (set ${t.pace})` : ""}` : "off"}</span>
            </li>
          ))}
        </ul>
      )}
      {node.milestoneId && (
        <Link to={`/milestones/${encodeURIComponent(node.milestoneId)}?tab=personas`} className="text-sm underline underline-offset-4">
          Switch personas on or off
        </Link>
      )}
    </div>
  );
}

export function GoalSetPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "table") as Tab;
  const { data: pursuitsBody } = usePursuits();
  const kr = params.get("kr");
  const openKr = (label: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (label) next.set("kr", label);
        else next.delete("kr");
        return next;
      },
      { replace: true },
    );
  const { data, error, loading } = useGoalSets();
  const inbox = useSetInbox(data);
  const node = inbox.ix.byId.get(id);
  // a link to one key result (an inbox card's) opens it and brings it into view.
  useEffect(() => {
    if (kr && node) document.getElementById(`kr-${encodeURIComponent(kr)}`)?.scrollIntoView?.({ block: "center" });
  }, [kr, node]);
  const pursuit = node ? inbox.ix.pursuitOf.get(node.id)! : undefined;
  const mine = node ? inbox.rows.filter((r) => inScorecard(inbox.ix, node.id, r.item)) : [];
  const counts = { ask: mine.filter((r) => r.kind === "ask").length, review: mine.filter((r) => r.kind === "review").length };
  const rows = node ? rowsWithInbox(node, inbox.loading ? undefined : counts) : [];
  const krs = node ? keyResultsOf(node) : [];
  const only = useCallback((i: Placeable) => !!node && inScorecard(inbox.ix, node.id, i), [node, inbox.ix]);
  const kitId = pursuit ? kitPursuitOf(pursuitsBody?.pursuits, pursuit.id) : undefined;
  const tabs = kitId ? TABS : TABS.filter((t) => t.id !== SET_KIT_TAB);
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-3" data-testid="goal-set-page" data-set={id}>
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the {SET_NAME.many.toLowerCase()}…</div>}
      {error && <div className="text-sm text-destructive">Could not read the {SET_NAME.many.toLowerCase()}: {error.message}</div>}
      {data && !node && (
        <div className="text-sm text-muted-foreground" data-testid="set-unknown">
          No {SET_NAME.one.toLowerCase()} here. <Link to={`/${SCORECARDS_PATH}`} className="underline underline-offset-4">See every one</Link>
        </div>
      )}
      {node && pursuit && (
        <>
          <Crumbs ix={inbox.ix} node={node} />
          {/* each objective is a wheel (the owner: "These are the wheels"): its key results round a circle, then the answer. */}
          {/* the first screen opens on one boxed answer at every width (the card check, 390 px: "a heading and a
              paragraph, not a punchline answer box"): the objective, then its answer, in one box edged by its light. */}
          <header className="flex min-w-0 items-start gap-3 rounded-xl border border-l-[6px] bg-card p-3 shadow-sm sm:p-4" style={{ borderLeftColor: STATE_FILL[lightOf(krs)] }} data-testid="set-answer-box">
            <SetWheel rows={krs} size={44} testId="set-wheel" />
            <div className="grid min-w-0 gap-1.5">
              <h1 className="text-xl font-semibold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-3xl" data-testid="set-objective">
                {titleOf(node)}
                {node.objectiveStatus === "proposed" && <ProposedMark />}
              </h1>
              <p className="text-[15px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere] sm:text-base" data-testid="set-answer">
                {krAnswer(krs)}
              </p>
            </div>
          </header>
          <TabStrip tabs={tabs} tab={tab} counts={{ inbox: mine.length, kanban: queueOf(data, node).length + counts.review }} />
          {tab === "table" && (
            <div className="grid gap-4">
              <KeyResultSheet krs={krs} setId={pursuit.id} open={kr} onOpen={openKr} />
              <ProgressLine today={data?.progress?.sets[pursuit.id]?.today} week={data?.progress?.sets[pursuit.id]?.week} since={data?.progress?.since} />
              {/* how it lives in its spine, after the sheet: the key results are the first thing he sees (17:57Z). */}
              <SpineLine node={node} krs={krs} />
              {/* every row measured for it (12 to 26, vn_fd4f7a7a) stays one tap away, under the key results. */}
              <details className="group rounded-xl border bg-card/50" data-testid="set-all-rows" open={!!kr && !krs.some((k) => k.label === kr)}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm text-muted-foreground hover:text-foreground">
                  <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" />
                  All {rows.length} measured rows
                </summary>
                <div className="p-2 pt-0">
                  <RowsTable rows={rows} setId={pursuit.id} open={kr} onOpen={openKr} kitHref={kitId ? setKitHref(node.id) : undefined} />
                </div>
              </details>
            </div>
          )}
          {tab === "kanban" && <Kanban body={data!} node={node} reviews={mine.filter((r) => r.kind === "review")} />}
          {tab === "inbox" && (
            <InboxSearchProvider>
              <InboxSearchBox />
              <SlimInbox rows={mine} showSet={false} loading={inbox.loading} sortKey="set-inbox" />
              <div className="mt-4 grid gap-4">
                <TeamCardsSections scorecard={pursuit.id} />
                <WaitingOnYou part="blocked" title="Waiting on you" only={only} />
                <WaitingForReview only={only} title="Ready for your review" />
              </div>
            </InboxSearchProvider>
          )}
          {tab === "chat" && <SetChat node={node} />}
          {tab === "context" && <Context node={node} pursuit={pursuit} />}
          {tab === "personas" && <Personas node={node} />}
          {tab === SET_KIT_TAB && (kitId ? <SocialKitView id={kitId} /> : <div className="text-sm text-muted-foreground" data-testid="set-no-kit">This {SET_NAME.one.toLowerCase()} has no social kit here yet.</div>)}
        </>
      )}
    </div>
  );
}

// ---------- all sets: the team desk spanning all ----------

const loadDesk = (read?: ChatRead) => api.getDeskChat(read);
const sendDesk = (text: string, page?: string, id?: string, files?: string[]) => (files?.length ? api.sendDeskMessage(text, page ?? SET_NAME.all, id, files) : api.sendDeskMessage(text, page ?? SET_NAME.all, id));
const markDeskSeen = () => api.markChatSeen({ chat: "desk" });

/**
 * The key-result table of several wheels at once (the owner: "the first tab on a wheel section view, or when all wheels
 * selected at once"): one row per wheel with its traffic light, a tap opens its key results (the same sheet as inside
 * one wheel: target, status now, each opening the work under it), a tap closes it. All objectives and Pursuits use it.
 */
export function WheelsTable({
  nodes,
  countFor,
  hrefOf = (n) => scorecardHref(n.id),
  lead,
}: {
  nodes: ScorecardNode[];
  countFor?: (id: string) => { ask: number; review: number };
  /** where a row's arrow goes (the console skin: the objective's page; The social skin: the campaign). */
  hrefOf?: (n: ScorecardNode) => string;
  /** the social skin's rows: this at the front (the campaign's number ring), and the whole row opens its page, no fold. */
  lead?: (n: ScorecardNode) => ReactNode;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [kr, setKr] = useState<Record<string, string | null>>({});
  // effort follows his order (docs/pursuits.json `effort`): each opened wheel says what its place buys it.
  const { data: pursuitsBody } = usePursuits();
  const effortOf = (id: string) => pursuitsBody?.pursuits.find((p) => p.id === id)?.effort;
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <ul className="overflow-hidden rounded-xl border bg-card" data-testid="all-sets-table">
      {nodes.map((n, i) => {
        const krs = keyResultsOf(n);
        const light = lightOf(krs);
        const isOpen = open.has(n.id);
        const c = countFor?.(n.id) ?? { ask: 0, review: 0 };
        return (
          <li key={n.id} className="border-b last:border-b-0" data-testid="all-sets-row" data-set={n.id} data-state={light}>
            <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center", isOpen && "bg-accent/30")}>
              {(() => {
                const inner = (
                  <>
                    {lead ? (
                      lead(n)
                    ) : (
                      <span className="text-muted-foreground" aria-hidden="true">
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </span>
                    )}
                    <TrafficLight light={light} testId="wheel-light" />
                    <span className="grid min-w-0 gap-1">
                      <span className="text-[15px] font-medium text-foreground [overflow-wrap:anywhere]" data-testid="wheel-name">
                        <span className="text-muted-foreground">{i + 1}. </span>
                        {titleOf(n)}
                        {n.objectiveStatus === "proposed" && <ProposedMark />}
                      </span>
                      {/* lean rows (the owner 13 Nov 21:46Z: "only the colors and pills is enough, the small gray stuff you can remove"): name, colour bar, pills. */}
                      <KrStrip rows={krs} />
                    </span>
                  </>
                );
                const cls = "flex min-h-14 min-w-0 items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/30";
                return lead ? (
                  <Link to={hrefOf(n)} className={cls} data-testid="wheel-row-link">
                    {inner}
                  </Link>
                ) : (
                  <button type="button" onClick={() => toggle(n.id)} aria-expanded={isOpen} className={cls} data-testid="wheel-toggle">
                    {inner}
                  </button>
                );
              })()}
              <span className="flex shrink-0 items-center gap-1 pr-2">
                <IdlePill n={n} />
                {c.ask > 0 && <CountPill count={c.ask} tone="needs-you" title={PILL_TITLES["needs-you"](c.ask)} />}
                {c.review > 0 && <CountPill count={c.review} tone="review" title={PILL_TITLES.review(c.review)} />}
                <Link to={hrefOf(n)} className="grid h-10 w-10 place-items-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground" aria-label={`Open ${titleOf(n)}`} data-testid="wheel-open">
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </span>
            </div>
            {isOpen && (
              <div className="grid gap-2 border-t bg-muted/10 px-2 py-3 sm:px-4" data-testid="wheel-krs">
                {effortOf(n.id) && (
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="wheel-effort">
                    <span className="font-medium text-foreground">Effort, place {i + 1}: {effortOf(n.id)!.tier}.</span> {effortOf(n.id)!.words}
                  </p>
                )}
                {krs.length ? <KeyResultSheet krs={krs} setId={n.id} open={kr[n.id] ?? null} onOpen={(l) => setKr((k) => ({ ...k, [n.id]: l }))} /> : <p className="text-sm text-muted-foreground">No key results yet.</p>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function GoalSetsPage() {
  const [params] = useSearchParams();
  const tab = ALL_TABS.find((t) => t.id === params.get("tab"))?.id ?? "table";
  const { data, error, loading } = useGoalSets();
  const inbox = useSetInbox(data);
  const sets = topObjectives(data?.nodes).map((n) => ({ n, krs: keyResultsOf(n) }));
  const allKrs = sets.flatMap((s) => s.krs);
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-3" data-testid="goal-sets-page">
      <AnswerBox
        light={lightOf(allKrs)}
        title={SET_NAME.all}
        testId="all-sets-answer"
        answer={data ? `${allKrs.filter((r) => r.state === "green").length} of ${allKrs.length} key results are green across ${sets.length} objectives, ${allKrs.filter((r) => r.state === "red").length} red. ${inbox.rows.length} things wait on you.` : `Every ${SET_NAME.one.toLowerCase()} in one place.`}
      />
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the {SET_NAME.many.toLowerCase()}…</div>}
      {error && <div className="text-sm text-destructive">Could not read the {SET_NAME.many.toLowerCase()}: {error.message}</div>}
      <TabStrip tabs={ALL_TABS} tab={tab} counts={{ inbox: inbox.rows.length }} />
      {tab === "table" && (
        <WheelsTable nodes={sets.map((x) => x.n)} countFor={inbox.countFor} />
      )}
      {tab === "inbox" && (
        <InboxSearchProvider>
          <InboxSearchBox />
          <SlimInbox rows={inbox.rows} loading={inbox.loading} sortKey="combined-inbox" />
        </InboxSearchProvider>
      )}
      {tab === "chat" && (
        <div data-testid="team-desk">
          <p className="mb-2 text-xs text-muted-foreground">The team desk: one chat for every set.</p>
          <ChatView who="Team desk" load={loadDesk} sendMessage={sendDesk} markSeen={markDeskSeen} cacheKey="desk" placeholder="Ask the team about any goal…" voiceBase="/api/voice" attach />
        </div>
      )}
    </div>
  );
}
