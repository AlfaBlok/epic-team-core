import { api } from "@/api";
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
