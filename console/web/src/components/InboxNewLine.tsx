import { useEffect } from "react";
import { useNavigationType } from "react-router-dom";
import { gateNewCards, showNewCards, useNewCardCount } from "@/lib/inboxNew";
import { PHONE_TAP } from "@/components/common";
import { cn } from "@/lib/utils";

/**
 * On the Inbox, new cards wait behind one quiet "N new" line instead of moving the card he reads (lib/inboxNew).
 * The line floats at the bottom of the screen, out of the page's flow, so it appearing moves nothing either; his tap shows
 * them and keeps the card at the top of his screen where it was. `visit` is the Inbox visit (lib/inboxPlace).
 */
export function InboxNewLine({ visit }: { visit: string }) {
  const nav = useNavigationType();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // Back (a POP with its own history key) keeps what he had seen; a fresh load (key "default") shows everything
  useEffect(() => gateNewCards(visit, nav === "POP" && visit !== "default"), [visit]);
  const n = useNewCardCount();
  if (!n) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-3 md:pl-64" data-testid="inbox-new-line">
      <button
        type="button"
        onClick={() => showNewCards()}
        className={cn(PHONE_TAP, "pointer-events-auto h-9 rounded-full border bg-background px-4 text-sm text-foreground hover:bg-accent")}
        aria-live="polite"
        data-testid="inbox-new-show"
      >
        {n} new
      </button>
    </div>
  );
}
