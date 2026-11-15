import { useEffect } from "react";
import { ChevronRight } from "lucide-react";
import { Link, NavLink, Navigate, useLocation, useParams } from "react-router-dom";
import { api } from "@/api";
import type { Pursuit, PursuitLine, PursuitLineState, PursuitsBody, PursuitTotem } from "@/api/pursuit-types";
import { pursuitTitle } from "@/api/pursuit-types";
import { PageHeader } from "@/components/common";
import { SOCIAL_KIT_TAB, setKitHref } from "@/components/socialKit";
import { PursuitsMap, RankBadge, epicDeckHref } from "@/components/pursuitsMap";
import { useQuery } from "@/lib/data";
import { scorecardHref } from "@/lib/scorecards";
import { useRoutes } from "@/lib/skin";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The owner's pursuits: the big goals he wants to see through, each with its "green when" line, a scorecard read from
 * real checks, the totems he must reach in one click (deck, social kit, value proposition) and whether it is moving or
 * stalled. The repo file docs/pursuits.json is the record; GET /api/pursuits reads it (server/src/pursuits.ts). The
 * look follows docs/design/console.md: ink, grey and the one green; red only as the word of a red line or "stalled".
 */
export const PURSUITS_PATH = "pursuits";
/** each pursuit has its own page under Pursuits, its tabs Scorecard and (when it has one) Social kit. */
export const PURSUIT_PATH = `${PURSUITS_PATH}/:id`;
export const PURSUIT_TAB_PATH = `${PURSUITS_PATH}/:id/:tab`;
export const pursuitHref = (id: string, tab?: string) => `/${PURSUITS_PATH}/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`;

export function usePursuits() {
  return useQuery<PursuitsBody>(() => api.listPursuits(), [], { tag: "inbox" });
}

const STATE_CLASS: Record<PursuitLineState, string> = {
  green: "text-emerald-700 dark:text-emerald-400",
  red: "text-destructive",
  amber: "text-foreground",
  unknown: "text-muted-foreground",
};
const STATE_WORD: Record<PursuitLineState, string> = { green: "green", red: "red", amber: "amber", unknown: "not read" };

/** One word in its colour: green, amber (ink), red, or not read (grey). */
export function StateWord({ state, testId = "pursuit-state" }: { state: PursuitLineState; testId?: string }) {
  return (
    <span className={cn("text-xs font-medium", STATE_CLASS[state])} data-testid={testId} data-state={state}>
      {STATE_WORD[state]}
    </span>
  );
}

/** moving in grey, stalled in red: the enemy is the stale. */
export function MotionWord({ p }: { p: Pick<Pursuit, "motion" | "lastMove"> }) {
  const word = p.motion === "unknown" ? "no history" : p.motion;
  return (
    <span
      className={cn("text-xs", p.motion === "stalled" ? "text-destructive" : "text-muted-foreground")}
      data-testid="pursuit-motion"
      data-motion={p.motion}
      title={p.lastMove ? `last moved ${formatRelative(p.lastMove.at)}` : undefined}
    >
      {word}
    </span>
  );
}

/** The battery: a thin ring, green for the share of lines that are green, the count inside for readers. */
export function PursuitRing({ greens, total, size = 36 }: { greens: number; total: number; size?: number }) {
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const share = total ? greens / total : 0;
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} data-testid="pursuit-ring" aria-label={`${greens} of ${total} lines green`} role="img">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="3" />
        {share > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(142 72% 29%)" strokeWidth="3" strokeDasharray={`${c * share} ${c}`} strokeLinecap="round" />}
      </svg>
      <span className="absolute text-xs font-medium text-foreground">
        {greens}/{total}
      </span>
    </span>
  );
}

