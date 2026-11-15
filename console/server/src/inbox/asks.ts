import { copyPasteInText } from "../steps/copyPaste.js";
import { ownBoxProblem } from "./phantomRefs.js";
import { ASK_GATE_RULE } from "./askGate.js";
import fs from "node:fs";
import path from "node:path";
import { inside } from "../adapters/doc.js";
import { proseLines, stripInline } from "../adapters/markdown.js";
import { IMPROVEMENT_QUESTION, isImprovementLabel, type Improvement } from "./improvement.js";
import { isPriorityLabel, OBJECTIVE_SEG, priorityAskRule } from "./priorityAsk.js";
import { DEFAULT_OWNER, ownerPatterns } from "../tenancy/owner.js";
import { deployerName, homeRepo, mainHost, opsRepo, ownerName, sites } from "../identity.js";

/**
 * human asks, per the epicspine-skill contract `docs/doctrine/human-asks.md` (v2: step 17, 2068ce7).
 * One line per ask under `## Waiting on` (right after Current State):
 *   - [ask: approve @the owner since 2026-10-21 row S3] <what it does, why> — rollback: … — recommend: … — unblocks: … — effort: ~1 min — context: <link>
 * v6 adds plain-words `context:` (prose, a link optional), `impact:`, `risk:` and `why the owner:` (`why <who>:`); `details:` is a link.
 * `do` stays in the grammar, but only for what the owner alone can physically do (his Mac, browser logins, payments, sign-ups):
 * its `steps:` are never shell commands for him to paste; agents run those themselves (ASK_TYPE_RULES).
 * v1 lines carry no code: `[ask: decide @the owner since 2026-10-21 row T4] …` (code null).
 * Answered, not yet cleaned up:
 *   - [answered 2026-10-22 @the owner] <question> — … — answer: <answer>   (v1: `[answered 2026-10-22 @the owner]`)
 * `spines.py --json` exposes the same list per node as `waiting_on`; `asksFor` prefers it once it carries the v2
 * keys (skill 2026.10.21.7+) and reads the markdown until then.
 */
/**
 * the doctrine every wake and every
 * "ask owner to write asks" request carries. The job of each wake is to move the milestone toward green; an ask is the
 * exception, not the way a wake ends. Three tiers, decided by what the step can undo, not by how big it is.
 */
export const TIER_GOAL =
  "Your job each wake is to move the milestone toward green: end every wake with a step done, not a question. Decide by reversibility, in three tiers.";
export const TIER_DO =
  "Tier do: reversible and inside the epic's goal and the repo's policy (merge per its Integration policy, deploy with a rollback, restart, retry, rerun, " +
  "cleanup per L-5, implementation choices, scheduling, fixing what is broken): just do it, no ask.";
export const TIER_DO_TELL =
  "Tier do + tell: reversible but notable (a production restart, a config change with a rollback, choosing between close options with a recorded recommendation): " +
  "do it, add a Decisions row `decided by <persona>: <what> — why — rollback`, and leave an FYI as an `[answered <CODE> <date> @<persona>] <what> — answer: <what you did> — why: … — rollback: …` line under `## Waiting on` " +
  `(the console shows it as an FYI card ${ownerName()} can reverse in one click). It never blocks you.`;
/** What is in the ask tier; shared by TIER_ASK and the worker brief rule (WORKER_TIER_RULE). */
export const ASK_TIER_ITEMS =
  "irreversible data loss; money: spend beyond a standing approval or a limit recorded in the spine; publishing or contacting third parties; widening security or access " +
  "(new keys, ports, permissions beyond your assignment's write scope); changing an epic's goal or Done means; a one-way door the goal and recorded answers do not settle; " +
  `what only ${ownerName()} can physically do`;
export const TIER_ASK = `Tier ask: ONLY ${ASK_TIER_ITEMS}. Every ask carries a recommendation.`;
export const TIER_BLOCKED =
  `\`blocked\` means ${ownerName()} must act: use it only citing an open ask-tier code (e.g. \`blocked: waits on E904-A3\`). ` +
  "Waiting on a time or a condition (a hold, a window, a scheduled check) is `monitoring`, with `nextCheckAt: <ISO UTC>` (the console wakes you then) and, if known, `until: <ISO UTC>`; " +
  "the console stores a `blocked` that cites no open ask as monitoring. Stuck on anything else: choose, test, document, continue.";
/** an answer that is itself a question ("what are people saying in the app platform GitHub?") is a task for the owner, not a reply to leave sitting. */
export const ANSWER_IS_QUESTION =
  `When ${ownerName()}'s answer to an ask is itself a question (e.g. \"what are people saying in the ${deployerName()} GitHub?\"), it is a research task for you: research it now, ` +
  "write the findings and a recommendation under the ask (`— research: … — recommend: …`), and act on the recommendation if the step is reversible. " +
  "Only re-ask, with the findings and your recommendation, if the step is in the ask tier. Never leave the answer sitting.";
export const TIER_RULES = [TIER_GOAL, TIER_DO, TIER_DO_TELL, TIER_ASK, TIER_BLOCKED, ANSWER_IS_QUESTION];

/** one bare ask code, v1 `` or v2 `` (the `code` spines.py --json gives); the steps kit checks with it too. */
export const ASK_CODE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-A\d+$/;
export const isAskCode = (s: string): boolean => ASK_CODE.test(s);

/** Ask codes (``, ``, `poly-maker/`) a run summary cites; bare codes, lower-cased repo dropped. */
export function citedAskCodes(text: string): string[] {
  return [...text.matchAll(/(?:^|[^\w-])(?:[\w.]+\/)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[Aa]\d+)(?![\w-])/g)].map((m) => m[1].toUpperCase());
}

/** The persona that triages its subtree's open asks; matched by name, like the owner routing in waiting.ts. */
export const isDeliveryManager = (name?: string) => !!name && /delivery[\s-]*manager/i.test(name);

/** how the Delivery Manager answers asks that are not in the ask tier (manager section of its wake prompt). */
export const managerTriageRules = (base: string, milestoneId: string, personaName: string, o: { hasGrants?: boolean } = {}) => {
  const handle = personaName.trim().replace(/\s+/g, "-");
  return [
  `G. Delivery Manager triage (you answer for ${ownerName()} on everything outside the ask tier; run it every wake, before dispatching workers):`,
  `   1. List the open asks in your subtree: the \`[ask …]\` lines under \`## Waiting on\` of its spines, and \`curl -sS '${base}/api/waiting-on-owner?milestoneId=${milestoneId}'\` (entries with \`state: open\`).`,
  `   2. For each ask that is NOT in the ask tier above, answer it yourself, do not leave it to ${ownerName()}: rewrite its tag to ` +
    `\`[answered <CODE> <YYYY-MM-DD> @${handle}]\` and append \` — answer: <what> — why: <reason> — rollback: <how to undo>\`; add a Decisions row ` +
    `\`decided by ${personaName}: <what> — why — rollback\`; then act on it (the owner or you). Asks you answer show to ${ownerName()} as an FYI card he can reverse in one click.`,
  `   3. Keep at most 3 ask-tier items for ${ownerName()}: merge asks one action resolves, order by the critical path, each with a recommendation. Never answer an ask that is in the ask tier.`,
  "   4. Delete the `[answered …]` lines you and your workers have acted on, or mark them `· done <YYYY-MM-DD> <sha>` inside the tag.",
  `   5. An \`[answered … @${ownerName()}]\` line whose answer is itself a question is yours to run: research it, write the findings and a recommendation under the ask, act if reversible, re-ask (with the recommendation) only if it is in the ask tier.`,
  ...(o.hasGrants ? [] : [KICKOFF_RULE]),
  ];
};

/**
 * kickoff look-ahead (epicspine-skill docs/doctrine/standing-approvals.md "Kickoff pattern"): only in a manager wake
 * whose milestone has no active grants.
 */
export const KICKOFF_RULE =
  "   6. Kickoff look-ahead: this milestone has no active standing approvals. If its plan needs accounts, infra it owns, spend or test-only side effects, " +
  "propose them as ONE `approve` ask whose question carries the bundle (one line per proposed grant: scope, limits). On approval write them as " +
  `\`- [grant <CODE>-G<n> @${ownerName()} since <date>] <scope> — limits: …\` lines under \`## Standing approvals\` (right after \`## Waiting on\`). ` +
  "Never put publishing, live money or shared infra in the bundle; propose those only by name.";

/** the persona that answers open asks (docs/personas/unblocker.md); matched by name like the Delivery Manager. */
export const isUnblocker = (name?: string) => !!name && /unblocker/i.test(name);

