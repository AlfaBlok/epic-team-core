import { ownerName } from "../identity.js";
import { isYesNoQuestion } from "../inbox/decideChoices.js";
import { choiceDefaults } from "../review/cardKind.js";

/**
 * (his pick "Walk the inbox by voice"): the call knows his inbox. When a Team
 * desk call starts, his inbox (review cards, open asks, goals to set and the team's ideas, in the order his inbox shows
 * them) and his objectives are loaded into the call, and the voice walks the cards with tools of its own (`next_card`,
 * `read_card`), the console keeping which card he is on. On his spoken yes, read back once, the voice presses his own
 * button on the card he is on (`press_card`, every card it walks: the console checks his yes and the button, the page
 * presses it through the card's own route, L-46). His objectives are walked one by one the same way
 * (`next_objective`, `read_objective`), and what he says about one is filed on it (`file_objective_words`, the
 * briefing's own route POST /api/briefing/answer).
 */

/** One inbox card as the call holds it (a snapshot taken when the call starts, so the walk never shifts under him). */
export interface InboxCard {
  /** `review` = a card waiting for his review; `ask` = a question waiting on his answer; `goal` = a goal to set; `team` = an idea or digest from the team. */
  kind: "review" | "ask" | "goal" | "team";
  /** The review item's or the waiting item's id (the id its own buttons use). */
  id: string;
  /** The row or ask code (relayed to the desk so it knows which card he means; never said aloud). */
  code?: string;
  title: string;
  /** The milestone or epic it sits in. */
  where?: string;
  /** Where it came from (his words, or who raised it). */
  source?: string;
  goal?: string;
  /** ✓ / ✗ lines: what was delivered and what was not. */
  delivered?: string[];
  /** The live thing he can open. */
  evidence?: string;
  /** The one decision asked of him, with the team's recommendation. */
  decision?: string;
  /** The card's own buttons (`<answer>: <what happens next>`), when it has them. */
  options?: string[];
  /** For an ask: the question, its options and the team's recommendation. */
  question?: string;
  recommend?: string;
  /**
   * the buttons the voice may press for him on this card (a call started from an inbox section), each his own
   * button on the card; a button ending in "…" takes his words (Changes wanted, Answer in words). None: the desk answers.
   */
  buttons?: string[];
  /** an ask's milestone (its answer route needs it). */
  milestoneId?: string;
  /** the card's evidence, shown on his screen while the voice is on it. */
  link?: { label: string; url: string };
}

/** the button labels the page's card builders use (web voice/SectionCall.tsx): the voice says and presses these. */
export const MARK_COMPLETE = "Mark complete";
export const CHANGES_WANTED = "Changes wanted…";
export const ANSWER_IN_WORDS = "Answer in words…";
export const ASK_YES = "Yes: go ahead";
export const ASK_NO = "No: drop it";
const FEEDBACK_OPTION = /^[^:]*:\s*(?:say|tell|change|give|write|send)\b|^(?:change it|not quite|tell us)\b/i;

/**
 * a review card's buttons as the page's reviewCard makes them: a decision's own choices (or Yes: plan it / No: park it
 * for a "Do we …?" decision) then Changes wanted; any other card Mark complete and Changes wanted. The page checks
 * again against the card it reads fresh, so a label that drifted is refused, never pressed wrong.
 */
export function reviewButtons(face: { decision?: string; options?: string[] } | undefined | null): string[] {
  const own = (face?.options ?? []).filter((o) => /^[^:]{1,30}:\s*\S/.test(o));
  const decision = (face?.decision ?? "").trim();
  if (own.length >= 2 && own.filter((o) => !FEEDBACK_OPTION.test(o.trim())).length >= 2) return [...own.slice(0, 4), CHANGES_WANTED];
  const defaults = own.length < 2 ? choiceDefaults(decision) : undefined;
  if (defaults) return [...defaults, CHANGES_WANTED];
  return [MARK_COMPLETE, CHANGES_WANTED];
}

