import { ownerName, ownerPattern, socialProduct } from "../identity.js";
/**
 * the gate every ask to the owner passes, where it is
 * raised (POST /needs-owner) and where the console reads it from a spine (inbox/waiting.ts). An ask that fails is never
 * shown to him: the API answers 422 `ask_not_his` with the reason, a spine ask is held back and listed to the milestone's
 * Delivery Manager (answer it yourself, or drop it).
 *
 * 1. An `approve` or `decide` ask names what of the owner's it answers: his ask (a voice note `vn_…`, a log id `^e-…` or
 *    `Log/<date>`, "you asked …", "your request"), or a `why the owner:` reason in the ask tier: money, publishing or
 *    contacting third parties, access, irreversible loss, the goal itself. "Only his hands" is a `do` ask, not an approval.
 * 2. It does not re-state what he already decided (it cites his earlier answer: "you already decided", "your 10 November
 *    decision", "you said it on …").
 * 3. No approve/decide ask carries a go-live date he did not set: a dated opening or a dated batch of posts is not a question, the team goes.
 * 4. An improvement request (the social product asks EpicTeam to build something) cites the owner's own words or his ask id: a
 *    `why the owner:` reason alone does not carry it (the build spends another team's time on his say only).
 * 5. (from 2026-11-12) A `do` or `provide` ask (his hands) says why the team cannot do it itself: a `why the owner:`
 *    of a few words, and when that reason is his Mac, his Chrome, his laptop or his sign-in, it also says why the Team
 *    Browser or the server browser cannot, anywhere in the ask (the owner, 12 Nov: "why do you still have to bring it to my guy?").
 */

/** The fields of an ask the gate reads (LocatedAsk / HumanAsk carry them all). */
export interface GateAsk {
  ask: string;
  state?: string;
  question: string;
  recommend?: string | null;
  contextText?: string | null;
  context?: string | null;
  why?: string | null;
  impact?: string | null;
  risk?: string | null;
  options?: string[];
  steps?: string | null;
  /** set on an improvement request ask (`label: improvement request`, inbox/improvement.ts). */
  improvement?: unknown;
  /** The ask's `since` date: undefined = a new ask (the API path), null/older than ASK_GATE_FROM = an old line, left alone. */
  since?: string | null;
}

