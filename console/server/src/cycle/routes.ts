import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Assignment, Store } from "../store.js";
import { CycleError, type Cycle } from "./service.js";
import { handoverIn } from "./handover.js";
import { workerLaunchIn } from "./workerLaunch.js";
import { ownerName } from "../identity.js";

const bootstrapIn = z
  .object({
    repo: z.string().trim().min(1),
    title: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    kind: z.enum(["spine", "ticket"]).default("spine"),
    owner: z.string().default(ownerName()),
  })
  .strict();
const steerIn = z.object({ message: z.string().optional(), clientRequestId: z.string().optional() });
/** optional one-off instructions for this Run now (empty = none). */
export const RUN_NOW_NOTE_MAX = 4000;
/** who gave the note (default the owner; the Unblocker sends `noteBy: "Unblocker"` when it wakes the Delivery Manager). */
const runNowIn = z.object({
  note: z.string().trim().max(RUN_NOW_NOTE_MAX).optional(),
  noteBy: z.string().trim().max(60).optional(),
  clientRequestId: z.string().trim().max(120).optional(),
});
/** An Unblocker note per section U starts "Unblocker answered"; read as the Unblocker's even without `noteBy` (older remits). */
export const noteAuthor = (note: string, by?: string) => by?.trim() || (/^\s*unblocker answered\b/i.test(note) ? "Unblocker" : ownerName());
/** Stop = the reason (required), `withWorkers` also stops the run's running child runs. */
const stopIn = z.object({ reason: z.string().trim().min(1).max(500), withWorkers: z.boolean().optional() });
const wakeIn = z.object({ threadId: z.string().optional(), seat: z.string().optional(), clientRequestId: z.string().trim().max(120).optional() }).passthrough();

const errJson = (c: Context, e: CycleError) =>
  c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.status);

/** Run a T3 side effect after a CRUD write without failing the write; errors are kept on the link. */
async function quietly(what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`cycle ${what}:`, (e as Error).message);
  }
}

/**
 * Mounts the cycle on the /api router: hooks around the CRUD routes (assignment ↔ T3 scheduled task
 * sync, Needs the owner follow-ups, seat release) and the cycle endpoints. Must be mounted before the CRUD routes.
 */