function Line({ l }: { l: PursuitLine }) {
  return (
    <li className="grid gap-0.5 py-2.5" data-testid="pursuit-line" data-state={l.state}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{l.label}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="text-xs text-muted-foreground">{l.value}</span>
          <StateWord state={l.state} testId="pursuit-line-state" />
        </span>
      </div>
      {l.note && <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{l.note}</div>}
    </li>
  );
}

function Totem({ t }: { t: PursuitTotem }) {
  if (!t.url)
    return (
      <span className="text-sm text-muted-foreground" data-testid="pursuit-totem" data-missing="true" title={t.missing}>
        {t.label}: missing{t.missing ? `, ${t.missing.charAt(0).toLowerCase()}${t.missing.slice(1)}` : ""}
      </span>
    );
  const cls = "text-sm text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground";
  return t.url.startsWith("/") ? (
    <Link to={t.url} className={cls} data-testid="pursuit-totem">
      {t.label}
    </Link>
  ) : (
    <a href={t.url} target="_blank" rel="noreferrer" className={cls} data-testid="pursuit-totem">
      {t.label}
    </a>
  );
}

/** Where it runs: each epic's deck (with the way back here) and the milestones and teams that carry it. */
function RunsIn({ p }: { p: Pursuit }) {
  const epics = (p.epics ?? []).filter((e) => e.code);
  const ms = p.milestones ?? [];
  if (!epics.length && !ms.length) return null;
  const cls = "text-sm text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground";
  return (
    <div className="mt-3 grid gap-2 border-t pt-3" data-testid="pursuit-runs-in">
      {epics.length > 0 && (
        <div className="grid gap-1">
          <div className="text-xs text-muted-foreground">Epics, each opens its deck</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {epics.map((e) => (
              <Link key={`${e.repo}/${e.path}`} to={epicDeckHref(e.repo, e.code!, p.id)} className={cls} data-testid="pursuit-epic" title={e.title}>
                {e.code}
                {e.title ? `: ${e.title.length > 60 ? `${e.title.slice(0, 58)}…` : e.title}` : ""}
              </Link>
            ))}
          </div>
        </div>
      )}
      {ms.length > 0 && (
        <div className="grid gap-1">
          <div className="text-xs text-muted-foreground">Milestones and their teams</div>
          <ul className="grid gap-1">
            {ms.map((m) => (
              <li key={m.id} className="grid gap-0.5" data-testid="pursuit-milestone">
                <Link to={`/milestones/${encodeURIComponent(m.id)}`} className={cls}>
                  {m.title}
                </Link>
                <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {m.teams.length
                    ? m.teams.map((t) => (t.enabled ? `${t.persona}: ${t.paceNow}${t.paceNow !== t.pace ? ` (set ${t.pace})` : ""}` : `${t.persona}: off`)).join(" · ")
                    : "no team on it"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function PursuitPanel({ p, linkName = false }: { p: Pursuit; linkName?: boolean }) {
  return (
    <article id={p.id} className="min-w-0 scroll-mt-20 rounded-xl border bg-card p-4" data-testid="pursuit" data-pursuit={p.id}>
      <div className="flex items-start gap-3">
        <PursuitRing greens={p.greens} total={p.total} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="text-[15px] font-semibold text-foreground [overflow-wrap:anywhere]">
              {linkName ? (
                <Link to={pursuitHref(p.id)} className="underline decoration-border underline-offset-4 hover:decoration-foreground" data-testid="pursuit-open">
                  {pursuitTitle(p)}
                </Link>
              ) : (
                pursuitTitle(p)
              )}
            </h2>
            <StateWord state={p.state} />
            <span className="text-xs text-muted-foreground">·</span>
            <MotionWord p={p} />
            {p.rank !== undefined && <RankBadge p={p} />}
          </div>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">Green when {p.greenWhen.charAt(0).toLowerCase() + p.greenWhen.slice(1)}</p>
          {p.effort && (
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="pursuit-panel-effort">
              {p.effort.words}
            </p>
          )}
        </div>
      </div>
      <ul className="mt-3 divide-y divide-border border-t" data-testid="pursuit-lines">
        {p.lines.map((l) => (
          <Line key={l.label} l={l} />
        ))}
      </ul>
      {p.totems.length > 0 && (
        <div className="mt-3 border-t pt-3" data-testid="pursuit-totems">
          <div className="mb-1.5 text-xs text-muted-foreground">Totems</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {p.totems.map((t) => (
              <Totem key={t.label} t={t} />
            ))}
          </div>
        </div>
      )}
      <RunsIn p={p} />
      <div className="mt-3 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="pursuit-last-move">
        {p.lastMove ? `Last moved ${formatRelative(p.lastMove.at)} in ${p.lastMove.repo}: ${p.lastMove.subject}` : "No change found in what it watches."}
      </div>
    </article>
  );
}

export function PursuitsPage() {
  const { data, error, loading } = usePursuits();
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash || !data) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "start" });
  }, [hash, data]);
  const stale = data?.staleDays ?? 3;
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-3" data-testid="pursuits-page">
      <PageHeader
        title="Pursuits"
        description={
          data?.pursuits.length
            ? `Your ${data.pursuits.length} big goals, most important first: ${data.pursuits[0].name} leads and gets the most effort; parked ones get none.`
            : "Your big goals, most important first."
        }
      />
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the scorecards…</div>}
      {error && <div className="text-sm text-destructive">Could not read the pursuits: {error.message}</div>}
      {data && data.pursuits.length === 0 && <div className="text-sm text-muted-foreground">No pursuits yet: docs/pursuits.json names them.</div>}
      {data && data.pursuits.length > 0 && <PursuitsMap data={data} />}
      {data && data.pursuits.length > 0 && (
        <h2 className="mt-2 text-sm font-semibold text-foreground" data-testid="pursuits-scorecards">
          Scorecards, in the same order. The worst line sets the colour; stalled means nothing it watches changed in {stale} days.
        </h2>
      )}
      {data?.pursuits.map((p) => <PursuitPanel key={p.id} p={p} linkName />)}
      {data?.said && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="pursuits-said">
          Your words: “{data.said.words}”
        </p>
      )}
    </div>
  );
}

