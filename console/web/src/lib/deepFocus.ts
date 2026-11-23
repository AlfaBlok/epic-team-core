/**
 * E948-S180 (the owner 22 Nov: "I would rather you did like a URL where you show me. You lead my attention to
 * what you want to show me"): a card's link to a console page lands on the one thing to look at.
 *
 * `?focus=<id or words>` or `#<id>`: the element with that id (else `data-focus`, else its `data-testid`, so every
 * screen's parts can be pointed at without new markup; `<name>:last` takes the last one, the newest chat line; else, for
 * `?focus=` only, the smallest row, line or block holding those words) scrolls to the middle of the screen and glows for a few seconds. Screens that
 * draw after their data arrives are waited for, up to 8 seconds. The page hub's pages do the same
 * (scripts/page_shell_kit/links.js); the review gate holds a card whose link to either is bare (server review/card.ts).
 */

const WAIT_MS = 8000;
const STEP_MS = 200;
const GLOW_MS = 3200;
const SKIP = "nav, header, aside, script, style, [role='dialog']";

/** What the address points at: `?focus=` first, else the `#` part. `words` says the value may be matched as words. */
export function focusTarget(href: string): { value: string; words: boolean } | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  const q = u.searchParams.get("focus")?.trim();
  if (q) return { value: q, words: true };
  const h = decodeURIComponent(u.hash.replace(/^#/, "")).trim();
  // a text fragment (#:~:text=) is found and marked by the browser itself
  if (!h || h.startsWith(":~:") || h.startsWith("/")) return undefined;
  return { value: h, words: false };
}

const norm = (t: string) => t.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

/** The element the target names: its id, its `data-focus`, else (words allowed) the smallest block holding the words. */
export function findFocus(root: ParentNode & { getElementById?: (id: string) => HTMLElement | null }, t: { value: string; words: boolean }): HTMLElement | null {
  const byId = (root as Document).getElementById?.(t.value) ?? root.querySelector<HTMLElement>(`[id="${cssEsc(t.value)}"]`);
  if (byId) return byId;
  const last = /:last$/.test(t.value);
  const name = cssEsc(t.value.replace(/:last$/, ""));
  const all = root.querySelectorAll<HTMLElement>(`[data-focus="${name}"], [data-testid="${name}"]`);
  const tagged = (last ? all[all.length - 1] : all[0]) ?? null;
  if (tagged || !t.words) return tagged;
  const needle = norm(t.value);
  if (needle.length < 3) return null;
  let best: HTMLElement | null = null;
  let bestLen = Infinity;
  root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,p,li,tr,td,th,dt,dd,section,article,div,span,a,strong,b").forEach((el) => {
    if (el.closest(SKIP)) return;
    const text = norm(el.textContent ?? "");
    if (!text.includes(needle) || text.length >= bestLen) return;
    best = el;
    bestLen = text.length;
  });
  const found = best as HTMLElement | null;
  const box = found?.closest<HTMLElement>("tr, li, dt, dd, figure, [data-testid]");
  return box && (box.textContent ?? "").length < 600 ? box : found;
}

function cssEsc(v: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
}

/** Scroll it to the middle and glow it briefly (one quiet amber, gone after a few seconds). */
export function glow(el: HTMLElement): void {
  // an instant jump, then once more after late boxes settle (a smooth scroll stops halfway when the page moves)
  el.scrollIntoView?.({ block: "center" });
  window.setTimeout(() => {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView?.({ block: "center" });
  }, 600);
  el.setAttribute("data-deep-focus", "");
  const s = el.style;
  const before = { outline: s.outline, outlineOffset: s.outlineOffset, backgroundColor: s.backgroundColor, transition: s.transition, borderRadius: s.borderRadius };
  s.transition = "background-color .6s ease, outline-color .6s ease";
  s.outline = "3px solid rgba(201,138,0,.85)";
  s.outlineOffset = "4px";
  s.borderRadius = before.borderRadius || "6px";
  s.backgroundColor = "rgba(255,214,102,.28)";
  window.setTimeout(() => {
    s.backgroundColor = before.backgroundColor;
    s.outline = before.outline;
    s.outlineOffset = before.outlineOffset;
    s.borderRadius = before.borderRadius;
    window.setTimeout(() => {
      s.transition = before.transition;
      el.removeAttribute("data-deep-focus");
    }, 700);
  }, GLOW_MS);
}

let lastHref = "";
let timer = 0;

/** Look for the target of the current address, once per address, waiting for a screen that draws late. */
export function focusNow(): void {
  const href = window.location.href;
  if (href === lastHref) return;
  lastHref = href;
  window.clearTimeout(timer);
  const t = focusTarget(href);
  if (!t) return;
  const until = Date.now() + WAIT_MS;
  const look = () => {
    if (window.location.href !== href) return;
    const el = findFocus(document, t);
    if (el) return glow(el);
    if (Date.now() < until) timer = window.setTimeout(look, STEP_MS);
  };
  look();
}

/** On first load and after every in-app move (the router's pushState) or `#` change. */
export function installDeepFocus(): void {
  for (const k of ["pushState", "replaceState"] as const) {
    const orig = history[k].bind(history);
    history[k] = ((...a: Parameters<History["pushState"]>) => {
      orig(...a);
      window.setTimeout(focusNow, 0);
    }) as History["pushState"];
  }
  window.addEventListener("popstate", focusNow);
  window.addEventListener("hashchange", focusNow);
  if (document.readyState === "complete") focusNow();
  else window.addEventListener("load", focusNow, { once: true });
}
