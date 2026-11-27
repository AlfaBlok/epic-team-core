import fs from "node:fs";
import path from "node:path";

/**
 * Campaign onboarding in three phases (the owner's voice note):
 *
 *   1 briefing call ──▶ 2 our research ──▶ 3 the pitch call
 *   he gives the problem,   competitors, influencers,   we walk a deck: channels, content,
 *   objectives, messages     Reddit, his site tried       messages, personas, cost, one week
 *   and the website
 *
 * "maybe there should be a second phone call after this guy has done all this research ... It's almost like you have to
 * present the project. You have to sell the project, and you say that's the expected cost ... we propose to run this for a week."
 *
 * No new call: the objective's own Call (and its product desk's) reads one file per objective,
 * docs/plans/campaign-onboarding/<objective id>.md in the home repo, and this rule tells it how to run each phase.
 */
export const ONBOARDING_PLANS_DIR = "docs/plans/campaign-onboarding";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX = 4000;

export const ONBOARDING_RULE = [
  "Campaign onboarding runs in three phases: 1 a briefing call (he gives the problem, the objectives, the messages and the website), 2 our research (competitors, influencers, what people say on Reddit, his site tried), 3 a pitch call where you sell him one campaign.",
  "If the brief below still lists open questions and he wants to do the briefing, ask them one at a time, let him talk, and pass each answer as one note in his own words.",
  "If he asks for the pitch (or the proposal, the campaign, the deck), walk it one slide at a time in its order. Say each slide in two or three sentences, then stop and let him react before the next. Never read links, codes or tables aloud.",
  "End the pitch by asking one thing: do we run it for a week as proposed. His yes, no or changes go as one note in his words. Never promise spend: money beyond what he already approved waits for his yes on a card.",
].join("\n");

/** the onboarding file of one objective, read for its call; "" when there is none. */
export function onboardingText(dir: string | undefined, id: string | undefined): string {
  if (!dir || !id || !ID.test(id)) return "";
  try {
    const t = fs.readFileSync(path.join(dir, ONBOARDING_PLANS_DIR, `${id}.md`), "utf8").trim();
    return t.length > MAX ? `${t.slice(0, MAX - 1).trimEnd()}…` : t;
  } catch {
    return "";
  }
}

/** the call's section for these objectives: the rule once, then each objective's brief, research and pitch. "" when none has one. */
export function onboardingSection(dir: string | undefined, ids: string[]): string {
  const parts = [...new Set(ids)].map((id) => onboardingText(dir, id)).filter(Boolean);
  if (!parts.length) return "";
  return ["## Campaign onboarding: brief, research, pitch", ONBOARDING_RULE, ...parts].join("\n\n");
}
