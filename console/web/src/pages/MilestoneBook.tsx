import { useEffect } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, type BookState, type MilestoneBook } from "@/api";
import { useLiveBook } from "@/lib/useLiveBook";
import { BOOK_PATH, STATE_DOT, STATE_FILL, STATE_LABEL, day, planRows } from "@/lib/book";
import { Card } from "@/components/ui/card";
import { Capabilities } from "@/pages/Book";
import { Empty, ErrorBox, Loading, PageHeader, RelTime } from "@/components/common";
import { formatDateTime } from "@/lib/format";
import { MadeList } from "@/components/bookMade";
import { deckCodeOf, deckHref } from "@/lib/deck";

/**
 * one milestone's Epic Book, the human page (the spine is for agents). Goal, where we are, the
 * plan and where we are in it, next steps, in plain words written on the server from the spine's Goal, Done means and
 * Current State (GET /api/book/:key, book/milestone.ts); both diagrams are drawn here from that data, never by hand.
 * `/book/<milestone id>`; `/book/<repo>` opens the repo's root milestone. Agreed order (Decisions): Goal, Where
 * we are, Plan, Next steps, then's "Everything made for this" (section id `made`, one fold per epic), then's
 * capabilities table (section id `capabilities`, the code repo's book), then Lately.
 */
export const MILESTONE_BOOK_PATH = `${BOOK_PATH}/:key`;

const ROW = 36;
const W = 640;

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <Card id={id} className="min-w-0 p-4" data-testid={`mbook-section-${id}`}>
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

