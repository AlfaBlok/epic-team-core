import { REVIEW_RULE } from "./review/review.js";
import { effectiveWrite, type Assignment, type Milestone, type Persona } from "./store.js";
import { FINISH_THE_JOB_RULE, NO_COPY_PASTE_RULE, VISUAL_FIRST_RULE, isDeliveryManager } from "./inbox/asks.js";
import { LEFT_READY_RULE } from "./cycle/followUp.js";
import { childVerdict, type ChildEpic } from "./cycle/children.js";
import { BLOCKER_RULE, READY_ACCOUNT_RULE } from "./cycle/movement.js";
import { homeRepo, ownerName } from "./identity.js";

/** the console's state card reads these lines, so every wake leaves them current. */
export const STATE_RULE =
  "At the end of every wake, update `## Current State` in the spine (`Last attempted:`, `Result:`, `Evidence:`, " +
  "`Waiting on:`, `Next action:`, `Verified at:`) before you PATCH the run. " +
  // spines.py and the console read only the first line of each; a list under `Waiting on:` rendered truncated.
  "Write each on ONE line (several items separated by ` ; `, never a list on the lines below it: the console reads only that line). " +
  "When nothing changed since your last wake (same blocker, no step done, no new fact), do not edit or commit the spine just to restamp " +
  "`Last attempted:` / `Verified at:`: leave it untouched and say it in your outcome line and run summary only. " +
  "Keep a `Monitoring:` line there while the epic only waits on a time or a condition (write it when a hold or watch starts, remove it when it ends): " +
  "`Monitoring: <what> since <ISO> until <ISO> · next check <ISO> <what> · then <what happens after>` (several items separated by ` ; `). " +
  // a stop is not a wait; the owner sees it as an alert in Waiting on you.
  "A Monitoring item is only for a calm wait: when what you watch has stopped (a 429, a rate limit, logged out, an egress offline, a capability down) or its next check date has passed by a day, " +
  `the console shows it to ${ownerName()} as a Monitor alert in Waiting on you. Then write the coded ask that unblocks it (or name an existing one in the item, \`waits on <repo>/<code>\`, so the alert links it) and keep the next check date ahead; ` +
  "when it works again, rewrite or remove the item so it reads true.";

/**
 * the spine records what was achieved before it closes (epicspine-skill console contract #outcome).
 * only the owner marks the verdict (console Mark accomplished writes Verdict + Closed); a persona leaves it out,
 * which shows the milestone as Ready to mark. Reopened: a new goal under a marked spine.
 */
export const OUTCOME_RULE =
  "Before you tick the last Done-means box or ask for closure, write `## Outcome` in the spine WITHOUT a `Verdict:` line: " +
  "`Outcome:` one sentence of what was achieved, `Risk:` residual risk and follow-ups (or none), and a " +
  "`| Done means | Evidence |` table mapping each Done-means item to its evidence links (URLs, commit SHAs, PR #n). " +
  `Only ${ownerName()} marks the verdict (the console's Mark accomplished writes \`Verdict:\` and \`Closed:\`); the milestone then shows Ready to mark. ` +
  `A \`Verdict:\` that is not \`Closed: … by ${ownerName()}\` was written by an agent: remove it and its \`Closed:\` line. ` +
  `Never write ${ownerName()}'s mark as a \`Waiting on:\` line (\"${ownerName()}: verify the Outcome and set Status done\"): Ready to mark already asks him. ` +
  `Then set Status: review, never done / closed: the Delivery manager or ${ownerName()} verifies the evidence and ${ownerName()} marks it. ` +
  "Put the outcome sentence in your run summary. " +
  "When you open a new epic or ledger row under a spine whose `## Outcome` has a Verdict, add a Decisions row `reopened by <epic>` " +
  "(the console shows it Reopened, no Settle, until that work is done); when it closes again, rewrite the Outcome sentence and evidence table.";

/** the spine may change between the console's tick and this read (the console skips non-runnable spines). */
export const RUNNABLE_RULE =
  "Work this spine only if its Status is ready or active (blocked: only its unblocked rows); otherwise (draft = planning, deferred, review, done, superseded) " +
  "say so in the outcome line (`outcome: idle: not runnable (Status <status>)`) and stop.";

