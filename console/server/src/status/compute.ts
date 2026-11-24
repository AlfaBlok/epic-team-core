import type { Assignment, Milestone, Run } from "../store.js";
import type { JordiPriority } from "../inbox/jordiPriority.js";
import type { Outcome } from "../adapters/spines.js";
import type { MonitorItem } from "../adapters/monitoring.js";
import { HONESTY_FLAGS, holdState, isClosed, progressOf, statusWordOf, summarize, walkLive, walkOwn, type Progress, type Tree, type TreeColor, type TreeNode } from "../adapters/tree.js";
import { actionableCount } from "../cycle/park.js";
import { readyIgnoredReason, readySteps } from "../cycle/wakeEnding.js";
import { repeatPhrase } from "../cycle/repeat.js";
import { citedAskCodes, snoozedNow, type AskKind } from "../inbox/asks.js";
import type { RefDefect, WaitingItem } from "../inbox/waiting.js";
import { AGENT_VERDICT, markedByJordi } from "../adapters/outcome.js";
import { readyToMarkItem } from "./mark.js";
import { DEFAULT_OWNER } from "../tenancy/owner.js";
import { alertDetail, alertId, alertNext, alertSnoozedUntil, alertState, monitorAlerts, refKey, type MonitorAlert, type ResolvedAsk } from "./monitorAlert.js";
import { ownerName } from "../identity.js";

/**
 * one server-computed status per milestone. Two marks: `outcome` (did the goal get met) and `flow` (what is
 * happening now), plus `items`, the single pending list every screen counts from. Pure: the routes gather the inputs.
 */
export type OutcomeWord = "not_yet" | "ready_to_mark" | "accomplished" | "partially" | "superseded" | "reopened";
export type FlowWord = "settled" | "paused" | "needs_you" | "working" | "planning" | "parked" | "monitoring" | "queued" | "stalled" | "nothing_to_do";
/** Flow order, first match wins (deck slide 8; Planning / Parked right after Working). */
export const FLOW_ORDER: FlowWord[] = ["settled", "paused", "needs_you", "working", "planning", "parked", "monitoring", "queued", "stalled", "nothing_to_do"];

/**
 * One pending line. `open` = waiting on the owner (counts for Needs you, the tab, banner, Team badge and Tree red);
 * `answered` = the owner replied, an agent has not acted on it yet (never counted as waiting); `alarm` = an orange line for
 * the owner that is not an ask (Stalled: switch a persona on or pause), never red, never in needsYou.
 * Kinds added by later steps: ready_to_mark (S2), stalled (S3), free_text_ask (S4), failed_run.
 * Counted kinds (every counted item is a real question or one action for the owner): ask, needs_jordi, mark_ready,
 * ready_to_mark. free_text_ask (Q3) is the owner named (the owner-owned open
 * ledger row, a `Waiting on:` line, a red row) with no coded ask: since it is only an intermediate of
 * `pendingItems`; `milestoneStatus` folds an Outcome-mark one into ready_to_mark and turns every other one into a defect
 * for the Delivery Manager (never counted, no card; amber in the Tree), so no status ever carries one.
 */
export type PendingKind = "ask" | "needs_jordi" | "answered" | "ready_to_mark" | "stalled" | "free_text_ask" | "failed_run" | "mark_ready" | "monitor_alert";
export interface PendingItem {
  /** The waiting-on-you item id (same id as GET /waiting-on-owner). */
  id: string;
  kind: PendingKind;
  /** snoozed = a monitor alert whose every unblocking ask the owner snoozed (one quiet line, never counted). */
  state: "open" | "answered" | "alarm" | "snoozed";
  milestoneId: string;
  /** when the first of its asks' snoozes ends; it is counted again from then. */
  snoozedUntil?: string;
  /** GET /status only: rank of the best milestone listing it (1 = top of the sidebar); absent = unknown milestone. */
  priority?: number;
  /** GET /status only: the owner's level from the Prioritizer (docs/priorities.json) and its why quoting him. */
  ownerPriority?: JordiPriority;
  title: string;
  ask?: AskKind;
  code?: string;
  repo?: string;
  /** Tree node the item attaches to (that node is red while the item is open). */
  nodeKey?: string;
  /** rows of any milestone that wait on this ask (`[waits on …]`, the owner row citing its code): red ring, not counted. */
  refNodes?: string[];
  since?: string;
  /** answered: who will act on it ("nobody scheduled" when no enabled persona). */
  persona?: string;
  /** free_text_ask: the spine line it was read from (repo-relative path, 0-based line) and its link. */
  path?: string;
  line?: number;
  /** free_text_ask: its spine link; ready_to_mark: the results page its Outcome names. */
  url?: string;
  /** free_text_ask: the raw line (`Waiting on: …`, `Owner: the owner · Status: draft`). */
  detail?: string;
  /** free_text_ask: the code of a coded ask for this row written outside `## Waiting on` (the parser skips it). */
  askOutside?: string;
  /** ask / needs_jordi: the question the owner answers (the count proof checks every counted item has one). */
  question?: string;
  /** stalled: the switched-off personas that could take the ready steps, first = the suggested one. */
  switchOn?: { assignmentId: string; persona: string }[];
  /** monitor_alert: the stopped / overdue `Monitoring:` item, the asks it names and what happens next. */
  monitor?: Omit<MonitorAlert, "what"> & { next: string };
}