/** E948-S200: Yes and No on an ask whose own question is a yes or no (not an approve ask): his answer is the word. */
export const ANSWER_YES = "Yes";
export const ANSWER_NO = "No";

/**
 * an ask's buttons: Yes / No on an approve ask, and his answer in words on every ask. E948-S200 (the owner, closing
 * E948-S109: a yes-or-no card's buttons say Yes and No, not Answer): any other ask whose question is a yes or no gets Yes
 * and No too, never only Answer in words.
 */
export function askButtons(ask: string | undefined, question?: string): string[] {
  if (ask === "approve") return [ASK_YES, ASK_NO, ANSWER_IN_WORDS];
  if (ask !== "provide" && ask !== "do" && isYesNoQuestion(question)) return [ANSWER_YES, ANSWER_NO, ANSWER_IN_WORDS];
  return [ANSWER_IN_WORDS];
}

/** a goal option's label, as the page's teamCard makes it. */
export const goalLabel = (g: { goal: string; number?: string }) => `${g.goal}${g.number ? ` (${g.number})` : ""}`.slice(0, 110);

/** a call started from one inbox section (its phone button): the section's name and its cards, as he sees them. */
export interface InboxFocus {
  section: string;
  cards: InboxCard[];
}

/** At most this many cards ride in the call's instructions (each turn re-reads them); the tools still reach every card. */
export const INBOX_PACK_MAX = 30;
/** At most this many cards are held for the walk. */
export const INBOX_WALK_MAX = 200;

export const INBOX_TOOL_NAMES = ["next_card", "read_card", "press_card"] as const;
export type InboxToolName = (typeof INBOX_TOOL_NAMES)[number];
export const isInboxTool = (n: string): n is InboxToolName => (INBOX_TOOL_NAMES as readonly string[]).includes(n);

const one = (s: string | undefined, max = 220) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
/** Markdown links read as their words. */
const words = (s: string | undefined, max?: number) => one((s ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]/g, ""), max);

const KIND_WORD: Record<InboxCard["kind"], string> = { review: "Review", ask: "Question", goal: "Goal to set", team: "From the team" };

/** The card's one line in the pack: its place, what it is, what it asks. */
export function cardLine(c: InboxCard, n: number): string {
  const asks = c.kind === "ask" || c.kind === "goal" ? words(c.question || c.title, 160) : words(c.decision, 140);
  return `${n}. ${KIND_WORD[c.kind] ?? "Review"}${c.code ? ` [${c.code}]` : ""}: ${words(c.title, 120)}${asks && asks !== words(c.title, 120) ? ` | asks: ${asks}` : ""}`;
}

/** The card in full, as `read_card` gives it to the voice to say in its own short words. */
export function cardText(c: InboxCard): string {
  const lead = { ask: `A question waiting on ${ownerName()}`, goal: `A goal for ${ownerName()} to set`, team: `An idea or digest from the team for ${ownerName()}`, review: `A card waiting for ${ownerName()}'s review` }[c.kind] ?? `A card for ${ownerName()}`;
  const out: string[] = [`${lead}${c.code ? ` (${c.code}, never say the code)` : ""}: ${words(c.title, 300)}`];
  if (c.where) out.push(`In: ${words(c.where, 120)}`);
  if (c.source) out.push(`Where it came from: ${words(c.source, 300)}`);
  if (c.goal) out.push(`Goal: ${words(c.goal, 200)}`);
  for (const d of c.delivered ?? []) out.push(`${d.trim().startsWith("✗") ? "Not delivered" : "Delivered"}: ${words(d.replace(/^\s*[✓✗]\s*/, ""), 200)}`);
  if (c.evidence) out.push(`What he can open: ${words(c.evidence, 160)}`);
  if (c.question) out.push(`The question: ${words(c.question, 400)}`);
  if (c.recommend) out.push(`The team recommends: ${words(c.recommend, 200)}`);
  if (c.decision) out.push(`What it asks him: ${words(c.decision, 300)}`);
  if (c.options?.length) out.push(`His buttons on it: ${c.options.map((o) => words(o, 80)).join(" · ")}`);
  else if (c.kind === "review") out.push("His buttons on it: Mark complete · Changes wanted");
  if (c.buttons) out.push(c.buttons.length ? `Buttons you may press for him on his spoken yes (press_card; he sees them, never read them out): ${c.buttons.join(" · ")}` : "You cannot press a button on this one: his answer goes to the desk (ask_the_desk).");
  return out.join("\n");
}