/** at most this many child workers run at once per milestone (CONSOLE_MAX_WORKERS_PER_MILESTONE overrides). */
export const DEFAULT_MAX_WORKERS = 10;
/** seconds to wait between two worker launches in one wake. */
export const WORKER_PAUSE_S = 10;

export function maxWorkersFromEnv(raw = process.env.CONSOLE_MAX_WORKERS_PER_MILESTONE): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_WORKERS;
}

/** the two reasons a ready row is recorded as queued instead of started. */
export const queuedCeiling = (max: number) => `queued: worker ceiling ${max}`;
export const queuedNoSeat = (reason = "<pick reason>") => `queued: no seat with headroom (${reason})`;

/** at most this many ready rows are listed in a wake's dispatch order (the rest follow in the ledger's order). */
export const DISPATCH_ORDER_MAX = 40;

/**
 * (the owner asked: "is the order of my objectives used at all?"): the wake's ready rows in his
 * objectives' order, so a higher objective's row gets a worker slot first and the rows left queued are the lower ones.
 * Empty when no ready row moves an objective (the ledger's order stands).
 */
export function dispatchOrderSection(rows: { id: string; objective?: { n: number; name: string } }[]): string {
  if (!rows.some((r) => r.objective)) return "";
  const shown = rows.slice(0, DISPATCH_ORDER_MAX);
  return [
    "## Dispatch order (his objectives)",
    `Start ready rows in this order, one worker each, until the ceiling or the seats run out: a row of a higher objective of ${ownerName()}'s gets a worker slot before a lower one, and the rows left queued are the lowest. ` +
      "A row on none of his objectives waits behind every row that moves one. Skip a row this list names only for a reason the rules above give (claimed, blocked, not yours).",
    ...shown.map((r, i) => `${i + 1}. ${r.id}: ${r.objective ? `objective ${r.objective.n + 1}, ${r.objective.name}` : "on none of his objectives"}`),
    ...(rows.length > shown.length ? [`… ${rows.length - shown.length} more ready rows after these, in the ledger's order.`] : []),
  ].join("\n");
}

/**
 * dispatch drains the ready queue. `available` in `$EPICSPINE_DISPATCHER status` counts ELIGIBLE seats, not free
 * slots; the broker has no per-seat cap, so several workers may share a seat and only `pick` returning a null id stops us.
 */
export const dispatchRule = (max: number) =>
  "Dispatch every ready, unblocked row in your scope that your remit and write rule allow, one worker per row: run `$EPICSPINE_DISPATCHER pick` for each worker " +
  "until it returns a null id (it chooses the seat by usage headroom; several workers may share a seat, and `available` in `status` counts eligible seats, never a number of workers). " +
  `Run at most ${max} child workers at once for this milestone (count its child runs still \`running\`) and pause ${WORKER_PAUSE_S} s between launches. ` +
  `Record every ready row you did not start in the run summary as \`${queuedCeiling(max)}\` (the ceiling is reached) or ` +
  `\`N ready rows ${queuedNoSeat()}\` (pick returned a null id; give pick's reason): queued is not idle. ` +
  "A row whose Owner cell says `<someone> — claimed …, lease until <a time still ahead>` is held: never start a second worker on it. " +
  `A row whose Role is \`Mac agent\` (the \`needs Mac agent\` label) is never a server worker's and never reads ready: Claude in the Claude app on ${ownerName()}'s Mac does it from its ticket page's bootstrap text (\`scripts/laptop_ticket.py\`, all on the Mac list); ` +
  "its ask carries `— label: needs Mac agent`, and its Done or Stuck report is what you act on. Work that needs his laptop (a browser sign-up, a provider dashboard, Stripe) becomes such a row, never a steps page.";

/**
 * the dispatch line of a wake that runs on its world's own job servers: no dispatcher and no seat there; the
 * console starts each worker as a job on a job server of that world (section B of the console protocol).
 */
