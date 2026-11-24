import { ownerName, ownerPattern, socialProduct } from "../identity.js";
import { phantomRefProblem } from "./phantomRefs.js";
import { decideButtonsProblem, decideChoices } from "./decideChoices.js";
import { untappableProblem } from "./untappable.js";
import { outageProblem } from "./outageAsk.js";
import { ABOUT_FROM, aboutProblem, NO_ABOUT, NO_ABOUT_FIX } from "./about.js";
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
 *    with a `secret: <app> <NAME>` target, an Approve button only on an approve ask (inbox/phantomRefs.ts). E948-S155: and
 *    only the controls its kind shows: a decide or approve card has buttons and no answer box (words asking him to write or
 *    say his answer on the card hold it), a provide card has an answer box and Send and no Done, Stuck, Yes or No.
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
 * 13. (E948-S151, open decide asks raised from 2026-11-18) A choice shows its options: a decide ask whose buttons pick among
 *    things he has to see (options that are only a letter, A, B or C, or a choice of mockups, layouts, designs, logos, screens, versions,
 *    drafts) links the page or picture of those options, which the card shows on its face above the buttons (web
 *    lib/faceLink.ts). A choice said wholly in words (start them or keep waiting) has its options on its face already: its
 *    buttons; a bare yes or no is not a choice. The owner on E940-A10 (vn_b2c9395c): "If you don't give me a
 *    link, how the fuck do you expect me to choose?" A spine on GitHub does not count.
 * 14. (every open ask in any world) One outage, one card: while the console's GitHub sign-in alarm is open, an ask
 *    whose subject is that incident (a GitHub token, sign-in, login or key) is held under the one alarm, and when the
 *    alarm closes every ask held under it closes with it (inbox/outageAsk.ts). The owner: "cards are being duplicated
 *    ... really annoying" (six asks for one token in one outage).
 * 15. (E948-S172, spine asks raised from ABOUT_FROM, 2026-11-23) It says what it is about: `— about: <topic>`, plain
 *    words, 8 or fewer ("your reply to Dad"), which opens his card as `About: …`; else held as "card needs rewriting: no
 *    About line". Older asks show a derived one (inbox/about.ts). His vn_106f5727: "can you not just put ... somewhere
 *    there that says what's the topic ... I keep saying this, can you please do it".
 * 5b. (do asks raised from BROWSER_PROMPT_FROM, merged into rule 5) A `do` ask whose step happens in his own
 *    signed-in browser (a web link and a sign-in, his Chrome or his account) says so and carries `— browser: <one plain
 *    prompt for Claude in Chrome>`: what to open (its link), what to do, where to put the result; never a terminal line,
 *    never a secret. Where the Mac agent can do it, `label: needs Mac agent` with its Mac list ticket stands in for it.
 *    His vn_e166481b on TAX-A20: "can this type of task, which can be done via Claude with the extension, come with a
 *    prompt that I can paste?" (browserPromptProblem).
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
  /** every `why:` on the line (a plain `why:` quoting his words, then `why the owner:`), E907-S66. */
  whyAll?: string[];
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
  /** `browser:` one plain prompt he pastes into Claude in Chrome (rule 5b). */
  browser?: string | null;
  /** a runbook link inside `steps:` (rule 11). */
  stepsLink?: string;
  /** E948-S172 `about:` the card's topic (rule 15). */
  about?: string | null;
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
/** the day rule 13 started (E948-S151, his voice note vn_b2c9395c of 2026-11-18). */
export const CHOICE_LINK_FROM = "2026-11-18";
/** the day rule 5b started (his voice note vn_e166481b of 2026-11-23): asks raised from the next day. */
export const BROWSER_PROMPT_FROM = "2026-11-24";
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
 * Rule 2b (E907-S66, his E907-A2 feedback of 24 Nov: "Haven't o replied to this several times already??? Is this a repeat?
 * I think it's the third time I get this question"): an approve or decide ask whose own quote of his already tells the team
 * to do exactly the asked thing. Four cards in 36 hours (E907-A1..A4) each quoted his voice note naming the key result and
 * still asked him to approve it; RESTATES only caught a cited earlier answer. Held: the Delivery Manager does it from his
 * words and closes the ask (root L-56, L-73).
 */
const QUOTED = /["“]([^"”]{12,})["”]/g;
/** His words tell the team to do something (a key result he names, what he wants, what we need or should do). */
const DIRECTIVE = /\b(?:(?:another|one|the|a|new)\s+key\s+results?\s+(?:is|are|would be|should be|will be)|i want|i'?d like|we need|we should|should (?:be|have)|let'?s|make (?:it|this|that)|add (?:it|this|that|a|an|the)|can you|please|the (?:target|goal) is|for now the key result)\b/i;
const NEGATED = /\b(?:don'?t|do not|never|no longer|not)\s+(?:want|need|add|make|measure|count)\b/i;
const STOP = new Set(
  "the and for are but not you your yours our ours his her its this that these those with from into onto over under than then them they their there what when where which while who whom whose why how all any each every some such only own same very can will would should could may might must shall have has had does did done doing get got make made been being was were key result results becomes become objective approve decide yes".split(" "),
);
const stems = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => w.slice(0, 5)),
  );

