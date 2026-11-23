/**
 * (the owner 22 Nov 23:45Z, vn_787c5934: "I pressed voice and then I pressed on the link ... it opens like a page
 * that I cannot navigate back from and it loses all the context. I just wasted maybe 20 minutes of talking"; and 23:50Z,
 * vn_ce90e291: "if the link takes you to a page outside the app, then it is a new window", "if the link sends you back to the
 * app, then it's not a new window").
 *
 *   tap a link ──▶ outside the app? ──yes──▶ new window (this tab, its note and its microphone stay)
 *                        │no
 *                        ▼
 *                 the router took it? ──yes──▶ in the app (the note goes on)
 *                        │no (a plain <a> to this site: a full reload)
 *                        ▼
 *                 a note is on? ──yes──▶ moved in the app without a reload (an app page) or a new window (a file, /api)
 *                        │no
 *                        ▼
 *                    left as it is
 *
 * One listener on the window, after React's (bubbling), so a react-router Link that already handled the tap is never touched.
 */
export interface LinkGuardDeps {
  /** a voice note (or anything that must not be lost) is on in this tab now. */
  busy: () => boolean;
  /** opens a new window (tests fake it). */
  open?: (url: string) => void;
}

/** every tab's "a note is on" check, so other link handlers (lib/inPlaceLinks) never load a page under a note. */
const busyChecks = new Set<() => boolean>();
export const noteOn = () => [...busyChecks].some((f) => f());

/** an address the app's router shows (not the console's API, not a file like /steps-kit.js). */
export const appPath = (path: string) => !/^\/api(\/|$)/.test(path) && !/\.[a-z0-9]{1,5}$/i.test(path);

/** where a tap on this anchor goes, or undefined when it is not ours to change. */
export function linkRoute(a: HTMLAnchorElement, here: Location, busy: boolean): { kind: "window" | "app"; url: URL } | undefined {
  const href = a.getAttribute("href");
  if (!href || href.startsWith("#")) return undefined;
  const target = (a.getAttribute("target") ?? "").toLowerCase();
  if ((target && target !== "_self") || a.hasAttribute("download")) return undefined;
  let url: URL;
  try {
    url = new URL(href, here.href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined; // mailto:, tel: leave the page alone
  if (url.origin !== here.origin) return { kind: "window", url };
  if (!busy) return undefined;
  // the same page with another #anchor scrolls, it never reloads
  if (url.pathname === here.pathname && url.search === here.search && url.hash) return undefined;
  return { kind: appPath(url.pathname) ? "app" : "window", url };
}

/** Hook the tab's links once; returns the unhook. */
export function hookLinks(win: Window, d: LinkGuardDeps): () => void {
  const open = d.open ?? ((u: string) => void win.open(u, "_blank", "noopener"));
  const click = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const r = linkRoute(a, win.location, d.busy());
    if (!r) return;
    e.preventDefault();
    if (r.kind === "window") return open(r.url.href);
    // react-router's BrowserRouter follows popstate: the app page changes, the tab (and its note) stays
    win.history.pushState({}, "", r.url.pathname + r.url.search + r.url.hash);
    win.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  };
  // a reload or a typed address while a note is on: the browser asks first (the parts kept on the device still go if he leaves)
  const unload = (e: BeforeUnloadEvent) => {
    if (!d.busy()) return;
    e.preventDefault();
    e.returnValue = "";
  };
  win.addEventListener("click", click);
  win.addEventListener("beforeunload", unload);
  busyChecks.add(d.busy);
  return () => {
    busyChecks.delete(d.busy);
    win.removeEventListener("click", click);
    win.removeEventListener("beforeunload", unload);
  };
}
