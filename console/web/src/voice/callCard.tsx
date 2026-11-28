import { Phone } from "lucide-react";
import { Link } from "react-router-dom";
import { hostOf, siteDomain, sites, socialProduct } from "@/lib/identity";
import { BRIEFING_PATH, COACH_PATH, MARKETING_PATH, STRATEGY_PATH } from "@/lib/routePaths";
import { cn } from "@/lib/utils";

/**
 * The owner could not find a call's button while its card linked to another site ("I don't see the button ... You keep
 * moving it around"): a card whose link opens one of our call pages carries the Call itself, on its face, at the top.
 * It opens that call page in this console (the app he is signed in to, never a new tab on another site) with ?call=1, and
 * the call starts there at once: the press is his, so the microphone and the voice may start.
 */
const CALL_PATHS = [MARKETING_PATH, BRIEFING_PATH, STRATEGY_PATH, COACH_PATH];
/** an objective's page, only when the card's link asks for its call (`?call=1`): a "ready to present" card (the owner's
 * note: "in the inbox, I get a card that says We're ready for the call to present the strategy"). */
const OBJECTIVE_CALL = /^sets\/[a-z0-9][a-z0-9-]{0,63}$/;

/** the call page a link opens (ours: same site, or a team/social console host), else undefined. */
export function callPathOf(href: string | undefined): string | undefined {
  if (!href) return undefined;
  let u: URL;
  try {
    u = new URL(href, "https://here.invalid");
  } catch {
    return undefined;
  }
  const host = u.host.toLowerCase();
  const consoles = [hostOf(sites().teamUrl), hostOf(sites().socialUrl)].map((h) => h.toLowerCase());
  const ours = host === "here.invalid" || consoles.includes(host) || host.endsWith(`.${siteDomain()}`) || (typeof window !== "undefined" && host === window.location.host);
  const p = u.pathname.replace(/^\/+|\/+$/g, "");
  if (!ours) return undefined;
  if (CALL_PATHS.includes(p)) return p;
  return OBJECTIVE_CALL.test(p) && u.searchParams.get("call") === "1" ? p : undefined;
}

/** the button's words for a call page ("Call the <social product> briefer" for /marketing). */
export function callLabel(path: string): string {
  if (path === MARKETING_PATH) return `Call the ${socialProduct()} partner`;
  if (path === BRIEFING_PATH) return "Call your objectives review";
  if (path === STRATEGY_PATH) return "Call the strategy call";
  if (OBJECTIVE_CALL.test(path)) return "Call to hear the strategy";
  return "Call the coach";
}

/** the big green Call on a card's face; nothing when its link is not a call page. */
export function CardCallButton({ hrefs, className }: { hrefs: (string | undefined)[]; className?: string }) {
  const path = hrefs.map(callPathOf).find(Boolean);
  if (!path) return null;
  const label = callLabel(path);
  return (
    <Link
      to={`/${path}?call=1`}
      data-testid="card-call-now"
      aria-label={label}
      className={cn(
        "mt-2.5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-emerald-600 px-5 text-[15px] font-semibold text-white shadow-sm hover:bg-emerald-700 sm:w-fit",
        className,
      )}
    >
      <Phone className="size-5" aria-hidden /> {label}
    </Link>
  );
}