export interface FlowRun {
  id: string;
  assignmentId: string;
  startedAt: string;
  parentRunId?: string;
  summary: string;
  /** Wake number within its assignment, when the run is a wake. */
  wake?: number;
}

export interface MilestoneStatus {
  milestoneId: string;
  outcome: { word: OutcomeWord; source: "outcome" | "derived"; note?: string; open?: number };
  flow: {
    word: FlowWord;
    reason: string;
    until?: string;
    nextWakeAt?: string;
    personas?: string[];
    run?: FlowRun;
    /** working: runs T3 confirms live now (fresh read, status live); the web's green pulsing dot when > 0. */
    live?: number;
    monitoring?: MonitorItem[];
  };
  items: PendingItem[];
  /**
   * what the last ended wake of each assignment says that the header should name (never a pending item):
   * `ready_ignored` = it reported idle while steps read ready; `repeating` = the same report n times in a row.
   */
  wakeNotes?: WakeNote[];
  /** Open items for the owner (`items` with state open): the one number every badge shows. */
  needsYou: number;
  /** how far the goal is (tree share done, adapters/tree progressOf); absent when the tree is not available. */
  progress?: Progress & { color: TreeColor };
  /** codes in the spines that name no ask: a defect for the owner (Delivery Manager), never counted. */
  defects?: RefDefect[];
  reasons: string[];
}

export interface WakeNote {
  kind: "ready_ignored" | "repeating";
  persona: string;
  runId: string;
  text: string;
  steps?: string[];
  n?: number;
  since?: string;
}

export interface StatusInput {
  milestone: Pick<Milestone, "id" | "paused" | "settledAt"> & { title?: string };
  /** Spine Status word (derived milestone). */
  status?: string;
  monitoring?: MonitorItem[];
  /** the asks the monitor items name, resolved in any repo or world (monitorAlert.askLookupIn), by refKey. */
  monitorAsks?: Map<string, ResolvedAsk>;
  outcome?: Outcome | null;
  doneMeans?: { done: number; total: number };
  tree?: Tree;
  /** waitingOnJordi for this milestone (own items and the asks it references). */
  waiting: WaitingItem[];
  /** unresolved references in this milestone's spines (reasons for the owner, never items). */
  defects?: RefDefect[];
  /** Waiting item ids the owner already answered from the console (latest response not failed: inbox/answered.ts). */
  responded?: Set<string>;
  runs: Run[];
  assignments: Assignment[];
  personaName?: (personaId: string) => string | undefined;
  /** T3 liveness of a running run, when the reconciler read it. */
  t3State?: (runId: string) => { status: string; checkedAt: string } | undefined;
  /** Answers at other epics' canonical asks this milestone waits on (cycle/park: work for its owner). */
  referencedAnswers?: number;
  now?: number;
}

const LIVE_UNKNOWN_MS = 3 * 3_600_000;
const T3_STALE_MS = 5 * 60_000;
const isWake = (r: Pick<Run, "kind" | "parentRunId">) => !r.parentRunId && r.kind !== "answer_run";

/** A run live now: running and T3 says live; with no fresh T3 read, started in the last 3 h (web isLiveNow). */
export function isLiveRun(r: Run, now: number, t3?: StatusInput["t3State"]): boolean {
  if (r.outcome !== "running" || r.endedAt) return false;
  const s = t3?.(r.id);
  if (s && now - Date.parse(s.checkedAt) <= T3_STALE_MS) return s.status === "live";
  return now - Date.parse(r.startedAt) < LIVE_UNKNOWN_MS && !/^Run now: send failed/.test(r.summary);
}

