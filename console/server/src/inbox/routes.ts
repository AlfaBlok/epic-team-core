import { repoRowIds } from "../status/rowIds.js";
import { saysYes } from "./priorityAsk.js";
import { HIS_WORDS_MAX } from "../hisWords.js";
import { addGrant, grantPrefix } from "../approvals.js";
import { listView, wantsListView } from "./slimList.js";
import { RecordError } from "../team/milestoneRecord.js";
import { plainAssignments, type RecordedAssignments } from "../team/assignmentRecord.js";
import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { withRubric } from "../cycle/rubric.js";
import type { Store } from "../store.js";
import { CycleError, type Cycle } from "../cycle/service.js";
import type { Run } from "../store.js";
import { answerWakeMessage, askerFor, epicRunState, requestReads, type Asker } from "./asker.js";
import type { HeldAsk } from "./askGate.js";
import { heldToRoute, type HeldOfGoal } from "./heldRoute.js";
import { managerState } from "./asks.js";
import { homeRepo } from "../identity.js";
import { isDm, NO_OWNER, ownerFor, qualifiedCode, VERB, waitingAndHeld, waitingForMilestone, waitingOnJordi, withThreadEnvironments, type Owner, type WaitingDeps, type WaitingItem } from "./waiting.js";
import { pendingItems } from "../status/compute.js";
import { listRepos, resolveRepo } from "../adapters/repos.js";
import { adhocMilestone } from "../routes/spines.js";
import { ASK_TYPE_RULES, asksFor, SNOOZE_UNTIL, snoozedNow, snoozeMinute } from "./asks.js";
import { applySnooze, createSpineWriter, type SpineWrite, type SpineWriter } from "./spineWrite.js";
import { markDelivered, settleWritten } from "./pending.js";
import { DEFAULT_OWNER, ownerOf } from "../tenancy/owner.js";
import { byMilestonePriority, storeRanks } from "./priority.js";
import { worldPriorities } from "./jordiPriority.js";
import { scrub, type SecretPut, type WorldKeys } from "../plug/keys.js";
import { hooks } from "../plug/hooks.js";
import { dropMirror, mirrorApproval, type Mirror } from "./approvalMirror.js";
import path from "node:path";
import { tableVersion } from "../tableVersion.js";
import { milestoneWorld, worldArgs, worldGuard } from "../tenancy/world.js"; // lists of the caller's world only
import { credentialWorld } from "../auth/identity.js";
import type { ReadModelHost } from "../readModel/host.js";
import { computeAdhoc, computeWaiting, viewAdhoc, viewWaiting, wantsAsker, type ViewKey, type WaitingPayload } from "../readModel/views.js";
import { undoHoldMs } from "../press/presses.js";
import { createAnswerJobs, type AnswerJobs, type AnswerStep, type JobState } from "./answerJobs.js";
import { closingEdit, findSettles, settleLine, type Judge, type Settled, type SettleSource } from "./settles.js";
import { AttachError, ATTACH_MAX_PER_MESSAGE } from "../desk/attachLimits.js";
import type { Attachments } from "../desk/attachments.js";
import { addAcceptedAskRow } from "../review/followups.js";
import { withAbout } from "./about.js";
import { deployerName, opsRepo, ownerName } from "../identity.js";
import { createAskLogReader } from "./askRepeat.js";
import { isDuplicate, traceDuplicate, withTrace, type DupCandidate } from "./duplicate.js";

/**
 * E996-S29: the other open asks that store the same key (same `secret: <app> <NAME>`) as `item`: one card and one box in
 * the inbox, and the one Save key answers them all.
 */
/** a spine write refused because the checkout held a leftover (a passing state, cleaned before the next try). */
export const DIRTY_CHECKOUT = /the checkout has uncommitted changes/;

export function sameKeyTwins(items: WaitingItem[], item: WaitingItem): WaitingItem[] {
  const s = item.secret;
  if (!s) return [];
  return items.filter((i) => i.id !== item.id && i.source === "ask" && i.state === "open" && i.secret?.app === s.app && i.secret?.name === s.name);
}

/** ?includeSettled=true|1 (default false). */
/** the longest a GET /waiting-on-owner waits on one item's git blame (an item the stored view did not cover). */
export const ASKER_BUDGET_MS = 750;
/** The promise's value, or undefined once `ms` passed (the promise carries on; its failure is dropped). */
export function withinBudget<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined), new Promise<undefined>((res) => (setTimeout(res, ms) as { unref?: () => void }).unref?.())]);
}
const includeSettled = (c: Context) => ["true", "1"].includes(c.req.query("includeSettled") ?? "");

/**
 * waiting-on-the owner inbox (aggregate + respond) and messages to a persona's home thread.
 * answering a spine item writes the answer into the spine in the repo checkout (one line, commit + push,
 * guarded: inbox/spineWrite.ts); Needs the owner rows keep the message to the asking run's thread. "Send to…" messages go
 * through the cycle (T3 sendToThread to the assignment's home thread, launched if missing).
 */
/** delivered = the spine write was refused by a PR policy but the asker's wake carries the note (it writes the line). */
export type Delivery = "sent" | "delivered" | "queued" | "failed";

export interface JordiResponse {
  id: string;
  itemId: string;
  milestoneId?: string;
  item: Partial<WaitingItem>;
  /** `feedback` = changes wanted, never an approval: the ask line becomes `[feedback …]` and the work reopens. */
  kind: "approve" | "deny" | "answer" | "feedback";
  text: string;
  assignmentId?: string;
  threadId?: string;
  /** T3 environment of threadId, when known. */
  environmentId?: string;
  /**
   * Spine items: sent = the line is in the spine, queued = a guard refused the write, failed = git failed (mirrors `spine`);
   * delivered = a PR policy refused the write and the asker was woken or steered with the answer (it writes the line).
   */
  delivery: Delivery;
  deliveryError?: string;
  createdAt: string;
  deliveredAt?: string;
  /** delivery log of the spine write (absent for Needs the owner rows). */
  spine?: SpineWrite & { at?: string };
  /** this response changes an earlier answer (that response's id; the old one is kept for history). */
  replacesId?: string;
  /** the earlier answer it replaces, as the owner saw it (`answerWord`). */
  replacedAnswer?: string;
  /** a wake of the owning assignment started after this answer (ISO start): the owner may already have read it. */
  ownerRunSince?: string;
  /** whether the answer woke or steered the persona who asked (absent before). */
  wake?: WakeResult;
  /** registered by the Team desk from what the owner said in the chat (`chat` = his words, verified against the desk thread); or by a milestone chat (its own thread). */
  via?: Via;
  chat?: string;
  /**
   * the background job that writes the answer into the spine and wakes the asker after the click was answered
   * (inbox/answerJobs.ts): pending (saved, waiting to run or to retry at nextAt), running, done, failed (error = why; Retry).
   */
  job?: { state: JobState; attempts: number; error?: string; nextAt?: string };
  /** the other open asks the same answer closed (each written in its spine) and the maybes, with the one line he reads. */
  settles?: Settled;
}

/**
 * what an answer did to the persona who asked. woken = Run now with the answer as instructions; steered = its
 * running session got the answer (mode thread = the answer message already went to that session's thread); skipped =
 * a bound held (paused / settled milestone, epic not runnable, nobody to wake); off = the owner unticked Wake; failed = T3 refused.
 * queued = its run is live but has no thread yet (a wake still launching): the steer is retried in the
 * background until the thread exists (then steered), the run ends (then woken) or STEER_RETRY_FOR_MS pass (then failed).
 */
export interface WakeResult {
  notified: "woken" | "steered" | "queued" | "skipped" | "off" | "failed";
  runId?: string;
  mode?: "steer" | "auto" | "thread" | "held" | "handled";
  reason?: string;
  /** The asker it went to (or would have). */
  persona?: string;
  assignmentId?: string;
}

export interface Message {
  id: string;
  milestoneId?: string;
  /** Absent when an ask_for_asks request went to an owner thread with no persona attached. */
  assignmentId?: string;
  /** message = the owner's own text; ask_for_asks = the fixed "write human asks" request. */
  kind: "message" | "ask_for_asks";
  text: string;
  refItemId?: string;
  threadId?: string;
  /** T3 environment of threadId, when known. */
  environmentId?: string;
  delivery: Delivery;
  deliveryError?: string;
  createdAt: string;
}

/**
 * snooze body: `days` (the dropdown: 3 days, 1 week, 1 month) or `until`; `until: null` unsnoozes. Or
 * `hours: 3` (3 hours, written as a UTC minute); `until` may be a day or a minute (`2026-11-02T18:30Z`).
 */
const snoozeIn = z
  .object({
    milestoneId: z.string().optional(),
    hours: z.literal(3).optional(),
    days: z.union([z.literal(3), z.literal(7), z.literal(30)]).optional(),
    until: z.string().regex(new RegExp(`^${SNOOZE_UNTIL}$`)).nullable().optional(),
    /** E948-S83 iteration 2: pressed as Park (the card's own button), so the commit says parked. */
    park: z.literal(true).optional(),
  })
  .refine((b) => b.hours !== undefined || b.days !== undefined || b.until !== undefined, { message: "hours, days or until is required" });
/** `days` after today (UTC), as YYYY-MM-DD. */
export const snoozeDate = (days: number, now = Date.now()) => new Date(now + days * 86_400_000).toISOString().slice(0, 10);
const stripQ = (q: string) => q.replace(/\s+/g, " ").trim().slice(0, 200);

const respondIn = z
  .object({
    kind: z.enum(["approve", "deny", "answer", "feedback"]),
    text: z.string().max(HIS_WORDS_MAX).default(""),
    milestoneId: z.string().optional(),
    // "Approve and grant write": approve a Needs the owner item and give the asking run's assignment write, limited to scope.
    grantWrite: z.object({ scope: z.string().trim().min(1).max(2000) }).strict().optional(),
    // wake (or steer) the persona who asked; false only records the answer.
    wake: z.boolean().default(true),
    // the Team desk registers an answer the owner gave in the chat: `via` + his words verbatim (checked against the desk thread).
    via: z.enum(["team-desk", "milestone-chat"]).optional(),
    chat: z.string().max(HIS_WORDS_MAX).optional(),
    // the web's idempotency key for this click (also accepted as header Idempotency-Key): a retried request with
    // the same key returns the answer already stored, never records a second one.
    clientKey: z.string().trim().min(8).max(128).optional(),
    // files he uploaded first (POST /api/chat/attachments); their links follow his words (attachments.cardText).
    attachments: z.array(z.string().trim().max(40)).max(ATTACH_MAX_PER_MESSAGE).optional(),
    // Accept (one, or Accept all on a persona's set of recommendations): approving also adds a ready row for it.
    asRow: z.boolean().optional(),
  })
  .strict();
/** the key itself; parsed by hand so a validation error never echoes it. */
const secretIn = (raw: unknown): { value: string; milestoneId?: string; wake: boolean } | string => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "request body must be an object";
  const b = raw as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== "value" && k !== "milestoneId" && k !== "wake");
  if (extra.length) return `unknown field(s): ${extra.join(", ")}`;
  if (typeof b.value !== "string") return "value must be a string";
  if (b.milestoneId !== undefined && typeof b.milestoneId !== "string") return "milestoneId must be a string";
  if (b.wake !== undefined && typeof b.wake !== "boolean") return "wake must be true or false";
  const value = b.value.trim();
  if (!value) return "paste the key first";
  if (value.length > 20_000) return "the value is too long for a key";
  if (/[\r\n]/.test(value)) return "a key is one line: the pasted value has several lines";
  return { value, wake: b.wake !== false, ...(b.milestoneId ? { milestoneId: b.milestoneId } : {}) };
};
/** a steps page's private box, through the ask's key path (`ok` carries names only, never the value). */
export type PasteKey = (i: { repo: string; spine: string; ask: string; app: string; name: string; value: string; file?: boolean }) => Promise<
  { ok: true; stored: { app: string; name: string; deployed: boolean; vault?: string; where?: string } } | { ok: false; status: 400 | 403 | 404 | 409 | 502; code: string; message: string }
>;
/** the answer a key ask gets in the spine (never the value). */
export const KEY_PROVIDED_ANSWER = "key provided in the console (stored with secret put, value never shown)";
/** the same for a world on its own secret store (backend `tenant`). */
export const KEY_PROVIDED_WORLD_ANSWER = "key provided in the console (stored in the world's secret store, value never shown)";
/** the answer when the key was saved in the owner's vault and read back before the card closed. */
export const keyVaultAnswer = (vault: string, where?: string) => `key provided in the console (saved in your ${vault}${where ? `, ${where},` : ""} and read back, value never shown)`;
export const isKeyProvidedAnswer = (t: string) => t === KEY_PROVIDED_ANSWER || t === KEY_PROVIDED_WORLD_ANSWER || /^key provided in the console \(saved in your .+ and read back, value never shown\)$/.test(t);

/** a queued answer re-tries its steer this often, for this long. */
export const STEER_RETRY_MS = 5_000;
export const STEER_RETRY_FOR_MS = 120_000;
/** how often the inbox reads look for answers the asker wrote into the spine itself. */
export const SETTLE_MS = 30_000;
export const RESTART_QUEUED_REASON = "console restarted while the answer was queued for a session still starting";

/** `to: "delivery-manager"` (Pending selector "Rewrite as a coded ask") sends it to the milestone's Delivery Manager when it has one. */
const requestAsksIn = z.object({ milestoneId: z.string().min(1), path: z.string().min(1), to: z.literal("delivery-manager").optional() }).strict();
const changeIn = z
  .object({
    kind: z.enum(["approve", "deny", "answer", "feedback"]),
    text: z.string().max(HIS_WORDS_MAX).default(""),
    wake: z.boolean().default(true),
    attachments: z.array(z.string().trim().max(40)).max(ATTACH_MAX_PER_MESSAGE).optional(),
  })
  .strict();
const messageIn = z
  .object({
    milestoneId: z.string().min(1),
    assignmentId: z.string().min(1),
    text: z.string().trim().min(1).max(HIS_WORDS_MAX),
    refItemId: z.string().optional(),
  })
  .strict();

type Row = Record<string, any>;
const opt = <T>(v: T | null | undefined) => (v == null ? undefined : v);

const toResponse = (r: Row): JordiResponse => {
  const item = JSON.parse(r.item || "{}");
  const asker: Asker | undefined = item.asker;
  return {
  id: r.id,
  itemId: r.item_id,
  milestoneId: opt(r.milestone_id),
  item,
  kind: r.kind,
  text: r.text,
  assignmentId: opt(r.assignment_id),
  threadId: opt(r.thread_id),
  delivery: r.delivery,
  deliveryError: opt(r.delivery_error),
  createdAt: r.created_at,
  deliveredAt: opt(r.delivered_at),
  ...(r.replaces_id ? { replacesId: r.replaces_id } : {}),
  ...(r.via ? { via: r.via, ...(r.chat_text ? { chat: r.chat_text } : {}) } : {}),
  ...(r.job_state
    ? { job: { state: r.job_state, attempts: r.job_attempts ?? 0, ...(r.job_error ? { error: r.job_error } : {}), ...(r.job_next_at ? { nextAt: r.job_next_at } : {}) } }
    : {}),
  ...(r.settles ? { settles: JSON.parse(r.settles) as Settled } : {}),
  ...(r.spine_status
    ? {
        spine: {
          status: r.spine_status,
          ...(r.spine_reason ? { reason: r.spine_reason } : {}),
          ...(r.spine_sha ? { sha: r.spine_sha } : {}),
          ...(r.spine_path ? { path: r.spine_path } : {}),
          ...(r.spine_at ? { at: r.spine_at } : {}),
        },
      }
    : {}),
  ...(r.wake_status
    ? {
        wake: {
          notified: r.wake_status,
          ...(r.wake_run_id ? { runId: r.wake_run_id } : {}),
          // a steer keeps its mode in wake_reason
          ...(r.wake_reason ? (r.wake_status === "steered" ? { mode: r.wake_reason } : { reason: r.wake_reason }) : {}),
          ...(asker ? { assignmentId: asker.assignmentId, ...(asker.personaName ? { persona: asker.personaName } : {}) } : {}),
        },
      }
    : {}),
  };
};
const toMessage = (r: Row): Message => ({
  id: r.id,
  milestoneId: opt(r.milestone_id),
  assignmentId: opt(r.assignment_id),
  kind: r.kind ?? "message",
  text: r.text,
  refItemId: opt(r.ref_item_id),
  threadId: opt(r.thread_id),
  delivery: r.delivery,
  deliveryError: opt(r.delivery_error),
  createdAt: r.created_at,
});