/** the `checks` example in section U (the run's finishing PATCH). */
export const UNBLOCKER_CHECKS_EXAMPLE = [
  { code: "E900-A6", decision: "answered", answer: "yes, add the line", confidence: 85, source: "E900-G3 grant", why: "app's own role on its own db", spine: "docs/EPIC-900-ROOT.md:42" },
  { code: "E900-A7", decision: "left", why: "publishing: in the floor", spine: "docs/EPIC-900-ROOT.md:43" },
];
/** the example with the rubric's scores (and a floor item on the left one). */
export const UNBLOCKER_RUBRIC_CHECKS_EXAMPLE = [
  { ...UNBLOCKER_CHECKS_EXAMPLE[0], scores: { reversal: 4, options: 3, impact: 3, evidence: 4 } },
  { ...UNBLOCKER_CHECKS_EXAMPLE[1], scores: { reversal: 1, options: 2, impact: 1, evidence: 2 }, floor: ["new_public_exposure"] },
];
/** ask codes compared bare and upper-case (`whatgpt_v3/` = ``). */
const bareCode = (c: string) => c.trim().replace(/^.*\//, "").toUpperCase();

/**
 * why an Unblocker's finishing PATCH is not acceptable, or undefined when it is. `open` = the asks open when its
 * wake prompt was built; `checks` must carry one entry per code, and a `left` ask of kind provide must say what it
 * `searched` (an existing credential, or a path that needs none). Messages tell the agent exactly what to resend.
 */
export function unblockerChecksProblem(
  open: { code: string; kind: string }[],
  checks: { code: string; decision: string; searched?: string }[] | null | undefined,
): string | undefined {
  if (!open.length) return undefined;
  const byCode = new Map((checks ?? []).map((c) => [bareCode(c.code), c]));
  const missing = open.filter((a) => !byCode.has(bareCode(a.code))).map((a) => a.code);
  if (missing.length)
    return `checks must carry one entry per ask open at wake time (${open.map((a) => a.code).join(", ")}); missing: ${missing.join(", ")}. ` +
      "Look at each, then resend the PATCH with all of them in `checks` (decision answered|split|left).";
  const unsearched = open
    .filter((a) => a.kind === "provide" && byCode.get(bareCode(a.code))?.decision === "left" && !byCode.get(bareCode(a.code))?.searched?.trim())
    .map((a) => a.code);
  if (unsearched.length)
    return `left provide asks need \`searched\`: what you checked for an existing credential or a no-credential path (${unsearched.join(", ")}). ` +
      "Run those read-only checks, then answer the ask or resend with `searched` filled in.";
  return undefined;
}

/**
 * the Unblocker's answering rules, in code so its remit can shrink to a line (docs/personas/unblocker.md steps 1-5).
 * It never raises asks of its own except the remainder of a SPLIT, and never rewrites asks (root L-14).
 */
export const unblockerRules = (
  base: string,
  milestoneId: string,
  managerAssignmentId?: string,
  openAsks?: { code: string; kind: string; path?: string; line?: number; carriedFrom?: string }[],
  /** the confidence rubric's decision rule (cycle/rubric.ts rubricRules); absent = the old 75% rule (tests of older sections). */
  rubric?: string[],
) => [
  "U. Read this whole prompt; it changes between wakes. Do not rely on earlier wakes.",
  `   Unblocker: you only ANSWER open asks to ${ownerName()} when the answer is clear; never rewrite or rephrase an ask (root L-14), never do the work,`,
  "   and raise no ask of your own except the remainder of a SPLIT. This replaces C for you. Every wake:",
  `   1. List open asks of this milestone's tree: \`[ask …]\` lines under \`## Waiting on\` of its spine and child spines, and \`curl -sS '${base}/api/waiting-on-owner?milestoneId=${milestoneId}'\` (state open).`,
  ...(rubric
    ? [
        "   2. For each new or changed ask (listed under 5; unchanged ones are carried), decide ANSWER, SPLIT or LEAVE.",
        ...rubric,
        `      SPLIT when one ask folds several things: answer the parts that clear the rubric (score that part); leave only the truly blocking ${ownerName()} part as one new`,
        "      ask line (next free code), phrased plainly (L-14); drop parts that are future steps (L-13: asked only when next). LEAVE otherwise: write nothing.",
      ]
    : [
        "   2. For each new or changed ask (listed under 5; unchanged ones are carried), decide ANSWER, SPLIT or LEAVE. Never answer inside the floor: irreversible data loss; live money or spend beyond a recorded limit or grant;",
        "      publishing or contacting third parties; widening security or access beyond the active grants (section F); changing a Goal or Done means;",
        `      a one-way door the goal and recorded answers do not settle; what only ${ownerName()} can physically do (his Mac, phone, browser logins, payments, QR scans).`,
        `      ANSWER otherwise when at least 75% confident, citing a source: the epic's Goal / Done means / Non-Goals, a standing approval, a past answer of ${ownerName()}'s`,
        `      (Decisions rows, \`[answered … @${ownerName()}]\` lines), an Operating Learning, or infra guidance (${opsRepo()} docs). Prefer the narrower, reversible answer.`,
        `      SPLIT when one ask folds several things: answer the parts you can; leave only the truly blocking ${ownerName()} part as one new ask line (next free code),`,
        "      phrased plainly (L-14); drop parts that are future steps (L-13: asked only when next). LEAVE when in the floor or under 75%: write nothing.",
      ]),
  "      An ask that is really an end-of-turn offer (\"want me to do 2, 3, or leave it?\") is answered by root L-16: ANSWER yes with what to do",
  "      when it moves the goal toward green, closes a known defect or completes the work just done; else no, with one line why.",
  "   3. Write each answer in the spine: tag `[answered <CODE> <YYYY-MM-DD> @Unblocker]`, append",
  "      ` — answer: <what> — why: <reason> — source: <where> — confidence: <n>% — rollback: <how to undo>`; add a Decisions row",
  `      \`decided by Unblocker: <what> — why — rollback\`. Commit and push per the repo's policy. ${ownerName()} sees each as an FYI card he can reverse.`,
  ...(managerAssignmentId
    ? [
        "   4. If you answered or split anything, wake this milestone's Delivery Manager (its assignment is switched on; root L-10) so it acts now:",
        `      \`curl -sS -X POST '${base}/api/assignments/${managerAssignmentId}/run-now' -H 'content-type: application/json' -d '{"note":"Unblocker answered <codes>: act on them","noteBy":"Unblocker"}'\` (409 already_running is fine).`,
        "      If you answered nothing, wake no one.",
      ]
    : ["   4. This milestone has no switched-on Delivery Manager assignment: wake no one (root L-10)."]),
  "   5. Finish (section E) `progressed` if you answered or split anything, else `idle`; summary `answered <n> · left <m>` plus the codes answered.",
  `      Your finishing PATCH must carry \`checks\`, one entry per new or changed ask at this wake (${ownerName()} sees each in Activity), e.g.`,
  `      \`"checks":${JSON.stringify(rubric ? UNBLOCKER_RUBRIC_CHECKS_EXAMPLE : UNBLOCKER_CHECKS_EXAMPLE)}\``,
  "      decision answered|split|left; answered/split: answer (plain words), confidence (0-100), source; left: why (floor item or what is unclear);",
  ...(rubric
    ? [
        "      every assessed ask (answered, split or left) carries `scores` {reversal, options, impact, evidence} (integers 0-4) and `floor` (the hard-floor ids",
        "      it touches, omitted when none); the console stamps the score and threshold on the check and rejects (400 rubric) an answer that does not clear it;",
      ]
    : []),
  "      a left ask of type provide (credential, key, account) also carries `searched`: the read-only checks you ran for an existing credential or",
  "      a path that needs none (step 2). spine: the repo-relative spine path and line of the ask (`<path>:<line>`).",
  ...(openAsks ? unblockerAskList(openAsks) : []),
];

/**
 * the open asks of this wake, split by the per-ask memory: assess the new or changed ones; the unchanged ones
 * are carried (`left (unchanged since <run>)`, filled in by the console), not assessed again.
 */
function unblockerAskList(openAsks: { code: string; kind: string; path?: string; line?: number; carriedFrom?: string }[]): string[] {
  const where = (x: { kind: string; path?: string; line?: number }) => `${x.kind}${x.path ? `, ${x.path}${x.line ? `:${x.line}` : ""}` : ""}`;
  const fresh = openAsks.filter((x) => !x.carriedFrom);
  const carried = openAsks.filter((x) => x.carriedFrom);
  if (!openAsks.length) return ["      No ask was open at this wake: finish `idle` with `checks: []`."];
  return [
    fresh.length
      ? `      New or changed at this wake (assess each): ${fresh.map((x) => `${x.code} (${where(x)})`).join("; ")}.`
      : "      No ask is new or changed at this wake: assess none; finish `idle` with `checks: []`.",
    ...(carried.length
      ? [
          `      Unchanged since they were assessed (do not assess again; the console carries each as \`left (unchanged since <run>)\`): ${carried.map((x) => `${x.code} (since ${x.carriedFrom})`).join("; ")}.`,
          `      The console remembers each ask and re-opens it only when its line, a grant, ${ownerName()}'s comment or its linked evidence changes;`,
          "      assess a carried one only if your instructions name it (your own check entry then replaces the carried one).",
        ]
      : []),
    "      The console rejects (400 checks_incomplete) a finishing PATCH whose checks miss any new or changed code, or a left provide ask without `searched`;",
    "      read the error, do what it says and resend.",
  ];
}

/**
 * Which ask type to raise, shared by the persona wake prompt and the "ask owner to write asks" request.
 * Tier first: most steps are not asks at all. Since the infra repo eb3952e the service user has passwordless sudo on the main server
 * (L-F5, the code repo root L-8): agents run shell/root steps.
 */
/**
 * (root L-16, the owner 2026-10-24 on a turn ending "Do you want me to do 2, 3, both, or leave it here?"):
 * an end-of-turn offer is an ask in disguise (epicspine human-asks v7). In every worker brief, the wake's closing step and the Unblocker.
 */
/**
 * the repo is the only source. Every wake and every worker brief carries this sentence.
 */
export const REPO_IS_SOURCE_RULE =
  "Decisions and state go into the spine, never only into the console's API or DB: the console's database is only a cache of the repo (root L-45).";

export const FINISH_THE_JOB_RULE =
  "Finish the job (root L-16): never end a turn offering follow-ups (\"want me to do X?\"). Do them now when they move the goal toward green, " +
  "close a known defect, or complete or clean up the work just done (loose ends, docs, leftovers); an unrequested nice-to-have that unblocks " +
  "nothing gets one line and is dropped; ask-tier items stay asks.";
/**
 * (root L-59, the owner 2026-11-12 on a review card: "why don't you use a lot more diagrams and boxes ... it's a lot of text and heavy text"):
 * every page, card evidence, report and proposal leads with its answer and shows it, prose last. In every worker brief and the wake's closing step;
 * `scripts/text_wall_check.py` flags a new page that breaks it (advisory, pre-commit and the wake's checks).
 */
export const VISUAL_FIRST_RULE =
  `Show, don't write walls (root L-59): every page, card evidence, report, proposal and status page you make for ${ownerName()} opens with its one-line answer (the punchline), ` +
  "then a diagram or boxed summary in the first screen (boxes and arrows: a flow, a before and after, a table of ✓/✗; draw it with the house-diagram-style skill, " +
  "the diagram-design skill for a named diagram type, the paper-deck skill for a deck or explainer page), " +
  "prose only for what a picture cannot say, short paragraphs after it. Every page you serve on the page host is built on the one shared page shell " +
  `(\`python3 scripts/page_shell.py new <dir> --title … --punchline … --row <row>\` in ${homeRepo()}: paper header, punchline box, diagram slot, the bar up to its parent), so every page looks the same. ` +
  "Pick the shape that carries the idea: a cycle or wheel as a circle, a sequence as boxes in one line, a hierarchy as a tree, a comparison side by side; " +
  "never a default grid of boxes (house-diagram-style layouts cycle, flow, tree, compare; the shell's `--shape cycle|line`). " +
  `Easy calls (an obvious choice inside the goal) you build, ship to production and show ${ownerName()} live; a heavy one (architecture, a one-way door, a change across products) comes as one proposal page ` +
  "(`python3 scripts/page_shell.py proposal`: the bottom line at the top and the bottom, the diagram, mock-ups, the changes, implications, our recommendation). " +
  "Your own chat reports and run summaries lead the same way: the answer in one line, then boxes, never a wall of bullets. " +
  "Before you hand over a page run `python3 scripts/text_wall_check.py <page>` " +
  `in ${homeRepo()} (it flags a text wall and a diagram whose shape misleads); fix what it names. The review gate holds a card whose evidence page opens with text ("needs evidence"). ` +
  // (the owner's voice note vn_c23abab6 on a plan card: "when you tell me a plan, I expect to see a diagram")
  `A plan (a card, page or reply telling ${ownerName()} what we will do) opens with one drawn diagram of the idea, before anything else, and little text after it: boxes of text or a table are not a diagram, and the review gate sends a plan card whose page has no drawn diagram before its first 80 words back ("needs evidence"). ` +
  // (the owner 2026-11-12: "I have like a strong predilection for simple UX ... make it clean and, like, sophisticated")
  "Clean, simple, sophisticated: every page, screen and site you make looks calm and few: one thing per screen, flat surfaces (no gradients, no shadows at rest), " +
  "colour only on data and the one action, two or three typefaces, no emoji or ornaments, nothing squeezed on a phone; take the look from the skills, never invent one " +
  "(pages: paper-deck; app screens: design-taste-frontend's references/app-screens.md; a new site: hallmark). " +
  `Check it with \`python3 scripts/clean_look_check.py <page>\` in ${homeRepo()}, or \`--screens\` after you change a product screen (each product's home and inbox at phone, tablet and laptop size); fix what it names.`;
/**
 * steps for the owner carry their own feedback. Every worker brief says so;
 * how to include the kit: docs/steps-kit.md.
 */
/**
 * never terminal lines for the owner to copy, never
 * a Claude CLI command: a Mac-agent ticket whose bootstrap text he pastes into the Claude app; a command left says where it runs.
 */
export const NO_COPY_PASTE_RULE =
  `Never hand ${ownerName()} terminal lines to copy (root L-54). First ask whether a command is needed at all: run it yourself on the server. ` +
  "Work that needs his Mac is a Mac-agent ticket (`scripts/laptop_ticket.py`, on the Mac list): bootstrap TEXT he pastes into a new session of the Claude app on his Mac " +
  "(locate the repo, bind as the persona, run the job, report back), which runs the commands itself and asks his OK; never a `claude` CLI command, never a code block to copy. " +
  "A command that truly must stay his says in large words exactly where it runs (\"On your Mac, in the Terminal app\" or \"On a server\"; `data-runs-on` on a steps page) and is tested in zsh and bash first. " +
  "The console refuses a steps page or an ask that holds copy-paste terminal lines (422 copy_paste_steps).";
export const STEPS_PAGE_RULE =
  `Steps for ${ownerName()} go out as a steps page on the steps kit (Done / Stuck / note per step), never a text blob (each note box has a voice button and no length limit): ` +
  "register the page once (`POST /api/steps/pages` {title, url, repo, spine} returns its token), put the token in a gitignored " +
  "`steps-token.js` beside it (`window.STEPS_TOKEN = \"…\";`), load `/steps-kit.css` and `/steps-kit.js` from the console and mark each step " +
  `\`<section data-step=\"<id>\" data-row=\"<row>\">\` (or \`data-ask\`); how-to and example: ${homeRepo()} docs/steps-kit.md. ` +
  NO_COPY_PASTE_RULE;
/** Root L-8; also in every worker brief (WORKER_TIER_RULE). */
export const NO_COMMANDS_RULE =
  `Never ask ${ownerName()} to run commands: run shell and root steps yourself (on ${mainHost().toUpperCase()} with \`sudo\`; from other hosts via \`ssh ${sites().mainSsh}\`).`;
/**
 * (root L-14 amended, the owner 2026-10-24 on whatgpt: "I need context, impact, risk, guidance in human format"):
 * the fields every ask carries in plain words; the console card shows them as labelled sections (epicspine human-asks v6).
 */
export const HUMAN_FORMAT_RULE =
  "Every ask carries, in plain words a non-engineer understands: `context:` why this comes up; `impact:` what it unblocks and the cost of waiting; " +
  `\`risk:\` what could go wrong if yes, and the rollback; \`recommend:\` your recommendation and why; \`why ${ownerName()}:\` why an agent cannot decide it ` +
  "(goal, money, exposure, or only his hands; root L-15). Commands, ids and jargon go in `steps:` or a context link, never in those fields.";
/** the ask line format (section C of the wake protocol). */
export const ASK_LINE_FORMAT =
  `\`- [ask <CODE>: decide|approve|provide|do @${ownerName()} since <YYYY-MM-DD> row <id>] You approve|decide|do: <one thing> Why: <one line> — context: <why this comes up> — ` +
  `impact: <what it unblocks, cost of waiting> — risk: <what could go wrong if yes; rollback> — recommend: <what and why> — why ${ownerName()}: <why not an agent> — ` +
  "options (decide) / steps (do): … — secret (provide a key): <app> <NAME> — unblocks: <rows> — details: <link>`";
/**
 * how whoever raises an ask writes it; in ASK_TYPE_RULES (every persona) and WORKER_TIER_RULE
 * (every worker's proposed ask). whatgpt_v3 folded keys, a token widening, a redirect and a future QR scan in one ask.
 */
export const ASK_WRITING_RULE =
  "Writing an ask: ask only for the step that blocks now, never a later step (a scan 'when pinged', keys 'before Wave 2' stay plan text until next). " +
  `Lead with the decision in plain words: what, why it matters, your recommendation, so ${ownerName()} can answer in seconds; ids, jargon and steps after. ` +
  "One decision per ask; never fold non-blocking extras into a blocking ask.";
/**
 * the question opens with one line by kind and a one-line why; his inbox card shows that line big and folds the rest.
 */
export const ASK_LEAD_RULE =
  "An ask's question opens with one line by kind, `You approve: <one thing>`, `You decide: <A or B>`, `You do: <one action>` or `You give: <the key>`, " +
  "then `Why: <one line>`; his card shows that line big and folds the rest (root L-56). `You decide` is for a real decision only: " +
  "when you are unsure what he MEANS, never make it a choice for him; the Team desk asks him one open question he answers by voice note " +
  "until it can restate him in one sentence (root L-66).";
/**
 * a key ask carries `secret:` and the console card stores the pasted key with the infra repo `secret put`.
 */
export const KEY_ASK_RULE =
  "Keys (API keys, tokens, passwords): first run `secret find <provider>` on " + mainHost().toUpperCase() + " (from other hosts `ssh " + sites().mainSsh + " secret find <provider>`; " +
  `${homeRepo()} AGENTS.md \"Secrets\") and reuse what is there; ask only when it is empty. A key ask is \`provide\` and carries ` +
  "`secret: <app> <NAME>` (e.g. `secret: whatgpt-service STRIPE_SECRET_KEY`): the console card then shows a private paste box and stores the key with " +
  `\`secret put\` (and sets it in ${deployerName()}). Say in one plain step what to create where (e.g. \"create a restricted Stripe key with write on Checkout\"); ` +
  `never tell ${ownerName()} to paste it into ${deployerName()}, a dashboard env page, a file or the chat.`;
export const ASK_TYPE_RULES = [
  ...TIER_RULES,
  ASK_WRITING_RULE,
  ASK_LEAD_RULE,
  HUMAN_FORMAT_RULE,
  NO_COMMANDS_RULE,
  KEY_ASK_RULE,
  "Irreversible, data-deleting, access-widening or production-config steps in the ask tier are an `approve` ask: say what it does, why, and the rollback;",
  `after ${ownerName()} approves, YOU run it and record the result. Use \`do\` only for what only ${ownerName()} can physically do (his face or voice, his phone, payments, his identity); a form, a sign-up or a sign-in goes to the Team Browser or the server browser first, and only what they cannot do reaches him, its \`why ${ownerName()}:\` saying what stopped them.`,
  ASK_GATE_RULE,
  priorityAskRule(ownerName()),
];

export type AskKind = "decide" | "approve" | "provide" | "do" | "unknown";

/** the infra repo `secret put <app> <NAME>`: app = lower-case slug, NAME = an env var name. */
export interface SecretTarget {
  app: string;
  name: string;
}

/** `secret: whatgpt-service STRIPE_SECRET_KEY` (backticks, `/` or `:` between them tolerated) → target; anything else → undefined. */
export function parseSecretTarget(val: string): SecretTarget | undefined {
  const m = /^\s*`?\s*([a-z0-9][a-z0-9._-]*)\s*(?:\s|\/|:)\s*([A-Za-z_][A-Za-z0-9_]*)\s*`?\s*\.?\s*$/i.exec(stripInline(val));
  if (!m) return undefined;
  return { app: m[1].toLowerCase(), name: m[2].toUpperCase() };
}

/** Shape of one `waiting_on` entry in `spines.py --json` (contract §In spines.py --json). */
export interface HumanAsk {
  /** v2 `<epic code>-A<n>` (e.g. ``, ``); null on v1 lines. */
  code: string | null;
  who: string;
  ask: AskKind;
  question: string;
  options: string[];
  recommend: string | null;
  /** Repo-relative path (anchor kept) or URL. */
  context: string | null;
  /** `context:` in plain words (why this comes up), when it is prose rather than a bare link. */
  contextText?: string | null;
  /** what it unblocks and the cost of waiting. */
  impact?: string | null;
  /** what could go wrong if yes, and the rollback. */
  risk?: string | null;
  /** `why the owner:` (`why <who>:`): why an agent cannot decide it. */
  why?: string | null;
  /** `secret: <app> <NAME>` on an ask of any kind: where the key goes (the console card shows a private paste box; E996-S29: any kind, not only provide). */
  secret?: SecretTarget | null;
  since: string | null;
  row: string | null;
  state: "open" | "answered";
  answer: string | null;
  /**
   * `[feedback <code> <date> @the owner] … — feedback: <his words>`: the owner wants changes, never an approval. Read as
   * answered (no longer waiting on him) with the words in `answer`; the work it names is reopened and owed a new round.
   */
  feedback?: boolean;
  /** v2: exact commands or a runbook link, plus host and user (required for `do`). */
  steps: string | null;
  /** v2: which rows proceed once answered, and the cost of waiting (required for every type). */
  unblocks: string | null;
  /** v2, optional: e.g. `~10 min`. */
  effort: string | null;
  /**
   * done marker on an answered line: `[answered 2026-10-22 @the owner · done 2026-10-23 abc1234]`. Present = the
   * owner acted on the answer (consumed): "" when the marker carries no date. `doneSha` is the commit that did the work.
   */
  doneAt?: string;
  doneSha?: string;
  /** spines.py state `superseded` (`[superseded <date> by]`): the replacing code; read like done (`doneAt` ""). */
  supersededBy?: string;
  /** `— snoozed until: <YYYY-MM-DD>` (or `<YYYY-MM-DD>THH:MMZ`) on an open ask: the owner snoozed it; the inbox hides it until then (it stays open). */
  snoozedUntil?: string;
  /**
   * `— label: needs Mac agent` on an open ask: Claude on the owner's Mac does it from its ticket (the Mac list,
   * scripts/laptop_ticket.py). It stays open but leaves the inbox count for the Mac list, like a snooze with no date.
   */
  macAgent?: true;
  /** `— label: improvement request` with `— to: <world>`, `— campaign: …`, `— done means: …` (inbox/improvement.ts). */
  improvement?: Improvement;
  /**
   * `— label: priority` with `— objective: <pursuit id>` (the owner, vn_cdcf1208): one of his notes named a new first
   * thing, so the team asks one line, "Put X first in your objectives?". The inbox pins it above everything; his Yes moves
   * that objective to the top of docs/pursuits.json (inbox/priorityAsk.ts), his No closes it.
   */
  putFirst?: { objective: string };
  /**
   * who approves the answer (`approve by @Marta`): the row stays blocked until they do.
   * `aware`: who hears the outcome without acting (`aware @the owner, @Sofia`). `escalatedBy`: who passed it up (`escalated
   * by @Leo`, Not sure or the time limit), with their note in `— escalated: …`.
   */
  approveBy?: string;
  aware?: string[];
  escalatedBy?: string;
  escalatedNote?: string;
  /** two-step approval: `[answered <code> <date> @Leo · awaits @Marta]` (answered, not yet approved). */
  awaits?: string;
  /** `[answered <code> <date> @Leo · approved @Marta <date>]`: the approver said yes; the answer counts. */
  approvedBy?: string;
  approvedAt?: string;
}

/** `@Leo`, `Leo`, `@Leo,` → `Leo`. */
const handle = (h: string) => h.replace(/^@/, "").replace(/[,;.]+$/, "");
/** the many-humans parts of an ask tag (open or answered), or nothing. */
export function peopleOfTag(tag: string): Pick<HumanAsk, "approveBy" | "aware" | "escalatedBy" | "awaits" | "approvedBy" | "approvedAt"> {
  const out: ReturnType<typeof peopleOfTag> = {};
  const approve = /\bapprove\s+by\s+@([^\s\],;·]+)/i.exec(tag);
  if (approve) out.approveBy = handle(approve[1]);
  const aware = /\baware\s+((?:@[^\s\],;·]+(?:\s*,\s*)?)+)/i.exec(tag);
  if (aware) out.aware = aware[1].split(/\s*,\s*/).map(handle).filter(Boolean);
  const esc = /\bescalated\s+by\s+@([^\s\],;·]+)/i.exec(tag);
  if (esc) out.escalatedBy = handle(esc[1]);
  const awaits = /·\s*awaits\s+@([^\s\],;·]+)/i.exec(tag);
  if (awaits) out.awaits = handle(awaits[1]);
  const ok = /·\s*approved\s+@([^\s\],;·]+)(?:\s+(\d{4}-\d{2}-\d{2}))?/i.exec(tag);
  if (ok) {
    out.approvedBy = handle(ok[1]);
    if (ok[2]) out.approvedAt = ok[2];
  }
  return out;
}
/** `— escalated: <who's note>` on an ask passed up by Not sure or the time limit. */
const ESCALATED_SEG = /^\s*escalated\s*:\s*(.*)$/i;

