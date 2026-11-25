import { ownerName, socialProduct } from "../identity.js";
import type { ObjectiveCard } from "./inbox.js";

/**
 * The senior marketing call (the owner's WhatsApp 25 Nov 14:34Z, Log/2026-11-25.md#^e-3941fc: "for me having this
 * conversation with a senior marketing person, could it be on the phone? ... We could have this working today
 * potentially"). One web link he opens on his phone (/marketing) starts a call with its own ElevenLabs agent, on the same
 * call path as the coach and the briefing call (mountOwnCall):
 *
 *   /marketing ──▶ console: the marketing brief (marketingBrief()), the social product's objectives,
 *                  every campaign's plan and numbers ──▶ ElevenLabs, on the grant
 *                  │ relay_to_desk (his words)
 *                  ├──▶ social desk: his words about the campaigns, posts and channels (the desk relay)
 *                  └──▶ Team desk: anything else, one request each
 *
 * The marketer talks strategy: what the number one blocker is, the campaign plan, who it is for, the message, the
 * channels, the timeline. It asks, bounces ideas, gives its view, and passes his decisions on; it never changes a plan,
 * a post or a key result itself.
 */

export const marketingAgentName = () => `${socialProduct()} senior marketing call`;
export const MARKETING_PAGE = "senior marketing call";
export const MARKETING_HEAD = "📞 From the senior marketing call";
/** the brief the call starts from, in the home repo (the social product's Context place). */
export const marketingBrief = () => process.env.CONSOLE_MARKETING_BRIEF || `docs/${socialProduct().toLowerCase()}/marketing-call.md`;
export const MARKETING_GREETING = () => `Hi ${ownerName()}, marketing here. Do you want the numbers first, posts, replies, DMs and testers, or straight to the number one blocker?`;

