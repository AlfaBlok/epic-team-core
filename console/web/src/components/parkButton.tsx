import type { ReviewItem, WaitingItem } from "@/api";
import type { ClosedCardRef } from "@/api/review-types";
import { CardButton } from "@/components/ui/cardButton";
import { showClosed } from "@/lib/afterClose";
import { snoozeItem, snoozeReview, unsnoozeItem, unsnoozeReview } from "@/lib/snooze";

/**
 * E948-S83 iteration 2 (the owner 2026-11-14 23:38Z on a decision card, vn_fc018786: "There should always be one button which is
 * to park ... park is like a way to snooze ... if there had been an option for park, I think maybe that's the one I would have
 * taken"): every card that waits on him carries Park beside its own buttons, so no card forces a choice he is not ready to make.
 *
 *   [ his choices / Mark complete / Done … ]  [ Park ]  [ Give feedback ]
 *                                                │
 *        the existing snooze writer, `park: true`: ` — snoozed until: <a month>` on the row or ask line in its spine,
 *        the commit and Decisions say "parked" (L-45); the card leaves the inbox and every count, comes back by itself,
 *        and "Bring it back" on the floating note (or the Snoozed list) puts it back at once.
 */
export const PARK_DAYS = 30 as const;
export const PARK = {
  label: "Park",
  hint: "Not now. Nothing is decided: it leaves your inbox for a month and comes back by itself. Bring it back any time.",
  said: "Parked for a month",
} as const;

export function ParkButton({ onPark, disabled, className }: { onPark: () => void; disabled?: boolean; className?: string }) {
  return (
    <CardButton variant="outline" className={className} disabled={disabled} onClick={onPark} title={PARK.hint} data-testid="card-park">
      {PARK.label}
    </CardButton>
  );
}

/** Park a review card: a month's snooze written as parked, the floating note with Bring it back. */
export function parkReview(item: ReviewItem, title: string, card?: ClosedCardRef) {
  void snoozeReview(item, { days: PARK_DAYS }, title, true);
  showClosed({
    said: PARK.said,
    title,
    ...(card ? { card } : {}),
    back: async () => (await unsnoozeReview(item), { back: true, line: "It is back in your inbox." }),
  });
}

/** Park an open ask written in a spine: the same month on its line, written as parked. */
export function parkAsk(item: WaitingItem, label?: string) {
  void snoozeItem(item, { days: PARK_DAYS }, label, true);
  showClosed({
    said: PARK.said,
    title: item.question || item.title,
    ...(item.source === "ask" && item.repo && item.path && item.code ? { card: { kind: "ask" as const, repo: item.repo, path: item.path, ref: item.code, ...(item.milestoneId ? { milestoneId: item.milestoneId } : {}) } } : {}),
    back: async () => (await unsnoozeItem(item), { back: true, line: "It is back in your inbox." }),
  });
}
