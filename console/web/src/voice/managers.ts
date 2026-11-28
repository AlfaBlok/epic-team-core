import { useEffect, useState } from "react";

/**
 * The people he calls, by name and face (the owner: "you see that face, and you see that name"). One read of GET /api/managers per page load; each call finds its own person
 * by the call it starts (`call`: /api/voice/coach for the board manager, /api/objectives/<id>/voice for a campaign
 * manager). The call directory reads the same list.
 */
export type ManagerCard = { id: string; name: string; role: "board" | "campaign"; objective?: string; objectiveName?: string; face?: string; call: string };

let loaded: Promise<ManagerCard[]> | undefined;
export const loadManagers = (): Promise<ManagerCard[]> =>
  (loaded ??= fetch("/api/managers")
    .then((r) => (r.ok ? (r.json() as Promise<{ managers?: ManagerCard[] }>) : { managers: [] }))
    .then((d) => (Array.isArray(d.managers) ? d.managers : []))
    .catch(() => []));

/** the person who answers the call at `base`, once the list is read (undefined while reading or for a call with none). */
export function useManagerFor(base: string | undefined): ManagerCard | undefined {
  const [m, setM] = useState<ManagerCard | undefined>();
  useEffect(() => {
    let live = true;
    if (base) void loadManagers().then((all) => live && setM(all.find((x) => x.call === base)));
    return () => {
      live = false;
    };
  }, [base]);
  return m;
}
