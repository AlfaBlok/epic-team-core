import { createContext, useContext, useEffect, type ReactNode } from "react";
import { customerSitesOf, hostOf, sites, socialProduct } from "@/lib/identity";

/**
 * a world's skin is presentation only (theme, words, which screens show), never permissions:
 * a hidden screen's API still works. `console` is the home world's console exactly as before; `social` is the social-manager
 * product. Today the skin comes from a dev-copy flag (skinFlag: a meta tag the dev copy, injects, or VITE_SKIN); when land,
 * `/api/me` returns `tenant.skin` and `skinFromWorld` reads it. Rollback: skin -> console.
 */
export type SkinId = "console" | "social";

/** Every screen the web app can show. Social-only screens (setup, calendar, report, credits) arrive with..S6. */
export type ScreenId =
  | "team"
  | "chat"
  | "milestones"
  | "spines"
  | "personas"
  | "runs"
  | "threads"
  | "tickets"
  | "hosts"
  | "secrets"
  /** team services (the memory service, Gmail) and which personas may use each (console only). */
  | "services"
  /** the social product tester signups (console only). */
  | "testers"
  /** the team skills library (console only; the social skin's persona editor still picks from it). */
  | "teamSkills"
  | "seats"
  | "browserAuth"
  | "report"
  /** the four social team members' cards (social only). */
  | "yourTeam"
  /** week calendar (social only; removed the approval inbox). */
  | "calendar"
  /** first-run setup (GitHub repo, X, Reddit, LinkedIn); social only. */
  | "setup"
  /** balance, 30-day burn, ledger (both skins; the platform also tops up and sets the gate here). */
  | "credits"
  /** My ideas & priorities (social only). */
  | "ideas"
  /** social screens (social nav; in the console skin reachable from the repo's Spines card, no nav link). */
  | "socialHome"
  | "pipeline"
  | "history"
  | "directions"
  | "topics"
  /** Campaigns list + New campaign wizard (social only). */
  | "campaigns"
  /** Campaign brief + Assets library (social only). */
  | "brief"
  /** the 20:00 digest (social only). */
  | "digest"
  /** the Epic Book, "where are we" across every repo (console only). */
  | "book"
  /** one post's page (approve it: full text, diagram, history, the card's buttons); both skins, no nav link. */
  | "post"
  /** DMs on their own page (both skins; the menu entry shows only in a world with a social repo). */
  | "messages"
  /** one conversation's page (/messages/<repo>/<chat id>); both skins, no nav link. */
  | "conversation"
  /** the Performance page (social: first entry of the left menu; console: reached, no nav link). */
  | "performance"
  /** the Company view, every project as a company with three wheels and one inbox (console only). */
  | "company"
  /** the goal sets: a table of rows, kanban, inbox, chat desk, context and personas each; both skins. */
  | "goalSets"
  /** Settings (docs/design/console.md): readiness, red lines and What you build on top, then every operator page (console only). */
  | "settings";

/** the social screens, in nav order. */
export const SOCIAL_SCREENS: ScreenId[] = ["socialHome", "pipeline", "history", "directions", "topics"];

/** The words a skin may rename. The console values are today's literal UI strings. */
export type WordKey =
  | "appName"
  | "team"
  | "milestones"
  /** the one tracked unit in running text, lower case ("this project"); `milestonesWord` its plural. */
  | "milestone"
  | "milestonesWord"
  | "addMilestone"
  | "spines"
  | "personas"
  | "runs"
  | "threads"
  | "tickets"
  | "seats"
  | "hosts"
  | "secrets"
  | "browserAuth"
  | "teamSkills"
  | "needsYou";

export type Words = Record<WordKey, string>;

export interface Skin {
  id: SkinId;
  words: Words;
  screens: ReadonlySet<ScreenId>;
  /** screens that route but get no nav link of their own (the console skin reaches the social screens this way). */
  reach?: ReadonlySet<ScreenId>;
  /**
   * the skin's pinned (focus) milestones are campaigns: New focus milestone is the New campaign
   * wizard, Add milestone offers a campaign or a one-off job, and a social-pack milestone opens on its Pipeline tab.
   */
  campaigns?: boolean;
  /** the skin's favicon (EpicTeam's logo C is in index.html); SkinProvider swaps the icon links to it. */
  favicon?: { svg: string; touch: string };
  /** Value of `data-skin` on <html>; index.css scopes the theme's CSS variables to it. Undefined = no attribute. */
  themeAttr?: string;
}