/** HumanAsk plus where it sits in the file (0-based line; undefined when it came from spines.py and was not found). */
export type LocatedAsk = HumanAsk & { line?: number; contextLabel?: string; /** Runbook link inside `steps:` (resolved like context). */ stepsLink?: string };

const TAG = /^\s*[-*]\s+\[(ask|answered|feedback)\b([^\]]*)\]\s*(.*)$/i;
const SEGMENT = /\s+(?:—|--)\s+/;
/** Open tag after `ask`: `: do …` (v2) or `: decide …` (v1). */
const OPEN_TAG = /^\s*([^\s:\]]+)?\s*:\s*(decide|approve|provide|do)\b/i;
/** Answered tag after `answered`: ` 2026-10-22 @the owner` (v2) or ` 2026-10-22 @the owner` (v1). */
const ANSWERED_TAG = /^\s*(?:(?!\d{4}-\d{2}-\d{2})([^\s@\]]+)\s+)?(\d{4}-\d{2}-\d{2})?/;
/** `· done 2026-10-23 abc1234` (date and sha optional) inside an answered tag; `·`, `|` or `;` separate it. */
export const DONE_MARKER = /(?:^|[\s·|;,])done(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+([0-9a-f]{6,40}))?\s*$/i;
/** D19 consumed-answer marker at the end of an `[answered …]` line: `… — answer: APPROVED · done 2026-10-22 7efe0ee` (date and sha optional). */
const LINE_DONE = /\s+[·|;]\s*done(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+([0-9a-f]{6,40}))?\s*$/i;
/** The skill's own reading (ask_refs.py DONE): ` · done <date>` then an optional sha and a free note, e.g. `· done 2026-11-09 905b4fe round 2`. */
const LINE_DONE_NOTE = /\s+·\s*done\s+(\d{4}-\d{2}-\d{2})(?:\s+([0-9a-f]{6,40}))?\b.*$/i;
const MD_LINK =/\[([^\]]*)\]\(([^)\s]+)\)/;
const WAITING_SECTION = /^waiting on\b/i;
/** a snooze-until value: a day (`2026-11-08`, hidden until that UTC day) or, a UTC minute (`2026-11-02T18:30Z`, a 3 hour snooze). */
export const SNOOZE_UNTIL = String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}Z)?`;
/** the snooze field of an ask line, `snoozed until: 2026-11-08` (also `snoozed: 2026-11-08`; or `2026-11-02T18:30Z`). */
export const SNOOZE_SEG = new RegExp(String.raw`^\s*snoozed(?:\s+until)?\s*:\s*(${SNOOZE_UNTIL})\b.*$`, "i");
/** the same field as it sits on a line (` — snoozed until: <date>`), for skills whose parser glues it to the previous field. */
export const SNOOZE_ON_LINE = new RegExp(String.raw`\s+(?:—|--)\s+snoozed(?:\s+until)?\s*:\s*${SNOOZE_UNTIL}\b[^—]*?(?=\s+(?:—|--)\s+|$)`, "i");
/** the one label for work done by Claude on the owner's Mac (row Role `Mac agent`, ask field `label: needs Mac agent`). */
export const MAC_AGENT_LABEL = "needs Mac agent";
/** the label field of an ask line, `label: needs Mac agent`. */
export const LABEL_SEG = /^\s*label\s*:\s*(.+?)\s*$/i;
/** the same field as it sits on a line, for spines.py, which glues an unknown field to the one before it. */
export const LABEL_ON_LINE = /\s+(?:—|--)\s+label\s*:\s*needs\s+mac\s+agent\b[^—]*?(?=\s+(?:—|--)\s+|$)/i;
export const isMacLabel = (v: string) => /^needs\s+mac\s+agent$/i.test(stripInline(v).trim());
/** a question that starts with the label ("needs Mac agent: …", the form other worlds wrote first) counts too. */
export const MAC_QUESTION = /^\W*needs\s+mac\s+agent\b/i;
/**
 * a snoozed ask is hidden from the inbox and every count until its day (date-only: until that UTC day starts);
 * until its minute when it carries one. `now` is a time (ms) or, as before, today's `YYYY-MM-DD`.
 */
export function snoozedNow(until: string | undefined, now: number | string = Date.now()): boolean {
  if (!until) return false;
  const t = typeof now === "number" ? now : Date.parse(now.length === 10 ? `${now}T00:00:00Z` : now);
  if (until.length === 10) return until > new Date(t).toISOString().slice(0, 10);
  const u = Date.parse(until);
  return Number.isFinite(u) && u > t;
}
/** `hours` from now as the UTC minute a snooze line carries (`2026-11-02T18:30Z`), rounded up to the minute. */
export const snoozeMinute = (hours: number, now = Date.now()) => new Date(Math.ceil((now + hours * 3_600_000) / 60_000) * 60_000).toISOString().slice(0, 16) + "Z";

/**
 * E948-S60 (E946-A29 showed its three options as one radio line): the contract writes `options: A | B`; asks also come
 * with ` · ` between the options (`A posts out on time · B people talking to us · your own number`). A pipe wins; with
 * no pipe, a spaced middle dot splits them.
 */
export const OPTION_DOT = /\s+·\s+/;
const splitOptions = (text: string) =>
  lettered(
    text
      .split(/\||\\\|/.test(text) ? /\s*(?:\\\||\|)\s*/ : OPTION_DOT)
      .map((o) => stripInline(o))
      .filter(Boolean),
  );

/**
 * The contract writes `options: A | B`, but asks also come as one lettered list (`(a) yes, done; (b) no, say what`,
 *): read that as one option per marker, markers kept, so the card gets one button each instead of
 * `missing: options` and an answer that quotes the whole list. Markers must run (a), (b), … or (1), (2), … in order; the
 * bare form `A) …; B) …` reads the same (came as one option and a card with no buttons).
 */
export function lettered(options: string[]): string[] {
  if (options.length !== 1) return options;
  // E948-S60: one option holding ` · ` between options (E946-A29, read by spines.py as one) is that many options.
  const dots = options[0].split(OPTION_DOT).map((o) => o.trim()).filter(Boolean);
  if (dots.length > 1) return dots;
  // E948-S69 (E946-A31: `options: yes as it stands; yes with changes said in the page's feedback box; no` came as one option
  // and its Decide card showed only feedback): 2 to 4 short parts between `; ` are that many options.
  // E948-S69: so do 2 to 4 parts between spaced slashes (another world's ask: `yes as shown (…) / no (…)`).
  for (const sep of [/\s*;\s+/, /\s+\/\s+/]) {
    const parts = options[0].split(sep).map((o) => o.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.length <= 4 && parts.every((o) => o.split(/\s+/).length <= 25) && !parts.some((o) => /^\(?(?:[a-z]|[1-9])\)\s/i.test(o))) return parts;
  }
  const parts = options[0].split(/\s*[;,]?\s+(?=(?:\((?:[a-z]|[1-9])|\b(?:[a-z]|[1-9]))\)\s)/i).map((o) => o.replace(/[;,]\s*$/, "").trim()).filter(Boolean);
  if (parts.length < 2) return options;
  const ok = parts.every((p, i) => {
    const m = /^\(?([a-z]|[1-9])\)\s/i.exec(p);
    return m && (m[1].toLowerCase() === String.fromCharCode(97 + i) || m[1] === String(i + 1));
  });
  return ok ? parts : options;
}

