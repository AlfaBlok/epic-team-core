import { ownerName, socialProduct } from "../identity.js";
import type { ObjectiveCard } from "./inbox.js";

/**
 * The objectives coach (the owner's note 25 Nov 11:55Z: "can we have this guy
 * ... he's like a coach ... He knows to not talk too much. It's more about asking questions ... until the key results are
 * very clear ... He can take notes and pass them back to the team desk or to the social desk"). One web link he opens on
 * his phone (/coach) starts a call with its own ElevenLabs agent:
 *
 *   /coach ──▶ console: the coach agent + his objectives (read only) ──▶ ElevenLabs, on the grant
 *                       │ relay_to_desk (his words)
 *                       ├──▶ Team desk chat: one request, his words and the coach's note
 *                       └──▶ social desk: only his words about the social product (the desk relay)
 *
 * The coach never changes an objective or a key result: it reads them, asks what moved and what blocks, says back what he
 * said, and passes his words on. Any change waits for his yes on the desk that gets them.
 */

/**
 * The Team desk partner (the owner, 27 Nov, call_910685a3: "the Team desk should be my objectives guy ... the senior-most
 * person because he owns all the objectives ... and all the scorecards. He's above the objective manager"; call_92cffeeb:
 * Partner in his chat must reach the Team desk, "not one objective's strategist"). The coach is that person now: the same
 * call (/coach and the Team desk chat's Partner, one Voice, one ElevenLabs agent), one name everywhere (web whoAnswers.ts).
 */
export const TEAM_DESK_PARTNER = "Team desk partner";
/** the ElevenLabs agent's name on the account (kept: the agent is found again by it). */
export const COACH_AGENT_NAME = "EpicTeam objectives coach";
export const COACH_PAGE = "Team desk partner call";
export const COACH_HEAD = "📞 From the Team desk partner call";
export const COACH_GREETING = () => `Hi ${ownerName()}, your ${TEAM_DESK_PARTNER} here, over all your objectives. What is red first, or one objective?`;

type Desk = "team" | "social";

