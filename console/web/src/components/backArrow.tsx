import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The installed app (home-screen PWA, iOS or desktop) has no browser back button of its own. */
export const installedApp = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

/** How many steps into the app's own history this screen is (react-router keeps it as `idx`; 0 = the first screen). */
export const historyStep = () => {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : 0;
};

/**
 * The owner (18 Nov): the installed app hides the browser's back button, so the top bar
 * carries a back arrow, left of the bar on the desktop and the phone. It goes back one step in the app's
 * history and is not there on the first screen (nothing to go back to). In a browser tab it never shows: the
 * browser's own back is already there.
 */
export function BackArrow({ className, installed = installedApp }: { className?: string; installed?: () => boolean }) {
  useLocation(); // read again on every move, so the arrow comes and goes with the history step
  const navigate = useNavigate();
  if (!installed() || historyStep() < 1) return null;
  return (
    <Button variant="ghost" size="icon" className={cn("shrink-0 max-[379px]:h-9 max-[379px]:w-8 md:h-8 md:w-8", className)} aria-label="Back" title="Back" onClick={() => navigate(-1)} data-testid="topbar-back">
      <ArrowLeft className="h-5 w-5 md:h-4 md:w-4" />
    </Button>
  );
}
