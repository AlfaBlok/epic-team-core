import { useEffect, useState, type DragEvent } from "react";
import { ObjectiveName } from "@/components/objectiveName";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronRight, GripVertical } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { EffortPolicy, Pursuit, PursuitsBody } from "@/api/pursuit-types";
import { pursuitTitle } from "@/api/pursuit-types";
import { mutate } from "@/lib/data";
import { deckHref } from "@/lib/deck";
import { cn } from "@/lib/utils";

/**
 * The navigable scorecard's first screen: every pursuit in the owner's order, what its rank buys, the milestones and
 * teams that carry it and the epic decks it opens, drawn as boxes and arrows in the console's own minimal look (diagram first; paper is for decks only).
 * He reorders with one drag or the arrows and parks a pursuit with one button; each change is one commit in
 * docs/pursuits.json, and the scheduler, the worker ceiling and the stall watch follow it.
 */

/** a box: plain card, the top one in the console's one green, a parked or empty one dashed and grey. */
const box = (focus = false, quiet = false) =>
  quiet
    ? "border border-dashed bg-muted/40 text-muted-foreground"
    : focus
      ? "border border-emerald-700/60 bg-emerald-50 text-foreground dark:bg-emerald-950/30"
      : "border bg-card text-foreground";

/** a link to an epic's deck that carries the way back to this pursuit. */
export const epicDeckHref = (repo: string, code: string, pursuitId: string) => `${deckHref(repo, code)}?pursuit=${encodeURIComponent(pursuitId)}`;
const milestoneHref = (id: string, code?: string) => `/milestones/${encodeURIComponent(id)}?tab=deck${code ? `&epic=${encodeURIComponent(code)}` : ""}`;

/** "#1 Top", "Parked" */
export function RankBadge({ p }: { p: Pursuit }) {
  if (p.rank === undefined) return null; // an older server: no order yet
  const parked = p.parked || p.rank === null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-baseline gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium",
        parked ? "bg-muted text-muted-foreground" : p.rank === 1 ? "bg-emerald-700 text-white" : "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
      )}
      data-testid="pursuit-rank"
      data-rank={parked ? "parked" : String(p.rank ?? "")}
    >
      {parked ? "Parked" : `#${p.rank}`}
      {!parked && p.effort && <span className="font-normal">{p.effort.tier}</span>}
    </span>
  );
}

function Arrow() {
  return (
    <div className="flex items-center justify-center text-muted-foreground/60" aria-hidden>
      <ArrowDown className="h-4 w-4 md:hidden" />
      <ArrowRight className="hidden h-4 w-4 md:block" />
    </div>
  );
}

const move = (ids: string[], from: number, to: number) => {
  const out = [...ids];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
};

