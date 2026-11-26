import { useEffect, useState, type ComponentType } from "react";
import { lazyPage } from "@/lib/lazyPage";
import { loadDialogParts } from "@/components/ui/dialog";

/**
 * So the phone downloads less app code before its inbox shows: the
 * sidebar's objectives list (components/goalSets, with the goal-sets screens it shares code with) and the social skin's
 * campaigns list (components/campaignHome) are their own scripts, not in the first download. A laptop draws its sidebar
 * at once: the built index.html preloads these beside the entry on a wide screen (vite.config.ts WIDE_PRELOADS), so they
 * arrive with it. A phone's menu is closed: it reads them once its inbox list is in (Layout's SidebarWarm), before he
 * opens the menu. The menu waits for them like for its lists (Layout's AtOnce), so it still draws in one frame.
 */
type Kept<M> = (() => Promise<M>) & { now: () => M | undefined };
function keep<M>(load: () => Promise<M>): Kept<M> {
  let mod: M | undefined;
  let asked: Promise<M> | undefined;
  const f = (() => (asked ??= load().then((m) => (mod = m)))) as Kept<M>;
  f.now = () => mod;
  return f;
}

export const loadGoalSets = keep(() => import("@/components/goalSets"));
export const loadCampaignHome = keep(() => import("@/components/campaignHome"));
/** the phone's menu dialog (components/mobileMenu) is its own script too, read with these. */
export const loadMobileMenu = keep(() => import("@/components/mobileMenu"));

/** read the sidebar's scripts ahead (each import is asked once). */
export function prefetchSidebarScripts(campaigns: boolean) {
  void loadGoalSets().catch(() => undefined);
  void loadMobileMenu().catch(() => undefined);
  // the dialog code too, once the inbox is in: a card's first dialog opens at once, and offline (the
  // service worker keeps every script it served) it still opens
  void loadDialogParts().catch(() => undefined);
  if (campaigns) void loadCampaignHome().catch(() => undefined);
}

/**
 * a component from a kept script: drawn at once when the script is in (React's lazy would still skip one frame, and
 * the menu would show its lists without the objectives for that frame), else loaded like any lazy screen part.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function keptPart<M extends { [k in K]: ComponentType<any> }, K extends string>(load: Kept<M>, name: K): M[K] {
  const Lazy = lazyPage(load, name, null) as unknown as ComponentType<object>;
  function KeptPart(props: object) {
    const m = load.now();
    const Part = (m ? m[name] : Lazy) as ComponentType<object>;
    return <Part {...props} />;
  }
  KeptPart.displayName = `Kept(${name})`;
  return KeptPart as unknown as M[K];
}

/** whether a kept script is in (true when not wanted); asks for it when wanted, re-renders when it lands. */
export function useScriptIn<M>(load: Kept<M>, want: boolean): boolean {
  const [inNow, setIn] = useState(() => !!load.now());
  useEffect(() => {
    if (!want || inNow) return;
    let live = true;
    load().then(
      () => live && setIn(true),
      () => live && setIn(true), // a failed script never holds the menu (lazyPage reloads onto a new build)
    );
    return () => {
      live = false;
    };
  }, [want, inNow, load]);
  return !want || inNow;
}
