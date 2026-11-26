import { useEffect, useState } from "react";

/**
 * The owner (vn_a63d5805 17 Nov: "when I close it, the page has moved under me because maybe new cards showed
 * up ... if they're added above it, then scroll down automatically, and if not, they are added below"; started again when
 * he closed the inbox-speed card, 22 Nov): new cards arriving never move the card he is reading.
 *
 * While the Inbox page is open (the gate is on), an inbox list that a poll brings back with a card he has not seen yet is
 * parked whole: the screen keeps what it shows, and a quiet "N new" line (components/InboxNewLine) floats over the page,
 * out of its flow. His tap shows them, keeping the card at the top of his screen where it was. What he does himself (an
 * answer, a snooze) applies at once, as before; a list that only changed cards he already sees applies too (nothing new
 * comes in above him). Back to the Inbox from a link keeps the cards he had seen for that visit (sessionStorage), and a
 * card that arrived meanwhile waits behind the same line.
 *
 * lib/data asks {@link gateAnswer} what to do with each answer of a query tagged `inbox`; the menu's pills (`counts`) are
 * outside the page and update as before.
 */

/** A card in a list answer: an item with a string `id`, in a top-level array or in an array one level down ({cards: […]}). */
export function cardIds(d: unknown): string[] {
  const out: string[] = [];
  const take = (a: unknown[]) => {
    for (const x of a) if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") out.push((x as { id: string }).id);
  };
  if (Array.isArray(d)) take(d);
  else if (d && typeof d === "object") for (const v of Object.values(d)) if (Array.isArray(v)) take(v);
  return out;
}

/** the items of a list answer that are not open (answered, done, superseded): history, never a new card. */
function historyIds(d: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(d))
    for (const x of d) if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" && (x as { state?: unknown }).state !== "open") out.add((x as { id: string }).id);
  return out;
}

/** The answer without the cards in `hide` (same shape), for a first answer on Back. */
export function withoutCards<T>(d: T, hide: Set<string>): T {
  const keep = (a: unknown[]) => a.filter((x) => !(x && typeof x === "object" && hide.has((x as { id?: string }).id as string)));
  if (Array.isArray(d)) return keep(d) as T;
  if (d && typeof d === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) o[k] = Array.isArray(v) ? keep(v) : v;
    return o as T;
  }
  return d;
}

const STORE = "inbox.seen.";
let on = 0;
let visit: string | undefined;
let seen = new Set<string>();
/** Back to a visit: until this time a query's first answer shows only the cards he had seen. */
let restoreUntil = 0;
/** how long after Back a first answer is still matched against the cards he had seen. */
export const RESTORE_MS = 15_000;
/** the cards each query shows now, gate on or off: a list the menu read before the Inbox opened is not new. */
const shown = new Map<object, string[]>();
const known = (id: string) => {
  if (seen.has(id)) return true;
  for (const ids of shown.values()) if (ids.includes(id)) return true;
  return false;
};
/** a parked answer: its query's apply, and the new cards it brings. */
const parked = new Map<object, { apply: () => void; fresh: string[] }>();
const subs = new Set<() => void>();
const ping = () => subs.forEach((f) => f());

function save() {
  if (!visit) return;
  try {
    window.sessionStorage.setItem(STORE + visit, JSON.stringify([...seen]));
  } catch {
    /* storage off: Back shows what came */
  }
}
function load(key: string): Set<string> | undefined {
  try {
    const raw = window.sessionStorage.getItem(STORE + key);
    return raw ? new Set(JSON.parse(raw) as string[]) : undefined;
  } catch {
    return undefined;
  }
}
const see = (ids: string[]) => {
  let grew = false;
  for (const id of ids) if (!seen.has(id)) (seen.add(id), (grew = true));
  if (grew) save();
};

/** True while the Inbox page holds new cards back. */
export const newCardsGated = () => on > 0;

/**
 * Turn the gate on for one Inbox visit (`key`, the history entry). `back`: he came back to this visit, so the cards he
 * had seen are the ones shown and the rest wait behind the line. Returns the off switch; off shows whatever waits.
 */
export function gateNewCards(key: string, back: boolean): () => void {
  on++;
  if (back) {
    const had = load(key);
    seen = had ?? new Set();
    restoreUntil = had?.size ? Date.now() + RESTORE_MS : 0;
  } else if (visit !== key) {
    seen = new Set();
    restoreUntil = 0;
  }
  visit = key;
  return () => {
    on = Math.max(0, on - 1);
    if (!on) showNewCards({ keepPlace: false });
  };
}

