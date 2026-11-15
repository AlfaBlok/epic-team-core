import { classifyRefusal, refusalText } from "../cycle/capRefusal.js";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Assignment, Milestone, Persona, Run, Store } from "../store.js";
import type { Dispatcher } from "../t3/dispatcher.js";
import { ticketId } from "../adapters/outcome.js";
import { FINISH_THE_JOB_RULE, STEPS_PAGE_RULE, VISUAL_FIRST_RULE } from "../inbox/asks.js";
import { START_FAIL_RULE, WORKER_FINISH_RULE, WORKER_TIER_RULE } from "../cycle/prompts.js";
import type { ChatScope } from "./scope.js";
import { chatCaller } from "./milestoneChat.js";
import { DEFAULT_TENANT } from "../db.js";
import { hooks } from "../plug/hooks.js";
import { sameRepo } from "../adapters/repoNames.js";
import { ownerName } from "../identity.js";

/**
 * the repo desk dispatches workers for its milestone when the owner asks in its chat, through the console so every
 * worker shows in Activity/Runs with Steer/Stop (the L-22 shape): a parent Run on the milestone's "Repo desk" assignment
 * (created switched off on first need: it never wakes on its own, root L-10), ended at once, with the chat thread; each
 * worker a child Run (`parentRunId`, `seat`, later `threadId`) that the desk PATCHes when the worker returns.
 *
 * The child run is the claim on its row. A row with a running child run in the same repo is claimed: the chat's dispatch
 * refuses it (409 `claimed`), and every wake prompt lists the claimed rows so the Delivery manager's scheduled wake leaves the
 * repo desk's rows alone (and the desk the manager's). Each integrates only the workers it dispatched (root L-3).
 */

export interface Claim {
  ticket: string;
  runId: string;
  parentRunId?: string;
  assignmentId: string;
  persona: string;
  milestoneId?: string;
  summary: string;
}

const TICKET = /^[A-Z][A-Z0-9]*-[A-Z0-9-]*\d[A-Za-z0-9-]*$/;
/** The row a child run works on: its summary starts with the row id (` …`, `N10-6 …`), else the first ticket id in it. */
export function rowOf(summary: string): string | undefined {
  const first = summary.trim().split(/\s+/)[0]?.replace(/[:,.;]+$/, "") ?? "";
  return TICKET.test(first) ? first : ticketId(summary);
}

/**
 * Running child runs of every milestone of the same repo whose summary names a ticket: the rows in flight. Given the
 * milestone's id, only milestones of its own world count (a checkout name is not a world boundary; the home world unchanged while
 * every row is the home world).
 */
export function claimsFor(store: Store, m: Pick<Milestone, "repo"> & { id?: string }): Claim[] {
  const world = m.id ? store.worldOfMilestone(m.id) : undefined;
  const same = new Set(
    store
      .listMilestones({ includeSettled: true })
      .filter((x) => sameRepo(x.repo, m.repo) && (!world || store.worldOfMilestone(x.id) === world))
      .map((x) => x.id),
  );
  const out: Claim[] = [];
  for (const id of same)
    for (const r of store.listRunningChildRuns(id)) {
      const ticket = rowOf(r.summary);
      if (!ticket) continue;
      const a = store.getAssignment(r.assignmentId);
      const persona = store.getPersona(r.personaId ?? a?.personaId ?? "")?.name ?? "another persona";
      out.push({ ticket, runId: r.id, parentRunId: r.parentRunId, assignmentId: r.assignmentId, persona, milestoneId: r.milestoneId, summary: r.summary });
    }
  return out;
}

/**
 * The dispatch-time check (a row was once dispatched twice by two Delivery Managers 2 minutes apart, on
 * 2026-11-12): a new worker (a child run) for a row that already has a live session is refused before any worker starts,
 * whoever dispatches it (a wake, the repo desk, another Delivery Manager). Live = a running child run of the same repo
 * names the row, or the row's Owner cell holds a claim (`spines.py --claim`) whose holder is a running run, or whose holder
 * is no run the console knows (a T3 thread, another host) and whose lease has not ended. A claim by a run that already
 * ended is stale: the row may be dispatched again. A claim by the dispatching wake itself is its own.
 */
