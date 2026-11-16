import { outcomeDefLine, TICKET_WORKER } from "../outcomeDefs.js";
import { objectivesRule } from "../objectives.js";
import { MAP_RULE } from "../totemMap.js";
import { ASK_LINE_FORMAT, ASK_TIER_ITEMS, FINISH_THE_JOB_RULE, REPO_IS_SOURCE_RULE, STEPS_PAGE_RULE, VISUAL_FIRST_RULE, ASK_TYPE_RULES, ASK_WRITING_RULE, NO_COMMANDS_RULE, isDeliveryManager, isUnblocker, managerTriageRules, unblockerRules } from "../inbox/asks.js";
import { WAKE_ENDING_RULE } from "./wakeEnding.js";
import { CARD_FIELDS_RULE, FEATURE_LIST_RULE } from "../review/cardRule.js";
import { DEFAULT_RUBRIC, rubricRules, type RubricSettings, type RubricStamp } from "./rubric.js";
import { LEFT_READY_RULE } from "./followUp.js";
import { GRANT_BRIEF_RULE, grantsSection, type Grant } from "./grants.js";
import { effectiveWrite, type Assignment, type Milestone, type Persona, type Run } from "../store.js";
import { DEFAULT_MAX_WORKERS, NOTE_ACK_RULE, VOICE_SPILL_RULE, LOGIN_RULE, RELEASE_RULE, deckBriefLine, WORKER_PAUSE_S, dispatchRule, hasStandingDuty, queuedCeiling, queuedNoSeat } from "../wakePrompt.js";
import { homeRepo, mainHost, memoryName, opsRepo, ownerName, workerHost } from "../identity.js";

const wakeCurl = (base: string, assignmentId: string, clientRequestId?: string) =>
  `curl -sS -X POST ${base}/api/assignments/${assignmentId}/wake -H 'content-type: application/json' -d '${clientRequestId ? JSON.stringify({ clientRequestId }) : "{}"}'`;

/**
 * The wake message (home thread first turn or cadence stub): short and stable. Everything that can change (remit,
 * milestone, protocol) is fetched at wake time. A run with a note carries it verbatim here too, first, so a
 * persona that skims the fetched prompt still has it in its thread; a pre-wake pull failure is said here.
 */
export function wakeStub(
  base: string,
  assignmentId: string,
  extra: { note?: string; noteBy?: string; preWake?: string; clientRequestId?: string } = {},
): string {
  const note = extra.note?.trim();
  return [
    `Agent-team console wake for assignment ${assignmentId}.`,
    ...(note
      ? [
          `${extra.noteBy || ownerName()}'s note for this run (act on it FIRST, before your usual next item, even if nothing else changed):`,
          "<<<",
          note,
          ">>>",
          NOTE_ACK_RULE,
        ]
      : []),
    ...(extra.preWake && /pull failed|unreadable/.test(extra.preWake)
      ? [`Console ${extra.preWake}. Your checkout may be stale: fix it if it is yours to fix (never reset others' work), else say so in your summary.`]
      : []),
    `Run \`${wakeCurl(base, assignmentId, extra.clientRequestId)}\` and follow the prompt it returns exactly; it is your full instructions for this wake.`,
    extra.clientRequestId
      ? "If the request times out or fails, retry the same command (same clientRequestId: you get the same wake) up to 2 times; still failing, reply `outcome: failed: console unreachable` and stop."
      : "If the request fails, reply `outcome: failed: console unreachable` and stop.",
  ].join("\n");
}

/** every worker brief carries this (a worker that ends its turn planning to act later is never woken again). */
/**
 * a worker whose turn never started ("The provider could not start this turn", 2026-10-31 23:40Z on the worker server under
 * load) is relaunched once: the broker is told the exact text (it then avoids that seat 10 min) and picks again.
 */
export const START_FAIL_RULE =
  "If T3 says the provider could not start this turn (the console records the child `failed` with that text): `$EPICSPINE_DISPATCHER done <pick id> --fail --signal \"<the exact error>\"`, " +
  "then relaunch it ONCE as a new child run (steps 1-3: `pick` again, the broker now prefers another seat; summary `<ticket id> retry of <old child run id>`); a second failure stays `failed`.";

