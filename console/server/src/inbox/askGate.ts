import { ownerName, ownerPattern, socialProduct } from "../identity.js";
import { phantomRefProblem } from "./phantomRefs.js";
import { decideButtonsProblem } from "./decideChoices.js";
import { untappableProblem } from "./untappable.js";
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
 * 6. (E996-S29, every open ask whatever its date) It names only what its card has: a private box to paste a value into only
 *    with a `secret: <app> <NAME>` target, an Approve button only on an approve ask (inbox/phantomRefs.ts).
 * 8. (E996-S43) A fresh agent completed it from the card alone: scripts/ask_dryrun.py dry-runs every open ask with only its
 *    card's words and links; a failed one is held as "ask needs rewriting: step N <why>", a new one waits for its dry run
 *    (inbox/askDryRun.ts, applied in inbox/waiting.ts where the spine line is at hand).
 * 9. (E996-S48) It does not repeat a question he already answered (same code, same row and most of the same words, or nearly
 *    the same words): held as "already answered on <date>: <his answer>" (inbox/askRepeat.ts, applied in inbox/waiting.ts).
 * 10. (E996-S48) It fits one sitting: its `effort:`, else the time its words give, else 3 minutes a numbered step, is 20
 *    minutes or less; else held as "too long for one sitting: split it".
 * 11. (E948-S85, every open ask whatever its date) It links to where the owner acts (his voice note of 12 Nov, e-4f9161:
 *    "if I need to do an action, I expect a link. I need to see a link."): a `do` or `provide` ask carries a web address
 *    (a full link or a bare site like x.com/settings), or is done on its own card (a `secret:` box, the Mac list's ticket,
 *    or it says "on this card" / "by voice note" for the card's Record button); an `approve` or `decide` ask that sends
 *    him to read, open, look at, review or try something links that thing (a web address or a document path). A link to
 *    a spine on GitHub does not count: that is where the team writes, not where he acts (inbox/askGate.ts linkProblem).
 * 12. (E948-S129, asks raised from 2026-11-17) Every address it shows is one he can tap: never localhost or a server's own
 *    address, an IP or short name with a port and no http://, or a link cut by a space (inbox/untappable.ts).
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
  /** `secret: <app> <NAME>`: the card shows a private key box (rule 6). */
  secret?: unknown;
  /** `label: needs Mac agent`: done from its Mac list ticket, the place he acts (rule 11). */
  macAgent?: unknown;
  /** a runbook link inside `steps:` (rule 11). */
  stepsLink?: string;
  /** The ask's `since` date: undefined = a new ask (the API path), null/older than ASK_GATE_FROM = an old line, left alone. */
  since?: string | null;
}

/** the day the gate started (the owner's messages of 2026-11-11). */
export const ASK_GATE_FROM = "2026-11-11";
/** the day rule 7 started (the owner on E946-A31, 2026-11-13): older open decide asks stay, the sweep names them. */
export const DECIDE_BUTTONS_FROM = "2026-11-13";
/** the day rule 12 started (E948-S129, his note of 2026-11-17 17:27Z): older open lines stay, the console links what it can. */
export const TAPPABLE_FROM = "2026-11-17";
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
  // 11. no link to where he acts: held whatever its date, after the other rules' reasons (E948-S85).
  return wordsOrButtonsProblem(a) ?? linkProblem(a) ?? tappableProblem(a);
}

/** 12. an address he cannot tap (E948-S129). */
export function tappableProblem(a: GateAsk): string | undefined {
  if (a.state && a.state !== "open") return undefined;
  if (a.since !== undefined && (!a.since || a.since < TAPPABLE_FROM)) return undefined;
  return untappableProblem("it", a.question, a.contextText, a.context, a.why, a.impact, a.risk, a.recommend, ...(a.options ?? []), a.steps, a.stepsLink);
}

