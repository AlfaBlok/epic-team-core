import { ownerName } from "../identity.js";
import type { InboxCard, ObjectiveCard } from "./inbox.js";
import { OBJECTIVE_TOOLS } from "./voice.js";

/**
 * The briefing call, now his objectives review (the owner's note vn_832a5307, 27 Nov 12:20Z: "I'm ready to have a call
 * about objectives ... and if we can have, like, briefings about what's happening ... set up the goals and then start
 * reviewing them. And I'm just a manager reviewing a team trying to make their goals"). It was the desk's news since his
 * last briefing (25 Nov, vn "the briefing guy"); one call, never a second one: the same link (/briefing), the same
 * ElevenLabs agent, the same "since his last briefing" mark, now walking his objectives:
 *
 *   /briefing ──▶ console: his objectives in his order (GET /api/objectives) ──▶ ElevenLabs, on the grant
 *                  each: red key results with today's numbers, what moved since the last briefing, what waits on him
 *                          │ file_objective_words (his decision on that objective: his words file + its epic's Decisions)
 *                          │ relay_to_desk (something to do: one request on the Team desk, the objective named)
 *                          └ lookups (exact facts: tester mails, posts a day, replies and DMs, site views)
 *
 * Objectives that moved or turned red since the last briefing come first; the first review walks them all in his order.
 * The daily briefing invite (scripts/briefings.py morning, 06:00 his time) links here.
 */

export const BRIEFING_AGENT_NAME = "EpicTeam briefing call";
export const BRIEFING_PAGE = "briefing call";
export const BRIEFING_HEAD = "📞 From the objectives review call";
export const BRIEFING_GREETING = () => `Hi ${ownerName()}, your Team desk manager here, for your objectives review. I'll go objective by objective, red first. Ready?`;
/** with no briefing before, "what moved" starts this far back. */
export const BRIEFING_FIRST_HOURS = 24;
/** never further back than this, however long since the last briefing. */
export const BRIEFING_MAX_DAYS = 7;
/** a call this short (he hung up at once) does not move the "since your last briefing" mark. */
export const BRIEFING_MIN_S = 60;
const CAP = { shipped: 12, waiting: 8 };

