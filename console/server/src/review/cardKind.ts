/**
 * (the owner 26 Nov on a tester-names card, "this came as review but was a question??"): which review card asks
 * him a real choice. The same rule as web lib/cardKind.ts `asksChoice` (keep the two alike): a decision whose first
 * sentence asks what the team does ("Do we / Should …?"), which one or when ("Which …?", "When do we …?"), names the step
 * to take ("Greet Ana by name …?") or weighs two ways ("… or …?") is a Decision even with no buttons of its own; a
 * question that only judges finished work ("Is this right?", "Does it read well?", "Keep it?") stays a Review.
 */
export const DECIDE_QUESTION = /^(?:do|should|shall|will|can|would) (?:we|the team|i)\b[^?]*\?/i;
const SHOULD = /^(?:should|shall)\b[^?]*\?/i;
export const PICK_QUESTION = /^(?:which|when|where|who|whom|what\b[^?]*\b(?:should|do|shall|will) (?:we|i|the team))\b[^?]*\?/i;
const OR_CHOICE = /\b\w+,? or (?!not\b|no\b|anything\b|something\b)\w+/i;
const NOT_A_STEP =
  /^(?:is|are|was|were|am|be|does|do|did|has|have|had|can|could|will|would|may|might|must|should|shall|how|why|what|which|when|where|who|whom|whose|the|this|these|that|those|a|an|your|our|my|its|their|it|they|you|we|i|he|she|one|all|every|both|each|any|now|so|then|and|or|but|ok|okay|good|right|done|ready|enough|here|there|keep|mark|close|accept|approve|confirm|stay|leave|start|switch|happy|fine|looks?|reads?|\d\S*)$/i;
export const firstAsk = (decision: string | undefined) => (decision ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim().split(/(?<=[?.!])\s+/)[0] ?? "";
export function asksChoice(decision: string | undefined): boolean {
  const q = firstAsk(decision);
  if (!q.endsWith("?")) return false;
  if (DECIDE_QUESTION.test(q) || SHOULD.test(q) || PICK_QUESTION.test(q)) return true;
  const first = q.split(/\s+/)[0]?.replace(/[^\p{L}\d']/gu, "") ?? "";
  if (first && !NOT_A_STEP.test(first)) return true;
  return OR_CHOICE.test(q.replace(/\?$/, ""));
}
/** the buttons a choice gets when the card names none: Yes: plan it for "Do we …?", Yes: go ahead for any other; a "Which …?" needs its own. */
export const choiceDefaults = (decision: string | undefined): string[] | undefined =>
  DECIDE_QUESTION.test(firstAsk(decision)) ? ["Yes: plan it", "No: park it"] : asksChoice(decision) && !PICK_QUESTION.test(firstAsk(decision)) ? ["Yes: go ahead", "No: park it"] : undefined;

/** E948-S232: the question asks what the team does next ("Do we / Should we …?", "Which / When …?"), as web lib/cardKind `asksNext`. */
export const asksNext = (decision: string | undefined) => {
  const q = firstAsk(decision);
  return q.endsWith("?") && (DECIDE_QUESTION.test(q) || SHOULD.test(q) || PICK_QUESTION.test(q));
};
/** the Yes of finished work: it keeps what was made, it starts nothing new (web lib/cardKind KEEPS). */
export const KEEPS = /^[^:]*:\s*(?:keep|leave|accept|close|mark|done|looks|it'?s|that'?s|fine|good|right|ship it as)\b/i;