/**
 * which rows end in `review`. Only a finished outcome waits for the owner's review; a step that only
 * feeds an ask or the next build closes `done`, citing the ask, so his review list never holds it (the ask is his card).
 */
export const ROW_CLOSE_RULE =
  `Set your row to \`review\` only for a finished outcome ${ownerName()} can open and judge himself (what he asked for, delivered and live). A step that only prepares an ask or the next build ` +
  "(proposal, mockup, guide, checklist page, prepared script) is never a review: once its ask is posted, close the row `done (fed <ask code>)` (root L-43). " +
  `Never close a finished row \`done\` yourself: only ${ownerName()}'s button does. A step with nothing for him to open and judge closes \`done (no confirm: <why>)\`. ` +
  "Set to `review`, the row's Next Action names its follow-ups and `confirm: yes`: `followups: started <code> (<covers>); start <title> — <why>; park <title> — <why>; confirm: yes — <why he must confirm>` (or `followups: none; confirm: yes — …`), so his close starts or parks each one and none is lost. " +
  `Before you set it to review, write its card fields: ${CARD_FIELDS_RULE} ${FEATURE_LIST_RULE}`;

/** one holder per row from any entry point; the worker's commits that name the row renew its lease. */
export const CLAIM_RULE =
  "Claim your row before any work: when `<skill dir>/scripts/claim.py` exists, run `python3 <skill dir>/scripts/spines.py --claim <row> --by <your run id> --repo <the repo checkout>` " +
  "(one pushed commit; exit 3 = someone else holds it: stop, report the holder in your run summary, never work it). Name the row code in every commit message (it renews your lease, 2 h); `--release` if you stop without finishing.";

/**
 * the outcome log: every wake and worker ends by logging its real outcomes, one each, in its finishing PATCH;
 * the console appends them to docs/outcomes/<day>.jsonl of its repo and the Outcomes page reads them back.
 */
export const OUTCOME_LOG_RULE =
  "Log your outcomes in your finishing run PATCH: add `\"outcomes\": [{\"kind\": \"delivered|learning|merged|folded|superseded|released|fixed|asked|other\", \"text\": \"<one plain line: what is now true>\", \"row\": \"<row code>\", \"link\": \"<live URL or card>\", \"goalRow\": \"<goal-set row it turned green, when known>\"}]` " +
  "(one entry per real outcome, none for a wake that changed nothing; the console writes them into the repo's docs/outcomes/ and the Outcomes page shows them).";

export const WORKER_FINISH_RULE =
  "Finish the step in this turn. Never end a turn planning to act later. If a step needs a time window or something not yet available, " +
  "PATCH your run `outcome: monitoring` with `nextCheckAt: <ISO UTC>` (what you wait for in the summary) and stop; `blocked` only for an open ask code. " +
  "A Team Browser `HELD: <egress> offline` result: do not retry; finish the rest, then end `outcome: monitoring` with `heldOn: \"egress:<name>\"`. " +
  ROW_CLOSE_RULE +
  ` ${CLAIM_RULE} ${OUTCOME_LOG_RULE}`;

/**
 * every worker brief carries the ask tier too, so workers in repos without Operating Learnings do
 * not ask about everything. Workers never raise asks themselves: the persona puts the proposed one in the spine.
 */
export const WORKER_TIER_RULE =
  `Do reversible steps inside the goal and repo policy without asking. ${NO_COMMANDS_RULE} ` +
  `Ask tier (only: ${ASK_TIER_ITEMS}): do not do it and do not ask ${ownerName()}; end your report with ` +
  `\`ask-tier: <proposed coded ask, in plain words: what — context — impact — risk + rollback — recommend + why — why ${ownerName()}>\`; the persona raises it in the spine. ` +
  ASK_WRITING_RULE;