/** The map: one row per pursuit, rank → pursuit → milestones and teams → epic decks. */
export function PursuitsMap({ data }: { data: PursuitsBody }) {
  const [order, setOrder] = useState<string[]>(() => data.pursuits.map((p) => p.id));
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const serverOrder = data.pursuits.map((p) => p.id).join(",");
  useEffect(() => setOrder(serverOrder.split(",")), [serverOrder]);
  const byId = new Map(data.pursuits.map((p) => [p.id, p]));
  const list = order.map((id) => byId.get(id)).filter((p): p is Pursuit => !!p);
  const ranked = list.filter((p) => !p.parked);
  const parked = list.filter((p) => p.parked);
  const editable = data.pursuits.every((p) => p.rank !== undefined); // an older server has no order to write

  const save = async (next: string[], what: string) => {
    const before = order;
    setOrder(next);
    setSaving(what);
    setError(null);
    try {
      await mutate(() => api.reorderPursuits(next), "inbox");
    } catch (e) {
      setOrder(before);
      setError(`Not saved: ${(e as Error).message}`);
    } finally {
      setSaving(null);
    }
  };
  const park = async (p: Pursuit, on: boolean) => {
    setSaving(on ? `Parking ${p.name}` : `Resuming ${p.name}`);
    setError(null);
    try {
      await mutate(() => api.parkPursuit(p.id, on), "inbox");
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
    } finally {
      setSaving(null);
    }
  };
  // ranked ones move among themselves; parked ones stay after them (their place returns when resumed).
  const shift = (p: Pursuit, by: -1 | 1) => {
    const i = ranked.indexOf(p);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ranked.length) return;
    const ids = move(ranked.map((x) => x.id), i, j).concat(parked.map((x) => x.id));
    void save(ids, `Moving ${p.name} ${by < 0 ? "up" : "down"}`);
  };
  const onDrop = (to: number) => (e: DragEvent) => {
    e.preventDefault();
    if (drag === null || drag === to) return setDrag(null);
    const ids = move(ranked.map((x) => x.id), drag, to).concat(parked.map((x) => x.id));
    setDrag(null);
    void save(ids, "Saving the new order");
  };

  return (
    <section className="grid min-w-0 gap-2 rounded-xl border bg-muted/30 p-3 sm:p-4" data-testid="pursuits-map" aria-label="Pursuits in order of importance">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">
          Most important first. Effort follows the order.
        </h2>
        <span className="text-xs text-muted-foreground" data-testid="pursuits-map-hint" aria-live="polite">
          {saving ? `${saving}…` : editable ? "Drag a pursuit or use the arrows. Each change is saved in the repo." : "Reordering arrives with the next console release."}
        </span>
      </div>
      {error && (
        <div className="text-sm text-destructive" role="alert" data-testid="pursuits-map-error">
          {error}
        </div>
      )}
      <div className="hidden min-w-0 grid-cols-[minmax(0,1.25fr)_1.5rem_minmax(0,1fr)_1.5rem_minmax(0,1fr)] gap-2 px-1 text-xs text-muted-foreground md:grid" aria-hidden>
        <span>Pursuit and what its rank buys</span>
        <span />
        <span>Milestones and teams</span>
        <span />
        <span>Epics, each opens its deck</span>
      </div>
      <ol className="grid min-w-0 gap-2">
        {ranked.map((p, i) => (
          <MapRow
            key={p.id}
            p={p}
            first={i === 0}
            last={i === ranked.length - 1}
            editable={editable && !saving}
            onUp={() => shift(p, -1)}
            onDown={() => shift(p, 1)}
            onPark={() => park(p, true)}
            dragProps={
              editable && !saving
                ? { draggable: true, onDragStart: () => setDrag(i), onDragOver: (e: DragEvent) => e.preventDefault(), onDrop: onDrop(i), onDragEnd: () => setDrag(null) }
                : {}
            }
            dragging={drag === i}
          />
        ))}
      </ol>
      {parked.length > 0 && (
        <div className="grid min-w-0 gap-2 border-t pt-2" data-testid="pursuits-parked">
          <div className="text-xs text-muted-foreground">
            Parked: no wakes, no workers, no nudges until you resume it.
          </div>
          <ol className="grid min-w-0 gap-2">
            {parked.map((p) => (
              <MapRow key={p.id} p={p} first last editable={editable && !saving} onPark={() => park(p, false)} />
            ))}
          </ol>
        </div>
      )}
      {data.effort && <EffortRule policy={data.effort} />}
    </section>
  );
}

