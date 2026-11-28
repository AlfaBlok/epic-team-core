import { useState } from "react";
import { X } from "lucide-react";

/**
 * The owner 28 Nov (vn_6f1d9926): his phone app showed a bar with a cross until he removed it and installed it again from
 * the new address: "now it shows in the right way". An app installed from an old address belongs to that address; the
 * old site now sends every page to the new one (server auth/gate movedUrl adds `moved_from`), where the app shows as a
 * browser view. Nothing on our side can move an installed app, so whoever arrives that way reads one plain line saying
 * how to get the app view back. The marker leaves the address at once; the line stays until closed (this visit only).
 */
export const MOVED_FROM = "moved_from";
const KEY = "moved-app-line";

/** Read and drop the marker from the address; true when this load came from an old address. */
export function takeMovedMarker(loc: Location = window.location, history: History = window.history): boolean {
  const u = new URL(loc.href);
  if (!u.searchParams.has(MOVED_FROM)) return false;
  u.searchParams.delete(MOVED_FROM);
  try {
    history.replaceState(history.state, "", u.pathname + (u.search === "?" ? "" : u.search) + u.hash);
  } catch {
    /* the address keeps the marker: harmless */
  }
  return true;
}

let arrived: boolean | undefined;
/** tests: read the address again */
export const forgetMovedArrival = () => (arrived = undefined);
const arrivedFromOld = () => {
  if (arrived === undefined) {
    arrived = typeof window !== "undefined" && takeMovedMarker();
    try {
      if (arrived) sessionStorage.setItem(KEY, "1");
      else arrived = sessionStorage.getItem(KEY) === "1";
    } catch {
      /* no storage: this load only */
    }
  }
  return arrived;
};

/** Shown on any window the old address sent here (an old install, seen from outside its address, may not say it is
 * installed); an app installed from the new address starts there and never carries the marker. */
export function MovedAppLine() {
  const [shown, setShown] = useState(arrivedFromOld);
  if (!shown) return null;
  const host = window.location.host;
  const close = () => {
    setShown(false);
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing kept */
    }
  };
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm" data-testid="moved-app-line">
      <p className="min-w-0 flex-1">
        This address moved to {host}. If you see a bar with a cross on your phone app, remove the app and install it again from {host}.
      </p>
      <button type="button" aria-label="Close" onClick={close} className="shrink-0 text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
