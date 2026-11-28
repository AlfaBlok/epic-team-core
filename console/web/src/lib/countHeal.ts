import { useEffect } from "react";
import { inboxCountCheck } from "@/lib/countCheck";
import { invalidate } from "@/lib/data";

/**
 * E948-S231 (the owner 28 Nov, his phone: "counter off again :((", the fourth time after E948-S19, E948-S141 and E948-S197):
 * his open Inbox checks itself. Every minute while it is in view it reads each pill against the open cards its section
 * draws (lib/countCheck, the same check the check host timer runs on production); a difference still there 4 s later (never a
 * card mid-slide) makes the inbox read its lists again at once, so a stale list is put right before he looks. Each
 * repair is kept on `window.inboxCountHealed` for the live check to report (it alerts when one stays wrong).
 */
export const HEAL_EVERY_MS = 60_000;
export const HEAL_CONFIRM_MS = 4_000;
export interface Healed {
  at: string;
  mismatches: string[];
}
const healed: Healed[] = [];
declare global {
  interface Window {
    inboxCountHealed?: Healed[];
  }
}

/** One look: the mismatches now, then again after `confirmMs`; a lasting one reads the inbox again. Returns the repair, if any. */
export async function healOnce(root: ParentNode = document, confirmMs = HEAL_CONFIRM_MS, refresh: () => void = () => invalidate("inbox", "own")): Promise<Healed | undefined> {
  if (!inboxCountCheck(root).mismatches.length) return undefined;
  await new Promise((r) => setTimeout(r, confirmMs));
  const again = inboxCountCheck(root).mismatches;
  if (!again.length) return undefined;
  const h = { at: new Date().toISOString(), mismatches: again };
  healed.push(h);
  if (healed.length > 20) healed.shift();
  if (typeof window !== "undefined") window.inboxCountHealed = [...healed];
  console.warn("[inbox count] a pill and its list differ, reading the inbox again:", again.join("; "));
  refresh();
  return h;
}

export function useCountHeal(on = true) {
  useEffect(() => {
    if (!on || typeof document === "undefined") return;
    let busy = false;
    const look = () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      void healOnce().finally(() => (busy = false));
    };
    const first = setTimeout(look, 8_000);
    const every = setInterval(look, HEAL_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [on]);
}