const today = () => new Date().toISOString().slice(0, 10);
/** what the spine line says when the Team desk registered the owner's chat answer. */
export const DESK_VIA = `by ${ownerName()} via Team desk`;
/** the same when a milestone chat registered it. */
export const MILESTONE_CHAT_VIA = `by ${ownerName()} via milestone chat`;
export type Via = "team-desk" | "milestone-chat";
const viaText = (via: string | undefined) => (via === "milestone-chat" ? MILESTONE_CHAT_VIA : DESK_VIA);
const viaName = (via: string | undefined) => (via === "milestone-chat" ? "milestone chat" : "Team desk");
export const answerWord = (kind: JordiResponse["kind"], text: string) =>
  kind === "approve"
    ? `APPROVED${text.trim() ? ` — ${text.trim()}` : ""}`
    : kind === "deny"
      ? `DENIED${text.trim() ? ` — ${text.trim()}` : ""}`
      : kind === "feedback"
        ? `FEEDBACK, changes wanted, not approved — ${text.trim()}`
        : text.trim();

/**
 * free text is never read as an approval. On an approve ask the outcomes are Approve, Feedback and Deny, so words
 * sent as a plain answer (a click, the Team desk, a chat) are his feedback: the work reopens and comes back as a new round.
 */
export const outcomeKind = (item: Partial<WaitingItem>, kind: JordiResponse["kind"], text?: string): JordiResponse["kind"] =>
  // E948-S139: "Duplicate or already answered" closes any card as answered, an approve ask too (never a new round).
  kind === "answer" && item.source === "ask" && item.ask === "approve" && !item.decidedBy && !isDuplicate(text) ? "feedback" : kind;

/**
 * What a Needs the owner answer sends the owner: the item, the owner's answer and the skill's write-back steps
 * (human-asks.md §Answering it). Spine items no longer get it (the `[answered]` line in the spine replaces it).
 */
export function responseMessage(item: Partial<WaitingItem>, kind: JordiResponse["kind"], text: string, base: string, viaDesk: boolean | Via = false): string {
  const answer = answerWord(kind, text) + (viaDesk ? ` (${viaText(viaDesk === true ? undefined : viaDesk)})` : "");
  // the owner reverses a decision a persona took for him: an answer on the same ask, no spine rewrite by the console.
  if (item.decidedBy) {
    const code = qualifiedCode(item);
    return [
      `${code ? `${code}: ` : ""}${ownerName()} REVERSES the decision ${item.decidedBy} took (via the agent-team console).`,
      `Milestone: ${item.milestoneTitle ?? "?"} (${item.milestoneId ?? "?"})${item.path ? ` · file: ${item.path}` : ""} · item ${item.id}`,
      `Decided: ${item.question ?? item.title ?? ""}${item.answer ? ` — answer: ${item.answer}` : ""}`,
      `${ownerName()}'s answer: ${answer}`,
      "",
      `Undo it now using the rollback on the \`[answered …]\` line, in ${item.path ? `\`${item.path}\`` : "the milestone spine"}:`,
      "1. Roll the change back (the line's `rollback:`), then rewrite the line to `[answered " + (item.code ? `${item.code} ` : "") + `${today()} @${ownerName()}] <what was decided> — answer: reversed — ${answer}\` so it stays recorded.`,
      `2. Add a Decisions row (date, reversed, who decided, citing ${ownerName()}'s reversal) and update Current State.`,
      `3. Commit and push per the repo's Integration policy, then continue toward green by the path ${ownerName()}'s answer names.`,
      `Reply with one line saying what you changed. (Console: ${base})`,
    ].join("\n");
  }
  const where = item.path ? `the spine \`${item.path}\`` : "the milestone spine";
  const code = qualifiedCode(item);
  const lines = [
    // human-asks v2 §Answering it: an answer that cites a code applies to that ask; the code leads, qualified by repo.
    ...(code ? [`${code}: ${answer}`, ""] : []),
    `From ${ownerName()} via the agent-team console: answer to a waiting-on-${ownerName()} item.`,
    `Milestone: ${item.milestoneTitle ?? "?"} (${item.milestoneId ?? "?"})${item.path ? ` · file: ${item.path}` : ""} · item ${item.id}`,
    `Ask: ${code ? `${code} ` : ""}${VERB[item.ask ?? "unknown"]}: ${item.question ?? item.title ?? ""}`,
    ...(item.options?.length ? [`Options: ${item.options.join(" | ")}`] : []),
    ...(item.recommendation ? [`Recommended: ${item.recommendation}`] : []),
    ...(item.detail ? [`Context: ${item.detail}`] : []),
    `${ownerName()}'s answer: ${answer}`,
    "",
    `Write it back now (epicspine-skill docs/doctrine/human-asks.md, "Answering it"), in ${where}:`,
    item.source === "ask"
      ? `1. Change the ask's tag to \`[answered ${item.code ? `${item.code} ` : ""}${today()} @${ownerName()}]\` and append \` — answer: ${answer}\`.`
      : `1. This item was not in the human-ask format: add it under \`## Waiting on\` as \`- [answered ${today()} @${ownerName()}] <the question> — answer: ${answer}\` (and from now on raise asks in that format).`,
    `2. Add a Decisions row (date, outcome, the answer, ${ownerName()}${item.code ? `, citing ${item.code}` : ""}).`,
    `3. Unblock ${item.row ? `row ${item.row}` : "the blocked row"} (set its Status to what it is now) and update Current State \`Waiting on:\`.`,
    `4. Commit and push per the repo's Integration policy, then continue the work it unblocks within your remit.`,
    `Reply with one line saying what you changed. (Console: ${base})`,
  ];
  return lines.join("\n");
}

/**
 * "Ask owner to write asks": the fixed request for one spine whose rows mention the owner but carry no ask
 * (guessed items). Asks the owner to restate the real current blockers as contract-v2 asks, synthesized.
 */
/** the correction a thread-delivered answer gets when the owner changes it (same thread as the first answer). */
export function changedAnswerMessage(item: Partial<WaitingItem>, oldAnswer: string, newAnswer: string, base: string): string {
  const code = qualifiedCode(item);
  return [
    `${code ? `${code}: ` : ""}${ownerName()} changed his answer to "${item.question ?? item.title ?? ""}" to: ${newAnswer}`,
    `This replaces his earlier answer (${oldAnswer || "(empty)"}); act on the new one. If you already acted on the old one, correct it toward the new answer.`,
    `Milestone: ${item.milestoneTitle ?? "?"} (${item.milestoneId ?? "?"})${item.path ? ` · file: ${item.path}` : ""} · item ${item.id}`,
    `Reply with one line saying what you changed. (Console: ${base})`,
  ].join("\n");
}

export function askForAsksText(o: { milestoneTitle: string; milestoneId: string; path: string; spineTitle: string; items: Partial<WaitingItem>[]; base: string }): string {
  return [
    `From ${ownerName()} via the agent-team console: please write human asks for ${o.spineTitle} (\`${o.path}\`, milestone ${o.milestoneTitle}).`,
    `These ${o.items.length} item${o.items.length === 1 ? "" : "s"} mention ${ownerName()}, but no agent has asked anything, so the console can only guess:`,
    ...o.items.map((i) => `- ${i.title ?? i.question}${i.detail ? ` (${i.detail})` : ""}`),
    "",
    "Restate the real current blockers as human-ask lines under `## Waiting on`, per epicspine-skill docs/doctrine/human-asks.md (v2):",
    "1. Synthesize them to the fewest human actions (merge asks one action resolves; order by the critical path; aim for at most 3).",
    `2. Each line gets a code \`<epic code>-A<n>\` and a type: \`[ask <code>: decide|approve|provide|do @${ownerName()} since <date> row <id>] <one self-contained question>\`, in plain words with \`context:\` (why this comes up), \`impact:\`, \`risk:\` (and rollback), \`recommend:\` (and why), \`why ${ownerName()}:\`, then \`options:\` (decide), \`steps:\` (do: only things ${ownerName()} does by hand, never commands), \`unblocks:\` and \`effort:\`.`,
    ...ASK_TYPE_RULES.map((l) => `   ${l}`),
    "3. A human named on a later step is a plan, not an ask: leave future gates as plain ledger text until that row is next.",
    `4. If nothing actually blocks on ${ownerName()} now, say so: set Current State \`Waiting on: none\` and drop his name from rows that do not need him yet.`,
    "5. Update Current State `Waiting on:` with the codes, commit and push per the repo's Integration policy.",
    `Reply with one line listing the ask codes you wrote (or "none"). (Console: ${o.base})`,
  ].join("\n");
}

export function messageText(o: { milestoneTitle: string; milestoneId: string; text: string; item?: Partial<WaitingItem> }): string {
  return [
    `Message from ${ownerName()} via the agent-team console · milestone ${o.milestoneTitle} (${o.milestoneId})` +
      (o.item ? ` · about: ${VERB[o.item.ask ?? "unknown"]}: ${o.item.question ?? o.item.title}${o.item.path ? ` (${o.item.path})` : ""}` : ""),
    "---",
    o.text.trim(),
    "---",
    `Treat this as an instruction from ${ownerName()} within your remit and the repo's AGENTS.md / EpicSpine rules. Reply with one line saying what you will do.`,
  ].join("\n");
}

/** lets the ask path check that words handed over by the Team desk are the owner's own in the desk chat. */
export interface DeskChat {
  /** `world` = a world's own desk thread (the social product's desk); absent = the home Team desk. */
  jordiSaid(chat: string, world?: string): Promise<boolean>;
}

/**
 * Which desk is calling, from X-Console-Run. `team-desk` is the Team desk of the caller's own world (a world's
 * token reads that world's desk thread, never the home one); `world-desk:<w>` is world w's own desk and needs w's own
 * credential (or none, on the console host). undefined = not a desk; a string = why the header is refused.
 */
export function deskCaller(header: string | undefined, own: string | undefined, home: string): { world: string } | string | undefined {
  const h = (header ?? "").trim().toLowerCase();
  if (h === "team-desk") return { world: own ?? home };
  const m = /^world-desk:([a-z0-9][a-z0-9_-]*)$/.exec(h);
  if (!m) return undefined;
  if (own && own !== m[1]) return `X-Console-Run ${h} is only for world ${m[1]}'s own desk, with its own token`;
  return { world: m[1]! };
}

/** a milestone chat answers asks only inside its subtree, with the owner's words from ITS thread. */
export interface MilestoneChatAsks {
  caller(header: string | undefined): string | undefined;
  /** Why the chat of `callerId` may not answer this item (outside its subtree), or undefined. */
  refusal(callerId: string, item: WaitingItem): Promise<string | undefined>;
  jordiSaid(callerId: string, chat: string): Promise<boolean>;
}

