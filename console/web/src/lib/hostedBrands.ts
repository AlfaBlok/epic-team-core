/**
 * Brands the hosted layer gives its campaign repos (src/hosted/brands.ts, read through an optional glob like the
 * hosted routes): a build without src/hosted names every repo after itself.
 */
const plugs = import.meta.glob<{ HOSTED_BRANDS?: Record<string, string>; HOSTED_PRODUCT_INK?: Record<string, string> }>("../../../../../hosted/console/web/src/hosted/brands.ts", { eager: true });

export const HOSTED_BRANDS: Record<string, string> = Object.assign({}, ...Object.values(plugs).map((m) => m.HOSTED_BRANDS ?? {}));

/** each product's own text colour classes for an objective's product label; a build without src/hosted reads every one muted. */
export const HOSTED_PRODUCT_INK: Record<string, string> = Object.assign({}, ...Object.values(plugs).map((m) => m.HOSTED_PRODUCT_INK ?? {}));