/**
 * the eleven rules every worker brief carries verbatim, in order, as one list: the wake's dispatch step prints
 * them and `GET /api/worker-rules` serves them, so a manager's own brief helper never copies a stale set (one such
 * helper kept a copy a day old and missed the visual-first rule in every brief after). The first is the owner's
 * objectives with their live list ("which objective does this move?" opens every plan and report).
 */
export function workerBriefRules(objectivesLine?: string, matchingViews: HisView[] = []): string[] {
  const rules = [objectivesRule(objectivesLine), MAP_RULE, `${WORKER_FINISH_RULE} ${outcomeDefLine(TICKET_WORKER)}`, REPO_IS_SOURCE_RULE, WORKER_TIER_RULE, FINISH_THE_JOB_RULE, STEPS_PAGE_RULE, VISUAL_FIRST_RULE, VOICE_SPILL_RULE, HIS_NOTES_RULE, LOGIN_RULE, RELEASE_RULE, X_LINKS_RULE];
  // the owner's view rides only in the brief of a row on its topic (hisViewsFor), never in every brief
  return matchingViews.length ? [...rules.slice(0, -1), hisViewRecipe(matchingViews), X_LINKS_RULE] : rules;
}

/** one `<owner>'s view: <topic>` entry in the memory service, as listed in the home repo's docs/his-views.json. */
export type HisView = { id: string; title: string; topic: string; mined?: string; worlds?: string[]; tags?: string[]; three?: HisViewBullet[] };
/** one of a view's three bullets: the point, his own words, their memory references (the owner: "too much context is just as bad as too little"). */
export type HisViewBullet = { line: string; words: string; refs?: string[] };

/** a view's three bullets as one line each: the point, his words, the references. */
const threeOf = (v: HisView): string =>
  (v.three ?? []).map((b) => `- ${b.line}: ${b.words}${b.refs?.length ? ` (${b.refs.join(", ")})` : ""}`).join(" ");

/**
 * the views a row touches (the owner: "does every agent need to read this, or is it like agents
 * working in a specific field?"): only a row of one of the view's worlds (its repo) or whose title shares one of its
 * tags, the same tag idea as the X links. Mirrors views_for in scripts/his_view.py.
 */