/**
 * Local context link → repo-relative path: relative to the spine's folder when that file exists, else as written
 * from the repo root (the contract's own example is repo-relative). URLs pass through.
 */
export function resolveContext(target: string, specRel: string, repoDir?: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  const [file, anchor] = target.split("#");
  if (!file) return `${specRel}#${anchor ?? ""}`;
  const fromSpine = path.posix.normalize(path.posix.join(path.posix.dirname(specRel), file));
  const asWritten = path.posix.normalize(file.replace(/^\/+/, ""));
  const exists = (rel: string) => {
    const abs = repoDir ? inside(repoDir, rel) : undefined;
    return !!abs && fs.existsSync(abs);
  };
  const rel = exists(fromSpine) || !exists(asWritten) ? fromSpine : asWritten;
  return anchor ? `${rel}#${anchor}` : rel;
}

/** A bare link target: a URL, or one token that looks like a path (has `/`, `#` or a file extension). */
const isLinkish = (t: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^[^\s]*(?:\/|#|\.\w{1,5}(?:#|$))[^\s]*$/.test(t);

/**
 * `context:` value → a link (markdown link, or a bare path/URL) and the plain-words text around it. v2 lines carry only
 * a link (`context: docs/x.md#y`, text null); v6 lines carry prose (`context: the app cannot reach its db [runbook](docs/x.md)`).
 */
export function splitContext(val: string): { link?: { target: string; label?: string }; text: string | null } {
  const md = MD_LINK.exec(val);
  if (md) {
    const text = stripInline(val.replace(md[0], " ")).replace(/\s+/g, " ").replace(/^[\s(:;,-]+|[\s(:;,-]+$/g, "").trim();
    return { link: { target: md[2], label: md[1] || undefined }, text: text || null };
  }
  const plain = stripInline(val).trim();
  if (!plain) return { text: null };
  if (isLinkish(plain)) return { link: { target: plain }, text: null };
  const first = plain.split(/\s+/)[0];
  // v2 habit: `context: docs/x.md (the runbook)`: a leading path with a note after it.
  if (isLinkish(first) && /[/#]/.test(first)) return { link: { target: first }, text: plain.slice(first.length).trim().replace(/^\((.*)\)$/, "$1") || null };
  return { text: plain };
}

/** Asks in the `## Waiting on` section(s) of a spine (also `## Waiting on the owner`). Fenced code ignored. */
export function parseAsks(markdown: string, specRel = "", repoDir?: string): LocatedAsk[] {
  const out: LocatedAsk[] = [];
  let level = 0; // > 0 while inside a Waiting on section of that heading level
  proseLines(markdown).forEach((line, i) => {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      if (level && h[1].length <= level) level = 0;
      if (!level && WAITING_SECTION.test(stripInline(h[2]))) level = h[1].length;
      return;
    }
    if (!level) return;
    const m = TAG.exec(line);
    if (!m) return;
    // a `[feedback …]` line reads like an answered one (same tag shape), flagged, its words in `feedback:`.
    const feedback = m[1].toLowerCase() === "feedback";
    const answered = feedback || m[1].toLowerCase() === "answered";
    const tag = m[2];
    const open = answered ? undefined : OPEN_TAG.exec(tag);
    const done = answered ? ANSWERED_TAG.exec(tag) : undefined;
    const kind = (open?.[2]?.toLowerCase() as AskKind | undefined) ?? "unknown";
    const code = (open?.[1] ?? done?.[1] ?? null) || null;
    const who = /@([^\s\]]+)/.exec(tag)?.[1] ?? "";
    // D19 (skill 2026.10.22.4): ` · done <date> <sha>` closes the line; the old inside-the-tag form is still read.
    const tail = answered ? (LINE_DONE.exec(m[3]) ?? LINE_DONE_NOTE.exec(m[3])) : null;
    const marker = answered ? (tail ?? DONE_MARKER.exec(tag.replace(/@[^\s\]·|;,]+/, ""))) : null;
    const rest = tail ? m[3].slice(0, tail.index) : m[3];
    const since = (answered ? done?.[2] : /\bsince\s+(\d{4}-\d{2}-\d{2})/i.exec(tag)?.[1]) ?? null;
    const row = /\brow\s+([^\s\]]+)/i.exec(tag)?.[1] ?? null;
    const people = peopleOfTag(tag);
    const segs = rest.split(SEGMENT);
    const ask: LocatedAsk = {
      code,
      who,
      ask: kind,
      question: stripInline(segs[0] ?? ""),
      options: [],
      recommend: null,
      context: null,
      since,
      row,
      state: answered ? "answered" : "open",
      answer: null,
      steps: null,
      unblocks: null,
      effort: null,
      ...(marker ? { doneAt: marker[1] ?? "", ...(marker[2] ? { doneSha: marker[2] } : {}) } : {}),
      ...(feedback ? { feedback: true } : {}),
      ...people,
      line: i,
    };
    if (MAC_QUESTION.test(ask.question)) ask.macAgent = true;
    const improve: { label: boolean; to?: string; campaign?: string; doneMeans?: string; raw: string[] } = { label: IMPROVEMENT_QUESTION.test(ask.question), raw: [] };
    const prio: { label: boolean; objective?: string; raw?: string } = { label: false };
    for (const seg of segs.slice(1)) {
      const snooze = SNOOZE_SEG.exec(seg);
      if (snooze) {
        ask.snoozedUntil = snooze[1];
        continue;
      }
      const label = LABEL_SEG.exec(seg);
      if (label && isMacLabel(label[1])) {
        ask.macAgent = true;
        continue;
      }
      if (label && isImprovementLabel(label[1])) {
        improve.label = true;
        continue;
      }
      if (label && isPriorityLabel(label[1])) {
        prio.label = true;
        continue;
      }
      const obj = OBJECTIVE_SEG.exec(seg);
      if (obj) {
        prio.objective = stripInline(obj[1]).trim();
        prio.raw = stripInline(seg);
        continue;
      }
      // the improvement request's own fields (kept aside; an ask without the label keeps them as text).
      const imp = /^\s*(to|campaign|done[\s-]+means)\s*:\s*(.*)$/i.exec(seg);
      if (imp) {
        const k = imp[1].toLowerCase();
        const v = stripInline(imp[2]).trim();
        if (k === "to") improve.to = v;
        else if (k === "campaign") improve.campaign = v;
        else improve.doneMeans = v;
        improve.raw.push(stripInline(seg));
        continue;
      }
      const esc = ESCALATED_SEG.exec(seg);
      if (esc) {
        ask.escalatedNote = stripInline(esc[1]) || undefined;
        continue;
      }
      const kv = /^\s*(options?|recommend(?:s|ation)?|context|details|answer|feedback|steps?|unblocks?|effort|impact|risks?|secret|why(?:\s+@?[\w.-]+)?)\s*:\s*(.*)$/i.exec(seg);
      if (!kv) {
        ask.question = `${ask.question} — ${stripInline(seg)}`;
        continue;
      }
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key.startsWith("option")) ask.options = splitOptions(val);
      else if (key.startsWith("recommend")) ask.recommend = stripInline(val) || null;
      else if (key === "answer" || (key === "feedback" && feedback)) ask.answer = stripInline(val) || null;
      else if (key.startsWith("unblock")) ask.unblocks = stripInline(val) || null;
      else if (key === "effort") ask.effort = stripInline(val) || null;
      else if (key === "impact") ask.impact = stripInline(val) || null;
      else if (key.startsWith("risk")) ask.risk = stripInline(val) || null;
      else if (key.startsWith("why")) ask.why = stripInline(val) || null;
      // tolerant; a malformed `secret:` is dropped (the card stays an ordinary ask).
      else if (key === "secret") ask.secret = parseSecretTarget(val) ?? null;
      else if (key.startsWith("step")) {
        // `[runbook](docs/x.md#run) (the main server, user root)` → steps "docs/x.md#run (the main server, user root)" (as spines.py writes it) + stepsLink.
        const md = MD_LINK.exec(val);
        if (md) ask.stepsLink = resolveContext(md[2], specRel, repoDir);
        ask.steps = stripInline(md ? val.replace(md[0], md[2]) : val) || null;
      } else if (key === "context" || key === "details") {
        // v6: `context:` may be plain words (with or without a link); a bare path/URL stays the context link. `details:` is a link.
        const { link, text } = splitContext(val);
        if (link && (!ask.context || key === "context")) {
          ask.context = resolveContext(link.target, specRel, repoDir);
          if (link.label) ask.contextLabel = link.label;
        }
        if (text && key === "context") ask.contextText = text;
      }
    }
    if (improve.label && improve.to) ask.improvement = { to: improve.to, ...(improve.campaign ? { campaign: improve.campaign } : {}), ...(improve.doneMeans ? { doneMeans: improve.doneMeans } : {}) };
    else if (improve.raw.length) ask.question = [ask.question, ...improve.raw].join(" — ");
    if (prio.label && prio.objective) ask.putFirst = { objective: prio.objective };
    else if (prio.raw) ask.question = `${ask.question} — ${prio.raw}`;
    if (ask.question) out.push(ask);
  });
  return out;
}

/**
 * Contract v2 check (advisory, like the skill's validator): which required fields an open ask lacks.
 * steps: do · options: decide · recommend: decide, approve, do · unblocks + context: all. The code is reported by
 * `advisories`, not here (v1 asks without one stay valid).
 */
export function missingFields(a: Omit<HumanAsk, "code" | "steps" | "unblocks" | "effort"> & Partial<HumanAsk>): string[] {
  const miss: string[] = [];
  if (a.state !== "open") return miss;
  if (a.ask === "unknown") miss.push("ask type");
  if (a.ask === "do" && !a.steps) miss.push("steps");
  if (a.ask === "decide" && a.options.length < 2) miss.push("options");
  if ((a.ask === "decide" || a.ask === "approve" || a.ask === "do") && !a.recommend) miss.push("recommend");
  if (!a.unblocks) miss.push("unblocks");
  if (!a.context && !a.contextText) miss.push("context");
  return miss;
}

/** the advisory an open ask gets while it hands the owner terminal lines to copy (root L-54). */
export const COPY_PASTE_ADVISORY = `copy-paste terminal steps for ${ownerName()}: make it a Mac-agent ticket (bootstrap text for the Claude app), never lines to copy (L-54)`;
/** Contract v2 advisories for the asks of one epic (file): missing code, duplicate code, > 3 open, open > 7 days. */
export const MAX_OPEN_ASKS = 3;
export const STALE_DAYS = 7;
export function advisories(a: HumanAsk, all: HumanAsk[], now = Date.now()): string[] {
  if (a.state !== "open") return [];
  const out: string[] = [];
  if (!a.code) out.push("ask has no code");
  else if (all.filter((x) => x.code === a.code).length > 1) out.push(`duplicate code ${a.code}`);
  const open = all.filter((x) => x.state === "open").length;
  if (open > MAX_OPEN_ASKS) out.push(`${open} open asks in this epic (aim for ≤ ${MAX_OPEN_ASKS})`);
  const since = a.since ? Date.parse(a.since) : NaN;
  if (!Number.isNaN(since) && now - since > STALE_DAYS * 86_400_000) out.push(`stale ask (open ${Math.floor((now - since) / 86_400_000)} days)`);
  // terminal lines for the owner to copy: the ask becomes a Mac-agent ticket instead
  if (copyPasteInText([a.question, a.steps ?? "", a.contextText ?? ""].join("\n")).length) out.push(COPY_PASTE_ADVISORY);
  // a key card whose words send the key elsewhere or deny its own box (the card shows them pointed at its box; E996-S29)
  const ownBox = ownBoxProblem(a);
  if (ownBox) out.push(`key card words: ${ownBox}`);
  return out;
}

/** spines.py passes `context` through as written; prose becomes contextText, a link stays context. */
function spinesContext(v: string | null): { context: string | null; contextText?: string | null } {
  if (!v) return { context: null };
  const { link, text } = splitContext(v);
  return { context: link?.target ?? null, ...(text ? { contextText: text } : {}) };
}

/**
 * spines.py (skill ask_refs.py) does not know `secret:` yet and glues the segment onto the field before it (or the
 * question). Cut ` — secret: …` out of every string field and keep the first target found.
 */
const SPINES_SECRET_SEG = /\s+(?:—|–|--)\s+secret\s*:\s*(.*?)(?=\s+(?:—|–|--)\s+|$)/i;
function liftSecret(e: Record<string, unknown>): { entry: Record<string, unknown>; secret?: string } {
  let secret: string | undefined;
  const entry: Record<string, unknown> = {};
  const cut = (v: string) => {
    const m = SPINES_SECRET_SEG.exec(v);
    if (!m) return v;
    secret ??= m[1];
    return v.replace(m[0], "");
  };
  // E996-S29: the last option of an approve ask carried it too (T9-A9 `B stay on our server — secret: acme …`): its card had no box.
  for (const [k, v] of Object.entries(e)) entry[k] = typeof v === "string" ? cut(v) : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? cut(x) : x)) : v;
  return { entry, secret };
}

