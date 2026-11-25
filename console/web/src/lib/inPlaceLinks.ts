/**
 * The one link rule of the whole app (the owner 25 Nov, vn_77ec9815, said again):
 * "If the link is to an objective or ... somewhere inside the Epic Team app, then it should not open a new window ...
 * But if it's a URL that is just a pure URL that is like a page that's not inside the app ... it should open a new window."
 *
 *   tap a link ──▶ one of the app's screens? ──yes──▶ in the app (installed app: through the router, so Back returns)
 *                        │no: an outside site, or a page of ours the app does not draw (a steps page, a file, /api)
 *                        ▼
 *                  a new window, always (the app's own window never leaves the app, so its back and a note being
 *                  recorded stay)
 *
 * Before (034a89234): in the installed app a page of ours that the app does not draw was loaded in the app's own
 * window, and a link with no target to an outside page navigated the app's window whenever no note was on: no back, and
 * the recorder went with the page. Now nothing but an app screen ever opens in the app's window.
 * In a browser tab the app's own links keep the browser's behaviour (a new tab is what a browser does well); a Ctrl, Cmd,
 * Shift or middle click and a download keep their own behaviour everywhere.
 */

type Go = (to: string) => void;

/** Paths the server answers itself, not the app's router: pages not drawn by the app, so they open in a new window. */
const SERVER_PATH = /^\/(?:api|steps|landing|releases|login|people|auth-sync|sw\.js)(?:[/?#]|$)|\/[^/?#]*\.[a-z0-9]{1,6}(?:[?#]|$)/i;

/** Where a URL opens: "route" for one of the app's screens, "outside" for every other web page (a new window), undefined
 * for what keeps its own way (mailto:, tel:, blob:, data:). */
export function linkKind(href: string, origin = window.location.origin): "route" | "outside" | undefined {
  let u: URL;
  try {
    u = new URL(href, origin);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.origin !== origin) return "outside";
  return SERVER_PATH.test(u.pathname) ? "outside" : "route";
}

/** @deprecated the old name: "route" for an app screen, else undefined (a new window). */
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
    if (kind === "outside" && !blank) {
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
        if (linkKind(String(url)) === "route") {
          const u = new URL(String(url), window.location.origin);
          route(u.pathname + u.search + u.hash);
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
