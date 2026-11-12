import type { ScreenId } from "@/lib/skin";

/** the social screens' paths and nav labels (social nav order). `?repo=<name>` picks one of the world's repos. */
export const SOCIAL_NAV: { screen: ScreenId; path: string; label: string }[] = [
  { screen: "socialHome", path: "/social", label: "Home" },
  { screen: "pipeline", path: "/social/pipeline", label: "Pipeline" },
  { screen: "history", path: "/social/history", label: "History" },
  { screen: "directions", path: "/social/directions", label: "Directions" },
  { screen: "topics", path: "/social/topics", label: "Topics" },
];

/** the Performance page (the social product's first menu entry). */
export const PERFORMANCE_PATH = "performance";

/** the product deck page (next to Performance). */
export const PRODUCT_PATH = "product";

/** the all-campaigns Pipeline (skins with campaigns: the left menu's Team, Chat, Pipeline). */
export const ALL_PIPELINE_PATH = "pipeline";

export const socialPath = (screen: ScreenId) => SOCIAL_NAV.find((n) => n.screen === screen)!.path;

/** A social screen's link, keeping the repo the caller is looking at. */
export const socialHref = (screen: ScreenId, repo?: string | null) => `${socialPath(screen)}${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;

/** a post's own page (the approval flow: full text, diagram, history, the card's buttons). Ids repeat across repos. */
export const POST_PATH = "posts/:repo/:id";
export const postHref = (repo: string, id: string) => `/posts/${encodeURIComponent(repo)}/${encodeURIComponent(id)}`;
/** Where the post page's Back goes: the screen the link was on (router state), named as it shows there. */
export type PostFrom = { from: string; label: string };
