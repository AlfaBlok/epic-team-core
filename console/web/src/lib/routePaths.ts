import { DECK_PATH, ROCKS_PATH } from "@/lib/deck";
import { BOOK_PATH } from "@/lib/book";
import { memoryName } from "@/lib/identity";

/**
 * The screens' addresses, apart from the screens themselves, so the router and the sidebar can name a screen
 * without putting its script in the first download (each page module re-exports its own, so old imports still work).
 */
export const FEEDBACK_PATH = "feedback";
export const TEAM_SKILLS_PATH = "team-skills";
export const YOUR_TEAM_PATH = "your-team";
export const IDEAS_PATH = "ideas";
export const CAMPAIGNS_PATH = "campaigns";
export const NEW_CAMPAIGN_PATH = "campaigns/new";
export const BRIEF_PATH = "brief";
export { BOOK_PATH };
export const MILESTONE_BOOK_PATH = `${BOOK_PATH}/:key`;
export const DECK_INDEX_PATH = DECK_PATH;
export const EPIC_DECK_PATH = `${DECK_PATH}/:repo/:code`;
export const ROCKS_PAGE_PATH = ROCKS_PATH;
export const GOAL_GRAPH_PATH = "goal-graph";
export const memoryPagePath = (): string => `${memoryName().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-memory`;
export const GAP_FINDER_PATH = "gap-finder";
export const LAUNCH_PATH = "launch";
export const PRIORITY_PATH = "priority";
export const PAGES_PATH = "pages";
export const ONE_OFFS_PATH = "one-offs";
export const OUTCOMES_PATH = "outcomes";
export const VOICE_NOTES_PATH = "voice-notes";
/** the voice notes kept on this device: waiting to send, and the last few sent. */
export const ON_DEVICE_PATH = "voice-on-device";
/** the objectives coach call: one link he opens on his phone. */
export const COACH_PATH = "coach";
/** the briefing call: what happened since his last briefing, then his notes to the Team desk. */
export const BRIEFING_PATH = "briefing";
/** the senior marketing call: the social product's strategy, the number one blocker and each campaign's plan. */
export const MARKETING_PATH = "marketing";
/** the team product's strategy call: who buys first, the message, the waitlist, the launch timeline. */
export const STRATEGY_PATH = "strategy";
export const X_STATS_PATH = "x-stats";
