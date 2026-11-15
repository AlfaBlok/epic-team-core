import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one button every card uses, in both skins (the console and the social site), for review, ask, draft,
 * decision, held post, stuck step and persona-set cards (the owner, 2026-11-12: "I'm not gonna press
 * another card until I'm shown buttons that look normal").
 *
 * - its natural width: never shrinks below its label (shrink-0), never wider than its card (max-w-full);
 * - its label on one line: no wrap, no break inside a word, whatever the card sets (`overflow-wrap:anywhere`);
 * - a 44 px tall tap target on a phone (under 640 px), its computer height unchanged;
 * - a row of card buttons that does not fit wraps whole buttons to the next line (the row is `flex-wrap`).
 *
 * `data-card-button` lets the shared polish sheet leave it alone (polish R1-2 lets badges in a card wrap, never
 * buttons) and lets a check find every card button on a page.
 */
export const CARD_BUTTON = "shrink-0 max-w-full whitespace-nowrap [overflow-wrap:normal] [word-break:normal] max-sm:min-h-11";

export const CardButton = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, size = "sm", ...props }, ref) => (
  <Button ref={ref} size={size} className={cn(CARD_BUTTON, className)} data-card-button="" {...props} />
));
CardButton.displayName = "CardButton";

/**
 * the one green link to check on a card: its own line ABOVE the card's buttons, phone and computer, so he opens the
 * thing before he decides (the owner 2026-11-14 23:43Z). Never inside the buttons row.
 */
export const CARD_LINK = "mt-3 flex w-fit max-w-full items-center text-[13px] font-medium text-emerald-700 [overflow-wrap:anywhere] hover:underline dark:text-emerald-400 max-sm:min-h-11";