/** Normalise one spines.py `waiting_on` entry (fields may be missing on older/partial output). */
export function fromSpinesEntry(raw: Record<string, unknown>): HumanAsk | undefined {
  const { entry: e, secret: glued } = liftSecret(raw);
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const secretVal = s(e.secret) ?? glued;
  const question = s(e.question);
  if (!question) return undefined;
  const ask = s(e.ask)?.toLowerCase();
  // spines.py states: open | answered | done (answered and consumed by the owner) | superseded (replaced by another code,
  //). Done and superseded read as answered + doneAt ("": spines.py carries no date; the markdown twin in `asksFor`
  // fills in date and sha for done lines).
  const state = s(e.state);
  return {
    code: s(e.code),
    who: s(e.who) ?? "",
    ask: ask === "decide" || ask === "approve" || ask === "provide" || ask === "do" ? ask : "unknown",
    question,
    options: Array.isArray(e.options) ? lettered(e.options.filter((o): o is string => typeof o === "string")) : [],
    recommend: s(e.recommend),
    ...spinesContext(s(e.context)),
    impact: s(e.impact),
    risk: s(e.risk),
    why: s(e.why),
    ...(secretVal ? { secret: parseSecretTarget(secretVal) ?? null } : {}),
    since: s(e.since),
    row: s(e.row) ?? (typeof e.row === "number" ? String(e.row) : null),
    state: state === "answered" || state === "feedback" || state === "done" || state === "superseded" ? "answered" : "open",
    answer: s(e.answer) ?? s(e.feedback),
    // a skill that knows `[feedback …]` says so (state feedback, or done with outcome feedback).
    ...(state === "feedback" || s(e.outcome) === "feedback" ? { feedback: true } : {}),
    steps: s(e.steps) ?? (Array.isArray(e.steps) ? e.steps.filter((x) => typeof x === "string").join("\n") || null : null),
    unblocks: s(e.unblocks),
    effort: s(e.effort),
    ...(state === "done" || state === "superseded" ? { doneAt: "" } : {}),
    ...(state === "superseded" ? { supersededBy: s(e.superseded_by) ?? "" } : {}),
    ...(s(e.snoozed_until) ? { snoozedUntil: s(e.snoozed_until)! } : {}),
  };
}

