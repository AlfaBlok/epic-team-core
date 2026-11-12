import { sites, socialProduct } from "./identity.js";

/**
 * one page head, two products. web/index.html and the login page are written for EpicTeam (the production site); on a
 * social host (auth/gate.ts socialHosts) the server swaps the product's name, line, address and share image in, so a link
 * to the social site previews as the social product before any script runs (link crawlers run none). Icons swap by path
 * (app.ts SOCIAL_ICONS). Rollback: socialHead returns the page unchanged.
 */
export const TEAM_HEAD = {
  name: "EpicTeam",
  line: "The agent team's console. Goals, reviews and asks in one place.",
  get origin(): string {
    return sites().teamUrl;
  },
} as const;
export const SOCIAL_HEAD = {
  get name(): string {
    return socialProduct();
  },
  line: "Your social media team. It plans, drafts and posts with you.",
  get origin(): string {
    return sites().socialUrl;
  },
} as const;

/** The EpicTeam page head with the social product's name, line and address (the share image path stays /og-image.png). */
export function socialHead(html: string): string {
  return html
    .split(TEAM_HEAD.origin)
    .join(SOCIAL_HEAD.origin)
    .split(TEAM_HEAD.line)
    .join(SOCIAL_HEAD.line)
    .replace(/(<title>(?:[^<]*· )?)EpicTeam(<\/title>)/, `$1${SOCIAL_HEAD.name}$2`)
    .replace(/(<meta (?:property|name)="(?:og:site_name|og:title|twitter:title|og:image:alt|apple-mobile-web-app-title)" content=")EpicTeam/g, `$1${SOCIAL_HEAD.name}`)
    .replace(/(<span data-brand-name>)EpicTeam(<\/span>)/, `$1${SOCIAL_HEAD.name}$2`); // the login page's name
}