const CONSOLE_WORDS: Words = {
  // the EpicSpine brand family (EpicSpine, EpicTeam, the social product); was "Agent Team".
  appName: "EpicTeam",
  // the home is his Inbox (the owner 2026-11-11: "That section should be Inbox").
  team: "Inbox",
  // EpicTeam's screens say project;
  // routes, API and table names keep milestone (words only, one revert rolls back).
  milestones: "Projects",
  milestone: "project",
  milestonesWord: "projects",
  addMilestone: "Add project",
  spines: "Spines",
  personas: "Personas",
  runs: "Runs",
  threads: "Threads",
  tickets: "Tickets",
  seats: "Seats",
  hosts: "Hosts",
  secrets: "Secrets",
  browserAuth: "Browser auth",
  teamSkills: "Team skills",
  needsYou: "Needs you",
};

// Social-only screens are left out of the console skin.
const ALL_SCREENS: ScreenId[] = ["goalSets", "team", "company", "settings", "book", "chat", "messages", "milestones", "spines", "personas", "runs", "threads", "tickets", "hosts", "secrets", "services", "teamSkills", "testers", "seats", "browserAuth", "credits"];

/**
 * the social skin is the console with a violet theme and favicon, one
 * renamed word (a pinned milestone is a Campaign), the campaign tabs and Setup until connected (docs/status/e58-s1-mockup.md,
 * the short list). Its old screens (Home, Pipeline, History, Directions, Topics, Brief, Ideas, Calendar, Digest, Report,
 * Your team, Campaigns) have no menu entry: they route (reach) and lead to the campaign's tabs.
 */
export const SOCIAL_REACH: ScreenId[] = ["campaigns", "brief", "yourTeam", "calendar", "ideas", ...SOCIAL_SCREENS, "digest", "report", "post", "conversation"];

export const SKINS: Record<SkinId, Skin> = {
  console: { id: "console", words: CONSOLE_WORDS, screens: new Set(ALL_SCREENS), reach: new Set<ScreenId>([...SOCIAL_SCREENS, "post", "conversation", "performance"]) },
  social: {
    id: "social",
    themeAttr: "social",
    // the Team skills page is "Skills" here: the team's base skills read-only, the world's own add/remove.
    // the social skin says campaign for the unit: in the social product project already names a repo, so a
    // milestone on its screens is a campaign; routes, API and table names keep milestone (words only, one revert rolls back).
    words: { ...CONSOLE_WORDS, get appName() {
        return socialProduct();
      },
      milestones: "Campaigns", milestone: "campaign", milestonesWord: "campaigns", addMilestone: "Add campaign", teamSkills: "Skills" },
    // Plan §3: hidden are Hosts, Seats, Threads, Secrets (keys come as approval cards), Testers and the Book.
    screens: new Set<ScreenId>(["goalSets", "performance", "team", "chat", "messages", "milestones", "spines", "personas", "runs", "tickets", "services", "teamSkills", "credits", "browserAuth", "setup"]),
    reach: new Set(SOCIAL_REACH),
    campaigns: true,
    favicon: { svg: "/favicon-social.svg", touch: "/apple-touch-icon-social.png" },
  },
};

/** the pinned milestones' heading: "Focus projects" on the console, the skin's word where it renames milestones (Campaigns). */
export const focusHeading = (w: Words) => (w.milestones === CONSOLE_WORDS.milestones ? `Focus ${CONSOLE_WORDS.milestonesWord}` : w.milestones);

/** a word with its first letter in capitals ("Project", "Projects"), for a heading or a sentence's start. */
export const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export const DEFAULT_SKIN: Skin = SKINS.console;

/** the shared header line of the brand family; the same names show on epicspine.dev. */
export const family = (): string[] => ["EpicSpine", "EpicTeam", socialProduct()];
export const EPICSPINE_URL = "https://epicspine.dev";

