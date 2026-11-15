// waiting-on-the owner inbox + messages (server: core/console/server/src/inbox/).

export type AskKind = "decide" | "approve" | "provide" | "do" | "unknown";

/** the owner's level for an item, set by the Prioritizer from his voice notes (docs/priorities.json), with its why. */
export interface OwnerPriority {
  level: "high" | "normal" | "low";
  why: string;
  words?: string;
  said?: string;
  source?: string;
  ref: string;
  at?: string;
  /** on the owner's red line: above every level, with a red marker. */
  redLine?: { sentence: string; state: RedLine["state"]; ask?: string; at?: string; name?: string; line?: number };
  /** he was frustrated about it or asked for it again: first of all, until it is answered. */
  pressing?: { kind: "frustrated" | "repeated"; why: string; words?: string; said?: string; source?: string };
  /** the objective of his it moves (his order from the objectives screen; n 0 is his first, whose items lead). */
  objective?: { n: number; id: string; name: string };
}

/**
 * the owner's red line (the Prioritizer's `redLine` in docs/priorities.json): the one line that moves us forward
 * most tangibly now, and the 3 to 7 rows and asks on it. GET /api/red-line; null when none was written.
 */
export interface RedLine {
  /** several named red lines ("the memory service's first tester", "Data-product flywheel"); the first leads. */
  name?: string;
  /** the line's deadline (YYYY-MM-DD), when the owner gave one. */
  target?: string;
  sentence: string;
  why?: string;
  words?: string;
  said?: string;
  source?: string;
  state: "proposed" | "agreed" | "changed";
  ask?: string;
  at?: string;
  items: { repo: string; ref: string; path?: string; why?: string }[];
  /** pages the line is about (one plain label each). */
  links?: { label: string; url: string }[];
  /** live numbers read from a remote source, with where each came from. */
  counts?: { label: string; source: string; value?: number | null; sourceText?: string; note?: string; page?: { name: string; address: string; url: string } }[];
}
/** delivered = a PR policy kept the console from writing the spine; the asker got the answer and writes the line. */
export type Delivery = "sent" | "delivered" | "queued" | "failed";

/** where another milestone's spine points at a canonical ask. */
export interface AskReference {
  milestoneId: string;
  milestoneTitle: string;
  path: string;
  line?: number;
  row?: string;
  via: "waits_on" | "unblocks";
  /** D19 reference line: the one-line gloss after `[waits on …]`. */
  gloss?: string;
  nodeKey?: string;
  url?: string;
}

export interface WaitingOwner {
  /** thread = no persona attached; the spine's Current State `Owner:` names a T3 thread. */
  kind: "assignment" | "delivery-manager" | "thread" | "none";
  assignmentId?: string;
  personaId?: string;
  personaName?: string;
  threadId?: string;
  /** T3 environment of threadId, when the console knows it (t3code:// link). */
  environmentId?: string;
  label: string;
}

/** the one-line write of an answer into the spine (commit + push); written = it is there, skipped = a guard refused, failed = git failed. */
export interface SpineWrite {
  status: "written" | "skipped" | "failed";
  /** Why it was skipped / failed (shown on the card). */
  reason?: string;
  /** Short sha of the commit carrying the answer. */
  sha?: string;
  path?: string;
  at?: string;
}

export interface OwnerResponse {
  id: string;
  itemId: string;
  milestoneId?: string;
  /** `feedback` = changes wanted, never an approval (the work reopens and comes back as a new round). */
  kind: "approve" | "deny" | "answer" | "feedback";
  text: string;
  assignmentId?: string;
  threadId?: string;
  /** T3 environment of threadId, when the console knows it (t3code:// link). */
  environmentId?: string;
  delivery: Delivery;
  deliveryError?: string;
  createdAt: string;
  deliveredAt?: string;
  /** Spine items: the write into the spine. Absent for Needs the owner rows (those message the asking run's thread). */
  spine?: SpineWrite;
  /** this response changed an earlier answer (its id) and what that answer was. */
  replacesId?: string;
  replacedAnswer?: string;
  /** a wake of the owner started after this answer (ISO): it may already have read it. */
  ownerRunSince?: string;
  /** what the answer did to the persona who asked (absent on answers from before). */
  wake?: WakeResult;
  /**
   * the background job that writes the answer into the spine and wakes the asker after the console stored it:
   * pending (waiting to run, or to try again at nextAt after `error`), running, done, failed (error = why; Retry).
   */
  job?: AnswerJob;
  /** one answer closes many: the other open asks the same answer closed, the maybes, and the one line to show. */
  settles?: Settled;
}