export function hisViewsFor(row: { repo?: string; title?: string }, views: HisView[]): HisView[] {
  const words = new Set((row.title ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const repo = row.repo;
  return views.filter((v) => (!!repo && (v.worlds ?? []).includes(repo)) || (v.tags ?? []).some((t) => words.has(t)));
}

/**
 * how a worker gets the owner's whole view on a topic from the memory service in one step: a fresh agent took 24
 * calls and ~113 s re-mining every note; with a `<owner>'s view: <topic>` entry (his words and an evidence reference
 * per line) it took 1 call and ~37 s and found the same wants. Only for a row its topic touches (hisViewsFor); every
 * other brief gets "" and skips it.
 */
export const hisViewRecipe = (views: HisView[] = []): string =>
  views.length === 0
    ? ""
    : `${ownerName()}'s view on your row's topic, in three bullet points in his own words (plan on these first): ` +
      views.map((v) => `\`${v.title}\`: ${threeOf(v) || "(no three bullets yet: write them first)"}`).join(" ") +
      ` The full view stays in ${memoryName()} as the source, read only when the three are not enough: ` +
      views.map((v) => `\`python3 ~/github/${homeRepo()}/scripts/his_view.py ${v.topic}\``).join(", ") +
      " prints it (his words and an evidence reference on every line) and only his notes captured after it; read those, not every note again. " +
      "A new wish of his on the topic: add it to the view with `store_memory` (his words and reference per line, `mined <ISO UTC>`), and to its three when it changes what matters most.";

/** the scoped pointer every brief carries: whether one of the owner's views touches this row (most rows: none). */
export const HIS_VIEW_POINTER =
  `Then \`python3 ~/github/${homeRepo()}/scripts/his_view.py for <your row> [--repo <your checkout>]\` says whether one of ${ownerName()}'s views in ${memoryName()} is on your row's topic ` +
  "(its world or its tags); only then read it, otherwise skip it.";

/**
 * the owner asked for one thing about ten times before it was built whole: each brief quoted only his newest note, the
 * same ask sat on several rows, an iteration narrowed it and the card check judged only the newest quote. Every worker
 * reads all his notes on its row and on the rows the same ask sits on, whatever its brief quoted, and answers each.
 */
export const HIS_NOTES_RULE =
  `Before you plan, read every note ${ownerName()} left on your row and on the rows the same ask sits on: ` +
  `\`python3 ~/github/${homeRepo()}/scripts/card_notes.py words <your row> [--repo <repo>=<your checkout>]\` prints them whole, ` +
  "oldest first, with the ones where he says it again on top. Your brief may quote only the newest: the older ones still count. " +
  "Your result answers each of his points (a point you do not deliver is a ✗ line on the card), never a narrower or wider version of it; " +
  "when he says it again (\"how many times\", \"still not\"), say back in one line what he keeps asking and cover it whole (root L-73). " +
  "The card check judges your card against every one of these notes.";

/**
 * the X links the owner sends: each is one entry in the home repo's docs/tool-scout/tools.json with topic tags and the
 * nodes of the data graph it informs; every worker reads the ones on its row's nodes or sharing its row's tags before
 * it plans, so none is lost.
 */
export const X_LINKS_RULE =
  `Before you plan, read the X links ${ownerName()} sent that touch your row: \`python3 ~/github/${homeRepo()}/scripts/x_links.py for <your row> [--repo <your checkout>]\` ` +
  "prints each one on your row's place in the data graph (its product, objective, campaign) or sharing its topic tags, with its lesson; " +
  "use what applies and name it in your plan. Search more with `x_links.py search <words>`. " +
  `When ${ownerName()} sends a new X link, its entry gets tags and nodes the same day (AGENTS.md). ` +
  HIS_VIEW_POINTER;

/** a child-run create that times out may still have created the run; the retry must not make a second one. */
export const CHILD_RUN_RETRY_RULE =
  "Pick a new clientRequestId for each worker you launch; if that POST times out or fails, retry it with the SAME clientRequestId " +
  "(the console answers 200 with the run it already created, never a second one). Never retry a run create without it.";

/** how the persona reads its child runs at each wake. */
export const childStateRule = (base: string, runId: string) =>
  `At each wake, read your child runs (\`curl -sS '${base}/api/runs?parentRunId=<wake run id>'\` for earlier wakes, ` +
  `\`?parentRunId=${runId}\` for this one, or \`?assignmentId=…\` for all). Only a child whose outcome is \`running\` is in flight. ` +
  "A child ended `blank_report`/`failed`/`blocked` is not: verify its effect, then redispatch or record. Never write that a worker 'waits' for a time.";

/** the only way to act at a later time. */
export const TIMED_WAKE_RULE =
  "To act at a time (a window, a scheduled event, the next check of a hold), do not wait and do not leave a worker waiting: finish this run " +
  "`outcome: monitoring` with `nextCheckAt: <ISO UTC>` (or `retryAt`) in your finishing PATCH; the console wakes you then (one extra wake, earliest request wins).";

/**
 * a Team Browser read answered `HELD: laptop offline` (an egress is away). Nobody retries or waits: the wake ends
 * monitoring held on that egress; the egress online event wakes it (6 h fallback check if missed).
 */
export const HELD_RULE =
  "A Team Browser read that answers `HELD: <egress> offline` (e.g. laptop) is not a failure and not an ask: do not retry it or try another route. " +
  "Finish your other work, then end this wake `outcome: monitoring` with `heldOn: \"egress:<name>\"` (e.g. `egress:laptop`), the held site in the summary; " +
  "a child run that reports HELD counts too. The console wakes you when the egress is back (a 6 h fallback check is set for you if you give no nextCheckAt).";

/** Appended to buildWakePrompt: how this wake reports back to the console. */
export function wakeProtocol(o: {
  base: string;
  run: Run;
  assignment: Assignment;
  milestone: Milestone;
  persona: Persona;
  /** active standing approvals of the milestone (own + inherited); none → no section F. */
  grants?: Grant[];
  /** for an Unblocker wake, the switched-on Delivery Manager assignment of the milestone (to Run now after answering). */
  managerAssignmentId?: string;
  /** ceiling of child workers running at once for the milestone (default 10) and how many run now (undefined = unknown). */
  maxWorkers?: number;
  runningWorkers?: number;
  /** the room-aware ceiling's line (the number allowed now and why); absent = the flat ceiling. */
  roomLine?: string;
  /** the Unblocker's confidence rubric in force at this wake (absent = the default). */
  rubric?: RubricSettings & { from?: RubricStamp["from"] };
  /** the milestone's deck link; each worker brief opens with it (absent: another world, no deck). */
  deckUrl?: string;
  /** the owner's objectives in one line (objectives.ts), carried in the first worker rule (absent: another world). */
  objectivesLine?: string;
}): string {
  const { base, run, assignment, milestone, persona } = o;
  const maxWorkers = o.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const grants = o.grants ?? [];
  const unblocker = isUnblocker(persona.name);
  // a pack-role persona does its standing duty itself and dispatches no rows, so its B
  // keeps only how to launch one child for long work (no row dispatch, ceiling or re-dispatch lines).
  const duty = hasStandingDuty(persona);
  const w = effectiveWrite(assignment);
  const j = (v: unknown) => `'${JSON.stringify(v)}'`;
  const h = "-H 'content-type: application/json'";
  return [
    "",
    `## Console protocol (run ${run.id})`,
    `Console API: ${base}/api · milestone ${milestone.id} · assignment ${assignment.id} · this run ${run.id}.`,
    "",
    "A. Repo rules: work in the milestone repo and follow its AGENTS.md / EpicSpine rules (root spine, Integration policy,",
    "   dispatch profile). Edit the spine only if your remit makes you its single writer; otherwise report in the summary.",
    `   ${REPO_IS_SOURCE_RULE}`,
    "",
    ...(duty
      ? [
          // a duty persona launches no child itself (no the main server worker route any more); long work becomes a queued row.
          "B. Child workers: your standing duty is done in this thread. Long work (a render, a batch) is not done here and not launched by you:",
          "   name it in your finishing summary as `queued: <what it does>` (or add it as a row if your remit writes the spine); the Delivery manager dispatches it on " + workerHost().toUpperCase() + " at its next wake.",
          `   ${childStateRule(base, run.id)} Before you finish, verify a finished child's effect in the repo.`,
        ]
      : [
        "B. Child workers: never do long work in this thread.",
        `   ${childStateRule(base, run.id)}`,
        `   ${dispatchRule(maxWorkers)}`,
        ...(o.roomLine ? [`   ${o.roomLine}`] : []),
        ...(o.runningWorkers === undefined
          ? []
          : [`   At this wake's start the console counts ${o.runningWorkers} child run(s) still running for this milestone: you may launch ${Math.max(0, maxWorkers - o.runningWorkers)} more (recount before each launch).`]),
        "   For each worker (ready row):",
        `   0. If ${maxWorkers} child runs are already \`running\` for this milestone, stop launching: the remaining ready rows are \`${queuedCeiling(maxWorkers)}\`. Otherwise wait ${WORKER_PAUSE_S} s after the previous launch, then:`,
        // every worker is dispatched on the worker server; a null pick queues the row, never the main server launch.
        "   1. `$EPICSPINE_DISPATCHER pick` → JSON. Workers run on " + workerHost().toUpperCase() + " only: never launch one on " + mainHost().toUpperCase() + " or through the console. " +
          "If `id` is null and `retryable` is true, pick again in this turn after `retry_after_s`, doubling the wait, for about 15 min in total (a Monitor or until-loop, never a foreground sleep). " +
          `Still null at the end, or not retryable: launch no more this wake: put \`N ready rows ${queuedNoSeat()}\` (N = rows not started, the reason = pick's reason field) in your finishing summary, ` +
          "and finish `progressed` if you started any worker, else `monitoring`, with `retryAt` about now + 5 min either way (queued is waiting, not idle; never leave it to the next scheduled wake; a host cap usually clears within minutes).",
        `   2. Record it first: \`curl -sS -X POST ${base}/api/runs ${h} -d ${j({ assignmentId: assignment.id, parentRunId: run.id, seat: "<pick id>", outcome: "running", summary: "<ticket id> <what it does>", clientRequestId: "<ticket id>-<UTC HHMMSS now>" })}\``,
        "      Start the summary with the ticket id it works on (e.g. `N10-6 ...`). Keep the returned id: the child run id.",
        "      A 409 `claimed` means the row already has a live session (another wake, desk or Delivery Manager runs a worker on it, or its row holds a live claim): skip that row, `$EPICSPINE_DISPATCHER done <pick id>`, and name it `skipped <row>: claimed by <holder>` in your summary.",
        `      ${CHILD_RUN_RETRY_RULE}`,
        "   3. Launch it with the T3 `delegate_task` tool, `target.providerInstanceId` = the pick's providerInstanceId, mode async,",
        "      `clientRequestId` = `<ticket id>-<child run id>` (e.g. `e6-s34-run_3a000db5`): the console binds the task's thread to that run, never a second run.",
        "      `title` = `<ticket id> <what it does, a few words>` (e.g. `N10-6 outcome log`): every session is named by its ticket.",
        ...(o.deckUrl
          ? [`      Its brief opens with the line \`${deckBriefLine(o.deckUrl)}\` and, when it names a Bound epic, \`This epic's deck: ${o.deckUrl}&epic=<that epic's EPIC-n>\`.`]
          : []),
        "      Its brief must say: end every commit message with the trailer line `Run: <child run id>`; and, verbatim, these eleven rules:",
        ...workerBriefRules(o.objectivesLine).map((r) => `      "${r}"`),
        `      A brief helper of your own (a script, a rules file) reads them fresh each wake from \`${base}/api/worker-rules\` (plain text, one quoted rule a line), never a copy kept from an earlier wake.`,
        ...(grants.length ? [`      ${GRANT_BRIEF_RULE}`] : []),
        `      (the PATCH: \`curl -sS -X PATCH ${base}/api/runs/<child run id> ${h} -d ${j({ outcome: "monitoring", nextCheckAt: "<ISO UTC>", summary: "<what it waits for>", endedAt: "<ISO UTC now>" })}\`)`,
        `      Then \`curl -sS -X PATCH ${base}/api/runs/<child run id> ${h} -d ${j({ threadId: "<childThreadId>" })}\`.`,
        "   4. When its completion arrives in this thread (a later turn): PATCH that child run with its outcome/summary/endedAt,",
        "      then `$EPICSPINE_DISPATCHER done <pick id>` (add `--fail` if it failed). Always call done, also on failure.",
        `      ${START_FAIL_RULE}`,
        `      Then re-run the dispatch for the next unblocked steps in your remit (same rule as the wake: every ready, unblocked row, one worker each, \`pick\` until null id, within the ceiling of ${maxWorkers}) before ending the turn.`,
        "      A report ending `ask-tier: …` is not done: raise that ask per C (or answer it if it is not ask tier), then PATCH the child `blocked: waits on <CODE>`.",
        ]),
    "",
    unblocker
      ? "C. You raise no ask of your own (see U), except the remainder of a SPLIT: one coded line under `## Waiting on` of the spine you can write:"
      : `C. Drive to green; ask ${ownerName()} only in the ask tier. When a step is in the ask tier, raise it in ONE place, the spine, as a coded ask, one line under \`## Waiting on\` of the spine you can write:`,
    `   ${ASK_LINE_FORMAT}`,
    ...ASK_TYPE_RULES.map((l) => `   ${l}`),
    `   (CODE = \`<epic code>-A<n>\`). If another epic already has that ask open, do not write a second one: put \`waits on <repo>/<CODE>\` (e.g. \`waits on ${opsRepo()}/EPIC-910-A7\`)`,
    `   in the row that waits; ${ownerName()} answers once at the canonical line and every referencing milestone is told. Never raise one question twice (spine line and API).`,
    "   The API below is only for a spine you cannot write yourself or an action outside your write rule: the console writes the same coded line into the spine for you.",
    "",
    "   Ask through the console: " +
      (w.scope
        ? "for any action outside your remit or outside your write scope, or that is irreversible and not clearly covered by them,"
        : "you are diagnose-only (write is off for this assignment). For any write, restart, deploy, push or production change,") +
      " do NOT do it. Instead:",
    `   \`curl -sS -X POST ${base}/api/needs-owner ${h} -d ${j({ runId: run.id, milestoneId: milestone.id, question: "<question>", proposedAction: "<exact action>", path: "<repo-relative spine you work in; default: the milestone spine>" })}\``,
    "   The console writes it as a coded `[ask <CODE>: …]` line under `## Waiting on` of that spine (commit + push) and answers with `ask.code`; a refusal (409) wrote nothing: say why in your report.",
    `   Finish with outcome \`blocked: waits on <CODE>\`. ${ownerName()}'s answer is the \`[answered <CODE> …]\` line in the spine (you are woken or steered with a pointer to it): pull, read the line, act only on what it says.`,
    "",
    `D. Commits: end every commit message you make with the trailer line \`Run: ${run.id}\`. A commit you make on a child's`,
    "   behalf (recording its dispatch or its result) carries that child's run id instead: `Run: <child run id>`.",
    "   The trailer goes in the message's last paragraph (after a blank line, next to any Co-Authored-By line).",
    "",
    `E. Finish (exactly once, also on failure, as your last step). Every wake ends with a step done; \`blocked\` only citing an open ask-tier code (${ownerName()} must act);`,
    "   `monitoring` when nothing is to do until a time or a condition (a hold, a window): add `nextCheckAt` (and `until` if known).",
    `   ${WAKE_ENDING_RULE}`,
    `   ${LEFT_READY_RULE}`,
    `   \`curl -sS -X PATCH ${base}/api/runs/${run.id} ${h} -d ${j({ outcome: "progressed|blocked|monitoring|idle|failed", summary: "<one line>", endedAt: "<ISO-8601 UTC now>" })}\``,
    "   Use one outcome word. Then reply with the same `outcome: … — summary` line.",
    `   ${OUTCOME_LOG_RULE}`,
    `   ${outcomeDefLine(persona.name)}`,
    `   ${TIMED_WAKE_RULE}`,
    `   e.g. \`-d ${j({ outcome: "monitoring", summary: "<step> needs the 06:10 UTC window", nextCheckAt: "<ISO-8601 UTC>", endedAt: "<ISO-8601 UTC now>" })}\``,
    `   ${HELD_RULE}`,
    `   e.g. \`-d ${j({ outcome: "monitoring", heldOn: "egress:laptop", summary: "inmuebles24 reads held: laptop offline", endedAt: "<ISO-8601 UTC now>" })}\``,
    ...(grants.length ? ["", ...grantsSection(grants)] : []),
    ...(isDeliveryManager(persona.name) ? ["", ...managerTriageRules(base, milestone.id, persona.name, { hasGrants: grants.length > 0 })] : []),
    ...(unblocker ? ["", ...unblockerRules(base, milestone.id, o.managerAssignmentId, run.openAsks, rubricRules(o.rubric ?? DEFAULT_RUBRIC))] : []),
  ].join("\n");
}

export const skipPrompt = (prevRunId: string) =>
  `The previous wake of this assignment (run ${prevRunId}) is still running, so this wake is skipped (recorded as idle). Reply \`outcome: idle: previous run still running\` and stop.`;

/** an Unblocker cadence wake with nothing new since its last check; the console recorded it as idle. */
export const nothingNewPrompt = (summary: string) =>
  `Nothing changed since the last check (${summary}); the console recorded this wake as idle and started no work. Reply \`outcome: idle: nothing new\` and stop.`;

export const inactivePrompt = (why: string) => `This assignment is ${why}. Do nothing; reply \`outcome: idle: ${why}\` and stop.`;

export function approvalMessage(o: {
  approved: boolean;
  base: string;
  needsJordiId: string;
  runId?: string;
  assignmentId?: string;
  proposedAction: string;
  question: string;
  note?: string;
  /** the owner approved by granting this assignment write, limited to this scope. */
  grantedScope?: string;
}) {
  const note = o.note?.trim() ? [`${ownerName()}'s note: ${o.note.trim()}`] : [];
  const grant = o.approved && o.grantedScope
    ? [
        `Write access granted for this assignment, ONLY within this scope: ${o.grantedScope}`,
        `Anything outside it (prod, root, deploys, other repos) still goes to Needs ${ownerName()}. Never mark your own node done or green.`,
      ]
    : [];
  if (!o.approved)
    return [
      `${ownerName()} denied: ${o.proposedAction}`,
      `(Needs ${ownerName()} ${o.needsJordiId}: ${o.question})`,
      ...note,
      "Do not carry out that action. Reply with one line acknowledging it; no other work in this turn.",
    ].join("\n");
  return [
    `${ownerName()} approved: ${o.proposedAction}`,
    `(Needs ${ownerName()} ${o.needsJordiId}: ${o.question})`,
    ...grant,
    ...note,
    "Carry out exactly that action now, within the repo's rules, then record it as a child run of the run that asked:",
    `\`curl -sS -X POST ${o.base}/api/runs -H 'content-type: application/json' -d '${JSON.stringify({
      assignmentId: o.assignmentId ?? "<assignment id>",
      parentRunId: o.runId ?? null,
      outcome: "progressed|failed",
      summary: "<what you did>",
      endedAt: "<ISO-8601 UTC now>",
    })}'\``,
  ].join("\n");
}

export function bootstrapPrompt(o: {
  base: string;
  milestone: Milestone;
  run: Run;
  goal: string;
  kind: "spine" | "ticket";
  seat?: string;
}): string {
  const { base, milestone, run, goal, kind } = o;
  const h = "-H 'content-type: application/json'";
  const what = kind === "spine" ? "a new EpicSpine spine (epic) file" : "a new epic ticket file";
  return [
    `Bootstrap for the agent-team console: create ${what} in this repo for a new milestone.`,
    "",
    `- Title: ${milestone.title}`,
    `- Goal (from ${ownerName()}): ${goal}`,
    `- Kind: ${kind}`,
    `- Console milestone: ${milestone.id} (its path is empty until you set it) · bootstrap run: ${run.id}`,
    "",
    "Steps:",
    "1. Read this repo's AGENTS.md and its root spine (Current State, Operating Learnings, how epics/tickets are laid out).",
    "   Follow this repo's own EpicSpine conventions for where the file goes, how it is named and how it is listed.",
    `   Example: ${opsRepo()} uses tickets/E<n>-<slug>.md listed in docs/EPIC-900-FLEET.md; ${homeRepo()} uses docs/spines/<slug>.md`,
    "   listed in docs/spines/root.md. Use the next free number if the repo numbers them.",
    "2. Write the file: title, mission/goal, Current State (status draft), and a Definition of Done / Acceptance checklist",
    "   (`- [ ]` items) drafted from the goal: concrete, verifiable, 3-8 items. Add it to the parent spine's index/ledger as that",
    "   repo does. Do not implement anything else.",
    "3. Commit and push per this repo's Integration policy (main-direct: commit on main and push; PR-based: branch, push, open a PR",
    `   and say so in the summary). Never force-push. End the commit message with the trailer line \`Run: ${run.id}\`.`,
    `4. Set the milestone path (repo-relative): \`curl -sS -X PATCH ${base}/api/milestones/${milestone.id} ${h} -d '{"path":"<path>"}'\``,
    `5. Close the run: \`curl -sS -X PATCH ${base}/api/runs/${run.id} ${h} -d '{"outcome":"progressed","summary":"created <path> @ <sha>","endedAt":"<ISO-8601 UTC now>"}'\``,
    `   On any failure instead PATCH outcome "failed" with the reason. Always do step 5.`,
  ].join("\n");
}
