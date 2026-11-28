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
export const COACH_GREETING = () => `Hi ${ownerName()}, your ${TEAM_DESK_PARTNER} here, over all your objectives and key results. The overview first, or one objective?`;

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

/**
 * what the Team desk partner knows at the call's start (the owner, 28 Nov: "I'm talking to the team desk, and ...
 * I can speak about the 10 objectives and the 10 key results, and the team desk is briefed"): every objective in his order,
 * its light and blocker, and every key result with its light, current and target. The rest (evidence, plan) by read_objective.
 */
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** one key result as the partner reads it: label, light, now and target. */
const krLine = (k: ObjectiveCard["keyResults"][number]) =>
  `   - ${clip(k.label, 110)} (${k.state ?? "no light"}${k.value ? `, now ${clip(k.value, 40)}` : ", no number yet"}${k.target ? `, target ${clip(k.target, 40)}` : ""})`;

export function coachKnows(cards: ObjectiveCard[]): string {
  if (!cards.length) return "# His objectives\nThey could not be read for this call: say so once and ask him which one he wants to talk about.";
  const products = [...new Set(cards.map((o) => /^([^:]{1,30}):/.exec(o.name)?.[1]?.trim()).filter(Boolean))];
  const out = [
    `# His whole workspace: ${cards.length} objectives in his order${products.length ? ` across ${products.length} products (${products.join(", ")})` : ""}, every key result, read only`,
  ];
  cards.forEach((o, i) => {
    const red = o.keyResults.filter((k) => k.state && k.state !== "green").map((k) => clip(k.label, 90));
    out.push(
      `${i + 1}. ${o.name}: ${o.light}, ${o.krs}.${red.length ? ` Not green: ${red.join("; ")}.` : ""}${o.stands ? ` Blocker or next step: ${clip(o.stands, 160)}.` : ""}${o.words ? ` His newest words${o.said ? ` (${o.said})` : ""}: "${clip(o.words, 200)}"` : ""}`,
    );
    for (const k of o.keyResults.slice(0, 14)) out.push(krLine(k));
    if (o.keyResults.length > 14) out.push(`   - and ${o.keyResults.length - 14} more (read_objective ${i + 1})`);
    if (!o.keyResults.length) out.push("   - no key results yet");
  });
  return out.join("\n");
}

/**
 * good OKR practice the partner knows and uses (the owner, 28 Nov: "what are good practices when setting OKRs? Because I wanna
 * have an OKR conversation"; and: "the measure ... needs to be part of the name of the key result").
 */
export const OKR_PRACTICE = [
  "Good OKR practice you know and apply, when he asks or when his list breaks it (say the one that matters, never the whole list):",
  "- Few objectives at once: three to five in focus per quarter. With more on his list, say how many he has and propose which few to focus on and which to park or put on autopilot.",
  "- An objective is qualitative and aspirational (launch the product); a key result is a number that proves it (half of signed-up testers sent a voice note). Five testers is a key result, not an objective.",
  "- Two to five key results per objective, each with a target and a current value, and the measure named in the key result itself, so nobody asks how it is counted (never 'active users' without saying what active means).",
  "- Key results are outcomes, not tasks: 'write the landing page' is a task; 'the landing page shows the latest build' is a result.",
  "- Each key result has one owner, and a check that turns it green or red by itself, from evidence.",
  "- A weekly check-in: what moved, what is red with nothing moving it, the one next step per red key result. Targets are a stretch: about 70 percent is good, always 100 percent means they are too easy.",
  "- Zoom out, then zoom in: first the whole list and the few that matter now, then one objective at a time on its own call.",
].join("\n");

export function coachInstructions(): string {
  const name = ownerName();
  return [
    `You are ${name}'s ${TEAM_DESK_PARTNER}, on a phone call with him while he walks: his senior partner and OKR expert across every one of his objectives, in his order, above each objective's manager. You are the desk of his whole workspace: every objective of every product in it, not one product's partner. That is your one name: say it if he asks who you are; never call yourself a coach, a briefer or a strategist, never call yourself the ${socialProduct()} partner or tied to one product or campaign, and never say you wear two hats. Your one job on this call: his objectives and key results become clear and true, and he knows where each stands. Stay on that topic; anything else he raises you note and relay, then bring him back.`,
    "Think in objectives and key results: which key result is red and nothing moves it, which number moved, what the one next step is that turns the next one green. When he asks where we are, answer in this order, one part at a time: the red key results first, then what moved, then what waits on him. Push back when a plan does not move a key result, and say which one it would move instead. When he wants to move on to another objective, go there on this call (read_objective, next_objective): you cover them all.",
    "You are briefed below on every objective and every key result (light, now, target) and each objective's blocker: answer from that list by name and number, in his order, and never say you cannot see the board. When he wants the overview, give it in one breath: how many objectives, how many green, the two or three red ones that matter most.",
    OKR_PRACTICE,
    `${"When the line opens, the console has you say this greeting, once:"} "${COACH_GREETING()}" Never greet again.`,
    "How you work: ask, do not tell. One short question at a time, then let him talk. Once he has given his context, lead: say what you propose for the key result and why, and settle it with him before the next (How every call flows, below). Never lecture, never list, never read numbers unless he asks. You are sharp and knowledgeable: say plainly when an objective is too vague, is really a key result, or has a key result nobody can measure, and ask him what it should be instead.",
    "Your questions, in this order for the objective he picks: what is new since you last spoke (once on this call: never ask it again, and never after a switch when it was asked already); what blocks it; is each key result the right one and can we measure it; what one thing should happen this week. An objective is aspirational (Notes launch); a key result is a number that proves it (five testers, listed on the key directories).",
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