/** what one answer also settled (server inbox/settles.ts). */
export interface Settled {
  at: string;
  closed: { itemId: string; code: string; reason: string; write: { status: string; sha?: string } }[];
  maybe: { itemId: string; code: string; reason: string }[];
  checked: number;
  label: string;
  line: string;
}

export interface AnswerJob {
  state: "pending" | "running" | "done" | "failed";
  attempts: number;
  error?: string;
  nextAt?: string;
}

/** the answer is stored and its spine write / wake is still to come (the card shows the progress and polls). */
export const jobActive = (r?: Pick<OwnerResponse, "job">) => !!r?.job && (r.job.state === "pending" || r.job.state === "running");

/**
 * woken = Run now pointed at the answer; steered = its running session got it; skipped = a bound held (paused,
 * settled, epic not runnable, nobody to wake); off = Wake was unticked; failed = T3 refused. Queued = its
 * session is still starting; the console retries the steer for up to 2 min (then steered, woken or failed).
 */
export interface WakeResult {
  notified: "woken" | "steered" | "queued" | "skipped" | "off" | "failed";
  runId?: string;
  mode?: "steer" | "auto" | "thread";
  reason?: string;
  persona?: string;
  assignmentId?: string;
}

/** the persona who asked (the run that committed the ask line, the run behind a request, else the owner). */
export interface Asker {
  assignmentId: string;
  personaId?: string;
  personaName?: string;
  via: "ask" | "run" | "owner";
}

/** Save key result: the (value-free) answer and where the key went (`wake` says what reached the asker). */
export interface SaveKeyResult extends OwnerResponse {
  /** deployed false = the app has no app on the app platform, so the key is in the secret store only (not set in an env). */
  stored: { app: string; name: string; deployed?: boolean };
}

/** the monitor alert an ask's buttons go through: the alert's milestone and the ask's code. */
export interface AskRelay {
  milestoneId: string;
  code: string;
}

