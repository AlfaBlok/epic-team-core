import type { Context, Hono } from "hono";
import { z } from "zod";
import { PriorityError, type PriorityMode } from "./priorityMode.js";

/**
 * Priority mode routes (home world only: routeScope denies new routes to other worlds by default).
 *   GET  /api/priority-mode                      → {on, session, parked, log, focusRunning}
 *   POST /api/priority-mode {rows, reason?, by?, assignmentId?} → park every other running session, run only these rows
 *   POST /api/priority-mode/resume {why?, by?}   → end it and wake every parked worker, best rank first
 */
const startIn = z
  .object({
    rows: z.array(z.string().trim().min(1).max(40)).min(1).max(2),
    reason: z.string().trim().max(500).optional(),
    by: z.string().trim().max(60).optional(),
    assignmentId: z.string().trim().max(80).optional(),
  })
  .strict();
const resumeIn = z.object({ why: z.string().trim().max(500).optional(), by: z.string().trim().max(60).optional() }).strict();

export function mountPriority(api: Hono, pm: PriorityMode, ownerName: () => string) {
  const fail = (c: Context, e: unknown) => {
    if (e instanceof PriorityError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
    throw e;
  };
  const parse = async <T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> => {
    let raw: unknown = {};
    try {
      const text = await c.req.text();
      raw = text.trim() ? JSON.parse(text) : {};
    } catch {
      return c.json({ error: { code: "invalid_json", message: "request body must be valid JSON" } }, 400);
    }
    const r = schema.safeParse(raw);
    if (!r.success) return c.json({ error: { code: "validation_error", message: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
    return r.data;
  };

  api.get("/priority-mode", (c) => c.json(pm.view()));
  api.post("/priority-mode", async (c) => {
    const b = await parse(c, startIn);
    if (b instanceof Response) return b;
    try {
      return c.json(await pm.start({ rows: b.rows, reason: b.reason, by: b.by || ownerName(), assignmentId: b.assignmentId }), 201);
    } catch (e) {
      return fail(c, e);
    }
  });
  api.post("/priority-mode/resume", async (c) => {
    const b = await parse(c, resumeIn);
    if (b instanceof Response) return b;
    try {
      return c.json(await pm.resume({ by: b.by || ownerName(), why: b.why || "Resume pressed" }));
    } catch (e) {
      return fail(c, e);
    }
  });
}
