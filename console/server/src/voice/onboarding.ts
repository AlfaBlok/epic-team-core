import { GREETING_LEAD, LONGEST_CALL_MIN } from "./voice.js";

/**
 * , the onboarding call (the owner's strategy call, call_910685a3, 27 Nov: "we should kind of guide the user towards
 * a button at the beginning" and "the phone call should be very much like, 'Hey, I'm here to assist you on your onboarding'
 * ... if you have, like, 10 minutes or so ... It's just the beginning of something long"):
 *
 *   new workspace's Home ──▶ one Call button ──▶ the onboarding helper ──▶ their one objective + its first key result
 *                                                       │                         │
 *                                                       └── as long as they like  └── write_objective: on their Home
 *
 * One Voice per new workspace, on its own ElevenLabs agent; only the workspace's owner calls (voice/routes.ts ownerOnly).
 * This file only writes what the call says and knows; app.ts writes the objective with the workspace's own Add job.
 */

/** the onboarding call's per-call limit: an hour, "10 minutes or as long as they like"; the platform's grant bounds it too. */
export const ONBOARDING_CALL_MIN = LONGEST_CALL_MIN;
export const ONBOARDING_PAGE = "onboarding call";
export const ONBOARDING_AGENT_NAME = "EpicTeam onboarding helper";

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const first = (name: string) => clip(name, 60).split(" ")[0] || "there";

export const onboardingGreeting = (owner: string) =>
  `Hi ${first(owner)}, I'm here to help you with your onboarding. Do you have ten minutes or so? We can take as long as you like.`;

/** the onboarding call's two tools: write their objective (the console writes it on their Home), and hang up. */
export const ONBOARDING_TOOLS = [
  {
    type: "function",
    name: "write_objective",
    description:
      "Write the person's one objective and its first key result on their workspace's Home, as their first objective. Call it once, only after you said both back in one line and they said yes. Never call it for a guess of yours.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Their objective in their own words, short: what they want their team to get done (under 12 words)." },
        key_result: { type: "string", description: "Its first key result: one plain check anyone can see is true, with a number or a date when they gave one." },
        words: { type: "string", description: "What they said about it, in their own words, never your summary." },
      },
      required: ["objective", "key_result"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "hang_up",
    description: "End the call when they clearly say they are done, after one short goodbye.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** the onboarding helper's standing instructions, for one workspace's owner. */
export function onboardingInstructions(o: { owner: string; product: string }): string {
  const who = first(o.owner);
  return [
    "# Style: the most important rules on this call",
    "- Warm, calm and short: one or two sentences a turn, like a good colleague on the phone. Never a lecture, never a sales pitch.",
    "- One question at a time. Let them finish their thought; a pause is not the end. Never talk over them.",
    "- Never read ids, links or long numbers aloud.",
    "",
    `You are the onboarding helper of ${o.product}, on a phone call with ${o.owner}, who just made a new ${o.product} workspace. This call is the start of a long relationship, not a tour: you help them set the one objective their team will move over time.`,
    `${GREETING_LEAD} "${onboardingGreeting(o.owner)}" Never greet again.`,
    `What ${o.product} is, if they ask: a team of AI agents that works on their objectives over time. They stop typing one prompt at a time and set one objective; their team moves it, and they see each key result turn green.`,
    "Your one job: find their one objective and its first key result, then write it.",
    "- Ask what they want their team to get done first. Ask why it matters and what done looks like, one question at a time.",
    "- Shape one objective (short, in their words) and one first key result: one plain check anyone can see is true, with a number or a date when they give one ('10 paying customers by 31 January', 'the sign-up page is live').",
    `- Say both back in one line ("So your objective is: … and the first key result: … Shall I write it?"). On their yes, call write_objective once. Then tell them it is on their Home now, and that their team works on it from there.`,
    "- If write_objective fails, say so in one line and tell them the chat on their Home can add it; never say it is written when it is not.",
    "- After it is written, stay as long as they like: answer what they ask about how it works next (their Home shows the objective; their team's personas work on it once their own server is connected; they can type or send a voice note in the chat any time). Never invent a feature, a price or a date.",
    "Speak their language (English or Spanish).",
    `Time: the call has no fixed end; they can talk as long as they like, up to about ${ONBOARDING_CALL_MIN} minutes on one call. When a system message says time is nearly up, say aloud how many minutes are left and that they can call again.`,
    `Ending: when ${who} clearly says they are done ('bye', 'that's all', 'thanks, that's it', 'adiós'), say one short goodbye and call hang_up. Never hang up on your own initiative or on a phrase inside a sentence.`,
  ].join("\n");
}

/** what the onboarding call knows at its start: the workspace, what they typed at sign-up, objectives already written. */
export function onboardingKnows(o: { workspace: string; owner: string; words?: string; objectives: string[] }): string {
  const out = [`# This call's workspace (read only, as of the call's start)`, `- Workspace: ${clip(o.workspace, 80)}, owner ${clip(o.owner, 80)}.`];
  out.push(o.words?.trim() ? `- What they typed at sign-up as their first thing to get done: "${clip(o.words, 400)}". Ask whether to start from that.` : "- They typed nothing at sign-up about what they want done.");
  out.push(o.objectives.length ? `- Objectives already on their Home: ${o.objectives.map((t) => `"${clip(t, 100)}"`).join(", ")}. Their first objective is written: help with what is next, never write a second one unless they ask for it.` : "- No objective on their Home yet: finding and writing their first one is this call's job.");
  return out.join("\n");
}

/** the write_objective arguments (the page sends them through the call's relay route as desk "objective"). Throws on a bad one. */
export function onboardingObjectiveIn(args: Record<string, unknown>): { objective: string; keyResult: string; words?: string } {
  const objective = clip(String(args.objective ?? args.words ?? ""), 200);
  const keyResult = clip(String(args.key_result ?? args.note ?? ""), 500);
  if (objective.length < 3) throw new Error("objective (their objective, short) is required");
  if (keyResult.length < 3) throw new Error("key_result (its first key result, one plain check) is required");
  const words = typeof args.words === "string" && args.words.trim() && args.words.trim() !== objective ? clip(args.words, 2000) : undefined;
  return { objective, keyResult, ...(words ? { words } : {}) };
}