export interface WaitingItem {
  /** an open ask his long voice note touched, until its owner rewrites it. */
  noteMark?: import("./review-types").NoteMark;
  id: string;
  /** ask = skill human-ask line; heuristic = red node / free-text Waiting on / Needs column; needs_jordi = persona run. */
  source: "needs_jordi" | "ask" | "heuristic";
  /** stamp_ready: a Planning epic whose `Waiting on:` asks the owner to stamp it ready (a Mark ready item). */
  signal?: "red_node" | "waiting_on" | "needs_column" | "owner_row" | "stamp_ready";
  hint?: string;
  /** heuristic rows: "future" = a gate the owner cannot act on yet (listed under "Coming up"); else guessed. */
  gate?: "future";
  gateReason?: string;
  /** Heuristic items: the spine file the signal is in (the guessed card groups by it) and its title. */
  spine?: { path: string; title: string };
  /** Checkout name of the repo: codes are shown as `<repo>/<code>` when the inbox spans repos. */
  repo?: string;
  /** Human-asks v2: `<epic code>-A<n>`; steps for `do`; unblocks; effort; advisories (chips, never block). */
  code?: string;
  steps?: string;
  stepsLink?: { label: string; url: string };
  unblocks?: string;
  effort?: string;
  advisory?: string[];
  /** Needs the owner rows raised by a run that ended blocked: that run and the persona it blocks. */
  blocksRunId?: string;
  blocksPersona?: string;
  /** open; answered = the `[answered]` line is in the spine, pending the owner's work; done = the owner has since deleted it. */
  /** an open ask the owner snoozed: hidden from the list and every count until this day (YYYY-MM-DD; or UTC minute YYYY-MM-DDTHH:MMZ); shown under Snoozed. */
  snoozedUntil?: string;
  /** labelled `needs Mac agent`: Claude on the owner's Mac does it from its ticket; folded under Needs Mac agent, never counted. */
  macAgent?: true;
  /** an improvement request from the social product: which world builds it, for which campaign, what done means. */
  improvement?: { to: string; campaign?: string; doneMeans?: string };
  /** a priority ask: "Put X first in your objectives?"; pinned above everything in his inbox, his Yes puts X first. */
  putFirst?: { objective: string };
  state: "open" | "answered" | "done" | "superseded";
  /** the spine line is `[feedback …]`: the owner asked for changes; the work is reopened. */
  feedback?: boolean;
  /**
   * the ask as a monitor alert shows it (another milestone's, often another world's): its buttons go through the
   * alert's milestone (`POST /milestones/<id>/alert-asks/<code>/…`), which writes to the ask in its own repo and world.
   */
  relay?: AskRelay;
  /** answered by this persona (`[answered … @<persona>]`), not the owner: an FYI card with Reverse; never counted as waiting. */
  decidedBy?: string;
  /** FYI cards: the rubric the persona's verdict was judged by ("score 82/75 · reversal 4 · …"). */
  rubric?: string;
  /** set when the `[answered …]` line carries `· done <date>` ("" without a date); the card reads done. */
  doneAt?: string;
  /** answered persona requests: a run has acted on the answer since (ISO end time): consumed, never pending. */
  consumedAt?: string;
  /** other milestones whose spines wait on this canonical ask (`waits on <repo>/<code>`, or its `unblocks:` names their rows). */
  referencedBy?: AskReference[];
  /** Needs the owner rows with state superseded (only listed with includeSuperseded): the coded ask that replaced it, or `moot`. */
  supersededBy?: string;
  /** Asks: 0-based line of the ask in `path` when read. */
  line?: number;
  answer?: string;
  who?: string;
  row?: string;
  /** Compact link to the ledger row the ask blocks ("row T4"), shown instead of the row's title. */
  rowLink?: { label: string; url: string };
  missing?: string[];
  milestoneId: string;
  /** team-wide list only: rank of the best milestone listing it (1 = top of the sidebar); the list comes sorted by it. */
  priority?: number;
  /** the owner's level from the Prioritizer, with the why quoting him (the list comes sorted by it first). */
  ownerPriority?: OwnerPriority;
  milestoneTitle: string;
  nodeKey?: string;
  path?: string;
  title: string;
  ask: AskKind;
  question: string;
  detail?: string;
  proposedAction?: string;
  options?: string[];
  /** E948-S69: the options were built from the question (the ask listed none): `Yes, <the action>` and `No`, or its either-or. */
  optionsDerived?: true;
  recommendation?: string;
  /** plain-words sections of an ask; the card shows them labelled, technical fields under Details. */
  contextText?: string;
  impact?: string;
  risk?: string;
  /** `why the owner:`: why an agent cannot decide it. */
  whyYou?: string;
  /** a key ask (`secret: <app> <NAME>`): the card shows a private paste box; the server stores it with `secret put`. */
  secret?: { app: string; name: string };
  /** E996-S29 (client): the codes of the other open asks that store this same key; this card holds their one box. */
  sameKey?: string[];
  contextLinks: { label: string; url: string; threadId?: string; environmentId?: string }[];
  owner: WaitingOwner;
  since?: string;
  decidable: boolean;
  needsJordiId?: string;
  /** Latest answer the owner gave from the console. */
  response?: OwnerResponse;
  /** who an answer wakes (open items and persona decisions). */
  asker?: Asker;
  /** approved with Accept (one, or Accept all on a persona's set): the answer job adds a ready row for it. */
  asReadyRow?: boolean;
  /** the ready row his accept made (its code), or why it was not written. */
  readyRow?: string;
  readyRowError?: string;
  /** display name of the world's owner when it is not the owner (absent for the home world). */
  ownerName?: string;
  /** a done or superseded item as its folded row only (`?view=list`); getWaitingItem fetches the whole card. */
  slim?: true;
}

export interface ConsoleMessage {
  id: string;
  milestoneId?: string;
  assignmentId?: string;
  /** message = the owner's own text; ask_for_asks = "Ask owner to write asks". */
  kind?: "message" | "ask_for_asks";
  text: string;
  refItemId?: string;
  threadId?: string;
  /** T3 environment of threadId, when the console knows it (t3code:// link). */
  environmentId?: string;
  delivery: Delivery;
  deliveryError?: string;
  createdAt: string;
}