/** the day the gate started (the owner's messages of 2026-11-11). */
export const ASK_GATE_FROM = "2026-11-11";
/** the day rule 5 started (the owner's voice note of 2026-11-12 02:01Z). */
export const HANDS_WHY_FROM = "2026-11-12";
/** A why that rests on his own machine or sign-in; it must then name the team's own browsers (rule 5). */
const HIS_MACHINE = /\b(?:mac|macbook|chrome|laptop|signed[ -]in|sign[ -]ins?|logged[ -]in)\b/i;
const OUR_BROWSERS = /\b(?:team(?:'s)? browser|server browser)\b/i;

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE = `(?:\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b20\\d\\d-\\d\\d-\\d\\d\\b)`;
const GO_LIVE = "(?:\\bopen(?:s|ing)?\\b|\\blaunch(?:es|ed|ing)?\\b|\\bgo(?:es)?[ -]live\\b|\\bgoing live\\b|\\blive (?:on|from)\\b|\\bpublish(?:es|ing)?\\b|\\bposts?\\b|\\breleas(?:e|es|ing)\\b)";
/** A go-live word and a date in one clause (no full stop or dash between them). */
const DATED_GO_LIVE = new RegExp(`${GO_LIVE}[^.;—]{0,80}?${DATE}|${DATE}[^.;—]{0,80}?${GO_LIVE}`, "i");
/** His own date, said as his: the ask may carry it. */
const HIS_DATE = () => new RegExp(String.raw`\b(?:you|${ownerPattern()})\s+(?:set|chose|picked|named|gave|asked for)\b[^.;—]{0,40}\b(?:date|day|deadline)\b|\byour (?:date|deadline)\b`, "i");

/** What of his it answers: his ask by id (voice note, log line), or his words quoted (12+ characters in quotes). */
const HIS_ASK_ID = /\bvn_[0-9a-f]{6,}\b|\^e-[0-9a-f]{6}\b|\bLog\/\d{4}-\d{2}-\d{2}/i;
const HIS_WORDS = /["“][^"”]{12,}["”]/;
/** An improvement request written without its label: "Improvement request: …" (inbox/improvement.ts IMPROVEMENT_QUESTION). */
const IMPROVEMENT_ASK = /^\W*improvement[\s-]+request\s*:/i;

/** Ask-tier reasons a `why the owner:` may give for an approve/decide (TIER_ASK, root L-15, L-56); his hands are a `do` ask. */
const TIER_REASONS: [string, RegExp][] = [
  ["money", /\b(?:money|pay(?:s|ing|ment)?|paid|spend(?:s|ing)?|spent|costs?|price[sd]?|pricing|budget|buy(?:s|ing)?|purchase|invoice|charge[sd]?|subscription|dollars?|euros?|USD|EUR)\b|[$€£]\s?\d/i],
  ["publishing or contacting others", /\bpublish\w*|\bpublic(?:ly)?\b|\bin your name\b|\bstrangers?\b|\bthird[ -]part(?:y|ies)\b|\bcontact\w*|\bexposure\b|\bpress\b|\bcustomers?\b/i],
  ["access", /\baccess\b|\bkeys?\b|\btokens?\b|\bpasswords?\b|\bpermissions?\b|\bcredentials?\b|\blogins?\b|\bsecrets?\b|\badmin\b/i],
  ["irreversible", /\birreversib\w*|\bcannot be undone\b|\bcan'?t be undone\b|\bone[- ]way\b|\bdata loss\b|\bdeletes?\b[^.;—]{0,40}\b(?:for good|permanently)\b/i],
  ["the goal", /\b(?:chang\w*|drop\w*|widen\w*|narrow\w*|new)\s+(?:the\s+|its\s+|an\s+|this\s+)?(?:epic'?s?\s+|red line'?s?\s+)?(?:goal|Done means)\b/i],
];

/** Citing his earlier answer: the ask only re-states it. */
const RESTATES = new RegExp(
  [
    `\\b(?:you|${ownerName()}|he)\\s+(?:already\\s+)?(?:decided|approved|chose|agreed|answered)\\b`,
    `\\byour\\s+(?:earlier\\s+|own\\s+|(?:\\d{1,2}\\s+)?${MONTH}(?:\\s+\\d{1,2})?\\s+)?(?:decision|answer|approval)\\b`,
    "\\balready\\s+(?:decided|approved|answered|agreed)\\b",
    "\\byou said (?:it|so|yes|this)\\b",
    "\\bas you (?:said|decided|asked)\\b",
  ].join("|"),
  "i",
);

const text = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).join(" — ");

/**
 * Why this ask must not reach the owner, in plain words for the persona that wrote it; undefined when it passes.
 * Only open asks are gated (answered lines, FYIs and feedback are history).
 */
export function askGateProblem(a: GateAsk): string | undefined {
  if (a.state && a.state !== "open") return undefined;
  // The gate holds asks raised from the day the rule started; older open lines stay as they are (root L-56).
  if (a.since !== undefined && (!a.since || a.since < ASK_GATE_FROM)) return undefined;
  const kind = a.ask.toLowerCase();
  // 5. `do` (only his hands) and `provide` (a key, a file) asks say why the team cannot do it itself.
  if (kind === "do" || kind === "provide") {
    if (a.since !== undefined && (!a.since || a.since < HANDS_WHY_FROM)) return undefined;
    const all5 = text(a.question, a.contextText, a.context, a.why, a.impact, a.risk, a.recommend, a.steps);
    const why5 = (a.why ?? new RegExp(String.raw`\bwhy\s+(?:${ownerPattern()}|you)\s*:\s*([^—]*)`, "i").exec(all5)?.[1] ?? "").trim();
    // An ask that itself says what the team's own browser hit (the Team Browser's "signed out, Sync again") carries its why.
    if (OUR_BROWSERS.test(all5)) return undefined;
    if (why5.split(/\s+/).filter(Boolean).length < 4)
      return `it asks ${ownerName()}'s hands without a \`why ${ownerName()}:\` saying why the team cannot do it itself (the Team Browser first, then a server agent, then a key we hold): give that reason or do it yourself`;
    if (HIS_MACHINE.test(why5))
      return `its \`why ${ownerName()}:\` rests on his Mac, his Chrome or his sign-in but does not say why the Team Browser or the server browser cannot do it: try those first, then say what stopped them`;
    return undefined;
  }
  if (kind !== "approve" && kind !== "decide") return undefined;
  const said = text(a.question, a.recommend, ...(a.options ?? []));
  // 3. a go-live date he did not set
  if (DATED_GO_LIVE.test(said) && !HIS_DATE().test(text(said, a.contextText, a.why)))
    return `it carries a go-live date ${ownerName()} did not set (a dated opening or a dated batch of posts): the team just goes, no ask (root L-56)`;
  const all = text(a.question, a.contextText, a.context, a.why, a.impact, a.risk, a.recommend, ...(a.options ?? []), a.steps);
  // 2. it re-states what he already decided
  if (RESTATES.test(all))
    return `it re-states something ${ownerName()} already decided (it cites his earlier answer): act on that answer, never ask him again (root L-56)`;
  // 1. what of his it answers
  if (HIS_ASK_ID.test(all) || HIS_WORDS.test(all)) return undefined;
  // 4. an improvement request needs his words: no `why the owner:` stands in for them
  if (a.improvement || IMPROVEMENT_ASK.test(a.question))
    return `it is an improvement request that does not cite ${ownerName()}'s words (quote what he said, or give his voice note or log id): ${socialProduct()} asks EpicTeam to build only what he asked for (root L-56)`;
  // an API-raised ask is one flat line: its `why the owner:` is read from the text
  const why = a.why ?? new RegExp(String.raw`\bwhy\s+(?:${ownerPattern()}|you)\s*:\s*([^—]*)`, "i").exec(all)?.[1] ?? "";
  if (why && TIER_REASONS.some(([, re]) => re.test(why))) return undefined;
  return (
    `it does not name what of ${ownerName()}'s it answers: cite his ask (his words in quotes, a voice note or log id) or give a \`why ${ownerName()}:\` in the ask tier ` +
    `(money, publishing or contacting others, access, irreversible, the goal itself; his hands are a \`do\` ask). ` +
    `A recommendation he did not ask for goes to the Delivery Manager as a row or a note: decide it yourself, or drop it (root L-56)`
  );
}

/** The rule every persona reads (ASK_TYPE_RULES) and the Advisor's prompt quotes. */
export const ASK_GATE_RULE =
  "The console refuses (422 ask_not_his, or holds back from his inbox and lists to the Delivery Manager) any approve or decide ask that does not name " +
  `what of ${ownerName()}'s it answers (his ask: his words in quotes, a voice note or log id; or a \`why ${ownerName()}:\` that is money, publishing or contacting others, access, ` +
  "irreversible, or the goal itself; an improvement request always quotes his words or names his voice note or log id), any ask re-stating what he already decided, and any ask carrying a go-live date he did not set (a dated opening, " +
  "a dated batch of posts: the team just goes). From 2026-11-12 it also holds any do or provide ask (his hands) with no \`why " + ownerName() + ":\` saying why the team cannot do it itself, and any whose why rests on his Mac, Chrome or sign-in without saying why the Team Browser or the server browser cannot. A recommendation he did not ask for is a row or a note for the Delivery Manager, never an ask (root L-56).";

export interface HeldAsk {
  code?: string;
  repo: string;
  path: string;
  line?: number;
  question: string;
  reason: string;
}

/** The Delivery Manager's wake section: asks held back from the owner's inbox by the gate. */
export function heldAsksSection(held: HeldAsk[]): string | undefined {
  if (!held.length) return undefined;
  return [
    `## Asks held back from ${ownerName()} (ask gate, root L-56)`,
    `These open ask lines in your tree never reach ${ownerName()}: each fails the ask gate for the reason named. For each one, this wake: decide it yourself ` +
      "(do it, or record it as a Decisions row and turn the line into `[answered <CODE> <date> @<persona>] … — answer: …`) or drop it " +
      "(`[answered <CODE> <date> @<persona>] … — answer: dropped, not his ask`). Never rewrite it to slip past the gate.",
    ...held.slice(0, 20).map((h) => `- ${h.code ?? "(no code)"} ${h.repo}/${h.path}${h.line !== undefined ? `:${h.line + 1}` : ""}: ${h.question.slice(0, 160)} — held: ${h.reason}`),
    ...(held.length > 20 ? [`- … ${held.length - 20} more`] : []),
  ].join("\n");
}