/** The way back and where he is: Pursuits › the pursuit › the tab, each part a link up. */
function Crumbs({ p, tab }: { p?: Pursuit; tab?: string }) {
  const link = "text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-foreground";
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm" aria-label="Where you are" data-testid="pursuit-crumbs">
      <Link to={`/${PURSUITS_PATH}`} className={link} data-testid="pursuit-back">
        Pursuits
      </Link>
      {p && (
        <>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          {tab ? (
            <Link to={pursuitHref(p.id)} className={link}>
              {pursuitTitle(p)}
            </Link>
          ) : (
            <span className="text-foreground">{pursuitTitle(p)}</span>
          )}
        </>
      )}
      {p && tab && (
        <>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-foreground">{tab}</span>
        </>
      )}
    </nav>
  );
}

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn("-mb-px border-b-2 px-1 pb-2 text-sm transition-colors", isActive ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground");

/** The old kit address, in both skins (the pursuit pages are console-only): it leads to the goal set's Social kit tab. */
export const PURSUIT_KIT_PATH = `${PURSUITS_PATH}/:id/${SOCIAL_KIT_TAB}`;
export function PursuitKitRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={setKitHref(id)} replace />;
}

/**
 * An old /pursuits address. The console skin keeps its pursuit pages; a skin without them (the social one) opens the
 * objective instead: /pursuits -> All objectives, /pursuits/<id> -> /sets/<id>, its social kit -> the Social kit tab.
 */
export function OldPursuitRoute({ page }: { page: JSX.Element }) {
  const routes = useRoutes();
  const { id, tab } = useParams();
  // one pursuit opens as its wheel, with its tabs, the key results first, in both skins.
  if (!id && routes("book")) return page;
  if (!id) return <Navigate to={scorecardHref()} replace />;
  return <Navigate to={tab === SOCIAL_KIT_TAB ? setKitHref(id) : scorecardHref(id)} replace />;
}

