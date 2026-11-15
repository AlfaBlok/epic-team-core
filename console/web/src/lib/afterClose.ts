import { useSyncExternalStore } from "react";
import type { ClosedCardRef } from "@/api/review-types";
import { markSent } from "@/lib/sentRows";

/**
 * "even after the card has disappeared, you should have like a
 * floating thing" to add something or take the press back. After a card press that closes it (answer, approve, Changes
 * wanted, decline, snooze, close) one floating note shows for NOTE_MS: "Saved", Add a last thought (his words or a voice
 * note, filed to the same row or ask and sent to its owner) and Bring it back (the card's own way back: the press taken
 * back while it waits out its window, else the route that reopens it). Opening the box keeps the note up until he sends
 * or closes it. One note at a time: a newer close replaces it.
 */
export const NOTE_MS = 6_000;

/** What Bring it back did: `back` = the card is in the inbox again; otherwise the note says why and opens the box. */
export type BackResult = { back: true; line: string } | { back: false; line: string };

export interface ClosedNote {
  id: number;
  /** What was pressed, in a few words ("Approved", "Changes sent", "Snoozed for 3 days"). */
  said: string;
  /** The card's title. */
  title: string;
  /** The row or ask the card was on (Add a last thought files there); absent = no spine to file to (a persona's request). */
  card?: ClosedCardRef;
  back?: () => Promise<BackResult>;
  /**
   * vn_e00f1134: the card(s) this press answered (`ask:<id>`, `review:<id>`, as `data-inbox-card`): each collapses in place
   * to one green Sent row with Add comment; the floating note shows only when no Sent row is on the page.
   */
  slot?: string | string[];
}

let note: ClosedNote | undefined;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));

/** Show the note for a card that just closed (replaces the one showing). */
export function showClosed(n: Omit<ClosedNote, "id">): number {
  if (n.slot) markSent(n.slot, { said: n.said, title: n.title, ...(n.card ? { card: n.card } : {}), ...(n.back ? { back: n.back } : {}) });
  note = { ...n, id: ++seq };
  emit();
  return note.id;
}

/** Close the note (only that one, when an id is given). */
export function closeNote(id?: number) {
  if (!note || (id !== undefined && note.id !== id)) return;
  note = undefined;
  emit();
}

export function useClosedNote(): ClosedNote | undefined {
  return useSyncExternalStore(subscribe, () => note);
}

/** Tests only. */
export const resetClosedNote = () => {
  note = undefined;
  emit();
};

/** Tests only: the note showing now. */
export const closedNote = () => note;
