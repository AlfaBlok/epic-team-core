/**
 * the secure copy of a steps page. Every steps page lives on a plain-http tailnet host,
 * where a browser gives no microphone, so the kit's Voice button had to open a separate window on the console's https
 * origin. This route serves the registered page itself from the console, `/steps/view/<page id>/<its path>`, read over
 * the tailnet on each request: on that https copy the kit records in place under the note box (press, speak, press
 * again, it is filed), exactly as the cards do.
 *
 * Only for a signed-in caller of the page's world (the console's login guards it like any app page; it is never an open
 * path), only the registered page's own host and port (no other address is ever fetched), GET only, at most 5 MB a file.
 * The HTML is rewritten so the kit and its style load from this console (an http script on an https page is blocked)
 * and the page's own absolute links stay inside the copy.
 */
import type { Context, Hono } from "hono";
import { DEFAULT_TENANT } from "../db.js";
import { currentAuth } from "../auth/identity.js";
import type { StepPage } from "./steps.js";

export const VIEW_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_ID = /^sp_[a-f0-9]{8}$/;

/** The copy's address of a registered page (its path on this console). */
export const viewPath = (p: { id: string; url: string }) => {
  let u: URL;
  try {
    u = new URL(p.url);
  } catch {
    return undefined;
  }
  return `/steps/view/${p.id}${u.pathname}${u.search}`;
};

/**
 * the page's HTML as the copy serves it: the kit and its style from this console, the page's own origin mapped into the
 * copy, the kit's api and voice origin attributes dropped (the kit then calls this console, same origin).
 */
export function rewriteHtml(html: string, pageOrigin: string, prefix: string): string {
  const esc = pageOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // the kit first (held aside, so the page's own links rewritten next never touch it), then root links, then the page's origin
  const KIT = "\u0000sk-kit\u0000";
  return html
    .replace(/(["'])https?:\/\/[^"'\s]+?\/steps-kit\.(js|css)(\?[^"'\s]*)?\1/g, (_m, q: string, ext: string) => `${q}${KIT}${ext}${q}`)
    .replace(/\sdata-(steps-api|voice-origin)=(["'])[^"']*\2/g, "")
    .replace(/(\s(?:src|href|action)=)(["'])\/(?!\/)/g, `$1$2${prefix}/`)
    .replace(new RegExp(`(["'(])${esc}(?=/|["')])`, "g"), `$1${prefix}`)
    .split(KIT)
    .join("/steps-kit.");
}

export interface StepsViewDeps {
  byId: (id: string) => StepPage | undefined;
  /** reads the tailnet page (tests pass a fake). */
  fetch?: typeof fetch;
}

export function mountStepsView(app: Hono, d: StepsViewDeps) {
  const get = d.fetch ?? fetch;
  const handler = async (c: Context) => {
    const id = c.req.param("id") ?? "";
    const p = PAGE_ID.test(id) ? d.byId(id) : undefined;
    // a page of another world is a 404, like a missing one
    const i = currentAuth()?.identity;
    const world = i && "tenant" in i && i.tenant ? i.tenant : DEFAULT_TENANT;
    if (!p || (p.world || DEFAULT_TENANT) !== world) return c.text("No steps page here.", 404);
    let base: URL;
    try {
      base = new URL(p.url);
    } catch {
      return c.text("This steps page has no address the console can read.", 404);
    }
    const prefix = `/steps/view/${p.id}`;
    const u = new URL(c.req.url);
    const rest = u.pathname.slice(prefix.length) || "/";
    const target = new URL(rest + u.search, base.origin);
    if (target.origin !== base.origin) return c.text("No steps page here.", 404);
    // the bare copy address opens the registered page itself
    if (rest === "/" && base.pathname !== "/") return c.redirect(`${prefix}${base.pathname}${base.search}`, 302);
    const r = await get(target.href, { signal: AbortSignal.timeout(8_000), redirect: "manual" }).catch(() => undefined);
    if (!r) return c.text("The steps page's server did not answer. Try again in a minute.", 502);
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      const to = loc ? new URL(loc, target) : undefined;
      if (to && to.origin === base.origin) return c.redirect(`${prefix}${to.pathname}${to.search}`, 302);
      return c.text("The steps page moved somewhere the copy does not follow.", 502);
    }
    const len = Number(r.headers.get("content-length"));
    if (Number.isFinite(len) && len > VIEW_MAX_BYTES) return c.text("Too big for the copy.", 413);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > VIEW_MAX_BYTES) return c.text("Too big for the copy.", 413);
    const type = r.headers.get("content-type") ?? "application/octet-stream";
    const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    if (/^text\/html\b/i.test(type)) return c.body(rewriteHtml(new TextDecoder().decode(buf), base.origin, prefix), r.status as 200, headers);
    return c.body(buf as Uint8Array<ArrayBuffer>, r.status as 200, headers);
  };
  app.get("/steps/view/:id", handler);
  app.get("/steps/view/:id/*", handler);
}