const isSkinId = (v: unknown): v is SkinId => typeof v === "string" && v in SKINS;

/** hosts that serve the social skin of the same console (same server, API and data as the production site). */
export function socialHosts(): ReadonlySet<string> {
  return new Set([hostOf(sites().socialUrl), ...customerSitesOf("social")]); // + the social product's customer sites
}

/** The skin a host name picks, or undefined (the production site, the tailnet URL, localhost: the flag decides). */
export function skinFromHost(host: string | undefined): SkinId | undefined {
  // app.social.<anything> too (a local proof runs as app.social.localhost)
  if (!host) return undefined;
  const h = host.toLowerCase();
  // app. or cloud. of a social customer site's name under any domain (a local proof runs on another one)
  const names = new Set(customerSitesOf("social").map((x) => x.split(".")[1]).filter(Boolean));
  const m = /^(app|cloud)\.([^.]+)\./.exec(h);
  return socialHosts().has(h) || (!!m && names.has(m[2])) ? "social" : undefined;
}

/**
 * Skin flag, read once at startup: `<meta name="console-skin" content="social">` in the served index.html
 * (devcopy.sh injects it after unpacking, so the shared release tarball stays the home world's), else the host name
 * (https://the social site is social), else VITE_SKIN at build time (local dev). Anything else (none,
 * empty, typo) is the console skin. Rollback for the host: drop it from the sites' social hosts.
 */
export function skinFlag(doc: Document | undefined = typeof document === "undefined" ? undefined : document): string | undefined {
  return (
    doc?.querySelector('meta[name="console-skin"]')?.getAttribute("content") ||
    skinFromHost(doc?.location?.hostname) ||
    import.meta.env.VITE_SKIN
  );
}
export function skinFromFlag(flag: string | undefined = skinFlag()): Skin {
  return isSkinId(flag) ? SKINS[flag] : DEFAULT_SKIN;
}

/** The world's setting (E22 seam): `/api/me` -> `{ tenant: { skin } }` (plan §3). Missing or unknown falls back to `fallback`. */
export interface WorldSkinSource {
  tenant?: { skin?: string | null } | null;
}
export function skinFromWorld(me: WorldSkinSource | null | undefined, fallback: Skin = skinFromFlag()): Skin {
  const s = me?.tenant?.skin;
  return isSkinId(s) ? SKINS[s] : fallback;
}

const SkinContext = createContext<Skin>(DEFAULT_SKIN);

/** Puts the skin in context and its theme attribute on <html>; the console skin sets nothing. */
export function SkinProvider({ skin, children }: { skin: Skin; children: ReactNode }) {
  // the skin's favicon (index.html links EpicTeam's icons; the server also serves the violet set on social hosts).
  useEffect(() => {
    if (!skin.favicon) return;
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]')];
    const was = links.map((l) => [l, l.getAttribute("href"), l.getAttribute("type")] as const);
    for (const l of links) {
      l.href = l.rel === "apple-touch-icon" ? skin.favicon.touch : skin.favicon.svg;
      if (l.rel === "icon") l.type = "image/svg+xml";
    }
    return () => {
      for (const [l, href, type] of was) {
        if (href) l.setAttribute("href", href);
        if (type) l.setAttribute("type", type);
        else l.removeAttribute("type");
      }
    };
  }, [skin.favicon]);
  useEffect(() => {
    if (!skin.themeAttr) return;
    const root = document.documentElement;
    root.dataset.skin = skin.themeAttr;
    return () => {
      delete root.dataset.skin;
    };
  }, [skin.themeAttr]);
  return <SkinContext.Provider value={skin}>{children}</SkinContext.Provider>;
}

export const useSkin = () => useContext(SkinContext);
export const useWords = () => useSkin().words;
export const useShows = () => {
  const { screens } = useSkin();
  return (s: ScreenId) => screens.has(s);
};
/** A screen has a route: shown, or reachable without a nav link. */
export const useRoutes = () => {
  const { screens, reach } = useSkin();
  return (s: ScreenId) => screens.has(s) || !!reach?.has(s);
};
