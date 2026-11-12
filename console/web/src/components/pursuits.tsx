import { useEffect } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { api } from "@/api";
import type { Pursuit, PursuitLine, PursuitLineState, PursuitsBody, PursuitTotem } from "@/api/pursuit-types";
import { PageHeader } from "@/components/common";
import { useQuery } from "@/lib/data";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The owner's pursuits: the big goals he wants to see through, each with its "green when" line, a scorecard read from
 * real checks, the totems he must reach in one click (deck, social kit, value proposition) and whether it is moving or
 * stalled. The repo file docs/pursuits.json is the record; GET /api/pursuits reads it (server/src/pursuits.ts). The
 * look follows docs/design/console.md: ink, grey and the one green; red only as the word of a red line or "stalled".
 */
export const PURSUITS_PATH = "pursuits";

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

export function PursuitPanel({ p }: { p: Pursuit }) {
  return (
    <article id={p.id} className="min-w-0 scroll-mt-20 rounded-xl border bg-card p-4" data-testid="pursuit" data-pursuit={p.id}>
      <div className="flex items-start gap-3">
        <PursuitRing greens={p.greens} total={p.total} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="text-[15px] font-semibold text-foreground [overflow-wrap:anywhere]">{p.name}</h2>
            <StateWord state={p.state} />
            <span className="text-xs text-muted-foreground">·</span>
            <MotionWord p={p} />
          </div>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">Green when {p.greenWhen.charAt(0).toLowerCase() + p.greenWhen.slice(1)}</p>
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
    <div className="mx-auto grid w-full max-w-3xl gap-3" data-testid="pursuits-page">
      <PageHeader title="Pursuits" description={`Your big goals. The worst line sets the colour; stalled means nothing it watches changed in ${stale} days.`} />
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the scorecards…</div>}
      {error && <div className="text-sm text-destructive">Could not read the pursuits: {error.message}</div>}
      {data && data.pursuits.length === 0 && <div className="text-sm text-muted-foreground">No pursuits yet: docs/pursuits.json names them.</div>}
      {data?.pursuits.map((p) => <PursuitPanel key={p.id} p={p} />)}
      {data?.said && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="pursuits-said">
          Your words: “{data.said.words}”
        </p>
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
      <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">Pursuits</div>
      {data.pursuits.map((p) => (
        <NavLink
          key={p.id}
          to={`/${PURSUITS_PATH}#${p.id}`}
          className={() => sideItem({ isActive: pathname === `/${PURSUITS_PATH}` && hash === `#${p.id}` })}
          onClick={onNavigate}
          title={`${p.name}: ${STATE_WORD[p.state]}, ${p.greens} of ${p.total} lines green`}
          data-testid="sidebar-pursuit"
          data-pursuit={p.id}
        >
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="line-clamp-2 min-w-0 break-words text-[13px] font-medium text-foreground">{p.name}</span>
            <MotionWord p={p} />
          </span>
          <span className="mt-0.5 shrink-0 text-xs text-muted-foreground" data-testid="sidebar-pursuit-count">
            {p.greens}/{p.total}
          </span>
        </NavLink>
      ))}
    </div>
  );
}
