/**
 * E948-S69 iteration 2 (the owner on E946-A31, 2026-11-13, vn_11f06422: "It's still happening that I'm getting decide cards
 * with no decide options. Just now, only ask feedback."): every Decide card shows choices as buttons.
 *
 * - The ask lists 2 or more `options:`: those (E946-A31 wrote them with `;` between, read now as three).
 * - It lists none (or one): buttons from the question itself. A yes or no question gets `Yes, <the action>` and `No`; a
 *   `You decide: A or B?` gets A and B. The team's recommendation marks its button.
 * - No question but a recommendation: `Yes, <the recommendation>` and `No`.
 * - Nothing to build buttons from (no question mark, no either-or, no recommendation): the ask fails the check (the inbox holds it from his
 *   list, the raise route answers 422 decide_no_options, scripts/ask_refs_check.py names it).
 */

export interface DecideAsk {
  ask: string;
  question: string;
  options?: string[];
  recommend?: string | null;
}

export interface DecideChoices {
  options: string[];
  /** the option the team recommends, when it can be told. */
  recommend?: string;
  /** true when the buttons were built from the question, not listed on the ask. */
  derived: boolean;
}

/** Leading words of a yes or no question that the Yes button drops: "Should we build X?" → "Yes, build X". */
const YES_NO_LEAD =
  /^(?:(?:do|does|shall|should|can|could|may|will|would|must)\s+(?:we|you|i|the team|they|it)\s+|(?:is|are)\s+(?:it|this|that)\s+(?:ok|okay|fine|right)\s+(?:to|if we)\s+|(?:ok|okay)\s+(?:to|if we)\s+)/i;
/** A question that starts like a yes or no question (an auxiliary, or an imperative verb such as Agree, Start, Keep). */
const YES_NO_START =
  /^(?:do|does|did|shall|should|can|could|may|will|would|must|is|are|was|were|has|have|ok|okay|agree|approve|accept|start|go|keep|ship|launch|send|post|publish|use|move|make|let|stop|drop|run|open|close|add|switch|turn|give|take|pay|buy|book|sign|merge|release|build|plan|try|put|set)\b/i;

const WORDS_MAX = 8;

/** The question's own sentence: up to and with its first question mark, without the kind word lead. */
export function questionOf(text: string): string | undefined {
  const t = text.replace(/^\s*(?:you\s+(?:decide|approve|choose|pick)\s*:\s*)/i, "").trim();
  const q = /^(.*?\?)/s.exec(t);
  return q ? q[1].trim() : undefined;
}

