import { cn } from "@/lib/utils";
import { customerSitesOf, sites, socialProduct } from "@/lib/identity";

/**
 * (one letter per product: "E for EpicSpine, T for EpicTeam,
 * S for the social product"): EpicTeam's leaning T on an ink tile, the social product's leaning S inside a violet speech bubble; EpicSpine's
 * E lives on epicspine.dev. The same shapes as the favicons that hosted/console/scripts/gen-brand.mjs writes (hosted/tests/logoC.brand.test.tsx
 * keeps them equal). The colours follow the app's own light/dark switch (the `dark` class on <html>), not the OS setting
 * the favicon follows.
 */
export const BRAND_MARKS = {
  team: {
    name: "EpicTeam",
    plate: { rect: true, d: "" },
    letter: { dx: "3.40", d: "M8 6H24V10H19V26H13V10H8Z" },
    tile: "fill-[#18181b] dark:fill-[#fafafa]",
    glyph: "fill-[#fafafa] dark:fill-[#18181b]",
  },
  social: {
    get name(): string {
      return socialProduct();
    },
    plate: { rect: false, d: "M6 0h20a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H15l-8 4v-4H6a6 6 0 0 1-6-6V6a6 6 0 0 1 6-6z" },
    letter: { dx: "2.98", d: "M8 8A4 4 0 0 1 12 4L24 4L24 8L14 8L14 12L20 12A4 4 0 0 1 24 16L24 20A4 4 0 0 1 20 24L8 24L8 20L18 20L18 16L12 16A4 4 0 0 1 8 12Z" },
    tile: "fill-[#7c3bed] dark:fill-[#a977f8]",
    glyph: "fill-white dark:fill-[#18181b]",
  },
} as const;
export type BrandId = keyof typeof BRAND_MARKS;

/** The product of a skin's app name: the social product is the social mark, everything else EpicTeam's. */
export const brandOf = (appName: string): BrandId => (appName === BRAND_MARKS.social.name ? "social" : "team");

/** The other product, its address and its mark, for the "Open the social product" / "Open the team app" link: this console's two skins. */
export function sibling(brand: BrandId): { id: BrandId; url: string } {
  return brand === "team" ? { id: "social", url: `${sites().socialUrl.replace(/\/+$/, "")}/` } : { id: "team", url: `${sites().teamUrl.replace(/\/+$/, "")}/` };
}
/** on a customer site the sibling is the other product's current customer site (the old addresses redirect to it). */
export function siblingOf(brand: BrandId, host: string | undefined = typeof location === "undefined" ? undefined : location.hostname): { id: BrandId; url: string } {
  const sib = sibling(brand);
  const h = host?.toLowerCase();
  const onCustomerSite = !!h && (customerSitesOf("team").includes(h) || customerSitesOf("social").includes(h));
  const target = customerSitesOf(sib.id)[0];
  return onCustomerSite && target ? { id: sib.id, url: `https://${target}/` } : sib;
}

export function BrandMark({ brand, className, title }: { brand: BrandId; className?: string; title?: string }) {
  const m = BRAND_MARKS[brand];
  return (
    <svg viewBox="0 0 32 32" className={cn("h-8 w-8 shrink-0", className)} role="img" aria-label={title ?? m.name} data-testid="brand-mark" data-brand={brand}>
      {m.plate.rect ? <rect className={m.tile} width="32" height="32" rx="7" /> : <path className={m.tile} d={m.plate.d} />}
      <g transform={`translate(${m.letter.dx} 0) skewX(-12)`}>
        <path className={m.glyph} d={m.letter.d} />
      </g>
    </svg>
  );
}