/** The thing the ask asks him to approve: the words it quotes in its question (their headline before a colon), else the question's first clause. */
function askedThing(question: string): string {
  const q = [...question.matchAll(QUOTED)].map((m) => m[1]);
  const thing = q[0] ?? question.replace(/^\W*you\s+(?:approve|decide)\s*:\s*/i, "").split(/[?.]|\s—\s|\bwhy\s*:/i)[0];
  const head = thing.split(":")[0];
  return stems(head).size >= 2 ? head : thing;
}

/** Whether his own quoted words in the ask already tell the team to do the asked thing; returns the quote that does. */
export function hisWordsAlreadyAsk(a: GateAsk): string | undefined {
  const kind = a.ask.toLowerCase();
  if (kind !== "approve" && kind !== "decide") return undefined;
  const thing = stems(askedThing(a.question));
  if (thing.size < 2) return undefined;
  // the asked thing's own quote and the buttons' quotes are the team's words, never his
  const asked = [...a.question.matchAll(QUOTED)][0]?.[1].trim();
  const inQuestion = new Set([...(asked ? [asked] : []), ...[...text(...(a.options ?? [])).matchAll(QUOTED)].map((m) => m[1].trim())]);
  const rest = text(a.question, a.contextText, a.context, ...(a.whyAll ?? [a.why]), a.impact, a.steps);
  for (const m of rest.matchAll(QUOTED)) {
    const quote = m[1].trim();
    if (inQuestion.has(quote) || !DIRECTIVE.test(quote) || NEGATED.test(quote)) continue;
    const his = stems(quote);
    const hit = [...thing].filter((w) => his.has(w)).length;
    if (hit >= Math.min(3, thing.size) && hit / thing.size >= 0.6) return quote;
  }
  return undefined;
}

/**
 * Why this ask must not reach the owner, in plain words for the persona that wrote it; undefined when it passes.
 * Only open asks are gated (answered lines, FYIs and feedback are history).
 */
export function askGateProblem(a: GateAsk): string | undefined {
  if (a.state && a.state !== "open") return undefined;
  // 11. no link to where he acts: held whatever its date, after the other rules' reasons (E948-S85).
  // 14. a duplicate of the one GitHub sign-in alarm comes first: rewriting it would not make it his.
  return outageProblem(a) ?? wordsOrButtonsProblem(a) ?? linkProblem(a) ?? browserPromptProblem(a) ?? choiceLinkProblem(a) ?? tappableProblem(a) ?? aboutLineProblem(a);
}

/** The step happens in his own signed-in browser: his sign-in, his Chrome or browser, his account on a site. */
const HIS_BROWSER = /\bsign(?:ed|s)?[ -]?in\b|\blog(?:ged|s)?[ -]?in\b|\byour (?:own )?(?:chrome|browser)\b|\bin (?:your )?chrome\b|\byour [\w.-]+ account\b|\byour account\b/i;
/** A sign-in for the Team Browser itself, not a step in his own browser. */
const TEAM_BROWSER_SIGN_IN = /\bsync again\b|\bpress sync\b|\b(?:team(?:'s)? browser|server browser)\b[^;—]{0,20}\bsigned out\b|\bsign(?:ed|s)?[ -]?in\b[^;—]{0,60}\bin the team(?:'s)? browser\b/i;
/** A line he would type in a terminal: never in a prompt for Claude (root L-54). */
const TERMINAL_LINE = /(?:^|[.;:!?]\s+|\s—\s)(?:\$\s|sudo\s|curl\s|wget\s|git\s|ssh\s|scp\s|python3?\s|node\s|npm\s|npx\s|pnpm\s|brew\s|bash\s|zsh\s|chmod\s|cd\s+[~/.]|export\s+[A-Z_]+=)/i;
/** A secret's value: a known key shape, a long random token, or `password: <value>`. */
const SECRET_VALUE = /\b(?:sk-|sk_live_|ghp_|gho_|github_pat_|xox[abp]-|AKIA)[A-Za-z0-9_-]{8,}|\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b|\b(?:password|passcode|pin|api[ _-]?key|token)\s*[:=]\s*\S+/i;
const WEB = /\bhttps?:\/\/[^\s)\]>"']+|(?<![@\w.\/-])(?:[a-z0-9-]+\.)+(?:com|io|dev|app|net|org|ai|eu|co|me|es|mx)\b(?:\/[^\s)\]>"']*)?/gi;
const BROWSER_FIX =
  "add `— browser: <one plain prompt he pastes into Claude in Chrome: open <the https link>, do <the step>, put the result <where>>` (plain words, never a terminal line or a secret), " +
  "or, when the Mac agent can do it, make it a Mac list ticket (scripts/laptop_ticket.py) and label the ask `needs Mac agent`";