export const COACH_TOOLS = [
  {
    type: "function",
    name: "read_objective",
    description: `Read one of ${ownerName()}'s objectives in full (its light, every key result with its number and evidence, where it stands, his newest words): objective N in his order (number: N), or the one he is on (no number). Read only.`,
    parameters: { type: "object", properties: { number: { type: "integer", description: "The objective's place in his order (1 = first). Leave out for the one he is on." } }, additionalProperties: false },
  },
  {
    type: "function",
    name: "next_objective",
    description: `Go to ${ownerName()}'s next objective in his order and read it in full. Read only.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "relay_to_desk",
    description: `Pass what ${ownerName()} said to a desk, as one request it files and acts on. desk "team" for anything about building, his objectives and key results; desk "social" only for his words about ${socialProduct()} (its campaigns, posts, channels). Call it once per point, as soon as he says it, without reading it back or asking him. It changes nothing by itself: the desk asks his yes before any objective or key result changes.`,
    parameters: {
      type: "object",
      properties: {
        desk: { type: "string", description: `"team" or "social".` },
        words: { type: "string", description: "His words, as he said them, never your summary. For the social desk only his sentences about the social product." },
        note: { type: "string", description: "Team desk only: your one-line note (which objective, what he wants changed or decided)." },
        objective: { type: "string", description: "The objective it is about, by name, when there is one." },
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

/** what the coach knows of every objective at the call's start: one short block each (the rest by read_objective). */
export function coachKnows(cards: ObjectiveCard[]): string {
  if (!cards.length) return "# His objectives\nThey could not be read for this call: say so once and ask him which one he wants to talk about.";
  const out = [`# His objectives, in his order (${cards.length}), read only`];
  cards.forEach((o, i) => {
    const red = o.keyResults.filter((k) => k.state && k.state !== "green").map((k) => k.label.replace(/\s+/g, " ").slice(0, 90));
    out.push(`${i + 1}. ${o.name}: ${o.light}, ${o.krs}.${red.length ? ` Not green: ${red.slice(0, 4).join("; ")}${red.length > 4 ? `; and ${red.length - 4} more` : ""}.` : ""} ${o.stands ? `Stands: ${o.stands.slice(0, 140)}.` : ""}${o.words ? ` His newest words${o.said ? ` (${o.said})` : ""}: "${o.words.replace(/\s+/g, " ").slice(0, 200)}"` : ""}`);
  });
  return out.join("\n");
}

export function coachInstructions(): string {
  const name = ownerName();
  return [
    `You are ${name}'s ${TEAM_DESK_PARTNER}, on a phone call with him while he walks: his senior partner and OKR expert across every one of his objectives, in his order, above each objective's manager. That is your one name: say it if he asks who you are; never call yourself a coach, a briefer or a strategist, and never say you wear two hats. Your one job on this call: his objectives and key results become clear and true, and he knows where each stands. Stay on that topic; anything else he raises you note and relay, then bring him back.`,
    "Think in objectives and key results: which key result is red and nothing moves it, which number moved, what the one next step is that turns the next one green. When he asks where we are, answer in this order, one part at a time: the red key results first, then what moved, then what waits on him. Push back when a plan does not move a key result, and say which one it would move instead. When he wants to move on to another objective, go there on this call (read_objective, next_objective): you cover them all.",
    `${"When the line opens, the console has you say this greeting, once:"} "${COACH_GREETING()}" Never greet again.`,
    "How you work: ask, do not tell. One short question at a time, then let him talk. Once he has given his context, lead: say what you propose for the key result and why, then the next (How every call flows, below). Never lecture, never list, never read numbers unless he asks. You are sharp and knowledgeable: say plainly when an objective is too vague, is really a key result, or has a key result nobody can measure, and ask him what it should be instead.",
    "Your questions, in this order for the objective he picks: what moved since last time; what blocks it; is each key result the right one and can we measure it; what one thing should happen this week. An objective is aspirational (Notes launch); a key result is a number that proves it (five testers, listed on the key directories).",
    "You know his objectives below (read only) and read one in full with read_objective. You cannot change an objective, a key result or a target, and never say you did. If a pass does not go through, say so once and never promise to pass it later. When he wants something changed, added, dropped or done, call relay_to_desk quietly as he says it, with no read-back and no yes asked. The desk asks his yes again before anything changes.",
    `Which desk: "team" for objectives, key results, building and anything else; "social" only for his words about ${socialProduct()}'s campaigns, posts and channels, and then only his own sentences, nothing of yours.`,
    "Speak in his language (English or Spanish). Short turns: one or two sentences. Warm, direct, a little challenging, never chatty. He always has priority: never talk over him.",
    `Ending: when he clearly says he is done ('bye', 'that's all', 'hang up', 'adiós'), give a one-line recap of what you settled together, say goodbye and call hang_up. The whole call is saved to his Team desk chat when it ends.`,
  ].join("\n");
}

/** the coach's tool answer for relay_to_desk: which desk, his words, the coach's note. Throws on a bad desk or no words. */
export function relayIn(args: Record<string, unknown>): { desk: Desk; words: string; note: string; objective: string } {
  const desk = String(args.desk ?? "").toLowerCase().trim();
  const words = typeof args.words === "string" ? args.words.replace(/\s+/g, " ").trim() : "";
  if (desk !== "team" && desk !== "social") throw new Error('desk must be "team" or "social"');
  if (!words) throw new Error("words (his words, as he said them) are required");
  return { desk, words: words.slice(0, 6000), note: typeof args.note === "string" ? args.note.trim().slice(0, 600) : "", objective: typeof args.objective === "string" ? args.objective.trim().slice(0, 160) : "" };
}

/** the Team desk's message for one relay: his words first, the coach's note after, and what the desk does with it. */
export function teamRelayText(callId: string, r: { words: string; note: string; objective: string }): string {
  return [
    `${COACH_HEAD} (${callId})${r.objective ? ` · objective: ${r.objective}` : ""}`,
    `${ownerName()}'s words: "${r.words}"`,
    ...(r.note ? [`Partner's note: ${r.note}`] : []),
    `File it as one request row of his. Nothing changes an objective, key result or target without his yes: ask him on his inbox when it would.`,
  ].join("\n");
}