/** One pursuit's own page: its scorecard, and its social kit inside the console, never a page of its own. */
export function PursuitPage() {
  const { id = "", tab } = useParams();
  const { data, error, loading } = usePursuits();
  const p = data?.pursuits.find((x) => x.id === id);
  // the kit is a tab of the goal set's page now (pursuits live in the sidebar as sets).
  if (tab === SOCIAL_KIT_TAB) return <Navigate to={setKitHref(id)} replace />;
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-3xl gap-3" data-testid="pursuit-page" data-pursuit={id}>
      <Crumbs p={p} />
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the scorecard…</div>}
      {error && <div className="text-sm text-destructive">Could not read the pursuits: {error.message}</div>}
      {data && !p && (
        <div className="text-sm text-muted-foreground" data-testid="pursuit-unknown">
          No pursuit called “{id}”. <Link to={`/${PURSUITS_PATH}`} className="underline underline-offset-4">See every pursuit</Link>
        </div>
      )}
      {p && (
        <>
          <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{pursuitTitle(p)}</h1>
          <nav className="flex gap-5 border-b" aria-label="Pursuit pages" data-testid="pursuit-tabs">
            <NavLink to={pursuitHref(p.id)} end className={tabClass} data-testid="pursuit-tab-scorecard">
              Scorecard
            </NavLink>
            {p.kit && (
              <NavLink to={setKitHref(p.id)} className={tabClass} data-testid="pursuit-tab-kit">
                Social kit
              </NavLink>
            )}
          </nav>
          <PursuitPanel p={p} />
        </>
      )}
    </div>
  );
}

const sideItem = ({ isActive }: { isActive: boolean }) =>
  cn("flex min-w-0 items-start gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors", isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground");

/** The sidebar's pursuits: each its name and one word, moving or stalled, and how many lines are green. */
export function SidebarPursuits({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = usePursuits();
  const { hash, pathname } = useLocation();
  if (!data?.pursuits.length) return null;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-0.5" data-testid="sidebar-pursuits">
      {/* the heading opens every pursuit (a plain label did nothing when clicked). */}
      <NavLink
        to={`/${PURSUITS_PATH}`}
        end
        className={({ isActive }) => cn("rounded-md px-2.5 pb-1 pt-2 text-xs font-medium hover:text-foreground", isActive ? "text-foreground" : "text-muted-foreground")}
        onClick={onNavigate}
        data-testid="sidebar-pursuits-all"
      >
        Pursuits
      </NavLink>
      {data.pursuits.map((p) => (
        <NavLink
          key={p.id}
          to={pursuitHref(p.id)}
          className={() => sideItem({ isActive: pathname.startsWith(pursuitHref(p.id)) || (pathname === `/${PURSUITS_PATH}` && hash === `#${p.id}`) })}
          onClick={onNavigate}
          title={`${p.name}: ${STATE_WORD[p.state]}, ${p.greens} of ${p.total} lines green`}
          data-testid="sidebar-pursuit"
          data-pursuit={p.id}
        >
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="line-clamp-2 min-w-0 break-words text-[13px] font-medium text-foreground">
              {typeof p.rank === "number" && <span className="mr-1 text-muted-foreground" data-testid="sidebar-pursuit-rank">{p.rank}.</span>}
              {pursuitTitle(p)}
            </span>
            {p.parked ? <span className="text-xs text-muted-foreground">parked</span> : <MotionWord p={p} />}
          </span>
          <span className="mt-0.5 shrink-0 text-xs text-muted-foreground" data-testid="sidebar-pursuit-count">
            {p.greens}/{p.total}
          </span>
        </NavLink>
      ))}
    </div>
  );
}