export function mountInbox(
  api: Hono,
  o: { db: DB; store: Store; cycle: Cycle; deps: WaitingDeps; spine?: SpineWriter; secretPut?: SecretPut; deskChat?: DeskChat; milestoneChat?: MilestoneChatAsks;
    /** where a pasted key goes, per world (secrets/worlds.ts); absent = the infra repo `secret put` as before. */ keys?: WorldKeys;
    /** a write changed this checkout: drop its spines.py output and trees, so the next read shows the change. */ invalidate?: (repoDir: string) => void;
    /** lists answered from console.db views (readModel/host.ts); absent = computed per request as before. */ readModel?: ReadModelHost;
    /**
     * when POST …/respond replies. `saved` (production): as soon as the answer is stored (the item looked up in the
     * stored views only, never spines.py or git on the click); the spine write, push and wake run after in a job. `done`
     * (default, tests and agent callers that read the outcome): the same job, awaited before the reply.
     */
    answerAck?: "saved" | "done";
    /** a write grant also goes to the world's state/assignments.json first (default: console.db only). */
    recordAssignments?: (s: Store) => RecordedAssignments;
    /** pauses between the job's tries (answerJobs RETRY_MS). */ answerRetryMs?: number[];
    /** false on a passive console (shared staging): the answer jobs belong to the database's own console. */ resumeJobs?: boolean;
    /** files sent with an answer become links after his words (desk/attachments.ts). */ attachments?: Pick<Attachments, "cardText">;
    /** an answer brought back before its job ran (its presses are marked undone). */ onAnswerUndone?: (id: string) => void;
    /** each answer job's state change (the press log follows it). */ onAnswerJob?: (id: string, s: { state: "pending" | "running" | "done" | "failed"; attempts: number; error?: string | null }) => void;
    /** one answer closes many (settles.ts): on, with the model check when a judge is given; absent = off. */ settle?: { judge?: Judge };
    /**
     * an approved improvement request goes to the world that builds it (inbox/improvement.ts): one desk note in its
     * repo, after his answer is in the spine. `retry` = worth trying again (git, a checkout not there yet).
     */
    improvement?: (r: JordiResponse) => Promise<{ ok: true; note: string } | { ok: false; retry: boolean; error: string }>;
    /** his Yes on a priority ask puts its objective first in docs/pursuits.json (inbox/priorityAsk.ts). */
    priority?: (r: JordiResponse) => Promise<{ ok: true; note: string } | { ok: false; retry: boolean; error: string }> },
): { jobs: AnswerJobs; pasteKey: PasteKey; searchSources: () => Promise<{ waiting: Record<string, unknown>[]; responses: Record<string, unknown>[] }>; settle?: (src: SettleSource) => Promise<Settled> } {
  const { db, store, cycle } = o;
  const spineWriter = o.spine ?? createSpineWriter();
  const secretPut = o.secretPut ?? hooks.keys.runner();
  const iso = () => new Date().toISOString();
  const err = (c: Context, status: 400 | 403 | 404 | 409 | 413 | 415 | 502 | 503, code: string, message: string) =>
    c.json({ error: { code, message } }, status);
  /** the T3 environment next to a threadId (when the console knows it), for t3code:// links. */
  const withEnv = <T extends { threadId?: string }>(x: T): T & { environmentId?: string } => {
    const e = x.threadId ? o.deps.threadEnvironment?.(x.threadId) : undefined;
    return e ? { ...x, environmentId: e } : x;
  };

  /** the earlier answer a change replaces, for the card and Activity. */
  const withReplaced = (r: JordiResponse): JordiResponse => {
    if (!r.replacesId) return r;
    const old = db.prepare("SELECT kind, text FROM jordi_responses WHERE id = ?").get(r.replacesId) as Row | undefined;
    return old ? { ...r, replacedAnswer: answerWord(old.kind, old.text) } : r;
  };
  /**
   * every stored answer of the world, parsed, kept until the table changes (tableVersion: a trigger counts
   * every write, from any connection). The inbox read and parsed all of them (570 rows, 1.6 MB of JSON) twice on every
   * request, about half of the asks list's time. The kept objects are shared: callers copy, never change them.
   */
  let responsesVersion: (() => number | undefined) | undefined;
  const parsedResponses = new Map<string, { v: number; rows: JordiResponse[] }>();
  const allResponses = (): JordiResponse[] => {
    responsesVersion ??= tableVersion(db, "jordi_responses");
    const v = responsesVersion();
    const world = store.tenant ?? "";
    const hit = parsedResponses.get(world);
    if (v !== undefined && hit?.v === v) return hit.rows;
    const rows = (
      db.prepare(`SELECT * FROM jordi_responses WHERE ${worldGuard()} ORDER BY created_at DESC, rowid DESC`).all(...worldArgs(store.tenant)) as Row[]
    ).map((r) => withReplaced(toResponse(r)));
    if (v !== undefined) parsedResponses.set(world, { v, rows });
    return rows;
  };
  /** the stored answers (newest first), of one milestone or item when asked, each with its thread's environment. */
  const listResponses = (f: { milestoneId?: string; itemId?: string } = {}) => {
    const envOf = new Map<string, string | undefined>(); // one lookup per thread for the whole list
    const env = (t: string) => (envOf.has(t) ? envOf.get(t) : (envOf.set(t, o.deps.threadEnvironment?.(t)), envOf.get(t)));
    return allResponses()
      .filter((r) => (!f.milestoneId || r.milestoneId === f.milestoneId) && (!f.itemId || r.itemId === f.itemId))
      .map((r) => {
        const e = r.threadId ? env(r.threadId) : undefined;
        return e ? { ...r, environmentId: e } : r;
      });
  };
  const getResponse = (id: string) => {
    const r = db.prepare(`SELECT * FROM jordi_responses WHERE id = ? AND ${worldGuard()}`).get(id, ...worldArgs(store.tenant)) as Row | undefined;
    return r && withReplaced(withEnv(toResponse(r)));
  };
  const listMessages = (milestoneId?: string) =>
    (db.prepare(`SELECT * FROM messages WHERE (? IS NULL OR milestone_id = ?) AND ${worldGuard()} ORDER BY created_at DESC, rowid DESC`).all(milestoneId ?? null, milestoneId ?? null, ...worldArgs(store.tenant)) as Row[]).map(
      (r) => withEnv(toMessage(r)),
    );

  /**
   * Deliver to an assignment's home thread, else (no persona attached) to the owner thread named in the spine's
   * `Owner:`; never throws, returns the delivery state. Same message and idempotent clientRequestId on both paths.
   */
  const send = async (assignmentId: string | undefined, text: string, requestId: string, ownerThreadId?: string, answerRun?: string) => {
    if (!assignmentId && !ownerThreadId) return { delivery: "queued" as Delivery, error: NO_OWNER.label };
    try {
      const r = assignmentId ? await cycle.deliver(assignmentId, text, requestId, answerRun ? { answerRun: true, summary: answerRun } : {}) : await cycle.deliverToThread(ownerThreadId!, text, requestId);
      return { delivery: "sent" as Delivery, threadId: r.threadId, runId: "runId" in r ? r.runId : undefined };
    } catch (e) {
      return { delivery: "failed" as Delivery, error: e instanceof CycleError ? `${e.code}: ${e.message}` : (e as Error).message };
    }
  };

  /** Repo checkout of a milestone (its `repo` under the console's repos root). */
  const repoDirOf = (milestoneId?: string) => {
    const m = milestoneId ? store.getMilestone(milestoneId) : undefined;
    return { m, repo: m ? resolveRepo(o.deps.reposRoot, m.repo) : undefined };
  };
  /** the checkout name a response's answer belongs to (the pending note names it). */
  const repoNameOf = (r: Pick<JordiResponse, "milestoneId" | "item">) => {
    const { m, repo } = repoDirOf(r.milestoneId);
    return r.item.repo ?? repo?.name ?? m?.repo ?? "the repo";
  };
  /**
   * answers the console could not write (queued / delivered) whose `[answered …]` line is in the spine now (the
   * asker's own PR merged) become sent. On every inbox read, at most once per SETTLE_MS; once at start.
   */
  let settledAt = 0;
  const settlePending = (force = false) => {
    if (!force && Date.now() - settledAt < SETTLE_MS) return;
    settledAt = Date.now();
    try {
      settleWritten(db, (id) => repoDirOf(id).repo?.path);
    } catch {
      /* a read never fails on this pass */
    }
  };
  /**
   * the items of a scope (as `waitingOnJordi`) from the read model's stored view, with when it was last current;
   * without a read model (or for a view never stored: computed once, inline) as before.
   */
  const itemsIn = async (f: { milestoneId?: string; nodeKey?: string; includeSettled?: boolean; includeSuperseded?: boolean }): Promise<{ items: WaitingItem[]; asOf?: string; askers?: Record<string, Asker | null> }> => {
    const rm = o.readModel;
    if (!rm) return { items: await waitingOnJordi(o.deps, f) };
    const k: Extract<ViewKey, { kind: "waiting" }> = { kind: "waiting", world: store.tenant ?? "", ...(f.milestoneId ? { milestoneId: f.milestoneId } : {}), includeSettled: !!f.includeSettled };
    const v = await rm.view(k, () => computeWaiting(o.deps, k));
    return { items: viewWaiting(v.payload, f), asOf: v.asOf, ...(v.payload.askers ? { askers: v.payload.askers } : {}) };
  };
  /** The item the owner acts on: from the stored view (fast), else read fresh (an item newer than the view). */
  const findItem = async (id: string, f: { milestoneId?: string; includeSuperseded?: boolean }): Promise<WaitingItem | undefined> =>
    (await itemsIn(f)).items.find((i) => i.id === id) ?? (o.readModel ? (await waitingOnJordi(o.deps, f)).find((i) => i.id === id) : undefined);
  /**
   * the item behind a click from the stored views only (no spines.py, no git, no inline compute): the milestone's
   * views, then the whole world's, open and settled. Undefined when no stored view has it (an ask newer than the views).
   */
  /** every item of the stored view the click reads (the milestone's, else the world's), for code counts. */
  const storedItems = (milestoneId?: string): WaitingItem[] | undefined => {
    const rm = o.readModel;
    if (!rm) return undefined;
    for (const scope of milestoneId ? [{ milestoneId }, {}] : [{}])
      for (const includeSettled of [false, true]) {
        const v = rm.peek<WaitingPayload>({ kind: "waiting", world: store.tenant ?? "", ...scope, includeSettled });
        if (v) return viewWaiting(v.payload, { includeSuperseded: true });
      }
    return undefined;
  };
  /** E948-S139: what a duplicate tap may repeat: every ask he answered (the asks log) and the other open asks in the inbox. */
  const dupLog = createAskLogReader({ reposRoot: o.deps.reposRoot });
  const dupCandidates = (item: WaitingItem, milestoneId?: string): DupCandidate[] => [
    ...dupLog().map((a) => ({ ref: a.code ?? a.row ?? "an earlier ask", question: a.question, repo: a.repo, row: a.row, on: a.on, answer: a.answer })),
    ...(storedItems(milestoneId) ?? [])
      .filter((i) => i.id !== item.id && i.state === "open")
      .map((i) => ({ ref: i.code ?? i.row ?? i.id, question: i.question || i.title || "", repo: i.repo, row: i.row, open: true })),
  ];
  const findStored = (id: string, milestoneId?: string): { item: WaitingItem; asker?: Asker | null } | undefined => {
    const rm = o.readModel;
    if (!rm) return undefined;
    const world = store.tenant ?? "";
    for (const scope of milestoneId ? [{ milestoneId }, {}] : [{}])
      for (const includeSettled of [false, true]) {
        const v = rm.peek<WaitingPayload>({ kind: "waiting", world, ...scope, includeSettled });
        const item = v ? viewWaiting(v.payload, { includeSuperseded: true }).find((i) => i.id === id) : undefined;
        if (item) return { item, ...(v!.payload.askers && id in v!.payload.askers ? { asker: v!.payload.askers[id] } : {}) };
      }
    return undefined;
  };
  /** answered lines are signed by the world's owner; nothing extra for the owner (the home world writes unchanged). */
  const signedBy = (milestoneId?: string) => {
    const handle = ownerOf(o.db, milestoneId).handle;
    return handle === DEFAULT_OWNER ? {} : { owner: handle };
  };

  /**
   * write (or re-write after a refusal) the answer into the spine of the item's repo checkout and log the
   * outcome on the response: spine_status written / skipped (a guard refused, reason kept) / failed (git error).
   */
  const writeToSpine = async (r: JordiResponse): Promise<JordiResponse> => {
    const item = r.item;
    const { m, repo } = repoDirOf(r.milestoneId);
    // an approved answer changed to feedback: the answered line becomes his `[feedback …]` line (its row reopens).
    const changed = r.kind === "feedback" && r.replacesId ? getResponse(r.replacesId) : undefined;
    const res: SpineWrite = !repo
      ? { status: "skipped", reason: `no checkout of “${m?.repo ?? "?"}” under the console's repos root`, ...(item.path ? { path: item.path } : {}) }
      : changed?.spine?.status === "written"
        ? await spineWriter.change({
            repoDir: repo.path,
            target: {
              id: changed.itemId,
              source: "ask",
              question: item.question ?? item.title ?? "",
              ...(item.row ? { row: item.row } : {}),
              ...(item.code ? { code: item.code } : {}),
              ...(item.path ? { path: item.path } : {}),
            },
            answer: r.text.trim(),
            feedback: true,
            label: changed.itemId,
            ...signedBy(r.milestoneId),
          })
        : await spineWriter.answer({
          repoDir: repo.path,
          target: {
            id: r.itemId,
            source: item.source === "ask" ? "ask" : "heuristic",
            question: item.question ?? item.title ?? "",
            ...(item.row ? { row: item.row } : {}),
            ...(item.code ? { code: item.code } : {}),
            ...(item.line !== undefined ? { line: item.line } : {}),
            ...(item.path ? { path: item.path } : {}),
          },
          // feedback goes on a `[feedback …]` line as his words alone (the tag says it is not an approval).
          answer: (r.kind === "feedback" ? r.text.trim() : answerWord(r.kind, r.text)) + (r.via ? ` (${viaText(r.via)})` : ""),
          ...(r.kind === "feedback" ? { feedback: true } : {}),
          label: r.itemId,
          ...(r.via ? { via: { name: viaName(r.via), ...(r.chat ? { chat: r.chat } : {}) } } : {}),
          ...signedBy(r.milestoneId),
        });
    const delivery: Delivery = res.status === "written" ? "sent" : res.status === "skipped" ? "queued" : "failed";
    db.prepare(
      `UPDATE jordi_responses SET delivery = ?, delivery_error = ?, delivered_at = ?, spine_status = ?, spine_reason = ?, spine_sha = ?, spine_path = ?, spine_at = ? WHERE id = ?`,
    ).run(
      delivery,
      res.status === "written" ? null : (res.reason ?? res.status),
      res.status === "written" ? iso() : null,
      res.status,
      res.reason ?? null,
      res.sha ?? null,
      res.path ?? null,
      res.status === "written" ? iso() : null,
      r.id,
    );
    // a re-delivery refused again keeps `delivered` when the asker already has the note.
    if (res.status === "skipped") markDelivered(db, r.id, repoNameOf(r));
    if (res.status === "written" && repo && !changed) await readyRowFor(r, repo.path, res.path ?? item.path);
    return getResponse(r.id)!;
  };

  /**
   * an accepted recommendation (approve sent with `asRow`) becomes a ready row in the ask's spine, his accept the
   * ready stamp (root L-37); the row's code goes on the stored item (`readyRow`) for the card. Its own commit after the
   * answered line; a row already there for the ask (a retried job) is not added twice. A write that does not land keeps
   * the reason on the item (`readyRowError`); the answer stands either way.
   */
  const readyRowFor = async (r: JordiResponse, repoDir: string, rel: string | undefined): Promise<void> => {
    const item = r.item;
    if (r.kind !== "approve" || !item.asReadyRow || item.source !== "ask" || !item.code || !rel || item.readyRow) return;
    let ref: string | undefined;
    const w = await spineWriter.edit({
      repoDir,
      path: rel,
      label: item.code,
      group: true,
      edit: (text, date) => {
        const a = addAcceptedAskRow(text, { code: item.code!, question: item.question ?? item.title ?? "", ...(item.asker?.personaName ? { persona: item.asker.personaName } : {}) }, date, ownerOf(o.db, r.milestoneId).handle, repoRowIds(repoDir));
        if ("skip" in a) return a;
        ref = a.ref;
        return { text: a.text, msg: `${a.ref} ready: ${ownerName()} accepted ${item.code} (via console)`, body: `${stripQ(item.question ?? "")}\n\nAccepted on the console: his accept is the ready stamp (root L-37), so this is a ready row the team delivers.` };
      },
    });
    if (w.status === "written") o.invalidate?.(repoDir);
    const note = w.status === "written" && ref ? { readyRow: ref } : { readyRowError: w.reason ?? w.status };
    db.prepare("UPDATE jordi_responses SET item = ? WHERE id = ?").run(JSON.stringify({ ...item, ...note }), r.id);
  };

  /**
   * Deliver (or re-deliver) a stored response. Spine items (ask / heuristic): the spine write above; no message to the
   * owner (the `[answered]` line is the hand-off). Needs the owner rows: to the asking run's thread, else the owner,
   * re-resolving the owner (a persona may be attached now).
   */
  const deliverResponse = async (r: JordiResponse): Promise<JordiResponse> => {
    const item = r.item;
    if (item.source !== "needs_jordi" && !item.decidedBy) return writeToSpine(r);
    // A persona-decided FYI's reversal (and an answer stored before on a Needs the owner row) goes to the owner's
    // thread: a persona attached since keeps priority; else the owner thread the item was resolved to.
    const owner: Owner | undefined = r.milestoneId ? ownerFor(store, r.milestoneId, o.deps.homeThread, item.owner?.assignmentId) : undefined;
    const assignmentId = owner?.assignmentId;
    const ownerThread = !assignmentId && item.owner?.kind === "thread" ? item.owner.threadId : undefined;
    const out: { delivery: Delivery; threadId?: string; error?: string; assignmentId?: string } = {
      ...(await send(assignmentId, responseMessage(item, r.kind, r.text, cycle.publicUrl, r.via ?? false), `console-resp-${r.id}`, ownerThread)),
      assignmentId,
    };
    db.prepare(
      `UPDATE jordi_responses SET delivery = ?, delivery_error = ?, thread_id = COALESCE(?, thread_id), assignment_id = COALESCE(?, assignment_id), delivered_at = ? WHERE id = ?`,
    ).run(out.delivery, out.error ?? null, out.threadId ?? null, out.assignmentId ?? null, out.delivery === "sent" ? iso() : null, r.id);
    return getResponse(r.id)!;
  };

  /**
   * one answer closes many. After his answer to an ask is in the spine, every other open ask of the world
   * it clearly settles (settles.ts: exact links, then the model's strict yes/no) is closed with his words quoted and a
   * link to where he said them; the maybes are listed, never closed. Once per answer: the result is stored on the row
   * (settles) and a retry of the job reads it back. Off unless the console was given `settle`.
   */
  const settleOthers = async (r: JordiResponse): Promise<Settled | undefined> => {
    if (!o.settle) return undefined;
    const done = db.prepare("SELECT settles FROM jordi_responses WHERE id = ?").get(r.id) as Row | undefined;
    if (done?.settles) return JSON.parse(done.settles) as Settled;
    const item = r.item;
    if (r.spine?.status !== "written" || item.source !== "ask" || item.decidedBy || r.replacesId || !item.question) return undefined;
    const { repo } = repoDirOf(r.milestoneId);
    const repoName = item.repo ?? repo?.name;
    const label = qualifiedCode({ code: item.code, repo: repoName }) ?? `“${item.question.replace(/\s+/g, " ").trim().slice(0, 60)}”`;
    const rel = r.spine.path ?? item.path;
    const link = repo?.remote && rel ? `https://github.com/${repo.remote}/blob/${r.spine.sha ?? "HEAD"}/${rel}${item.line !== undefined ? `?plain=1#L${item.line + 1}` : ""}` : undefined;
    const owner = ownerOf(o.db, r.milestoneId).handle;
    const src: SettleSource = {
      kind: "ask",
      itemId: r.itemId,
      ...(repoName ? { repo: repoName } : {}),
      ...(rel ? { path: rel } : {}),
      ...(item.code ? { code: item.code } : {}),
      ...(item.row ? { row: item.row } : {}),
      ask: item.ask,
      question: item.question,
      detail: [item.contextText, item.steps, item.recommendation, item.impact, item.unblocks].filter(Boolean).join(" — "),
      ...(item.secret ? { secret: item.secret } : {}),
      answerKind: r.kind,
      // his own words: the chat he said them in when a desk registered them, else what he typed or pressed
      words: r.chat?.trim() || (r.kind === "answer" ? r.text.trim() : answerWord(r.kind, r.text)),
      label,
      ...(link ? { link } : {}),
      owner,
    };
    const settled = await settleFrom(src);
    db.prepare("UPDATE jordi_responses SET settles = ? WHERE id = ?").run(JSON.stringify(settled), r.id);
    return settled;
  };
  /** find what `src` settles in the whole world and close each clear one in its own spine (settles.ts). */
  const settleFrom = async (src: SettleSource): Promise<Settled> => {
    // the whole world's open asks (every repo), from the stored view: a stale entry is caught by the write (not open any more)
    const open = (await itemsIn({})).items;
    const found = await findSettles(src, open, o.settle?.judge);
    const closed: Settled["closed"] = [];
    for (const m of found.close) {
      const cand = open.find((i) => i.id === m.itemId)!;
      const dir = cand.repo ? resolveRepo(o.deps.reposRoot, cand.repo)?.path : repoDirOf(cand.milestoneId).repo?.path;
      const w: SpineWrite =
        !dir || !cand.path
          ? { status: "skipped", reason: `no checkout of ${cand.repo ?? "its repo"} on the console host` }
          : await spineWriter.edit({ repoDir: dir, path: cand.path, label: cand.id, edit: closingEdit(src, m, cand) });
      if (w.status === "written") {
        o.readModel?.patch({ kind: "answered", id: cand.id });
        if (dir) o.invalidate?.(dir);
      }
      closed.push({ ...m, write: { itemId: m.itemId, code: m.code, status: w.status, ...(w.sha ? { sha: w.sha } : {}), ...(w.reason ? { reason: w.reason } : {}) } });
    }
    const written = closed.filter((c) => c.write.status === "written");
    // a close that did not land is a maybe for the next wake (the ask is still open)
    const maybe = [...found.maybe, ...closed.filter((c) => c.write.status !== "written").map(({ write, ...m }) => ({ ...m, reason: `not written: ${write.reason ?? write.status}` }))];
    return {
      at: iso(),
      closed: written,
      maybe,
      checked: found.checked,
      ...(found.judgeError ? { judgeError: found.judgeError } : {}),
      label: src.label,
      line: settleLine({ close: written, maybe }),
    };
  };

  const errText = (e: unknown) => (e instanceof CycleError ? e.message : (e as Error).message);
  const recordWake = (id: string, w: WakeResult): JordiResponse => {
    db.prepare(`UPDATE jordi_responses SET wake_status = ?, wake_run_id = ?, wake_reason = ? WHERE id = ?`).run(
      w.notified,
      w.runId ?? null,
      (w.notified === "steered" ? w.mode : w.reason) ?? null,
      id,
    );
    // the asker has the answer (woken / steered) and the PR policy keeps the console out: delivered, not queued.
    if (w.notified === "woken" || w.notified === "steered") {
      const r = getResponse(id);
      if (r) markDelivered(db, id, repoNameOf(r));
    }
    return getResponse(id)!;
  };

  /**
   * after an answer is recorded, wake the persona who asked pointed at it, or steer its running session; once per
   * response id (a woken / steered / off outcome is final; a skipped or failed one is tried again on re-delivery).
   * Bounds: a paused or settled milestone, or an epic that is not runnable, gets no wake (the answer waits for the next one).
   */
  const notifyAsker = async (r: JordiResponse, opt: { wake?: boolean; answer?: string; oldAnswer?: string; settled?: Settled } = {}): Promise<JordiResponse> => {
    if (r.wake && ["woken", "steered", "off"].includes(r.wake.notified)) return r;
    if (steerRetries.has(r.id)) return r; // its queued steer is already being retried
    if (opt.wake === false) return recordWake(r.id, { notified: "off", reason: "Wake was unticked: the answer is only recorded" });
    const item = r.item;
    let asker = item.asker;
    if (!asker) {
      asker = await askerFor(o.deps, { ...item, milestoneId: item.milestoneId ?? r.milestoneId });
      if (asker) db.prepare("UPDATE jordi_responses SET item = ? WHERE id = ?").run(JSON.stringify({ ...item, asker }), r.id);
    }
    const skip = (reason: string) => recordWake(r.id, { notified: "skipped", reason });
    if (!asker) return skip("no persona attached to wake");
    const a = store.getAssignment(asker.assignmentId);
    const m = a ? store.getMilestone(a.milestoneId) : undefined;
    if (!a || !m) return skip("the asking assignment is gone");
    if (m.paused) return skip("the milestone is paused");
    if (m.settledAt) return skip("the milestone is settled");
    // Needs the owner rows and reversals were delivered as a thread message; spine answers are the `[answered]` line.
    const threadDelivered = item.source === "needs_jordi" || !!item.decidedBy;
    // a refused / failed spine write still wakes the asker: it writes the answer in itself (per the Integration policy).
    const unwritten = !threadDelivered && r.spine?.status !== "written" ? (r.spine?.reason ?? r.deliveryError ?? "the spine write did not happen") : undefined;
    const rel = item.path ?? m.path;
    // his feedback reopened the work: it is a start order (L-37), whatever the epic's status read before.
    // so is his Approve on an approve ask: a proposer persona's draft epic asks "start this?", and his yes is the
    // ready stamp the asker writes in (else the approval would wait forever on an epic no wake may work).
    if (rel && r.kind !== "feedback" && !(r.kind === "approve" && item.ask === "approve")) {
      const tree = await o.deps.treeFor(m).catch(() => undefined);
      const st = tree ? epicRunState(tree, rel) : undefined;
      if (st && !st.runnable) return skip(`its epic is ${st.status}, not runnable`);
    }
    const repo = item.repo ?? resolveRepo(o.deps.reposRoot, m.repo)?.name ?? m.repo;
    const text = (steer: boolean) =>
      answerWakeMessage({
        item,
        answer: opt.answer ?? (r.kind === "feedback" ? r.text.trim() : answerWord(r.kind, r.text)),
        repo,
        sha: r.spine?.sha,
        oldAnswer: opt.oldAnswer,
        steer,
        ...(unwritten !== undefined ? { unwritten } : {}),
        ...(r.kind === "feedback" ? { feedback: true } : {}),
        ...(opt.settled && (opt.settled.closed.length || opt.settled.maybe.length)
          ? { settled: { closed: opt.settled.closed.map((m) => m.code), maybe: opt.settled.maybe.map((m) => m.code), label: opt.settled.label } }
          : {}),
      });
    const steer = async (live: Run | undefined): Promise<WakeResult> => {
      // The answer message itself already went into that session's thread.
      if (threadDelivered && live?.threadId && r.threadId === live.threadId) return { notified: "steered", runId: live.id, mode: "thread" };
      try {
        const s = await cycle.steer(a.id, text(true), `console-answer-${r.id}`);
        return { notified: "steered", runId: s.run.id, mode: s.mode };
      } catch (e) {
        // the run is live but its thread is still being launched: queue the answer and retry the steer.
        const still = e instanceof CycleError && e.code === "not_running" ? cycle.liveRun(a.id) : undefined;
        if (still) return { notified: "queued", runId: still.id };
        return { notified: "failed", reason: `could not steer the running session: ${errText(e)}` };
      }
    };
    /** Steer the live run, else wake the idle asker (Run now); a launch racing ours turns into a steer. */
    const attempt = async (): Promise<WakeResult> => {
      const live = cycle.liveRun(a.id);
      if (live) return steer(live);
      try {
        const run = await cycle.runNow(a.id, { instructions: text(false), instructionsBy: ownerName() });
        // a wake that started meanwhile got the answer queued into its thread (start guard): a steer, not a wake
        if (run.startGuard === "queued") return { notified: "steered", runId: run.id, mode: "steer" };
        // held for the next wake, or the same answer already reached a wake: no new wake
        if (run.startGuard === "held" || run.startGuard === "handled") return { notified: "steered", runId: run.id, mode: run.startGuard };
        return { notified: "woken", runId: run.id };
      } catch (e) {
        if (e instanceof CycleError && e.code === "already_running") return steer(cycle.liveRun(a.id));
        return { notified: e instanceof CycleError && ["settled", "cycle_disabled"].includes(e.code) ? "skipped" : "failed", reason: errText(e) };
      }
    };
    const w = await attempt();
    if (w.notified === "queued") retrySteer(r.id, attempt);
    return recordWake(r.id, w);
  };

  /**
   * a queued answer: try again every STEER_RETRY_MS (same clientRequestId, so a repeat is idempotent in T3) until
   * it is steered (the thread exists) or woken (the run ended meanwhile), or STEER_RETRY_FOR_MS pass (failed). In memory
   * only: a restart fails the row (sweep below) so Retry picks it up.
   */
  const steerRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const retrySteer = (id: string, attempt: () => Promise<WakeResult>, tries = Math.ceil(STEER_RETRY_FOR_MS / STEER_RETRY_MS)) => {
    const t = setTimeout(async () => {
      let w: WakeResult;
      try {
        w = await attempt();
      } catch (e) {
        w = { notified: "failed", reason: errText(e) };
      }
      if (w.notified === "queued" && tries > 1) {
        recordWake(id, w); // the run being waited on may have changed
        return retrySteer(id, attempt, tries - 1);
      }
      steerRetries.delete(id);
      if (w.notified === "queued")
        w = { notified: "failed", reason: `its session had no thread to steer after ${Math.round(STEER_RETRY_FOR_MS / 60_000)} min (run ${w.runId})` };
      recordWake(id, w);
    }, STEER_RETRY_MS);
    t.unref?.();
    steerRetries.set(id, t);
  };
  // at start, settle what the askers wrote in meanwhile (the stuck the memory service card included), and mark
  // delivered the older queued answers whose asker was already woken or steered with them.
  settlePending(true);
  for (const r of db.prepare(`SELECT id, milestone_id, item FROM jordi_responses WHERE delivery = 'queued' AND spine_status = 'skipped' AND wake_status IN ('woken', 'steered')`).all() as Row[])
    markDelivered(db, r.id, repoNameOf({ milestoneId: opt(r.milestone_id), item: JSON.parse(r.item || "{}") }));
  // no retry survives a restart: a row still queued now is failed, so Retry (re-delivery) picks it up.
  db.prepare(`UPDATE jordi_responses SET wake_status = 'failed', wake_reason = ? WHERE wake_status = 'queued'`).run(RESTART_QUEUED_REASON);

  /** An answer written into the spine shows as `done` for this long after the owner deletes the line. */
  const DONE_SHOWN_MS = 3 * 86_400_000;

  /** The answer on the item's `[answered]` line as the spine has it right now (the file, not the cached tree). */
  const answeredNow = (it: WaitingItem): string | undefined => {
    const { repo } = repoDirOf(it.milestoneId);
    if (!repo || !it.path) return undefined;
    const a = asksFor(repo.path, it.path).find((x) => x.state === "answered" && x.doneAt === undefined && x.question === it.question);
    return a ? (a.answer ?? "(answered)") : undefined;
  };

  const inScope = (r: JordiResponse, scope: { milestoneId?: string; nodeKey?: string }) => {
    if (scope.milestoneId && r.milestoneId !== scope.milestoneId) return false;
    const key = r.item.nodeKey;
    return !scope.nodeKey || key === scope.nodeKey || !!key?.startsWith(scope.nodeKey + "/");
  };
  /** a write grant is changed on the assignment, not by changing the answer. */
  const changeBlocked = (r: JordiResponse) => !!(r.item as { grantedScope?: string }).grantedScope;
  /** the first wake of the owning assignment that started after the answer (the owner may have read it). */
  const withOwnerRun = (r: JordiResponse, it: Partial<WaitingItem>, wakes: (assignmentId: string) => string[] = wakeStarts()): JordiResponse => {
    const ids = [...new Set([it.owner?.assignmentId, r.assignmentId].filter((x): x is string => !!x))];
    const since = ids
      .flatMap(wakes)
      .filter((startedAt) => startedAt > r.createdAt)
      .sort()[0];
    return since ? { ...r, ownerRunSince: since } : r;
  };
  /** an assignment's last 50 runs' wake start times, read once per list (was once per answered card, each a copy of 50 runs). */
  function wakeStarts(): (assignmentId: string) => string[] {
    const kept = new Map<string, string[]>();
    return (a) => {
      let w = kept.get(a);
      if (!w) kept.set(a, (w = store.listRuns({ assignmentId: a, limit: 50 }).filter((x) => x.kind === "wake").map((x) => x.startedAt)));
      return w;
    };
  }

  /**
   * Attach the owner's latest answer to each item. State comes from the spine: an open item whose answer was written is
   * re-read from the file (spines.py output is cached), and a written answer whose line the owner has since deleted
   * comes back as a `done` item (from the stored snapshot) for a few days. `scope` limits those to the view.
   */
  /**
   * (the owner 22 Nov 03:35Z: "I press send and it disappears and then it comes back"): a coded ask is one ask
   * whatever its id (repo, file, row and wording make the id; a reworded line or the answered tag changes it). His
   * written answer to the same file and code, given since the ask was opened, answers it.
   */
  // E948-S182: by repo and code, not file: a line moved to another epic is the same ask (E906-A12 showed twice after E906-S228).
  const codeKey = (repo?: string | null, code?: string | null) => (code ? `${repo ?? ""}\u0000${code.toUpperCase()}` : "");
  const answeredByCode = (byCode: Map<string, JordiResponse>, it: Pick<WaitingItem, "source" | "path" | "code" | "since" | "repo">, unique: (repo: string, code: string) => boolean): JordiResponse | undefined => {
    if (it.source !== "ask" || !it.code || !it.path || !unique(it.repo ?? "", it.code)) return undefined;
    const r = byCode.get(codeKey(it.repo, it.code));
    if (!r) return undefined;
    const opened = it.since ? Date.parse(it.since) : NaN;
    return Number.isFinite(opened) && Date.parse(r.createdAt) < opened ? undefined : r;
  };
  /** a code that names one ask in its file (two asks can share a code: those still match by question). */
  const uniqueCodes = (all: WaitingItem[]) => {
    const n = new Map<string, number>();
    for (const i of all) if (i.source === "ask" && i.code && i.path) n.set(codeKey(i.repo, i.code), (n.get(codeKey(i.repo, i.code)) ?? 0) + 1);
    return (repo: string, code: string) => n.get(codeKey(repo, code)) === 1;
  };
  const writtenByCode = (): Map<string, JordiResponse> => {
    const m = new Map<string, JordiResponse>();
    for (const r of listResponses()) if (r.spine?.status === "written" && r.item.code && r.item.path && !m.has(codeKey(r.item.repo, r.item.code))) m.set(codeKey(r.item.repo, r.item.code), r);
    return m;
  };
  const withResponses = (all: WaitingItem[], scope: { milestoneId?: string; nodeKey?: string; adhoc?: boolean } = {}) => {
    // a done-marked line stays in the spine for good; its card is shown for a few days after the marker date.
    const items = all.filter((i) => !(i.state === "done" && i.doneAt && Date.now() - Date.parse(i.doneAt) > DONE_SHOWN_MS));
    const latest = new Map<string, JordiResponse>();
    // The flipped line has no `row` (the answered tag drops it), so its item id differs from the open ask's:
    // match a written response to an answered line by file + question too.
    const qkey = (path?: string, question?: string) => `${path ?? ""}\u0000${question ?? ""}`;
    const byQuestion = new Map<string, JordiResponse>();
    const responses = listResponses(); // once per request (was twice)
    for (const r of responses) {
      if (!latest.has(r.itemId)) latest.set(r.itemId, r);
      if (r.spine?.status === "written" && !byQuestion.has(qkey(r.item.path, r.item.question))) byQuestion.set(qkey(r.item.path, r.item.question), r);
    }
    const answeredLines = new Set(items.filter((i) => i.source === "ask" && (i.state === "answered" || i.state === "done")).map((i) => qkey(i.path, i.question)));
    // E948-S155: an ask reworded between his press and the answered line keeps its code: the line carries the answer, so
    // the stored copy of the old wording never comes back as a second card (one ask showed twice, two wordings).
    // E948-S182: keyed by repo and code, so a moved line is still the same ask.
    const answeredCodes = new Set(items.filter((i) => i.source === "ask" && (i.state === "answered" || i.state === "done") && i.code).map((i) => codeKey(i.repo, i.code)));
    // every code the list holds as a live line, whatever its state: a stored record of that code never comes back as a second card
    const listedCodes = new Set(items.filter((i) => i.source === "ask" && i.code).map((i) => codeKey(i.repo, i.code)));
    const byCode = new Map<string, JordiResponse>();
    for (const r of responses) if (r.spine?.status === "written" && r.item.code && !byCode.has(codeKey(r.item.repo, r.item.code))) byCode.set(codeKey(r.item.repo, r.item.code), r);
    const unique = uniqueCodes(items);
    const wakes = wakeStarts();
    const shownByCode = new Set<string>();
    const out = items.flatMap((it): (WaitingItem & { response?: JordiResponse })[] => {
      const byId = latest.get(it.id) ?? (it.legacyId ? latest.get(it.legacyId) : undefined);
      const r = byId ?? (it.state === "answered" || it.state === "done" ? (byQuestion.get(qkey(it.path, it.question)) ?? (it.source === "ask" && it.code ? byCode.get(codeKey(it.repo, it.code)) : undefined)) : undefined);
      // an open coded ask whose code he already answered (written) since it was opened is answered, whatever
      // its id now (a reworded line, or a view older than the answered line): never an open card again. E948-S182: a coded
      // ask keeps one id, so his written answer may be found by that id too; the same rule holds.
      const sameCode = it.state === "open" && (!r || r.spine?.status === "written") ? answeredByCode(byCode, it, unique) : undefined;
      if (sameCode) shownByCode.add(sameCode.id);
      if (sameCode) return [{ ...it, state: "answered" as const, answer: answerWord(sameCode.kind, sameCode.text), response: withOwnerRun(sameCode, it, wakes) }];
      if (!r) return [it];
      // A free-text `Waiting on:` item whose answer is now an `[answered]` line is carried by that line's card.
      if (it.source === "heuristic" && r.spine?.status === "written" && answeredLines.has(qkey(it.path, it.question))) return [];
      const now = it.state === "open" && r.spine?.status === "written" ? answeredNow(it) : undefined;
      // the answered tag drops the ask's kind; the ask as it was answered keeps it, so Change answer offers that
      // kind's buttons (an approve ask: Changes wanted, never a plain answer box the server would read as feedback).
      const kind = it.source === "ask" && it.ask === "unknown" && r.item.ask && r.item.ask !== "unknown" ? { ask: r.item.ask } : {};
      return [{ ...it, ...kind, ...(now ? { state: "answered" as const, answer: now } : {}), response: withOwnerRun(r, it, wakes) }];
    });
    if (scope.adhoc) return out;
    const present = new Set(items.flatMap((i) => (i.legacyId ? [i.id, i.legacyId] : [i.id])));
    for (const [id, r] of latest) {
      // no Needs the owner rows are read here (they were a DB store of asks); an answered spine line is its own card.
      if (present.has(id) || shownByCode.has(r.id) || r.spine?.status !== "written" || r.item.source === "needs_jordi") continue;
      if (answeredLines.has(qkey(r.item.path, r.item.question)) || answeredCodes.has(codeKey(r.item.repo, r.item.code)) || listedCodes.has(codeKey(r.item.repo, r.item.code))) continue;
      if (!inScope(r, scope)) continue;
      if (Date.now() - Date.parse(r.spine.at ?? r.createdAt) > DONE_SHOWN_MS) continue;
      out.push({ ...(r.item as WaitingItem), state: "done", answer: answerWord(r.kind, r.text), response: r });
    }
    return out.map((it) => withThreadEnvironments(it, o.deps.threadEnvironment));
  };

  // E996-S48: the open asks the ask gate keeps from the owner (once each, with its reason) and how many each rule holds.
  api.get("/asks/held", async (c) => {
    const seen = new Set<string>();
    const held: (HeldAsk & { milestoneId: string; rule: string })[] = [];
    for (const m of store.listMilestones().filter((x) => !x.settledAt)) {
      for (const h of (await waitingAndHeld(o.deps, m)).held) {
        const k = `${h.repo}:${h.path}:${h.line ?? h.question}`;
        if (seen.has(k)) continue;
        seen.add(k);
        held.push({ milestoneId: m.id, rule: heldRule(h.reason), ...h });
      }
    }
    const byRule: Record<string, number> = {};
    for (const h of held) byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;
    // the held asks other goals' managers left (off, or 2 h untouched), which the home goal's Delivery Manager now takes
    const ms = store.listMilestones().filter((x) => !x.settledAt && !x.paused && x.repo);
    const root = (x: (typeof ms)[number]) => /(^|\/)root\.md$/i.test(x.path ?? "");
    const home = ms.find((x) => root(x) && resolveRepo(o.deps.reposRoot, x.repo)?.name === homeRepo()) ?? ms.find(root) ?? ms[0];
    const goals: HeldOfGoal[] = ms.map((m) => ({
      milestoneId: m.id,
      title: m.title,
      managerOn: managerState(store, m.id) === "on",
      held: held.filter((h) => h.milestoneId === m.id),
    }));
    const routed = home ? heldToRoute(goals, home.id).map(({ code, repo, path, line, question, goal, why, hours }) => ({ code, repo, path, line, question, goal, why, hours })) : [];
    return c.json({ count: held.length, byRule, held, ...(home ? { home: { milestoneId: home.id, title: home.title } } : {}), routed });
  });

  api.get("/waiting-on-owner", async (c) => {
    settlePending();
    const milestoneId = c.req.query("milestoneId") || undefined;
    const nodeKey = c.req.query("nodeKey") || undefined;
    // ad hoc node view: ?repo=<checkout name>&path=<spine> (no milestone); keys match GET /spine-tree.
    const repoName = c.req.query("repo");
    if (repoName && !milestoneId) {
      const repo = listRepos(o.deps.reposRoot).find((x) => x.name === repoName);
      const rel = c.req.query("path");
      if (!repo || !rel) return err(c, 400, "validation_error", "repo (a checkout name) and path are required");
      const title = c.req.query("title") || undefined;
      if (o.readModel) {
        const k: Extract<ViewKey, { kind: "adhoc" }> = { kind: "adhoc", world: store.tenant ?? "", repo: repo.name, path: rel, ...(title ? { title } : {}) };
        const v = await o.readModel.view(k, () => computeAdhoc(o.deps, k));
        c.header("X-Read-Model-As-Of", v.asOf);
        return c.json(withResponses(viewAdhoc(v.payload ?? [], nodeKey), { adhoc: true }));
      }
      const items = await waitingForMilestone(o.deps, adhocMilestone(repo, rel, title));
      return c.json(withResponses(items.filter((it) => !nodeKey || it.nodeKey === nodeKey || it.nodeKey?.startsWith(nodeKey + "/")), { adhoc: true }));
    }
    if (milestoneId && !store.getMilestone(milestoneId)) return err(c, 404, "not_found", `milestone ${milestoneId} not found`);
    const includeSuperseded = ["true", "1"].includes(c.req.query("includeSuperseded") ?? "");
    // the stored view (never spines.py or git on this request), with when it was last current.
    const read = await itemsIn({ milestoneId, nodeKey, includeSettled: includeSettled(c), includeSuperseded });
    if (read.asOf) c.header("X-Read-Model-As-Of", read.asOf);
    // the owner chose "Yes: trim the asks next" after the slow-phone fix: `?scope=open` sends only the open asks, what the
    // inbox's first draw shows (16 of 423 on 26 Nov, ~8% of the bytes); the app fetches the whole list right after.
    const openOnly = c.req.query("scope") === "open";
    const answered = withResponses(read.items, { milestoneId, nodeKey });
    const items = openOnly ? answered.filter((it) => it.state === "open") : answered;
    if (openOnly) c.header("X-Inbox-Scope", "open");
    // the card names who an answer wakes ("Wake <persona>"): open and answered items (Change answer), persona decisions (Reverse).
    // an FYI card shows the rubric scores its verdict was judged by (per-ask memory).
    const reads = { ...o.deps, store: requestReads(o.deps.store) }; // one DB read per question for all cards
    // the top milestone's items first (sidebar order); ties keep the order built above.
    // before that, the owner's level from the Prioritizer (high, normal, low), each item with its why.
    // the asker the refresher stored with the view (it reads git blame); only an item it did not cover is worked out here.
    // an item the stored view did not cover asks git (blame) here; a slow git never holds the list: past
    // ASKER_BUDGET_MS the card goes out without its asker (the blame finishes into the cache for the next read).
    const askerOf = async (it: WaitingItem) =>
      read.askers && it.id in read.askers ? (read.askers[it.id] ?? undefined) : await withinBudget(askerFor(reads, it), ASKER_BUDGET_MS);
    const full = await Promise.all(withRubric(db, byMilestonePriority(items, storeRanks(store, o.deps.reposRoot), worldPriorities(store, o.deps.reposRoot))).map(async (it) => (wantsAsker(it) ? { ...it, asker: await askerOf(it) } : it)));
    // the web app's Inbox asks for `view=list` (done and superseded items as one-line rows, no second copy
    // of each item inside its answer): 1.78 MB became ~0.2 MB. Agents' curl without `view` still get every field.
    const topical = full.map(withAbout);
    return c.json(wantsListView((n) => c.req.query(n)) ? listView(topical as unknown as Record<string, unknown>[]) : topical);
  });

  /**
   * one item whole (the card behind a folded Answered or Superseded row, fetched when it opens). The same list
   * as GET /waiting-on-owner (settled and superseded items included, ?milestoneId narrows), then that one id.
   */
  api.get("/waiting-on-owner/:id", async (c) => {
    settlePending();
    const id = c.req.param("id");
    const milestoneId = c.req.query("milestoneId") || undefined;
    if (milestoneId && !store.getMilestone(milestoneId)) return err(c, 404, "not_found", `milestone ${milestoneId} not found`);
    const read = await itemsIn({ milestoneId, includeSettled: true, includeSuperseded: true });
    const found = withResponses(read.items, { milestoneId }).find((it) => it.id === id);
    if (!found) return err(c, 404, "not_found", `item ${id} not found`);
    const [it] = withRubric(db, [found]).map(withAbout);
    return c.json(wantsAsker(it) ? { ...it, asker: await withinBudget(askerFor({ ...o.deps, store: requestReads(o.deps.store) }, it), ASKER_BUDGET_MS) } : it);
  });

  /** Why this answer cannot be taken for this item (checked on the click, or by the job for an item it had to resolve). */
  const answerRefusal = (item: WaitingItem, kind: JordiResponse["kind"], text: string): { status: 400 | 409; code: string; message: string } | undefined => {
    if (item.state === "superseded") return { status: 409, code: "conflict", message: "this item is superseded: it takes no answer" };
    // Reverse on an FYI card: a persona-decided ask takes a reversal (an answer; approve/deny make no sense for it).
    if (item.decidedBy && kind !== "answer") return { status: 400, code: "validation_error", message: "a decision a persona took is reversed with an answer (Reverse), not approved or denied" };
    if (kind === "answer" && !text.trim()) return { status: 400, code: "validation_error", message: "an answer needs text" };
    // Feedback and Deny are on every card; feedback needs his words (what should change).
    if (kind === "feedback" && !text.trim()) return { status: 400, code: "validation_error", message: "feedback needs your words: say what should change" };
    if (kind === "approve" && !(item.decidable || item.ask === "approve"))
      return { status: 400, code: "validation_error", message: `approve is only for Needs ${ownerName()} items and approve asks; pick an option, press Done, or send an answer instead` };
    return undefined;
  };
  const setItem = (id: string, item: Partial<WaitingItem>) => db.prepare("UPDATE jordi_responses SET item = ? WHERE id = ?").run(JSON.stringify(item), id);

  /**
   * the job behind a stored answer (answerJobs.ts), each step recorded on the row so a later try (or the next
   * process) continues where this one stopped: resolve the item (when the click found no stored view of it), find who
   * asked (git blame, before the line is rewritten), write the spine (commit + push) or deliver the persona request, then
   * wake or steer the asker. A git or T3 failure is retried; a guard's refusal (dirty tree, PR policy) is final (Retry).
   */
  const answerStep: AnswerStep = async (id, { last }) => {
    let r = getResponse(id);
    if (!r) return { state: "failed", error: "the answer is not in console.db any more" };
    const row = db.prepare("SELECT job_wake FROM jordi_responses WHERE id = ?").get(id) as Row | undefined;
    const wake = row?.job_wake !== 0;
    if ((r.item as { unresolved?: boolean }).unresolved) {
      const item = (await waitingOnJordi(o.deps, { ...(r.milestoneId ? { milestoneId: r.milestoneId } : {}), includeSuperseded: true })).find((i) => i.id === r!.itemId);
      if (!item) return { state: "failed", error: `the ask ${r.itemId} is not in the spine any more (answered already, or the spine changed)` };
      // the click did not know the ask yet: a plain answer on an approve ask is his feedback.
      const kind = outcomeKind(item, r.kind, r.text);
      const bad = answerRefusal(item, kind, r.text);
      if (bad) return { state: "failed", error: bad.message };
      if (kind !== r.kind) db.prepare("UPDATE jordi_responses SET kind = ? WHERE id = ?").run(kind, id);
      setItem(id, item);
      db.prepare("UPDATE jordi_responses SET assignment_id = COALESCE(assignment_id, ?) WHERE id = ?").run(item.owner?.assignmentId ?? null, id);
      r = getResponse(id)!;
    }
    // Always before the write, Wake ticked or not: a later Wake now needs the asker the ask line's blame names.
    if (!r.item.asker && !(r.item as { askerChecked?: boolean }).askerChecked) {
      const asker = await askerFor(o.deps, { ...r.item, milestoneId: r.item.milestoneId ?? r.milestoneId } as WaitingItem);
      setItem(id, { ...r.item, ...(asker ? { asker } : { askerChecked: true }) });
      r = getResponse(id)!;
    }
    const delivered = (x: JordiResponse) => x.delivery === "sent" || x.delivery === "delivered";
    // a `delivered` answer (PR policy: the asker writes the line) is not in the spine yet: each try writes again
    // (the line may be in the spine by now, or the policy changed); the ask stays open until it is.
    if (!delivered(r) || (r.delivery === "delivered" && r.spine?.status !== "written")) {
      r = await deliverResponse(r);
      if (r.delivery === "failed" && !last) return { state: "retry", error: r.spine?.reason ?? r.deliveryError ?? "delivery failed" };
    }
    // the card and every count change at once,: only once the answer is in the spine (a skipped, failed or
    // pending write leaves the ask open everywhere, with the reason and Retry on its card).
    if (r.spine?.status === "written") o.readModel?.patch({ kind: "answered", id: r.itemId });
    // his yes on an improvement request hands it to the builder's desk (one note, never twice); the asker's wake
    // waits for it, so the persona reads where it went.
    if (o.improvement && r.spine?.status === "written" && r.kind === "approve" && r.item.improvement && !r.item.improvementHanded) {
      const h = await o.improvement(r).catch((e: Error) => ({ ok: false as const, retry: true, error: e.message }));
      if (h.ok) {
        setItem(id, { ...r.item, improvementHanded: h.note });
        r = getResponse(id)!;
      } else if (h.retry && !last) return { state: "retry", error: `improvement request hand-off: ${h.error}` };
      else {
        setItem(id, { ...r.item, improvementError: h.error });
        r = getResponse(id)!;
      }
    }
    // his Yes on a priority ask puts the objective first (one commit in the objectives file, never twice);
    // the asker's wake waits for it, so the persona reads the new order.
    if (o.priority && r.spine?.status === "written" && r.item.putFirst && !r.item.priorityMoved && saysYes(r.kind, r.text)) {
      const h = await o.priority(r).catch((e: Error) => ({ ok: false as const, retry: true, error: e.message }));
      if (h.ok) {
        setItem(id, { ...r.item, priorityMoved: h.note, priorityError: undefined });
        r = getResponse(id)!;
      } else if (h.retry && !last) return { state: "retry", error: `priority ask: ${h.error}` };
      else {
        setItem(id, { ...r.item, priorityError: h.error });
        r = getResponse(id)!;
      }
    }
    // one answer closes many, once per answer, after his answer is in the spine (never blocks the wake).
    const settled = await settleOthers(r).catch((e) => (console.warn(`answer ${r!.id}: one answer closes many: ${(e as Error).message}`), undefined));
    if (settled) r = getResponse(id)!;
    r = await notifyAsker(r, { wake, ...(r.replacedAnswer ? { oldAnswer: r.replacedAnswer } : {}), ...(settled ? { settled } : {}) });
    // the console's own checkout left dirty by a write a restart cut off is no refusal of his answer: the next try
    // finds it cleaned (writeClone), so it is tried again, never failed for good (28 Nov 10:44-10:57Z: six of his answers
    // failed on "the checkout has uncommitted changes" and their cards came back into his inbox).
    if (!last && r.spine && r.spine.status !== "written" && r.delivery !== "delivered" && DIRTY_CHECKOUT.test(r.spine.reason ?? ""))
      return { state: "retry", error: r.spine.reason ?? "the checkout has uncommitted changes" };
    if (r.delivery === "failed" || (r.spine && r.spine.status !== "written" && r.delivery !== "delivered"))
      return { state: "failed", error: r.spine?.reason ?? r.deliveryError ?? r.delivery };
    return { state: "done" };
  };
  const ack = o.answerAck ?? "done";
  const jobs = createAnswerJobs({ db, step: answerStep, ...(o.answerRetryMs ? { retryMs: o.answerRetryMs } : {}), ...(o.onAnswerJob ? { onState: o.onAnswerJob } : {}) });
  // answers a restart interrupted (or that wait for a retry) carry on now (never on a passive console: not its jobs).
  if (o.resumeJobs !== false) jobs.resume();

  /** his words with the links of the files he sent along; an error message when a file is refused. */
  const withFiles = (b: { text: string; attachments?: string[] }): string | { status: 400 | 404 | 413 | 415; code: string; message: string } => {
    if (!b.attachments?.length) return b.text;
    if (!o.attachments) return { status: 400, code: "no_attachments", message: "this console takes no attachments" };
    try {
      return o.attachments.cardText(b.text, b.attachments);
    } catch (e) {
      if (e instanceof AttachError) return { status: e.status, code: e.code, message: e.message };
      throw e;
    }
  };

  api.post("/waiting-on-owner/:id/respond", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "invalid_json", "request body must be valid JSON");
    }
    const p = respondIn.safeParse(raw);
    if (!p.success) return c.json({ error: { code: "validation_error", message: "invalid request body", details: p.error.issues } }, 400);
    const filed = withFiles(p.data);
    if (typeof filed !== "string") return err(c, filed.status, filed.code, filed.message);
    p.data.text = filed;
    // the Team desk (header X-Console-Run: team-desk) registers only what the owner said in the chat: via + his words, which
    // must be in his messages to the desk thread; never an answer the desk wrote itself. Any other caller sends no via.
    // a world's own desk (X-Console-Run world-desk:<w>, or team-desk with its world's token) is a Team desk too:
    // its owner's words are checked against ITS thread, typed or a voice-note transcript alike.
    const desker = deskCaller(c.req.header("x-console-run"), credentialWorld(), DEFAULT_TENANT);
    if (typeof desker === "string") return err(c, 403, "desk_only", desker);
    const fromDesk = !!desker;
    const deskWorld = desker?.world;
    // a milestone chat (header X-Console-Run: milestone-chat:<id>) does the same with via milestone-chat, inside its subtree.
    const fromChat = o.milestoneChat?.caller(c.req.header("x-console-run"));
    const via = p.data.via;
    const chat = p.data.chat?.trim();
    if (fromDesk && via !== "team-desk") return err(c, 400, "validation_error", `the Team desk registers an answer ${ownerName()} gave in the chat: send "via":"team-desk" and "chat" (his words, verbatim)`);
    if (fromChat && via !== "milestone-chat") return err(c, 400, "validation_error", `a milestone chat registers an answer ${ownerName()} gave in it: send "via":"milestone-chat" and "chat" (his words, verbatim)`);
    if (via === "team-desk" && !fromDesk) return err(c, 403, "desk_only", "via team-desk is only for a Team desk's own calls (header X-Console-Run: team-desk, or world-desk:<world> for a world's own desk)");
    if (via === "milestone-chat" && !fromChat) return err(c, 403, "desk_only", "via milestone-chat is only for a milestone chat's own calls (header X-Console-Run: milestone-chat:<id>)");
    if (via && !chat) return err(c, 400, "validation_error", `chat (${ownerName()}'s words from the chat, verbatim) is required with via`);
    if (via === "team-desk" && !o.deskChat) return err(c, 503, "desk_unavailable", "the Team desk chat is not available to check the answer against");
    // a retried click (same key) gets the answer already stored, whatever happened to the first request.
    const clientKey = p.data.clientKey ?? (c.req.header("idempotency-key")?.trim() || undefined);
    const byKey = () => (clientKey ? (db.prepare("SELECT id FROM jordi_responses WHERE client_key = ?").get(clientKey) as Row | undefined) : undefined);
    const again = byKey();
    if (again) return c.json(getResponse(again.id), 200);
    const id = c.req.param("id");
    const saved = ack === "saved" && !!o.readModel;
    // on the click the item comes from the stored views (ms); the live read (spines.py, 10-40 s under load) only
    // for callers that wait for the outcome, a chat registering an answer (it checks the subtree) or a grant.
    const stored = saved ? findStored(id, p.data.milestoneId) : undefined;
    let item = stored?.item;
    let unresolved = false;
    if (!item) {
      // Idempotent: the same answer posted again after the line flipped (its id changed) returns what was recorded.
      const prior = listResponses({ itemId: id }).find((r) => r.spine?.status === "written");
      if (prior) return c.json({ ...prior, alreadyAnswered: true }, 200);
      const m = p.data.milestoneId ? store.getMilestone(p.data.milestoneId) : undefined;
      if (saved && m && !via && !p.data.grantWrite) {
        // Not in any stored view yet (an ask newer than the views): stored against its id now, resolved by the job.
        unresolved = true;
        item = { id, milestoneId: m.id, milestoneTitle: m.title } as WaitingItem;
      } else item = await findItem(id, { milestoneId: p.data.milestoneId, includeSuperseded: true });
      if (!item) return err(c, 404, "not_found", `waiting item ${id} not found (answered already, or the spine changed)`);
    }
    // a world's token or login answers only its own world's asks (the item id is not a path id rule 3 can judge).
    const own = credentialWorld();
    if (own && milestoneWorld(db, item.milestoneId) !== own) return err(c, 404, "not_found", `waiting item ${id} not found in this world`);
    // a card still showing an ask he already answered (a reworded line or an older view has another id)
    // gets that stored answer back, marked, and nothing is written twice; the card says when he answered it.
    if (!unresolved && item.state === "open" && !p.data.grantWrite) {
      const done = answeredByCode(writtenByCode(), item, uniqueCodes(storedItems(p.data.milestoneId) ?? [item]));
      if (done) return c.json({ ...done, alreadyAnswered: true }, 200);
    }
    const kind = outcomeKind(item, p.data.kind, p.data.text);
    // E948-S139: a Duplicate or already answered tap names the earlier card it repeats (the ask gate's repeat memory and
    // the open inbox, by its words), so the asker is told which one and the next card like it is held.
    if (kind === "answer" && isDuplicate(p.data.text) && !unresolved) p.data.text = withTrace(p.data.text, traceDuplicate({ question: item.question || item.title || "", ref: item.code, repo: item.repo, row: item.row }, dupCandidates(item, p.data.milestoneId)));
    if (!unresolved) {
      const bad = answerRefusal(item, kind, p.data.text);
      if (bad) return err(c, bad.status, bad.code, bad.message);
    } else if ((kind === "answer" || kind === "feedback") && !p.data.text.trim()) return err(c, 400, "validation_error", kind === "feedback" ? "feedback needs your words: say what should change" : "an answer needs text");
    if (fromChat) {
      const why = await o.milestoneChat!.refusal(fromChat, item);
      if (why) return c.json({ error: { code: "out_of_scope", message: why } }, 403);
    }
    // the grant goes to the assignment of the run that asked (write is per milestone × persona).
    const grant = p.data.grantWrite;
    let grantAssignmentId: string | undefined;
    if (grant) {
      // the grant goes with approving a spine ask (Needs the owner rows are spine asks now): to the persona that asked.
      if (kind !== "approve" || item.source !== "ask" || item.state !== "open")
        return err(c, 400, "validation_error", "grantWrite is only for approving an open ask");
      const asker = stored?.asker ?? (await askerFor(o.deps, item));
      grantAssignmentId = asker && asker.via !== "owner" && store.getAssignment(asker.assignmentId) ? asker.assignmentId : undefined;
      if (!grantAssignmentId) return err(c, 400, "unknown_reference", "the run that asked has no attached assignment to grant write to");
    }
    // Checked before anything changes: words the chat cannot show as the owner's register nothing.
    // a refused answer leaves one log line (item, desk, words length; never the words), so a day's refusals can be counted.
    const refusedLog = (desk: string) => console.warn(`answer refused not_in_chat: item ${id} desk ${desk} chat ${chat!.length} chars`);
    if (via === "team-desk" && !(await o.deskChat!.jordiSaid(chat!, deskWorld === DEFAULT_TENANT ? undefined : deskWorld)) && (refusedLog(`team-desk:${deskWorld ?? DEFAULT_TENANT}`), true))
      return err(c, 409, "not_in_chat", `those words are not in ${ownerName()}'s messages to ${deskWorld && deskWorld !== DEFAULT_TENANT ? `world ${deskWorld}'s desk` : "the Team desk"} (typed or voice note): only an answer he gave in the chat is registered`);
    if (via === "milestone-chat" && !(await o.milestoneChat!.jordiSaid(fromChat!, chat!)) && (refusedLog(`milestone-chat:${fromChat}`), true))
      return err(c, 409, "not_in_chat", `those words are not in ${ownerName()}'s messages to this milestone chat: only an answer he gave in the chat is registered`);
    if (grant) {
      // the grant is a `## Standing approvals` line in the asker's spine first, then the assignment's
      // write grant in the team repo; a write that does not land grants nothing (and the ask stays open).
      const a = store.getAssignment(grantAssignmentId!)!;
      const m = store.getMilestone(a.milestoneId);
      const dir = m ? resolveRepo(o.deps.reposRoot, m.repo)?.path : undefined;
      const rel = item.path || m?.path;
      if (!dir || !rel) return err(c, 409, "repo_write_refused", "the grant has no spine to go in (no checkout or spine for the milestone); nothing granted");
      const who = store.getPersona(a.personaId)?.name ?? a.personaId;
      let code = "";
      const gw = await spineWriter.edit({
        repoDir: dir,
        path: rel,
        label: "grant",
        edit: (text, date) => {
          const g = addGrant(text, { prefix: grantPrefix(text), date, grant: { scope: `${who} may write: ${grant.scope}`, context: `${ownerName()} approved ${item.code ?? "an ask"} with a write grant on the console` } });
          if ("skip" in g) return g;
          code = g.code;
          return { text: g.text, msg: `Grant ${g.code}: ${who} may write (${ownerName()}, via console)`, body: `${ownerName()} approved ${item.code ?? "an ask"} with a write grant: ${grant.scope}.` };
        },
      });
      if (gw.status !== "written") return err(c, gw.status === "failed" ? 502 : 409, gw.status === "failed" ? "repo_write_failed" : "repo_write_refused", `the grant line was not written (${gw.reason ?? gw.status}); nothing granted`);
      o.invalidate?.(dir);
      try {
        await (o.recordAssignments ?? plainAssignments)(store).updateAssignment(grantAssignmentId!, { writeEnabled: true, writeScope: grant.scope });
      } catch (e) {
        if (e instanceof RecordError) return err(c, e.status === "failed" ? 502 : 409, e.status === "failed" ? "repo_write_failed" : "repo_write_refused", `grant ${code} is in the spine, but ${e.message}`);
        throw e;
      }
    // The awaits above may have let the same key in from a retry: check once more, in the same tick as the insert.
    const raced = byKey();
    if (raced) return c.json(getResponse(raced.id), 200);
    }
    const rid = `jr_${randomUUID()}`;
    // who asked is resolved before the answer rewrites the ask line (its blame is the asker's commit): the asker
    // the read model stored with the view, else the job works it out before it writes.
    const keep = { ...item, ...(stored?.asker ? { asker: stored.asker } : {}), ...(unresolved ? { unresolved: true } : {}), ...(grant ? { grantedScope: grant.scope, grantNote: p.data.text } : {}), ...(p.data.asRow && kind === "approve" ? { asReadyRow: true } : {}) };
    // Activity shows the text: a grant says what was granted, then the owner's note.
    const text = grant ? `Granted write, scope: ${grant.scope}${p.data.text.trim() ? `\n${p.data.text.trim()}` : ""}` : p.data.text;
    db.prepare(
      `INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, assignment_id, delivery, created_at, via, chat_text, client_key, job_state, job_attempts, job_wake) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 'pending', 0, ?)`,
    ).run(rid, item.id, item.milestoneId, JSON.stringify(keep), kind, text, grantAssignmentId ?? item.owner?.assignmentId ?? null, iso(), via ?? null, via ? chat! : null, clientKey ?? null, p.data.wake ? 1 : 0);
    // The card (and every count) changes when the job has written the answer into the spine, so the card stays up, with
    // its progress, until then (nothing is closed in console.db first).
    // Saved: the job starts after this reply is on its way (none of its work, not even its first sync step, is on the click).
    // a card's answer waits out its Bring it back window (x-undo-ms) before its job writes anything
    const hold = undoHoldMs(c.req.header("x-undo-ms"));
    if (saved) jobs.schedule(rid, hold);
    else await jobs.start(rid);
    return c.json({ ...getResponse(rid)!, ...(saved && hold ? { undoMs: hold } : {}) }, 201);
  });

  /**
   * Bring it back on an answer still in its undo window: the stored answer is dropped before its job ran, so
   * nothing was written to the spine and nobody was woken; the ask is open again. 409 `landed` once the job has started
   * (the card then says so and offers Add comment, which reaches the owner like a new round).
   */
  api.post("/owner-responses/:id/undo", (c) => {
    const id = c.req.param("id");
    const r = getResponse(id);
    if (!r) return err(c, 404, "not_found", `response ${id} not found (brought back already?)`);
    const own = credentialWorld(); // as for /respond
    if (own && (!r.milestoneId || milestoneWorld(db, r.milestoneId) !== own)) return err(c, 404, "not_found", `response ${id} not found in this world`);
    if (!jobs.cancel(id)) return err(c, 409, "landed", "it is being written or is in the project already");
    o.onAnswerUndone?.(id);
    return c.json({ undone: true, itemId: r.itemId });
  });

  /**
   * the owner snoozes an open ask for 3 days / 1 week / 1 month (`days`, or an explicit `until` date; 3 hours), or unsnoozes it
   * (`until: null`). The date is written on the ask line in its spine (` — snoozed until: <date>`), committed and pushed
   * like an answer; the ask stays open and the inbox hides it (and leaves it out of every count) until that day.
   */
  api.post("/waiting-on-owner/:id/snooze", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "invalid_json", "request body must be valid JSON");
    }
    const p = snoozeIn.safeParse(raw);
    if (!p.success) return c.json({ error: { code: "validation_error", message: "send hours (3), days (3, 7 or 30), until (YYYY-MM-DD or YYYY-MM-DDTHH:MMZ) or until: null to unsnooze", details: p.error.issues } }, 400);
    const until = p.data.until === null ? undefined : (p.data.until ?? (p.data.hours ? snoozeMinute(p.data.hours) : snoozeDate(p.data.days!)));
    if (until && !snoozedNow(until)) return err(c, 400, "validation_error", "until must be later than now (a day after today, or a minute ahead)");
    const id = c.req.param("id");
    const item = await findItem(id, { milestoneId: p.data.milestoneId });
    if (!item) return err(c, 404, "not_found", `waiting item ${id} not found (answered already, or the spine changed)`);
    const own = credentialWorld(); // as for /respond
    if (own && milestoneWorld(db, item.milestoneId) !== own) return err(c, 404, "not_found", `waiting item ${id} not found in this world`);
    if (item.state !== "open") return err(c, 409, "conflict", "this ask is not open any more");
    if (item.source !== "ask" || !item.path) {
      // a card with no ask line (a red node, a free-text Waiting on): the console keeps the date and the inbox
      // hides the card until then (inbox/consoleSnooze.ts); before, the press failed (3 of his on 18 Nov 20:34Z)
      const by = ownerOf(o.db, item.milestoneId).handle;
      o.deps.store.setConsoleSnooze(item.id, until, by);
      const { snoozedUntil: _s, ...awake } = item;
      const back = until ? undefined : pendingItems([awake as WaitingItem])[0];
      o.readModel?.patch({ kind: "snoozed", id: item.id, until: until ?? null, ...(back ? { item: back } : {}) });
      return c.json({ id: item.id, snoozedUntil: until ?? null, kept: "console" }, 200);
    }
    const repo = (item.repo ? resolveRepo(o.deps.reposRoot, item.repo) : undefined) ?? repoDirOf(item.milestoneId).repo;
    if (!repo) return err(c, 409, "conflict", `no checkout of “${item.repo ?? "?"}” under the console's repos root: nothing written`);
    const target = { id: item.id, source: "ask" as const, question: item.question, path: item.path, ...(item.code ? { code: item.code } : {}), ...(item.row ? { row: item.row } : {}), ...(item.line !== undefined ? { line: item.line } : {}) };
    const label = item.code ?? item.id;
    const who = ownerOf(o.db, item.milestoneId).handle;
    let line: number | undefined;
    const w = await spineWriter.edit({
      repoDir: repo.path,
      path: item.path,
      label,
      // a snooze is one field the console computes and checks (applySnooze): no pre-commit hook, and no second
      // fetch when this checkout synced in the last 30 s (Decisions row in). Main, clean, policy, push stay.
      verify: false,
      fetchFreshMs: 30_000,
      group: true, // shares a commit and push with presses landing close together
      edit: (text) => {
        const e = applySnooze(text, target, until);
        if (e.how === "missing") return { skip: "the ask line is not in the spine any more" };
        if (e.how === "not_open") return { skip: "the ask is answered in the spine already" };
        line = e.line;
        if (e.how === "same") return { skip: until ? `already snoozed until ${until}` : "not snoozed" };
        return until
          ? p.data.park
            ? { text: e.text, msg: `Park ${label} until ${until} (${who}, via console)`, body: `${stripQ(item.question)}\n\n${who} parked this ask with the card's Park button: nothing was decided, it stays open and leaves the inbox until ${until}, then comes back by itself (Bring it back from Snoozed in the inbox). The agent-team console added \`— snoozed until: ${until}\` to its line in ${item.path}.` }
            : { text: e.text, msg: `Snooze ${label} until ${until} (${who}, via console)`, body: `${stripQ(item.question)}\n\n${who} snoozed this ask on the console: it stays open; the inbox hides it until ${until}. The agent-team console added \`— snoozed until: ${until}\` to its line in ${item.path}.` }
          : { text: e.text, msg: `Unsnooze ${label} (${who}, via console)`, body: `${stripQ(item.question)}\n\n${who} unsnoozed this ask on the console: it is back in the inbox. The agent-team console took the snoozed-until field off its line in ${item.path}.` };
      },
    });
    if (w.status === "written") o.invalidate?.(repo.path);
    // out of the counts at once; an unsnooze puts it back in them at once (the item as the status lists it)
    if (w.status === "written") {
      const { snoozedUntil: _s, ...awake } = item;
      const back = until ? undefined : pendingItems([awake as WaitingItem])[0];
      o.readModel?.patch({ kind: "snoozed", id: item.id, until: until ?? null, ...(back ? { item: back } : {}) });
    }
    const same = w.status === "skipped" && /^(already snoozed|not snoozed)/.test(w.reason ?? "");
    const { ms, ...spine } = w;
    if (ms) c.header("Server-Timing", Object.entries(ms).map(([k, v]) => `${k};dur=${v}`).join(", ")); // where the wait goes
    if (w.status !== "written" && !same) return err(c, w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict", `nothing changed: ${w.reason ?? "the spine line could not be written"}`);
    return c.json({ id: item.id, snoozedUntil: until ?? null, spine: { ...spine, ...(line !== undefined ? { line } : {}) } }, 200);
  });

  /**
   * the owner pastes a key into the card of an open `provide` ask carrying `secret: <app> <NAME>`. Order:
   * 1. the `[answered <CODE> … @the owner] … — answer: key provided in the console …` line is written and pushed (so the infra repo
   * `secret`'s money-class check sees an answered ask); 2. `secret put <app> <NAME> --stdin --the app platform --approved <CODE>`
   * with SECRET_DOCS_DIR = the spine's folder, the value on stdin only; 3. on failure the ask line is put back (open) and
   * the tool's stderr is shown; on success the owning assignment is woken when switched on. The value is never stored,
   * logged or returned: the response row carries only the fixed answer text.
   */
  api.post("/waiting-on-owner/:id/secret", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "invalid_json", "request body must be valid JSON");
    }
    const p = secretIn(raw);
    if (typeof p === "string") return err(c, 400, "validation_error", p);
    const id = c.req.param("id");
    const item = await findItem(id, { milestoneId: p.milestoneId });
    if (!item) return err(c, 404, "not_found", `waiting item ${id} not found (answered already, or the spine changed)`);
    const own = credentialWorld(); // as for /respond
    if (own && milestoneWorld(db, item.milestoneId) !== own) return err(c, 404, "not_found", `waiting item ${id} not found in this world`);
    const r = await storeKey(item, p.value, p.wake);
    // E996-S29: asks that name the same key (`secret: <app> <NAME>`) are one card and one box: the save answers them all.
    if (r.ok) {
      const twins = sameKeyTwins((await itemsIn({})).items, item).filter((i) => !own || milestoneWorld(db, i.milestoneId) === own);
      const also: { code?: string; ok: boolean; reason?: string }[] = [];
      for (const t of twins) {
        const tr = await storeKey(t, p.value, p.wake);
        also.push({ ...(t.code ? { code: t.code } : {}), ok: tr.ok, ...(tr.ok ? {} : { reason: tr.message }) });
      }
      if (also.length) return c.json({ ...(r.body as object), also }, 201);
    }
    return r.ok ? c.json(r.body, 201) : r.status === 502 && r.body ? c.json(r.body, 502) : err(c, r.status, r.code, r.message);
  });

  /**
   * the key path, shared by the ask card (above) and's private box on a steps page (`pasteKey`): the same
   * checks, the same answered line and approval mirror, the same `secret put`. The value is never returned.
   */
  type KeyResult =
    | { ok: true; body: unknown; stored: { app: string; name: string; deployed: boolean; vault?: string; where?: string; open?: string; at?: string } }
    | { ok: false; status: 400 | 403 | 404 | 409 | 502; code: string; message: string; body?: unknown };
  async function storeKey(item: WaitingItem, value: string, wake: boolean, file = false): Promise<KeyResult> {
    const no = (status: 400 | 403 | 404 | 409 | 502, code: string, message: string): KeyResult => ({ ok: false, status, code, message });
    const p = { value, wake };
    if (item.source !== "ask" || !item.secret) return no(400, "validation_error", "this ask does not name where a key goes (`secret: <app> <NAME>`): answer it in words");
    if (item.state !== "open") return no(409, "conflict", "this ask is not open any more");
    if (!item.code) return no(400, "validation_error", "a key ask needs a code (`[ask <CODE>: provide …]`): `secret put --approved` cites it");
    const { m, repo } = repoDirOf(item.milestoneId);
    if (!repo || !item.path) return no(409, "conflict", `no checkout of “${m?.repo ?? "?"}” under the console's repos root: nothing stored`);
    // the key goes to the ask's world's backend; a world never writes another world's (or the home world's) app.
    const world = milestoneWorld(db, item.milestoneId);
    const refused = o.keys?.refuse(world, item.secret.app);
    if (refused) return no(403, "world_scope", `nothing stored: ${refused}`);
    const inWorldStore = o.keys?.backend(world) === hooks.keys.worldBackend;

    const target = {
      id: item.id,
      source: "ask" as const,
      question: item.question,
      code: item.code,
      path: item.path,
      ...(item.row ? { row: item.row } : {}),
      ...(item.line !== undefined ? { line: item.line } : {}),
    };

    // 0. ("it was supposed to make it into the vault, it didn't. But the card closed"): where the
    // world keeps a vault, the key is saved there and read back by name before anything closes the card; a vault that
    // refuses leaves the card open, nothing written, with why.
    const first = o.keys?.saveFirst ? await o.keys.saveFirst(world, { app: item.secret.app, name: item.secret.name, value: p.value, source: `a paste on the console (ask ${item.code})` }) : undefined;
    if (first && !first.ok) return no(502, "secret_put_failed", `not saved: ${scrub(first.err, p.value)}. The card stays open: paste the key once more`);
    const keyAnswer = inWorldStore ? KEY_PROVIDED_WORLD_ANSWER : first?.ok ? keyVaultAnswer(first.vault, first.where) : KEY_PROVIDED_ANSWER;

    // 1. The answered line (secret's approval check reads it).
    const w = await spineWriter.answer({ repoDir: repo.path, target, answer: keyAnswer, label: item.id, ...signedBy(item.milestoneId) });
    if (w.status !== "written" || !w.before || !w.after)
      return no(w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict",
        `nothing stored: ${w.status === "written" ? "the ask is answered in the spine already" : (w.reason ?? "the spine line could not be written")}`);

    // the root half of `secret put --the app platform` reads approvals only from the infra repo's docs: mirror the
    // answered line there first (the home world's store only; a world's own store has no such check).
    const mirror: Mirror = inWorldStore
      ? { ok: true }
      : await mirrorApproval({ spine: spineWriter, reposRoot: o.deps.reposRoot, askRepoDir: repo.path, ask: { code: item.code, question: item.question, app: item.secret.app, name: item.secret.name, repo: m?.repo ?? repo.name, path: item.path } });

    // 2. Store it.
    const docsDir = path.dirname(path.join(repo.path, item.path));
    // an app with no the app platform app gets the key in the store only (put again without --the app platform).
    // a key file (several lines) is stored only, `--multiline`: the app platform env holds one line per name.
    const putIn = { app: item.secret.app, name: item.secret.name, approved: item.code, docsDir, value: p.value, ...(file ? { deployed: false, multiline: true } : {}), ...(first?.ok ? { vaultSaved: first.vault } : {}) };
    const put = o.keys ? await o.keys.store(world, putIn) : await hooks.keys.putWithFallback(secretPut, putIn);
    const asker = put.ok ? await askerFor(o.deps, item) : undefined;
    const rid = `jr_${randomUUID()}`;
    const insert = (delivery: Delivery, error: string | null, spine: SpineWrite) =>
      db.prepare(
        `INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, assignment_id, delivery, delivery_error, created_at, delivered_at, spine_status, spine_reason, spine_sha, spine_path, spine_at) VALUES (?, ?, ?, ?, 'answer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(rid, item.id, item.milestoneId, JSON.stringify(asker ? { ...item, asker } : item), keyAnswer, item.owner.assignmentId ?? null, delivery, error,
        iso(), delivery === "sent" ? iso() : null, spine.status, spine.reason ?? null, spine.sha ?? null, spine.path ?? null, iso());

    if (!put.ok) {
      // 3a. Take the answer back: the ask stays open.
      const back = await spineWriter.revert({ repoDir: repo.path, target, answer: keyAnswer, label: item.id, ...signedBy(item.milestoneId), from: w.after, to: w.before, why: "key not stored", detail: scrub(put.err, p.value) });
      // the mirrored approval goes too, so it never approves a later write nobody pasted.
      const unmirror = mirror.ok && mirror.line && mirror.repoDir
        ? await dropMirror({ spine: spineWriter, repoDir: mirror.repoDir, line: mirror.line, code: item.code, why: scrub(put.err, p.value) })
        : undefined;
      const reason = `key not stored: ${scrub(put.err, p.value)}${mirror.ok ? "" : ` (the approval could not be copied where the secret store reads it: ${mirror.reason})`}${back.status === "written" ? "; the ask is open again" : `; the answered line could not be taken back (${back.reason ?? back.status})`}${unmirror && unmirror.status !== "written" ? `; the ${opsRepo()} approval line could not be taken back (${unmirror.reason ?? unmirror.status})` : ""}. Nothing was saved: paste the key once more`;
      insert("failed", reason, { status: "failed", reason, ...(w.path ? { path: w.path } : {}) });
      return { ok: false, status: 502, code: "secret_put_failed", message: reason, body: { error: { code: "secret_put_failed", message: reason, response: getResponse(rid) } } };
    }

    // 3b. Stored: record the (value-free) answer and wake (or steer) the persona who asked.
    insert("sent", null, w);
    o.readModel?.patch({ kind: "answered", id: item.id }); // the card and every count change at once
    const answered = await notifyAsker(getResponse(rid)!, {
      wake: p.wake,
      answer: put.vault
        ? `key ${item.secret.app} ${item.secret.name} saved in ${put.vault} (${put.noCopy ? "kept only there" : put.mirrorErr ? `not set in ${deployerName()}: ${put.mirrorErr}` : put.deployed ? `also set in ${deployerName()}` : "kept only there"})`
        : `key ${item.secret.app} ${item.secret.name} saved in the console (${inWorldStore ? hooks.keys.worldStoredMessage(world) : put.deployed ? `stored with secret put, set in ${deployerName()}` : hooks.keys.storedNoDeploy(item.secret.app)})`,
    });
    const stored = { app: item.secret.app, name: item.secret.name, deployed: put.deployed, ...(put.vault ? { vault: put.vault } : {}), ...(first?.ok && first.where ? { where: first.where } : {}), ...(first?.ok && first.open ? { open: first.open } : {}), ...(first?.ok ? { at: first.at || new Date().toISOString() } : {}) };
    return { ok: true, body: { ...answered, stored }, stored };
  }

  api.get("/owner-responses", async (c) => {
    settlePending();
    const milestoneId = c.req.query("milestoneId") || undefined;
    const itemId = c.req.query("itemId") || undefined;
    const direct = listResponses({ milestoneId, itemId });
    if (direct.length || !itemId) return c.json(direct);
    // asked by an id the ask has now (its answered line, a reworded line): the answers to the same file and code.
    // the stored view first (ms); with none, one live read (this lookup used to answer empty here)
    const all = storedItems(milestoneId) ?? (await waitingOnJordi(o.deps, { ...(milestoneId ? { milestoneId } : {}), includeSuperseded: true }));
    const item = all.find((i) => i.id === itemId);
    if (!item || item.source !== "ask" || !item.code || !item.path || !uniqueCodes(all)(item.repo ?? "", item.code)) return c.json(direct);
    return c.json(listResponses({ milestoneId }).filter((r) => r.item.code?.toUpperCase() === item.code!.toUpperCase() && (r.item.repo ?? "") === (item.repo ?? "")));
  });
  api.post("/owner-responses/:id/deliver", async (c) => {
    settlePending(true); // an answer the asker's PR has put in the spine since is settled first
    const r = getResponse(c.req.param("id"));
    if (!r) return err(c, 404, "not_found", `response ${c.req.param("id")} not found`);
    // an answer already written whose wake was skipped or failed: re-run only the wake (no second write or message).
    const wakeOnly = r.delivery === "sent" && !!r.wake && ["skipped", "failed"].includes(r.wake.notified);
    // an approved improvement request whose hand-off did not go through: Retry runs the job again for it.
    const handOnly = r.delivery === "sent" && r.kind === "approve" && !!r.item.improvement && !r.item.improvementHanded;
    if (r.delivery === "sent" && !wakeOnly && !handOnly) return err(c, 409, "already_delivered", "this response was delivered already");
    if (handOnly) setItem(r.id, { ...r.item, improvementError: undefined });
    // a key answer is only written together with the key (Save key), never re-delivered alone.
    if (!wakeOnly && isKeyProvidedAnswer(r.text) && r.item.secret) return err(c, 409, "conflict", "a key ask is answered by pasting the key again (Save key)");
    // Retry / Wake now runs the answer's job again from its first try (production: in the background, the card shows it).
    if (wakeOnly) db.prepare("UPDATE jordi_responses SET job_wake = 1 WHERE id = ?").run(r.id);
    const job = jobs.start(r.id, { reset: true });
    if (!(ack === "saved" && o.readModel)) await job;
    return c.json(getResponse(r.id)!);
  });

  /**
   * the owner changes an answer before the owner acts on it. Spine items: the `[answered …]` line is rewritten in
   * place (spineWrite `change`: same guards, commit + push); refused with a plain reason (409) when the owner already
   * acted (line gone or marked done). Thread-delivered items (persona requests, reversals): a correction message to the
   * thread the first answer went to. The new response points at the old one (kept for history).
   */
  api.post("/owner-responses/:id/change", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "invalid_json", "request body must be valid JSON");
    }
    const p = changeIn.safeParse(raw);
    if (!p.success) return c.json({ error: { code: "validation_error", message: "invalid request body", details: p.error.issues } }, 400);
    const filed = withFiles(p.data);
    if (typeof filed !== "string") return err(c, filed.status, filed.code, filed.message);
    p.data.text = filed;
    const prior = getResponse(c.req.param("id"));
    if (!prior) return err(c, 404, "not_found", `response ${c.req.param("id")} not found`);
    const newer = db.prepare("SELECT id FROM jordi_responses WHERE replaces_id = ?").get(prior.id) as Row | undefined;
    if (newer) return err(c, 409, "conflict", `this answer was changed already (response ${newer.id}): change the latest one`);
    const item = prior.item;
    if (changeBlocked(prior)) return err(c, 400, "validation_error", "this answer granted write: change the grant on the assignment, not the answer");
    if (item.decidedBy && p.data.kind !== "answer") return err(c, 400, "validation_error", "a reversal is changed with an answer, not approve / deny");
    if (p.data.kind === "answer" && !p.data.text.trim()) return err(c, 400, "validation_error", "an answer needs text");
    // feedback reopened the work: it is answered by the next round, never changed in place.
    if (prior.kind === "feedback")
      return err(c, 409, "conflict", "feedback reopens the work and comes back as a new round: give your next feedback on that round, nothing changed");
    // his words on an approve ask are
    // feedback, so the change goes through as feedback. The answered line becomes his `[feedback …]` line and the row it
    // names reopens for a new round, written by the answer job like a feedback press (the click answers at once, L-1).
    if (outcomeKind(item, p.data.kind, p.data.text) === "feedback") {
      if (item.source !== "ask" || item.decidedBy) return err(c, 400, "validation_error", "changes wanted is only for an approve ask; send an answer instead");
      if (!p.data.text.trim()) return err(c, 400, "validation_error", "feedback needs your words: say what should change");
      const rid = `jr_${randomUUID()}`;
      db.prepare(
        `INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, assignment_id, thread_id, delivery, created_at, replaces_id, job_state, job_attempts, job_wake) VALUES (?, ?, ?, ?, 'feedback', ?, ?, ?, 'queued', ?, ?, 'pending', 0, ?)`,
      ).run(rid, prior.itemId, prior.milestoneId ?? null, JSON.stringify(item), p.data.text, prior.assignmentId ?? null, prior.threadId ?? null, iso(), prior.id, p.data.wake ? 1 : 0);
      if (ack === "saved" && o.readModel) jobs.schedule(rid);
      else await jobs.start(rid);
      return c.json(getResponse(rid)!, 201);
    }
    if (p.data.kind === "approve" && !(item.decidable || item.ask === "approve"))
      return err(c, 400, "validation_error", `approve is only for Needs ${ownerName()} items and approve asks; send an answer instead`);
    const oldAnswer = answerWord(prior.kind, prior.text);
    const newAnswer = answerWord(p.data.kind, p.data.text);
    if (oldAnswer === newAnswer) return err(c, 400, "validation_error", "that is the answer already given");
    const insert = () => {
      const rid = `jr_${randomUUID()}`;
      db.prepare(
        `INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, assignment_id, thread_id, delivery, created_at, replaces_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(rid, prior.itemId, prior.milestoneId ?? null, JSON.stringify(item), p.data.kind, p.data.text, prior.assignmentId ?? null, prior.threadId ?? null, iso(), prior.id);
      return getResponse(rid)!;
    };

    if (item.source !== "needs_jordi" && !item.decidedBy) {
      // The old answer never reached the spine (a guard refused it): the new one is written as a first answer.
      if (prior.spine?.status !== "written") return c.json(await notifyAsker(await writeToSpine(insert()), { wake: p.data.wake }), 201);
      const { m, repo } = repoDirOf(prior.milestoneId);
      if (!repo) return err(c, 409, "conflict", `no checkout of “${m?.repo ?? "?"}” under the console's repos root: nothing changed`);
      const res = await spineWriter.change({
        repoDir: repo.path,
        target: {
          id: prior.itemId,
          source: item.source === "ask" ? "ask" : "heuristic",
          question: item.question ?? item.title ?? "",
          ...(item.row ? { row: item.row } : {}),
          ...(item.code ? { code: item.code } : {}),
          ...(item.path ? { path: item.path } : {}),
        },
        answer: newAnswer,
        label: prior.itemId,
        ...signedBy(prior.milestoneId),
      });
      if (res.status === "skipped") return err(c, 409, "conflict", res.reason ?? "the spine line could not be changed");
      if (res.status === "failed") return err(c, 502, "git_failed", res.reason ?? "git failed; nothing changed");
      const r = insert();
      db.prepare(
        `UPDATE jordi_responses SET delivery = 'sent', delivered_at = ?, spine_status = ?, spine_reason = ?, spine_sha = ?, spine_path = ?, spine_at = ? WHERE id = ?`,
      ).run(iso(), res.status, res.reason ?? null, res.sha ?? null, res.path ?? null, iso(), r.id);
      return c.json(await notifyAsker(getResponse(r.id)!, { wake: p.data.wake, oldAnswer }), 201);
    }

    // Thread-delivered (a reversal of a persona's decision, or an answer given before on a Needs the owner row): the
    // correction goes to the first answer's thread.
    const r = insert();
    const text = changedAnswerMessage(item, oldAnswer, newAnswer, cycle.publicUrl);
    const reqId = `console-change-${r.id}`;
    let out: { delivery: Delivery; threadId?: string; error?: string };
    const home = prior.assignmentId ? cycle.getLink(prior.assignmentId)?.threadId : undefined;
    if (prior.assignmentId && (!prior.threadId || home === prior.threadId)) out = await send(prior.assignmentId, text, reqId);
    else if (prior.threadId)
      out = await cycle.deliverToThread(prior.threadId, text, reqId).then(
        (x) => ({ delivery: "sent" as Delivery, threadId: x.threadId }),
        (e) => ({ delivery: "failed" as Delivery, error: e instanceof CycleError ? `${e.code}: ${e.message}` : (e as Error).message }),
      );
    else {
      const owner: Owner | undefined = prior.milestoneId ? ownerFor(store, prior.milestoneId, o.deps.homeThread, item.owner?.assignmentId) : undefined;
      out = await send(owner?.assignmentId, text, reqId, !owner?.assignmentId && item.owner?.kind === "thread" ? item.owner.threadId : undefined);
    }
    db.prepare(`UPDATE jordi_responses SET delivery = ?, delivery_error = ?, thread_id = COALESCE(?, thread_id), delivered_at = ? WHERE id = ?`).run(
      out.delivery,
      out.error ?? null,
      out.threadId ?? null,
      out.delivery === "sent" ? iso() : null,
      r.id,
    );
    const changed = out.delivery === "sent" ? await notifyAsker(getResponse(r.id)!, { wake: p.data.wake, oldAnswer }) : getResponse(r.id)!;
    return c.json(changed, out.delivery === "sent" ? 201 : 502);
  });

  api.get("/messages", (c) => c.json(listMessages(c.req.query("milestoneId") || undefined)));
  api.post("/messages", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "invalid_json", "request body must be valid JSON");
    }
    const p = messageIn.safeParse(raw);
    if (!p.success) return c.json({ error: { code: "validation_error", message: "invalid request body", details: p.error.issues } }, 400);
    const m = store.getMilestone(p.data.milestoneId);
    if (!m) return err(c, 404, "not_found", `milestone ${p.data.milestoneId} not found`);
    const a = store.getAssignment(p.data.assignmentId);
    if (!a || a.milestoneId !== m.id) return err(c, 400, "unknown_reference", `assignment ${p.data.assignmentId} is not attached to this milestone`);
    const item = p.data.refItemId ? (await waitingOnJordi(o.deps, { milestoneId: m.id })).find((i) => i.id === p.data.refItemId) : undefined;
    const id = `msg_${randomUUID()}`;
    const r = await send(a.id, messageText({ milestoneTitle: m.title, milestoneId: m.id, text: p.data.text, item }), `console-msg-${id}`, undefined, `Answer run: ${p.data.text.replace(/\s+/g, " ").trim().slice(0, 120)}`);
    db.prepare(
      `INSERT INTO messages (id, milestone_id, assignment_id, text, ref_item_id, thread_id, delivery, delivery_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, m.id, a.id, p.data.text, p.data.refItemId ?? null, r.threadId ?? null, r.delivery, r.error ?? null, iso());
    const msg = withEnv(toMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row));
    return c.json(msg, r.delivery === "sent" ? 201 : 502);
  });

  /**
   * "Ask owner to write asks" for one spine file: its guessed items (heuristic, not future gates) go to the
   * owner (the persona owning the milestone, else the spine's `Owner:` thread; same path as answers) as a fixed
   * request, logged in Activity as a message of kind ask_for_asks. 201 sent, 502 not delivered (stored either way).
   */
  api.post("/waiting-on-owner/request-asks", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "invalid_json", "request body must be valid JSON");
    }
    const p = requestAsksIn.safeParse(raw);
    if (!p.success) return c.json({ error: { code: "validation_error", message: "invalid request body", details: p.error.issues } }, 400);
    const m = store.getMilestone(p.data.milestoneId);
    if (!m) return err(c, 404, "not_found", `milestone ${p.data.milestoneId} not found`);
    const items = (await waitingOnJordi(o.deps, { milestoneId: m.id })).filter((i) => i.source === "heuristic" && !i.gate && i.spine?.path === p.data.path);
    if (!items.length) return err(c, 404, "not_found", `no guessed items in ${p.data.path} (they may have become asks)`);
    const dm = p.data.to ? store.listAssignments({ milestoneId: m.id }).find((a) => isDm(store.getPersona(a.personaId)?.name)) : undefined;
    const owner = ownerFor(store, m.id, o.deps.homeThread, dm?.id);
    const assignmentId = owner.assignmentId;
    const ownerThread = !assignmentId ? items.find((i) => i.owner.kind === "thread")?.owner.threadId : undefined;
    const id = `msg_${randomUUID()}`;
    const text = askForAsksText({ milestoneTitle: m.title, milestoneId: m.id, path: p.data.path, spineTitle: items[0].spine!.title, items, base: cycle.publicUrl });
    const r = await send(assignmentId, text, `console-asks-${id}`, ownerThread);
    const summary = `Asked the owner to write human asks for ${items[0].spine!.title} (${p.data.path}): ${items.length} guessed item${items.length === 1 ? "" : "s"}`;
    db.prepare(
      `INSERT INTO messages (id, milestone_id, assignment_id, kind, text, thread_id, delivery, delivery_error, created_at) VALUES (?, ?, ?, 'ask_for_asks', ?, ?, ?, ?, ?)`,
    ).run(id, m.id, assignmentId ?? null, summary, r.threadId ?? null, r.delivery, r.error ?? null, iso());
    const msg = withEnv(toMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row));
    return c.json(msg, r.delivery === "sent" ? 201 : 502);
  });

  /** Activity feed: the owner's responses and messages, newest first (UI Activity tab / Team). */
  api.get("/owner-activity", (c) => {
    settlePending();
    const milestoneId = c.req.query("milestoneId") || undefined;
    const personas = new Map(store.listPersonas().map((p) => [p.id, p.name]));
    const personaOf = (assignmentId?: string) => {
      const a = assignmentId ? store.getAssignment(assignmentId) : undefined;
      return a ? personas.get(a.personaId) : undefined;
    };
    const rs = listResponses({ milestoneId }).map((r) => ({
      type: "response" as const,
      id: r.id,
      at: r.createdAt,
      milestoneId: r.milestoneId,
      assignmentId: r.assignmentId,
      personaName: personaOf(r.assignmentId),
      threadId: r.threadId,
      environmentId: r.environmentId,
      kind: r.kind,
      text: r.text,
      itemId: r.itemId,
      ...(r.replacesId ? { replacesId: r.replacesId, replacedAnswer: r.replacedAnswer } : {}),
      itemTitle: `${qualifiedCode(r.item) ? `${qualifiedCode(r.item)} ` : ""}${VERB[r.item.ask ?? "unknown"]}: ${r.item.question ?? r.item.title ?? ""}`,
      delivery: r.delivery,
      deliveryError: r.deliveryError,
      ...(r.spine ? { spine: r.spine } : {}),
    }));
    const ms = listMessages(milestoneId).map((m) => ({
      type: "message" as const,
      id: m.id,
      at: m.createdAt,
      milestoneId: m.milestoneId,
      assignmentId: m.assignmentId,
      personaName: personaOf(m.assignmentId),
      threadId: m.threadId,
      environmentId: m.environmentId,
      messageKind: m.kind,
      text: m.text,
      itemId: m.refItemId,
      delivery: m.delivery,
      deliveryError: m.deliveryError,
    }));
    return c.json([...rs, ...ms].sort((a, b) => b.at.localeCompare(a.at)));
  });
  /**
   * a
   * steps page's private box stores its key through the ask's own key path. The ask is found by its code in the page's
   * repo and spine, and must still be open and name this very `<app> <NAME>`; everything after is `storeKey` as above.
   */
  async function pasteKey(i: { repo: string; spine: string; ask: string; app: string; name: string; value: string; file?: boolean }): Promise<KeyResult> {
    const match = (x: WaitingItem) => x.source === "ask" && x.state === "open" && x.code === i.ask && x.repo === i.repo && x.path === i.spine;
    const item = (await itemsIn({})).items.find(match) ?? (o.readModel ? (await waitingOnJordi(o.deps, {})).find(match) : undefined);
    if (!item) return { ok: false, status: 404, code: "no_ask", message: `nothing stored: ask ${i.ask} is not open in ${i.repo} ${i.spine} (answered already, or the spine changed)` };
    // An open ask that names no key (a `do` ask with several keys, like): the steps page stores it the Secrets page way.
    if (!item.secret) return { ok: false, status: 409, code: "ask_names_no_key", message: `ask ${i.ask} names no key of its own` };
    if (item.secret.app !== i.app || item.secret.name !== i.name)
      return { ok: false, status: 403, code: "not_this_key", message: `nothing stored: ask ${i.ask} names ${item.secret.app} ${item.secret.name} as its key, not ${i.app} ${i.name}` };
    return storeKey(item, i.value, true, i.file === true);
  }

  /** what GET /api/inbox/search reads (inbox/search.ts): every ask of the world from the stored view and his answers. */
  const searchSources = async () => ({ waiting: (await itemsIn({ includeSettled: true, includeSuperseded: true })).items as unknown as Record<string, unknown>[], responses: listResponses() as unknown as Record<string, unknown>[] });
  return { jobs, pasteKey, searchSources, ...(o.settle ? { settle: settleFrom } : {}) };
}

/** the gate rule a held reason comes from (GET /api/asks/held). */
export function heldRule(reason: string): string {
  if (reason.startsWith("already answered on ")) return "answered before";
  if (reason.startsWith("too long for one sitting")) return "too long";
  if (reason.startsWith("ask needs rewriting")) return "dry run failed";
  if (reason.startsWith("waiting for its dry run")) return "waiting for its dry run";
  if (/re-states something/.test(reason)) return "re-states his decision";
  if (/does not name what of/.test(reason)) return "not his ask";
  if (/go-live date/.test(reason)) return "go-live date";
  if (/hands without|rests on his Mac/.test(reason)) return "hands without why";
  return "other";
}
