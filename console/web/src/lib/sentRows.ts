import { useRef, useSyncExternalStore } from "react";
import type { ClosedCardRef } from "@/api/review-types";
import type { BackResult } from "@/lib/afterClose";

/**
 * (the owner 2026-11-15 06:09Z, vn_e00f1134: "I pasted a key and then I think
 * eventually it saved and then the card disappeared ... I was left in some random place and I didn't notice ... maybe
 * the card shrinks into a row that says sent ... collapse it and mark it as in green ... it's one row ... add comment
 * or something, it stays there"):
 *
 *   [ the card: buttons, key box, note ]  ──press saved──▶  [ ✓ Sent · Approved · its title   Add comment ]
 *                                                              stays in the same place, the page does not move
 *
 * Every answer kind (a key saved, Yes/No/an option, Done, Park, Snooze, a note sent, a review press) marks its card
 * here by its slot (`ask:<id>`, `review:<id>`, the same id as `data-inbox-card`). The card shows the Sent row instead
 * of itself, and the list keeps that row where the card was after the refetch drops the card (keepSent). Module
 * state, so it outlives the card and every list that shows it agrees. Kept for the page's life (SENT_KEEP_MS at most).
 */
export const SENT_KEEP_MS = 2 * 60 * 60_000;

export interface SentEntry {
  id: number;
  /** what he did, in a few words ("Approved", "Key saved", "Parked for a month") */
  said: string;
  title: string;
  /** one quiet line under it, when the press has more to say (where a saved key went) */
  detail?: string;
  /** the row or ask Add comment files to; absent = nowhere to file (a persona's request) */
  card?: ClosedCardRef;
  back?: () => Promise<BackResult>;
  at: number;
}

/**
 * E948-S130 (the owner 17 Nov 17:28Z, vn_4f13161d: "after a text is sent, it ... collapses and remains there for you to add
 * things ... basically all cards should have the same behavior"): the Sent rows outlive a reload. Every entry (without its
 * Bring it back, a function) and each list's last order are kept in this browser's localStorage for SENT_KEEP_MS, so a
 * reload draws the same green rows where the cards were, never the answered card again.
 */
const STORE = "inbox.sent.v1";
const PLACES = "inbox.sentPlaces.v1";
const storage = (): Storage | undefined => {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
};
function loadSent(): Map<string, SentEntry> {
  try {
    const raw = storage()?.getItem(STORE);
    const list = raw ? (JSON.parse(raw) as [string, SentEntry][]) : [];
    const now = Date.now();
    return new Map(list.filter(([k, e]) => typeof k === "string" && e && typeof e.at === "number" && now - e.at < SENT_KEEP_MS));
  } catch {
    return new Map();
  }
}
function saveSent(m: Map<string, SentEntry>) {
  try {
    const now = Date.now();
    storage()?.setItem(STORE, JSON.stringify([...m].filter(([, e]) => now - e.at < SENT_KEEP_MS).map(([k, { back: _b, ...e }]) => [k, e])));
  } catch {
    /* a full or private store: the rows still show until the page closes */
  }
}
let sent = loadSent();
let seq = Math.max(0, ...[...sent.values()].map((e) => e.id));
/** Sent rows on the page now (a slot drawn by a list or a card), so the floating note stays away when one shows. */
const mounted = new Map<string, number>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

/** Mark one card (or several cards closed by one press: a set) as sent; returns the entry. */
export function markSent(slots: string | string[], e: Omit<SentEntry, "id" | "at">): SentEntry {
  const entry: SentEntry = { ...e, id: ++seq, at: Date.now() };
  const next = new Map(sent);
  for (const s of [slots].flat()) next.set(s, entry);
  sent = next;
  saveSent(sent);
  emit();
  return entry;
}

/** The card is back (Bring it back, or the press failed): it shows as a card again. */
export function unmarkSent(slots: string | string[]) {
  const list = [slots].flat().filter((s) => sent.has(s));
  if (!list.length) return;
  const next = new Map(sent);
  list.forEach((s) => next.delete(s));
  sent = next;
  saveSent(sent);
  emit();
}

const live = (e: SentEntry | undefined, now = Date.now()) => (e && now - e.at < SENT_KEEP_MS ? e : undefined);

export const sentOf = (slot: string) => live(sent.get(slot));
/**
 * (the owner 16 Nov, "why showing one, none left???"): an item he answered here (its card or status row is a green
 * Sent row now) is no longer open for him, so no red count holds it, even while the server's status batch still lists it.
 */