export function rowClaimRefusal(
  store: Store,
  o: { assignmentId: string; parentRunId?: string | null; summary?: string; claimIn?: (ref: string, m: Milestone) => { by: string; until: string; path: string } | undefined; now?: number },
): { code: "claimed"; row: string; holder: string; message: string } | undefined {
  if (!o.parentRunId) return undefined;
  const row = rowOf(o.summary ?? "");
  if (!row) return undefined;
  const a = store.getAssignment(o.assignmentId);
  const m = a ? store.getMilestone(a.milestoneId) : undefined;
  if (!m) return undefined;
  const run = claimsFor(store, m).find((c) => c.ticket === row);
  if (run)
    return {
      code: "claimed",
      row,
      holder: run.runId,
      message: `${row} already has a live session: ${run.persona}'s child run ${run.runId} works on it (parent ${run.parentRunId ?? "none"}). Skip this row: do not start a second worker; call \`done <seat>\` for the seat you picked.`,
    };
  const c = o.claimIn?.(row, m);
  if (!c || c.by === o.parentRunId) return undefined;
  const holder = store.getRun(c.by);
  const leaseOn = Date.parse(c.until.replace(/Z$/, ":00Z")) > (o.now ?? Date.now());
  const live = holder ? holder.outcome === "running" && !holder.endedAt : leaseOn;
  if (!live) return undefined;
  return {
    code: "claimed",
    row,
    holder: c.by,
    message: `${row} is claimed in ${c.path}: ${c.by} holds it (lease until ${c.until}${holder ? ", its run is still running" : ""}). Skip this row: do not start a second worker; call \`done <seat>\` for the seat you picked.`,
  };
}

/** The wake-prompt section (appended next to the tree to-do): which rows are already being worked, and by whom. */
export function claimsSection(claims: Claim[]): string | undefined {
  if (!claims.length) return undefined;
  return [
    "## Rows in flight (claimed)",
    "A running child run is the claim on its row. Do not dispatch, steer or integrate a row another persona's run claims: leave it to that persona " +
      "(each integrates only the workers it dispatched, root L-3). Your own claims you track as usual.",
    ...claims.map((c) => `- ${c.ticket} — claimed by ${c.persona} (child run ${c.runId}${c.parentRunId ? `, parent ${c.parentRunId}` : ""}): ${c.summary.slice(0, 160)}`),
  ].join("\n");
}

const dispatchIn = z
  .object({
    /** The ledger row the worker works on (e.g. ``); the child run's summary starts with it. */
    ticket: z.string().trim().regex(TICKET, "ticket must be a ledger row id like E919-S5"),
    /** What the worker does, one line. */
    summary: z.string().trim().min(1).max(500),
    /** The spine the row lives in, when it is a lower spine of this milestone (scope-checked). */
    path: z.string().trim().max(500).optional(),
    /** Reuse the parent run of an earlier dispatch from this chat (several workers for one request). */
    parentRunId: z.string().trim().optional(),
    /** Records the parent + child runs without picking a seat: no worker starts; close the child yourself. */
    dryRun: z.boolean().optional(),
  })
  .strict();

export interface ChatDispatchDeps {
  store: Store;
  scope: ChatScope;
  dispatcher?: Dispatcher;
  publicUrl: string;
  /** The Repo desk persona (created from its remit on first need). */
  persona: (m: Milestone) => Persona;
  /** the milestone's world (its curls then carry the Repo desk's world token); unset = the home world. */
  worldOf?: (m: Milestone) => string;
  /** The milestone chat's live T3 thread, when there is one. */
  chatThread: (m: Milestone) => string | undefined;
  maxWorkers: number;
  now?: () => number;
  /** the live claim in the row's Owner cell (spines.py --claim), read from the milestone's checkout. */
  claimIn?: (ref: string, m: Milestone) => { by: string; until: string; path: string } | undefined;
}

export class DispatchError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createChatDispatch(d: ChatDispatchDeps) {
  const base = d.publicUrl.replace(/\/+$/, "");
  const iso = () => new Date((d.now ?? Date.now)()).toISOString();