const BROWSER_WHY = '(his voice note vn_e166481b on TAX-A20: "can this type of task, which can be done via Claude with the extension, come with a prompt that I can paste?")';

/** Whether a `do` ask is a step in his own signed-in browser (rule 5b): it links a site and says he signs in there. */
export function isBrowserTask(a: GateAsk): boolean {
  if (a.ask.toLowerCase() !== "do" || a.secret || a.macAgent) return false;
  const all = text(a.question, a.contextText, a.why, a.steps, a.recommend);
  // a sign-in for the Team Browser itself (its "signed out, Sync again") has its own card and flow
  if (!HIS_BROWSER.test(all) || TEAM_BROWSER_SIGN_IN.test(all)) return false;
  return [...all.matchAll(WEB)].some((m) => !SPINE_ON_GITHUB.test(m[0]));
}

/** What is wrong with a prompt for Claude in Chrome; undefined when it is fit to paste. */
export function browserPromptFault(prompt: string): string | undefined {
  const p = prompt.trim();
  if (p.split(/\s+/).filter(Boolean).length < 10) return "its `browser:` prompt is too short: say what to open, what to do and where to put the result";
  if (![...p.matchAll(WEB)].length) return "its `browser:` prompt names no page: put the https link Claude opens first in it";
  if (TERMINAL_LINE.test(p) || /`[^`]+`/.test(p)) return "its `browser:` prompt holds a terminal line: plain words only, Claude in Chrome clicks and types in pages (root L-54)";
  if (SECRET_VALUE.test(p.replace(WEB, " "))) return "its `browser:` prompt holds what looks like a secret: never put a key or password in it, his browser is already signed in";
  return undefined;
}

/**
 * 5b. Why this `do` ask in his own signed-in browser has no prompt he can paste into Claude in Chrome; undefined
 * when it has a fit one, when the Mac agent does it (`needs Mac agent`), or when it is not a browser step.
 */
export function browserPromptProblem(a: GateAsk): string | undefined {
  if (a.state && a.state !== "open") return undefined;
  if (a.since !== undefined && (!a.since || a.since < BROWSER_PROMPT_FROM)) return undefined;
  if (a.browser) {
    const fault = browserPromptFault(a.browser);
    return fault ? `${fault} ${BROWSER_WHY}` : undefined;
  }
  if (!isBrowserTask(a)) return undefined;
  return `it is a step in ${ownerName()}'s own signed-in browser but carries no prompt for Claude in Chrome: ${BROWSER_FIX} ${BROWSER_WHY}`;
}

/** 15. a spine ask raised from ABOUT_FROM with no plain `about:` (E948-S172); the console's own raise writes one. */
export function aboutLineProblem(a: GateAsk): string | undefined {
  if (a.state && a.state !== "open") return undefined;
  if (!a.since || a.since < ABOUT_FROM) return undefined;
  const p = aboutProblem(a.about);
  if (!p) return undefined;
  return p === NO_ABOUT ? `${NO_ABOUT}: ${NO_ABOUT_FIX}` : `${NO_ABOUT}: ${p}; ${NO_ABOUT_FIX}`;
}

/** A button that is only a yes or a no (with its next step: "Yes, build it", "No: drop it"). */
const YES_NO_OPTION = /^\s*(?:yes|no)\b/i;
/** An option that is only a letter or number he must look up elsewhere: "A", "Pick B", "Option 2", "(c)", "Pick A: build A". */
const LETTERED_OPTION = /^\s*(?:(?:pick|option|choose|version|go with|build)\s+)?\(?([A-F]|[1-6])\)?\s*(?:[:.\-–—]\s*(?:(?:pick|option|choose|build|go with|use)\s+)?\(?\1\)?\s*\.?)?\s*$/i;
/** Words that say the options are things to see. */
const SEEN_THINGS = /\b(?:mock-?ups?|layouts?|designs?|logos?|looks?|screens?|screenshots?|pictures?|images?|sidebars?|versions?|drafts?|styles?|colou?rs?|themes?|icons?|banners?|thumbnails?|covers?|variants?|wireframes?|templates?|shapes?|diagrams?|clips?|videos?)\b/i;

/**
 * 13. Why this choice shows none of its options to look at (E948-S151, vn_b2c9395c); undefined when it links or pictures them,
 * or when it is not a choice among things (a yes or no question, fewer than two options).
 */