export const answeredHere = (id: string) => !!(live(sent.get(`ask:${id}`)) || live(sent.get(`status:${id}`)));
/** Re-render on every Sent mark (the counts read `answeredHere`). */
export const useSentVersion = () => useSyncExternalStore(subscribe, () => sent);
export function useSent(slot: string | undefined): SentEntry | undefined {
  const e = useSyncExternalStore(subscribe, () => (slot ? sent.get(slot) : undefined));
  return live(e);
}
const useSentMap = () => useSyncExternalStore(subscribe, () => sent);

/** A Sent row for this slot is on the page (the floating note need not show). */
export const sentShown = (slot: string) => (mounted.get(slot) ?? 0) > 0;
export function sentMounted(slot: string): () => void {
  mounted.set(slot, (mounted.get(slot) ?? 0) + 1);
  emit();
  return () => {
    const n = (mounted.get(slot) ?? 1) - 1;
    if (n > 0) mounted.set(slot, n);
    else mounted.delete(slot);
    emit();
  };
}
export const useSentShown = (slot: string | undefined) => useSyncExternalStore(subscribe, () => !!slot && sentShown(slot));

/** Pure: the new list, with each sent card that left it kept at its old place (after the card that was before it). */
export function keepPlaces<T>(prev: { slot: string; item?: T }[], items: T[], slotOf: (t: T) => string, isSent: (slot: string) => boolean): { slot: string; item?: T }[] {
  const out: { slot: string; item?: T }[] = items.map((item) => ({ slot: slotOf(item), item }));
  const here = new Set(out.map((r) => r.slot));
  prev.forEach((p, n) => {
    if (here.has(p.slot) || !isSent(p.slot)) return;
    // after the nearest earlier place still in the list, else first
    let at = 0;
    for (let k = n - 1; k >= 0; k--) {
      const i = out.findIndex((r) => r.slot === prev[k].slot);
      if (i >= 0) {
        at = i + 1;
        break;
      }
    }
    out.splice(at, 0, { slot: p.slot });
    here.add(p.slot);
  });
  return out;
}

/**
 * A list keeps its sent cards in place: each row is `{slot, item}` (a card still listed) or `{slot}` (it left the
 * list after he answered it: draw its Sent row there). One press that closed several cards (a set) keeps one row.
 */
export function useKeepSent<T>(items: T[], slotOf: (t: T) => string, list?: string): { slot: string; item?: T; sent?: SentEntry }[] {
  const map = useSentMap();
  // E948-S130: a named list starts from its order before the reload, so a sent card that left keeps its place
  const prev = useRef<{ slot: string; item?: T }[] | undefined>(undefined);
  if (prev.current === undefined) prev.current = list ? loadPlaces(list) : [];
  const kept = keepPlaces(prev.current, items, slotOf, (s) => !!live(map.get(s)));
  // an empty list (still loading after a reload) keeps the order it had, so the cards around a Sent row are not lost
  const saved = useRef("");
  if (items.length || !list) {
    // written when the order or which of them are sent changed (a press marks one without changing the order)
    const now = kept.map((r) => `${r.slot}${live(map.get(r.slot)) ? "*" : ""}`).join(" ");
    if (list && now !== saved.current) {
      savePlaces(list, kept);
      saved.current = now;
    }
    prev.current = kept;
  }
  const seen = new Set<number>();
  const out: { slot: string; item?: T; sent?: SentEntry }[] = [];
  for (const r of kept) {
    const e = live(map.get(r.slot));
    if (e && seen.has(e.id)) continue;
    if (e) seen.add(e.id);
    if (!r.item && !e) continue;
    out.push(e ? { ...r, sent: e } : r);
  }
  return out;
}

/** a list's last order (its slots), kept while it holds a Sent row; read once when the list first draws after a reload. */
function loadPlaces(list: string): { slot: string }[] {
  try {
    const all = JSON.parse(storage()?.getItem(PLACES) ?? "{}") as Record<string, string[]>;
    return (all[list] ?? []).filter((s) => typeof s === "string").map((slot) => ({ slot }));
  } catch {
    return [];
  }
}
function savePlaces(list: string, rows: { slot: string }[]) {
  try {
    const st = storage();
    if (!st) return;
    const all = JSON.parse(st.getItem(PLACES) ?? "{}") as Record<string, string[]>;
    if (rows.some((r) => live(sent.get(r.slot)))) all[list] = rows.map((r) => r.slot);
    else delete all[list];
    st.setItem(PLACES, JSON.stringify(all));
  } catch {
    /* as above */
  }
}

/** Tests only. */
export const resetSent = () => {
  sent = new Map();
  try {
    storage()?.removeItem(STORE);
    storage()?.removeItem(PLACES);
  } catch {
    /* none */
  }
  mounted.clear();
  emit();
};
