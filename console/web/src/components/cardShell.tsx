import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * E948-S60 iteration 2 (the owner 2026-11-12 19:39Z, WhatsApp ^e-8f980e: "Why are the cards so different every time?"): the one
 * card shell every card type renders through, in both skins (L-2: one quiet family, the same frame for every kind).
 *
 *   ┌ CardShell ─ rounded-xl, border, bg-card, p-4 ────────────────────┐
 *   │ CardMeta:  <Kind word>  project · age · tags          [right]    │
 *   │ title (CARD_TITLE)                                               │
 *   │ body · the card's own buttons                                    │
 *   │ FeedbackBlock (the same box, the same Send)  ← always last       │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * cardInventory.test.tsx renders every card type and fails when one has no shell, no meta line with a kind word first, or an
 * ending other than the one feedback block.
 */

/** the frame: the same on every card. */
export const CARD_FRAME = "grid min-w-0 grid-cols-1 rounded-xl border bg-card p-4 text-card-foreground [overflow-wrap:anywhere]";
/** the card's title line: the same size and weight on every card. */
export const CARD_TITLE = "mt-1.5 text-[15px] font-medium leading-snug text-foreground";
/** the meta line's classes (WaitingCard keeps its own element, with these). */
export const CARD_META = "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground";

export const CardShell = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & { as?: "div" | "article" | "section"; kind: string }>(
  ({ as: El = "div", kind, className, children, ...rest }, ref) => (
    <El ref={ref as never} className={cn(CARD_FRAME, className)} data-card-shell={kind} {...rest}>
      {children}
    </El>
  ),
);
CardShell.displayName = "CardShell";

/** the meta line: the kind word first (Decide, Answer, Review, Alert, Mac…), then grey context, an optional control on the right. */
export function CardMeta({ kind, children, right, className, ...rest }: { kind: ReactNode; children?: ReactNode; right?: ReactNode; className?: string } & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div className={cn(CARD_META, className)} data-card-meta="" {...rest}>
      <span className="font-medium text-foreground" data-card-kind-word="">
        {kind}
      </span>
      {children}
      {right && <span className="ml-auto flex items-center gap-2">{right}</span>}
    </div>
  );
}
