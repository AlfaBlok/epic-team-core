/**
 * (the owner 2026-11-16, vn_c95c40ad: "something that was time sensitive ... how come that this is not the first thing
 * on my inbox?"): a card whose card file names a `deadline:` leads its section (never a section of its own),
 * with this line above it: its time left counting down; past it the line says overdue in red.
 */
import { useEffect, useState } from "react";
import { deadlineWhen, timeLeft } from "@/lib/deadline";
import { cn } from "@/lib/utils";

/** "18 h 20 min left · due Tue 17 Nov, 01:47 UTC", then where the deadline comes from. Overdue reads in red. */
export function DeadlineLine({ at, why, now }: { at: string; why?: string; now: number }) {
  const left = timeLeft(at, now);
  if (!left) return null;
  return (
    <div className="grid gap-0.5 text-sm" data-testid="deadline-line" data-overdue={left.overdue ? "yes" : "no"}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn("font-semibold tabular-nums", left.overdue && "text-destructive")} data-testid="deadline-left">
          {left.text}
        </span>
        <time dateTime={at} className="text-muted-foreground">
          {left.overdue ? "was due" : "due"} {deadlineWhen(at)}
        </time>
      </div>
      {why && <div className="text-xs text-muted-foreground" data-testid="deadline-why">{why}</div>}
    </div>
  );
}

/** the clock the countdown reads: every 30 s while a deadline is shown (the minute changes on time). */
export function useMinuteClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
