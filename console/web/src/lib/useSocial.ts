import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { useCampaignScope } from "@/lib/campaign";
import { homeWorld } from "@/lib/identity";
import { useProject } from "@/lib/project";

/**
 * The caller's world: /api/me's tenant, else the home world (no identity: the dev copy, auth shadow on the production site).:
 * before login the server already names the world whose skin is social on the social site (auth/gate.ts), so the
 * social screens, Digest, Campaigns and Credits all follow it; under auth `on` the login decides.
 * only an answer without a world means the home world. A failing /api/me (30 s timeout under load, a 502 while the
 * console restarts) throws, so the caller shows its error and retries instead of asking the home world's data from another
 * world (404 cross_tenant in the owner's a social world repo session).
 */
export async function worldId(getMe = api.getMe): Promise<string> {
  if (!getMe) return homeWorld();
  const me = await getMe();
  lastWorld = me?.tenant?.id ?? homeWorld();
  lastDoor = me?.identity?.kind === "session" && !!me.identity.door;
  try {
    localStorage.setItem(WORLD_KEY, lastWorld);
    if (lastDoor) localStorage.setItem(DOOR_KEY, "1");
    else localStorage.removeItem(DOOR_KEY);
  } catch {
    /* no storage (private mode): this tab still remembers */
  }
  return lastWorld;
}
const WORLD_KEY = "console.world";
const DOOR_KEY = "console.door";
/**
 * the last /api/me said this is the door (the owner let into the home world on a customer site): the home world
 * then shows the customer screens (its own world desk as Chat, never the private console's Team desk).
 */
let lastDoor: boolean = (() => {
  try {
    return localStorage.getItem(DOOR_KEY) === "1";
  } catch {
    return false;
  }
})();
export const knownDoor = (): boolean => lastDoor;
let lastWorld: string | undefined = (() => {
  try {
    return localStorage.getItem(WORLD_KEY) ?? undefined;
  } catch {
    return undefined;
  }
})();
/**
 * the world the last /api/me in this browser named (localStorage; undefined before one answered), so Chat opens
 * without waiting for /api/me (it took up to 10.5 s while the console stalled). Switching worlds or signing in reloads the
 * page and the next /api/me answer replaces it; until then the page shows that world's desk.
 */
export const knownWorld = (): string | undefined => lastWorld;
/** Tests: forget it (each test is its own browser). */
export const forgetWorld = () => {
  lastWorld = undefined;
  lastDoor = false;
  try {
    localStorage.removeItem(WORLD_KEY);
    localStorage.removeItem(DOOR_KEY);
  } catch {
    /* none */
  }
};

/**
 * the caller's world's social data (GET /api/tenants/:id/social, the pack export), in the world `worldId` names.
 * `repo` picks one of the world's repos; unset = the world's social repo.
 */
export function useSocial(repo?: string) {
  // inside a campaign tab the screen reads that campaign's repo. A named campaign reads only its rows.
  const scope = useCampaignScope();
  // with no repo named, a world with several projects reads the selected one (never "the first social repo").
  const project = useProject();
  const r = scope?.repo ?? repo ?? project.current?.repo;
  const c = scope?.campaign;
  return useQuery(async () => (c ? api.getSocial(await worldId(), r, c) : api.getSocial(await worldId(), r)), [r, c]);
}