function MapRow({
  p,
  first,
  last,
  editable,
  onUp,
  onDown,
  onPark,
  dragProps = {},
  dragging,
}: {
  p: Pursuit;
  first: boolean;
  last: boolean;
  editable: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onPark: () => void;
  dragProps?: Record<string, unknown>;
  dragging?: boolean;
}) {
  const ctl = "inline-grid h-9 w-9 place-items-center rounded-md border bg-background disabled:opacity-30 md:h-8 md:w-8";
  const epics = (p.epics ?? []).filter((e) => e.code);
  return (
    <li
      className={cn("grid min-w-0 grid-cols-1 gap-1.5 rounded-lg md:grid-cols-[minmax(0,1.25fr)_1.5rem_minmax(0,1fr)_1.5rem_minmax(0,1fr)] md:items-stretch md:gap-2", dragging && "opacity-50")}
      data-testid="pursuit-map-row"
      data-pursuit={p.id}
      {...dragProps}
    >
      <div className={cn("grid min-w-0 gap-1 rounded-md px-3 py-2", box(p.rank === 1, !!p.parked))}>
        <div className="flex min-w-0 items-start gap-2">
          {!p.parked && editable && <GripVertical className="mt-0.5 hidden h-4 w-4 shrink-0 cursor-grab text-muted-foreground md:block" aria-hidden />}
          <RankBadge p={p} />
          <Link to={`/pursuits/${encodeURIComponent(p.id)}`} className="min-w-0 flex-1 text-sm font-semibold underline decoration-transparent underline-offset-4 hover:decoration-current [overflow-wrap:anywhere]" data-testid="pursuit-map-open">
            <ObjectiveName name={pursuitTitle(p)} />
          </Link>
          <span className="shrink-0 text-xs text-muted-foreground">
            {p.greens}/{p.total}
          </span>
        </div>
        <div className={cn("text-xs [overflow-wrap:anywhere]", p.parked && "text-muted-foreground")} data-testid="pursuit-effort">
          {p.effort?.words ?? "Effort follows its rank once the console has the new release."}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {!p.parked && (
            <>
              <button type="button" className={ctl} disabled={!editable || first} onClick={onUp} aria-label={`Move ${p.name} up`} data-testid="pursuit-up">
                <ArrowUp className="h-4 w-4" />
              </button>
              <button type="button" className={ctl} disabled={!editable || last} onClick={onDown} aria-label={`Move ${p.name} down`} data-testid="pursuit-down">
                <ArrowDown className="h-4 w-4" />
              </button>
            </>
          )}
          <button type="button" className="h-9 rounded-md border bg-background px-2.5 text-xs disabled:opacity-30 md:h-8" disabled={!editable} onClick={onPark} data-testid="pursuit-park">
            {p.parked ? "Resume" : "Park"}
          </button>
          <span className={cn("text-xs", p.motion === "stalled" ? "text-destructive" : "text-muted-foreground")}>
            {p.motion === "unknown" ? "no history" : p.motion}
          </span>
        </div>
      </div>
      <Arrow />
      <div className="grid min-w-0 content-start gap-1.5" data-testid="pursuit-map-milestones">
        {(p.milestones ?? []).length === 0 && (
          <div className={cn("rounded-md px-3 py-2 text-xs", box(false, true))}>
            No milestone runs it yet.
          </div>
        )}
        {(p.milestones ?? []).map((m) => {
          const on = m.teams.filter((t) => t.enabled);
          return (
            <Link key={m.id} to={milestoneHref(m.id)} className={cn("block min-w-0 rounded-md px-3 py-2 text-xs hover:underline", box())} data-testid="pursuit-map-milestone">
              <span className="block text-sm font-medium [overflow-wrap:anywhere]">{m.title}</span>
              <span className="block text-muted-foreground [overflow-wrap:anywhere]">
                {on.length ? on.slice(0, 3).map((t) => `${t.persona} ${t.paceNow}`).join(" · ") + (on.length > 3 ? ` · ${on.length - 3} more teams` : "") : "no team switched on"}
              </span>
            </Link>
          );
        })}
      </div>
      <Arrow />
      <div className="flex min-w-0 flex-wrap content-start gap-1.5" data-testid="pursuit-map-epics">
        {epics.length === 0 && (
          <div className={cn("rounded-md px-3 py-2 text-xs", box(false, true))}>
            No epic named yet.
          </div>
        )}
        {epics.map((e) => (
          <Link
            key={`${e.repo}/${e.path}`}
            to={epicDeckHref(e.repo, e.code!, p.id)}
            className={cn("min-w-0 max-w-full rounded-md px-2.5 py-1.5 text-xs hover:underline [overflow-wrap:anywhere]", box())}
            title={e.title}
            data-testid="pursuit-map-epic"
          >
            <span className="font-medium">{e.code}</span>
            {e.title && <span className="text-muted-foreground"> {e.title.length > 48 ? `${e.title.slice(0, 46)}…` : e.title}</span>}
          </Link>
        ))}
      </div>
    </li>
  );
}

