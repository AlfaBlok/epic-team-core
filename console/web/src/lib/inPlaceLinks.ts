/**
 * The one link rule of the whole app (the owner 25 Nov, vn_77ec9815, said again):
 * "If the link is to an objective or ... somewhere inside the Epic Team app, then it should not open a new window ...
 * But if it's a URL that is just a pure URL that is like a page that's not inside the app ... it should open a new window."
 *
 *   tap a link ──▶ one of the app's screens? ──yes──▶ in the app (installed app: through the router, so Back returns)
 *                        │no
 *                        ▼
 *                 a page of ours the app does not draw (a steps page, a file, /api)? ──yes──▶ installed app: shown inside
 *                        │no: another site                    the app on its own screen (/open?u=…, components/OurPage):
 *                        ▼                                    Back returns, a note goes on, never window.open, no reload
 *                  a new window (another origin is out of the app's scope: the phone shows it over the app, Back returns)
 *
 * Why a page of ours never goes to window.open in the installed app (the owner 25 Nov 14:57Z, vn_982a8bd6, the fourth
 * time: "it opens a brand new instance of the app ... the back button does not work"): its URL is inside the installed
 * app's scope, so Android opens it as a SECOND copy of the app, with no way back. fed3f237a (25 Nov 09:22) did that.
 * In a browser tab the app's own links keep the browser's behaviour (a new tab is what a browser does well); a Ctrl, Cmd,
 * Shift or middle click and a download keep their own behaviour everywhere.
 */

/** The app's screen that shows a page of ours the app does not draw (components/OurPage). */
export const OUR_PAGE_PATH = "/open";
export const ourPagePath = (path: string) => `${OUR_PAGE_PATH}?u=${encodeURIComponent(path)}`;

type Go = (to: string) => void;

/** Paths the server answers itself, not the app's router: pages of ours the app does not draw. */
const SERVER_PATH = /^\/(?:api|steps|landing|releases|login|people|auth-sync|sw\.js)(?:[/?#]|$)|\/[^/?#]*\.[a-z0-9]{1,6}(?:[?#]|$)/i;

/** Where a URL opens: "route" for one of the app's screens, "page" for a page of ours the app does not draw (inside the
 * installed app's scope), "outside" for another site (a new window), undefined for what keeps its own way (mailto:, tel:,
 * blob:, data:). */
export function linkKind(href: string, origin = window.location.origin): "route" | "page" | "outside" | undefined {
  let u: URL;
  try {
    u = new URL(href, origin);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.origin !== origin) return "outside";
  return SERVER_PATH.test(u.pathname) ? "page" : "route";
}

/** @deprecated the old name: "route" for an app screen, else undefined. */
export const inPlaceKind = (href: string, origin = window.location.origin) => (linkKind(href, origin) === "route" ? "route" : undefined);

const opensNewWindow = (target: string | null | undefined) => !!target && !/^_(self|top|parent)$/i.test(target);

/**
 * Install the rule; returns the undo. `route` moves inside the app (react-router's navigate). `installed`: the installed
 * app, where a new-window link to one of our screens moves in place instead (it has no tabs to come back from).
 * Everywhere, a link to an outside page or a server page with no new-window target opens a new window (`open`).
 */
export function installInPlaceLinks(
  route: Go,
  o: { installed?: boolean; open?: (url: string) => void } = {},
): () => void {
  const installed = o.installed ?? true;
  const original = window.open;
  /** The installed app, a page of ours: on the app's own screen for it (Back returns, a note goes on), never window.open
   * (a second copy of the app) and never loaded over the app (that ends a note and reloads the app on Back). */
  const showPage = (url: string) => {
    const u = new URL(url, window.location.origin);
    route(ourPagePath(u.pathname + u.search + u.hash));
  };
  // window.open at the time of the tap (the wrapper below hands an outside page to the browser), so a later wrapper sees it
  const open = o.open ?? ((url: string) => void window.open(url, "_blank", "noopener"));
  // a click this file already moved: a card's own handler that then calls window.open for the same click is a no-op
  let moving = false;
  const moved = () => {
    moving = true;
    setTimeout(() => (moving = false), 0);
  };
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.hasAttribute("download")) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    const kind = linkKind(a.href);
    const blank = opensNewWindow(a.getAttribute("target"));
    if (kind === "page" && installed) {
      e.preventDefault();
      showPage(a.href);
      moved();
      return;
    }
    if ((kind === "outside" || kind === "page") && !blank) {
      // a page outside the app with no new-window target would take the app's own window: a new window instead
      e.preventDefault();
      open(a.href);
      moved();
      return;
    }
    if (kind === "route" && blank && installed) {
      const u = new URL(a.href);
      e.preventDefault();
      route(u.pathname + u.search + u.hash);
      moved();
    }
    // an outside page with target=_blank: the browser's own new window
  };
  // capture: before any card handler, so one that stops the click still never takes the app's window
  window.addEventListener("click", onClick, true);
  if (installed)
    window.open = function (url?: string | URL, target?: string, features?: string) {
      if (url != null && (target === undefined || target === "" || opensNewWindow(target))) {
        if (moving) return null;
        const kind = linkKind(String(url));
        if (kind === "route") {
          const u = new URL(String(url), window.location.origin);
          route(u.pathname + u.search + u.hash);
          moved();
          return null;
        }
        if (kind === "page") {
          showPage(String(url));
          moved();
          return null;
        }
      }
      return original.call(window, url, target, features);
    } as typeof window.open;
  return () => {
    window.removeEventListener("click", onClick, true);
    if (installed) window.open = original;
  };
}
