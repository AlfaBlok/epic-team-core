import { ownerName } from "../identity.js";
import type { InboxCard } from "./inbox.js";

/**
 * The briefing call (the owner's voice note 25 Nov 13:48Z, Log/2026-11-25.md#^e-5d6f8d: "a phone call with a guy that is
 * briefed ... what did we do yesterday? ... He's like the briefing guy"). One web link he opens on his phone (/briefing)
 * starts a call with its own ElevenLabs agent, on the same call path as the objectives coach (voice/coach.ts):
 *
 *   /briefing ──▶ console: the desk's news since his last briefing (what shipped, what waits on him) ──▶ ElevenLabs
 *                          │ relay_to_desk (his words, one note at a time)
 *                          └──▶ Team desk chat: one request per note, like a chat line of his
 *
 * The briefing guy tells, he does not decide: no advice, no press on a card, no change to anything. His notes go to the
 * Team desk as he said them, so the desk plans the day with them.
 */

export const BRIEFING_AGENT_NAME = "EpicTeam briefing call";
export const BRIEFING_PAGE = "briefing call";
export const BRIEFING_HEAD = "📞 From the briefing call";
export const BRIEFING_GREETING = () => `Hi ${ownerName()}, your briefing. Ready for what happened?`;
/** with no briefing before, the news starts this far back ("what did we do yesterday"). */
export const BRIEFING_FIRST_HOURS = 24;
/** never further back than this, however long since the last briefing. */
export const BRIEFING_MAX_DAYS = 7;
const CAP = { shipped: 12, waiting: 8 };

export const BRIEFING_TOOLS = [
  {
    type: "function",
    name: "relay_to_desk",
    description: `Pass one note of ${ownerName()}'s to the Team desk, as one request it files and plans the day with, like a chat line of his. desk is always "team". Call it once per note, after you said back in one line what you will pass and he agreed.`,
    parameters: {
      type: "object",
      properties: {
        desk: { type: "string", description: `Always "team".` },
        words: { type: "string", description: "His words, as he said them, never your summary." },
        note: { type: "string", description: "Your one-line note: which item of the briefing it is about, when it is about one." },
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

/** what the briefing guy knows at the call's start: what shipped since `since`, then what waits on him. */
export function briefingKnows(o: { since: string; now: number; shipped: ShippedLine[]; waiting: InboxCard[] }): string {
  const hours = Math.max(1, Math.round((o.now - Date.parse(o.since)) / 3_600_000));
  const shipped = o.shipped.filter((s) => SHIPPED.has(s.kind) && s.at >= o.since).sort((a, b) => (a.at < b.at ? 1 : -1));
  const reviews = o.waiting.filter((c) => c.kind === "review");
  const asks = o.waiting.filter((c) => c.kind === "ask");
  const out = [`# The briefing: the desk's news of the last ${hours} hours (since ${o.since.slice(0, 16)}Z), newest first`];
  out.push(`## What shipped (${shipped.length})`);
  if (!shipped.length) out.push("Nothing shipped in this window: say so plainly.");
  shipped.slice(0, CAP.shipped).forEach((s) => out.push(`- ${s.product ? `${s.product}: ` : ""}${one(s.text, 180)}`));
  if (shipped.length > CAP.shipped) out.push(`- and ${shipped.length - CAP.shipped} more, smaller`);
  out.push(`## What waits on him (${reviews.length} cards to review, ${asks.length} questions)`);
  [...reviews, ...asks].slice(0, CAP.waiting).forEach((c) => out.push(`- ${c.kind === "review" ? "Card" : "Question"}: ${one(c.title, 140)}${c.where ? ` (${one(c.where, 60)})` : ""}`));
  if (reviews.length + asks.length > CAP.waiting) out.push(`- and ${reviews.length + asks.length - CAP.waiting} more on his inbox`);
  return out.join("\n");
}

export function briefingInstructions(): string {
  const name = ownerName();
  return [
    `You are ${name}'s briefing guy, on a phone call with him. You know the briefing below inside out. Your job: tell him what happened, then take his notes. You do not help him decide, you do not advise, and you never change, press or approve anything.`,
    `When the line opens, the console has you say this greeting, once: "${BRIEFING_GREETING()}" Never greet again.`,
    "The briefing, when he says yes: first what shipped, the few biggest in plain words, grouped by product, one or two sentences each; then what waits on him, as a count and the two or three that matter most. Under a minute in all. Never read codes, links, dates or long numbers. Then ask: 'Any notes for the team?'",
    "When he asks about an item, answer only from the briefing below; if it is not there, say you do not know and offer to pass the question on as a note.",
    `Notes: each thing he wants the team to do, know or answer is one note. Say back in one line what you will pass, and on his yes call relay_to_desk with desk "team" and his own words. One note, one call. The desk files each as one request and plans the day with it. If a pass does not go through, say so once and never promise to pass it later.`,
    "Speak in his language (English or Spanish). Short turns: one or two sentences. Calm and factual, never chatty. He always has priority: never talk over him.",
    "Ending: when he clearly says he is done ('bye', 'that's all', 'hang up', 'adiós'), say how many notes you passed, say goodbye and call hang_up. The whole call is saved to his Team desk chat when it ends.",
  ].join("\n");
}

/** the Team desk's message for one note: his words first, the briefing guy's note after, filed as one request. */
export function briefingNoteText(callId: string, r: { words: string; note: string }): string {
  return [`${BRIEFING_HEAD} (${callId})`, `${ownerName()}'s words: "${r.words}"`, ...(r.note ? [`Briefing note: ${r.note}`] : []), "File it as one request row of his, like a chat line of his."].join("\n");
}