/**
 * a run T3 confirms live now (running, fresh reconciler read, status live): the web's runLiveState === "live",
 * the rule behind the Activity "N workers running" header, so the green dot and that count cannot disagree.
 */
export function isConfirmedLive(r: Run, now: number, t3?: StatusInput["t3State"]): boolean {
  if (r.outcome !== "running" || r.endedAt) return false;
  const s = t3?.(r.id);
  return !!s && now - Date.parse(s.checkedAt) <= T3_STALE_MS && s.status === "live";
}

/** An assignment that will wake on its own: enabled, not parked, with a next wake. */
const scheduled = (a: Assignment) => a.enabled && !a.parkedAt && !!(a.nextWakeAt ?? a.nextRunAt);

/** The pending list from the waiting-on-you items (one per id): open asks / persona requests, and answered asks. */
export function pendingItems(waiting: WaitingItem[], o: { responded?: Set<string>; persona?: string } = {}): PendingItem[] {
  const out: PendingItem[] = [];
  const seen = new Set<string>();
  for (const w of waiting) {
    if (seen.has(w.id) || w.decidedBy || (w.source === "heuristic" && (w.gate === "future" || w.state !== "open"))) continue; // persona FYIs and future gates are not pending
    if (w.macAgent) continue; // needs Mac agent: on the Mac list, run from his laptop in one sitting, not an inbox card
    if (w.snoozedUntil && snoozedNow(w.snoozedUntil)) continue; // snoozed by the owner: still open in the spine, not pending until the day (or minute) comes
    seen.add(w.id);
    const refNodes = [...new Set((w.referencedBy ?? []).flatMap((r) => (r.nodeKey ? [r.nodeKey] : [])))];
    const base = { id: w.id, milestoneId: w.milestoneId, ask: w.ask, ...(w.code ? { code: w.code } : {}), ...(w.repo ? { repo: w.repo } : {}), ...(w.nodeKey ? { nodeKey: w.nodeKey } : {}), ...(refNodes.length ? { refNodes } : {}), ...(w.since ? { since: w.since } : {}) };
    if (w.source === "heuristic" && w.signal === "stamp_ready") {
      // the owner's ready stamp on a Planning epic: one Mark ready item (its button writes Status: ready).
      out.push({ ...base, kind: "mark_ready", state: "open", title: w.title, ...(w.path ? { path: w.path } : {}), ...(w.detail ? { detail: w.detail } : {}) });
      continue;
    }
    if (w.source === "heuristic" && !o.responded?.has(w.id)) {
      // open for the owner with no coded ask (answered from the console: an answered item, like an ask).
      const url = w.contextLinks.find((l) => !l.threadId)?.url;
      out.push({ ...base, kind: "free_text_ask", state: "open", title: w.title || w.question, ...(w.path ? { path: w.path } : {}), ...(w.line !== undefined ? { line: w.line } : {}), ...(url ? { url } : {}), ...(w.detail ? { detail: w.detail } : {}), ...(w.askOutside ? { askOutside: w.askOutside } : {}) });
      continue;
    }
    const answeredNow = w.state === "answered" || (w.state === "open" && o.responded?.has(w.id));
    if (w.state === "open" && !answeredNow) out.push({ ...base, kind: w.source === "needs_jordi" ? "needs_jordi" : "ask", state: "open", title: w.title || w.question, ...(w.question ? { question: w.question } : {}) });
    else if (answeredNow && w.doneAt === undefined) {
      const persona = o.persona ?? "nobody scheduled";
      out.push({ ...base, kind: "answered", state: "answered", persona, title: `Answer received, waiting for ${persona} to act${w.code ? ` (${w.code})` : ""}` });
    }
  }
  return out;
}

/**
 * the Waiting on you alert of a stopped or overdue monitor item. Open (Needs you, counted) only while an
 * ask that unblocks it is open and not snoozed; snoozed when every such ask is (follows the snooze, never counted); an
 * alarm when it names no open ask (the Delivery Manager's defect, never counted).
 */
export function monitorAlertItem(milestoneId: string, a: MonitorAlert, now: number): PendingItem {
  const { what, ...rest } = a;
  const detail = alertDetail(a, now);
  const state = alertState(a.asks);
  const until = state === "snoozed" ? alertSnoozedUntil(a.asks) : undefined;
  return { id: alertId(milestoneId, what), kind: "monitor_alert", state, milestoneId, title: `Monitor alert: ${what}`, ...(detail ? { detail } : {}), ...(a.since ? { since: a.since } : {}), ...(until ? { snoozedUntil: until } : {}), monitor: { ...rest, next: alertNext(a) } };
}

