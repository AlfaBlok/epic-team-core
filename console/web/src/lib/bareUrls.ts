/**
 * E948-S129 (the owner, vn_dc4a25de: "we should never have a URL that is not clickable, bro"): every URL a card, ask,
 * page or desk message shows is a link. `bareUrlsIn` lists the URLs a rendered tree shows as plain text (outside any
 * <a>, <pre>, copy box, form field or element marked `data-url-plain`), so tests fail a card that shows one.
 */
import { URL_IN } from "@/lib/linkjsx/links";

export function bareUrlsIn(root: Node): string[] {
  const out: string[] = [];
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue ?? "";
    const el = n.parentElement;
    if (el?.closest("a[href], pre, textarea, input, script, style, svg, [data-url-plain], [data-owner-command], [data-runs-on], code.select-all")) continue;
    for (const m of text.matchAll(new RegExp(URL_IN.source, "gi"))) out.push(m[0].replace(/[.,;:!?]+$/, ""));
  }
  return out;
}