export const BRIEFING_TOOLS = [
  ...OBJECTIVE_TOOLS,
  {
    type: "function",
    name: "relay_to_desk",
    description: `Pass one thing ${ownerName()} wants done to the Team desk, as one request it files and plans with, like a chat line of his. desk is always "team". Call it once per note, after you said back in one line what you will pass and he agreed. The objective he is on is named on it by the console.`,
    parameters: {
      type: "object",
      properties: {
        desk: { type: "string", description: `Always "team".` },
        words: { type: "string", description: "His words, as he said them, never your summary." },
        note: { type: "string", description: "Your one-line note: what he wants done, on which key result." },
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

export interface ShippedLine {
  at: string;
  kind: string;
  text: string;
  product?: string;
}

/** where his last briefing left off: the start of the last briefing call, else a day back; never more than a week. */
export function briefingSince(lastAt: string | undefined, now: number): string {
  const floor = now - BRIEFING_MAX_DAYS * 24 * 3_600_000;
  const t = lastAt ? Date.parse(lastAt) : NaN;
  const from = Number.isFinite(t) ? Math.max(t, floor) : now - BRIEFING_FIRST_HOURS * 3_600_000;
  return new Date(from).toISOString();
}

const one = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const SHIPPED = new Set(["delivered", "released", "fixed", "merged"]);

/** what he saw at the last briefing: each objective's light and each key result's light and number. */
export interface ReviewSnapshot {
  at: string;
  objectives: Record<string, { light: string; krs: Record<string, { state?: string; value?: string }> }>;
}

export function snapshotOf(cards: ObjectiveCard[], at: string): ReviewSnapshot {
  return {
    at,
    objectives: Object.fromEntries(cards.map((c) => [c.id, { light: c.light, krs: Object.fromEntries(c.keyResults.map((k) => [k.label, { ...(k.state ? { state: k.state } : {}), ...(k.value ? { value: k.value } : {}) }])) }])),
  };
}

/** what changed on one objective since the snapshot: key results turned red or green, numbers that moved, a new one. */
export function changesOf(card: ObjectiveCard, before: ReviewSnapshot["objectives"][string] | undefined): string[] {
  if (!before) return ["new since the last briefing"];
  const out: string[] = [];
  for (const k of card.keyResults) {
    const b = before.krs[k.label];
    const label = one(k.label, 90);
    if (!b) {
      out.push(`new key result: ${label}`);
      continue;
    }
    if (k.state === "red" && b.state !== "red") out.push(`turned red: ${label}${k.value ? ` (now ${one(k.value, 50)})` : ""}`);
    else if (k.state === "green" && b.state !== "green") out.push(`turned green: ${label}${k.value ? ` (now ${one(k.value, 50)})` : ""}`);
    else if ((k.value ?? "") !== (b.value ?? "") && k.value) out.push(`moved: ${label}, ${b.value ? `${one(b.value, 40)} → ` : "now "}${one(k.value, 50)}`);
  }
  return out;
}

/**
 * His objectives as the review walks them: in his order, those that moved or turned red since the last briefing first
 * (with no briefing before: every one, in his order); each one's red key results first, and where it stands said as
 * what moved since the last briefing and today, then what waits on him there.
 */
export function reviewCards(cards: ObjectiveCard[], o: { last?: ReviewSnapshot; waits: (c: ObjectiveCard) => string[] }): { cards: ObjectiveCard[]; changed: number; first: boolean } {
  const first = !o.last;
  const RANK: Record<string, number> = { red: 0, amber: 1 };
  const shaped = cards.map((c) => {
    const changes = first ? [] : changesOf(c, o.last!.objectives[c.id]);
    const waits = o.waits(c);
    const keyResults = [...c.keyResults].sort((a, b) => (RANK[a.state ?? ""] ?? 2) - (RANK[b.state ?? ""] ?? 2));
    const since = first ? "" : changes.length ? ` Since the last briefing (${o.last!.at.slice(0, 16).replace("T", " ")}Z): ${changes.slice(0, 6).join("; ")}.` : " Nothing changed since the last briefing.";
    const wait = waits.length ? ` Waits on ${ownerName()} here: ${waits.slice(0, 3).join(" | ")}.` : ` Nothing waits on ${ownerName()} here.`;
    return { card: { ...c, keyResults, stands: `${c.stands}.${since}${wait}` }, moved: first || changes.length > 0 };
  });
  const moved = shaped.filter((s) => s.moved).map((s) => s.card);
  const rest = shaped.filter((s) => !s.moved).map((s) => s.card);
  return { cards: [...moved, ...rest], changed: moved.length, first };
}

/** the agenda the call opens with: how many objectives, which moved, the one-line state of each, then what shipped. */
export function briefingKnows(o: { since: string; now: number; cards: ObjectiveCard[]; changed: number; first: boolean; shipped: ShippedLine[]; waiting: InboxCard[] }): string {
  const hours = Math.max(1, Math.round((o.now - Date.parse(o.since)) / 3_600_000));
  const out = [
    o.first
      ? `# His objectives review: the first one, so walk all ${o.cards.length} objectives in his order`
      : `# His objectives review: ${o.changed} of ${o.cards.length} objectives moved or turned red since the last briefing (${o.since.slice(0, 16).replace("T", " ")}Z, ${hours} hours ago): walk those ${o.changed} first, in his order; then say the other ${o.cards.length - o.changed} did not change and walk them only if he asks`,
    "## The agenda (the order next_objective walks)",
  ];
  o.cards.forEach((c, i) => {
    const red = c.keyResults.filter((k) => k.state === "red");
    out.push(`${i + 1}. ${c.name}: ${c.light}, ${c.krs}${red.length ? `; red: ${red.slice(0, 3).map((k) => `${one(k.label, 70)}${k.value ? ` (now ${one(k.value, 30)}${k.target ? `, target ${one(k.target, 30)}` : ""})` : ""}`).join("; ")}` : ""}${!o.first && i === o.changed - 1 ? "  ← the last one that moved" : ""}`);
  });
  const shipped = o.shipped.filter((s) => SHIPPED.has(s.kind) && s.at >= o.since).sort((a, b) => (a.at < b.at ? 1 : -1));
  out.push("", `## What shipped since ${o.since.slice(0, 16).replace("T", " ")}Z (${shipped.length}): use it when he asks what the team did`);
  if (!shipped.length) out.push("Nothing shipped in this window: say so plainly if he asks.");
  shipped.slice(0, CAP.shipped).forEach((s) => out.push(`- ${s.product ? `${s.product}: ` : ""}${one(s.text, 180)}`));
  if (shipped.length > CAP.shipped) out.push(`- and ${shipped.length - CAP.shipped} more, smaller`);
  const reviews = o.waiting.filter((c) => c.kind === "review");
  const asks = o.waiting.filter((c) => c.kind === "ask");
  out.push(`## Everything waiting on his inbox (${reviews.length} cards to review, ${asks.length} questions)`);
  [...reviews, ...asks].slice(0, CAP.waiting).forEach((c) => out.push(`- ${c.kind === "review" ? "Card" : "Question"}: ${one(c.title, 140)}${c.where ? ` (${one(c.where, 60)})` : ""}`));
  if (reviews.length + asks.length > CAP.waiting) out.push(`- and ${reviews.length + asks.length - CAP.waiting} more on his inbox`);
  return out.join("\n");
}

/** how the review walks: the objectives tools, one at a time, his decisions filed on each (replaces the default walk rule). */
export function briefingWalkRule(total: number): string {
  return [
    `# The walk: ${total} objectives, one at a time`,
    "Start with next_objective as soon as he says yes or ready, and keep the order the console gives (the agenda above). For each objective say, in three or four short sentences: its place and name, its light and how many key results are green; the red key results with their exact number against the target ('Testers: 2 of 5'); what moved since the last briefing or today; and what waits on him there. Then ask: 'Anything for the team on this one?' and stop. He may be walking: wait for his answer; if he stays silent a few seconds, check once that he is still with you (his call_dab66f00: speak up quickly when he goes quiet).",
    "Numbers: say each one exactly as the objective gives it, never rounded, never guessed. If he asks for a fact the objective does not hold (when a tester mail went, posts a day, replies, DMs, site views), call the matching lookup and say its answer exactly; with no source, say there is none.",
    `His decisions: when he decides something on an objective ('push the second tester this week', 'drop that key result'), say it back in one line ("I'll file on Testers: push the second tester this week. File it?") and on his yes call file_objective_words with his words as he said them and confirmed=true. It lands on that objective, where its manager reads it on the next wake. Something he wants done goes to the Team desk with relay_to_desk too. Then next_objective.`,
    "When the walk reaches the end, say so in one line, say how many decisions you filed, and ask if there is anything else.",
  ].join("\n");
}

export function briefingInstructions(): string {
  const name = ownerName();
  return [
    `You are ${name}'s Team desk manager: the senior-most person on his team, above each objective's manager, owning all his objectives and scorecards. Introduce yourself by that name if he asks who you are. You brief ${name} on his objectives, on a phone call with him. He is a manager reviewing a team that is trying to reach its goals: he wants each objective's real state, short, and to give his decisions. You report and take his decisions; you do not argue for work he did not ask for, and you never change, press or approve anything yourself.`,
    `When the line opens, the console has you say this greeting, once: "${BRIEFING_GREETING()}" Never greet again.`,
    "Speak in his language (English or Spanish). Short turns: one to four sentences. Calm, factual and sharp. Never read codes, links or ids. He always has priority: never talk over him; when he jumps to another objective, read_objective that one.",
    "Ending: when he clearly says he is done ('bye', 'that's all', 'hang up', 'adiós'), say how many decisions you filed and notes you passed, say goodbye and call hang_up. The whole call is saved to his Team desk chat when it ends.",
  ].join("\n");
}

/** the Team desk's message for one note: his words first, the objective he was on, filed as one request. */
export function briefingNoteText(callId: string, r: { words: string; note: string; objective?: string }): string {
  return [
    `${BRIEFING_HEAD} (${callId})${r.objective ? ` · objective: ${r.objective}` : ""}`,
    `${ownerName()}'s words: "${r.words}"`,
    ...(r.note ? [`Briefing note: ${r.note}`] : []),
    `File it as one request row of his, like a chat line of his${r.objective ? `, under the objective ${r.objective}` : ""}.`,
  ].join("\n");
}