/** a free-text line asking the owner to verify / mark / accept the Outcome, or to set Status done. */
const MARK_ASK = /\b(?:verify|review|mark|accept|confirm|check|approve|sign[ -]?off)\b[^.;]*\boutcome\b|\bset\s+(?:the\s+)?status\s+(?:to\s+)?done\b|\bmark\b[^.;]*\b(?:done|accomplished)\b/i;
export const asksToMark = (x: Pick<PendingItem, "title" | "detail">) => MARK_ASK.test(x.detail ?? x.title);

const NOUN: Record<AskKind, [string, string]> = {
  decide: ["decision", "decisions"],
  approve: ["approval", "approvals"],
  provide: ["thing to provide", "things to provide"],
  do: ["action", "actions"],
  unknown: ["question", "questions"],
};
/** open items counted by kind ("1 to mark", "1 approval, 2 questions"): never "question" for a non-question. */
export function itemsPhrase(open: Pick<PendingItem, "kind" | "ask">[]): string {
  const counts = new Map<string, number>();
  const add = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const x of open) add(x.kind === "ready_to_mark" ? "mark" : x.kind === "mark_ready" ? "ready" : x.kind === "failed_run" ? "run" : x.kind === "monitor_alert" ? "alert" : (x.ask ?? "unknown"));
  const rank = (k: string) => (k === "alert" ? -1 : k === "mark" ? 0 : k === "ready" ? 0.5 : k === "run" ? 2 : 1); // marks first, failed runs last (web asksPhrase)
  return [...counts]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([k, n]) => (k === "mark" ? `${n} to mark` : k === "ready" ? `${n} to mark ready` : k === "run" ? `${n} failed run${n === 1 ? "" : "s"}` : k === "alert" ? `${n} monitor alert${n === 1 ? "" : "s"}` : `${n} ${NOUN[k as AskKind][n === 1 ? 0 : 1]}`))
    .join(", ");
}

/** Descendant goals (spine nodes under the root) that are not done, not closed and not finished. */
export function openDescendantGoals(t?: Tree): number {
  if (!t) return 0;
  let n = 0;
  walkLive(t.root, (x) => {
    if (x.flags.includes("cycle") || x.flags.includes("repeat")) return;
    if (x !== t.root && x.kind === "spine" && x.color !== "green" && !isClosed(x)) n++;
  });
  return n;
}

const VERDICT_WORD: Record<string, OutcomeWord> = { accomplished: "accomplished", "partially accomplished": "partially", partially: "partially", superseded: "superseded" };

/**
 * Outcome mark. Order: superseded → reopened → the owner's mark (`## Outcome` verdict) → ready_to_mark → not_yet.
 * a Verdict an agent wrote (not `Closed: … by the owner`, Status not done) is no mark: it reads ready_to_mark
 * (not_yet while goals under it are open), with the reason, so the next wake removes it.
 */
export function outcomeOf(i: Pick<StatusInput, "status" | "outcome" | "doneMeans" | "tree">): MilestoneStatus["outcome"] {
  const verdict = i.outcome?.verdict?.trim().toLowerCase();
  if (i.status === "superseded" || verdict === "superseded") return { word: "superseded", source: verdict ? "outcome" : "derived" };
  if (verdict && !markedByJordi(i.outcome, i.status)) {
    const open = openDescendantGoals(i.tree);
    if (open > 0) return { word: "not_yet", source: "derived", note: `${AGENT_VERDICT}; ${open} goal${open === 1 ? "" : "s"} under it ${open === 1 ? "is" : "are"} not done` };
    return { word: "ready_to_mark", source: "derived", note: AGENT_VERDICT };
  }
  if (verdict) {
    const open = openDescendantGoals(i.tree);
    if (open > 0) return { word: "reopened", source: "outcome", open, note: `Outcome says ${verdict}, but ${open} goal${open === 1 ? "" : "s"} under it ${open === 1 ? "is" : "are"} not done` };
    const w = VERDICT_WORD[verdict];
    if (w) return { word: w, source: "outcome" };
    return { word: "not_yet", source: "outcome", note: `Outcome says ${verdict}` };
  }
  const dm = i.doneMeans;
  if (dm && dm.total > 0 && dm.done === dm.total && (i.outcome?.evidence.length ?? 0) > 0) return { word: "ready_to_mark", source: "derived", note: "every Done means is ticked and the evidence table is written" };
  return { word: "not_yet", source: "derived", ...(dm && dm.total > 0 ? { note: `${dm.done}/${dm.total} Done means` } : {}) };
}

