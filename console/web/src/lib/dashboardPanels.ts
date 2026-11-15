import { useCallback, useEffect, useState } from "react";

/**
 * The dashboard panels the owner does not use left Settings (the owner: "the things I'm using are the inbox and
 * looking at the runs... All the dashboard stuff is not providing value to me"). Their code stays, behind this one
 * switch at the foot of Settings, off by default and kept per browser.
 */
export const DASHBOARD_PANELS_KEY = "console.settings.dashboardPanels";
const EVENT = "console-dashboard-panels";

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(DASHBOARD_PANELS_KEY) === "on";
  } catch {
    return false;
  }
}

export function useDashboardPanels(): [boolean, (on: boolean) => void] {
  const [on, setOnState] = useState(read);
  useEffect(() => {
    const sync = () => setOnState(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const setOn = useCallback((next: boolean) => {
    try {
      if (next) globalThis.localStorage?.setItem(DASHBOARD_PANELS_KEY, "on");
      else globalThis.localStorage?.removeItem(DASHBOARD_PANELS_KEY);
    } catch {
      /* private mode: the switch still works for this page */
    }
    setOnState(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [on, setOn];
}
