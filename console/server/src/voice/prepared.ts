import { ownerName } from "../identity.js";
import { levelName, type LevelCard } from "./levelCall.js";

/**
 * Every call he makes from his phone directory is prepared (the owner, 28 Nov: "it would be awesome if tomorrow
 * I could have these 16 calls ... when I'm talking to them, they already know their shit"). Like the social product's prepared topics
 * call, each call opens on its own one-line status and our proposal, made at the call's start from what the call
 * already reads (key results, where we are, the campaign onboarding, the spine), never a question back to him first.
 *
 *   board     ──▶ "N objectives, G green, the reddest are A and B. Our proposal: one by one, reddest first."
 *   objective ──▶ "G of T key results green, the first red is X, now v against t. Our proposal: <pitch | open work | his open question>."
 *   campaign  ──▶ "<its spine's Status>. Our proposal: <its spine's Next action>."
 */

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
/** words a voice can say: no links, codes, markdown or brackets; quotes made safe for the greeting's own quotes. */
export function sayable(s: string): string {
  return flat(
    s
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\([^)]*\b(?:E\d+-[SA]\d+|EPIC-\d+|card|run_|call_|vn_|#\^?e-)[^)]*\)/gi, "")
      .replace(/\b(?:E\d+-[SA]\d+|EPIC-\d+|run_[0-9a-f-]+|call_[0-9a-f]+)\b/g, "")
      .replace(/[*_`#>]/g, "")
      .replace(/["“”]/g, "'"),
  )
    .replace(/\s+([,.;:?!])/g, "$1")
    .replace(/^[,.;:\s]+/, "")
    .trim();
}
/** cut at a word, never mid-word, and close the sentence (it is spoken). */
export function cut(s: string, max: number): string {
  const t = sayable(s).replace(/[.;:,\s]+$/, "");
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const sp = head.lastIndexOf(" ");
  return (sp > max * 0.5 ? head.slice(0, sp) : head).replace(/[.;:,\s]+$/, "");
}

const RED = ["red", "amber", "unknown", undefined];
/** the first key result that is not green, red first (his reddest one), with the number it is at. */
function reddest(c: LevelCard, idle = false): LevelCard["keyResults"][number] | undefined {
  for (const s of RED) {
    const k = c.keyResults.find((x) => (x.state ?? undefined) === s && x.state !== "green" && (!idle || !x.tickets?.length));
    if (k) return k;
  }
  return undefined;
}
const numberOf = (k: LevelCard["keyResults"][number]) =>
  k.value ? `, now ${cut(k.value, 40)}${k.target ? ` against ${cut(k.target, 40)}` : ""}` : ", no number yet";

/** the pitch's first line when the objective's campaign onboarding has one ready (docs/plans/campaign-onboarding). */
const pitchReady = (onboarding?: string) => !!onboarding && /^## The pitch\b/m.test(onboarding) && /^\s*1\.\s+\S/m.test(onboarding.split(/^## The pitch\b/m)[1] ?? "");
const briefOpen = (onboarding?: string) => /^- Still open[^:]*:\s*(.+)$/im.exec(onboarding ?? "")?.[1];

/** what we propose on one objective: the prepared pitch, else work on a red key result nothing moves, else his first open question. */
export function objectiveProposal(c: LevelCard, o: { onboarding?: string; open?: string[] } = {}): string {
  if (pitchReady(o.onboarding)) return "I walk you through the one-week plan we prepared, slide by slide, and you say yes, no or change";
  const idle = reddest(c, true);
  if (idle) return `we open work this week on '${cut(idle.label, 90)}', since nothing moves it yet`;
  const k = reddest(c);
  const q = o.open?.map((x) => cut(x, 140)).find((x) => x.length > 8);
  if (q) return `we settle one open question first: ${q.charAt(0).toLowerCase()}${q.slice(1).replace(/\?$/, "")}?`;
  const b = briefOpen(o.onboarding);
  if (b) return `we settle what is still open in the brief: ${cut(b, 120)}`;
  if (k) return `we agree this week's one step on '${cut(k.label, 90)}'`;
  return "we agree this week's one step to keep every key result green";
}

/** a spoken sentence's end: a question keeps its mark, anything else gets a full stop. */
const end = (s: string) => (/[?.!]$/.test(s) ? s : `${s}.`);

/**
 * an objective manager's first words: who, where it stands in one line, then the big-picture question (his
 * call_2332dcc1: "you went a little bit too quickly into specifics ... you are more about the bigger picture ... let me
 * talk"). Our proposal waits in the call's rule (OBJECTIVE_PREPARED_RULE) until he has said what is on his mind.
 */
export function objectiveOpening(c: LevelCard, o: { onboarding?: string; open?: string[]; person?: string } = {}): string {
  const who = o.person ? `${sayable(o.person)} here, the ${levelName(c.name)}` : `the ${levelName(c.name)} here`;
  return `Hi ${ownerName()}, ${who}. In one line: ${cut(c.krs, 60)}. What's new since we last spoke?`;
}
/** the objective call's prepared rule: the proposal it holds back, and never re-asking what his answers settle. */
export const objectiveRule = (c: LevelCard, o: { onboarding?: string; open?: string[] } = {}) =>
  [
    `This call is prepared. Your greeting said where it stands in one line and asked what is new since you last spoke. Let him talk first. When he has said what is on his mind, the proposal you hold is: ${end(objectiveProposal(c, o))} Bring it in your words, and settle it with him.`,
    "His recorded answers settle their points (his newest words in force, the brief, what earlier calls decided, all below): never ask any of them again; build on them and say which one you build on.",
  ].join("\n");

/** a campaign manager's first words: its spine's Status and Next action, else its objective's line. */
export function campaignOpening(title: string, state: string[], card?: LevelCard, o: { onboarding?: string; open?: string[] } = {}): string {
  const line = (k: string) => state.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1);
  const status = line("Status") ?? line("Result");
  const next = line("Next action");
  const stand = status ? cut(status, 170) : card ? cut(card.krs, 60) : "nothing written on its spine yet";
  const prop = next ? cut(next, 200) : card ? objectiveProposal(card, o) : "we agree this week's one step";
  return `Hi ${ownerName()}, the ${levelName(title)} here. Where we stand: ${stand}. Our proposal: ${end(prop)} Shall we start there?`;
}

/** the board's first words (his Team desk partner, over every objective): how many are green, the reddest two, our order. */
export function boardOpening(cards: Pick<LevelCard, "name" | "light">[], role: string, person?: string): string {
  const who = person ? `${sayable(person)} here, your ${role}` : `your ${role} here`;
  if (!cards.length) return `Hi ${ownerName()}, ${who}, on the board of your objectives and key results. Our proposal: we go through them one by one, reddest first. Shall we start?`;
  const green = cards.filter((c) => c.light === "green").length;
  const red = cards.filter((c) => c.light === "red").slice(0, 2).map((c) => cut(c.name.replace(/^[^:]{1,30}:\s*/, ""), 50));
  const reds = red.length ? `; the reddest are ${red.join(" and ")}` : "";
  return `Hi ${ownerName()}, ${who}, on the board of your ${cards.length} objectives and key results: ${green} green${reds}. Our proposal: we go through them one by one, reddest first, and agree each one's step for this week. Shall we start${red[0] ? ` with ${red[0]}` : ""}?`;
}

/** the rule every prepared call adds: lead, never re-ask what his recorded answers settle. */
export const PREPARED_RULE = [
  "This call is prepared: your greeting already said where we stand and our proposal. Lead from it: when he agrees, go straight into the proposal; when he wants something else, follow him.",
  "His recorded answers settle their points (his newest words in force, the brief, what earlier calls decided, all below): never ask any of them again; build on them and say which one you build on.",
  "If the greeting was not said in his language, say the status and our proposal first, in one or two sentences, before anything else.",
].join("\n");