/**
 * a free-text item as the Delivery Manager's defect: the owner is named in a spine line with no coded ask. With a
 * coded ask for the row written outside `## Waiting on` (in its Current State field), the fix is to move it.
 */
export function freeTextDefect(x: PendingItem): RefDefect {
  const at = x.path ? `${x.path}${x.line !== undefined ? `:${x.line + 1}` : ""}` : x.title;
  return {
    kind: "free_text",
    milestoneId: x.milestoneId,
    repo: x.repo ?? "",
    path: x.path ?? "",
    line: x.line ?? 0,
    ...(x.nodeKey ? { nodeKey: x.nodeKey } : {}),
    ...(x.url ? { url: x.url } : {}),
    text: x.askOutside ? `${at} has ask ${x.askOutside} outside \`## Waiting on\`, so no card shows: move the line under \`## Waiting on\`` : `${DEFAULT_OWNER} named at ${at} with no ask: write a coded ask or drop the line`,
    note: x.askOutside ? `has ask ${x.askOutside} outside \`## Waiting on\`: move it there` : `names ${DEFAULT_OWNER} with no ask: write a coded ask or drop the line`,
  };
}

export function milestoneStatus(i: StatusInput): MilestoneStatus {
  const now = i.now ?? Date.now();
  const reasons: string[] = [];
  const mine = i.assignments.filter((a) => a.milestoneId === i.milestone.id);
  const sched = mine.filter(scheduled).sort((a, b) => (a.nextWakeAt ?? a.nextRunAt)!.localeCompare((b.nextWakeAt ?? b.nextRunAt)!));
  const names = (list: Assignment[]) => [...new Set(list.map((a) => i.personaName?.(a.personaId) ?? a.personaId))];
  let outcome = outcomeOf(i);
  if (outcome.note?.startsWith(AGENT_VERDICT)) reasons.push(`${AGENT_VERDICT}: the next wake removes it`);
  const all = pendingItems(i.waiting, { responded: i.responded, ...(sched.length ? { persona: names(sched).join(", ") } : {}) });
  // "the owner: verify the Outcome and set Status done" is the Ready to mark step, not a question: with an
  // `## Outcome` written it folds into the one ready_to_mark item (a not_yet outcome the owner calls ready becomes it).
  const rootKey = i.tree?.root.key;
  const marks = i.outcome ? all.filter((x) => x.kind === "free_text_ask" && (!x.nodeKey || x.nodeKey === rootKey) && asksToMark(x)) : [];
  if (marks.length && outcome.word === "not_yet" && !outcome.note?.startsWith(AGENT_VERDICT)) outcome = { word: "ready_to_mark", source: "derived", note: "the owner asks you to verify the Outcome" };
  // any other free-text item is no question the owner can answer: never counted, no card; a defect for the owner.
  const freeText = all.filter((x) => x.kind === "free_text_ask" && !marks.includes(x));
  const items = all.filter((x) => x.kind !== "free_text_ask");
  if (outcome.word === "ready_to_mark") items.push(readyToMarkItem(i.milestone.id, outcome.note, { name: i.milestone.title, sentence: i.outcome?.sentence, ...(i.doneMeans ?? {}) }));
  // a monitor item that names a stop or whose next check is a day overdue is an alert for the owner, not monitoring.
  const alerts = monitorAlerts(i.monitoring, now, (r) => i.monitorAsks?.get(refKey(r)));
  items.push(...alerts.map((a) => monitorAlertItem(i.milestone.id, a, now)));
  if (alerts.some((a) => alertState(a.asks) === "alarm")) reasons.push("defect for the Delivery Manager: a stopped or overdue Monitoring item names no open ask: write a coded ask or clear the item");
  for (const a of alerts) if (alertState(a.asks) === "snoozed") reasons.push(`monitor alert follows your snooze, not counted: ${a.what} (${alertNext(a)})`);
  const open = items.filter((x) => x.state === "open");
  const answered = items.filter((x) => x.state === "answered");
  const notes = wakeNotes(i, mine);
  reasons.push(...notes.map((n) => n.text));
  const defects = [...(i.defects ?? []), ...freeText.map(freeTextDefect)];
  reasons.push(...defects.map((x) => `defect for the Delivery Manager: ${x.text}`));
  const base = { milestoneId: i.milestone.id, outcome, items, ...(notes.length ? { wakeNotes: notes } : {}), ...(defects.length ? { defects } : {}), needsYou: open.length, ...(i.tree ? { progress: { ...progressOf(i.tree.root), color: rootColor(i.tree, i.milestone.id, open) } } : {}) };
  const done = (flow: MilestoneStatus["flow"]): MilestoneStatus => ({ ...base, flow, reasons: [...reasons, flow.reason] });

  if (i.milestone.settledAt) return done({ word: "settled", reason: "settled: hidden from the sidebar and Team home" });
  if (i.milestone.paused || i.status === "paused") return done({ word: "paused", reason: "paused: no wakes until it is resumed" });
  if (open.length) return done({ word: "needs_you", reason: itemsPhrase(open) });
  if (answered.length) reasons.push(`${answered.length} answer${answered.length === 1 ? "" : "s"} received, not acted on yet`);

  const runs = i.runs.filter((r) => mine.some((a) => a.id === r.assignmentId) || r.milestoneId === i.milestone.id);
  const live = runs.filter((r) => isLiveRun(r, now, i.t3State)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (live.length) {
    const run = live.find(isWake) ?? live[0];
    const wakes = runs.filter((r) => isWake(r) && r.assignmentId === run.assignmentId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const n = wakes.findIndex((r) => r.id === run.id);
    const persona = i.personaName?.(mine.find((a) => a.id === run.assignmentId)?.personaId ?? "");
    const confirmed = live.filter((r) => isConfirmedLive(r, now, i.t3State)).length;
    return done({
      word: "working",
      ...(confirmed ? { live: confirmed } : {}),
      reason: `${persona ?? "a persona"} is running${n >= 0 ? ` (wake #${n + 1})` : ""}`,
      run: { id: run.id, assignmentId: run.assignmentId, startedAt: run.startedAt, summary: run.summary, ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}), ...(n >= 0 ? { wake: n + 1 } : {}) },
      ...(persona ? { personas: [persona] } : {}),
    });
  }

  // a draft spine is Planning, a deferred one Parked: no wake works it, so never Stalled, Queued or ready.
  const hold = planOf(i);
  if (hold === "planning") return done({ word: "planning", reason: `planning: a draft, no wake works it until ${ownerName()} stamps it ready` });
  if (hold === "parked") return done({ word: "parked", reason: "parked: deferred, no wake works it" });

  // Monitoring needs a date: a `Monitoring:` item with a next check or an end. The spine's line only,
  // never a timed wake or a run's monitoring report (a monitoring report writes the line, app.ts monitoringInSpine).
  const calm = (i.monitoring ?? []).filter((m) => !alerts.some((a) => a.what === m.what));
  const dated = calm.filter((m) => m.nextCheckAt || m.until);
  if (calm.length && !dated.length) reasons.push("Monitoring line has no date: not monitoring");
  if (dated.length) {
    const next = dated.map((m) => m.nextCheckAt).filter((x): x is string => !!x).sort()[0];
    const until = dated.map((m) => m.until).filter((x): x is string => !!x).sort()[0];
    return done({ word: "monitoring", reason: `monitoring: ${dated[0].what}`, monitoring: dated, ...(next ? { nextWakeAt: next } : {}), ...(until ? { until } : {}) });
  }

  // A step is ready: the park predicate's actionable nodes, the owner's answers to act on, referenced answers.
  const actionable = i.tree && i.tree.source !== "fallback" ? actionableCount(i.tree) + (i.referencedAnswers ?? 0) : undefined;
  const ready = actionable === undefined ? true : actionable > 0 || answered.length > 0;
  if (actionable === undefined) reasons.push("tree not available: treated as having a ready step");
  if (!ready) return done({ word: "nothing_to_do", reason: "no step is ready" });
  // the number shown is the ready rows (readySteps); the open-node count only when no row is marked ready.
  const rows = i.tree && i.tree.source !== "fallback" ? readySteps(i.tree).length : 0;
  const what = rows
    ? `${rows} step${rows === 1 ? "" : "s"} ready`
    : actionable
      ? `${actionable} open item${actionable === 1 ? "" : "s"} to work`
      : answered.length ? "answers to act on" : "steps ready";
  if (sched.length) {
    const at = sched[0].nextWakeAt ?? sched[0].nextRunAt!;
    return done({ word: "queued", reason: `${what}; next wake of ${names(sched.slice(0, 1))[0]}`, nextWakeAt: at, personas: names(sched) });
  }
  const off = mine.length ? `${mine.length} persona${mine.length === 1 ? "" : "s"} assigned, none enabled and scheduled` : "no persona assigned";
  const st = done({ word: "stalled", reason: `${what}; ${off}: nobody will wake` });
  // Stalled is an alarm only for a goal not met yet (deck D3): a marked outcome (accomplished / partially / superseded) adds none.
  if (["accomplished", "partially", "superseded"].includes(outcome.word)) return st;
  return { ...st, items: [...items, stalledItem(i.milestone.id, what, mine, i.personaName)] };
}

/**
 * the big root's dot: red when an open item of this milestone sits on the root itself (no node, or the root's
 * key), else the root's own color. An item shared with another milestone carries that milestone's node key (the batch
 * reads waiting once per world), so it must not paint this root red: the sidebar rings the dot for those instead.
 */
export function rootColor(tree: Tree, milestoneId: string, open: PendingItem[]): TreeColor {
  const root = tree.root;
  return open.some((x) => x.milestoneId === milestoneId && (!x.nodeKey || x.nodeKey === root.key)) ? "red" : root.color;
}

/** the latest ended wake of each assignment of the milestone: idle with ready steps, or a repeated report. */
export function wakeNotes(i: Pick<StatusInput, "runs" | "personaName">, mine: Assignment[]): WakeNote[] {
  const out: WakeNote[] = [];
  for (const a of mine) {
    const last = i.runs
      .filter((r) => r.assignmentId === a.id && isWake(r) && r.kind === "wake" && r.outcome !== "running")
      .sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0];
    if (!last) continue;
    const persona = i.personaName?.(a.personaId) ?? a.personaId;
    if (last.readyIgnored?.length) out.push({ kind: "ready_ignored", persona, runId: last.id, steps: last.readyIgnored, text: readyIgnoredReason(persona, last.readyIgnored) });
    if (last.repeating && last.repeatSince)
      out.push({ kind: "repeating", persona, runId: last.id, n: last.repeating, since: last.repeatSince, text: `${persona}: ${repeatPhrase(last.repeating, last.repeatSince)}` });
  }
  return out;
}

