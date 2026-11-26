import { useEffect } from "react";
import { useBlocked, useReviewCards, useStatusBatch } from "@/lib/inbox";
import { useProject } from "@/lib/project";
import { goalsOf, keepGoals, showAllGoals, tapGoal, useGoalIndex, useShownGoals } from "@/lib/goalFilter";
import { cn } from "@/lib/utils";

/**
 * (the owner 26 Nov 00:02Z, vn_b5b6f567): one row of goal labels above the Inbox, made only from the goals of
 * the cards the red and green pills count (no empty goal), so it changes as cards come and go. Every goal is on at
 * first; the first tap shows that goal alone, each further tap turns a goal on or off, Show all puts every goal back
 * (his chat of 26 Nov). Every section and every pill follows. Leaving the Inbox shows every goal again.
 */
export function InboxGoalLabels() {
  const { keep } = useProject();
  const { data: statuses } = useStatusBatch();
  // the very lists the pills count, before any goal is hidden (lib/inbox, components/Layout TopBarPills)
  const blocked = useBlocked(statuses, { keep });
  const reviews = useReviewCards({ keep }).cards;
  const idx = useGoalIndex();
  const shownGoals = useShownGoals();
  const goals = goalsOf([...blocked, ...(reviews ?? [])], idx);
  useEffect(() => () => void showAllGoals(), []);
  // a goal he turned on whose cards all left the inbox is dropped; none left, every goal is on again
  const names = goals.map((g) => g.name).join("\n");
  useEffect(() => {
    if (!statuses || statuses.loading || !reviews) return;
    keepGoals(new Set(names.split("\n")));
  }, [names, shownGoals, statuses, reviews]);
  if (goals.length < 2) return null;
  return (
    // one row: on a phone it scrolls sideways (never a screen of labels above the cards), on a laptop it wraps
    <nav
      className="-mx-4 mb-3 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
      aria-label="Goals"
      data-testid="inbox-goals"
    >
      {shownGoals && (
        <button type="button" onClick={() => showAllGoals()} className="min-h-8 shrink-0 px-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" data-testid="inbox-goals-all">
          Show all
        </button>
      )}
      {goals.map((g) => {
        const on = !shownGoals || shownGoals.has(g.name);
        return (
          <button
            key={g.name}
            type="button"
            onClick={() => tapGoal(g.name)}
            aria-pressed={on}
            title={!shownGoals ? `Show only ${g.name}` : on ? `Hide ${g.name}` : `Show ${g.name} too`}
            data-testid="inbox-goal"
            data-goal={g.name}
            className={cn(
              "inline-flex min-h-8 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full border px-3 text-[13px] transition-colors",
              // every goal on: quiet labels; once he picks, the goals he picked are filled dark, the rest muted
              !shownGoals ? "border-foreground/25 bg-accent text-foreground" : on ? "border-foreground bg-foreground text-background" : "border-border bg-transparent text-muted-foreground/80 hover:text-foreground",
            )}
          >
            <span data-testid="inbox-goal-name">{g.name}</span>
            {/* the count is its own small badge beside the name, never glued to it */}
            <span
              className={cn("ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] leading-5 tabular-nums", shownGoals && on ? "bg-background/20 text-background" : "bg-foreground/10 text-muted-foreground")}
              data-testid="inbox-goal-count"
            >
              {g.count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
