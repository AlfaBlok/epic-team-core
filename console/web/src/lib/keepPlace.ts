/**
 * (the owner 2026-11-09: "When an inbox card closes after an answer or voice note, the page collapses and leaves the owner
 * mid-way through the next card, lost. Scroll smoothly so the next card's top sits where the old one was; on the phone too."):
 * the card he works on is remembered (a tap anywhere in it, or a press that answers it), its top measured while it is on the
 * page. When it leaves the list (answer, approve, feedback, snooze, close, a voice note's answer, a review press), and the
 * list has settled (the slide-out, the "also closed N" line of, other asks the same answer closed), the page scrolls
 * smoothly so the next card's top sits where the old card's top was; a card whose top was above the screen lands the next
 * one just under the top bar. The last card of a list lands on the next section's header, or nothing moves (the end).
 * prefers-reduced-motion jumps without the animation. Phone (390 px) and desktop alike: the page scrolls the window, or the
 * nearest scrolling box around the card.
 *
 * Every leaving card carries `data-inbox-card="<id>"`; section headers are `[data-fold-section]` (homeSection).
 */

const CARD = "[data-inbox-card]";
const NEXT = `${CARD}, [data-fold-section]`;
/** How long a card stays remembered after his last touch (an ask waits for the refetch that drops it). */
export const KEEP_MS = 3 * 60_000;
/** The list has settled when nothing changed on the page for this long (at most SETTLE_MAX_MS after the card left). */
export const SETTLE_MS = 150;
export const SETTLE_MAX_MS = 1_500;
/** The gap left between the top bar and a card that lands at the top of the screen. */
export const GAP = 12;

type Armed = { id: string; top: number; next: string[]; path: string; until: number };
let armed: Armed | undefined;
let installed: (() => void) | undefined;

/** E948-S208: a green Sent row keeps its card's `data-inbox-card`, but it is a card he already sent: never a place to land on. */
const SENT_ROW = '[data-testid="sent-row"]';
const isSentRow = (el: Element) => !!el.closest?.(SENT_ROW);
const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));
const cardEl = (id: string) => document.querySelector<HTMLElement>(`${CARD}[data-inbox-card="${esc(id)}"]`);
/** A stable key for a landing place: a card's id, or a section's test id. */
const keyOf = (el: Element) => (el.matches(CARD) ? `card:${el.getAttribute("data-inbox-card")}` : `section:${el.getAttribute("data-testid") ?? ""}`);
const byKey = (k: string) =>
  k.startsWith("card:") ? cardEl(k.slice(5)) : document.querySelector<HTMLElement>(`[data-fold-section][data-testid="${esc(k.slice(8))}"]`);