/** A web address: a full link, or a bare site with a known ending (x.com, team.example.com/pages). */
const WEB_LINK = /\bhttps?:\/\/[^\s)\]>"']+|(?<![@\w.\/-])(?:[a-z0-9-]+\.)+(?:com|io|dev|app|net|org|ai|eu|co|me|es|mx|so|sh|to|tv|ly|link|site|page)\b(?:\/[^\s)\]>"']*)?/gi;
/** A spine (or other markdown) on GitHub: where the team writes, not where he acts. */
const SPINE_ON_GITHUB = /^https?:\/\/github\.com\/[^\s]+\.md\b/i;
/** A document path the card shows as a link (`context: docs/status/x.html`), never a spine. */
const DOC_PATH = /^(?!https?:)[^\s]+\.(?:md|html?|pdf|png|webp|jpe?g|csv|txt)(?:#\S*)?$/i;
/** A spine file: where the team writes, not where he acts. */
const SPINE_PATH = /(?:^|\/)spines\/|(?:^|\/)(?:EPIC|EPIC_SPINE|EPIC_SPINE_[^/]*|root)\.md(?:#|$)/i;
/** The ask says it is answered on its own card (its Record, Write or option buttons). */
const ON_THE_CARD = /\b(?:on|in|from|with) (?:this|the|its) card\b|\bcard'?s (?:voice|record|write|box|buttons?)\b|\bby voice note\b|\b(?:record|send) (?:a |one )?voice note\b/i;
/** An approve or decide ask that sends him somewhere to judge: read, open, look at, review, try, watch, listen. */
const SENDS_HIM = /\b(?:read|open|look(?:s|ing)? at|review|watch|listen to|try|test|check|see|visit|go to|sign in to|log ?in to)\b(?:\s+(?:the|this|that|its|our|your|a|an|new|both|two|three|four|five|round \d+|\w+'s)){0,3}\s+(?:[\w-]+\s+)?(?:page|pages|deck|draft|drafts|mock-?ups?|dossier|document|doc|docs|file|site|form|forms|video|videos|clip|clips|report|list|post|posts|demo|screen|screens|pdf|link|proposal|brief|layouts?|app|steps)\b/i;

const isWebPlace = (u: string) => !SPINE_ON_GITHUB.test(u);
/** Whether a text links a place the owner can open (a web address, never a spine on GitHub); markdown links count by their target. */
export const hasPlaceLink = (t: string) => [...t.replace(/\[[^\]]*\]\(([^)\s]+)\)/g, " $1 ").matchAll(WEB_LINK)].some((m) => isWebPlace(m[0]));
function webLinks(a: GateAsk): string[] {
  const all = text(a.question, a.contextText, a.context, a.why, a.impact, a.risk, a.recommend, ...(a.options ?? []), a.steps, a.stepsLink);
  return [...all.matchAll(WEB_LINK)].map((m) => m[0]).filter(isWebPlace);
}

/**
 * 11. Why this ask has no link to where the owner acts (his voice note of 12 Nov, e-4f9161); undefined when it has one,
 * or when its own card is the place (a key box, a Mac list ticket, the card's voice button).
 */
export function linkProblem(a: GateAsk): string | undefined {
  if (a.state && a.state !== "open") return undefined;
  const kind = a.ask.toLowerCase();
  const links = webLinks(a);
  // a document the card shows as a link (a runbook in `steps:`, a page in `context:`), never a spine
  const mdTargets = [...text(a.question, a.contextText, a.steps, a.recommend).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const docLink = [a.context, a.stepsLink, ...mdTargets].some((p) => !!p && DOC_PATH.test(p) && !SPINE_PATH.test(p));
  if (kind === "do" || kind === "provide") {
    if (links.length || docLink || a.secret || a.macAgent) return undefined;
    if (ON_THE_CARD.test(text(a.question, a.contextText, a.steps, a.recommend))) return undefined;
    return (
      `it asks ${ownerName()} to act but has no link to where he acts: put the page, site or form he opens first in the ask ` +
      `(a full https link, or a runbook or page path in \`steps:\` or \`context:\`; a spine does not count), or say it is done on this card (its voice or option buttons), or give it a \`secret: <app> <NAME>\` box ` +
      `(his voice note of 12 Nov: "if I need to do an action, I expect a link")`
    );
  }
  if (kind !== "approve" && kind !== "decide") return undefined;
  if (!SENDS_HIM.test(text(a.question, a.recommend, ...(a.options ?? []), a.steps))) return undefined;
  if (links.length || docLink) return undefined;
  return (
    `it sends ${ownerName()} to read, open or try something but does not link it: put the page he judges in the ask ` +
    `(a full https link or the document's path in \`context:\`; a spine on GitHub does not count) (his voice note of 12 Nov: "I need to see a link")`
  );
}

function wordsOrButtonsProblem(a: GateAsk): string | undefined {
  // 7. a Decide card always shows choices as buttons: held whatever its date, after the other rules' reasons (E948-S69, E946-A31).
  return wordsProblem(a) ?? (a.since === undefined || (!!a.since && a.since >= DECIDE_BUTTONS_FROM) ? decideButtonsProblem(a) : undefined);
}

function wordsProblem(a: GateAsk): string | undefined {
  // 6. it names a box or button its card does not have: held whatever its date (E996-S29, T9-A10).
  const phantom = phantomRefProblem(a);
  if (phantom) return phantom;
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
  "a dated batch of posts: the team just goes). From 2026-11-12 it also holds any do or provide ask (his hands) with no \`why " + ownerName() + ":\` saying why the team cannot do it itself, and any whose why rests on his Mac, Chrome or sign-in without saying why the Team Browser or the server browser cannot. It also holds any ask that tells him to paste a value into a private box without a \`secret: <app> <NAME>\` (so its card has no box) or to press Approve on a card with no Approve button (E996-S29). Before it reaches him, a fresh agent with only the card's words and links dry-runs every step (is the exact place named, does it exist now, could it be done from these words alone); any no holds it as \"ask needs rewriting: step N <why>\" (E996-S43). It also holds an ask repeating a question he already answered (\"already answered on <date>: <his answer>\": act on it, or ask only what is new and cite the earlier ask) and one longer than 20 minutes (its effort, the time it names, or 3 minutes a step: \"too long for one sitting: split it\", send only the step that blocks now) (E996-S48). Every ask links to where he acts (E948-S85, his voice note of 12 Nov: \"if I need to do an action, I expect a link\"): a do or provide ask carries the https link of the page, site or form he opens first (a spine on GitHub does not count), unless its own card is the place (a `secret:` box, a needs Mac agent ticket, or it says it is answered on this card or by voice note); an approve or decide ask that sends him to read, open, look at, review or try something links that thing. A recommendation he did not ask for is a row or a note for the Delivery Manager, never an ask (root L-56).";

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

/** E996-S47: an ask open longer than this reaches the Delivery Manager's wake (scripts/asks_insights.py STALE_DAYS, the same rule). */
export const STALE_ASK_DAYS = 3;

export interface StaleAskLike {
  code?: string;
  repo?: string;
  path?: string;
  line?: number;
  row?: string;
  question: string;
  since?: string;
  state?: string;
  source?: string;
  gate?: string;
  /** the owner snoozed it until this day: his choice, not left hanging (asks.ts snoozedUntil). */
  snoozedUntil?: string;
}

/**
 * E996-S47: the Delivery Manager's wake section: asks open more than STALE_ASK_DAYS days (48 of the 118 failed asks of
 * 9-14 Nov were left open for days, never answered or withdrawn). Each gets one of three ends this wake: closed, withdrawn
 * or asked again rewritten. Oldest first.
 */
export function staleAsksSection(items: StaleAskLike[], now = new Date()): string | undefined {
  const cut = now.getTime() - STALE_ASK_DAYS * 86_400_000;
  const stale = items
    .filter((i) => (i.state ?? "open") === "open" && i.source !== "heuristic" && i.gate !== "future" && !(i.snoozedUntil && i.snoozedUntil.slice(0, 10) >= now.toISOString().slice(0, 10)) && i.since && Date.parse(i.since) < cut)
    .map((i) => ({ ...i, days: Math.floor((now.getTime() - Date.parse(i.since!)) / 86_400_000) }))
    .sort((a, b) => b.days - a.days);
  if (!stale.length) return undefined;
  return [
    `## Asks open more than ${STALE_ASK_DAYS} days (E996-S47)`,
    `${stale.length} ask${stale.length > 1 ? "s" : ""} to ${ownerName()} in your tree ${stale.length > 1 ? "have" : "has"} waited more than ${STALE_ASK_DAYS} days. An ask left hanging is a failure (asks page, kind \"left hanging\"). This wake, give each one of three ends: ` +
      "(1) close it: it was done or answered elsewhere, or is no longer needed: `[answered <CODE> <date> @<persona>] … — answer: done, <where>` or `… — answer: no longer needed, <why>`; " +
      "(2) withdraw it: it is not truly his (root L-56) or the team can do it: `[answered <CODE> <date> @Delivery-Manager] … — answer: withdrawn, <why>`, then do the work or file it as a row; " +
      `(3) ask again, rewritten, only if it still blocks now and is still ${ownerName()}'s: one decision, the blocking step only, and it must pass \`python3 scripts/ask_dryrun.py --only <CODE> --rejudge\`. ` +
      "Never answer an ask-tier question for him.",
    ...stale.slice(0, 30).map((s) => `- ${s.code ?? "(no code)"} · ${s.days} days · ${s.row ? `row ${s.row} · ` : ""}${s.repo ?? ""}${s.path ? `/${s.path}` : ""}${s.line !== undefined ? `:${s.line + 1}` : ""}: ${s.question.slice(0, 160)}`),
    ...(stale.length > 30 ? [`- … ${stale.length - 30} more`] : []),
  ].join("\n");
}