export const jobDispatchRule = (max: number) =>
  "Dispatch every ready, unblocked row in your scope that your remit and write rule allow, one worker per row, with the console's workers call (section B of the console protocol): " +
  `each worker runs as a job on a job server of this workspace. Run at most ${max} child workers at once for this milestone (count its child runs still \`running\`). ` +
  `Record every ready row you did not start in the run summary as \`${queuedCeiling(max)}\`: queued is not idle. ` +
  "A row whose Owner cell says `<someone> — claimed …, lease until <a time still ahead>` is held: never start a second worker on it.";

/** safety rule, in every wake whatever the write setting. */
export const NO_SELF_GREEN =
  `Never mark your own node done or green; propose done with evidence for the Delivery manager / ${ownerName()} to verify.`;

/**
 * agents never ready their own ideas; a run whose spine diff does so is flagged `self-readied` and reverted.
 * the owner's ask is his ready stamp, so readying what he asked for, with a Decisions row citing his words, is allowed.
 */
export const NO_SELF_READY =
  `Never change a spine's or a row's Status from draft to ready on your own idea: ready comes from ${ownerName()}. His ask is his ready stamp (root L-37): ` +
  `when you ready an item because ${ownerName()} asked for it (desk, chat, voice note, the console's Add), add in the same commit a Decisions row that names ${ownerName()} and L-37 and quotes his words; ` +
  "a commit that readies without such a row is flagged self-readied and the Delivery manager reverts it. Keep it a draft only when he said so (\"just register it\", \"draft\", \"don't do it yet\").";

/**
 * a voice note (or any words of his) that reaches one persona about one item often
 * says more. The receiver handles its own part and never lets the rest drop: it updates those rows itself or hands them to
 * the Team desk's Delivery Manager with one desk inbox note in the world's home repo. The console also does this by itself for
 * a note filed on a card (voice/spill.ts: the `📎 Also in this note` desk line).
 */
export const VOICE_SPILL_RULE =
  `${ownerName()}'s words reach you about one item (a voice note on a card, his answer, a feedback note, your brief) but often say more: handle your part, then never let the rest drop. ` +
  "Each other part (another row, ask, epic or product) either goes into that row yourself when it is in your scope and write rule (his words quoted, L-37; a part with no row of its own yet says \`part of <the row his note is on>\`, so his note stays on one row), or to the Team desk: " +
  `one note \`python3 ~/github/${homeRepo()}/scripts/desk_note.py send --to <the world's home repo checkout> --from <world> --reply-to <that repo> --about \"Also in ${ownerName()}'s note <vn id or where>: <topics>\" --body \"<his words, then each part in one line>\"\` ` +
  "(the Delivery Manager places it on its next wake). Name what you handed on in your summary (`also: <part> → <row or desk note>`).";

/**
 * every login the team creates goes into the owner's Bitwarden at creation,
 * through scripts/bw_login.py, so his Bitwarden fills it in; never a login handed over as text. In every wake and worker brief.
 */
export const LOGIN_RULE =
  `Every new login goes into ${ownerName()}'s Bitwarden at creation (root L-53): the moment you make anything with a login (a site's user, an app admin, a social account), ` +
  `before its sign-up is submitted or the login is shown to anyone, run \`python3 ~/github/${homeRepo()}/scripts/bw_login.py new \"<Product> · <site> <who>\" --username <login> --uri <its login page> --row <row>\` ` +
  "(it makes the password, or takes the one the site set with `--password-stdin`; `--out <file>` hands it to your sign-up; it prints only the item name). " +
  `Never give ${ownerName()} a login (card, ask, chat, page) whose password is not in his Bitwarden: \`state: queued\` means not yet, so the row says so and does not go to review until it is saved or its one-step ask is posted.`;

/**
 * how a console change reaches the live console: straight, one release step, no staging copy to park on and no promote
 * to wait for (the owner removed staging until there is a second server). The release keeps its safety: a DB backup before
 * the swap, a health check that rolls back by itself, a one-step rollback and the release log. No release hour (the owner,
 * 2026-11-22: "I never approved any hourly delay ... remove it."). In every worker brief.
 */
