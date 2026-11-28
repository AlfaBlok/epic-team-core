import { ownerName, sites } from "../identity.js";
import { teamLink } from "../notify/notice.js";

/**
 * E996-S29 (the owner, on T9-A10: "HOW CAN I HAVE SOME TEXT REFERRING TO A PASTE IN A BOX THAT DOESN'T EXIST"): an ask or
 * a step may name only what its card or page really has. Checked by the ask gate (inbox/askGate.ts rule 6) and the
 * steps-page check (steps/steps.ts): the private key box exists only where a `secret: <app> <NAME>` target is named (an
 * ask) or the step is registered with a secret (a steps page); Approve exists only on an approve ask.
 */

/**
 * Words that send him to a private box to paste or type a value into (a site's own "password field" is not ours: not
 * matched).
 */
export const NAMES_KEY_BOX =
  /\b(?:secret|private|paste)[ -](?:key[ -])?(?:box|card)\b|\bkey[ -]box\b|\b(?:paste|enter|type)\b[^.;—\n]{0,60}\b(?:in|into)\s+(?:the|this|its|this card's|the card's)\s+(?:private\s+|secret\s+)?box\b/i;
/** The private card T3 shows when an agent calls `request_secret`: a real box, named by that word. */
const T3_SECRET_CARD = /\brequest_secret\b/;

/** A provide ask that hands over a key value (an API key, a token, a password, a client secret). */
// "the key results" of an objective is no key: a provide card that names them asks for words, not a secret
export const ASKS_FOR_KEY =
  /\b(?:api[ -]?keys?|tokens?|passwords?|credentials?|client[ -]secrets?|secret[ -]keys?|access[ -]keys?|(?:the|a|one|its|your|new)\s+(?:[\w-]+\s+){0,3}keys?(?!\s+results?\b))\b/i;

/** Words that send him to press an Approve button. */
const NAMES_APPROVE = /\b(?:press|click|tap|hit)\s+(?:the\s+)?["“]?approve["”]?(?:\s+button)?\b/i;

/**
 * E948-S155 (E948-A18 on 20 Nov: a `decide` card, so Yes and No buttons and no box, whose words said "Say or write here
 * what to change"): words that send him to write or say his answer into a box on the card. Only a `provide` card (no
 * `secret:`) has that box with its Send button; a `do` card has a note box beside Done and Stuck.
 */
export const WRITES_ON_CARD =
  /\b(?:write|type|record|put|say|give|send)\b[^.;—\n]{0,80}?\b(?:in|into|on)\s+(?:the|this|its)\s+(?:card'?s\s+)?(?:answer\s+|text\s+|note\s+|reply\s+|voice\s+)?box\b|\b(?:answer|reply|text or voice)\s+box\b|\b(?:say|write|type|record)\b(?:\s+or\s+(?:say|write|type|record))?\s+(?:it\s+|them\s+|your\s+\w+\s+)?(?:here|on this card|in this card)\b/i;
/** Words that send him to press Done, Stuck, Yes or No: a `provide` answer card has none of them, only its box and Send. */
export const PRESSES_BUTTON = /\b(?:press|click|tap|hit)\s+(?:the\s+)?["“]?(?:done|stuck|yes|no)["”]?(?:\s+button)?\b/i;

export interface RefAsk {
  ask: string;
  secret?: unknown;
  question: string;
  contextText?: string | null;
  context?: string | null;
  why?: string | null;
  recommend?: string | null;
  steps?: string | null;
  options?: string[];
}

/** Why this ask names a box or button its card does not render; undefined when it names only what is there. */
const text = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).join(" — ");

export function phantomRefProblem(a: RefAsk): string | undefined {
  const all = [a.question, a.contextText, a.context, a.why, a.recommend, a.steps, ...(a.options ?? [])].filter(Boolean).join(" — ");
  if (!a.secret && NAMES_KEY_BOX.test(all) && !T3_SECRET_CARD.test(all))
    return `it tells ${ownerName()} to paste a value into a private box, but it names no \`secret: <app> <NAME>\`, so its card has no box: add the secret target (the card then shows the box) or drop those words (E996-S29)`;
  // the end of the action is a key: its card must have the box (the owner, 12 Nov: "the end of the action is for me to paste the key and I don't have a box")
  if (!a.secret && a.ask.toLowerCase() === "provide" && ASKS_FOR_KEY.test(text(a.question, a.steps)) && !T3_SECRET_CARD.test(all))
    return `it asks ${ownerName()} for a key but names no \`secret: <app> <NAME>\`, so its card has no box to paste it into: add the secret target (E996-S29)`;
  // E948-S155: the card's words name only the controls its kind shows (decide: its buttons; approve: Approve and Deny;
  // provide: an answer box and Send; do: Done, Stuck and a note).
  const kind = a.ask.toLowerCase();
  if ((kind === "decide" || kind === "approve") && WRITES_ON_CARD.test(text(a.question, a.steps, a.recommend)))
    return `it asks ${ownerName()} to write or say his answer on the card, but a ${kind} card shows only its buttons and no answer box: make it a provide ask (its card has the answer box and Send), or give it the options he presses (E948-S155)`;
  if (kind === "provide" && !a.secret && PRESSES_BUTTON.test(text(a.question, a.steps, a.recommend)))
    return `it tells ${ownerName()} to press a button a provide card does not have: that card shows an answer box and Send, no Done, Stuck, Yes or No. Name the box, or make it a do or decide ask (E948-S155)`;
  if (a.ask.toLowerCase() !== "approve" && NAMES_APPROVE.test(all))
    return `it tells ${ownerName()} to press Approve, but a ${a.ask} ask's card has no Approve button: name the button the card has, or make it an approve ask (E996-S29)`;
  return undefined;
}

