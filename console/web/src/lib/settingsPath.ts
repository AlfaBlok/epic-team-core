import { type ScreenId, useShows, useWords } from "@/lib/skin";

/** the Settings page's path, beside the menu's operator pages. */
export const SETTINGS_PATH = "settings";

/**
 * the operator pages Settings lists and the menu shows under Settings (docs/design/console.md; round 2 mockup
 * the tailnet URL One list, so the menu and the page never differ.
 */
export function useOperatorPages(): { to: string; label: string; what: string; testId: string }[] {
  const w = useWords();
  const shows = useShows();
  const all: { screen: ScreenId; to: string; label: string; what: string; testId: string }[] = [
    { screen: "seats", to: "/seats", label: w.seats, what: "where your agents run", testId: "op-seats" },
    { screen: "hosts", to: "/hosts", label: w.hosts, what: "your servers", testId: "op-hosts" },
    { screen: "secrets", to: "/secrets", label: w.secrets, what: "keys, by name only", testId: "op-secrets" },
    { screen: "services", to: "/connections", label: "Connections", what: "sign-ins the team uses", testId: "op-connections" },
    { screen: "teamSkills", to: "/team-skills", label: w.teamSkills, what: "what every persona can do", testId: "op-team-skills" },
    // the owner looks for "who applied", so the entry says Applications.
    { screen: "testers", to: "/testers", label: "Applications", what: "tester applications", testId: "op-applications" },
    { screen: "testers", to: "/feedback", label: "Voice feedback", what: "voice notes from testers and customers", testId: "op-feedback" },
    { screen: "credits", to: "/credits", label: "Credits", what: "your plan, monthly grant and top-ups", testId: "op-credits" },
    { screen: "browserAuth", to: "/auth", label: w.browserAuth, what: "the team browser's sign-ins", testId: "op-browser-auth" },
  ];
  return all.filter((p) => shows(p.screen));
}