/** `rest`: the whole list after the first draw's part: its extra items are history, so only an open card it
 * brings that the screen never showed waits behind the line. */
export type Source = "first" | "own" | "background" | "rest";

/**
 * What lib/data does with an answer `d` of an inbox query (`entry` names the query): `show` it (maybe without the cards
 * that wait), or `park` it (keep showing the last one). `apply` shows it later, on his tap.
 */
export function gateAnswer<T>(entry: object, d: T, source: Source, tag: "inbox" | "counts" | undefined, apply: () => void): { show: T } | "park" {
  // the menu's pills (`counts`) sit outside the page: they may say a card came, they never move one
  if (tag !== "inbox") return { show: d };
  const ids = cardIds(d);
  const showAll = () => {
    shown.set(entry, ids);
    if (on) see(ids);
    if (parked.delete(entry)) ping();
    return { show: d };
  };
  if (!on || source === "own" || (source === "first" && Date.now() >= restoreUntil)) return showAll();
  const isHistory = source === "rest" ? historyIds(d) : undefined;
  const fresh = ids.filter((id) => !known(id) && !isHistory?.has(id));
  if (!fresh.length) return showAll();
  parked.set(entry, {
    apply: () => {
      shown.set(entry, ids);
      apply();
    },
    fresh,
  });
  ping();
  // a first answer (Back to this visit) shows the cards he had seen; a later one keeps the screen as it is
  if (source === "first") {
    const hide = new Set(fresh);
    shown.set(entry, ids.filter((id) => !hide.has(id)));
    return { show: withoutCards(d, hide) };
  }
  return "park";
}

/** A query that goes away drops what it parked. */
export function forgetParked(entry: object) {
  shown.delete(entry);
  if (parked.delete(entry)) ping();
}

/** How many new cards wait behind the line. */
export function newCardCount(): number {
  const all = new Set<string>();
  for (const p of parked.values()) for (const id of p.fresh) all.add(id);
  return all.size;
}

/** The card at the top of his screen (never a sticky heading, which stays put) and where it sits. */
function topOfScreen(): { el: Element; top: number } | undefined {
  if (typeof document === "undefined") return undefined;
  const bar = document.querySelector('[data-testid="topbar"]')?.getBoundingClientRect().bottom ?? 0;
  for (const sel of ["[data-inbox-card], [data-card-shell]", "[data-fold-section]"]) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.height && r.bottom > bar + 48) return { el, top: r.top };
    }
  }
  return undefined;
}

/** how long after his tap the card is held in place while the new cards and their sections draw. */
export const KEEP_PLACE_MS = 1500;

/** His tap: show every card that waits; the card at the top of his screen stays where it was. */
export function showNewCards(o: { keepPlace?: boolean } = {}) {
  if (!parked.size) return;
  const anchor = o.keepPlace === false ? undefined : topOfScreen();
  const all = [...parked.values()];
  parked.clear();
  for (const p of all) see(p.fresh);
  for (const p of all) p.apply();
  ping();
  if (!anchor || typeof window === "undefined") return;
  // keep it there frame by frame while what came in draws above it; his own scroll ends it
  const until = Date.now() + KEEP_PLACE_MS;
  let stop = false;
  const mine = () => void (stop = true);
  window.addEventListener("wheel", mine, { passive: true, once: true });
  window.addEventListener("touchmove", mine, { passive: true, once: true });
  const keep = () => {
    if (stop || !anchor.el.isConnected) return;
    const moved = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(moved) >= 1) window.scrollBy(0, moved);
    if (Date.now() < until) requestAnimationFrame(keep);
    else {
      window.removeEventListener("wheel", mine);
      window.removeEventListener("touchmove", mine);
    }
  };
  requestAnimationFrame(keep);
}

/** What waits, by list (the live check reads it: window.__inboxNew()). */
export const newCardsWaiting = () => [...parked.values()].map((p) => p.fresh);
if (typeof window !== "undefined") (window as unknown as { __inboxNew?: () => string[][] }).__inboxNew = newCardsWaiting;

/** The "N new" count, live. */
export function useNewCardCount(): number {
  const [n, setN] = useState(newCardCount);
  useEffect(() => {
    const f = () => setN(newCardCount());
    subs.add(f);
    f();
    return () => void subs.delete(f);
  }, []);
  return n;
}

/** Tests only. */
export function resetNewCards() {
  on = 0;
  visit = undefined;
  seen = new Set();
  restoreUntil = 0;
  parked.clear();
  shown.clear();
  ping();
}
