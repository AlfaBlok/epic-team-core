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

/** each product's own colour comes from the hosted layer (lib/hostedBrands.ts); a product it does not list reads muted. */
const MUTED = "text-muted-foreground";

export const productInk = (product: string, inks: Record<string, string> = HOSTED_PRODUCT_INK) => inks[product.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? MUTED;

/** `Acme: 5 testers` → product `Acme`, goal `5 testers`; a name with no product part keeps it whole. */
export function splitObjectiveName(name: string): { product?: string; goal: string } {
  const m = /^([^:]{1,32}):\s+(\S[\s\S]*)$/.exec(name.trim());
  return m ? { product: m[1].trim(), goal: m[2] } : { goal: name };
}

/**
 * `stack` (the default): the product label above the goal, for lists and headers. `inline`: label then goal on one line,
 * for crumbs and bars. `after` sits right after the goal (a count, a proposed mark). The goal text keeps the caller's
 * size and weight (it inherits); the label is always the same small one.
 */
export function ObjectiveName({ name, layout = "stack", after, className }: { name: string; layout?: "stack" | "inline"; after?: ReactNode; className?: string }) {
  const { product, goal } = splitObjectiveName(name);
  if (!product)
    return (
      <span className={className} data-testid="objective-name">
        <span data-testid="objective-goal">{goal}</span>
        {after}
      </span>
    );
  const label = (
    <span className={cn("text-[12px] font-semibold leading-tight", productInk(product))} data-testid="objective-product" data-product={product}>
      {product}
      {/* the colon stays for screen readers and copy-paste: the name reads whole. */}
      <span className="sr-only">: </span>
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