/**
 * how the voice presses his button (every card it walks; his words on the card, 18 Nov, call_c83e51e8:
 * "I'm literally on a call right now and I'm asking you to press buttons, and you seem to be doing it, so it's not clear
 * to me what is the additional"): read back once, press on his yes, then say plainly that it landed. The choices are on
 * his screen: never read the list of buttons aloud.
 */
export function pressRule(): string {
  return [
    `Pressing his buttons (press_card): you can press his own buttons on the card he is on, the ones the card lists as yours to press. The choices are on his screen: never read the list of buttons aloud; say the team's recommendation when there is one and ask what he wants.`,
    `Before you press, say back in one line what you will press on which card ("Mark the voice call card complete?") and press only after his spoken yes; then call press_card with that button (his words for a button ending in "…") and confirmed=true. Say "pressed, it landed" only when the result shows its commit (landed <commit>); when it says still saving, say "Pressed, it's still saving. I'll tell you when it lands." and nothing about landing; if it did not go through, say so in one line. His plain yes on a card, even in a line that also asks for something else ("My answer is yes, but pass this on"), is his yes to the card: press it and pass the rest to the desk. Never say a press is not possible yet, never press on a maybe, never on your own idea, never twice.`,
    `A card with no button for you, a change he wants, or anything else he asks goes to the desk with ask_the_desk, naming the card's code from the list.`,
  ].join("\n");
}

/** The rule block for the inbox walk (only on a call that has his inbox). */
export function inboxRule(): string {
  const who = ownerName();
  return [
    `# ${who}'s inbox on this call`,
    `${who}'s inbox (cards waiting for his review, questions waiting on his answer, goals to set and the team's ideas) is listed below in his inbox's order, as of the call's start, and his objectives after it. Answer 'what's in my inbox', 'how many cards', 'what's first' from the list at once, with no tool call.`,
    `When he wants to go through his inbox ('let's do my inbox', 'next', 'next card', 'go on', 'skip it'), call next_card; when he wants one card in full ('read it', 'what does it say', 'read card three', 'go back'), call read_card (with its number for a given card). The console keeps which card he is on: the tool tells you the card's place ('card 3 of 12'); trust it over your own count.`,
    "Say each card the way a colleague would on the phone: its place, what was made or what is asked, and the one thing it asks him, in two or three short sentences, no codes, no links read out; then stop and let him react. Read the whole card only when he asks.",
    pressRule(),
    "When the walk reaches the end, say so in one line and ask if there is anything else.",
  ].join("\n");
}

/** The pack added to the call's instructions: the rule, the cards (first INBOX_PACK_MAX), his objectives. */
export function inboxPack(cards: InboxCard[], objectives?: string): string {
  const n = (k: InboxCard["kind"]) => cards.filter((c) => c.kind === k).length;
  const parts = [`${n("review")} to review`, `${n("ask")} questions`, ...(n("goal") ? [`${n("goal")} goals to set`] : []), ...(n("team") ? [`${n("team")} from the team`] : [])];
  const head = cards.length ? `His inbox now: ${cards.length} card${cards.length === 1 ? "" : "s"} (${parts.join(", ")}).` : "His inbox is empty right now.";
  const lines = cards.slice(0, INBOX_PACK_MAX).map((c, i) => cardLine(c, i + 1));
  if (cards.length > INBOX_PACK_MAX) lines.push(`… and ${cards.length - INBOX_PACK_MAX} more (next_card and read_card reach them).`);
  const obj = (objectives ?? "").trim();
  return [inboxRule(), "", head, ...lines, ...(obj ? ["", `His objectives, in his order: when he asks about his objectives ('what are my objectives', 'how is <objective> doing'), answer from this list, never from the milestones or the root tree (those are milestones, not objectives):`, obj] : [])].join("\n");
}

