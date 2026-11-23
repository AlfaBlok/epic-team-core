// the goal pieces the app frame draws on every screen (the sidebar's rings and pills, the objectives read),
// apart from the goal-sets screens, so the Inbox's first download holds no goal-sets page code. components/goalSets
// re-exports them; the sidebar's objectives list loads with that script (components/Layout).
import type { KeyboardEvent, MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import type { ScorecardNode, ScorecardRow, ScorecardRowState, ScorecardsBody } from "@/api/pursuit-types";
import { CountPill, PILL_TITLES } from "@/components/homeSection";
import { useSharedQuery } from "@/lib/data";

export function useGoalSets() {
  return useSharedQuery<ScorecardsBody>("sb:scorecards", () => api.listScorecards(), { tag: "inbox" });
}

export const STATE_FILL: Record<ScorecardRowState, string> = {
  green: "hsl(142 72% 29%)",
  amber: "hsl(38 92% 50%)",
  red: "hsl(0 72% 51%)",
  unknown: "hsl(var(--border))",
};
/** the order of the ring's arcs: green, then yellow (amber), then red, then grey for not measured (vn_68cda1fe, his 22 Nov ask). */
export const RING_ARC_ORDER: ScorecardRowState[] = ["green", "amber", "red", "unknown"];

/** the ring's arcs: one per colour present, its length the share of rows in that colour, laid end to end from the top
 * with no gap, so the whole is one continuous circle ("one continuous circle ... no gaps"). Pure, for the tests. */
export function ringArcs(rows: Pick<ScorecardRow, "state">[], circumference: number): { state: ScorecardRowState; share: number; length: number; offset: number }[] {
  const n = rows.length;
  if (!n) return [];
  let at = 0;
  return RING_ARC_ORDER.flatMap((state) => {
    const k = rows.filter((x) => (RING_ARC_ORDER.includes(x.state) ? x.state : "unknown") === state).length;
    if (!k) return [];
    const share = k / n;
    const arc = { state, share, length: share * circumference, offset: at };
    at += arc.length;
    return [arc];
  });
}

/** the set as a ring: one continuous circle whose arcs show the share of green, then yellow, then red rows (grey: not
 * measured, last), no gaps (the owner 22 Nov, after vn_68cda1fe); greens of rows inside on the larger sizes. */
export function SetWheel({ rows, size = 40, testId = "set-wheel" }: { rows: Pick<ScorecardRow, "state">[]; size?: number; testId?: string }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const n = rows.length;
  const arcs = ringArcs(rows, c);
  const greens = rows.filter((x) => x.state === "green").length;
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} data-testid={testId} role="img" aria-label={`${greens} of ${n} rows green`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        {arcs.length === 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="4" />}
        {arcs.map((a) =>
          a.share >= 1 ? (
            <circle key={a.state} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={STATE_FILL[a.state]} strokeWidth="4" data-arc={a.state} data-share={a.share.toFixed(4)} />
          ) : (
            <circle key={a.state} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={STATE_FILL[a.state]} strokeWidth="4" strokeDasharray={`${a.length} ${c}`} strokeDashoffset={-a.offset} data-arc={a.state} data-share={a.share.toFixed(4)} />
          ),
        )}
      </svg>
      {size >= 36 && (
        <span className="absolute text-[11px] font-medium tabular-nums text-foreground">
          {greens}/{n}
        </span>
      )}
    </span>
  );
}


/** the tab every sidebar pill opens and counts: a goal's Inbox (its asks red, its review cards green). */
export const GOAL_INBOX_TAB = "inbox";

/**
 * a goal's inbox pills, the same on every sidebar entry and on its Inbox tab (the owner: a green 1
 * on House decision opened a page where no tab showed it). Red = asks waiting on him, green = cards for his review;
 * with `to`, a tap on a pill opens that goal's Inbox tab, the tab that lists exactly those items.
 */
export function GoalPills({ c, to, onNavigate, milestoneId, ids = { ask: "sidebar-set-asks", review: "sidebar-set-review" } }: { c: { ask: number; review: number }; to?: string; onNavigate?: () => void; milestoneId?: string; ids?: { ask: string; review: string } }) {
  const navigate = useNavigate();
  if (!c.ask && !c.review) return null;
  const open = to
    ? {
        role: "link",
        tabIndex: 0,
        "data-to": to,
        onClick: (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onNavigate?.();
          navigate(to);
        },
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          e.stopPropagation();
          onNavigate?.();
          navigate(to);
        },
      }
    : {};
  return (
    <span className="flex shrink-0 items-center gap-1" data-testid="goal-pills" {...open} title={to ? `Open its Inbox: ${c.ask} waiting on you, ${c.review} for your review` : undefined}>
      {c.ask > 0 && <CountPill count={c.ask} tone="needs-you" title={PILL_TITLES["needs-you"](c.ask)} testId={ids.ask} milestoneId={milestoneId} />}
      {c.review > 0 && <CountPill count={c.review} tone="review" title={PILL_TITLES.review(c.review)} testId={ids.review} milestoneId={milestoneId} />}
    </span>
  );
}

/** the top objectives in his order, less the ones shown inside another (their file's `foldedInto`). */
export const topObjectives = (nodes: ScorecardNode[] | undefined) => (nodes ?? []).filter((n) => !n.foldedInto);

