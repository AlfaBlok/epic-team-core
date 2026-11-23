import { z } from "zod";
import { isHostId, mainHost, workerHost } from "./identity.js";

/** one of the two host ids, read when a request is parsed (the ids are config, set after this module may load) */
export const hostIdSchema = () =>
  z.string().refine((h) => isHostId(h), () => ({ message: `Invalid enum value. Expected '${mainHost()}' | '${workerHost()}'` }));

const nonEmpty = z.string().trim().min(1);

export const milestoneCreate = z
  .object({
    title: nonEmpty,
    repo: nonEmpty,
    path: nonEmpty,
    owner: z.string().default(""),
    paused: z.boolean().default(false),
    // position among the owner's big roots (1 first); null on a patch makes it an ordinary milestone again.
    bigRoot: z.number().int().min(1).max(99).nullable().optional(),
  })
  .strict();
// an empty title clears the Settings title, so the spine's own title shows again.
export const milestonePatch = milestoneCreate.extend({ title: z.string().trim() }).partial().strict();

export const personaCreate = z
  .object({
    name: nonEmpty,
    remit: nonEmpty,
    skills: z.array(nonEmpty).default([]),
    model: z.string().default(""),
    mayWrite: z.boolean().default(false),
    host: hostIdSchema().default(() => mainHost()),
    // launch a new thread for every wake (the Unblocker), instead of waking the home thread.
    freshThreadEachWake: z.boolean().default(false),
    // skip a cadence wake when nothing changed since the last real wake (opt out per persona).
    skipUnchanged: z.boolean().default(true),
  })
  .strict();
export const personaPatch = personaCreate.partial().strict();

export const cadence = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("interval"),
      everyMinutes: z.number().int().min(1).max(60 * 24 * 31),
      // no wake from `from` to `to` (HH:MM in timeZone, may cross midnight): a wake that would fall inside waits for `to`.
      quiet: z
        .object({
          from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "quiet.from must be HH:MM (24h)"),
          to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "quiet.to must be HH:MM (24h)"),
          timeZone: z.string().refine((tz) => {
            try {
              new Intl.DateTimeFormat("en-US", { timeZone: tz });
              return true;
            } catch {
              return false;
            }
          }, "quiet.timeZone must be an IANA time zone"),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fixed_time"),
      timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "timeOfDay must be HH:MM (24h)"),
      // 0 = Sunday … 6 = Saturday
      weekdays: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .refine((d) => new Set(d).size === d.length, "weekdays must be unique"),
    })
    .strict(),
]);
export type Cadence = z.infer<typeof cadence>;

const isoTime = z.string().datetime({ offset: true });

export const assignmentCreate = z
  .object({
    milestoneId: nonEmpty,
    personaId: nonEmpty,
    cadence,
    // Safety: a new assignment never fires until toggled on.
    enabled: z.boolean().default(false),
    t3ScheduledTaskId: z.string().nullable().optional(),
    lastRunAt: isoTime.nullable().optional(),
    nextRunAt: isoTime.nullable().optional(),
    // write on this milestone only, limited to writeScope (off by default).
    // omitted = the persona's may_write decides the default for this new assignment.
    writeEnabled: z.boolean().optional(),
    writeScope: z.string().max(2000).optional(),
    // the objective (docs/pursuits.json id) it works; "" on a patch clears it.
    objective: z.string().trim().max(80).regex(/^[a-z0-9-]*$/, "an objective id: lowercase words joined by -").optional(),
  })
  .strict();
export const assignmentPatch = assignmentCreate.partial().strict();

// `monitoring` = nothing to do until a time or condition (nextCheckAt); `blocked` needs an open ask code.
export const outcome = z.enum(["running", "progressed", "blocked", "monitoring", "idle", "failed", "blank_report"]);

export const runKind = z.enum(["wake", "answer_run"]);

/** one ask an Unblocker run checked, sent in its finishing PATCH (`checks`). */
export const runCheck = z
  .object({
    code: z.string().trim().min(1).max(80),
    decision: z.enum(["answered", "left", "split"]),
    answer: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(100).optional(),
    source: z.string().max(1000).optional(),
    why: z.string().max(2000).optional(),
    // a `left` ask of kind provide says what it checked for an existing credential or a no-credential path.
    searched: z.string().max(2000).optional(),
    spine: z.string().max(400).optional(),
    // set by the console on checks a skipped cadence wake copied from an earlier run.
    skipped: z.boolean().optional(),
    // set by the console on a remembered verdict carried unchanged (the run that assessed it).
    carriedFrom: z.string().max(80).optional(),
    // the confidence rubric's four factors (0-4 each) and the hard-floor ids the ask touches (cycle/rubric.ts).
    scores: z.object({ reversal: z.number(), options: z.number(), impact: z.number(), evidence: z.number() }).strict().optional(),
    floor: z.array(z.string().max(40)).max(10).optional(),
    // stamped by the console (the rubric the check was judged by); ignored when sent.
    rubric: z.any().optional(),
  })
  .strict();

