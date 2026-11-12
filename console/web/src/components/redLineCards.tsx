import { api, type ReviewItem } from "@/api";
import { isStructured, needsAnswer, type OwnerPriority, type RedLine, type WaitingItem } from "@/api/inbox-types";
import { useQuery } from "@/lib/data";
import { markReviewGoneAfter, unmarkReviewGone, useReviewCards } from "@/lib/inbox";
import { useSnoozes, withSnoozes } from "@/lib/snooze";
import { PostReviewCard, ReviewCard } from "@/components/review";
import { WaitingCard } from "@/components/waiting";

const onLine = (r: RedLine, j?: OwnerPriority) => !!j?.redLine && (r.name ? j.redLine.name === r.name : true);

/**
 * an unfolded red line is the full inbox cards of its items, the same cards as the lists below with all
 * their buttons, in the line's order, and nothing else. Mounted only while the line is open, so a folded line fetches nothing.
 */
export function RedLineCards({ r }: { r: RedLine }) {
  const { cards: reviews } = useReviewCards();
  const { data: fetched } = useQuery(() => api.listWaitingOnOwner(), [], { tag: "inbox" });
  const { entries: snoozes } = useSnoozes();
  const asks = withSnoozes(fetched, snoozes)?.filter((i) => onLine(r, i.ownerPriority) && needsAnswer(i) && isStructured(i) && !i.snoozedUntil && !i.decidedBy && i.signal !== "stamp_ready");
  const mine = reviews?.filter((i) => onLine(r, i.ownerPriority));
  if (!asks || !mine) {
    return (
      <p className="border-t border-red-600/20 px-3 py-2 text-sm text-muted-foreground" data-testid="red-line-cards-loading">
        Loading its cards…
      </p>
    );
  }
  const place = (repo: string | undefined, ref: string | undefined) => {
    const n = r.items.findIndex((it) => it.repo === repo && it.ref === ref);
    return n < 0 ? r.items.length : n;
  };
  const list: ({ ask: WaitingItem } | { review: ReviewItem })[] = [
    ...asks.map((ask) => ({ ask, n: place(ask.repo, ask.code) })),
    ...mine.map((review) => ({ review, n: place(review.repo, review.ref) })),
  ].sort((a, b) => a.n - b.n);
  const rest = r.items.length - list.length;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 border-t border-red-600/20 p-2 sm:p-3" data-testid="red-line-cards">
      {list.map((c) =>
        "ask" in c ? (
          <div key={`ask:${c.ask.id}`} className="min-w-0" data-testid="red-line-card" data-inbox-card={`ask:${c.ask.id}`}>
            <WaitingCard item={c.ask} showMilestone qualify />
          </div>
        ) : (
          <div key={`review:${c.review.id}`} className="min-w-0" data-testid="red-line-card" data-inbox-card={`review:${c.review.id}`}>
            {c.review.kind === "post" && c.review.post ? (
              <PostReviewCard item={c.review} onDone={() => markReviewGoneAfter(c.review.id, 320)} onFailed={() => unmarkReviewGone(c.review.id)} />
            ) : (
              <ReviewCard item={c.review} onDone={() => markReviewGoneAfter(c.review.id, 320)} onFailed={() => unmarkReviewGone(c.review.id)} onBack={() => unmarkReviewGone(c.review.id)} />
            )}
          </div>
        ),
      )}
      {list.length === 0 && (
        <p className="px-1 text-sm text-muted-foreground" data-testid="red-line-cards-none">
          No card on this line waits on you now. The team is working on its items.
        </p>
      )}
      {list.length > 0 && rest > 0 && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="red-line-cards-rest">
          {rest} more on this line {rest === 1 ? "is" : "are"} with the team, no card for you yet.
        </p>
      )}
    </div>
  );
}