export const RELEASE_RULE =
  "Console releases go straight to production when they are ready: build the release from main and run `hosted/console/scripts/deploy.sh --release <tarball> --to <console host>`; " +
  "it goes live at once (no release hour, no quiet hours: the owner never approved a wait), one deploy at a time, backs up the database, swaps, checks health and rolls back by itself when the health check fails. " +
  "`deploy.sh --rollback --by <run id> --reason <why>` puts the previous release back at once. " +
  "There is no staging step: never park a change for staging or for a later slot, never wait for a promote; say `live <sha>` on the row only after the live revision shows it. " +
  "`--incident <what is broken>` only labels a real incident's release in the log.";

/** the write rule of an assignment with write on: only within its scope. */
export const scopedWriteRule = (scope: string) =>
  `You may write, ONLY within this scope: ${scope}; anything outside it (prod, root, deploys, other repos) still goes to Needs ${ownerName()}. ` +
  "Record each write in the run summary.";

/**
 * how a run that carries a note acknowledges it. The report must hold this line; the console refuses a
 * finishing PATCH without it (400 note_unacknowledged) and flags a run that ended without it ("note skipped").
 */
export const NOTE_ACK_RULE =
  "Your finishing summary MUST contain one line `note: done: <what you did about it>` or `note: not done: <why>`; the console refuses a finishing report without it.";

/** `note: done: …` / `note: not done: …` in a report (first such line), else undefined. */
export function noteAck(summary: string | undefined): string | undefined {
  const m = /^[\s>*-]*note:\s*(done|not done)\b\s*:?\s*(.*)$/im.exec(summary ?? "");
  if (!m) return undefined;
  const why = m[2].trim();
  return `${m[1].toLowerCase()}${why ? `: ${why}` : ""}`.slice(0, 500);
}

/**
 * the owner's one-off Run now instructions, for the wake that claims that run only (or the Unblocker's).
 * at the very top of the prompt (a persona skimming sections missed it right after the remit), act on it first.
 */
export const instructionsSection = (text: string, by = ownerName()) =>
  [`## ${by}'s note for this run: read and act on it FIRST`, text.trim(), "",
    "These apply to this wake only; they override your usual next-item choice but not the write rule or the ask tier. " +
      "Do this before anything else in this prompt, even when nothing else changed since your last wake.",
    NOTE_ACK_RULE].join("\n");

const CHILD_LABEL = {
  pickup: "PICK UP",
  owned: "",
  planning: `skip: planning (draft; ${ownerName()} has not stamped it ready)`,
  parked: "skip: parked (deferred)",
  finished: "skip: finished",
} as const;

/** one line per child epic, with the console's verdict (pick up / owned by <persona> / skip). */
export const childLine = (c: ChildEpic) => {
  const v = childVerdict(c);
  const rows = v === "pickup" && c.ready ? ` — ${c.ready.length ? `ready rows: ${c.ready.join(", ")}` : "no ready row"}` : "";
  return `- ${c.path} — ${c.title} — Status: ${c.status} (${c.runState}) — ${v === "owned" ? `owned by ${c.ownedBy}: leave it alone` : CHILD_LABEL[v]}${rows}`;
};

/** every child that needs a look gets its line; finished ones are one count line (a smaller wake). */
export const childLines = (children: ChildEpic[]): string[] => {
  const done = children.filter((c) => childVerdict(c) === "finished");
  return [
    ...children.filter((c) => childVerdict(c) !== "finished").map(childLine),
    ...(done.length ? [`- ${done.length} finished child${done.length > 1 ? "ren" : ""} (${done.map((c) => c.path.replace(/^.*\//, "").replace(/\.md$/, "")).join(", ")}): skip: finished`] : []),
  ];
};