/** Where the walk is: `pos` = the card he is on, 1-based (0 = not started). */
export interface WalkStep {
  place: string;
  /** the card's title and evidence, for the call bar on any page (a whole-inbox call has no page cards). */
  title?: string;
  link?: { label: string; url: string };
  /** the card's id, so the page shows that card (its evidence) while the voice talks about it. */
  id?: string;
  pos: number;
  total: number;
  card?: string;
  done?: true;
  note: string;
}

const shown = (c: InboxCard) => ({ title: c.title, ...(c.link?.url ? { link: c.link } : {}) });

/** One tool turn of the walk: the new position and what the voice gets back. Pure (the caller stores `pos`). */
export function walk(cards: InboxCard[], pos: number, name: InboxToolName, args: { number?: unknown } = {}): WalkStep {
  const total = cards.length;
  if (!total) return { place: "no cards", pos: 0, total: 0, done: true, note: "His inbox is empty. Tell him so in one line." };
  if (name === "next_card") {
    const next = pos + 1;
    if (next > total) return { place: `past the last of ${total}`, pos: total, total, done: true, note: `That was the last card (${total} of ${total}). Say so in one line and ask if there is anything else.` };
    return { place: `card ${next} of ${total}`, id: cards[next - 1].id, ...shown(cards[next - 1]), pos: next, total, card: cardText(cards[next - 1]), note: "Say its place, what it is and the one thing it asks him, in two or three short sentences, then stop." };
  }
  const n = Number(args.number);
  const at = Number.isInteger(n) && n !== 0 ? (n < 0 ? Math.max(1, pos + n) : n) : Math.max(1, pos);
  if (at > total) return { place: `there is no card ${at}`, pos, total, note: `There are only ${total} cards. Tell him, and which card he is on${pos ? ` (${pos})` : ""}.` };
  return { place: `card ${at} of ${total}`, id: cards[at - 1].id, ...shown(cards[at - 1]), pos: at, total, card: cardText(cards[at - 1]), note: "This is the whole card: say what he asked for from it, simply, without codes or links." };
}

/** a section call's cards: at most this many (the section he pressed; the console checks them). */
export const FOCUS_MAX = 60;
/** A button that takes his words (Changes wanted…, Answer in words…). */
export const takesWords = (b: string) => /…$|\.\.\.$/.test(b.trim());

/**
 * The rule block of a call started from one inbox section (the owner: a phone button next to a section starts a call that
 * already has those cards, goes one by one to clear the board, answers fast, and hands other work to the desk).
 */
export function focusRule(section: string, total: number): string {
  const who = ownerName();
  return [
    `# This call is about one part of ${who}'s inbox: ${section} (${total} card${total === 1 ? "" : "s"})`,
    `${who} pressed the phone button on "${section}" to clear it with you, one card at a time. The cards are listed below in the order he sees them. You already know them: answer about them at once, with no tool call, and keep every answer short.`,
    `Guide him one by one: when he says go, next, start or yes at the start, call next_card. The page shows that card on his screen with its evidence as you reach it, so he sees what you talk about: say "it's on your screen", then the card in one or two short sentences (what it is and the team's recommendation when there is one). Do not read its choices aloud: he sees them on his screen. Ask him which he wants, and stop (never a yes-or-no question on a card with several choices). When he has answered, offer the next one. read_card gives one card in full when he asks.`,
    pressRule(),
    `Do not do the desk's work on the call: after a hand-off, carry on with the cards.`,
    `When the last card is done, say the section is clear in one line and ask if there is anything else.`,
  ].join("\n");
}