export const MARKETING_TOOLS = [
  {
    type: "function",
    name: "relay_to_desk",
    description: `Pass one decision or note of ${ownerName()}'s to a desk, as one request it files and acts on. desk "social" for his words about ${socialProduct()}'s campaigns, strategy, messages, posts and channels; desk "team" for anything about building a product or his objectives. Call it once per point, after you said back in one line what you will pass and he agreed.`,
    parameters: {
      type: "object",
      properties: {
        desk: { type: "string", description: `"social" or "team".` },
        words: { type: "string", description: "His words, as he said them, never your summary." },
        note: { type: "string", description: "Your one-line note: which campaign, what he decided or wants." },
        campaign: { type: "string", description: "The campaign or product it is about, when there is one." },
      },
      required: ["desk", "words"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "hang_up",
    description: `End the call when ${ownerName()} clearly says he is done, after one short goodbye.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

const clip = (s: string, max: number) => {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** what the marketer knows at the call's start: the brief, the social product's objectives, the campaigns' plans. */
export function marketingKnows(o: { brief?: string; objectives: ObjectiveCard[]; campaigns?: string; numbers?: string }): string {
  const out: string[] = ["# What you know on this call (read only)"];
  out.push(o.brief?.trim() ? clip(o.brief.replace(/^# .*\n/, ""), 9000) : "The marketing brief could not be read for this call: say so once if he asks about the plan.");
  const mine = o.objectives.filter((x) => x.name.toLowerCase().startsWith(`${socialProduct().toLowerCase()}:`));
  out.push("", `## ${socialProduct()}'s objectives (${mine.length}), his order`);
  if (!mine.length) out.push("None could be read for this call.");
  for (const x of mine) {
    const red = x.keyResults.filter((k) => k.state && k.state !== "green").map((k) => k.label.replace(/\s+/g, " ").slice(0, 110));
    out.push(`- ${x.name}: ${x.light}, ${x.krs}.${red.length ? ` Not green: ${red.slice(0, 4).join("; ")}.` : ""}${x.words ? ` His newest words: "${x.words.replace(/\s+/g, " ").slice(0, 200)}"` : ""}`);
  }
  if (o.numbers?.trim()) out.push("", clip(o.numbers, 9000));
  if (o.campaigns?.trim()) out.push("", "## The campaigns' own plans, today", clip(o.campaigns.replace(/^# .*\n/, ""), 7000));
  return out.join("\n");
}

export function marketingInstructions(): string {
  const name = ownerName();
  return [
    `You are ${name}'s senior marketing person for ${socialProduct()}, on a phone call with him while he walks. ${socialProduct()} runs the marketing campaigns of his products, named in what you know below. Your job on this call: settle the strategy with him, campaign by campaign: the number one blocker, who it is for, the one message, the channels, what a win looks like and by when.`,
    `When the line opens, the console has you say this greeting, once: "${MARKETING_GREETING()}" Never greet again.`,
    "How you work: you are senior and have a view. When he asks for the number one blocker, give yours from what you know below in one or two sentences, then ask for his. Ask one question at a time and let him talk. Bounce ideas: offer one idea at a time, with why, and ask what he thinks. Say back in one sentence what you heard before the next question. Never lecture, never list more than three things, never read codes, links or long numbers.",
    "The numbers: what you know below holds the numbers read live as the call started: the posts of the last 7 days with views, engagement, the best and the worst, the Reddit replies to us, the DMs waiting on us, the tester invites and each campaign's next steps. When he wants the numbers, walk them in that order, one part at a time, in plain words and round numbers, and stop after each part for his word. Name a post by what it says, never by its id. A part that could not be read: say so in one line and why, never guess a number.",
    "For a campaign without a strategy yet, walk him through it in this order: who it is for, the one message, the two or three channels, what we can start now (a waitlist, message tests) while the product is not ready, and the timeline in milestones.",
    "You know only what is below. If something is not there, say you do not know and offer to pass the question on. You cannot change a plan, a post, a key result or a target, and never say you did.",
    `Notes: each thing he decides or wants done is one note. Say back in one line what you will pass and to which desk, and on his yes call relay_to_desk: desk "social" for campaigns, messages, posts and channels, desk "team" for building a product or his objectives. One note, one call, his own words. If a pass does not go through, say so once and never promise to pass it later.`,
    "Speak in his language (English or Spanish). Short turns: one to three sentences. Warm, direct and sharp, like a good marketing lead; never chatty, never salesy. He always has priority: never talk over him.",
    "Ending: when he clearly says he is done ('bye', 'that's all', 'hang up', 'adiós'), give a one-line recap of what you passed on, say goodbye and call hang_up. The whole call is saved to his Team desk chat when it ends.",
  ].join("\n");
}

/** the marketer's relay_to_desk: which desk, his words, the note, the campaign. Throws on a bad desk or no words. */
export function marketingRelayIn(args: Record<string, unknown>): { desk: "social" | "team"; words: string; note: string; campaign: string } {
  const desk = String(args.desk ?? "").toLowerCase().trim();
  const words = typeof args.words === "string" ? args.words.replace(/\s+/g, " ").trim() : "";
  if (desk !== "team" && desk !== "social") throw new Error('desk must be "social" or "team"');
  if (!words) throw new Error("words (his words, as he said them) are required");
  return { desk, words: words.slice(0, 6000), note: typeof args.note === "string" ? args.note.trim().slice(0, 600) : "", campaign: typeof args.campaign === "string" ? args.campaign.trim().slice(0, 160) : "" };
}

/** the Team desk's message for one note: his words first, the marketer's note after, filed as one request. */
export function marketingNoteText(callId: string, r: { words: string; note: string; campaign: string }, forSocial = false): string {
  return [
    `${MARKETING_HEAD} (${callId})${r.campaign ? ` · ${r.campaign}` : ""}`,
    `${ownerName()}'s words: "${r.words}"`,
    ...(r.note ? [`Marketing note: ${r.note}`] : []),
    forSocial
      ? `For the ${socialProduct()} desk: pass only his words there (no desk across on this console). File it as one request row of his.`
      : "File it as one request row of his, like a chat line of his.",
  ].join("\n");
}
