import { useEffect, useState } from "react";

/**
 * the owner: "the note where I started recording has moved ... it's not easy for me to find it back because they all
 * look the same". While a card box has a voice note on (recording or on its way) or typed words in it, the inbox holds still. Every inbox list and count
 * (queries tagged `inbox` or `counts`, lib/data) keeps showing what it showed; a fetch that lands meanwhile is parked and
 * applied the moment the owner sends or clears the box, so a new or re-ranked item never moves the card the owner is on. The card itself
 * carries `data-inbox-hold` inside it, which marks its frame (index.css).
 */

/** A typed draft the owner walked away from stops holding the list after this long without a keystroke (a voice note never does). */
export const TYPED_IDLE_MS = 5 * 60_000;

const holds = new Map<string, number>();
const subs = new Set<() => void>();
const releases = new Set<() => void>();

/** True while any card box holds the inbox. */
export const inboxHeld = () => holds.size > 0;

/** Run `fn` each time the last hold lets go (lib/data applies what it parked). Returns the unsubscribe. */
export function onInboxRelease(fn: () => void): () => void {
  releases.add(fn);
  return () => void releases.delete(fn);
}

/** Watch the hold (tests, a quiet marker). Returns the unsubscribe. */
export function onInboxHold(fn: () => void): () => void {
  subs.add(fn);
  return () => void subs.delete(fn);
}

/** Hold the inbox for `origin` (one card box); the returned function lets go, once. */
export function holdInbox(origin: string): () => void {
  holds.set(origin, (holds.get(origin) ?? 0) + 1);
  subs.forEach((f) => f());
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (holds.get(origin) ?? 1) - 1;
    if (n > 0) holds.set(origin, n);
    else holds.delete(origin);
    subs.forEach((f) => f());
    if (!holds.size) releases.forEach((f) => f());
  };
}

/** Tests only. */
export function resetInboxHold() {
  const was = holds.size > 0;
  holds.clear();
  if (was) releases.forEach((f) => f());
}

/**
 * A card box's hold: on while its voice note is on or on its way, or while it has typed words (until {@link TYPED_IDLE_MS}
 * without a change). Returns whether this box holds the list now.
 */
export function useInboxHold(origin: string, o: { recording: boolean; typed: string }): boolean {
  const hasWords = o.typed.trim().length > 0;
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    setFresh(true);
    if (!hasWords) return;
    const t = setTimeout(() => setFresh(false), TYPED_IDLE_MS);
    return () => clearTimeout(t);
  }, [o.typed, hasWords]);
  const on = o.recording || (hasWords && fresh);
  useEffect(() => (on ? holdInbox(origin) : undefined), [on, origin]);
  return on;
}
