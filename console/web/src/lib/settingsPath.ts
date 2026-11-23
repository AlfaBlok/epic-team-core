import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { homeWorld } from "@/lib/identity";
import { type ScreenId, useShows, useWords } from "@/lib/skin";

/** the Settings page's path, beside the menu's operator pages. */
export const SETTINGS_PATH = "settings";
/** the old dashboard panels (project cards, personas, activity), out of Settings (root L-80: read-only). */
export const DASHBOARD_PATH = "dashboard";

type Page = { to: string; label: string; what: string; testId: string };

/**
 * Settings is only what the owner changes (root L-80, the owner: "settings is about things where the
 * user has to input something ... If the user is not inputting something, it's not a setting"). Each page says which
 * it is: `input` pages (a field, a toggle, a pick) sit under Settings; the read-only ones (Seats first, his "Why is
 * seats inside of settings? And I cannot change anything") are tools, listed with the console's other pages.
 *
 * the operator pages Settings lists and the menu shows under Settings (docs/design/console.md; round 2 mockup
 * the tailnet URL One list, so the menu and the page never differ.
 */
export function useOperatorPages(): Page[] {
  return usePages(true);
}

/** the read-only pages that left Settings: they show, nothing to change there (the menu's tools). */
export function useToolPages(): Page[] {
  return usePages(false);
}

function usePages(input: boolean): Page[] {
  const w = useWords();
  const shows = useShows();
  const all: (Page & { screen: ScreenId; input: boolean })[] = [
    { screen: "seats", to: "/seats", label: w.seats, what: "where your agents run", testId: "op-seats", input: false },
    { screen: "hosts", to: "/hosts", label: w.hosts, what: "your servers", testId: "op-hosts", input: false },
    { screen: "secrets", to: "/secrets", label: w.secrets, what: "add or replace a key", testId: "op-secrets", input: true },
    { screen: "services", to: "/connections", label: "Connections", what: "connect or remove a sign-in", testId: "op-connections", input: true },
    { screen: "teamSkills", to: "/team-skills", label: w.teamSkills, what: "add or remove a skill", testId: "op-team-skills", input: true },
    // the owner: the applications are a tracker inside an objective, no menu entry.
    { screen: "testers", to: "/feedback", label: "Voice feedback", what: "voice notes from testers and customers", testId: "op-feedback", input: false },
    { screen: "yourAi", to: "/your-ai", label: "Your AI", what: "the AI your team runs on", testId: "op-your-ai", input: true },
    { screen: "credits", to: "/credits", label: "Credits", what: "top up your credits", testId: "op-credits", input: true },
    // the owner: "Can we have in the settings somewhere where those blocks are explicit"; each line leads to where its rule is changed.
    { screen: "postingLimits", to: "/posting-limits", label: "Posting limits", what: "every rule that can stop a post", testId: "op-posting-limits", input: true },
    { screen: "browserAuth", to: "/auth", label: w.browserAuth, what: "sign the team browser in or out", testId: "op-browser-auth", input: true },
    { screen: "settings", to: `/${DASHBOARD_PATH}`, label: "Dashboard", what: "project cards, personas and activity", testId: "op-dashboard", input: false },
  ];
  // Your AI is a customer workspace's: the home world's team still runs on the platform's seats.
  const { data: me } = useQuery(() => (api.getMe ? api.getMe() : Promise.resolve(undefined)), []);
  const customer = !!me?.tenant?.id && me.tenant.id !== homeWorld();
  // the owner 18 Nov ("I go in settings and I didn't have the ability there to connect GitHub"): a
  // customer workspace connects GitHub on Connections, and the entry says so
  return all
    .filter((p) => p.input === input && shows(p.screen) && (p.screen !== "yourAi" || customer))
    .map(({ to, label, what, testId }) => ({ to, label, what: customer && to === "/connections" ? "connect GitHub, MCP, email" : what, testId }));
}

