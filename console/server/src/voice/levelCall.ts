import { ownerName, socialProduct } from "../identity.js";
import type { InboxCard, ObjectiveCard } from "./inbox.js";

/**
 * A Call at each level (the owner, 26 Nov, on a long walk: "a Call button at each level (product desk, each campaign or
 * objective) with the right context"). Three levels, one call engine (mountOwnCall / mountCalls, ElevenLabs on the grant):
 *
 *   product desk ──▶ the senior partner, an OKR expert: the product's objectives, every key result, where we are, his words, open asks
 *   objective    ──▶ its own briefer: that objective's key results, where we are, his newest words, its open asks
 *   campaign     ──▶ its own briefer: the campaign's plan and key results, where we are (its spine), what waits on him
 *
 * This file only writes what each call knows and how it talks; the routes, caps, owner-only rule and relays are the
 * existing ones (voice/routes.ts, app.ts).
 */

export type LevelCard = Omit<ObjectiveCard, "keyResults"> & { keyResults: (ObjectiveCard["keyResults"][number] & { tickets?: string[] })[] };

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, max: number) => {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** a spine's Current State lines a call needs (Status, Next action, Waiting on) and its open `## Waiting on` asks. */
export function spineState(spine: string | undefined): { state: string[]; asks: string[] } {
  if (!spine) return { state: [], asks: [] };
  const cur = /^## Current State\n([\s\S]*?)(?=^## )/m.exec(spine)?.[1] ?? "";
  const state = cur
    .split("\n")
    .filter((l) => /^(Status|Next action|Waiting on|Result):/.test(l))
    .map((l) => clip(flat(l), 600));
  const wait = /^## Waiting on\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(spine)?.[1] ?? "";
  const asks = wait
    .split("\n")
    .filter((l) => /^- \[ask /.test(l))
    .map((l) => clip(flat(l.replace(/^- \[ask [^\]]*\]\s*/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")), 320));
  return { state, asks };
}

/** the open asks and review cards of his inbox that belong to these objectives (their key results' open tickets). */
export function asksOf(cards: LevelCard[], inbox: InboxCard[]): string[] {
  const rows = new Set(cards.flatMap((c) => c.keyResults.flatMap((k) => k.tickets ?? [])));
  if (!rows.size) return [];
  const hit = (c: InboxCard) => {
    if (c.code && rows.has(c.code)) return true;
    const text = `${c.title} ${c.question ?? ""} ${c.decision ?? ""}`;
    return [...rows].some((r) => text.includes(r));
  };
  return inbox.filter(hit).slice(0, 8).map((c) => `${c.kind === "review" ? "Card to review" : "Question"}: ${clip(flat(c.title), 200)}${c.recommend ? `; the team recommends: ${clip(flat(c.recommend), 160)}` : ""}`);
}

/** one objective, whole: light, every key result with today's number and target, where we are, his newest words in force. */
function objectiveBlock(c: LevelCard, where: string | undefined): string[] {
  const out = [`### ${c.name}: ${c.light}, ${c.krs}. ${c.stands}.`];
  for (const k of c.keyResults.slice(0, 14))
    out.push(`- ${clip(flat(k.label), 160)} (${k.state ?? "no light"}): ${k.value ? `now ${clip(flat(k.value), 80)}` : "no number yet"}${k.target ? `, target ${clip(flat(k.target), 60)}` : ""}${k.tickets?.length ? `; being worked: ${k.tickets.length} open ticket${k.tickets.length === 1 ? "" : "s"}` : "; nothing open moves it"}`);
  out.push(c.words ? `His newest words in force${c.said ? ` (${c.said.slice(0, 10)})` : ""}: "${clip(flat(c.words), 500)}"` : "His newest words: none recorded on it yet.");
  out.push(where ? `Where we are (its Context chapter): ${clip(flat(where), 1200)}` : "Where we are: not written yet (say so if he asks).");
  return out;
}

/** What a level's call knows at its start: the level, its objectives' key results, where we are, his words, the plan, open asks. */
export function levelKnows(o: { level: "desk" | "objective" | "campaign"; name: string; objectives: { card: LevelCard; where?: string }[]; asks: string[]; state?: string[]; plan?: string }): string {
  const out = [`# This call's level: the ${o.level === "desk" ? "product desk" : o.level} "${o.name}" (read only, as of the call's start)`];
  if (o.state?.length) out.push("", "## Where it stands now (its spine)", ...o.state.map((l) => `- ${l}`));
  out.push("", `## Key results today (${o.objectives.length} objective${o.objectives.length === 1 ? "" : "s"}, his order)`);
  if (!o.objectives.length) out.push("No objective could be read for this call: say so once if he asks about key results.");
  for (const x of o.objectives) out.push(...objectiveBlock(x.card, x.where));
  if (o.plan?.trim()) out.push("", clip(o.plan.trim(), 3500));
  out.push("", `## Open asks and cards waiting on ${ownerName()} here (${o.asks.length})`);
  out.push(...(o.asks.length ? o.asks.map((a) => `- ${a}`) : ["None waits on him at this level right now."]));
  return out.join("\n");
}

/** the OKR partner's rule, added to a product desk call (the senior partner) and to every objective or campaign call. */
export function partnerRule(level: "desk" | "objective" | "campaign", name: string): string {
  const scope = level === "desk" ? `the ${name} desk, across every objective of the product` : `this ${level}, "${name}"`;
  return [
    `You are also ${ownerName()}'s senior partner and OKR expert for ${scope}. Think in objectives and key results: which key result is red and nothing moves it, which number moved, what the one next step is that turns the next one green.`,
    "When he asks where we are, answer in this order, one part at a time: the key results (red first, today's number against its target), where we are, then what waits on him. Push back when a plan does not move a key result, and say which one it would move instead.",
    "Never invent a number or a key result: only what this call knows. A new key result he wants is a note you pass on, never one you add.",
  ].join("\n");
}

/** the objective briefer's own instructions: one objective, his partner on it. */
export function objectiveCallInstructions(name: string): string {
  return [
    `You are the ${levelName(name)}, ${ownerName()}'s manager for one objective, "${name}", on a phone call with him, often while he walks. That is your one name (he sees it on the call screen): never call yourself a briefer or a strategist. Above you is his Team desk partner, who covers all his objectives: when he wants another objective, say that the Team desk partner (Partner in his Team desk chat) or that objective's own Call covers it. You know that objective's key results with today's numbers, where we are, his newest words on it and what waits on him, below.`,
    `When the line opens, the console has you say this greeting, once: "${objectiveGreeting(name)}" Never greet again.`,
    partnerRule("objective", name),
    "Ask one question at a time and let him talk. Say back in one sentence what you heard before the next question. Never lecture, never list more than three things, never read codes, links or long numbers.",
    `Notes: each thing he decides or wants done is one note. Say back in one line what you will pass, and on his yes call relay_to_desk: desk "team" for building, plans and key results; desk "social" for ${socialProduct()}'s campaigns, posts and channels. One note, one call, his own words. If a pass does not go through, say so once.`,
    "Speak in his language (English or Spanish). Short turns: one to three sentences. Warm, direct and sharp. He always has priority: never talk over him.",
    "Ending: when he clearly says he is done ('bye', 'that's all', 'hang up', 'adiós'), give a one-line recap of what you passed on, say goodbye and call hang_up. The whole call is saved to his Team desk chat when it ends.",
  ].join("\n");
}

/** the name of who answers a level's call (objective or campaign), the same words as the web's whoAnswers.ts. */
export const levelName = (name: string) => `${clip(flat(name).replace(/^[^:]{1,30}:\s*/, ""), 80) || name} manager`;
export const objectiveGreeting = (name: string) => `Hi ${ownerName()}, the ${levelName(name)} here. Key results first, or straight to what is red?`;
/** a campaign's call greets by its name (any world's owner, so no name of his): the greeting after `lead` (voice.ts GREETING_LEAD) is replaced, the rest kept. */
export function campaignGreeting(instructions: string, title: string, lead: string): string {
  const i = instructions.indexOf(lead);
  if (i < 0) return instructions;
  const at = i + lead.length;
  return instructions.slice(0, at) + instructions.slice(at).replace(/^(\s*)"[^"]+"/, `$1"Hi, the ${levelName(title)} here. How can I help?"`);
}
export const objectiveCallHead = (name: string) => `📞 From the ${clip(name, 80)} call`;

/** the Team desk's message for one note of an objective call: his words first, the objective named. */
export function objectiveNoteText(callId: string, name: string, r: { words: string; note: string }, forSocial = false): string {
  return [
    `${objectiveCallHead(name)} (${callId})`,
    `${ownerName()}'s words: "${r.words}"`,
    ...(r.note ? [`Briefer note: ${r.note}`] : []),
    forSocial ? `For the ${socialProduct()} desk: pass only his words there (no desk across on this console). File it as one request row of his.` : "File it as one request row of his, like a chat line of his.",
  ].join("\n");
}