/** a spines.py that does not know `snoozed until:` appends it to the field before it (or the question): take it off. */
export function unglueSnooze<T extends HumanAsk>(a: T): T {
  const keys = ["question", "recommend", "context", "contextText", "impact", "risk", "why", "steps", "unblocks", "effort", "answer"] as const;
  let out = a;
  for (const k of keys) {
    const v = a[k];
    if (typeof v !== "string" || !SNOOZE_ON_LINE.test(v)) continue;
    out = { ...out, [k]: v.replace(SNOOZE_ON_LINE, "").trim() };
  }
  return out;
}

/** the same for `label: needs Mac agent`: take it off the field spines.py glued it to, and mark the ask. */
export function unglueLabel<T extends HumanAsk>(a: T): T {
  const keys = ["question", "recommend", "context", "contextText", "impact", "risk", "why", "steps", "unblocks", "effort", "answer"] as const;
  let out = a;
  for (const k of keys) {
    const v = a[k];
    if (typeof v !== "string" || !LABEL_ON_LINE.test(v)) continue;
    out = { ...out, [k]: v.replace(LABEL_ON_LINE, "").trim(), macAgent: true };
  }
  return MAC_QUESTION.test(out.question) ? { ...out, macAgent: true } : out;
}

const fileCache = new Map<string, { key: string; asks: LocatedAsk[] }>();
const v2Cache = new WeakMap<object, Map<string, { key: string; asks: LocatedAsk[] }>>();