/** The nearest box that scrolls around `el`, or the page (null). */
export function scrollerOf(el: Element | null): HTMLElement | null {
  for (let p = el?.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Where the visible area starts: under the sticky top bar for the page, the box's own top for a scrolling box. */
export function visibleTop(scroller: HTMLElement | null): number {
  if (scroller) return scroller.getBoundingClientRect().top;
  const bar = document.querySelector('[data-testid="topbar"]');
  const top = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
  // E948-S145: an open section's heading stuck under the bar covers the cards too
  let under = top;
  for (const h of Array.from(document.querySelectorAll("[data-fold-header][data-sticky]"))) {
    const r = h.getBoundingClientRect();
    if (r.height && Math.abs(r.top - top) < 2) under = Math.max(under, r.bottom);
  }
  return under;
}

/**
 * Where the next card's top must land: where the old card's top was, or just under the top bar when the old card started
 * above the screen (he was at its buttons, low in a long card).
 */
export function landingTop(oldTop: number, top0: number): number {
  return oldTop < top0 ? top0 + GAP : oldTop;
}

/** How far to scroll (positive = down) so the target's top lands at `landing`; 0 when it is already there. */
export function scrollDelta(targetTop: number, landing: number): number {
  const d = Math.round(targetTop - landing);
  return Math.abs(d) < 2 ? 0 : d;
}

const reduced = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Measure the remembered card again (it may have scrolled or grown since the tap). */
function measure(a: Armed) {
  const el = cardEl(a.id);
  if (!el) return;
  a.top = el.getBoundingClientRect().top;
  // the next few places after it, in page order: the following cards, then the next section's header
  const all = Array.from(document.querySelectorAll(NEXT));
  const after = all.filter((n) => n !== el && !el.contains(n) && !n.contains(el) && !isSentRow(n) && el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
  a.next = after.slice(0, 8).map(keyOf);
}

/** Remember card `id` as the one he works on (a press calls this too, so a voice note or a key press counts). */
export function keepPlace(id: string) {
  if (!cardEl(id)) return;
  armed = { id, top: 0, next: [], path: location.pathname, until: Date.now() + KEEP_MS };
  measure(armed);
}

/** Tests only. */
export const keptPlace = () => armed;
export const resetKeepPlace = () => {
  armed = undefined;
};

let settleTimer: ReturnType<typeof setTimeout> | undefined;
let settleStart = 0;

/** The card left: wait until the list settled, then scroll so the next place's top lands where the card's top was. */
function land(a: Armed) {
  armed = undefined;
  settleStart = Date.now();
  const go = () => {
    settleTimer = undefined;
    if (location.pathname !== a.path || cardEl(a.id)) return;
    const target = a.next.map(byKey).find((el): el is HTMLElement => !!el && el.isConnected);
    if (!target) return; // the last card on the page: the page ends where it ends
    const scroller = scrollerOf(target);
    const delta = scrollDelta(target.getBoundingClientRect().top, landingTop(a.top, visibleTop(scroller)));
    if (!delta) return;
    const behavior: ScrollBehavior = reduced() ? "auto" : "smooth";
    (scroller ?? window).scrollBy({ top: delta, behavior });
  };
  const wait = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(go, Date.now() - settleStart >= SETTLE_MAX_MS ? 0 : SETTLE_MS);
  };
  wait();
  return wait;
}

/** Install once (main.tsx): the tap that picks the card, the scroll that re-measures it, the watcher that sees it leave. */
export function installKeepPlace(): () => void {
  if (installed) return installed;
  let settling: (() => void) | undefined;
  const onTouch = (e: Event) => {
    // folding a section takes its cards away on purpose: nothing to land on
    if ((e.target as Element | null)?.closest?.("[data-fold-header]")) return void (armed = undefined);
    const card = (e.target as Element | null)?.closest?.(CARD);
    const id = card?.getAttribute("data-inbox-card");
    if (id) keepPlace(id);
  };
  const onScroll = () => {
    if (armed && cardEl(armed.id)) measure(armed);
  };
  const mo = new MutationObserver(() => {
    if (settling && settleTimer) return settling(); // still settling after a card left: wait for quiet
    settling = undefined;
    const a = armed;
    if (!a) return;
    if (Date.now() > a.until) return void (armed = undefined);
    if (cardEl(a.id)) return measure(a);
    settling = land(a);
  });
  document.addEventListener("pointerdown", onTouch, true);
  document.addEventListener("keydown", onTouch, true);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  mo.observe(document.body, { childList: true, subtree: true });
  installed = () => {
    document.removeEventListener("pointerdown", onTouch, true);
    document.removeEventListener("keydown", onTouch, true);
    window.removeEventListener("scroll", onScroll, { capture: true });
    mo.disconnect();
    clearTimeout(settleTimer);
    settleTimer = undefined;
    armed = undefined;
    installed = undefined;
  };
  return installed;
}

/**
 * E948-S208 (the owner 25 Nov, vn_7a378324: the screen never jumps to a card he already sent, so he sees the rest of his
 * inbox). The moment he answers a card (lib/sentRows markSent, before the card turns into its Sent row):
 *
 *   its top on the screen     ──▶  that spot holds: the Sent row stays where the card's top was, nothing moves
 *   its top above the screen  ──▶  the next card still waiting on him lands just under the top bar
 *                                  (never a Sent row, never back up to the row he just sent)
 *
 * The place is held for HOLD_MS, frame by frame, while the card collapses, an older Sent row leaves and the counts redraw
 * (no browser's own scroll anchoring is needed: iPhone Safari has none). His own scroll or swipe ends the hold.
 */
export const HOLD_MS = 900;
let holding: (() => void) | undefined;

/** Stop holding his place (a new answer, a section that folds). */
export function stopHold() {
  holding?.();
  holding = undefined;
}

function hold(key: string, want: number, scroller: HTMLElement | null) {
  stopHold();
  if (typeof window === "undefined") return;
  const until = Date.now() + HOLD_MS;
  let stop = false;
  const mine = () => void (stop = true);
  const end = () => {
    stop = true;
    window.removeEventListener("wheel", mine);
    window.removeEventListener("touchmove", mine);
  };
  window.addEventListener("wheel", mine, { passive: true });
  window.addEventListener("touchmove", mine, { passive: true });
  holding = end;
  const keep = () => {
    if (stop) return;
    const el = byKey(key);
    if (el?.isConnected) {
      const d = scrollDelta(el.getBoundingClientRect().top, want);
      if (d) (scroller ?? window).scrollBy({ top: d, behavior: "auto" });
    }
    if (Date.now() < until) requestAnimationFrame(keep);
    else if (holding === end) stopHold();
  };
  requestAnimationFrame(keep);
}

/** The place to hold when card `slot` is answered (pure on the page as it is now); undefined = nothing to hold. */
export function answerPlace(slots: string[]): { key: string; want: number; scroller: HTMLElement | null } | undefined {
  if (typeof document === "undefined") return undefined;
  const el = slots.map(cardEl).find((x): x is HTMLElement => !!x && !isSentRow(x));
  if (!el || typeof el.getBoundingClientRect !== "function") return undefined;
  const scroller = scrollerOf(el);
  const top0 = visibleTop(scroller);
  const top = el.getBoundingClientRect().top;
  if (top >= top0) return { key: keyOf(el), want: top, scroller };
  const next = Array.from(document.querySelectorAll(NEXT)).find(
    (n) => n !== el && !el.contains(n) && !n.contains(el) && !isSentRow(n) && !!(el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
  return next ? { key: keyOf(next), want: top0 + GAP, scroller } : undefined;
}

/** He answered card(s) `slots`: hold his place (see above). Called by markSent before the card turns into its Sent row. */
export function holdAfterAnswer(slots: string[]) {
  const p = answerPlace(slots);
  if (p) hold(p.key, p.want, p.scroller);
}

/**
 * E948-S208: a section that folded by itself after he answered its last card. When its heading had scrolled above the
 * screen (a long section, he was low in it) the folded heading lands just under the top bar, with the next section right
 * under it; a heading still on the screen stays where it is.
 */
export function landFoldedSection(section: Element) {
  if (typeof document === "undefined" || typeof section.getBoundingClientRect !== "function") return;
  const bar = document.querySelector('[data-testid="topbar"]');
  const top0 = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
  const top = section.getBoundingClientRect().top;
  if (top >= top0) return;
  const d = scrollDelta(top, top0 + GAP);
  if (d) window.scrollBy({ top: d, behavior: "auto" });
}
