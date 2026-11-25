import type { ScreenId } from "@/lib/skin";

/** One screen's route: the skin decides whether it shows (lib/skin.ts useRoutes). */
export type ScreenRoute = { screen: ScreenId; path: string; element: JSX.Element };

/**
 * The hosted layer's web plug: pages a one-team console does not need (connections, hosts, secrets, companies,
 * testers, credits, the social pages) live in src/hosted and register their routes in src/hosted/routes.tsx.
 * The glob is optional: a build without src/hosted finds nothing and serves the core screens only.
 */
const plugs = import.meta.glob<{ HOSTED_ROUTES?: ScreenRoute[] }>("../../../../../hosted/console/web/src/hosted/routes.tsx", { eager: true });

export const HOSTED_ROUTES: ScreenRoute[] = Object.values(plugs).flatMap((m) => m.HOSTED_ROUTES ?? []);