/** "Agree this plan for the testers and start … tomorrow?" → "agree this plan for the testers" (short, a button). */
export function actionOf(question: string): string {
  let a = question.replace(/\?\s*$/, "").replace(YES_NO_LEAD, "").trim();
  // the first clause: a button names the act, the card's text keeps the rest
  a = a.split(/\s+(?:and|then|so)\s+|\s*[,;:—–(]\s*|\s+-\s+/)[0].trim();
  const words = a.split(/\s+/).filter(Boolean);
  a = words.slice(0, WORDS_MAX).join(" ");
  return a.charAt(0).toLowerCase() + a.slice(1);
}

/** A question that picks among things (never a yes or no). */
const PICKS = /^(?:which|what|who|when|where|how)\b/i;

/**
 * `A or B?`, or a pick question naming its choices (`which do we sell first, A Acme Social, B Acme Books, or C emails?`):
 * the 2 to 4 short choices; else undefined.
 */
function eitherOr(question: string): string[] | undefined {
  const q = question.replace(/\?\s*$/, "").trim();
  const pick = PICKS.test(q);
  if (YES_NO_START.test(q) && !pick) return undefined;
  // a pick question names its choices after its first comma or colon
  const body = pick ? (/[,:]\s*(.+)$/s.exec(q)?.[1] ?? "") : q;
  const parts = body.split(/\s*,\s*(?:or\s+)?|\s+or\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4 || parts.some((p) => p.split(/\s+/).length > WORDS_MAX)) return undefined;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
}

/** Says yes: `yes`, `yes, …`, `the team recommends yes`, `go ahead`. */
const SAYS_YES = /^(?:\s*(?:yes|go ahead|agree|approve|do it|start)\b)|\brecommends?\s+yes\b/i;
const SAYS_NO = /^\s*(?:no|not now|don'?t|do not|wait|hold)\b|\brecommends?\s+no\b/i;

/** The buttons a Decide card shows. Not a decide ask: its listed options, as they are. */
export function decideChoices(a: DecideAsk): DecideChoices {
  const listed = a.options ?? [];
  const rec = a.recommend?.trim() || undefined;
  if (a.ask !== "decide" || listed.length >= 2) {
    const match = rec ? listed.find((o) => o === rec) ?? listed.find((o) => rec.toLowerCase().startsWith(o.toLowerCase())) : undefined;
    return { options: listed, ...(match ? { recommend: match } : {}), derived: false };
  }
  const q = questionOf(a.question);
  // no question, but the team's pick: Yes to that pick, or No ("Pick the launch date", recommend Monday)
  if (!q) {
    const pick = rec?.split(/[,;.—(]/)[0].trim();
    if (!pick || pick.split(/\s+/).length > WORDS_MAX) return { options: [], derived: true };
    const yes = `Yes, ${pick}`;
    return { options: [yes, "No"], recommend: yes, derived: true };
  }
  const either = eitherOr(q);
  if (either) {
    const said = (rec ?? a.question.slice(q.length)).toLowerCase();
    // the pick names the choice, or its letter (`We recommend A.`)
    const pick = either.find((o) => said.includes(o.toLowerCase())) ?? either.find((o) => /^([A-D])\s/.test(o) && new RegExp(`\\b(?:recommend|pick|choose)\\s+${o[0].toLowerCase()}\\b`).test(said));
    return { options: either, ...(pick ? { recommend: pick } : {}), derived: true };
  }
  // a pick question that does not name its choices has no yes or no: the check names it
  if (PICKS.test(q)) return { options: [], derived: true };
  const action = actionOf(q);
  const yes = action ? `Yes, ${action}` : "Yes";
  // the question's own words may carry the team's pick ("? The team recommends yes.")
  const said = rec ?? a.question.slice(q.length);
  const recommend = SAYS_YES.test(said) ? yes : SAYS_NO.test(rec ?? "") ? "No" : undefined;
  return { options: [yes, "No"], ...(recommend ? { recommend } : {}), derived: true };
}

/** Why this open decide ask's card would show no option buttons; undefined when it shows them. */
export function decideButtonsProblem(a: DecideAsk & { state?: string }): string | undefined {
  if (a.ask !== "decide" || (a.state && a.state !== "open")) return undefined;
  if (decideChoices(a).options.length >= 2) return undefined;
  return (
    "it is a decide ask, but its card would show no option buttons: it lists no `options: A | B` and its question is not a yes or no " +
    "question (no question mark), an either-or or a recommendation: list 2 to 4 options, or ask one yes or no question (E948-S69)"
  );
}

/** A question that lists its choices (", or …"): never a yes or no. */
const CHOICES = /,\s*or\s+\S/i;
/**
 * E948-S200: the ask's own question is answered by a yes or a no: its first sentence (after any "You decide:" lead and a
 * page link it opens with) ends with "?", and it is not a pick question (which, what, how …) or a list of choices.
 * The page's lib/yesNo.ts is the same test.
 */
export function isYesNoQuestion(text: string | undefined): boolean {
  const t = (text ?? "")
    .replace(/^\s*\[[^\]]*\]\(https?:\/\/[^)\s]+\)\s*(?:[:—–-]\s+|:)?\s*/i, "")
    .replace(/^\s*https?:\/\/\S+\s*(?:[:—–-]\s+|:\s+)/i, "")
    .replace(/^\s*(?:\*\*)?you\s+(?:approve|decide|do|give|provide|check|answer)(?:\s*,\s*urgent)?\s*(?:\*\*)?\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const q = /^[^?]*?\?/.exec(t)?.[0]?.trim();
  if (!q || q.length < 4 || /[.!]\s+\S/.test(q.slice(0, -1))) return false;
  return !PICKS.test(q) && !CHOICES.test(q);
}
