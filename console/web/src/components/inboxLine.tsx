import { Link } from "react-router-dom";
import { splitDecisions } from "@/lib/cardKind";
import { Inbox } from "lucide-react";
import { useBlocked, useReviewCards, useStatusBatch } from "@/lib/inbox";
import { useProject } from "@/lib/project";

/** the full aggregated Inbox's own route (Home is the goals view); the top bar's Inbox button opens it. */
export const INBOX_PATH = "inbox";

/**
 * one line above the goals: how many things wait on him, a link to the Inbox. Nothing when nothing waits, so the goals
 * lead the page.
 */
export function InboxLine() {
  const { keep } = useProject();
  const { data: statuses } = useStatusBatch();
  // E948-S103: decisions wait on him with Blocked; finished work is to review
  const split = splitDecisions(useReviewCards({ keep }).cards);
  const blocked = useBlocked(statuses, { keep }).length + split.decisions.length;
  const review = split.review.length;
  if (statuses?.loading || blocked + review === 0) return null;
  const parts = [blocked ? `${blocked} waiting on you` : "", review ? `${review} to review` : ""].filter(Boolean).join(", ");
  return (
    <Link
      to={`/${INBOX_PATH}`}
      className="mx-auto mb-3 flex w-full max-w-6xl min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm hover:bg-accent"
      data-testid="home-inbox-line"
    >
      <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Inbox: {parts}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground underline underline-offset-4">Open</span>
    </Link>
  );
}