export interface OwnerActivity {
  type: "response" | "message";
  id: string;
  at: string;
  milestoneId?: string;
  assignmentId?: string;
  personaName?: string;
  threadId?: string;
  /** T3 environment of threadId, when the console knows it (t3code:// link). */
  environmentId?: string;
  kind?: OwnerResponse["kind"];
  text: string;
  itemId?: string;
  itemTitle?: string;
  messageKind?: ConsoleMessage["kind"];
  delivery: Delivery;
  deliveryError?: string;
  spine?: SpineWrite;
  /** a changed answer: the response it replaces and that answer. */
  replacesId?: string;
  replacedAnswer?: string;
}

export const ASK_VERB: Record<AskKind, string> = { decide: "Decide", approve: "Approve", provide: "Provide", do: "Action", unknown: "Respond" };

/** Structured (an agent actually asked): human-ask lines and persona Needs the owner rows; guessed heuristics are not. */
export const isStructured = (i: WaitingItem) => i.source !== "heuristic";

/** Open, structured and not yet answered from the console: what the count badges show (guesses never count). */
export const needsAnswer = (i: WaitingItem) => isStructured(i) && i.state === "open" && !i.response;

/** `<repo>/<code>` when `qualify` (the list spans repos), else the bare code; undefined without a code. */
export const codeLabel = (i: Pick<WaitingItem, "code" | "repo">, qualify: boolean) => (i.code ? (qualify && i.repo ? `${i.repo}/${i.code}` : i.code) : undefined);

/** the Snooze dropdown: 3 days, 1 week, 1 month; 3 hours first (written as a UTC minute, not a day). */
export type SnoozeDays = 3 | 7 | 30;
export type SnoozeHours = 3;
export type SnoozeChoice = { hours: SnoozeHours; days?: undefined } | { days: SnoozeDays; hours?: undefined };
export const SNOOZE_CHOICES: (SnoozeChoice & { label: string })[] = [
  { hours: 3, label: "3 hours" },
  { days: 3, label: "3 days" },
  { days: 7, label: "1 week" },
  { days: 30, label: "1 month" },
];

/**
 * the "I'm on my laptop" switch (GET /api/laptop). `session` null = off. `tasks` are the Mac list's: each ticket
 * with its one command and minutes, and the labelled asks with their command inline; the inbox orders them by its Mac asks.
 */
export type LaptopFor = "1h" | "2h" | "open";
export interface LaptopSession {
  id: string;
  since: string;
  /** null: until he says. */
  until: string | null;
  by: string;
}
export interface MacTask {
  key: string;
  repo: string;
  row?: string;
  ask?: string;
  title: string;
  minutes?: number;
  url?: string;
  command?: string;
  order: number;
  /** the steps page id the Mac list names. */
  page?: string;
  /** the ticket page's step as the spine has it; the inbox card writes the same step (absent: no page). */
  step?: LaptopStep;
}
/** a Mac task's step on its ticket page (steps kit): its state, notes and the change still filing. */
export interface LaptopStep {
  pageId: string;
  step: string;
  state: "todo" | "done" | "stuck";
  at?: string;
  words?: string;
  notes: { at: string; words: string }[];
  change?: { status: "saved" | "filed" | "undone" | "failed"; sha?: string; at: string; wake: string; reason?: string };
}
/** a press on a Mac task's card: a state, his words, or both (POST /api/steps/pages/<id>/ticks). */
export interface StepTickInput {
  step: string;
  state?: "todo" | "done" | "stuck";
  comment?: string;
  title?: string;
  row?: string;
  ask?: string;
}
export interface LaptopView {
  session: LaptopSession | null;
  tasks: MacTask[];
  /** the tasks a Done (on the card or the page) cleared. */
  done?: MacTask[];
  listUrl: string;
  tasksError?: string;
}

/** GET /api/inbox/search?q= : the items matching every word, by section, each with where it matched. */
export interface InboxSearchResult {
  q: string;
  tookMs: number;
  total: number;
  counts: { blocked: number; review: number; done: number };
  hits: { id: string; section: "blocked" | "review" | "done"; where: ("title" | "card" | "note")[]; title: string }[];
  /** done items older than the Inbox's own list (up to 30 days), as one-line rows. */
  rows: WaitingItem[];
}