/** `egress:<name>` from the Team Browser's HELD text (e.g. egress:laptop). */
export const heldOn = z.string().trim().regex(/^egress:[a-z0-9_-]{1,40}$/, "heldOn must be egress:<name>, e.g. egress:laptop");

export const runCreate = z
  .object({
    assignmentId: nonEmpty,
    startedAt: isoTime.optional(),
    endedAt: isoTime.nullable().optional(),
    seat: z.string().nullable().optional(),
    threadId: z.string().nullable().optional(),
    outcome: outcome.default("running"),
    summary: z.string().default(""),
    parentRunId: z.string().nullable().optional(),
    kind: runKind.optional(),
    // wake this assignment at this time (ISO UTC), e.g. a step that needs a time window. Earliest pending wins.
    retryAt: isoTime.nullable().optional(),
    // the asks this run checked (Unblocker), shown per ask in Activity.
    checks: z.array(runCheck).max(100).nullable().optional(),
    // a `monitoring` run's next scheduled check (ISO; also asks for a timed wake then) and, optionally, when the watch ends.
    nextCheckAt: isoTime.nullable().optional(),
    until: isoTime.nullable().optional(),
    // the run ended monitoring because this egress was offline (the Team Browser's HELD); its online event wakes it.
    heldOn: heldOn.nullable().optional(),
    // the host the run's agent runs on (`hostname` on the main server / the worker server); without it a child run takes its parent's.
    host: hostIdSchema().nullable().optional(),
    // the caller's id for this create; a repeat with the same id (per assignment) returns the first run (200).
    clientRequestId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export const runPatch = runCreate.omit({ assignmentId: true, startedAt: true, kind: true, clientRequestId: true }).partial().strict();

export const needsJordiStatus = z.enum(["open", "approved", "denied", "answered"]);
/** Filter values for GET /needs-owner (adds superseded, which only POST /needs-owner/:id/supersede sets). */
export const needsJordiFilterStatus = z.enum(["open", "approved", "denied", "answered", "superseded"]);
/** `moot`, or the coded ask that replaced it: `<repo>/<epic>-A<n>` (repo optional). */
export const needsJordiSupersede = z
  .object({ by: z.string().trim().regex(/^(moot|([\w.-]+\/)?[A-Za-z0-9]+(-[A-Za-z0-9]+)*-A\d+)$/, "by must be `moot` or an ask code like poly-maker/E904-A1").optional() })
  .strict();
/**
 * POST /needs-owner raises an ask in the asker's spine (`path`, default the milestone's), not a DB row. `status`
 * is still accepted (only `open`) so older callers keep working.
 */
export const needsJordiCreate = z
  .object({
    runId: z.string().nullable().optional(),
    milestoneId: nonEmpty,
    question: nonEmpty,
    proposedAction: z.string().default(""),
    status: z.literal("open").optional(),
    path: z.string().trim().min(1).optional(),
    row: z.string().trim().regex(/^[\w.-]+$/, "row must be a ledger row id like E962-S4").optional(),
    /** the ask's kind when the caller knows it (a `do` ask is a step only the owner can do); default from the text. */
    kind: z.enum(["do", "decide", "approve", "provide"]).optional(),
    /** E948-S172: the card's topic in plain words, 8 or fewer (its first line, `About: …`); derived from the question when left out. */
    about: z.string().trim().min(1).max(80).optional(),
    /** a `do` step in his own signed-in browser: one plain prompt he pastes into Claude in Chrome (no terminal line, no secret). */
    browser: z.string().trim().min(1).max(1200).optional(),
  })
  .strict();
/** an ask the console wrote taken out again by its raiser once it is moot (the Team Browser's site reads signed in again). */
export const needsJordiRetire = z
  .object({
    milestoneId: nonEmpty,
    path: z.string().trim().min(1),
    code: z.string().trim().regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-A\d+$/, "code must be an ask code like EPIC-986-A2"),
    why: z.string().trim().min(1).max(300),
  })
  .strict();
export const needsJordiPatch = z.object({ status: needsJordiStatus }).strict();
