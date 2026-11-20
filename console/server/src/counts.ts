import type { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_TENANT } from "./db.js";
import type { Store } from "./store.js";
import type { ChatUnread } from "./desk/unread.js";
import { TEAM_KEY } from "./desk/session.js";
import { milestoneKey } from "./desk/milestoneChat.js";
import { worldDeskKey } from "./plug/marks.js";
import { currentAuth, runWithAuth, type Member } from "./auth/identity.js";
import { platformBlocked, requestHost } from "./auth/gate.js";
import { ownerName } from "./identity.js";

/**
 * the sidebar's and top bar's pills in one small answer, so no page loads a list only to count it:
 * - `needsYou`: what waits on the owner to unblock (red): the stored Team status of the read model, the same number
 *   the Team badge and Blocked show; null while its spines are not read yet;
 * - `review`: "Done, waiting for your review" (green), the caller's world's spine rows in review that answer live;
 * - `chat`: unread replies in the world's top-level Chat (the home world's Team desk, another world's team desk); null = not known yet;
 * - `milestones`: the same three per sidebar milestone, only the ones with something to show.
 * Per world (TENANT_SAFE): the request-scoped store, the world's own status view, review rows and chats.
 */
export interface CountsDeps {
  store: Store;
  status: () => Promise<{ milestones: { milestoneId: string; needsYou: number | null; loading?: boolean }[]; needsYou: number | null; loading?: boolean; asOf?: string }>;
  review: { list: (f?: { ages?: boolean }) => Promise<{ milestoneId?: string }[]> };
  unread?: ChatUnread;
  /** the worlds a login belongs to (auth's memberships), for the world switcher's per-world counts. */
  memberships?: (userId: string) => Member[];
}

/** one row of the world switcher: a world the login belongs to and what waits on the owner there (red + green). */
export interface WorldCounts {
  tenantId: string;
  tenantName: string;
  role: string;
  current: boolean;
  /** Blocked asks waiting on the owner (the red pill); null while its spines are not read yet. */
  needsYou: number | null;
  /** Review cards (the green pill). */
  review: number;
}

export interface MilestoneCounts {
  needsYou?: number | null;
  review?: number;
  chat?: number;
}

/** The world's top-level Chat: the home world's is the Team desk, another world's its team desk. */
export const deskKeyOf = (world: string) => (world === DEFAULT_TENANT ? TEAM_KEY : worldDeskKey(world));

const seenIn = z.union([z.object({ chat: z.literal("desk") }).strict(), z.object({ chat: z.literal("milestone"), id: z.string().trim().min(1).max(120) }).strict()]);

export function mountCounts(api: Hono, d: CountsDeps) {
  /**
   * the world switcher's rows. A login sees every world it belongs to, each with its red (blocked
   * asks) and green (review cards) counts, read exactly as that world's own /counts reads them: the same status view and
   * review rows, computed inside that world's request scope (the scoped store, its viewWorld). Only a logged-in person gets
   * other worlds (a membership row is the right to read them); an agent token or legacy trust gets its own world only.
   */
  api.get("/counts/worlds", async (c) => {
    const ctx = currentAuth();
    const i = ctx?.identity;
    const here = d.store.tenant ?? DEFAULT_TENANT;
    const own = async (): Promise<Omit<WorldCounts, "tenantId" | "tenantName" | "role" | "current">> => {
      const st = await d.status();
      return { needsYou: st.loading ? null : st.needsYou, review: (await d.review.list({ ages: false })).length };
    };
    if (!ctx || !i || i.kind !== "session" || !d.memberships || ctx.mode !== "on") {
      const t = d.store.getTenant(here);
      return c.json({ worlds: [{ tenantId: here, tenantName: t?.name || here, role: i && i.kind === "session" ? i.role : "member", current: true, ...(await own()) }] });
    }
    const worlds: WorldCounts[] = [];
    // on a customer site the platform world is never listed (its sign-in is refused there).
    const host = requestHost((n) => c.req.header(n));
    for (const m of d.memberships(i.userId).filter((w) => !platformBlocked(host, w.tenantId, process.env, { email: i.email }))) {
      const scoped = { ...ctx, identity: { ...i, tenant: m.tenantId, role: m.role }, scope: m.tenantId };
      const n = m.tenantId === here ? await own() : await runWithAuth(scoped, own).catch(() => ({ needsYou: null, review: 0 }));
      worlds.push({ tenantId: m.tenantId, tenantName: m.tenantName || m.tenantId, role: m.role, current: m.tenantId === here, ...n });
    }
    return c.json({ worlds });
  });

  api.get("/counts", async (c) => {
    const world = d.store.tenant ?? DEFAULT_TENANT;
    const ids = new Set(d.store.listMilestones().map((m) => m.id));
    const st = await d.status();
    // the badge, sidebar and section header count the cards the owner must act
    // on (live, not snoozed, not backlog); Older rows and Not live yet are their own folded sections with their own counts
    const reviews = await d.review.list({ ages: false });
    const desk = deskKeyOf(world);
    const unread = d.unread?.counts((k) => k === desk || (k.startsWith("milestone:") && ids.has(k.slice("milestone:".length))));
    const milestones: Record<string, MilestoneCounts> = {};
    const at = (id: string) => (milestones[id] ??= {});
    for (const m of st.milestones) if (ids.has(m.milestoneId) && (m.loading || m.needsYou === null || m.needsYou > 0)) at(m.milestoneId).needsYou = m.loading ? null : m.needsYou;
    for (const r of reviews) if (r.milestoneId && ids.has(r.milestoneId)) at(r.milestoneId).review = (milestones[r.milestoneId]?.review ?? 0) + 1;
    for (const id of ids) {
      const n = unread?.byKey[milestoneKey(id)];
      if (n) at(id).chat = n;
    }
    return c.json({
      needsYou: st.loading ? null : st.needsYou,
      review: reviews.length,
      chat: unread?.ready ? (unread.byKey[desk] ?? 0) : null,
      milestones,
      ...(st.asOf ? { asOf: st.asOf } : {}),
    });
  });

  // the owner opened a chat (the Chat page, a milestone's Chat tab): its unread goes to 0. Never a persona run (reading a chat
  // through the API is not the owner reading it). The milestone must be the caller's world's (else 404, as everywhere).
  api.post("/chat/seen", async (c) => {
    if (c.req.header("x-console-run") || c.req.header("x-run-id")) return c.json({ error: { code: "jordi_only", message: `a persona run does not mark ${ownerName()}'s chat as read` } }, 403);
    const p = seenIn.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: { code: "validation_error", message: 'body is {"chat":"desk"} or {"chat":"milestone","id":"<milestone id>"}' } }, 400);
    if (p.data.chat === "milestone" && !d.store.getMilestone(p.data.id)) return c.json({ error: { code: "not_found", message: `no milestone ${p.data.id}` } }, 404);
    if (!d.unread) return c.json({ error: { code: "unavailable", message: "the console has no T3 connection, so no chat to mark" } }, 503);
    const key = p.data.chat === "desk" ? deskKeyOf(d.store.tenant ?? DEFAULT_TENANT) : milestoneKey(p.data.id);
    return c.json(await d.unread.markSeen(key));
  });
}
