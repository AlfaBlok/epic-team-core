/**
 * The owner (22 Nov): in the installed app a link on a card opened a new app window he could
 * not go back from. Here, at one place for the whole app, every link that would open a new window (an `<a target=_blank>`
 * anywhere, or a `window.open(url, "_blank")` from a card's own handler) opens in place instead, so the back arrow
 * (backArrow) or the phone's back returns to the card he clicked, scrolled to it (inboxPlace keeps the Inbox's place per
 * history entry). One of our screens opens through the router (no reload); a server page of ours (a steps page, an
 * evidence file) loads in the same window, but never while a voice note is on (then it opens a new window).
 * His newer word (22 Nov 23:50Z, vn_ce90e291, again 23 Nov 00:57Z, vn_b58dfccb): "if the link takes you to a
 * page outside the app, then it is a new window": an outside site is left alone and opens a new window, so the app, its
 * page and a note being recorded stay ("it says leave the site ... so the voice notes break").
 * In a browser tab nothing changes (a new tab is what a browser does well, and its own back stays); a Ctrl, Cmd, Shift or
 * middle click and a download keep their own behaviour.
 */

import { noteOn } from "@/voice/linkGuard";

type Go = (to: string) => void;

/** Paths the server answers itself, not the app's router: loaded as a page, never routed. */
const SERVER_PATH = /^\/(?:api|steps|landing|releases|login|people|auth-sync|sw\.js)(?:[/?#]|$)|\/[^/?#]*\.[a-z0-9]{1,6}(?:[?#]|$)/i;

/** Where a URL opens in place: "route" for one of our screens, "load" for a server page of ours, undefined to leave alone
 * (an outside site: a new window). */
export function inPlaceKind(href: string, origin = window.location.origin): "route" | "load" | undefined {
  let u: URL;
  try {
    u = new URL(href, origin);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined; // mailto:, tel:, blob:, data: keep their own way
  if (u.origin !== origin) return undefined; // outside the app: a new window, never in place (vn_ce90e291)
  return SERVER_PATH.test(u.pathname) ? "load" : "route";
}

function openInPlace(href: string, route: Go, load: Go, busy: () => boolean): boolean {
  const kind = inPlaceKind(href);
  if (!kind) return false;
  if (kind === "load" && busy()) return false; // a note is on: loading would unload it, so a new window instead
  if (kind === "route") {
    const u = new URL(href, window.location.origin);
    route(u.pathname + u.search + u.hash);
  } else load(new URL(href, window.location.origin).href);
  return true;
}

const opensNewWindow = (target: string | null | undefined) => !!target && !/^_(self|top|parent)$/i.test(target) && target !== "";

/**
 * Turn new windows into in-place moves for as long as it is installed; returns the undo. `route` moves inside the app
 * (react-router's navigate), `load` loads a page in this window.
 */
export function installInPlaceLinks(route: Go, load: Go = (to) => window.location.assign(to), busy: () => boolean = noteOn): () => void {
  // a click this file already moved: a card's own handler that then calls window.open for the same click is a no-op
  let moving = false;
  const moved = () => {
    moving = true;
    setTimeout(() => (moving = false), 0);
  };
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.hasAttribute("download") || !opensNewWindow(a.getAttribute("target"))) return;
    if (!openInPlace(a.href, route, load, busy)) return;
    e.preventDefault();
    moved();
  };
  // capture: before any card handler, so one that stops the click still never gets a new window
  window.addEventListener("click", onClick, true);
  const original = window.open;
  window.open = function (url?: string | URL, target?: string, features?: string) {
    if (url != null && (target === undefined || opensNewWindow(target))) {
      if (moving) return null;
      if (openInPlace(String(url), route, load, busy)) {
        moved();
        return null;
      }
    }
    return original.call(window, url, target, features);
  } as typeof window.open;
  return () => {
    window.removeEventListener("click", onClick, true);
    window.open = original;
  };
}
