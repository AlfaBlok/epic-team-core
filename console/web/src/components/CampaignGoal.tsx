import type { CampaignCard } from "@/api/campaign-types";

/**
 * the
 * campaign's one goal, the number toward it with a bar, and what waits on him, all read from its spine and ledger.
 * `compact`: the Team home card (one line each); else the campaign page under its title.
 */
export function CampaignGoalBlock({ card, compact = false }: { card: CampaignCard; compact?: boolean }) {
  const g = card.goal;
  if (!g) return null;
  const m = g.metric;
  const pct = m && m.now !== null && m.target > 0 ? Math.max(0, Math.min(100, Math.round((m.now / m.target) * 100))) : null;
  const waits = card.waiting && (card.waiting.held > 0 || card.waiting.asks.length > 0);
  return (
    <div className={compact ? "grid gap-1 text-xs" : "mb-4 grid gap-1.5 rounded-lg border bg-card p-3 text-sm"} data-testid="campaign-goal">
      <div className={compact ? "line-clamp-2 text-foreground" : "text-foreground"} data-testid="campaign-goal-sentence">
        <span className="font-medium">Goal: </span>
        {g.sentence ?? <span className="text-muted-foreground">not written yet</span>}
      </div>
      <div className="flex min-w-0 items-center gap-2" data-testid="campaign-goal-progress" title={m?.source ?? undefined}>
        {pct !== null && (
          <span className={`${compact ? "w-16" : "w-28"} h-1.5 shrink-0 overflow-hidden rounded-full bg-muted`} aria-hidden>
            <span className="block h-full rounded-full bg-emerald-600" style={{ width: `${Math.max(pct, 2)}%` }} />
          </span>
        )}
        <span className="min-w-0 text-muted-foreground">{g.line}</span>
      </div>
      {!compact && card.waiting && (
        <div className={waits ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground"} data-testid="campaign-goal-waiting">
          {card.waiting.line}
          {card.waiting.asks.length > 0 && <span className="font-normal text-muted-foreground"> · {card.waiting.asks.map((a) => a.question).join(" · ")}</span>}
        </div>
      )}
    </div>
  );
}
