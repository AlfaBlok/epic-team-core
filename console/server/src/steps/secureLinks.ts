/**
 * every link the console hands out to a steps page (or any page served on the same
 * page host and port, an evidence page beside it) opens the page's secure copy on the console (`/steps/view/<id>/…`,
 * stepView.ts), so its Voice button records at the first press and nothing reloads. A browser gives no microphone to a
 * plain-http page, and the page hosts are plain http on the tailnet.
 *
 * Only addresses whose host and port belong to a registered steps page change, only when the console's own address is
 * https (a test console keeps the plain links), and a TEST page is never the target of someone else's link.
 */
import { sites } from "../identity.js";

export interface SecurePage {
  id: string;
  url: string;
  title?: string;
}

let source: (() => SecurePage[]) | undefined;
let cache: { at: number; byOrigin: Map<string, string>; byPage: Map<string, string> } | undefined;
const pageKey = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
const TTL_MS = 30_000;

/** the console tells it where the registered pages are (createSteps' list); tests pass a list. */
export function setSecurePages(list: (() => SecurePage[]) | undefined): void {
  source = list;
  cache = undefined;
}

function byOrigin(): Map<string, string> {
  return known().byOrigin;
}
function known(): NonNullable<typeof cache> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const m = new Map<string, string>();
  const pages = new Map<string, string>();
  for (const p of source?.() ?? []) {
    if (/^TEST\b/.test(p.title ?? "")) continue;
    try {
      const u = new URL(p.url);
      if (u.protocol !== "http:") continue;
      // the newest registration of an origin wins when the list comes newest first; keep the first seen
      if (!m.has(u.origin)) m.set(u.origin, p.id);
      if (!pages.has(pageKey(u))) pages.set(pageKey(u), p.id);
    } catch {
      /* no address */
    }
  }
  cache = { at: Date.now(), byOrigin: m, byPage: pages };
  return cache;
}

/** the secure copy of `url` when its page host is a registered steps page's, else `url` as it is. */
export function secureCopyOf(url: string, origin: string = sites().teamUrl): string {
  if (!/^https:\/\//.test(origin) || !/^http:\/\//i.test(url)) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  // the page's own registration first, else another registered page on the same host and port (the copy serves its
  // whole origin; the page's own steps-token.js still names its own page)
  const k = known();
  const id = k.byPage.get(pageKey(u)) ?? k.byOrigin.get(u.origin);
  return id ? `${origin.replace(/\/+$/, "")}/steps/view/${id}${u.pathname}${u.search}${u.hash}` : url;
}

const HTTP_URL = /http:\/\/[^\s)\]|>"'`<]+/gi;

/** the same for every plain-http address inside a text (a card's delivered line, a desk line). */
export function secureLinksIn(text: string, origin?: string): string {
  if (!byOrigin().size) return text;
  return text.replace(HTTP_URL, (m) => {
    // a sentence's last full stop or comma is not part of the address
    const tail = /[.,;:]+$/.exec(m)?.[0] ?? "";
    const core = tail ? m.slice(0, -tail.length) : m;
    return secureCopyOf(core, origin) + tail;
  });
}

/** every string inside a JSON-like value, links rewritten (cards and the Pages list on their way out). */
export function secureDeep<T>(v: T, origin?: string): T {
  if (!byOrigin().size) return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return x.includes("http://") ? secureLinksIn(x, origin) : x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v) as T;
}
