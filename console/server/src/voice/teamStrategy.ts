import { TEAM_HEAD } from "../brand.js";
import { ownerName, socialProduct } from "../identity.js";
import type { ObjectiveCard } from "./inbox.js";
import { MARKETING_TOOLS } from "./marketing.js";

/**
 * The team product's strategy call (the owner chose to book both strategy calls when he closed the launch timeline, his
 * WhatsApp 25 Nov: "These are two phone calls where we do the campaign strategy setting"). The senior marketing call (/marketing) sets the social
 * product's strategy; this one sets the team product's, on the same call path (mountOwnCall, its own ElevenLabs agent):
 *
 *   /strategy ──▶ console: the strategy brief (strategyBrief(): the launch timeline, what ready waits on, the questions)
 *                 + the team product's objectives ──▶ ElevenLabs, on the grant
 *                 │ relay_to_desk (his words; the marketing call's tool and relay, reused)
 *                 ├──▶ Team desk: building the product, its plan, its key results
 *                 └──▶ social desk: his words about its campaign, messages, posts and channels
 *
 * It asks, bounces ideas, gives its view, passes his decisions on; it never changes a plan, a key result or a page.
 */

export const teamProduct = () => TEAM_HEAD.name;
export const strategyAgentName = () => `${teamProduct()} strategy call`;
export const STRATEGY_PAGE = "strategy call";
export const STRATEGY_HEAD = "📞 From the strategy call";
/** the brief the call starts from, in the home repo (the team product's Context place). */
export const strategyBrief = () => process.env.CONSOLE_STRATEGY_BRIEF || `docs/${teamProduct().toLowerCase()}/strategy-call.md`;
export const STRATEGY_GREETING = () => `Hi ${ownerName()}, this is the ${teamProduct()} strategy call. Shall we start with who buys first?`;
/** the same two tools as the marketing call: relay_to_desk (social or team) and hang_up. */
export const STRATEGY_TOOLS = MARKETING_TOOLS;

const clip = (s: string, max: number) => {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** what the call knows at its start: the brief and only the team product's objectives. */
export function strategyKnows(o: { brief?: string; objectives: ObjectiveCard[] }): string {
  const out: string[] = ["# What you know on this call (read only)"];
  out.push(o.brief?.trim() ? clip(o.brief.replace(/^# .*\n/, ""), 12000) : "The strategy brief could not be read for this call: say so once if he asks about the timeline.");
  const mine = o.objectives.filter((x) => x.name.toLowerCase().startsWith(`${teamProduct().toLowerCase()}:`));
  out.push("", `## ${teamProduct()}'s objectives (${mine.length}), his order`);
  if (!mine.length) out.push("None could be read for this call.");
  for (const x of mine) {
    const red = x.keyResults.filter((k) => k.state && k.state !== "green").map((k) => k.label.replace(/\s+/g, " ").slice(0, 110));
    out.push(`- ${x.name}: ${x.light}, ${x.krs}.${red.length ? ` Not green: ${red.slice(0, 4).join("; ")}.` : ""}${x.words ? ` His newest words: "${x.words.replace(/\s+/g, " ").slice(0, 200)}"` : ""}`);
  }
  return out.join("\n");
}

export function strategyInstructions(): string {
  const name = ownerName();
  const p = teamProduct();
  return [
    `You are ${name}'s senior strategist for ${p}, on a phone call with him while he walks. ${p} is his agent team sold as a product. Your job on this call: set ${p}'s launch strategy with him, the questions in what you know below, one at a time: who buys first, which of his pitch points lead, a waitlist now or wait for checkout, what we show, and what number means it worked by when.`,
    `When the line opens, the console has you say this greeting, once: "${STRATEGY_GREETING()}" Never greet again.`,
    "How you work: you are senior and have a view. Start from the number one blocker in what you know below, in one or two sentences, then ask the first question. Ask one question at a time and let him talk. Bounce ideas: offer one idea at a time, with why, and ask what he thinks. Say back in one sentence what you heard before the next question. Never lecture, never list more than three things, never read codes, links or long numbers.",
    "You know only what is below. If something is not there, say you do not know and offer to pass the question on. You cannot change a plan, a page, a key result or a date, and never say you did.",
    `Notes: each thing he decides or wants done is one note. Say back in one line what you will pass and to which desk, and on his yes call relay_to_desk: desk "team" for building ${p}, its plan, its key results and its dates; desk "social" for ${p}'s campaign, messages, posts and channels, which ${socialProduct()} runs. One note, one call, his own words. If a pass does not go through, say so once and never promise to pass it later.`,
    "Speak in his language (English or Spanish). Short turns: one to three sentences. Warm, direct and sharp; never chatty, never salesy. He always has priority: never talk over him.",
    "Ending: when he clearly says he is done ('bye', 'that's all', 'hang up', 'adiós'), give a one-line recap of what you passed on, say goodbye and call hang_up. The whole call is saved to his Team desk chat when it ends.",
  ].join("\n");
}

/** the Team desk's message for one note: his words first, the strategist's note after, filed as one request. */
export function strategyNoteText(callId: string, r: { words: string; note: string; campaign: string }, forSocial = false): string {
  return [
    `${STRATEGY_HEAD} (${callId}) · ${r.campaign || teamProduct()}`,
    `${ownerName()}'s words: "${r.words}"`,
    ...(r.note ? [`Strategy note: ${r.note}`] : []),
    forSocial
      ? `For the ${socialProduct()} desk: pass only his words there (no desk across on this console). File it as one request row of his.`
      : "File it as one request row of his, like a chat line of his.",
  ].join("\n");
}