const pace = (f: number) => (f === 1 ? "the pace set" : f === 2 ? "twice as often" : f === 0.5 ? "half as often" : `${f} times as often`);

/** The rule in plain words: what each rank buys, parked, and teams in no pursuit. */
export function EffortRule({ policy }: { policy: EffortPolicy }) {
  let from = 1;
  return (
    <div className="grid min-w-0 gap-1.5 border-t pt-2" data-testid="effort-rule">
      <div className="text-xs font-medium">How effort follows the order</div>
      <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
        {policy.tiers.map((t) => {
          const ranks = t.upToRank >= 50 ? `Rank ${from} and below` : from === t.upToRank ? `Rank ${from}` : `Ranks ${from} to ${t.upToRank}`;
          from = t.upToRank + 1;
          return (
            <div key={t.name} className={cn("rounded-md px-2.5 py-1.5 text-xs", box(t.upToRank === 1))} data-testid="effort-tier">
              <div className="font-medium">
                {ranks} · {t.name}
              </div>
              <div>
                Wakes {pace(t.wakeFactor)}, up to {t.maxWorkers} workers, nudged after {t.stallHours} h idle.
              </div>
            </div>
          );
        })}
        <div className={cn("rounded-md px-2.5 py-1.5 text-xs", box(false, true))} data-testid="effort-tier">
          <div className="font-medium">Parked</div>
          <div>No wakes, no workers, no nudges.</div>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {policy.outside} Faster wakes never go under {policy.minWakeMinutes} min apart.
      </div>
    </div>
  );
}

/**
 * On an epic deck: the bar up to the pursuit it carries and back to the scorecard (the way back of the navigable
 * scorecard). Shown when the deck was opened from a pursuit (`?pursuit=`) or its epic is one a pursuit names.
 */
export function PursuitBackBar({ repo, code }: { repo: string; code: string }) {
  const [params] = useSearchParams();
  const asked = params.get("pursuit");
  const [data, setData] = useState<PursuitsBody | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .listPursuits()
      .then((d) => alive && setData(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!data) return null;
  const last = (r: string) => r.split("/").pop()!.toLowerCase();
  const carries = (p: Pursuit) => (p.epics ?? []).some((e) => e.code === code && last(e.repo) === last(repo));
  const p = data.pursuits.find((x) => x.id === asked) ?? data.pursuits.find(carries);
  if (!p) return null;
  return (
    <nav className="mb-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-3 py-2 text-sm text-foreground" aria-label="Part of a pursuit" data-testid="deck-pursuit-bar">
      <Link to="/pursuits" className="inline-flex min-h-[2.25rem] items-center gap-1 font-medium underline underline-offset-2" data-testid="deck-pursuit-back">
        <ArrowLeft className="h-4 w-4" /> Pursuits
      </Link>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <Link to={`/pursuits/${encodeURIComponent(p.id)}`} className="min-w-0 underline underline-offset-2 [overflow-wrap:anywhere]" data-testid="deck-pursuit-open">
        <ObjectiveName name={pursuitTitle(p)} layout="inline" />
      </Link>
      <RankBadge p={p} />
      <span className="text-xs text-muted-foreground">
        This epic carries it.
      </span>
    </nav>
  );
}
