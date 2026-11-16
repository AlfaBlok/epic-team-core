import { useEffect, useState } from "react";
import type { ReviewItem } from "@/api";
import { useProject } from "@/lib/project";
import { markReviewGoneAfter, unmarkReviewGone, useReviewCards } from "@/lib/inbox";
import { byDeadline, deadlineWhen, timeLeft } from "@/lib/deadline";
import { cn } from "@/lib/utils";
import { isReady } from "@/lib/cardKind";
import { FoldSection } from "@/components/homeSection";
import { PostReviewCard, ReviewCard } from "@/components/review";

/**
 * (the owner 2026-11-16, vn_c95c40ad: "I think I mentioned that there was something that was time sensitive ...
 * So how come that this is not the first thing on my inbox?"; the Airbnb reply with its deadline sat third under Done,
 * waiting for your review): a card whose card file names a `deadline:` leads the whole inbox, above every section, in
 * both skins alike, soonest first, each with its time left counting down; past it the line says overdue in
 * red and the card stays first. The sections below leave these cards out (lib/cardKind `hasDeadline`).
 */
export function DeadlineFirst() {
  const project = useProject();
  const { cards } = useReviewCards({ keep: project.keep });
  // a ready card leads under Ready for you, with its deadline line there
  const list = byDeadline(cards as ReviewItem[] | undefined).filter((c) => !isReady(c.face));
  const now = useMinuteClock(list.length > 0);
  if (!list.length) return null;
  return (
    <FoldSection title="Has a deadline" count={list.length} tone="needs-you" testId="deadline-first">
      <ul className="grid min-w-0 grid-cols-1 gap-[18px]">
        {list.map((i) => (
          <li key={i.id} className="grid min-w-0 gap-2" data-testid="deadline-card" data-inbox-card={`review:${i.id}`}>
            <DeadlineLine at={i.face!.deadline!.at} why={i.face!.deadline!.why} now={now} />
            {i.kind === "post" && i.post ? (
              <PostReviewCard item={i} onDone={() => markReviewGoneAfter(i.id, 320)} onFailed={() => unmarkReviewGone(i.id)} />
            ) : (
              <ReviewCard item={i} onDone={() => markReviewGoneAfter(i.id, 320)} onFailed={() => unmarkReviewGone(i.id)} onBack={() => unmarkReviewGone(i.id)} />
            )}
          </li>
        ))}
      </ul>
    </FoldSection>
  );
}

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
function useMinuteClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