/** The pack of a section call: its rule, its cards (all of them, up to FOCUS_MAX), his objectives. */
export function focusPack(f: InboxFocus, objectives?: string): string {
  const obj = (objectives ?? "").trim();
  return [
    focusRule(f.section, f.cards.length),
    "",
    ...f.cards.map((c, i) => cardLine(c, i + 1)),
    ...(obj ? ["", "His objectives, in his order (what these cards serve; answer from this list when he asks):", obj] : []),
  ].join("\n");
}

/** The voice's first words on a section call: the section, how many, and the offer to start. */
export function focusGreeting(f: InboxFocus): string {
  const n = f.cards.length;
  const what = f.section.replace(/["“”]/g, "");
  return n ? `${what}: ${n} card${n === 1 ? "" : "s"}. Shall we go through them one by one?` : `${what} is clear: nothing waits there. Anything else?`;
}

/** What the voice gets back from press_card: the press for the page to make, or why not. Pure (the page presses). */
export interface PressStep {
  place: string;
  id?: string;
  pos: number;
  total: number;
  press?: { id: string; kind: InboxCard["kind"]; button: string; words?: string; title: string; milestoneId?: string };
  note: string;
}

export function pressStep(cards: InboxCard[], pos: number, args: { number?: unknown; button?: unknown; words?: unknown; confirmed?: unknown }): PressStep {
  const total = cards.length;
  const n = Number(args.number);
  const at = Number.isInteger(n) && n > 0 ? n : pos;
  const card = at >= 1 && at <= total ? cards[at - 1] : undefined;
  if (!card) return { place: "no card", pos, total, note: "No card is open. Say which card, or call next_card first." };
  const place = `card ${at} of ${total}`;
  const id = card.id;
  if (args.confirmed !== true) return { place, id, pos: at, total, note: "Not pressed: say back what you will press and press only after his spoken yes (confirmed=true)." };
  const want = String(args.button ?? "").trim().toLowerCase().replace(/[….]+$/, "");
  const button = (card.buttons ?? []).find((b) => b.toLowerCase().replace(/[….]+$/, "") === want);
  if (!button) return { place, id, pos: at, total, note: card.buttons?.length ? `Not pressed: that is not one of his buttons on this card (${card.buttons.join(" · ")}). Ask him which.` : "Not pressed: this card has no button you may press. Pass his answer to the desk with ask_the_desk." };
  const w = typeof args.words === "string" ? args.words.trim() : "";
  if (takesWords(button) && !w) return { place, id, pos: at, total, note: `Not pressed: ${button} needs his words. Ask him what to say.` };
  return { place, id, pos: at, total, press: { id: card.id, kind: card.kind, button, ...(takesWords(button) ? { words: w.slice(0, 4000) } : {}), title: card.title, ...(card.milestoneId ? { milestoneId: card.milestoneId } : {}) }, note: "The page presses it now; say \"pressed, it landed\" only when the result shows its commit" };
}

/**
 * his objectives one by one on the same call (the earlier briefing, by voice; his vn_15aa4467: "these are your
 * objectives and key results, one by one. And I can just talk about it"). Each live objective in his order (the
 * objectives screen's, docs/pursuits.json), its light, its key results, where it stands (its next step) and his newest
 * words on it (docs/his-words.json); what he says about one is filed on it through the briefing's own route.
 */
export interface ObjectiveCard {
  id: string;
  name: string;
  /** green, amber or red: the objectives screen's light. */
  light: string;
  /** "4 of 8 key results green". */
  krs: string;
  /** `evidence`: what shows its colour; absent: no evidence yet, said plainly. */
  keyResults: { label: string; state?: string; value?: string; target?: string; evidence?: string }[];
  /** where it stands: moved today, or what moves it next (a worker, his answer, a check). */
  stands: string;
  /** his newest words on it, whole, and when he said them. */
  words?: string;
  said?: string;
}

export const OBJECTIVE_TOOL_NAMES = ["next_objective", "read_objective", "file_objective_words"] as const;
export type ObjectiveToolName = (typeof OBJECTIVE_TOOL_NAMES)[number];
export const isObjectiveTool = (n: string): n is ObjectiveToolName => (OBJECTIVE_TOOL_NAMES as readonly string[]).includes(n);
/** his words filed on one objective at most this long (the route keeps 2,000). */
const FILE_WORDS_MAX = 2000;

/** One objective as the voice gets it: its place, light, key results, where it stands, his newest words. */
export function objectiveText(o: ObjectiveCard, n: number, total: number): string {
  const out = [`Objective ${n} of ${total} in ${ownerName()}'s order: ${o.name}. Light: ${o.light}. ${o.krs}.`];
  for (const k of o.keyResults.slice(0, 12)) out.push(`- ${words(k.label, 140)} (${k.state ?? "no light"}): ${k.value ? `now ${words(k.value, 60)}` : "no number yet"}${k.target ? `, target ${words(k.target, 60)}` : ""}; evidence: ${k.evidence ? words(k.evidence, 80) : "none yet"}`);
  if (!o.keyResults.length) out.push("It has no key results yet.");
  out.push(`Where it stands: ${words(o.stands, 220)}`);
  if (o.words) out.push(`His newest words on it${o.said ? ` (${o.said.slice(0, 10)})` : ""}: "${words(o.words, 600)}"`);
  return out.join("\n");
}

/** What the objective tools give back: the place, the objective, or the words for the page to file. Pure. */
export interface ObjectiveStep {
  place: string;
  id?: string;
  pos: number;
  total: number;
  objective?: string;
  done?: true;
  file?: { id: string; name: string; words: string };
  note: string;
}

export function objectiveStep(cards: ObjectiveCard[], pos: number, name: ObjectiveToolName, args: { number?: unknown; words?: unknown; confirmed?: unknown } = {}): ObjectiveStep {
  const total = cards.length;
  if (!total) return { place: "no objectives", pos: 0, total: 0, done: true, note: "No objectives were read for this call. Say so in one line." };
  if (name === "next_objective") {
    const next = pos + 1;
    if (next > total) return { place: `past the last of ${total}`, pos: total, total, done: true, note: `That was the last objective (${total} of ${total}). Say so in one line and ask if there is anything else.` };
    const o = cards[next - 1];
    return { place: `objective ${next} of ${total}`, id: o.id, pos: next, total, objective: objectiveText(o, next, total), note: "Say its place and name, its light and how many key results are green, the red ones in a few words, where it stands, and his newest words if any, in three or four short sentences. Then ask what he thinks of it, and stop." };
  }
  const n = Number(args.number);
  const at = Number.isInteger(n) && n !== 0 ? (n < 0 ? Math.max(1, pos + n) : n) : Math.max(1, pos);
  if (at > total) return { place: `there is no objective ${at}`, pos, total, note: `He has ${total} objectives. Tell him, and which one he is on${pos ? ` (${pos})` : ""}.` };
  const o = cards[at - 1];
  if (name === "read_objective") return { place: `objective ${at} of ${total}`, id: o.id, pos: at, total, objective: objectiveText(o, at, total), note: "This is the whole objective: say what he asked about it, simply." };
  // file_objective_words: his decision is his yes (no 'File it?' after each point)
  if (args.confirmed !== true) return { place: `objective ${at} of ${total}`, id: o.id, pos: at, total, note: "Not filed: call again with confirmed=true once he has decided it; never ask him 'File it?'." };
  const w = typeof args.words === "string" ? args.words.replace(/\s+/g, " ").trim() : "";
  if (!w) return { place: `objective ${at} of ${total}`, id: o.id, pos: at, total, note: "Not filed: there are no words of his to file. Ask him what he thinks of it." };
  return { place: `objective ${at} of ${total}`, id: o.id, pos: at, total, file: { id: o.id, name: o.name, words: w.slice(0, FILE_WORDS_MAX) }, note: "The page files his words on it now; once the result says it landed, say \"Filed on <the objective's short name>.\" and offer the next objective." };
}

/** the briefing's rule: objectives one by one, his words filed on each. */
export function briefingRule(total: number): string {
  return [
    `# His objectives, one by one (${total})`,
    `When he wants his briefing or to go through his objectives ('brief me', 'go through my objectives', 'next objective'), walk them one at a time in his order: next_objective for the next, read_objective for one in full (its number, or -1 to go back). The console keeps which objective he is on. For each, say its place and name, its light, how many key results are green, the red ones in a few words, where it stands, and his newest words on it if any, in three or four short sentences, then ask what he thinks and stop.`,
    `When he has said what he thinks of one, call file_objective_words with his words as he said them (never your summary) and confirmed=true. It is filed on that objective, where its owner reads it on the next wake. Then offer the next objective. Something he wants done goes to the desk with ask_the_desk as well.`,
  ].join("\n");
}

/**
 * his yes on a card(his call_c83e51e8: on card 2 he said "My answer is yes, but can you actually give the
 * feedback …" and the call passed the feedback and pressed nothing): a spoken yes on a card is a press, every time, even
 * when the same line asks for something else. The after-call check counts yeses with the same words.
 */
export const SPOKEN_YES = /^\W*(?:yes|yeah|yep|yup|sure|ok(?:ay)?,? go|go for it|go ahead|do it|press it|s[ií],? (?:dale|hazlo|adelante))\b|\b(?:go for it|my answer is yes|the answer is yes|press it|mark it complete|do what you recommend|go with (?:your|the) recommendation)\b/i;
export const SPOKEN_NO = /\b(?:no|not yet|don't|do not|wait|park it|skip)\b/i;
/** a yes that moves on, not an answer to the card ("yes, next card"). */
const MOVES_ON = /\b(?:next(?: one| card)?|skip|later|go back|back to|previous)\b/i;

/** his yes on a card: a yes, no no (after "no need" is cut off), and not a yes that only moves on. */
export function saidYes(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!SPOKEN_YES.test(t)) return false;
  if (SPOKEN_NO.test(t.replace(/\b(?:don't need|no need|no problem)\b.*/i, ""))) return false;
  return !MOVES_ON.test(t);
}

/** the button his plain yes presses on a card: the team's recommendation, else a Yes choice, else Mark complete. */
export function yesButton(card: InboxCard): string | undefined {
  const b = card.buttons ?? [];
  const usable = b.filter((x) => !takesWords(x) && !/^(?:no|park|drop|not)\b/i.test(x));
  if (card.recommend) {
    const r = usable.find((x) => x === card.recommend || x.toLowerCase().startsWith(card.recommend!.toLowerCase()));
    if (r) return r;
  }
  return usable.find((x) => /^yes\b/i.test(x)) ?? usable.find((x) => x === MARK_COMPLETE) ?? (card.kind === "review" ? usable[0] : undefined);
}

/**
 * The console's check after each of his lines on a card (`yes_check`, the page and the TEST script call it, never the
 * voice): when he said yes on the card he was on and the call has not pressed it, the voice is told to press now.
 */
export function yesCheck(cards: InboxCard[], cardId: string, words: string, pressed: string[]): { place?: string; button?: string; note?: string } {
  const at = cards.findIndex((c) => c.id === cardId);
  if (at < 0 || pressed.includes(cardId) || !saidYes(words)) return {};
  const card = cards[at];
  const button = yesButton(card);
  const place = `card ${at + 1} of ${cards.length}`;
  if (!button) return { place };
  return {
    place,
    button,
    note: `He said yes on ${place} ("${card.title.slice(0, 80)}"): that is his answer, and a spoken yes is a press. Press it now: call press_card with button "${button}", number ${at + 1} and confirmed=true. Say nothing before the result; then say "pressed" and what the result says about landing. Anything else he asked in the same breath went to the desk separately.`,
  };
}
