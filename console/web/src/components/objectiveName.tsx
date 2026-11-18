import type { ReactNode } from "react";
import { HOSTED_PRODUCT_INK } from "@/lib/hostedBrands";
import { cn } from "@/lib/utils";

/**
 * An objective's name in two parts, everywhere it shows. Every name is `Product: short goal`, and the owner asked that
 * the two parts look different: two objectives with the same goal under different products read as one name twice.
 * So the product is a small label in its own colour and the goal is the main text. The product's colour is data (whose
 * objective it is), so the clean look's "colour only on data and the one action" holds. One component: the sidebar,
 * the objectives screen, an objective's page, its crumbs and the product pages all draw the name through it, both skins.
 */

/**
 * each product's own colour (text and its soft background) comes from the hosted layer (lib/hostedBrands.ts); a product
 * it does not list reads muted on the same soft grey. Every label is the same small chip with a very subtle soft
 * background, never white on the dark sidebar (the owner: "not white ... maybe like a soft background to these labels.
 * Very subtle, but to make it clear that it's different").
 */
const MUTED = "text-muted-foreground bg-muted/70";

export const productInk = (product: string, inks: Record<string, string> = HOSTED_PRODUCT_INK) => inks[product.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? MUTED;

/** the product's own text colour alone, no soft box (the sidebar, the owner's pick A: the box's padding broke its one left edge). */
export const productText = (product: string, inks: Record<string, string> = HOSTED_PRODUCT_INK) =>
  productInk(product, inks)
    .split(/\s+/)
    .filter((c) => !/(^|:)bg-/.test(c))
    .join(" ");

/** `Acme: 5 testers` → product `Acme`, goal `5 testers`; a name with no product part keeps it whole. */
export function splitObjectiveName(name: string): { product?: string; goal: string } {
  const m = /^([^:]{1,32}):\s+(\S[\s\S]*)$/.exec(name.trim());
  return m ? { product: m[1].trim(), goal: m[2] } : { goal: name };
}

/**
 * `stack` (the default): the product label above the goal, for lists and headers. `inline`: label then goal on one line,
 * for crumbs and bars. `flow`: label and goal run as one line of text that wraps back to the column's left edge, never
 * under the goal's own start (the objectives rows on the owner's phone: a number, the label and the goal on one line). `after` sits right after the goal (a count, a proposed mark). The goal text keeps the caller's
 * size and weight (it inherits); the label is always the same small one.
 */
export function ObjectiveName({ name, layout = "stack", after, className }: { name: string; layout?: "stack" | "inline" | "flow"; after?: ReactNode; className?: string }) {
  const { product, goal } = splitObjectiveName(name);
  if (!product)
    return (
      <span className={className} data-testid="objective-name">
        <span data-testid="objective-goal">{goal}</span>
        {after}
      </span>
    );
  const label = (
    // relative: the hidden colon below is absolutely placed; without a placed box around it, it escapes any clipped tag
    // the name sits in (a card's one-row top line on a phone) and makes the whole page scroll sideways
    <span className={cn("relative w-fit rounded px-1.5 py-px text-[12px] font-semibold leading-tight", productInk(product))} data-testid="objective-product" data-product={product}>
      {product}
      {/* the colon stays for screen readers and copy-paste: the name reads whole. */}
      <span className="sr-only">: </span>
    </span>
  );
  if (layout === "flow")
    return (
      <span className={cn("min-w-0", className)} data-testid="objective-name" data-layout="flow">
        <span className="mr-1.5 inline-block align-[1px]">{label}</span>
        {/* one block: beside the label when it fits, else whole on the next line from the left edge ("5 testers", never "5" then "testers") */}
        <span className="inline-block max-w-full" data-testid="objective-goal">
          {goal}
          {after}
        </span>
      </span>
    );
  return layout === "inline" ? (
    <span className={cn("inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5", className)} data-testid="objective-name" data-layout="inline">
      {label}
      <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="objective-goal">
        {goal}
        {after}
      </span>
    </span>
  ) : (
    <span className={cn("grid min-w-0 gap-0.5", className)} data-testid="objective-name" data-layout="stack">
      {label}
      <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="objective-goal">
        {goal}
        {after}
      </span>
    </span>
  );
}