/** steps 1-2 of a wake on a spine with children: it steers them and starts only what the owner stamped ready. */
export function parentWakeSteps(children: ChildEpic[], maxWorkers = DEFAULT_MAX_WORKERS, rule: (max: number) => string = dispatchRule): string[] {
  return [
    "This spine has child epics; you steer them. Read each child's `## Current State` and Status, not its rows, and do not start rows that belong to a child spine except as below.",
    "Children (the console's reading of `spines.py --json`; trust the spine if it changed since):",
    ...childLines(children),
    "1. For each PICK UP child (Status `ready`, or `active` with no enabled persona of its own): its line above lists every ready row of its Issue Ledger by id (`ready rows: …`). " +
      "Each listed row gets a worker this wake or a written reason (see step 4); a ready row in its ledger the list missed counts the same. " +
      "A `draft` row is planning: never start it. An `active` child with no ready rows needs nothing from you.",
    `2. Start those rows: ${rule(maxWorkers)} Each brief names \`Bound epic: <child path>\`. ` +
      "For each child you start, set its `Status: active` and its `Last attempted:` naming this run. " +
      "Never start a draft, deferred or finished child, nor one owned by another persona. In this spine's own ledger start only rows with Status `ready` (its old `draft` rows stay as they are). " +
      "Ready children you could not start (ceiling or no seat) stay `ready` and queued: name them in the summary; the follow-up wake picks them up.",
  ];
}

/** a remit line naming the persona's pack role(s) (`Pack role: Writer`): a standing duty, see ownWorkSteps. */
const PACK_ROLE_LINE = /^[\s>*-]*pack roles?:\s*\S/im;
/** a persona whose remit names a pack role does its standing duty and never dispatches ready rows (the DM aside). */
export const hasStandingDuty = (p: { name: string; remit?: string }) => !isDeliveryManager(p.name) && PACK_ROLE_LINE.test(p.remit ?? "");

/**
 * steps 1-2 of a persona that does its own work instead of dispatching (any persona but the Delivery Manager
 * on a spine with children; a pack-role persona on any spine). Before this, every persona on a parent spine got the
 * Delivery Manager's steer-the-children steps: a social world repo's Writer looked for ready child rows, found none and ended
 * idle every day from 2026-10-27, its daily post never written.
 */
export const STANDING_DUTY_RULE =
  "Your remit's recurring work (today's post, the replies waiting, the slot that is due, the morning scan) is your standing duty: it is due on every wake " +
  "whether or not a ledger row asks for it, and you get it done in this wake within your write rule (yourself, or one child worker per B of the console protocol when it is long). No ready row is never a reason to stop: " +
  "end idle only when that work is done for now, and say what you checked (e.g. `idle: today's post P-0049 already scheduled`).";
export function ownWorkSteps(children?: ChildEpic[]): string[] {
  return [
    ...(children?.length
      ? ["This spine has child epics; the Delivery Manager steers them and dispatches their ready rows. You do not: never start workers for rows that are not assigned to you, never change a child's Status."]
      : []),
    "1. Your queue first: the Issue Ledger rows assigned to you (your persona name as owner/assignee) in this spine" +
      (children?.length ? " and its child spines" : "") +
      "; do each ready, unblocked one yourself (an open ask blocks only the rows it names).",
    `2. Then your standing duty. ${STANDING_DUTY_RULE}`,
  ];
}

/**
 * the persona's team skills, each with its library `use_when` line, so the persona reaches for the right one.
 * They are installed on every seat (the code repo skills/team-skills.json); the wake check has verified this host.
 */
export function skillsSection(skills: string[], use: Record<string, string> = {}): string {
  return [
    "## Skills",
    "Your team skills (installed on this seat; open one by its name when the task fits):",
    ...skills.map((s) => (use[s] ? `- Use \`${s}\` ${whenLine(use[s])}` : `- \`${s}\``)),
  ].join("\n");
}
/** "a branded diagram …" → "when you need a branded diagram …"; a SKILL.md style "Use this skill whenever X" → "whenever X". */
const whenLine = (t: string) => {
  const x = t.trim().replace(/[.\s]+$/, "");
  const own = /^(?:use (?:this skill |it )?)?(when(?:ever)?|for)\s+(.*)$/i.exec(x); // also a bare "When the user …"
  return own ? `${own[1].toLowerCase()} ${own[2]}` : `when you need ${x.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}`;
};

/**
 * the milestone's Deck tab on the console, and the same tab on one epic of its tree (`&epic=<code>`).
 */
