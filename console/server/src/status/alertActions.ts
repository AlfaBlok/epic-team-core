import type { Hono } from "hono";
import type { DB } from "../db.js";
import { currentAuth, runWithAuth, type AuthContext, type Identity } from "../auth/identity.js";
import { hasOwnerPower } from "../auth/owner.js";
import type { Milestone, Store } from "../store.js";
import type { ResolvedAsk } from "./monitorAlert.js";

/**
 * a counted monitor alert carries the actions of the ask that unblocks it (Approve, Deny, Answer, Save key,
 * Snooze), and the ask often sits in another world (a social world repo's always-on Reddit waits on the code repo/).
 * `POST /api/milestones/:id/alert-asks/:code/(respond|snooze|secret)` relays the click to the ask's own inbox route in
 * its own world (`/api/waiting-on-owner/<item>/<action>`, every check and write of that route unchanged), only when:
 *  - the path milestone is the caller's (rule 3 of the gate) and one of its stopped / overdue monitor items names that
 *    ask, open, right now (no relay to any other ask);
 *  - the caller may act in the ask's world: the same world, or a login that is a member of it (the owner's a social world repo
 *    session for the code repo ask), or the console host; a world's agent token never acts in another world.
 */
export interface AlertActionDeps {
  db: DB;
  store: Store;
  /** The asks the milestone's stopped / overdue monitor items name, resolved in any world (monitorAlert.askLookupIn). */
  alertAsks: (m: Milestone) => Promise<ResolvedAsk[]>;
  /** The app itself: the relayed request runs through its routes. */
  fetch: (req: Request) => Response | Promise<Response>;
}

type Refusal = { status: 403 | 404; code: string; message: string };

/** The identity the relayed request runs as in the ask's world, or why the caller may not act there. */
export function actAs(db: DB, ctx: AuthContext | undefined, world: string | undefined, code: string): { ctx?: AuthContext } | Refusal {
  if (!ctx) return {}; // CONSOLE_AUTH=off: every caller is today's console
  const i = ctx.identity;
  if (!world || ("tenant" in i && i.tenant === world)) return { ctx };
  const inWorld = (identity: Identity): { ctx: AuthContext } => ({ ctx: { mode: ctx.mode, identity, ...(ctx.mode === "on" ? { scope: world } : {}), via: "gateway" } });
  if (i.kind === "session") {
    const m = db.prepare("SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?").get(i.userId, world) as { role: string } | undefined;
    if (m) return inWorld({ ...i, tenant: world, role: m.role as typeof i.role });
    if (sameOwner(db, i, world)) return inWorld({ ...i, tenant: world });
    return { status: 403, code: "not_member", message: `${code} is an ask of the world ${world}, and your login is not a member of it` };
  }
  if (i.kind === "legacy" && hasOwnerPower(i, ctx.mode)) return inWorld({ ...i, tenant: world });
  return { status: 403, code: "cross_world", message: `${code} is an ask of the world ${world}: a world's token acts only in its own world; log in as a member of ${world} to answer it here` };
}

/**
 * the owner logs into each world with its own login (j…@our domain for the home world, j…@memory.dev for a social world repo), so
 * membership alone would refuse his own button. The owner login of one of the platform's own worlds (plan `internal`)
 * whose recorded owner is the target world's owner (`tenants.owner_handle`, both set by the platform, never by a world:
 * a tester world has its own plan and handle) is the same person: it may act there, through this relay only (an ask its
 * milestone's monitor alert names). Rollback: drop this check (cross-world buttons then need a membership).
 */
function sameOwner(db: DB, i: Extract<Identity, { kind: "session" }>, world: string): boolean {
  if (i.role !== "owner") return false;
  const row = (id: string) => db.prepare("SELECT plan, owner_handle FROM tenants WHERE id = ?").get(id) as { plan: string; owner_handle: string } | undefined;
  const from = row(i.tenant);
  const to = row(world);
  return !!from && !!to && from.plan === "internal" && !!from.owner_handle && from.owner_handle === to.owner_handle;
}

export function mountAlertActions(api: Hono, d: AlertActionDeps) {
  api.post("/milestones/:id/alert-asks/:code/:action{respond|snooze|secret}", async (c) => {
    const err = (status: 400 | 403 | 404, code: string, message: string) => c.json({ error: { code, message } }, status);
    const m = d.store.getMilestone(c.req.param("id"));
    if (!m) return err(404, "not_found", `milestone ${c.req.param("id")} not found`);
    const code = c.req.param("code").toUpperCase();
    const action = c.req.param("action");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return err(400, "invalid_json", "request body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "validation_error", "request body must be a JSON object");
    const ask = (await d.alertAsks(m)).find((a) => a.code.toUpperCase() === code && a.state === "open" && a.milestoneId);
    if (!ask) return err(404, "not_found", `no stopped or overdue Monitoring item of ${m.title} names an open ask ${code}`);
    const world = ask.world ?? d.store.worldOfMilestone?.(ask.milestoneId!);
    const as = actAs(d.db, currentAuth(), world, code);
    if ("status" in as) return err(as.status, as.code, as.message);
    const origin = new URL(c.req.url).origin;
    const run = <T>(fn: () => Promise<T>): Promise<T> => (as.ctx ? runWithAuth(as.ctx, fn) : fn());
    const call = (path: string, init?: RequestInit) => run(async () => d.fetch(new Request(origin + path, init)));
    // The ask's item as its own inbox lists it now (its id is what the inbox routes act on).
    const listed = await call(`/api/waiting-on-owner?milestoneId=${encodeURIComponent(ask.milestoneId!)}`);
    const items = listed.ok ? ((await listed.json()) as { id: string; code?: string; source: string; state: string }[]) : [];
    const item = Array.isArray(items) ? items.find((x) => x.source === "ask" && x.state === "open" && x.code?.toUpperCase() === code) : undefined;
    const id = item?.id ?? ask.id;
    if (!id) return err(404, "not_found", `${code} is not open in its inbox any more`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = c.req.header("idempotency-key");
    if (key) headers["idempotency-key"] = key;
    const res = await call(`/api/waiting-on-owner/${encodeURIComponent(id)}/${action}`, { method: "POST", headers, body: JSON.stringify({ ...body, milestoneId: ask.milestoneId }) });
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  });
}
