import { ownerName } from "../identity.js";

/**
 * Switch on the same call (the owner, 27 Nov: "why is it that we need to really hand over? ... Can
 * you like load the strategy package into your context?"). A TEST on ElevenLabs showed one live call can: a client tool
 * returns that objective's package and the agent answers from it about a second later, same call, same line, nothing lost.
 *
 *   desk call ── "let's do Testers" ──▶ switch_to("Testers") ──▶ console: that objective's package (levelKnows)
 *        ▲                                       │                         │
 *        │                                       ▼                         ▼
 *        └──── switch_to("desk") ◀── "<objective> manager" on his screen ◀─ the agent speaks as its manager
 *
 * Which calls have it: the Team desk partner (/coach, Partner in his chat), the Team desk manager (/briefing) and the
 * strategy call. Its result goes into the call's context; the page puts the new name on the call screen.
 */

export const SWITCH_TOOL = {
  type: "function",
  name: "switch_to",
  description: `Bring another partner onto this same call: the manager of one of ${ownerName()}'s objectives (to: its name or its number in his order), or back to the desk (to: "desk"). Loads that partner's whole package (key results with today's numbers, plan, where we are, his newest words, what waits on him) into this call and puts its name on his screen. Say first, in one line, who you are switching to.`,
  parameters: {
    type: "object",
    properties: { to: { type: "string", description: 'The objective, by name or number in his order, or "desk" to come back.' } },
    required: ["to"],
    additionalProperties: false,
  },
};

/** the rule every call with switch_to adds to its instructions: when to switch, what to say, how to come back. */
export function switchRule(home: string): string {
  return [
    `Switching partner on this call: you start as the ${home}. When the talk turns to one objective (its plan, its key results, a decision on it), or he asks for its manager, say in one line "Switching to the <objective> manager, just to keep us focused: everything we said stays on this call", then call switch_to with that objective. From its answer on you ARE that manager: say its name if he asks who he is talking to, and answer from its package, never from memory.`,
    `When he wants the whole picture again or another objective, switch again (to: "desk" brings back the ${home}). Never hang up to hand over, and never say another call will ring: the switch happens on this call.`,
  ].join("\n");
}

export type SwitchCard = { id: string; name: string };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^[^:]{1,30}:\s*/, "")
    .replace(/[^a-z0-9áéíóúñü ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** which objective `to` names: its number in his order, its whole name, the words after its product, or most shared words. */
export function pickObjective<T extends SwitchCard>(cards: T[], to: string): T | undefined {
  const t = to.trim();
  if (!t) return undefined;
  const n = /^#?\s*(\d{1,2})$/.exec(t)?.[1];
  if (n) return cards[Number(n) - 1];
  const want = norm(t);
  const whole = t.toLowerCase().trim();
  const exact = cards.find((c) => c.name.toLowerCase() === whole || norm(c.name) === want || c.id === t);
  if (exact) return exact;
  const inside = cards.find((c) => norm(c.name).includes(want) || (want.length > 3 && want.includes(norm(c.name))));
  if (inside) return inside;
  const words = new Set(want.split(" ").filter((w) => w.length > 2 && !["the", "and", "objective", "manager", "get"].includes(w)));
  let best: T | undefined;
  let score = 0;
  for (const c of cards) {
    const s = norm(c.name)
      .split(" ")
      .filter((w) => words.has(w)).length;
    if (s > score) [best, score] = [c, s];
  }
  return score ? best : undefined;
}

const isDesk = (to: string) => /^(desk|back|team desk|the desk|home|all|everything)$/i.test(to.trim()) || /\bdesk\b/i.test(to);

/**
 * the switch_to answer: `{ name, result }`. `name` is who is on the line now (the page shows it); `result` goes into the
 * call's context. `objectiveName` names an objective's manager the same way as the web (whoAnswers.ts) and levelCall.ts.
 */
export async function switchAnswer(
  to: string,
  o: { home: string; cards: () => Promise<SwitchCard[]>; pack: (card: SwitchCard) => Promise<string>; deskPack?: () => Promise<string>; objectiveName: (name: string) => string },
): Promise<{ name: string; objective?: string; result: string }> {
  const want = String(to ?? "").trim();
  if (!want || isDesk(want)) {
    const back = o.deskPack ? await o.deskPack().catch(() => "") : "";
    return {
      name: o.home,
      result: [`SWITCHED: you are the ${o.home} again, over all of ${ownerName()}'s objectives. Say in one line that you are back as the ${o.home}; everything said on this call stays.`, back].filter(Boolean).join("\n\n"),
    };
  }
  const cards = await o.cards();
  const card = pickObjective(cards, want);
  if (!card) {
    const list = cards.map((c, i) => `${i + 1}. ${c.name}`).join("; ");
    return { name: "", result: `NOT SWITCHED: no objective matches "${want.slice(0, 80)}". His objectives: ${list || "none could be read"}. Ask him which one, in one short question.` };
  }
  // a merged objective's name carries "(with: …)": his screen names the objective alone.
  const name = o.objectiveName(card.name.replace(/\s*\(with:.*$/, "").trim() || card.name);
  const pack = await o.pack(card).catch(() => "");
  return {
    name,
    objective: card.name,
    result: [
      `SWITCHED: you are now the ${name}, the manager of "${card.name}", on this same call. Speak as the ${name} from now on (say so in one line if you have not), and answer from this package only, exactly: never round or guess a number. switch_to "desk" brings back the ${o.home}.`,
      pack || "Its package could not be read right now: say so once, and offer to pass his question to the Team desk.",
    ].join("\n\n"),
  };
}