export const milestoneDeckUrl = (teamUrl: string, milestoneId: string, epic?: string) =>
  `${teamUrl.replace(/\/+$/, "")}/milestones/${encodeURIComponent(milestoneId)}?${new URLSearchParams(epic ? { tab: "deck", epic } : { tab: "deck" })}`;

/** The line every worker brief inside a milestone opens with (and the console's own worker message, workerLaunch.ts). */
export const deckBriefLine = (deckUrl: string) => `This milestone's deck: ${deckUrl}`;

/** at the top of every wake inside a milestone: its deck, read first, and how a brief carries it on. */
export function deckSection(deckUrl: string): string {
  return [
    "## This milestone's deck: read it first",
    `- ${deckBriefLine(deckUrl)} (the human page of this goal: what it is for, what is done, what waits, everything made for it). ` +
      "Open it before you act; it is built from the spine, so keep the spine fields it quotes plain and current (EpicSpine Epic deck rule).",
    `- An epic of this milestone's tree has its own deck in the same tab: \`${deckUrl}&epic=<EPIC-n, or the spine's file name>\`.`,
    `- Every worker brief you write inside this milestone opens with \`${deckBriefLine(deckUrl)}\` and, when it names a Bound epic, ` +
      "`This epic's deck: <that epic's deck link>` on the next line.",
  ].join("\n");
}

/**
 * The prompt a persona wakes with for one milestone. Generic: everything role-specific
 * comes from persona.remit; everything milestone-specific from the milestone pointer.
 */
export function buildWakePrompt(
  persona: Pick<Persona, "name" | "remit" | "skills"> & Partial<Pick<Persona, "mayWrite">>,
  milestone: Pick<Milestone, "title" | "repo" | "path" | "owner">,
  assignment?: Pick<Assignment, "writeEnabled" | "writeScope">,
  instructions?: string,
  instructionsBy?: string,
  maxWorkers = DEFAULT_MAX_WORKERS,
  children?: ChildEpic[],
  skillUse: Record<string, string> = {},
  /** a role brief (the Writer brief), right after the first line, before the remit and the protocol. */
  brief?: string,
  /** the milestone's deck link (the home world's milestones; another world has no deck), right after the first line. */
  deckUrl?: string,
  /** the wake runs on its world's own job servers (workers through the console, no dispatcher). */
  onJobServers = false,
): string {
  const dispatch = onJobServers ? jobDispatchRule : dispatchRule;
  // only the assignment's write_enabled + write_scope open writes; persona.mayWrite is not consulted here.
  const w = effectiveWrite(assignment);
  const writeRule = w.scope
    ? scopedWriteRule(w.scope)
    : "Read-only: you may NOT make writes, restarts, deploys or any production change, and neither may agents you launch " +
      `(launch them diagnose-only). For each such action, stop and raise it as a coded ask in the spine (\`[ask <CODE>: approve @${ownerName()} …]\` ` +
      `with the exact proposed action; a Needs ${ownerName()} item only if you cannot write the spine), then continue with what you can do read-only.`;
  // only the Delivery Manager steers children and dispatches; a pack-role persona does its standing duty.
  const ownWork = !isDeliveryManager(persona.name) && (!!children?.length || PACK_ROLE_LINE.test(persona.remit));
  const steer = !ownWork && !!children?.length;
  const lines = [
    ...(instructions?.trim() ? [instructionsSection(instructions, instructionsBy), ""] : []),
    `You are ${persona.name}, a persona on ${ownerName()}'s agent team, waking on your cadence for one milestone.`,
    "",
    ...(deckUrl ? [deckSection(deckUrl), ""] : []),
    ...(brief?.trim() ? [brief.trim(), ""] : []),
    "## Your remit",
    persona.remit.trim(),
    "",
    "## Milestone",
    `- Title: ${milestone.title}`,
    `- Repo: ${milestone.repo}`,
    `- Spine / ticket: ${milestone.path} (in that repo)`,
    ...(milestone.owner ? [`- Owner: ${milestone.owner}`] : []),
    "The spine is the source of truth for status, Definition of Done / Acceptance, and the Issue Ledger. " +
      "Read it before acting; do not keep a separate copy of milestone state.",
    "",
    ...(persona.skills.length ? [skillsSection(persona.skills, skillUse), ""] : []),
    "## Write rule",
    writeRule,
    NO_SELF_GREEN,
    NO_SELF_READY,
    VOICE_SPILL_RULE,
    LOGIN_RULE,
    NO_COPY_PASTE_RULE,
    "",
    "## This wake",
    RUNNABLE_RULE,
    ...(ownWork
      ? ownWorkSteps(children)
      : steer
      ? parentWakeSteps(children!, maxWorkers, dispatch)
      : [
          "1. Read the spine and its tickets; list EVERY unblocked item that falls in your remit (an open ask blocks only the rows it names; a blocked row never stops the others).",
          `2. ${dispatch(maxWorkers)} Or decide there is nothing to do. Your goal is green: do the reversible step instead of asking (see C of the console protocol).`,
        ]),
    `3. Before you PATCH, finish what this wake started: ${FINISH_THE_JOB_RULE} ${VISUAL_FIRST_RULE}`,
    "4. Finish with one line: `outcome: progressed: <step done>, next <step> | blocked: waits on <open ask code> | monitoring: <what> until <when>, next check <ISO> | idle: no step ready` " +
      "followed by a one-line summary of what you did, the agents you launched, and the ready rows still queued with their reason. " +
      LEFT_READY_RULE +
      ` ${READY_ACCOUNT_RULE}` +
      ` ${BLOCKER_RULE}` +
      ` ${REVIEW_RULE}` +
      (instructions?.trim() ? ` ${NOTE_ACK_RULE}` : "") +
      (steer
        ? " Then list the children: `picked up: <paths>` · `queued for a seat: <paths>` · `left to its persona: <path (persona)>` · `skipped as planning: <paths>`."
        : ""),
    "",
    "## Spine state and closing",
    `- ${STATE_RULE}`,
    `- ${OUTCOME_RULE}`,
    "- If your remit or write rule does not let you edit the spine, put these same lines in your run summary instead.",
  ];
  return lines.join("\n");
}

