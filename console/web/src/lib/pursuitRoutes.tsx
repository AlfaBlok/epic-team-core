// the pursuit and social-kit addresses and the two redirects the app's routes need, apart from the pursuit and
// social-kit screens (components/pursuits, components/socialKit re-export them), so the first download holds neither.
import { Navigate, useParams } from "react-router-dom";
import { scorecardHref } from "@/lib/scorecards";
import { useRoutes } from "@/lib/skin";

export const SOCIAL_KIT_TAB = "social-kit";

/**
 * Pursuits now live in the sidebar as goal sets (/sets/<id>), so the kit is a tab of the
 * set's own page, `/sets/<id>?tab=kit`; the old /pursuits/<id>/social-kit address leads there.
 */
export const SET_KIT_TAB = "kit";
export const setKitHref = (setId: string) => `/sets/${encodeURIComponent(setId)}?tab=${SET_KIT_TAB}`;

export const PURSUITS_PATH = "pursuits";
/** each pursuit has its own page under Pursuits, its tabs Scorecard and (when it has one) Social kit. */
export const PURSUIT_PATH = `${PURSUITS_PATH}/:id`;
export const PURSUIT_TAB_PATH = `${PURSUITS_PATH}/:id/:tab`;
export const pursuitHref = (id: string, tab?: string) => `/${PURSUITS_PATH}/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`;

/** The old kit address, in both skins (the pursuit pages are console-only): it leads to the goal set's Social kit tab. */
export const PURSUIT_KIT_PATH = `${PURSUITS_PATH}/:id/${SOCIAL_KIT_TAB}`;
export function PursuitKitRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={setKitHref(id)} replace />;
}

/**
 * An old /pursuits address. The console skin keeps its pursuit pages; a skin without them (the social one) opens the
 * objective instead: /pursuits -> All objectives, /pursuits/<id> -> /sets/<id>, its social kit -> the Social kit tab.
 */
export function OldPursuitRoute({ page }: { page: JSX.Element }) {
  const routes = useRoutes();
  const { id, tab } = useParams();
  // one pursuit opens as its wheel, with its tabs, the key results first, in both skins.
  if (!id && routes("book")) return page;
  if (!id) return <Navigate to={scorecardHref()} replace />;
  return <Navigate to={tab === SOCIAL_KIT_TAB ? setKitHref(id) : scorecardHref(id)} replace />;
}
