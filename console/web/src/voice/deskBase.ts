import { useEffect, useState } from "react";
import { knownWorld, worldId } from "@/lib/useSocial";
import { homeWorld } from "@/lib/identity";

/**
 * (the owner 2026-11-10: "Is Epic Social like on an old version of Epic Team? I'm not seeing voice notes, buttons"):
 * the voice routes of the caller's world desk. the home world's are `/api/voice` (its Team desk); every other world records on its
 * own desk's (`/api/tenants/<world>/desk/voice`, tenant-safe since), as its Chat already did. Before this, every
 * card box defaulted to `/api/voice`, which answers 403 world_scope in another world, so the social product's cards had no microphone.
 */
export const deskVoiceBase = (world: string | undefined): string =>
  !world || world === homeWorld() ? "/api/voice" : `/api/tenants/${encodeURIComponent(world)}/desk/voice`;

/** One /api/me per page load for every voice control on it (a page has dozens of cards). */
let asked: Promise<string | undefined> | undefined;
const askWorld = () => (asked ??= worldId().catch(() => undefined));
/** Tests: forget the answer (each test is its own browser). */
export const forgetDeskVoiceWorld = () => {
  asked = undefined;
};

/** The voice base a box uses when its caller names none: this world's desk (the last known world first, /api/me's answer next). */
export function useDeskVoiceBase(): string {
  const [world, setWorld] = useState<string | undefined>(knownWorld);
  useEffect(() => {
    let live = true;
    void askWorld().then((w) => live && w && setWorld(w));
    return () => {
      live = false;
    };
  }, []);
  return deskVoiceBase(world);
}