  /** The milestone's Repo desk assignment: created switched off (never wakes on its own); its runs are the chat's dispatches. */
  function deskAssignment(m: Milestone): Assignment {
    const persona = d.persona(m);
    const have = d.store.listAssignments({ milestoneId: m.id }).find((a) => a.personaId === persona.id);
    return have ?? d.store.createAssignment({ milestoneId: m.id, personaId: persona.id, cadence: { type: "interval", everyMinutes: 24 * 60 }, enabled: false });
  }

  async function dispatch(callerHeader: string | undefined, milestoneId: string, raw: unknown) {
    const callerId = chatCaller(callerHeader);
    if (!callerId) throw new DispatchError(403, "chat_only", "dispatch from a chat is called by a milestone chat (X-Console-Run: milestone-chat:<id>); a wake dispatches with POST /api/runs");
    const m = d.store.getMilestone(milestoneId);
    if (!m) throw new DispatchError(404, "not_found", `no milestone ${milestoneId}`);
    const p = dispatchIn.safeParse(raw);
    if (!p.success) throw new DispatchError(400, "validation_error", p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    const b = p.data;
    const why = await d.scope.refusal(callerId, m, b.path);
    if (why) throw new DispatchError(403, "out_of_scope", why);

    const claim = claimsFor(d.store, m).find((c) => c.ticket === b.ticket);
    if (claim)
      throw new DispatchError(
        409,
        "claimed",
        `${b.ticket} is already being worked: ${claim.persona}'s child run ${claim.runId} (${base}/runs/${claim.runId}) claims it. Leave it to ${claim.persona}; steer or stop that run only if ${ownerName()} asks.`,
      );
    const held = d.claimIn?.(b.ticket, m);
    if (held) {
      const holder = d.store.getRun(held.by);
      const live = holder ? holder.outcome === "running" && !holder.endedAt : Date.parse(held.until.replace(/Z$/, ":00Z")) > (d.now ?? Date.now)();
      if (live) throw new DispatchError(409, "claimed", `${b.ticket} is claimed in ${held.path}: ${held.by} holds it (lease until ${held.until}). Leave it; steer or stop that session only if ${ownerName()} asks.`);
    }
    const running = d.store.listRuns({ milestoneId: m.id, limit: 1000 }).filter((r) => r.parentRunId && r.outcome === "running").length;
    if (running >= d.maxWorkers) throw new DispatchError(409, "ceiling", `queued: worker ceiling ${d.maxWorkers} (${running} child runs running for this milestone)`);

    const a = deskAssignment(m);
    let parent: Run | undefined;
    if (b.parentRunId) {
      parent = d.store.getRun(b.parentRunId);
      if (!parent || parent.assignmentId !== a.id || parent.parentRunId)
        throw new DispatchError(400, "bad_parent", `parentRunId must be a parent run of this chat's earlier dispatch on milestone ${m.id}`);
    }

    let seat: string | undefined;
    let providerInstanceId: string | undefined;
    if (!b.dryRun) {
      if (!d.dispatcher) throw new DispatchError(503, "no_dispatcher", "EPICSPINE_DISPATCHER is not set on the console");
      // another world's worker is picked for that world (`pick --world`), so its credits gate holds it
      const world = d.worldOf?.(m) ?? DEFAULT_TENANT;
      const pick = world !== DEFAULT_TENANT && d.dispatcher.pickFor ? await d.dispatcher.pickFor({ world, persona: d.persona(m).id }) : await d.dispatcher.pick();
      if (pick.seat === null)
        throw /credits/.test(pick.reason)
          ? new DispatchError(409, "no_credits", `not started: world ${world} is out of credits (${pick.reason}); tell ${ownerName()}`)
          : new DispatchError(409, "no_seat", `queued: ${refusalText([classifyRefusal(pick.reason)])}`);
      ({ seat, providerInstanceId } = pick);
    }
    try {
      parent ??= d.store.createRun({
        assignmentId: a.id,
        outcome: "progressed",
        endedAt: iso(),
        threadId: d.chatThread(m) ?? null,
        summary: `Dispatched from the milestone chat on ${ownerName()}'s request${b.dryRun ? " (dry run)" : ""}: ${b.ticket}`,
      });
      const summary = b.summary.startsWith(b.ticket) ? b.summary : `${b.ticket} ${b.summary}`;
      const child = d.store.createRun({
        assignmentId: a.id,
        parentRunId: parent.id,
        seat: seat ?? null,
        outcome: "running",
        summary: b.dryRun ? `${summary} [dry run: no worker started]` : summary,
      });
      const w = { tenant: d.worldOf?.(m) ?? DEFAULT_TENANT, personaId: d.persona(m).id };
      return { parent, child, seat, providerInstanceId, dryRun: !!b.dryRun, steps: steps(child, seat, !!b.dryRun).map((l) => hooks.worldCurls(l, w)) };
    } catch (e) {
      if (seat) await d.dispatcher?.done(seat, true).catch(() => undefined);
      throw e;
    }
  }

  const h = "-H 'content-type: application/json'";
  const j = (v: unknown) => `'${JSON.stringify(v)}'`;
  function steps(child: Run, seat: string | undefined, dry: boolean): string[] {
    const patch = (body: object) => `curl -sS -X PATCH ${base}/api/runs/${child.id} ${h} -d ${j(body)}`;
    if (dry)
      return [
        "Dry run: no seat was picked and no worker starts. Close the child run now:",
        patch({ outcome: "progressed", summary: "dry run closed: no worker", endedAt: "<ISO-8601 UTC now>" }),
      ];
    return [
      `1. Launch the worker with the T3 \`delegate_task\` tool (mode async), \`target.providerInstanceId\` = providerInstanceId, \`clientRequestId\` = \`<row id>-${child.id.slice(0, 12)}\` (the console binds its thread to this run), \`title\` = \`<row id> <what it does, a few words>\` (every session is named by its ticket). Its brief names \`Bound epic: <spine path>\` and the row,`,
      `   says: end every commit message with the trailer line \`Run: ${child.id}\`; and carries briefRules verbatim.`,
      `2. ${patch({ threadId: "<childThreadId>" })}`,
      `3. When it returns: verify its diff and checks, integrate per the repo's Integration policy, then ${patch({ outcome: "progressed|failed|blocked|monitoring", summary: "<one line>", endedAt: "<ISO-8601 UTC now>" })}`,
      `   and \`$EPICSPINE_DISPATCHER done ${seat}\` (add \`--fail\` if it failed). Always call done. Update the row and the spine's Current State.`,
      "   If delegate_task fails, PATCH the child `failed` with the error and call done --fail.",
      `   ${START_FAIL_RULE}`,
    ];
  }

  return { dispatch, deskAssignment, claims: (m: Milestone) => claimsFor(d.store, m) };
}

export type ChatDispatch = ReturnType<typeof createChatDispatch>;

/** `POST /api/milestones/:id/chat/dispatch` (from a milestone chat only) and `GET /api/milestones/:id/claims`. */
export function mountChatDispatch(api: Hono, d: ChatDispatchDeps): ChatDispatch {
  const cd = createChatDispatch(d);
  const fail = (c: Context, e: unknown) => {
    if (e instanceof DispatchError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
    throw e;
  };
  api.post("/milestones/:id/chat/dispatch", async (c) => {
    try {
      const r = await cd.dispatch(c.req.header("x-console-run"), c.req.param("id") ?? "", await c.req.json().catch(() => undefined));
      return c.json(
        {
          parentRunId: r.parent.id,
          childRunId: r.child.id,
          seat: r.seat ?? null,
          providerInstanceId: r.providerInstanceId ?? null,
          dryRun: r.dryRun,
          briefRules: [WORKER_FINISH_RULE, WORKER_TIER_RULE, FINISH_THE_JOB_RULE, STEPS_PAGE_RULE, VISUAL_FIRST_RULE],
          steps: r.steps,
        },
        201,
      );
    } catch (e) {
      return fail(c, e);
    }
  });
  // What a wake prompt lists as claimed for this milestone's repo (the same section the wake gets).
  api.get("/milestones/:id/claims", (c) => {
    const m = d.store.getMilestone(c.req.param("id") ?? "");
    if (!m) return c.json({ error: { code: "not_found", message: "no such milestone" } }, 404);
    const claims = claimsFor(d.store, m);
    return c.json({ claims, section: claimsSection(claims) ?? null });
  });
  return cd;
}