/**
 * spines.py `waiting_on` is used once it speaks contract v2 (its entries carry the `code` key, skill 2026.10.21.7+).
 * A v1 list (no `code` key; v1 spines.py also misses `[ask <code>: …]` lines entirely) or an empty one falls back to
 * the markdown parser, which reads both versions; for an empty list both agree.
 */
export const isV2WaitingOn = (v: unknown): v is unknown[] =>
  Array.isArray(v) && v.length > 0 && v.every((e) => !!e && typeof e === "object" && "code" in (e as object));

/**
 * Asks of one spine: `spinesWaitingOn` (the node's spines.py `waiting_on`) when it is v2, with line numbers and
 * link labels looked up in the file; else the markdown parser. Cached by file mtime + size.
 */
export function asksFor(repoDir: string, rel: string, spinesWaitingOn?: unknown): LocatedAsk[] {
  const abs = inside(repoDir, rel);
  if (!abs) return [];
  let text = "";
  let key = "";
  try {
    const st = fs.statSync(abs);
    key = `${st.mtimeMs}:${st.size}`;
    const hit = fileCache.get(abs);
    if (!isV2WaitingOn(spinesWaitingOn) && hit && hit.key === key) return hit.asks;
    // the same with spines.py's list (the stored output is the same object until it changes): every tree build
    // re-parsed every spine's asks on the main thread
    const v2 = isV2WaitingOn(spinesWaitingOn) ? v2Cache.get(spinesWaitingOn as object)?.get(abs) : undefined;
    if (v2 && v2.key === key) return v2.asks;
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const parsed = parseAsks(text, rel, repoDir);
  if (isV2WaitingOn(spinesWaitingOn)) {
    const lines = proseLines(text);
    const viaSpines: LocatedAsk[] = spinesWaitingOn
      .map((e) => (e && typeof e === "object" ? fromSpinesEntry(e as Record<string, unknown>) : undefined))
      .filter((a): a is HumanAsk => !!a)
      .map((a) => unglueLabel(unglueSnooze(a)))
      .map(({ snoozedUntil: fromSpines, macAgent: macFromSpines, ...a }) => {
        const twin = parsed.find((p) => (a.code && p.code === a.code) || stripInline(p.question) === stripInline(a.question));
        const line = twin?.line ?? lines.findIndex((l) => TAG.test(l) && l.includes(a.question.slice(0, 40)));
        // open or answered is the file as it is now (the twin).
        // spines.py output can be minutes old on a loaded host, or kept for good when every run times out (a social world repo on
        // the main server 2026-11-11: 136 timeouts in 36 h, so asks answered at 00:47Z still counted open at 05:30Z with no button).
        const reopened = twin?.state === "open" && a.state !== "open";
        return {
          ...a,
          ...(twin ? { state: twin.state } : {}),
          line: line !== undefined && line >= 0 ? line : undefined,
          ...(twin?.contextLabel ? { contextLabel: twin.contextLabel } : {}),
          // the markdown twin resolved the context link against the spine's folder; fields an older spines.py lacks come from it.
          ...(twin?.context && (a.contextText || !a.context) ? { context: twin.context } : {}),
          ...(twin?.contextText && !a.contextText ? { contextText: twin.contextText } : {}),
          ...(twin?.impact && !a.impact ? { impact: twin.impact } : {}),
          ...(twin?.risk && !a.risk ? { risk: twin.risk } : {}),
          ...(twin?.why && !a.why ? { why: twin.why } : {}),
          ...(twin?.secret && !a.secret ? { secret: twin.secret } : {}),
          ...(twin?.stepsLink ? { stepsLink: twin.stepsLink } : {}),
          // spines.py drops the answered date; the markdown twin's `[answered <code> <date>]` carries it.
          // answered in the file but still open in that output: the answer's date and words are the file's.
          ...(twin?.since && twin.state === "answered" && (!a.since || a.state !== "answered") ? { since: twin.since } : {}),
          ...(twin?.state === "answered" && a.state !== "answered" && twin.answer ? { answer: twin.answer } : {}),
          ...(twin?.doneAt !== undefined ? { doneAt: twin.doneAt, ...(twin.doneSha ? { doneSha: twin.doneSha } : {}) } : {}),
          // a line open again in the file carries no done or superseded mark from the older output
          ...(reopened ? { doneAt: undefined, doneSha: undefined, supersededBy: undefined, answer: null } : {}),
          ...(twin?.feedback ? { feedback: true, ...(twin.answer && !a.answer ? { answer: twin.answer } : {}) } : {}),
          // the many-humans parts of the tag, from the file (a skill before them drops or rejects them).
          ...(twin ? peopleFields(twin) : {}),
          // the snooze date from the file as it is now (the twin; spines.py output may be older), else spines.py's.
          ...((twin ? twin.snoozedUntil : fromSpines) ? { snoozedUntil: (twin ? twin.snoozedUntil : fromSpines)! } : {}),
          // the Mac label, from the file as it is now when the twin is found.
          ...((twin ? twin.macAgent : macFromSpines) ? { macAgent: true as const } : {}),
          // spines.py glues the improvement fields onto the field before them: the markdown twin reads them apart.
          // the same for a priority ask: its objective and plain fields from the file.
          ...(twin?.putFirst ? { putFirst: twin.putFirst, question: twin.question, unblocks: twin.unblocks, recommend: twin.recommend, context: twin.context, contextText: twin.contextText, impact: twin.impact, risk: twin.risk, why: twin.why, answer: a.answer ?? twin.answer } : {}),
          ...(twin?.improvement ? { improvement: twin.improvement, question: twin.question, unblocks: twin.unblocks, recommend: twin.recommend, context: twin.context, contextText: twin.contextText, impact: twin.impact, risk: twin.risk, why: twin.why, answer: a.answer ?? twin.answer } : {}),
        };
      });
    // a skill that does not know `[feedback …]` yet skips the line (its tag is no form it reads): the twin keeps it.
    const known = new Set(viaSpines.map((a) => a.line));
    const asks = [...viaSpines, ...parsed.filter((p) => p.feedback && !known.has(p.line))];
    let byFile = v2Cache.get(spinesWaitingOn as object);
    if (!byFile) v2Cache.set(spinesWaitingOn as object, (byFile = new Map()));
    byFile.set(abs, { key, asks });
    return asks;
  }
  fileCache.set(abs, { key, asks: parsed });
  return parsed;
}

/** the many-humans fields of an ask, for copying from the markdown twin. */
const PEOPLE_KEYS = ["approveBy", "aware", "escalatedBy", "escalatedNote", "awaits", "approvedBy", "approvedAt"] as const;
export function peopleFields(a: HumanAsk): Partial<HumanAsk> {
  const out: Partial<HumanAsk> = {};
  for (const k of PEOPLE_KEYS) if (a[k] !== undefined) (out as Record<string, unknown>)[k] = a[k];
  return out;
}

/** The ask names the world's owner, the owner by default (or nobody: an unnamed human ask in the owner's repos is theirs). */
export const isJordis = (a: Pick<HumanAsk, "who">, owner: string = DEFAULT_OWNER) => !a.who || ownerPatterns(owner).who.test(a.who);

/** `row` matches a ledger row: its Issue id, or the first token of its Title ("1. Define …" → "1"). */
export function rowMatches(row: string | null | undefined, node: { id: string; title: string }): boolean {
  if (!row) return false;
  const want = stripInline(row).toLowerCase().replace(/[.:)]+$/, "");
  const first = stripInline(node.title).split(/\s+/)[0]?.toLowerCase().replace(/[.:)]+$/, "") ?? "";
  return stripInline(node.id).toLowerCase() === want || (!!first && first === want);
}