/**
 * A key card has its own box (`secret:`), but its words send him to paste the key somewhere else (the T3 private
 * `request_secret` card, "the secret card the Delivery Manager sends you") or say the card has no box (T9-A10 on 13 Nov:
 * "paste it in the private T3 request_secret card … not in the console card, which has no secret box"). The card's box is
 * the one place: the console shows those words pointed at it (web keyStepsHere) and the check names the ask.
 */
export const BOX_ELSEWHERE =
  /\b(?:in|into)\s+(?:the|a)\s+(?:private\s+)?(?:T3\s+)?(?:request_secret|secret|key)\s+(?:card|box)\s+the\s+Delivery\s+Manager\s+sends\s+you\b|\b(?:in|into)\s+(?:the|a)\s+(?:private\s+)?(?:T3\s+)?request_secret\s+(?:card|box)\b/i;
export const DENIES_BOX = /\b(?:card|page|ticket),?\s+which\s+has\s+no\s+(?:secret\s+|private\s+|key\s+|paste\s+)?box\b|\bhas\s+no\s+(?:secret|private|key|paste)\s+box\b/i;

export function ownBoxProblem(a: RefAsk): string | undefined {
  if (!a.secret) return undefined;
  const all = [a.question, a.contextText, a.context, a.why, a.recommend, a.steps, ...(a.options ?? [])].filter(Boolean).join(" — ");
  if (DENIES_BOX.test(all))
    return `its card has the box Paste the key here, but its words say the card has no box: drop those words and point to the box on the card (E996-S29)`;
  if (BOX_ELSEWHERE.test(all))
    return `its card has the box Paste the key here, but its words send ${ownerName()} to paste the key in another card: point to the box on the card (E996-S29)`;
  return undefined;
}

/** One step section of a steps page (`<section data-step="id">`), as text. */
export function stepTexts(html: string): { step: string; text: string }[] {
  const out: { step: string; text: string }[] = [];
  const re = /<section\b[^>]*\bdata-step=["']([^"']+)["'][^>]*>([\s\S]*?)<\/section>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const text = m[2]
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ step: m[1], text });
  }
  return out;
}

/**
 * The steps of a page that tell him to paste into a private box that is nowhere: a page has its boxes only when it was
 * registered with `secrets` (the kit draws them, `withBox`: any step of this page, "the box below" included); a step may
 * also send him to another page that has one (a registered page with a box, `boxedUrls`), to the console itself (its
 * cards and Connections have their own boxes) or to the T3 private card (`request_secret`).
 */
export function phantomBoxSteps(html: string, withBox: Set<string>, boxedUrls: Set<string> = new Set()): string[] {
  if (withBox.size) return [];
  const team = sites().teamUrl.replace(/\/+$/, "");
  const link = teamLink().replace(/\/+$/, ""); // the console on the address the owner's links go to
  const elsewhere = (t: string) =>
    T3_SECRET_CARD.test(t) || (!!team && t.includes(team)) || (!!link && t.includes(link)) || [...t.matchAll(/https?:\/\/[^\s"'<>)]+/g)].some((m) => boxedUrls.has(m[0].replace(/[.,;]+$/, "")));
  return stepTexts(html)
    .filter((s) => NAMES_KEY_BOX.test(s.text) && !elsewhere(s.text))
    .map((s) => s.step);
}

export function phantomStepsProblem(steps: string[]): string | undefined {
  if (!steps.length) return undefined;
  return `step ${steps.join(", ")} tells ${ownerName()} to paste a value into a private box the page does not have: register the page with \`secrets\` for that step (the kit then draws the box) or drop those words (E996-S29)`;
}