export function choiceLinkProblem(a: GateAsk): string | undefined {
  if (a.state && a.state !== "open") return undefined;
  if (a.ask.toLowerCase() !== "decide") return undefined;
  if (a.since !== undefined && (!a.since || a.since < CHOICE_LINK_FROM)) return undefined;
  const choices = decideChoices({ ask: "decide", question: a.question, options: a.options, recommend: a.recommend }).options.filter((o) => !YES_NO_OPTION.test(o));
  if (choices.length < 2) return undefined;
  // things he has to see: lettered options, or a choice of mockups, layouts, designs… (a choice in words shows itself)
  const toSee = choices.filter((o) => LETTERED_OPTION.test(o)).length >= 2 || SEEN_THINGS.test(text(a.question, ...(a.options ?? [])));
  if (!toSee) return undefined;
  if (webLinks(a).length) return undefined;
  // a picture or page path the card shows as a link (`context: docs/status/options.webp`), never a spine
  const mdTargets = [...text(a.question, a.contextText, a.recommend, ...(a.options ?? [])).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  if ([a.context, ...mdTargets].some((p) => !!p && DOC_PATH.test(p) && !SPINE_PATH.test(p))) return undefined;
  return (
    `it asks ${ownerName()} to choose between ${choices.slice(0, 4).join(", ")} but shows none of them: link the page or picture of the options ` +
    `(a full https link in the question, \`context:\` or each option; the card shows it on its face, above the buttons; a spine does not count) ` +
    `(his voice note vn_b2c9395c on E940-A10: "If you don't give me a link, how the fuck do you expect me to choose?")`
  );
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
  // 2b. its own quote of his already tells the team to do exactly this (E907-S66)
  const already = hisWordsAlreadyAsk(a);
  if (already)
    return `its own quote of ${ownerName()} already asks for this ("${already.slice(0, 120)}${already.length > 120 ? "…" : ""}"): do it from his words and close the ask as asked, never ask him to approve what he said (root L-56, E907-S66)`;
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
  "irreversible, or the goal itself; an improvement request always quotes his words or names his voice note or log id), any ask re-stating what he already decided, any ask whose own quote of his words already tells the team to do the asked thing (a key result he named, what he said he wants: do it from his words, E907-S66), and any ask carrying a go-live date he did not set (a dated opening, " +
  "a dated batch of posts: the team just goes). From 2026-11-12 it also holds any do or provide ask (his hands) with no \`why " + ownerName() + ":\` saying why the team cannot do it itself, and any whose why rests on his Mac, Chrome or sign-in without saying why the Team Browser or the server browser cannot. It also holds any ask that tells him to paste a value into a private box without a \`secret: <app> <NAME>\` (so its card has no box) or to press Approve on a card with no Approve button (E996-S29). Before it reaches him, a fresh agent with only the card's words and links dry-runs every step (is the exact place named, does it exist now, could it be done from these words alone); any no holds it as \"ask needs rewriting: step N <why>\" (E996-S43). It also holds an ask repeating a question he already answered (\"already answered on <date>: <his answer>\": act on it, or ask only what is new and cite the earlier ask) and one longer than 20 minutes (its effort, the time it names, or 3 minutes a step: \"too long for one sitting: split it\", send only the step that blocks now) (E996-S48). Every ask links to where he acts (E948-S85, his voice note of 12 Nov: \"if I need to do an action, I expect a link\"): a do or provide ask carries the https link of the page, site or form he opens first (a spine on GitHub does not count), unless its own card is the place (a `secret:` box, a needs Mac agent ticket, or it says it is answered on this card or by voice note). A do ask whose step is in his own signed-in browser (download a receipt, change a setting) carries `— browser: <one plain prompt he pastes into Claude in Chrome: what to open, what to do, where to put the result>`, never a terminal line or a secret, or is a needs Mac agent ticket when the Mac agent can do it (his vn_e166481b: \"can this type of task ... come with a prompt that I can paste?\"); an approve or decide ask that sends him to read, open, look at, review or try something links that thing. A decide ask that picks among things he has to see (lettered options A, B or C, or mockups, layouts, designs, logos, screens, versions, drafts) links the page or picture of its options, which its card shows on its face above the buttons (E948-S151, his voice note on E940-A10: \"If you don't give me a link, how the fuck do you expect me to choose?\"). A recommendation he did not ask for is a row or a note for the Delivery Manager, never an ask (root L-56). One outage, one card (his words: \"cards are being duplicated\"): while the console's GitHub sign-in alarm is open it holds every ask in any world about a GitHub token, sign-in, login or key and points it at that one alarm; when the alarm closes, those asks close with it: never raise your own ask for it.";

export interface HeldAsk {
  code?: string;
  repo: string;
  path: string;
  line?: number;
  question: string;
  reason: string;
  /** when the held words were committed (git blame of the line): a hold older than 2 hours is routed on. */
  since?: string;
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