export function mountCycle(api: Hono, store: Store, cycle: Cycle) {
  // ---- hooks around CRUD ----
  api.use("/assignments", async (c, next) => {
    await next();
    if (c.req.method === "POST" && c.res.status === 201) {
      const a = (await c.res.clone().json()) as Assignment;
      await quietly("sync", () => cycle.sync(a.id));
      c.res = new Response(JSON.stringify(store.getAssignment(a.id)), { status: 201, headers: c.res.headers });
    }
  });
  api.use("/assignments/:id", async (c, next) => {
    const id = c.req.param("id");
    const before = c.req.method === "DELETE" ? store.getAssignment(id) : undefined;
    await next();
    if (c.req.method === "DELETE" && c.res.status === 204 && before) await quietly("delete", () => cycle.onAssignmentDeleted(before));
    if ((c.req.method === "PATCH" || c.req.method === "PUT") && c.res.status === 200) {
      await quietly("sync", () => cycle.sync(id));
      c.res = new Response(JSON.stringify(store.getAssignment(id)), { status: 200, headers: c.res.headers });
    }
  });
  const cascade = (key: "milestoneId" | "personaId") => async (c: Context, next: () => Promise<void>) => {
    const id = c.req.param("id")!;
    const affected = store.listAssignments({ [key]: id });
    const hostBefore = key === "personaId" ? store.getPersona(id)?.host : undefined;
    await next();
    if (c.req.method === "DELETE" && c.res.status === 204)
      for (const a of affected) await quietly("delete", () => cycle.onAssignmentDeleted(a));
    // Pausing a milestone clears its next wakes (and deletes leftover T3 tasks); a persona host change moves its assignments.
    const hostChanged = key === "personaId" && store.getPersona(id)?.host !== hostBefore;
    if ((c.req.method === "PATCH" || c.req.method === "PUT") && c.res.status === 200 && (key === "milestoneId" || hostChanged))
      for (const a of affected) await quietly("sync", () => cycle.sync(a.id));
  };
  api.use("/milestones/:id", cascade("milestoneId"));
  api.use("/personas/:id", cascade("personaId"));
  api.use("/runs/:id", async (c, next) => {
    await next();
    if (c.req.method === "PATCH" && c.res.status === 200) {
      await quietly("seat release", () => cycle.releaseSeatHold(c.req.param("id")));
      cycle.runEnded(c.req.param("id")); // a run that ended pulls its repo so what it pushed shows at once
    }
  });

  // ---- cycle endpoints ----
  const guard = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof CycleError) return errJson(c, e);
      throw e;
    }
  };

  api.get("/cycle", (c) => c.json({ enabled: cycle.enabled, publicUrl: cycle.publicUrl }));

  api.post(
    "/assignments/:id/run-now",
    guard(async (c) => {
      const id = c.req.param("id")!;
      if (!store.getAssignment(id)) throw new CycleError(404, "not_found", `assignment ${id} not found`);
      const t = await c.req.text().catch(() => "");
      let raw: unknown = {};
      try {
        raw = t.trim() ? JSON.parse(t) : {};
      } catch {
        return c.json({ error: { code: "invalid_body", message: "body must be JSON" } }, 400);
      }
      const p = runNowIn.safeParse(raw);
      if (!p.success) return c.json({ error: { code: "invalid_note", message: `note must be a string of at most ${RUN_NOW_NOTE_MAX} characters` } }, 400);
      const note = p.data.note || undefined;
      // a repeat with the same clientRequestId answers 200 with the first request's run.
      const { run, replayed } = await cycle.runNowRequest(id, { instructions: note, instructionsBy: note ? noteAuthor(note, p.data.noteBy) : undefined }, p.data.clientRequestId || undefined);
      // a note queued into the still-running wake answers 200 with that run (`startGuard: "queued"`): no run was created.
      return c.json(run, replayed || "startGuard" in run ? 200 : 201);
    }),
  );

  // hand the session over to the other host: a new top-level T3 thread there reads the epic's Handover note.
  api.post(
    "/handover",
    guard(async (c) => {
      const raw = await c.req.json().catch(() => undefined);
      const p = handoverIn.safeParse(raw ?? {});
      if (!p.success)
        return c.json({ error: { code: "invalid_handover", message: p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
      const { handover, replayed } = await cycle.handover(p.data);
      return c.json(handover, replayed ? 200 : 201);
    }),
  );

  // the console launches a worker on the main server. Refused 409 `vps1_workers_off` unless CONSOLE_CAP_FALLBACK=1 (incident).
  api.post(
    "/runs/:id/workers",
    guard(async (c) => {
      const raw = await c.req.json().catch(() => undefined);
      const p = workerLaunchIn.safeParse(raw ?? {});
      if (!p.success)
        return c.json({ error: { code: "invalid_worker", message: p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
      const { run, replayed } = await cycle.launchWorker(c.req.param("id")!, p.data);
      return c.json(run, replayed ? 200 : 201);
    }),
  );

  // steer the running persona (message into its T3 thread).
  api.post(
    "/assignments/:id/steer",
    guard(async (c) => {
      const id = c.req.param("id")!;
      if (!store.getAssignment(id)) throw new CycleError(404, "not_found", `assignment ${id} not found`);
      const raw = await c.req.json().catch(() => ({}));
      const p = steerIn.safeParse(raw);
      const message = p.success ? (p.data.message ?? "").trim() : "";
      if (!message) return c.json({ error: { code: "empty_message", message: "message is required" } }, 400);
      return c.json(await cycle.steer(id, message, p.success ? p.data.clientRequestId : undefined));
    }),
  );

  // steer any running run by its id (a persona wake or a child worker): message into that run's own thread.
  api.post(
    "/runs/:id/steer",
    guard(async (c) => {
      const raw = await c.req.json().catch(() => ({}));
      const p = steerIn.safeParse(raw);
      const message = p.success ? (p.data.message ?? "").trim() : "";
      if (!message) return c.json({ error: { code: "empty_message", message: "message is required" } }, 400);
      return c.json(await cycle.steerRun(c.req.param("id")!, message, p.success ? p.data.clientRequestId : undefined));
    }),
  );

  // stop a running run now (T3 interrupt), closing it `stopped` with the reason. Never resumes on its own (L-10).
  api.post(
    "/runs/:id/stop",
    guard(async (c) => {
      const raw = await c.req.json().catch(() => undefined);
      const p = stopIn.safeParse(raw ?? {});
      if (!p.success) return c.json({ error: { code: "empty_reason", message: "reason is required (at most 500 characters)" } }, 400);
      return c.json(await cycle.stopRun(c.req.param("id")!, p.data));
    }),
  );

  // The woken agent fetches its full prompt here (text/plain). ?format=json returns {prompt, run}.
  api.post(
    "/assignments/:id/wake",
    guard(async (c) => {
      let raw: unknown = {};
      try {
        const t = await c.req.text();
        raw = t.trim() ? JSON.parse(t) : {};
      } catch {
        raw = {};
      }
      const parsed = wakeIn.safeParse(raw);
      // the stub's clientRequestId (its run id): a retry after a client timeout gets the same wake, not a skip.
      const out = await cycle.wakeRequest(c.req.param("id")!, parsed.success ? parsed.data : {});
      if (c.req.query("format") === "json") return c.json(out);
      return c.text(out.prompt + "\n");
    }),
  );

  api.get(
    "/assignments/:id/cycle",
    guard(async (c) => c.json(await cycle.status(c.req.param("id")!))),
  );

  api.post(
    "/milestones/bootstrap",
    guard(async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: { code: "invalid_json", message: "request body must be valid JSON" } }, 400);
      }
      const p = bootstrapIn.safeParse(raw);
      if (!p.success) return c.json({ error: { code: "validation_error", message: "invalid request body", details: p.error.issues } }, 400);
      return c.json(await cycle.bootstrap(p.data), 201);
    }),
  );
  api.get("/bootstraps", (c) => c.json(cycle.listBootstraps()));
}
