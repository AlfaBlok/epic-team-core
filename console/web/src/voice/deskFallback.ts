import { api } from "@/api";
import type { ClosedCardRef } from "@/api/review-types";
import { homeWorld } from "@/lib/identity";
import { knownWorld } from "@/lib/useSocial";

/**
 * a card that refuses his voice note (a gate, a closed row, a console error) never ends his words there: they go
 * to this world's Team desk whole, once per note (the client request id is the note's), and the desk places them.
 */
export async function deskFallback(text: string, page: string | undefined, id: string): Promise<void> {
  const world = knownWorld();
  if (world && world !== homeWorld()) await api.sendWorldDeskMessage(world, text, page?.slice(0, 200), id);
  else await api.sendDeskMessage(text, page?.slice(0, 200), id);
}

/**
 * a card's press that refuses his note (the row moved on, a gate, a field it would not take) never ends his
 * words there or sends them to the desk as a side copy: they land on the card's own row as his note on that card (a Decisions
 * row, the row's owner woken), the same Add comment route every closed card uses.
 */
export async function keepOnCard(card: ClosedCardRef, words: string, files: string[] = [], via: "text" | "voice" = "voice"): Promise<void> {
  await api.commentClosedCard({ ...card, text: words, ...(files.length ? { attachments: files } : {}), via, stage: "on_card" });
}

/** a refused card voice note (NoteTab's toCard). */
export const cardFallback = (card: ClosedCardRef, words: string): Promise<void> => keepOnCard(card, words);
