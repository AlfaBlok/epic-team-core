import { ownerName } from "../identity.js";

/**
 * (his pick "Walk the inbox by voice"): the call knows his inbox. When a Team
 * desk call starts, his inbox (review cards and open asks, in the order his inbox shows them) and his objectives are loaded
 * into the call, and the voice walks the cards with two tools of its own (`next_card`, `read_card`), the console keeping
 * which card he is on. Step 1 reads only: an answer he gives on a card still goes to the desk (ask_the_desk); the voice
 * pressing his button on his spoken yes is the next step.
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
}

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
  if (c.buttons) out.push(c.buttons.length ? `Buttons you may press for him on his spoken yes (press_card): ${c.buttons.join(" · ")}` : "You cannot press a button on this one: his answer goes to the desk (ask_the_desk).");
  return out.join("\n");
}

/** The rule block for the inbox walk (only on a call that has his inbox). */
export function inboxRule(): string {
  const who = ownerName();
  return [
    `# ${who}'s inbox on this call`,
    `${who}'s inbox (cards waiting for his review and questions waiting on his answer) is listed below in his inbox's order, as of the call's start, and his objectives after it. Answer 'what's in my inbox', 'how many cards', 'what's first' from the list at once, with no tool call.`,
    `When he wants to go through his inbox ('let's do my inbox', 'next', 'next card', 'go on', 'skip it'), call next_card; when he wants one card in full ('read it', 'what does it say', 'read card three', 'go back'), call read_card (with its number for a given card). The console keeps which card he is on: the tool tells you the card's place ('card 3 of 12'); trust it over your own count.`,
    "Say each card the way a colleague would on the phone: its place, what was made or what is asked, and the one thing it asks him, in two or three short sentences, no codes, no links read out; then stop and let him react. Read the whole card only when he asks.",
    `When he gives his answer or a comment on a card, pass it to the desk with ask_the_desk: his words, naming the card's code from the list so the desk knows which card, confirmed=true only when he clearly said what to do. The desk presses his button for him. Never tell him you cannot press, or that pressing is not built yet: say the desk has it, and when its answer says it is done, say plainly "pressed, it landed". Then go on to the next card when he says so.`,
    "When the walk reaches the end, say so in one line and ask if there is anything else.",
  ].join("\n");
}

/** The pack added to the call's instructions: the rule, the cards (first INBOX_PACK_MAX), his objectives. */
export function inboxPack(cards: InboxCard[], objectives?: string): string {
  const head = cards.length ? `His inbox now: ${cards.length} card${cards.length === 1 ? "" : "s"} (${cards.filter((c) => c.kind === "review").length} to review, ${cards.filter((c) => c.kind === "ask").length} questions).` : "His inbox is empty right now.";
  const lines = cards.slice(0, INBOX_PACK_MAX).map((c, i) => cardLine(c, i + 1));
  if (cards.length > INBOX_PACK_MAX) lines.push(`… and ${cards.length - INBOX_PACK_MAX} more (next_card and read_card reach them).`);
  const obj = (objectives ?? "").trim();
  return [inboxRule(), "", head, ...lines, ...(obj ? ["", `His objectives, in his order: when he asks about his objectives ('what are my objectives', 'how is <objective> doing'), answer from this list, never from the milestones or the root tree (those are milestones, not objectives):`, obj] : [])].join("\n");
}

/** Where the walk is: `pos` = the card he is on, 1-based (0 = not started). */
export interface WalkStep {
  place: string;
  /** the card's id, so the page shows that card (its evidence) while the voice talks about it. */
  id?: string;
  pos: number;
  total: number;
  card?: string;
  done?: true;
  note: string;
}

/** One tool turn of the walk: the new position and what the voice gets back. Pure (the caller stores `pos`). */
export function walk(cards: InboxCard[], pos: number, name: InboxToolName, args: { number?: unknown } = {}): WalkStep {
  const total = cards.length;
  if (!total) return { place: "no cards", pos: 0, total: 0, done: true, note: "His inbox is empty. Tell him so in one line." };
  if (name === "next_card") {
    const next = pos + 1;
    if (next > total) return { place: `past the last of ${total}`, pos: total, total, done: true, note: `That was the last card (${total} of ${total}). Say so in one line and ask if there is anything else.` };
    return { place: `card ${next} of ${total}`, id: cards[next - 1].id, pos: next, total, card: cardText(cards[next - 1]), note: "Say its place, what it is and the one thing it asks him, in two or three short sentences, then stop." };
  }
  const n = Number(args.number);
  const at = Number.isInteger(n) && n !== 0 ? (n < 0 ? Math.max(1, pos + n) : n) : Math.max(1, pos);
  if (at > total) return { place: `there is no card ${at}`, pos, total, note: `There are only ${total} cards. Tell him, and which card he is on${pos ? ` (${pos})` : ""}.` };
  return { place: `card ${at} of ${total}`, id: cards[at - 1].id, pos: at, total, card: cardText(cards[at - 1]), note: "This is the whole card: say what he asked for from it, simply, without codes or links." };
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
    `Pressing his buttons (press_card): only the buttons a card lists as yours to press. Before you press, say back in one line what you will press on which card ("Mark the voice call card complete?") and press only after his spoken yes; then call press_card with that button (and his words for a button ending in "…") and confirmed=true; when it comes back done, say plainly "pressed, it landed", and offer the next card. Never press on a maybe, never on your own idea, never twice.`,
    `Anything else he asks for (a change, a question about the work, a card with no button for you, a new task) goes to the desk with ask_the_desk, naming the card's code from the list, then carry on with the cards. Do not do the desk's work on the call.`,
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
  press?: { id: string; kind: InboxCard["kind"]; button: string; words?: string; title: string };
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
  return { place, id, pos: at, total, press: { id: card.id, kind: card.kind, button, ...(takesWords(button) ? { words: w.slice(0, 4000) } : {}), title: card.title }, note: "The page presses it now; say it is done in a few words once the result says so." };
}