/**
 * the Stalled pending line. Its action switches a persona on (the one that woke last first) or pauses the
 * milestone; with no persona assigned only Pause is offered. `alarm`: orange, not counted in needsYou.
 */
export function stalledItem(milestoneId: string, what: string, mine: Assignment[], personaName?: (id: string) => string | undefined): PendingItem {
  const switchOn = mine
    .filter((a) => !a.enabled || a.parkedAt)
    .sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") || a.createdAt.localeCompare(b.createdAt))
    .map((a) => ({ assignmentId: a.id, persona: personaName?.(a.personaId) ?? a.personaId }));
  const title = switchOn.length ? `${what}, nobody on. Switch on ${switchOn[0].persona}?` : `${what}, ${mine.length ? "no persona scheduled" : "no persona assigned"}`;
  return { id: `stalled:${milestoneId}`, kind: "stalled", state: "alarm", milestoneId, title, ...(switchOn.length ? { switchOn } : {}) };
}

/** Planning / Parked from the root's spines.py run_state, else the spine Status word (draft / deferred). */
export function planOf(i: Pick<StatusInput, "status" | "tree">): "planning" | "parked" | undefined {
  const rs = i.tree?.root.runState;
  if (rs) return rs === "planning" || rs === "parked" ? rs : undefined;
  if (i.tree) return holdState({ ...i.tree.root, kind: "spine" });
  const w = i.status ? statusWordOf(i.status) : undefined;
  return w === "draft" ? "planning" : w === "deferred" ? "parked" : undefined;
}

