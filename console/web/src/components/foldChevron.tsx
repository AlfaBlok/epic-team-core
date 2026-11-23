import { cn } from "@/lib/utils";

/**
 * The one fold chevron (the owner 22 Nov: card headings unfold on click "but nothing shows it").
 *
 *   closed  ›  Heading          open  ⌄  Heading
 *                                        the folded content
 *
 * Every foldable heading in the app shows it: right when closed, turned down when open, a short rotate (none with
 * reduced motion). The look lives in polish.css (`.fold-chevron`), and every <summary> gets the same chevron there
 * by itself, so a <details> never needs this component. A button that folds passes its own `open` and carries
 * aria-expanded; the chevron itself is hidden from screen readers (the button's aria-expanded says the state).
 */
export function FoldChevron({ open, className }: { open?: boolean; className?: string }) {
  return <span aria-hidden="true" className={cn("fold-chevron", className)} data-open={open === undefined ? undefined : open ? "true" : "false"} data-testid="fold-chevron" />;
}
