import path from "node:path";
import type { Context, Hono, Next } from "hono";
import type { Milestone, Store } from "../store.js";
import { chatCaller } from "./milestoneChat.js";

/**
 * a milestone chat acts only from its milestone's epic downward. Every call it makes carries
 * `X-Console-Run: milestone-chat:<id>` (`chatCaller`); Run now, Steer, Stop, Add and ticket detail are accepted only when the
 * target (an assignment, a run, a spine) sits in that milestone's subtree: the milestone's own spine and every spine below it in
 * the same checkout, so a lower milestone of the same repo is inside a root milestone's scope. Anything else is 403
 * `out_of_scope`, naming the milestone chat (or the Team desk) to use instead. Ask answers check the same scope in the respond
 * route (`covers` on the item). Marks and stamps stay refused for every chat by their own guards.
 */
export interface ChatScopeDeps {
  store: Store;
  publicUrl: string;
  /** The milestone's checkout and its spine path inside it. */
  locate: (m: Milestone) => Promise<{ repoDir?: string; rel?: string }>;
  /** Spine paths of the milestone's tree (its own spine and every child spine). */
  treePaths: (m: Milestone) => Promise<Set<string>>;
}

const clean = (p: string) => p.replace(/^\.\//, "");

export function createChatScope(d: ChatScopeDeps) {
  const base = d.publicUrl.replace(/\/+$/, "");
  const chatLink = (m: Milestone) => `the milestone chat of "${m.title}" (${base}/milestones/${m.id})`;

  /** Is the target (a milestone, optionally one spine path in its checkout) inside the caller milestone's subtree? */
  async function covers(caller: Milestone, target: Milestone, targetPath?: string): Promise<boolean> {
    if (caller.id === target.id && !targetPath) return true;
    const [c, t] = await Promise.all([d.locate(caller).catch(() => ({}) as { repoDir?: string; rel?: string }), d.locate(target).catch(() => ({}) as { repoDir?: string; rel?: string })]);
    if (!c.repoDir || !c.rel || !t.repoDir || path.resolve(c.repoDir) !== path.resolve(t.repoDir)) return false;
    const p = clean(targetPath ?? t.rel ?? "");
    if (!p) return false;
    if (p === clean(c.rel)) return true;
    return (await d.treePaths(caller).catch(() => new Set<string>())).has(p);
  }

  /** Why the caller may not act on the target, or undefined when it may. */
  async function refusal(callerId: string, target: Milestone | undefined, targetPath?: string): Promise<string | undefined> {
    const caller = d.store.getMilestone(callerId);
    if (!caller) return `this chat's milestone ${callerId} is not on the console: ask the Team desk (${base}/chat)`;
    if (target && (await covers(caller, target, targetPath))) return undefined;
    const where = target ? `${chatLink(target)}, or the Team desk (${base}/chat)` : `the Team desk (${base}/chat)`;
    return `outside "${caller.title}" and the epics below it: this chat acts only on its own subtree. Use ${where}.`;
  }

  return { covers, refusal, caller: chatCaller };
}

export type ChatScope = ReturnType<typeof createChatScope>;

/**
 * Mounted before the routes it guards (cycle run control, tree Add, ticket detail): only milestone-chat callers are checked, every
 * other caller passes untouched. A target the console does not know passes too, so the route answers its own 404.
 */
export function mountChatScope(api: Hono, d: ChatScopeDeps): ChatScope {
  const scope = createChatScope(d);
  const out = (c: Context, message: string) => c.json({ error: { code: "out_of_scope", message } }, 403);
  const guard = (target: (c: Context) => Promise<{ milestone?: Milestone; path?: string } | undefined>) => async (c: Context, next: Next) => {
    const callerId = chatCaller(c.req.header("x-console-run"));
    if (!callerId || c.req.method !== "POST") return next();
    const t = await target(c);
    if (!t) return next();
    const why = await scope.refusal(callerId, t.milestone, t.path);
    return why ? out(c, why) : next();
  };
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const ofAssignment = (id: string | undefined) => {
    const a = id ? d.store.getAssignment(id) : undefined;
    return a ? { milestone: d.store.getMilestone(a.milestoneId) } : undefined;
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  for (const p of ["/assignments/:id/run-now", "/assignments/:id/steer"]) api.use(p, guard(async (c) => ofAssignment(c.req.param("id"))));
  for (const p of ["/runs/:id/steer", "/runs/:id/stop"])
    api.use(
      p,
      guard(async (c) => {
        const r = d.store.getRun(c.req.param("id") ?? "");
        if (!r) return undefined;
        return r.milestoneId ? { milestone: d.store.getMilestone(r.milestoneId) } : ofAssignment(r.assignmentId);
      }),
    );
  api.use(
    "/milestones/:id/tree/add",
    guard(async (c) => {
      const m = d.store.getMilestone(c.req.param("id") ?? "");
      return m ? { milestone: m, path: str((await body(c)).path) } : undefined;
    }),
  );
  // a campaign chat renames, re-plans, retires or restores only campaigns in its own subtree (a repo's root chat: its campaigns).
  for (const p of ["/tenants/:id/campaigns/:mid/rename", "/tenants/:id/campaigns/:mid/plan", "/tenants/:id/campaigns/:mid/retire", "/tenants/:id/campaigns/:mid/restore"])
    api.use(
      p,
      guard(async (c) => {
        const m = d.store.getMilestone(c.req.param("mid") ?? "");
        return m ? { milestone: m } : undefined;
      }),
    );
  api.use(
    "/tickets/session",
    guard(async (c) => {
      const b = await body(c);
      const id = str(b.milestoneId);
      const m = id ? d.store.getMilestone(id) : undefined;
      return m ? { milestone: m, path: str(b.path) } : undefined;
    }),
  );
  return scope;
}