/** The Done means as a track: one stop per goal, filled when met; the first open one is "we are here". */
export function GoalTrack({ goals }: { goals: MilestoneBook["narrative"]["goals"] }) {
  if (!goals.length) return null;
  const gap = 34;
  const w = Math.max(200, goals.length * gap + 24);
  const here = goals.findIndex((g) => !g.done);
  const label = (id: string) => id.replace(/^.*?-(?=\d+$)/, "") || id;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} 58`} className="h-auto" style={{ width: Math.min(w, 720), minWidth: Math.min(w, 320) }} role="img" aria-label={`${goals.filter((g) => g.done).length} of ${goals.length} goals met`} data-testid="mbook-track">
        <line x1={24} x2={24 + (goals.length - 1) * gap} y1={20} y2={20} className="stroke-border" strokeWidth={3} />
        {goals.map((g, i) => (
          <g key={g.id}>
            <title>{`${g.id}: ${g.text}${g.done ? " (met)" : ""}`}</title>
            {i === here && <circle cx={24 + i * gap} cy={20} r={13} className="fill-none stroke-amber-500" strokeWidth={2.5} />}
            <circle cx={24 + i * gap} cy={20} r={8} className={g.done ? "fill-sky-500" : "fill-background stroke-muted-foreground"} strokeWidth={g.done ? 0 : 2} />
            <text x={24 + i * gap} y={50} textAnchor="middle" className="fill-muted-foreground" fontSize={11}>
              {label(g.id)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** The plan as a tree diagram from the spines under the milestone: open epics drawn, closed ones folded per parent. */
export function PlanDiagram({ tree }: { tree: MilestoneBook["tree"] }) {
  const rows = planRows(tree);
  if (rows.length < 2) return null;
  const h = rows.length * ROW + 8;
  const xOf = (d: number) => 8 + d * 22;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${h}`} className="h-auto w-full min-w-[560px]" role="img" aria-label="The plan: the project and the epics under it" data-testid="mbook-plan">
        {rows.map((r, i) => {
          if (r.parent < 0) return null;
          const px = xOf(rows[r.parent].depth) + 10;
          const py = r.parent * ROW + 4 + 28;
          const y = i * ROW + 4 + 14;
          return <path key={`c${r.key}`} d={`M${px},${py} V${y} H${xOf(r.depth)}`} className="fill-none stroke-border" strokeWidth={1.5} />;
        })}
        {rows.map((r, i) => {
          const x = xOf(r.depth);
          const y = i * ROW + 4;
          const bw = W - x - 8;
          const folded = !r.code;
          const right = r.dod?.total ? `${r.dod.done}/${r.dod.total}` : "";
          const room = Math.floor((bw - 24 - (r.code ? r.code.length * 7.5 + 8 : 0) - (right ? 64 : 0) - (r.hidden ? 70 : 0)) / 6.6);
          const title = r.title.length > room ? `${r.title.slice(0, Math.max(room - 1, 4))}…` : r.title;
          return (
            <g key={r.key} data-testid="mbook-plan-row" data-state={r.state}>
              <title>{`${r.code ? `${r.code} ` : ""}${r.title} (${STATE_LABEL[r.state]})`}</title>
              <rect x={x} y={y} width={bw} height={28} rx={6} className={folded ? "fill-muted stroke-border" : "fill-card stroke-border"} strokeDasharray={folded ? "4 3" : undefined} />
              <rect x={x} y={y} width={6} height={28} rx={3} className={STATE_FILL[r.state]} />
              <text x={x + 14} y={y + 18.5} fontSize={13} className={folded ? "fill-muted-foreground" : "fill-foreground"}>
                {r.code && (
                  <tspan fontFamily="ui-monospace, monospace" fontSize={12} className="fill-muted-foreground">
                    {r.code}{" "}
                  </tspan>
                )}
                <tspan fontWeight={r.depth === 0 ? 600 : 400}>{title}</tspan>
                {r.hidden ? <tspan className="fill-muted-foreground" fontSize={11}>{`  +${r.hidden} below`}</tspan> : null}
              </text>
              {right && (
                <g>
                  <rect x={x + bw - 72} y={y + 11} width={30} height={6} rx={3} className="fill-muted" />
                  <rect x={x + bw - 72} y={y + 11} width={(30 * r.dod!.done) / r.dod!.total} height={6} rx={3} className="fill-sky-500" />
                  <text x={x + bw - 8} y={y + 18} fontSize={11} textAnchor="end" className="fill-muted-foreground">
                    {right}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {(["moving", "stuck", "parked", "done"] as BookState[]).map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATE_DOT[s]}`} />
          {s === "stuck" ? "waiting on someone" : STATE_LABEL[s]}
        </span>
      ))}
      <span>· n/m = goals met</span>
    </span>
  );
}

/** last updated (the newest of the spine, the capability probe and the daily refresh); stale past 2 days. */
function LastUpdated({ u }: { u: NonNullable<MilestoneBook["updated"]> }) {
  const parts = [
    u.spineAt && `spine changed ${formatDateTime(u.spineAt)}`,
    u.probeAt && `capabilities probed ${formatDateTime(u.probeAt)}`,
    u.refreshedAt && `daily refresh ${formatDateTime(u.refreshedAt)}`,
  ].filter(Boolean);
  return (
    <span
      data-testid="mbook-updated"
      title={parts.join(" · ") || "no spine change, probe or refresh recorded"}
      className={u.stale ? "rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-800 dark:bg-red-950 dark:text-red-300" : "font-medium text-foreground"}
    >
      {u.stale ? "Stale: last updated " : "Last updated "}
      {u.at ? (
        <>
          {formatDateTime(u.at)} (<RelTime iso={u.at} />)
        </>
      ) : (
        "never"
      )}
      {u.stale && ", over 2 days ago: the daily refresh has not run"}
    </span>
  );
}

/**
 * everything made, one fold per epic: the milestone's own open, each epic under it folded with its count (root
 * L-39), in tree order; epics with nothing linked yet are named on one line.
 */
function Made({ made }: { made: NonNullable<MilestoneBook["made"]> }) {
  const withItems = made.filter((m) => m.items.length);
  const empty = made.filter((m) => !m.items.length && m.depth > 0);
  const total = withItems.reduce((a, m) => a + m.items.length, 0);
  return (
    <Section id="made" title={`Everything made for this (${total})`}>
      <p className="mb-3 text-sm text-muted-foreground">
        Every mockup, deck, proposal, live page and piece of evidence, newest first, kept from the spines as the work goes. A link that stopped answering is marked, never removed.
      </p>
      <div className="grid gap-2" data-testid="mbook-made">
        {withItems.map((m) => (
          <details key={m.path} open={m.depth === 0} className="min-w-0 rounded-md border" data-testid="mbook-made-epic" style={{ marginLeft: `${Math.min(m.depth, 3) * 0.75}rem` }}>
            <summary className="flex cursor-pointer items-baseline gap-2 px-3 py-2 max-sm:min-h-11">
              <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${STATE_DOT[m.state]}`} />
              <span className="font-mono text-xs text-muted-foreground">{m.code}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{m.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{m.items.length}</span>
            </summary>
            <div className="border-t px-3 py-2">
              <MadeList items={m.items} />
            </div>
          </details>
        ))}
      </div>
      {empty.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Nothing linked yet in {empty.map((m) => m.code).join(", ")}.</p>}
    </Section>
  );
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function MilestoneBookPage() {
  const key = useParams().key ?? "";
  const { data, error, loading } = useLiveBook(() => api.getMilestoneBook(key), [key], `epic-book:${key}`); // rework
  // `/book/<id>#where` (an ask's Epic Book link) scrolls to its section once the book has rendered; the browser's own
  // hash scroll runs before the async content exists.
  const hash = useLocation().hash.slice(1);
  const ready = !!data?.book;
  useEffect(() => {
    if (!hash || !ready) return;
    document.getElementById(safeDecode(hash))?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [hash, ready]);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const b = data?.book;
  if (!b)
    return (
      <div>
        <PageHeader title="Epic Book" />
        <Empty>The first book is being built from the spines; it appears here by itself in a few seconds.</Empty>
      </div>
    );
  const n = b.narrative;
  const commitHref = (sha: string) => (b.repo.remote ? `https://github.com/${b.repo.remote}/commit/${sha}` : undefined);
  return (
    <div className="min-w-0">
      <PageHeader
        title={`${b.milestone.title}: Epic Book`}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Goals, where we are, the plan and what is next. Written from the spine and git, <RelTime iso={b.builtAt} />
              {data?.building && " (refreshing)"}.
            </span>
            {b.updated && <LastUpdated u={b.updated} />}
            <Link to={deckHref(b.repo.name, deckCodeOf(b.milestone.code, b.milestone.path))} className="underline" data-testid="mbook-deck">
              Epic deck
            </Link>
            <Link to={`/milestones/${b.milestone.id}`} className="underline">
              Open the project
            </Link>
            <Link to={`/${BOOK_PATH}?repo=${encodeURIComponent(b.repo.name)}`} className="underline">
              Every epic in {b.repo.name}
            </Link>
            {b.milestone.href && (
              <a href={b.milestone.href} target="_blank" rel="noreferrer" className="underline">
                The spine
              </a>
            )}
          </span>
        }
      />
      <div className="grid max-w-3xl gap-4">
        <Section id="goal" title="The goal">
          {n.goal ? <p className="text-[15px] leading-relaxed">{n.goal}</p> : <p className="text-sm text-muted-foreground">The spine has no Goal yet.</p>}
          {n.outcome && (
            <p className="mt-2 text-sm">
              <span className="font-medium">Outcome:</span> {n.outcome}
            </p>
          )}
        </Section>
        <Section id="where" title="Where we are">
          <ul className="grid gap-1.5 text-[15px] leading-relaxed" data-testid="mbook-where">
            {n.whereWeAre.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </Section>
        <Section id="plan" title="The plan, and where we are in it">
          {n.goals.length > 0 && (
            <div className="mb-4 grid gap-2">
              <p className="text-sm text-muted-foreground">It is done when all of these are true ({n.goals.filter((g) => g.done).length} of {n.goals.length} met; the ringed stop is where we are):</p>
              <GoalTrack goals={n.goals} />
              <ol className="grid gap-1 text-sm" data-testid="mbook-goals">
                {n.goals.map((g) => (
                  <li key={g.id} className="flex gap-2">
                    <span aria-label={g.done ? "met" : "open"} className={g.done ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground"}>
                      {g.done ? "✓" : "○"}
                    </span>
                    <span className={g.done ? "text-muted-foreground" : ""}>{g.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {b.tree.length > 1 && (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">The work under it, open epics first:</p>
              <PlanDiagram tree={b.tree} />
              <Legend />
            </div>
          )}
        </Section>
        <Section id="next" title="Next steps">
          {n.next.length ? (
            <ul className="grid gap-1.5 text-sm" data-testid="mbook-next">
              {n.next.map((x, i) => (
                <li key={i} className={x.stuck ? "text-red-700 dark:text-red-400" : ""}>
                  {x.code && <span className="mr-1 font-mono text-xs text-muted-foreground">{x.code}</span>}
                  {x.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing named next in the spine.</p>
          )}
        </Section>
        {b.made && <Made made={b.made} />}
        {b.capabilities && <Capabilities t={b.capabilities} />}
        {b.timeline.length > 0 && (
          <Section id="lately" title="Lately">
            <ol className="grid gap-1 text-sm">
              {b.timeline.map((t, i) => {
                const href = t.sha ? commitHref(t.sha) : undefined;
                return (
                  <li key={i} className="flex gap-2">
                    <span className="w-14 shrink-0 text-muted-foreground tabular-nums">{day(t.date)}</span>
                    <span className="min-w-0 break-words">
                      {t.kind === "decision" && <span className="mr-1 rounded bg-muted px-1 text-[11px] uppercase">decision</span>}
                      {t.text}
                      {href && (
                        <a href={href} target="_blank" rel="noreferrer" className="ml-1 font-mono text-xs text-muted-foreground underline">
                          {t.sha}
                        </a>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Section>
        )}
      </div>
    </div>
  );
}