/**
 * A persona that names one objective (several objectives share one milestone, one Delivery Manager each).
 * Its Delivery Manager is the objective's manager: it works that objective's epics only, aims at its key results green, under the milestone's spine; the rest of the milestone
 * belongs to other personas. Any other persona (a whole-team one: Prioritizer, Strategist, Performance, Learning
 * harvester, Epic Spine health, Alignment) only has its home there: that objective's Personas tab lists it, and it
 * keeps serving every objective its remit names (the owner: "they serve all").
 */
export function objectiveSection(id: string, o?: { name: string; epics: string[] }, onlyThis = true): string {
  const what = `${o ? `${o.name} (\`${id}\` in docs/pursuits.json)` : `\`${id}\` in docs/pursuits.json`}`;
  if (!onlyThis)
    return [
      "## Your home objective",
      `- ${what}: its Personas tab lists you. You still serve every objective your remit names; this only says where you show.`,
    ].join("\n");
  return [
    "## Your objective: you are its objective manager",
    `- ${what}: you work this objective only, never the milestone's other objectives.`,
    ...(o?.epics.length ? [`- Its epics (bind and dispatch from these): ${o.epics.join(" · ")}`] : []),
    "- Its key results, plan and tickets are its Key results and Plan tabs; a row of another objective is left to that objective's own personas.",
    // the owner, 23 Nov 11:21Z: "These guys wake up and their goal is to get the things to green and they dispatch ... as needed"
    "- Your aim is its key results green, not tickets closed. Each wake, before the steps above: list its key results that are not green; for each, the next open step of its plan; start a worker on the row that is that step (a step with no row gets one first); a red key result with nothing moving it and no step that could is an ask, the same wake.",
    "- Ask the owner only what only he can answer (a decision, a login, his taste); everything else you settle yourself and do.",
    "- Your report opens with each key result: green, or red and what you started on it, or red and the ask it waits on.",
  ].join("\n");
}