// ---------- free text (Needs the owner rows from persona runs; heuristic items keep ask "unknown") ----------

const KINDS: [RegExp, AskKind][] = [
  [/\b(decide|decision|choose|pick|which|whether|answers?|questions?|prefer)\b/i, "decide"],
  [/\b(approv\w*|go|go-ahead|sign[- ]?off|green[- ]?light|permission|ok to|allow|accept)\b/i, "approve"],
  [/\b(provide|send|share|give|credentials?|tokens?|passwords?|api keys?|access|root|install|login|log in|sign in)\b/i, "provide"],
];

/** decide / approve / provide from free text: the earliest cue wins; a bare question mark means decide. */
export function askKindOf(...texts: (string | undefined)[]): AskKind {
  for (const raw of texts) {
    if (!raw) continue;
    const text = stripInline(raw);
    let best: { at: number; k: AskKind } | undefined;
    for (const [re, k] of KINDS) {
      const m = re.exec(text);
      if (m && (!best || m.index < best.at)) best = { at: m.index, k };
    }
    if (best) return best.k;
    if (text.includes("?")) return "decide";
  }
  return "unknown";
}

/** `options: A | B` / `Options: A or B` in free text. */
export function optionsOf(text?: string): string[] | undefined {
  const m = text && /\boptions?\s*:\s*(.+?)(?:\.\s|\n|$)/i.exec(text);
  if (!m) return undefined;
  const opts = /\||\s·\s/.test(m[1]) ? splitOptions(m[1]) : m[1].split(/\s*,\s*|\s+or\s+/i).map((o) => stripInline(o)).filter(Boolean);
  return opts.length > 1 ? opts : undefined;
}

/** `recommend: X` / `Recommendation: X` / `I recommend X` in free text. */
export function recommendationOf(text?: string): string | undefined {
  const m = text && /\brecommend(?:s|ed|ation)?\b\s*:?\s*(.+?)(?:\.\s|\n|$)/i.exec(text);
  return m ? stripInline(m[1]).replace(/\.$/, "") || undefined : undefined;
}

/** "the owner: S4 go, …" → "S4 go, …"; "waiting on the owner's go for T4" → "go for T4". */
export function stripJordi(text: string, owner: string = DEFAULT_OWNER): string {
  return stripInline(text)
    .replace(/^(?:blocked|waiting)\s*(?:on|for)?\s*[-—:–,;(]?\s*/i, "")
    .replace(ownerPatterns(owner).prefix, "")
    .trim();
}
