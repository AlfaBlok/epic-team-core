import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ObjectiveName, productText, splitObjectiveName } from "@/components/objectiveName";
import { byRingColour } from "@/lib/ringOrder";
import { ArrowRight, ChevronRight } from "lucide-react";
import { Link, NavLink, Navigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import { api, type ChatRead, type DeskChat, type PendingItem, type ReviewItem } from "@/api";
import type { PersonaGapsBody, ScorecardNode, ScorecardRow, ScorecardRowState, ScorecardsBody, ScorecardWork } from "@/api/pursuit-types";
import { CountPill, PILL_SHAPE, PILL_TITLES, SortControl, useSectionSort, type SectionSort } from "@/components/homeSection";
import { InboxSearchBox } from "@/components/inboxSearch";
import { TeamCardsSections } from "@/components/teamCards";
import { epicDeckHref } from "@/components/pursuitsMap";
import { usePursuits } from "@/components/pursuits";
import { DailyBriefingSwitch, InactiveObjectives, ObjectiveOffButton } from "@/components/objectiveSwitch";
import { kitPursuitOf } from "@/components/socialKit";
import { useQuery } from "@/lib/data";
import { useBlocked, useReviewCards, useStatusBatch } from "@/lib/inbox";
import { InboxSearchProvider, useInboxSearch } from "@/lib/inboxSearch";
import {
  SCORECARDS_PATH,
  PRODUCTS_PATH,
  SET_NAME,
  homeOf,
  inScorecard,
  indexScorecards,
  boardOf,
  namesLaunchBoard,
  productHref,
  scorecardHref,
  sortInbox,
  type InboxRow,
  type InboxSort,
  type Placeable,
  type ScorecardIndex,
} from "@/lib/scorecards";
import { cn } from "@/lib/utils";
import { CardAge, cardAgeWords } from "@/components/common";
import { lazyPage } from "@/lib/lazyPage";
import { spineViewHref } from "@/lib/nodes";
import { useHomeTab, useWheelPages, WheelPagesTab } from "@/components/wheelPages";
import { WheelPlanTab } from "@/components/wheelPlan";
import { TotemTab, productOfObjective, useTotemMaps } from "@/components/totemTabs";
import { wheelTabsOf } from "@/lib/wheelTabs";
import { MadeOfLink } from "@/pages/MadeOf";
import type { Totem } from "@/api/totem-types";
import { TrackersTab } from "@/components/trackersTab";
import { PersonaLogTab } from "@/components/personaLogTab";
import { homeFilesOf, pagesOfObjective } from "@/lib/wheelPages";
import { FoldChevron } from "@/components/foldChevron";
import { GOAL_INBOX_TAB, GoalPills, RING_ARC_ORDER, ringArcs, SetWheel, STATE_FILL, topObjectives, useGoalSets } from "@/components/goalRing";
export { GOAL_INBOX_TAB, GoalPills, RING_ARC_ORDER, ringArcs, SetWheel, STATE_FILL, topObjectives, useGoalSets };
import { WhereWeAreBox } from "@/components/whereWeAre";

// The chat and inbox tabs load their scripts when opened, so Home's first download holds only the goals view.
const ChatView = lazyPage(() => import("@/pages/Chat"), "ChatView");
const WaitingForReview = lazyPage(() => import("@/components/review"), "WaitingForReview");
const WaitingOnYou = lazyPage(() => import("@/components/waiting"), "WaitingOnYou");
const ObjectivePersonas = lazyPage(() => import("@/components/objectivePersonas"), "ObjectivePersonas");
const ObjectiveApprovals = lazyPage(() => import("@/components/objectivePersonas"), "ObjectiveApprovals");

/**
 * Goal sets (the name is one setting, SET_NAME, until the owner picks one).
 * the owner vn_fe52ef4a 22:19Z: "for each entry on the left, on the sidebar, is a scorecard ... They can be inside of each
 * other ... when you click on it, you should see the scorecard. You should be able to chat. You should be able to see
 * the queues, the inbox for that entry. And then at the top ... the aggregated inbox ... I can sort across all".
 * vn_fd4f7a7a: "Each pursuit is a table of measurable rows (12-26) coloured green/amber/red, with its own kanban, chat
 * desk and personas; the team desk spans all." Same in both skins (the sidebar shows it in both products).
 */

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
      out.push({ id: c.id, kind: "review", title: c.face?.title ?? c.title, code: c.ref, since: c.inboxSince || c.createdAt || undefined, priority: c.priority, pursuit: home?.pursuit, node: home?.node, item: c });
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

const STATE_WORD: Record<ScorecardRowState, string> = { green: "green", amber: "amber", red: "red", unknown: "no data yet" };
/** a key result's status said in words, before its value (the legend's own words). */
export const STATUS_SAYS: Record<ScorecardRowState, string> = { green: "At target", amber: "On its way", red: "Behind", unknown: "Not measured" };
const STATUS_INK: Record<ScorecardRowState, string> = { green: "hsl(142 72% 26%)", amber: "hsl(30 90% 35%)", red: "hsl(0 72% 42%)", unknown: "hsl(var(--muted-foreground))" };


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

/** the id of a ticket's line on an objective's page (a search hit scrolls to it). */
export const workAnchor = (code: string) => `work-${encodeURIComponent(code)}`;

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

/**
 * every ticket hangs under a key result: the objective's open tickets no key result
 * lists, under the key results table, so a ticket floating under no goal shows where he looks. None: one calm line.
 */
export function UnplacedTickets({ node, setId, marked }: { node: Pick<ScorecardNode, "unplaced" | "keyResults">; setId: string; marked?: string | null }) {
  if (!node.keyResults?.length) return null;
  const all = node.unplaced ?? [];
  if (!all.length)
    return (
      <p className="text-xs text-muted-foreground" data-testid="unplaced-none">
        Every open ticket hangs under a key result.
      </p>
    );
  return (
    <section className="grid gap-1.5 rounded-xl border bg-card p-3" data-testid="unplaced">
      <p className="text-sm text-foreground">
        <span className="font-semibold">{all.length}</span> open {all.length === 1 ? "ticket hangs" : "tickets hang"} under no key result
      </p>
      <p className="text-xs text-muted-foreground">The Delivery Manager puts each under the key result it moves on its next wake, or closes it.</p>
      <ul className="grid gap-1">
        {all.map((w) => {
          const href = w.epicCode ? epicDeckHref(w.repo, w.epicCode, setId) : undefined;
          const inner = (
            <span className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-x-3">
              <code className="text-xs text-muted-foreground">{w.code}</code>
              <span className="text-sm text-foreground [overflow-wrap:anywhere]">{w.title ?? "in review"}</span>
              <span className="col-start-2 text-xs text-muted-foreground sm:col-start-auto sm:text-right">{w.status ?? ""}</span>
            </span>
          );
          return (
            <li key={`${w.repo}:${w.code}`} data-testid="unplaced-item" {...(marked === w.code ? { id: workAnchor(w.code), "data-marked": "1", className: "rounded-md ring-1 ring-foreground" } : {})}>
              {href ? (
                <Link to={href} className="block rounded-md px-1.5 py-1.5 hover:bg-accent/40">
                  {inner}
                </Link>
              ) : (
                <div className="px-1.5 py-1.5">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
                      {TAKES_WORK.has(r.kind) && <FoldChevron open={open === r.label} className="mt-[3px] text-muted-foreground" />}
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

/** one block per key result, in its colour, each colour together: the objective's strip (the sidebar and the all list). */
export function KrStrip({ rows, className, fit }: { rows: Pick<ScorecardRow, "state" | "label">[]; className?: string; fit?: boolean }) {
  // `fit` (the objectives rows): one line always, each bar shrinks to the column instead of wrapping to a second row.
  return (
    <span className={cn("flex gap-[3px]", fit ? "min-w-0 flex-nowrap" : "flex-wrap", className)} role="img" aria-label={`${rows.filter((r) => r.state === "green").length} of ${rows.length} key results green`} data-testid="kr-strip">
      {byRingColour(rows).map((r, i) => (
        <i key={i} className={cn("block h-1.5 rounded-[1px]", fit ? "min-w-[4px] max-w-5 flex-1" : "w-5")} style={{ background: STATE_FILL[r.state] }} title={`${r.label}: ${STATE_WORD[r.state]}`} data-state={r.state} />
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
  const rest = [by.amber && `${by.amber} amber`, by.red && `${by.red} red`, by.unknown && `${by.unknown} with no data yet`].filter(Boolean).join(", ");
  const none = idle(krs);
  return `${by.green} of ${krs.length} key results are green${rest ? `, ${rest}` : ""}.${none ? ` ${none} ${none === 1 ? "has" : "have"} nothing working on ${none === 1 ? "it" : "them"}.` : ""}`;
}

/**
 * The spine an objective lives in, for its spine box: the one its file names ("repo EPIC-n"), else its first epic,
 * also a plan kept in a top-level EPIC.md with no EPIC number, then named by its title. `path` opens it.
 */
export function objectiveSpine(node: ScorecardNode): { repo: string; label: string; path?: string } | undefined {
  const plain = (name: string) => name.replace(/^EPIC(-[\w.]+)?\s*:\s*/i, "").trim() || name;
  const pathOf = (repo: string, code: string): string | undefined => {
    const todo = [...node.children];
    while (todo.length) {
      const n = todo.shift()!;
      if (n.repo === repo && n.code === code && n.path) return n.path;
      todo.push(...n.children);
    }
    return undefined;
  };
  if (node.spineRef) return { repo: node.spineRef.repo, label: node.spineRef.code, path: pathOf(node.spineRef.repo, node.spineRef.code) };
  const first = node.children[0];
  if (!first?.repo || !(first.code || first.path)) return undefined;
  return { repo: first.repo, label: first.code ?? plain(first.name), ...(first.path ? { path: first.path } : {}) };
}

/**
 * How an objective lives in its spine, drawn as one line of boxes with arrows at every width (a sequence is a line; the
 * card check: "drawn as one line with arrows"): the spine, its Goal sentence (the objective), its Done means (the key
 * results, coloured) and the rows under them (the work).
 */
export function SpineLine({ node, krs }: { node: ScorecardNode; krs: ScorecardRow[] }) {
  const work = new Set(krs.flatMap((r) => (r.work ?? []).map((w) => `${w.repo}:${w.code}`))).size;
  const ref = objectiveSpine(node);
  const steps: { k: string; top: ReactNode; sub: string; subShort?: string; href?: string }[] = [
    { k: "spine", top: ref ? ref.label : "no spine", sub: ref ? `${ref.repo} spine` : "spine", subShort: "its spine", ...(ref?.path ? { href: spineViewHref({ repo: ref.repo, path: ref.path }) } : {}) },
    { k: "objective", top: SET_NAME.one, sub: "its Goal sentence" },
    { k: "krs", top: <>{krs.length} key results<KrStrip rows={krs} className="mt-1 gap-[2px] [&>i]:w-2.5" /></>, sub: "its Done means" },
    { k: "work", top: `${work} ${work === 1 ? "thing" : "things"}`, sub: "its rows, the work" },
  ];
  return (
    <ol className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-x-0.5 sm:gap-x-1.5" aria-label="How this lives in its spine: spine, objective, key results, work" data-testid="spine-line">
      {steps.map((s, i) => (
        <Fragment key={s.k}>
          <li className="relative grid min-w-0 content-start rounded-lg border bg-card px-1.5 py-1.5 sm:px-3" data-testid={`spine-line-${s.k}`}>
            {s.href ? (
              // the spine box opens the objective's plan (its spine), the whole box is the link.
              <Link to={s.href} className="text-xs font-medium leading-tight text-foreground underline-offset-2 [overflow-wrap:anywhere] after:absolute after:inset-0 hover:underline sm:text-sm" data-testid="spine-line-open">
                {s.top}
              </Link>
            ) : (
              <span className="text-xs font-medium leading-tight text-foreground [overflow-wrap:anywhere] sm:text-sm">{s.top}</span>
            )}
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
// green first, then amber, then red, left to right (the owner 22 Nov, vn_68cda1fe).
const LAMPS = ["green", "amber", "red"] as const;
/** a pursuit's light: red when any key result is red, green when all are, amber otherwise, unlit with none. */
export function lightOf(krs: Pick<ScorecardRow, "state">[]): Light {
  if (!krs.length) return "unknown";
  if (krs.some((r) => r.state === "red")) return "red";
  if (krs.every((r) => r.state === "green")) return "green";
  if (krs.every((r) => r.state === "unknown")) return "unknown";
  return "amber";
}
/** a small traffic light: green, amber, red lamps, the one that applies lit, none lit when there is no data yet. */
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
/**
 * a target or current value split into its number and its words (the owner 22 Nov, vn_1e5a86e8: "can the number be big?
 * ... the font can be smaller. But the number I wanted to jump to my face, the target and the current"): "1.19 GB" is
 * 1.19 and GB, "0 of 5" is 0 and "of 5", "under 2 GB" is 2 with its whole phrase under it. A date ("done by 24 Nov"), a
 * long lead-in or no number at all stays words.
 */
export function krNumber(text: string | null | undefined): { lead: string; num: string; rest: string } | null {
  const t = (text ?? "").replace(/\u00a0/g, " ").trim();
  const m = /^(.*?)(-?\d[\d,]*(?:\.\d+)?%?)(.*)$/.exec(t);
  if (!m) return null;
  const [, lead, num, rest] = m;
  if (lead.length > 12 || /[\d:/]/.test(lead)) return null;
  if (/^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(rest) || /^[:/]/.test(rest)) return null;
  return { lead: lead.trim(), num, rest: rest.trim() };
}

/** a value in the table: its number large and bold (in `ink` when given), its words small and muted under it. */
function KrFigure({ text, ink, testId }: { text: string; ink?: string; testId: string }) {
  const n = krNumber(text);
  if (!n) return <span className="line-clamp-3 text-sm font-semibold [overflow-wrap:anywhere]" style={ink ? { color: ink } : undefined} data-testid={testId}>{text}</span>;
  const words = n.lead ? text.replace(/\u00a0/g, " ").trim() : n.rest;
  return (
    <span className="grid min-w-0 justify-items-end" data-testid={testId}>
      <span className="whitespace-nowrap text-xl font-bold leading-none tracking-tight tabular-nums sm:text-3xl" style={ink ? { color: ink } : { color: "hsl(var(--foreground))" }} data-testid="kr-big">
        {n.num}
      </span>
      {words && <span className="sr-only"> </span>}
      {words && <span className="mt-1 line-clamp-3 text-xs leading-tight text-muted-foreground [overflow-wrap:anywhere]" data-testid="kr-unit">{words}</span>}
    </span>
  );
}

function KrTarget({ r, label, full }: { r: ScorecardRow; label?: boolean; full?: boolean }) {
  if (r.target && !label && !full) return <span className="grid min-w-0 justify-items-end" data-testid="kr-target-text"><KrFigure text={r.target} testId="kr-target-figure" /></span>;
  return r.target ? (
    // the whole target, never cut (vn_15aa4467: "the target ... I want to see it fully in this view ... if not, we make it wider, taller").
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

/** a key result older than this reads stale (the owner: "are all the other ones also not up to date?"). */
export const KR_STALE_MS = 24 * 3600 * 1000;
/** when a key result was measured, in words: "measured 3 h ago", stale past a day, "nothing measures this" when never. */
export function krMeasured(r: Pick<ScorecardRow, "measuredAt"> & Partial<Pick<ScorecardRow, "source">>, now = Date.now()): { words: string; stale: boolean; never: boolean } {
  const t = r.measuredAt ? Date.parse(r.measuredAt) : NaN;
  // a row its check reads (a `source`) is measured, only its time is not stamped.
  if (!Number.isFinite(t) && r.source) return { words: `read by ${r.source}, time not stamped`, stale: false, never: false };
  if (!Number.isFinite(t)) return { words: "nothing measures this yet", stale: true, never: true };
  const ago = Math.max(0, now - t);
  const h = Math.floor(ago / 3600000);
  const when = ago < 3600000 ? `${Math.max(1, Math.round(ago / 60000))} min ago` : h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
  const stale = ago > KR_STALE_MS;
  return { words: stale ? `stale: measured ${when}` : `measured ${when}`, stale, never: false };
}

/** where it stands now: the value, its note (when it was read, the due date), a dot in its colour. In the row it is cut to
 * two lines (the owner: "please make rows reasonable height"); the whole text opens with the row (`full`). */
function KrNow({ r, label, full }: { r: ScorecardRow; label?: boolean; full?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-start gap-1.5" data-testid="kr-now-text">
      <span className="mt-[5px] shrink-0">
        <TrafficLight light={r.state} size="sm" testId="kr-light" />
      </span>
      <span className="grid min-w-0">
        <span className={cn("min-w-0 [overflow-wrap:anywhere]", !full && "line-clamp-2")} title={full ? undefined : [r.value, r.note].filter(Boolean).join(" · ")} data-testid={full ? "kr-now-full" : "kr-now-short"}>
          {label && <span className="text-muted-foreground">Now </span>}
          {/* the status in a word first, in its colour (vn_15aa4467: "the status needs to be extremely clear"). */}
          {r.kind === "key-result" && (
            <span className="font-semibold" style={{ color: STATUS_INK[r.state] }} data-testid="kr-status-word">
              {STATUS_SAYS[r.state]}
              {r.state !== "unknown" ? ": " : ""}
            </span>
          )}
          {(r.kind !== "key-result" || r.state !== "unknown") && <span className="font-semibold tabular-nums text-foreground">{r.value}</span>}
          {r.note && <span className="text-muted-foreground"> · {r.note}</span>}
        </span>
        {r.kind === "key-result" && <KrWhen r={r} />}
      </span>
    </span>
  );
}
/** the measured line under a key result's value: when, or stale, or that nothing measures it. */
function KrWhen({ r }: { r: ScorecardRow }) {
  const m = krMeasured(r);
  return (
    <span className={cn("block text-xs", m.stale ? "text-muted-foreground/70 italic" : "text-muted-foreground")} title={r.measuredAt} data-testid="kr-measured" data-stale={m.stale ? "1" : "0"}>
      {m.words}
    </span>
  );
}

/** when a key result's evidence was last read, in words ("read 3 h ago"), from its measured stamp. */
export function krEvidenceRead(r: Pick<ScorecardRow, "measuredAt">, now = Date.now()): string {
  const m = krMeasured(r, now);
  return m.never ? "not read yet" : m.words.replace(/measured /, "read ");
}
/**
 * one link to the evidence behind its colour, with when it was last read (the owner, on a live call: "When I click on
 * here, I just want to see a link to the evidence for why this color is this color"). None named at its
 * source: it says so plainly, in grey.
 */
export function KrEvidence({ r }: { r: ScorecardRow }) {
  const e = r.evidence;
  if (!e)
    return (
      <span className="text-xs text-muted-foreground/70" data-testid="kr-evidence-none">
        Evidence: no evidence yet. Nothing we can open shows why it is this colour.
      </span>
    );
  const outside = /^https?:\/\//.test(e.url);
  const cls = "font-medium text-foreground underline underline-offset-2 [overflow-wrap:anywhere] hover:text-primary";
  return (
    <span className="text-xs text-muted-foreground" data-testid="kr-evidence">
      Evidence:{" "}
      {outside ? (
        <a href={e.url} target="_blank" rel="noreferrer" className={cls} data-testid="kr-evidence-link">
          {e.what} ↗
        </a>
      ) : (
        <Link to={e.url} className={cls} data-testid="kr-evidence-link">
          {e.what}
        </Link>
      )}
      <span data-testid="kr-evidence-read"> · {krEvidenceRead(r)}</span>
    </span>
  );
}

/**
 * where a key result came from (the owner, vn_243861c3 22 Nov: "another key result that I don't know where it's
 * coming from"): his words that asked for it, when. In the row one line of text (the row is a button); opened, the
 * whole quote, linked to the note.
 */
export function KrFromLine({ r, full }: { r: ScorecardRow; full?: boolean }) {
  const f = r.from;
  if (!f) return null;
  const words = (
    <>
      From your note{f.when ? `, ${f.when}` : ""}: <q className="italic">{f.said}</q>
    </>
  );
  const cls = cn("block text-xs text-muted-foreground [overflow-wrap:anywhere]", !full && "line-clamp-1");
  return full && f.url ? (
    <a href={f.url} target="_blank" rel="noreferrer" className={cn(cls, "underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground")} data-testid={full ? "kr-from-full" : "kr-from"}>
      {words} ↗
    </a>
  ) : (
    <span className={cls} data-testid={full ? "kr-from-full" : "kr-from"}>
      {words}
    </span>
  );
}

/** a state's colour as a soft tint, for the current cell's ground (the colour carries the status; the ink stays readable). */
const STATE_TINT: Record<ScorecardRowState, string> = {
  green: "hsl(142 72% 29% / 0.12)",
  amber: "hsl(38 92% 50% / 0.16)",
  red: "hsl(0 72% 51% / 0.12)",
  unknown: "hsl(var(--muted) / 0.6)",
};
/**
 * the table's columns: the key result takes most of the width, target and current stay narrow and right-aligned; the
 * arrow that opens a row has its own column only on a laptop, on a phone it sits in the first cell (the owner 22 Nov,
 * vn_b0c6e015: "very little space horizontally on the mobile ... make the first column not so narrow").
 */
export const KR_COLS = "grid-cols-[minmax(0,1fr)_minmax(0,4rem)_minmax(0,4.25rem)] sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,10rem)_1rem]";
const KR_COLS_PLAIN = "grid-cols-[minmax(0,1fr)_minmax(0,4rem)_minmax(0,4.25rem)] sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,10rem)]";

/** the current cell: the value alone, in its colour, right-aligned; the whole row carries the tint (vn_b0c6e015). */
function KrCurrent({ r }: { r: ScorecardRow }) {
  const says = r.kind === "key-result" ? STATUS_SAYS[r.state] : STATE_WORD[r.state];
  const value = r.kind === "key-result" && r.state === "unknown" ? "no data yet" : r.value;
  return (
    <span className="grid min-w-0 content-start justify-items-end gap-0.5 py-3 text-right" title={`${says}: ${[r.value, r.note].filter(Boolean).join(" · ")}`} data-testid="kr-now" data-state={r.state}>
      <span className="grid min-w-0 justify-items-end" data-testid="kr-now-short">
        <KrFigure text={value} ink={STATUS_INK[r.state]} testId="kr-now-figure" />
        <span className="sr-only"> ({says})</span>
      </span>
      {r.kind === "key-result" && (
        <span className="hidden sm:block">
          <KrWhen r={r} />
        </span>
      )}
    </span>
  );
}

/** the key result that decides the objective stays first, whatever its colour; the rest keep the colour order
 * (the owner, vn_617e3481: "one key result is missing, which is the first, the key result is a house was bought"). */
export function pinDeciding<T extends { decides?: boolean }>(rows: T[]): T[] {
  return [...rows.filter((r) => r.decides), ...rows.filter((r) => !r.decides)];
}

/**
 * an objective's key results as one table of three columns, key result, target and current, on a phone and a laptop
 * alike (the owner 22 Nov, vn_68cda1fe: "a table with three columns ... Testers sign up, 5, 3"); the current cell is
 * coloured, and the rows go green first, then amber, then red, then no data (the one order, lib/ringOrder.ts).
 * A row opens its whole status, its evidence and the work under it. `plain` (a new workspace's Get set up): the same
 * table, nothing to open and no work count (the workspace's chat works them).
 */
export function KeyResultSheet({ krs: given, setId, open, onOpen, plain = false, marked }: { krs: ScorecardRow[]; setId: string; open?: string | null; onOpen?: (label: string | null) => void; plain?: boolean; marked?: string | null }) {
  const krs = pinDeciding(byRingColour(given));
  const by = { green: 0, amber: 0, red: 0, unknown: 0 };
  krs.forEach((r) => by[r.state]++);
  const stale = krs.filter((r) => krMeasured(r).stale).length;
  const cols = plain ? KR_COLS_PLAIN : KR_COLS;
  return (
    <div className="grid gap-2" data-testid="kr-sheet-wrap">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-muted-foreground" data-testid="kr-summary">
        <span className="text-lg font-semibold text-foreground">
          {by.green} of {krs.length} green
        </span>
        <span>
          {by.amber} amber · {by.red} red{by.unknown ? ` · ${by.unknown} no data yet` : ""}
          {stale ? ` · ${stale} stale, greyed` : ""}
        </span>
        {!plain && <span>tap a key result for the work under it</span>}
      </p>
      <ul className="overflow-hidden rounded-xl border bg-card" data-testid="kr-sheet">
        <li aria-hidden="true" className={cn("grid gap-x-2 border-b bg-muted/30 pl-3 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:gap-x-3", cols, !plain && "pr-2 sm:pr-3")} data-testid="kr-sheet-head">
          <span className="py-2">Key result</span>
          <span className="py-2 text-right">Target</span>
          <span className="py-2 text-right">Current</span>
          {!plain && <span className="hidden sm:block" />}
        </li>
        {krs.map((r) => {
          const isOpen = !plain && open === r.label;
          const all = r.work ?? [];
          const toggle = () => onOpen?.(isOpen ? null : r.label);
          return (
            <li key={r.label} id={`kr-${encodeURIComponent(r.label)}`} className={cn("border-b last:border-b-0", krMeasured(r).stale && "opacity-55 grayscale")} style={{ background: STATE_TINT[r.state] }} data-testid="kr-item" data-state={r.state} data-stale={krMeasured(r).stale ? "1" : "0"}>
              <button type="button" onClick={plain ? undefined : toggle} aria-expanded={plain ? undefined : isOpen} className={cn("grid w-full items-start gap-x-2 pl-3 text-left sm:gap-x-3", cols, plain ? "cursor-default" : "pr-2 hover:bg-accent/30 sm:pr-3", isOpen && "bg-accent/40")} data-testid="kr-row">
                <span className="grid min-w-0 gap-0.5 py-3">
                  <span className="text-[15px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="kr-name">
                    {r.label}
                    <span className="sr-only"> ({STATE_WORD[r.state]})</span>
                  </span>
                  <KrFromLine r={r} />
                  {plain ? null : (
                    <span className="flex items-center gap-1">
                      {all.length ? (
                        <span className="text-xs text-muted-foreground" data-testid="kr-things">
                          {all.length} {all.length === 1 ? "thing" : "things"} under it
                        </span>
                      ) : (
                        <span className={cn("text-xs", r.state === "green" ? "text-muted-foreground" : "text-[hsl(0_72%_45%)]")} data-testid="kr-no-work">
                          nothing working on this
                        </span>
                      )}
                      {/* on a phone the arrow sits here, no column of its own; the whole row opens it */}
                      <span className="text-muted-foreground sm:hidden" aria-hidden="true" data-testid="kr-open-phone">
                        <FoldChevron open={isOpen} />
                      </span>
                    </span>
                  )}
                </span>
                <span className="grid min-w-0 justify-items-end py-3 text-right text-sm" data-testid="kr-target">
                  <KrTarget r={r} />
                </span>
                <KrCurrent r={r} />
                {!plain && (
                  <span className="hidden py-3.5 text-muted-foreground sm:block" aria-hidden="true">
                    <FoldChevron open={isOpen} />
                  </span>
                )}
              </button>
      {isOpen && (
                <div className="grid gap-1.5 border-t bg-muted/20 px-3 py-3 sm:px-5" data-testid="kr-detail">
                  {/* the whole status and target, cut to two lines in the row above: the full text on tap. */}
                  <div className="grid gap-1 rounded-md border bg-card px-2.5 py-2 text-sm" data-testid="kr-detail-status">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status now</span>
                    <KrNow r={r} full />
                    {r.target && (
                      <span className="text-xs text-muted-foreground">
                        Target <KrTarget r={r} full />
                      </span>
                    )}
                    <KrEvidence r={r} />
                    <KrFromLine r={r} full />
                  </div>
                  <p className="text-sm text-foreground">Work under this key result</p>
                  {!all.length && <p className="text-xs text-muted-foreground">Nothing is working on this yet. The Delivery Manager opens a row for it on the next wake.</p>}
                  {byRingColour(all.map((w) => ({ w, state: stateOfWork(w) }))).map(({ w, state: st }) => {
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
                    const hit = marked === w.code;
                    const cls = cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-md border bg-card px-2.5 py-2", hit && "border-foreground ring-1 ring-foreground");
                    const mark = hit ? { id: workAnchor(w.code), "data-marked": "1" } : {};
                    return href ? (
                      <Link key={`${w.repo}:${w.code}`} to={href} className={cn(cls, "hover:bg-accent/40")} data-testid="kr-work-item" data-state={st} {...mark}>
                        {inner}
                      </Link>
                    ) : (
                      <div key={`${w.repo}:${w.code}`} className={cls} data-testid="kr-work-item" data-state={st} {...mark}>
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
            ["unknown", "no data yet · greyed: not measured in the last day"],
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

/** (the owner: "a wheel without a persona is not going to turn"): no persona on it, or all of them switched off. */
export const NO_PERSONA_TITLE = { none: "No persona: this wheel does not turn.", off: "Its personas are switched off: it turns once one is switched on." } as const;
export function NoPersonaPill({ n, testId = "wheel-no-persona" }: { n: Pick<ScorecardNode, "noPersona">; testId?: string }) {
  if (!n.noPersona) return null;
  return (
    <span className={cn(PILL_SHAPE, n.noPersona === "none" ? "border border-[hsl(0_72%_51%)] bg-[hsl(0_72%_51%)] text-white" : "border border-border bg-transparent text-muted-foreground")} title={NO_PERSONA_TITLE[n.noPersona]} data-testid={testId}>
      {n.noPersona === "off" ? "persona off" : "no persona"}
    </span>
  );
}

/** every goal with no persona at all, any world: one line on the objectives screen, nothing when every goal has one. */
export function PersonaGapsLine() {
  const { data } = useQuery<PersonaGapsBody>(() => api.personaGaps(), [], { tag: "inbox" });
  const gaps = (data?.gaps ?? []).filter((g) => g.turner === "none");
  if (!gaps.length) return null;
  const n = gaps.length;
  return (
    <div className="rounded-xl border border-[hsl(0_72%_51%)] bg-card px-3 py-2.5 text-sm" data-testid="persona-gaps">
      <p className="font-medium text-foreground">
        {n} {n === 1 ? "goal has" : "goals have"} no persona. A wheel without a persona does not turn.
      </p>
      <ul className="mt-1 grid gap-0.5">
        {gaps.map((g) => (
          <li key={`${g.kind}:${g.id}`} className="flex flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere]" data-testid="persona-gap" data-kind={g.kind}>
            {g.milestoneId ? (
              <Link to={`/milestones/${g.milestoneId}`} className="text-foreground underline-offset-2 hover:underline">
                {g.title}
              </Link>
            ) : (
              <span className="text-foreground">{g.title}</span>
            )}
            <span className="text-xs text-muted-foreground">{g.kind === "objective" ? "objective" : "milestone"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** a goal's first screen: its wheel, its name and its one-line answer in one box edged by its light (objectives and milestones alike). */
export function GoalHeader({ rows, title, answer, children, testId = "set-answer-box" }: { rows: Pick<ScorecardRow, "state">[]; title: ReactNode; answer: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <header className="flex min-w-0 items-start gap-3 rounded-xl border border-l-[6px] bg-card p-3 shadow-sm sm:p-4" style={{ borderLeftColor: STATE_FILL[lightOf(rows)] }} data-testid={testId}>
      <SetWheel rows={rows} size={44} testId="set-wheel" />
      <div className="grid min-w-0 gap-1.5">
        <h1 className="text-xl font-semibold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-3xl" data-testid="set-objective">
          {title}
        </h1>
        <p className="text-[15px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere] sm:text-base" data-testid="set-answer">
          {answer}
        </p>
        {children}
      </div>
    </header>
  );
}

/**
 * One objective in the sidebar: only its name, its inbox pills and its colour circle (the owner 2026-11-13 20:03Z:
 * "Too much info on sidebar - we only need name, inbox and circle"); the strip and the child epics live on its page. The open one adds
 * nothing under its name: its Board, Inbox, Chat desk and Social kit are the tabs on its page (card check 2026-11-13).
 * Option A, the owner's pick of three mock-ups (vn_40ab2ea9: "avoid this effect where they're not in line ... lose the one, two, three"):
 * no numbers; the ring, then the product word over the goal, both on one left edge; the product word is coloured text with
 * no box (its padding broke the edge), the pills sit at the right of the product line and the goal may run under them.
 */
function SidebarObjective({ n, countFor, onNavigate, activeId }: { n: ScorecardNode; countFor: (id: string) => { ask: number; review: number }; onNavigate?: () => void; activeId?: string }) {
  const c = countFor(n.id);
  const krs = keyResultsOf(n);
  const active = activeId === n.id;
  const { product, goal } = splitObjectiveName(titleOf(n));
  return (
    <li className="grid min-w-0" data-testid="sidebar-set" data-set={n.id} data-depth={0}>
      <Link
        to={scorecardHref(n.id)}
        onClick={onNavigate}
        className={cn(
          "grid min-w-0 grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 rounded-md border-l-[3px] py-2 pl-2 pr-2.5",
          active ? "border-l-foreground bg-card shadow-sm ring-1 ring-border" : "border-l-transparent hover:bg-accent/60",
        )}
        title={`${titleOf(n)}: ${krs.filter((r) => r.state === "green").length} of ${krs.length} key results green`}
        aria-current={active ? "page" : undefined}
        data-testid="sidebar-set-link"
      >
        <span className="col-start-1 row-start-1 flex h-[18px] items-center" data-testid="sidebar-set-ring">
          <SetWheel rows={krs} size={18} testId="sidebar-set-wheel" />
        </span>
        <span className="col-start-2 row-start-1 min-w-0" data-testid="objective-name" data-layout="sidebar">
          {product ? (
            <span className={cn("block truncate text-[12px] font-semibold leading-[18px]", productText(product))} data-testid="objective-product" data-product={product}>
              {product}
              <span className="sr-only">: </span>
            </span>
          ) : (
            <span className="block text-[14px] font-medium leading-[18px] text-foreground [overflow-wrap:anywhere]" data-testid="objective-goal">
              {goal}
            </span>
          )}
        </span>
        <span className="col-start-3 row-start-1 flex h-[18px] shrink-0 items-center gap-1">
          <IdlePill n={n} testId="sidebar-set-idle" />
          <GoalPills c={c} to={scorecardHref(n.id, GOAL_INBOX_TAB)} onNavigate={onNavigate} />
        </span>
        {product ? (
          <span className="col-span-2 col-start-2 row-start-2 min-w-0 text-[14px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="objective-goal">
            {goal}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/** the sidebar, both skins: All objectives on top (every key result, the combined inbox), then each objective in his order, nested. */
export function SidebarGoalSets({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useGoalSets();
  return <SidebarGoalSetsOf data={data} onNavigate={onNavigate} />;
}

/**
 * the same, on objectives the caller already read: the Objectives heading (it opens every objective), then every
 * objective in his order, one list, never a second tier (the owner: "I don't like this kind of
 * distinction between objectives and more objectives ... These are all objectives, you know, and they're sorted"), then
 * `footer` (Add objective). The goals no objective holds are not objectives:
 * the caller draws them apart (Layout's Other goals fold, beside Tools).
 */
export function SidebarGoalSetsOf({
  data,
  onNavigate,
  footer,
  products = true,
}: {
  data: ScorecardsBody | undefined;
  onNavigate?: () => void;
  footer?: ReactNode;
  /** the Products link (the social skin keeps it; the console's sidebar dropped it). */
  products?: boolean;
}) {
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
        className={({ isActive }) => cn("mt-1 flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-sm", isActive ? "bg-card font-semibold text-foreground shadow-sm ring-1 ring-border" : "bg-card/60 font-semibold text-foreground hover:bg-accent/60")}
        title={SET_NAME.all}
        data-testid="sidebar-goal-sets-all"
      >
        <span className="min-w-0 flex-1">{SET_NAME.many}</span>
        {/* every key result of every objective; the inbox's own pills sit on Inbox above. */}
        <span className="shrink-0 text-xs font-normal text-muted-foreground" data-testid="sidebar-all-counts" title={`${asks} asks and ${reviews} cards wait on you across them`}>
          {krs.filter((r) => r.state === "green").length} green · {krs.filter((r) => r.state === "red").length} red
        </span>
      </NavLink>
      <ul className="grid min-w-0 gap-1" data-testid="sidebar-objectives">
        {/* his order, unnumbered (the owner picked A, "lose the one, two, three") */}
        {top.map((n) => (
          <SidebarObjective key={n.id} n={n} countFor={countFor} onNavigate={onNavigate} activeId={activeId} />
        ))}
      </ul>
      {footer}
      {/* each product defined once; its objectives and its social kit read it there. */}
      {products && (
        <NavLink
          to={`/${PRODUCTS_PATH}`}
          onClick={onNavigate}
          className={({ isActive }) => cn("mt-1 flex min-h-9 min-w-0 items-center rounded-md px-2.5 text-sm", isActive ? "bg-card font-semibold text-foreground ring-1 ring-border" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
          data-testid="sidebar-products"
        >
          Products
        </NavLink>
      )}
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
              <Link to={r.node ? scorecardHref(r.node.id, "inbox") : "/"} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-3 py-2.5 hover:bg-accent/40">
                <Dot state={r.kind === "ask" ? "red" : "green"} />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground [overflow-wrap:anywhere]">{r.title}</span>
                  <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {r.kind === "ask" ? "waiting on you" : "ready for your review"}
                    {/* its age right after what it is, the one CardAge every card shows */}
                    {r.since && cardAgeWords(r.since) ? <> · <CardAge iso={r.since} what="reached your inbox" /></> : null}
                    {showSet ? ` · ${r.pursuit ? (r.node && r.node !== r.pursuit ? `${titleOf(r.pursuit)} › ${titleOf(r.node)}` : titleOf(r.pursuit)) : `outside every ${SET_NAME.one.toLowerCase()}`}` : r.node ? ` · ${r.node.name}` : ""}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- tabs ----------

/**
 * Every objective page is the same class of thing with the same tabs (the owner, vn_e6655c98, root L-100: "each objective
 * is the same class of thing and it should have the same class of tabs ... these fixed points of knowledge corresponds
 * to tabs in this key results page"). The tabs come from the product's data graph (the owner: "these tabs depend on the
 * data graph of the product"), one tab per kind of node its personas need, read from the hosted layer (lib/wheelTabs.ts):
 * ten in his order (Key results, Plan, Inbox, Chat, Personas, Board, Context, Pages, Trackers, Log; Log on his 24 Nov
 * word), never a list written here.
 * What one product has and another has not (a launch board, a feature list, a product deck, a social kit) is content
 * inside one of these tabs (TOTEM_HOME), never a tab of its own; an empty tab says what goes there.
 */
export const OBJECTIVE_TABS = wheelTabsOf("objective");
type Tab = string;
/** the tab each product totem and extra lives inside: the launch board on the Board, the social kit in the Plan, the
 * product deck, pricing, feature list and lean core (and any totem not named here) in the Context. */
export const TOTEM_HOME: Record<string, Tab> = {
  launch: "kanban",
  kit: "plan",
  product: "context",
  pricing: "context",
  features: "context",
  core: "context",
};
/** a totem's home tab: its own when it is one of the nine (Plan, Key results, Inbox, Pages, Trackers), else TOTEM_HOME. */
export const homeOfTotem = (tab: string): Tab => (OBJECTIVE_TABS.find((t) => t.id === tab)?.id ?? TOTEM_HOME[tab] ?? "context") as Tab;
/**
 * the old milestone page's tabs, folded into the objective's own (vn_748ec5a1): Summary is Key results, Waiting on you is
 * Inbox, Tree and Backlog are the Board, Chat is the Chat desk, Definition, Deck and Approvals are Context, Activity
 * and Settings (pause) are Personas. The old extra tabs (Product, Pricing, Launch board, Feature list, Social kit) open
 * the tab that holds them now. A link carrying an old tab opens the tab that does its job now.
 */
export const OLD_TAB_TO_OBJECTIVE: Record<string, Tab> = {
  ...TOTEM_HOME,
  summary: "table",
  waiting: "inbox",
  tree: "kanban",
  // the Board by its own name: ?tab=board opens it (it fell back to Key results).
  board: "kanban",
  backlog: "kanban",
  chat: "chat",
  definitions: "context",
  overview: "context",
  deck: "context",
  approvals: "context",
  activity: "personas",
  settings: "personas",
  personas: "personas",
};
export function objectiveTab(asked: string | null): Tab {
  return (OBJECTIVE_TABS.find((t) => t.id === asked)?.id ?? (asked ? OLD_TAB_TO_OBJECTIVE[asked] : undefined) ?? "table") as Tab;
}
const ALL_TABS = [
  { id: "table", label: "Key results" },
  { id: "inbox", label: "Combined inbox" },
  { id: "chat", label: "Team desk" },
] as const;

/** a tab's link: ?tab=<id> (none for the first), plus the params kept across tabs (a milestone goal's picked ?node=). */
const tabTo = (id: string, keep?: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  if (id !== "table") q.set("tab", id);
  for (const [k, v] of Object.entries(keep ?? {})) if (v) q.set(k, v);
  return `?${q}`;
};

/** a tab's count as a quiet grey pill: a number that changes, never part of the tab's name (vn_15aa4467: "make the 29
 * look distinctly a different thing. It can stay gray ... make it clear that it's a variable, it's not a label"). */
export function TabCount({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums leading-5 text-muted-foreground" data-testid="tab-count">
      {n}
    </span>
  );
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/**
 * the dates his key results are due by, read from their targets ("5 testers by 8 Dec"), soonest first: the key dates
 * he asked for on the objective (vn_15aa4467: "something like urgency or deadline, or timeline, or key dates").
 */
export function keyDatesOf(krs: Pick<ScorecardRow, "label" | "target">[]): { day: string; label: string }[] {
  const out: { day: string; label: string; at: number }[] = [];
  for (const r of krs) {
    const m = /\bby (?:[A-Z][a-z]+day )?(\d{1,2}) ([A-Za-z]{3})[a-z]*\b/.exec(r.target ?? "");
    const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
    if (!m || mon < 0) continue;
    out.push({ day: `${Number(m[1])} ${m[2][0].toUpperCase()}${m[2].slice(1, 3).toLowerCase()}`, label: r.label, at: mon * 32 + Number(m[1]) });
  }
  return out.sort((a, b) => a.at - b.at).map(({ day, label }) => ({ day, label }));
}

/** `links`: tabs that open another page (the social skin's Home: Inbox), drawn after the page's own tabs. */
export function TabStrip({ tabs, tab, counts, pills, links, keep, label = `${SET_NAME.one} pages` }: { tabs: readonly { id: string; label: string }[]; tab: string; counts?: Partial<Record<string, number>>; pills?: Partial<Record<string, { ask: number; review: number }>>; keep?: Record<string, string | undefined>; links?: Record<string, { label: string; to: string; count?: number }>; label?: string }) {
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
          to={tabTo(t.id, keep)}
          replace
          className={cn("-mb-px flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm sm:min-h-10 sm:px-1", tab === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          aria-current={tab === t.id ? "page" : undefined}
          data-testid={`set-tab-${t.id}`}
        >
          {t.label}
          {counts?.[t.id] ? <TabCount n={counts[t.id]!} /> : null}
          {/* the same red and green pills as the goal's sidebar entry (GoalPills), here on the tab they open. */}
          {pills?.[t.id] ? <GoalPills c={pills[t.id]!} ids={{ ask: `tab-${t.id}-asks`, review: `tab-${t.id}-review` }} /> : null}
        </Link>
      ))}
      {Object.entries(links ?? {}).map(([id, l]) => (
        <Link key={id} to={l.to} className="-mb-px flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground sm:min-h-10 sm:px-1" data-testid={`set-tab-${id}`}>
          {l.label}
          {l.count ? <TabCount n={l.count} /> : null}
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
            <ObjectiveName name={titleOf(n)} layout="inline" />
          </Link>
        </span>
      ))}
    </nav>
  );
}

/** Kanban: Ready, Running, Waiting from the spines' ledgers, Review from the inbox's cards. */
function Kanban({ body, node, reviews }: { body: ScorecardsBody; node: ScorecardNode; reviews: InboxRow[] }) {
  const q = boardOf(body, node);
  const cols: { id: string; title: string; items: { key: string; code?: string; title: string; sub?: string; href?: string; since?: string }[] }[] = [
    { id: "ready", title: "Ready", items: q.filter((r) => r.state === "ready").map((r) => ({ key: `${r.repo}:${r.code}`, code: r.code, title: r.title, sub: r.epicCode ?? r.epic })) },
    { id: "running", title: "Running", items: q.filter((r) => r.state === "running").map((r) => ({ key: `${r.repo}:${r.code}`, code: r.code, title: r.title, sub: r.status })) },
    { id: "waiting", title: "Waiting", items: q.filter((r) => r.state === "waiting").map((r) => ({ key: `${r.repo}:${r.code}`, code: r.code, title: r.title, sub: r.status })) },
    { id: "review", title: "Your review", items: reviews.map((r) => ({ key: r.id, code: r.code, title: r.title, href: scorecardHref(node.id, "inbox"), since: r.since })) },
  ];
  // an empty Board says what goes there in one plain line (root L-100: every tab is a fixed point of knowledge).
  if (cols.every((c) => !c.items.length))
    return (
      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="set-kanban" data-empty="yes">
        Nothing is being built for this {SET_NAME.one.toLowerCase()} yet. Its ready, running and waiting rows and your reviews show here.
      </p>
    );
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
                <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {/* a card waiting on him shows its age first, the one CardAge */}
                  {i.since && cardAgeWords(i.since) ? <><CardAge iso={i.since} what="reached your inbox" />{i.code || i.sub ? " · " : ""}</> : null}
                  {[i.code, i.sub].filter(Boolean).join(" · ")}
                </span>
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
  // the desk answered and none of its lines is about this objective: that is an empty view, never "Loading the chat…".
  if (!out.length && chat.messages.length) return { ...chat, messages: out, stale: false, unreachable: undefined, t3: undefined };
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
            {node.objective ?? node.headline ?? pursuit.objective}
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
      {node.milestoneId && <ObjectiveApprovals milestoneId={node.milestoneId} />}
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
  // one objective, one screen (vn_748ec5a1): its personas switch on or off right here, never on a second page.
  // only this objective's personas, its Delivery Manager first (several objectives share one milestone)
  if (node.kind === "pursuit") return <ObjectivePersonas milestoneId={node.milestoneId} objective={{ id: node.id, shared: node.milestoneShared }} fallback={<TeamsList node={node} />} />;
  if (node.milestoneId) return <ObjectivePersonas milestoneId={node.milestoneId} />;
  return <TeamsList node={node} />;
}

function TeamsList({ node }: { node: ScorecardNode }) {
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
    </div>
  );
}

export function GoalSetPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const baseTab = objectiveTab(params.get("tab"));
  const { data: pursuitsBody } = usePursuits();
  const totemMaps = useTotemMaps();
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
    if (!node) return;
    // a ticket from Search (?row=) first, else its key result.
    const row = params.get("row");
    const el = (row ? document.getElementById(workAnchor(row)) : null) ?? (kr ? document.getElementById(`kr-${encodeURIComponent(kr)}`) : null);
    el?.scrollIntoView?.({ block: "center" });
  }, [kr, node, params]);
  const pursuit = node ? inbox.ix.pursuitOf.get(node.id)! : undefined;
  const mine = node ? inbox.rows.filter((r) => inScorecard(inbox.ix, node.id, r.item)) : [];
  // the sidebar's own count (useSetInbox countFor), so its pills and this Inbox tab's never differ.
  const counts = node ? inbox.countFor(node.id) : { ask: 0, review: 0 };
  const rows = node ? rowsWithInbox(node, inbox.loading ? undefined : counts) : [];
  const krs = node ? keyResultsOf(node) : [];
  const only = useCallback((i: Placeable) => !!node && inScorecard(inbox.ix, node.id, i), [node, inbox.ix]);
  const kitId = pursuit ? kitPursuitOf(pursuitsBody?.pursuits, pursuit.id) : undefined;
  const pursuitP = pursuit ? pursuitsBody?.pursuits.find((x) => x.id === pursuit.id) : undefined;
  // root L-77: the objective's product map names its hardwired totems; each one is content inside the tab that is its
  // home (TOTEM_HOME), never a tab of its own: every objective shows the same nine tabs (root L-100, vn_e6655c98).
  const productMap = productOfObjective(totemMaps.data, pursuit?.id, pursuitP?.product?.id);
  // the social kit totem is drawn by the kit view itself when the objective has a kit, never twice.
  const homed = (home: Tab) => productMap?.totems.filter((t) => !OBJECTIVE_TABS.some((x) => x.id === t.tab) && !(t.tab === "kit" && kitId) && homeOfTotem(t.tab) === home) ?? [];
  // his order, numbered (vn_15aa4467: "I could say priority 5, priority 10"): the same number as the sidebar's.
  const priority = node && node.kind === "pursuit" ? topObjectives(data?.nodes).findIndex((n) => n.id === node.id) + 1 : 0;
  const dates = keyDatesOf(krs);
  const tab: Tab = baseTab;
  // an old link to an extra's own tab (?tab=launch) opens its home tab and brings that part into view.
  const askedTab = params.get("tab");
  useEffect(() => {
    if (askedTab && TOTEM_HOME[askedTab] && productMap) document.getElementById(`totem-${askedTab}`)?.scrollIntoView?.({ block: "start" });
  }, [askedTab, productMap]);
  const pagesList = useWheelPages();
  const myPages = useMemo(() => (node ? pagesOfObjective(pagesList.data, data, inbox.ix, node.id) : []), [pagesList.data, data, inbox.ix, node]);
  // the pages and notes kept in the repo for this objective (every file the Pages tab homes), read on that tab.
  // read on every tab: the Pages pill counts them too, so it never shows fewer than the tab holds.
  const homeFiles = useHomeTab("all", "pages");
  const myFiles = useMemo(() => (node ? homeFilesOf(homeFiles.data?.entries, inbox.ix, node.id) : []), [homeFiles.data, inbox.ix, node]);
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
          {/* an old link to the objective's Social kit (?tab=kit) opens the kit where it lives now: on its product. */}
          {askedTab === "kit" && pursuitP?.product && <Navigate replace to={productHref(pursuitP.product.id, "kit")} />}
          <GoalHeader
            rows={krs}
            title={
              <ObjectiveName name={titleOf(node)} after={node.objectiveStatus === "proposed" && <ProposedMark />} />
            }
            answer={krAnswer(krs)}
          >
            {(priority > 0 || dates.length > 0) && (
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground" data-testid="set-priority-dates">
                {priority > 0 && (
                  <span data-testid="set-priority">
                    Priority <span className="font-semibold tabular-nums text-foreground">{priority}</span>
                  </span>
                )}
                {dates.length > 0 && (
                  <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="set-key-dates">
                    Key dates:{" "}
                    {dates.map((d, i) => (
                      <span key={d.label}>
                        {i > 0 && " · "}
                        <span className="font-semibold text-foreground">{d.day}</span> {d.label}
                      </span>
                    ))}
                  </span>
                )}
              </p>
            )}
            {/* the product this objective promotes, written once, and its social kit: one tap from the objective in both
                skins (the owner: no page without a way to it). */}
            {pursuitP?.product && (
              <p className="text-xs text-muted-foreground" data-testid="set-product">
                Product{" "}
                <Link to={productHref(pursuitP.product.id)} className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground" data-testid="set-product-link">
                  {pursuitP.product.name}
                </Link>
                {" · "}
                <Link to={productHref(pursuitP.product.id, "kit")} className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground" data-testid="set-product-kit">
                  Social kit
                </Link>
              </p>
            )}
            {/* an objective held inside another says so and links its holder: its own page keeps only its own work. */}
            {node.foldedInto && inbox.ix.byId.get(node.foldedInto) && (
              <p className="text-xs text-muted-foreground" data-testid="set-held-in">
                Held inside{" "}
                <Link to={`/sets/${encodeURIComponent(node.foldedInto)}`} className="font-medium text-foreground underline underline-offset-4">
                  {titleOf(inbox.ix.byId.get(node.foldedInto)!)}
                </Link>
                : the two share one wheel, each with its own key results.
              </p>
            )}
            <span className="inline-flex flex-wrap items-center gap-2">
              <DailyBriefingSwitch id={node.id} />
              <ObjectiveOffButton id={node.id} openBoxes={node.children.reduce((n, c) => n + Math.max(0, c.total - c.greens), 0)} />
            </span>
          </GoalHeader>
          <TabStrip tabs={OBJECTIVE_TABS} tab={tab} pills={{ inbox: counts }} counts={{ kanban: boardOf(data, node).length + counts.review, ...(pagesList.data ? { pages: myPages.length + myFiles.length } : {}) }} />
          {/* each tab is a property of the objective; the made-of screen says what each holds and where it lives. */}
          <div className="-mt-2 flex justify-end">
            <MadeOfLink kind="objective" />
          </div>
          {tab === "table" && (
            <div className="grid gap-4">
              {/* a ticket found by Search opens here with ?row=<code>: its line is marked and brought into view. */}
              <KeyResultSheet krs={krs} setId={pursuit.id} open={kr} onOpen={openKr} marked={params.get("row")} />
              <UnplacedTickets node={node} setId={pursuit.id} marked={params.get("row")} />
              <ProgressLine today={data?.progress?.sets[pursuit.id]?.today} week={data?.progress?.sets[pursuit.id]?.week} since={data?.progress?.since} />
              {/* how it lives in its spine, after the sheet: the key results are the first thing he sees (17:57Z). */}
              <SpineLine node={node} krs={krs} />
              {/* every row measured for it (12 to 26, vn_fd4f7a7a) stays one tap away, under the key results. */}
              <details className="group rounded-xl border bg-card/50" data-testid="set-all-rows" open={!!kr && !krs.some((k) => k.label === kr)}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm text-muted-foreground hover:text-foreground">
                  <FoldChevron />
                  All {rows.length} measured rows
                </summary>
                <div className="p-2 pt-0">
                  <RowsTable rows={rows} setId={pursuit.id} open={kr} onOpen={openKr} />
                </div>
              </details>
            </div>
          )}
          {tab === "kanban" && (
            <div className="grid gap-6">
              {/* the launch board: what must be true before the product launches, inside the Board (root L-100). */}
              {/* only on the objective that names its launch board itself, never every objective of the product. */}
              {productMap && namesLaunchBoard(pursuitP?.totems) && homed("kanban").map((t) => <HomedTotem key={t.id} product={productMap.product} totem={t} />)}
              <Kanban body={data!} node={node} reviews={mine.filter((r) => r.kind === "review")} />
            </div>
          )}
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
          {tab === "context" &&
            (node.kind === "pursuit" ? (
              // an objective's Context is its one where-we-are and nothing else: no product page, pricing or feature list,
              // which belong to a campaign (the owner: "What the fuck is this doing here?").
              <div className="grid gap-6" data-testid="set-context">
                <WhereWeAreBox id={node.id} />
              </div>
            ) : (
              <Context node={node} pursuit={pursuit} />
            ))}
          {tab === "personas" && <Personas node={node} />}
          {/* the wheel's plan and nothing else: a social kit or marketing material stays on its campaign. */}
          {tab === "plan" && <WheelPlanTab id={pursuit.id} keyResults={keyResultsOf(node)} />}
          {tab === "trackers" && <TrackersTab wheel={pursuit.id} />}
          {tab === "log" && <PersonaLogTab wheel={pursuit.id} />}
          {tab === "pages" && <WheelPagesTab pages={myPages} loading={pagesList.loading} what={SET_NAME.one.toLowerCase()} files={{ entries: myFiles, loading: homeFiles.loading }} />}
        </>
      )}
    </div>
  );
}

/** a product totem shown inside its home tab, with an anchor so an old ?tab=<its id> link scrolls to it. */
function HomedTotem({ product, totem }: { product: string; totem: Totem }) {
  return (
    <div id={`totem-${totem.tab}`} className="scroll-mt-4" data-testid="homed-totem" data-tab={totem.tab}>
      <TotemTab product={product} totem={totem} />
    </div>
  );
}

// ---------- all sets: the team desk spanning all ----------

// his briefing, loaded when the screen shows; its file reads this one's parts.
const BriefingSlot = lazyPage(() => import("@/components/briefing"), "BriefingSlot", null);
// the last briefings' pictures, under the Briefing button.
const LastBriefings = lazyPage(() => import("@/components/lastBriefings"), "LastBriefings", null);

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
            {/* one grid per row (the owner's phone 17 Nov: "Alignment off on the traffic's line"): [chevron][light][number
                label goal / bars][count][arrow], every cell on the name's first line, the count slot the same width on every
                row so the name column is too; the hover shade (only where there is a mouse, never stuck after a tap) and the
                open shade cover the whole row. */}
            <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start [@media(hover:hover)]:hover:bg-accent/30", isOpen && "bg-accent/30")} data-testid="wheel-row-grid">
              {(() => {
                const inner = (
                  <>
                    <span className="flex min-h-6 items-center text-muted-foreground" aria-hidden={lead ? undefined : true}>
                      {lead ? lead(n) : <FoldChevron open={isOpen} />}
                    </span>
                    <span className="flex h-6 items-center">
                      <TrafficLight light={light} testId="wheel-light" />
                    </span>
                    <span className="grid min-w-0 gap-1.5">
                      {/* the number, the product label and the goal run as one line of text that wraps back to this column's
                          left edge: nothing hangs, a name breaks between words, never one letter per line. */}
                      <span className="text-[15px] font-medium leading-6 text-foreground [overflow-wrap:break-word]" data-testid="wheel-name">
                        <span className="mr-1.5 tabular-nums text-muted-foreground" data-testid="wheel-number">
                          {i + 1}.
                        </span>
                        <ObjectiveName name={titleOf(n)} layout="flow" />
                      </span>
                      {/* lean rows (the owner 13 Nov 21:46Z: "only the colors and pills is enough, the small gray stuff you can remove"): name, colour bar, pills. */}
                      <KrStrip rows={krs} fit />
                      {(n.noPersona || n.idle?.idle || n.objectiveStatus === "proposed") && (
                        <span className="flex flex-wrap items-center gap-1 [&>[data-testid=objective-proposed]]:ml-0" data-testid="wheel-status-pills">
                          {n.objectiveStatus === "proposed" && <ProposedMark />}
                          <NoPersonaPill n={n} />
                          <IdlePill n={n} />
                        </span>
                      )}
                    </span>
                  </>
                );
                const cls = "grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-2 py-3 pl-3 text-left sm:gap-x-3";
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
              <span className="flex items-start gap-1 py-3 pl-2 pr-1 sm:pr-2">
                <span className="flex min-h-6 min-w-6 flex-col items-end justify-center gap-1 sm:flex-row sm:items-center" data-testid="wheel-counts">
                  {c.ask > 0 && <CountPill count={c.ask} tone="needs-you" title={PILL_TITLES["needs-you"](c.ask)} />}
                  {c.review > 0 && <CountPill count={c.review} tone="review" title={PILL_TITLES.review(c.review)} />}
                </span>
                <Link to={hrefOf(n)} className="-my-2 grid h-10 w-9 place-items-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground sm:w-10" aria-label={`Open ${titleOf(n)}`} data-testid="wheel-open">
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

/** what his order does, said once on the objectives screen. */
export const ORDER_RULE = "Your order decides what goes first: a higher objective's cards come first in your inbox, and its ready work gets workers first.";

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
      {/* the owner asked: "is the order of my objectives used at all?": the rule, in one line. */}
      {tab === "table" && (
        <p className="text-sm text-muted-foreground" data-testid="objective-order-rule">
          {ORDER_RULE}
        </p>
      )}
      {tab === "table" && data && <BriefingSlot nodes={sets.map((x) => x.n)} kind="objective" />}
      {tab === "table" && <LastBriefings />}
      {tab === "table" && <PersonaGapsLine />}
      {tab === "table" && (
        <WheelsTable nodes={sets.map((x) => x.n)} countFor={inbox.countFor} />
      )}
      {tab === "table" && <InactiveObjectives />}
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