// ---------- tree colors from the same items (3b, 3c) ----------

/** Node fields the status paint adds: open items for the owner on the node, and the red ring of an ancestor. */
export interface PaintedNode extends TreeNode {
  /** Open items for the owner attached to this node (the Tree red count is their sum). */
  waiting?: number;
  /** An ancestor of a red node: a red ring, never counted as red. */
  rollup?: "red";
  /** the row waits on an open ask counted elsewhere (its code): a red ring, never counted. */
  waitsOn?: string[];
}

/**
 * Repaint a tree from the pending items: a node with an open item is red whatever its status, one count per item.
 * A node red only by its spine words loses red (blocked → yellow, else grey). An open node whose Status (or spines.py
 * Waiting-on references) names an ask that is answered or consumed is flagged `stale` ("status stale"), never red.
 * Items whose node is not in the tree attach to the root; ancestors of a red node get `rollup: "red"` (a ring, not
 * counted). Counts: red = the number of open items. Returns a copy.
 */
export function paintTree(tree: Tree, items: PendingItem[], defects: RefDefect[] = []): Tree {
  const open = items.filter((x) => x.state === "open");
  // a node where the owner is named with no ask (a free-text defect) is amber, never red: it is not counted.
  const named = new Set(defects.flatMap((x) => (x.kind === "free_text" && x.nodeKey ? [x.nodeKey] : [])));
  const root = structuredClone(tree.root) as PaintedNode;
  const byKey = new Map<string, PaintedNode>();
  const visit = (n: PaintedNode) => {
    byKey.set(n.key, n);
    n.children.forEach((c) => visit(c as PaintedNode));
  };
  visit(root);
  const per = new Map<string, number>();
  const refRows = new Map<string, string[]>();
  for (const it of open) {
    // An ask of another milestone this tree waits on sits on its first referencing row here, else the root.
    const refs = (it.refNodes ?? []).filter((k) => byKey.has(k));
    const key = it.nodeKey && byKey.has(it.nodeKey) ? it.nodeKey : (refs[0] ?? root.key);
    per.set(key, (per.get(key) ?? 0) + 1);
    for (const r of refs) if (r !== key) refRows.set(r, [...(refRows.get(r) ?? []), it.code ?? it.title]);
  }
  // Codes no longer open: answered / done / superseded asks and resolved waits in any file of the tree.
  const settled = new Set<string>();
  for (const a of Object.values(tree.asks ?? {}).flat()) if (a.code && (a.state !== "open" || a.doneAt !== undefined)) settled.add(a.code.toUpperCase());
  for (const w of Object.values(tree.waits ?? {}).flat()) if (w.state !== "open" && w.state !== "unresolved") settled.add(w.code.toUpperCase());
  for (const it of items) if (it.state === "answered" && it.code) settled.add(it.code.toUpperCase());
  const openCodes = new Set(open.flatMap((x) => (x.code ? [x.code.toUpperCase()] : [])));
  const refs = (n: TreeNode) => n.flags.includes("cycle") || n.flags.includes("repeat");
  const paint = (n: PaintedNode): boolean => {
    let below = false;
    for (const c of n.children) below = paint(c as PaintedNode) || below;
    const count = refs(n) ? 0 : (per.get(n.key) ?? 0);
    if (count > 0) {
      n.color = "red";
      n.waiting = count;
    } else if (n.color !== "green") {
      // red is only ever an item counted here; a reference node (shown elsewhere) is never a red dot either.
      if (n.color === "red") n.color = /\b(blocked|waiting|needs|on hold)\b/i.test(n.status) ? "yellow" : "grey";
      if (named.has(n.key) && !refs(n)) {
        n.color = "yellow";
        n.notes = [...(n.notes ?? []), `names ${ownerName()} with no ask: the Delivery Manager writes a coded ask or drops the line`];
      }
      const waitsOn = refs(n) ? undefined : refRows.get(n.key);
      if (waitsOn) n.waitsOn = [...new Set(waitsOn)];
      const cited = refs(n) ? [] : [...citedAskCodes(n.status), ...(n.path ? (tree.waits?.[n.path] ?? []).map((w) => w.code.toUpperCase()) : [])];
      const stale = cited.filter((c) => settled.has(c) && !openCodes.has(c));
      if (stale.length && !n.flags.includes("stale")) {
        n.flags.push("stale");
        n.notes = [...(n.notes ?? []), `status stale: names ${[...new Set(stale)].join(", ")}, already answered`];
      }
    }
    if (below && count === 0) n.rollup = "red";
    return below || count > 0;
  };
  paint(root);
  const counts = summarize(root);
  return { ...tree, root, ...counts, counts: { ...counts.counts, red: redCount(root) }, flagged: countFlagged(root) };
}

/** Tree red count: open items on the nodes of a (painted) subtree. */
export function redCount(root: TreeNode): number {
  let n = 0;
  const visit = (x: TreeNode) => {
    n += (x as PaintedNode).waiting ?? 0;
    x.children.forEach(visit);
  };
  visit(root);
  return n;
}

/** Flagged open-work nodes (finished subtrees skipped, as in summarize). */
function countFlagged(root: TreeNode): number {
  let n = 0;
  walkOwn(root, (x) => {
    if (!(x.flags.includes("cycle") || x.flags.includes("repeat")) && x.flags.some((f) => HONESTY_FLAGS.includes(f))) n++;
  });
  return n;
}
