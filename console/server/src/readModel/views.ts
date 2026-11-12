import type { Store } from "../store.js";
import { listRepos } from "../adapters/repos.js";
import { adhocMilestone } from "../routes/spines.js";
import { waitingAndDefects, waitingForMilestone, type RefDefect, type WaitingDeps, type WaitingItem } from "../inbox/waiting.js";
import type { StatusService, StatusView } from "../status/routes.js";
import type { PendingItem } from "../status/compute.js";
import type { Asker } from "../inbox/asker.js";
import { snoozedNow } from "../inbox/asks.js";
import type { ReviewPayload } from "../review/rows.js";
import { alertNext, alertSnoozedUntil, alertState, type ResolvedAsk } from "../status/monitorAlert.js";

/**
 * the views the read model keeps (one console.db row each) and how each is computed. The same functions run in
 * the refresher (worker thread) and, only when a view has no row yet, inline on the request.
 *
 * `world` is the store scope the view was read under (the caller's world with CONSOLE_AUTH=on, "" = unscoped).
 */
export type ViewKey =
  /** GET /waiting-on-owner (global, or ?milestoneId): every item, superseded ones too; nodeKey and includeSuperseded filter on read. */
  | { kind: "waiting"; world: string; milestoneId?: string; includeSettled: boolean }
  /** GET /waiting-on-owner?repo=&path= (an untracked spine). */
  | { kind: "adhoc"; world: string; repo: string; path: string; title?: string }
  /** GET /status. */
  | { kind: "status"; world: string; includeSettled: boolean }
  /** GET /milestones/:id/status. */
  | { kind: "status-one"; world: string; milestoneId: string }
  /** GET /review-items: every spine ledger row in `review` across the world's milestone repos (review/rows.ts). */
  | { kind: "review"; world: string };

export const keyOf = (k: ViewKey): string => {
  switch (k.kind) {
    case "waiting":
      return JSON.stringify(["waiting", k.world, k.milestoneId ?? "", k.includeSettled ? 1 : 0]);
    case "adhoc":
      return JSON.stringify(["adhoc", k.world, k.repo, k.path, k.title ?? ""]);
    case "status":
      return JSON.stringify(["status", k.world, k.includeSettled ? 1 : 0]);
    case "status-one":
      return JSON.stringify(["status-one", k.world, k.milestoneId]);
    case "review":
      return JSON.stringify(["review", k.world]);
  }
};

export function parseKey(s: string): ViewKey | undefined {
  try {
    const a = JSON.parse(s) as unknown[];
    if (!Array.isArray(a) || typeof a[1] !== "string") return undefined;
    const world = a[1];
    if (a[0] === "waiting") return { kind: "waiting", world, ...(a[2] ? { milestoneId: String(a[2]) } : {}), includeSettled: a[3] === 1 };
    if (a[0] === "adhoc") return { kind: "adhoc", world, repo: String(a[2]), path: String(a[3]), ...(a[4] ? { title: String(a[4]) } : {}) };
    if (a[0] === "status") return { kind: "status", world, includeSettled: a[2] === 1 };
    if (a[0] === "status-one") return { kind: "status-one", world, milestoneId: String(a[2]) };
    if (a[0] === "review") return { kind: "review", world };
  } catch {
    /* not a key */
  }
  return undefined;
}

/** What a waiting view stores: every item (superseded included), the defects, and the milestones the view was scoped to. */
export interface WaitingPayload {
  items: WaitingItem[];
  defects: RefDefect[];
  /** Milestones in the view's scope (`waitingAndDefects` `scoped`): the nodeKey filter needs them. */
  scopedIds: string[];
  /**
   * asker per item id (null = none), worked out by the refresher: it reads `git blame` of the ask line, which must
   * not run on the request. Items missing here (an inline answer) are worked out on the request as before.
   */
  askers?: Record<string, Asker | null>;
}

/** Items whose card names who an answer wakes (GET /waiting-on-owner adds `asker` to these). */
export const wantsAsker = (it: Pick<WaitingItem, "state" | "decidedBy">) => it.state === "open" || it.state === "answered" || !!it.decidedBy;

export async function computeWaiting(
  deps: WaitingDeps,
  k: Extract<ViewKey, { kind: "waiting" }>,
  askerOf?: (it: WaitingItem) => Promise<Asker | undefined>,
): Promise<WaitingPayload> {
  const r = await waitingAndDefects(deps, { ...(k.milestoneId ? { milestoneId: k.milestoneId } : {}), includeSettled: k.includeSettled, includeSuperseded: true });
  const scopedIds = k.milestoneId
    ? [k.milestoneId]
    : deps.store
        .listMilestones({ includeSettled: true })
        .filter((m) => k.includeSettled || !m.settledAt)
        .map((m) => m.id);
  if (!askerOf) return { items: r.items, defects: r.defects, scopedIds };
  const askers: Record<string, Asker | null> = {};
  for (const it of r.items) if (wantsAsker(it)) askers[it.id] = (await askerOf(it).catch(() => undefined)) ?? null;
  return { items: r.items, defects: r.defects, scopedIds, askers };
}

/**
 * a stored view is recomputed when its spines change, not when a snooze runs out: an item whose snooze has
 * passed (a 3 hour one, or a day that came) is shown as open again at read time.
 */
export function expireSnoozes(items: WaitingItem[], now = Date.now()): WaitingItem[] {
  if (!items.some((i) => i.snoozedUntil && !snoozedNow(i.snoozedUntil, now))) return items;
  return items.map((i) => {
    if (!i.snoozedUntil || snoozedNow(i.snoozedUntil, now)) return i;
    const { snoozedUntil: _s, ...rest } = i;
    return rest as WaitingItem;
  });
}

/** The list GET /waiting-on-owner answers from a stored view: as `waitingAndDefects` with the same nodeKey / includeSuperseded. */
export function viewWaiting(p: WaitingPayload, f: { nodeKey?: string; includeSuperseded?: boolean }, now = Date.now()): WaitingItem[] {
  const all = expireSnoozes(p.items, now);
  const items = f.includeSuperseded ? all : all.filter((i) => i.state !== "superseded");
  if (!f.nodeKey) return items;
  const scoped = new Set(p.scopedIds);
  const ok = (key?: string) => key === f.nodeKey || !!key?.startsWith(f.nodeKey + "/");
  return items.filter((it) => {
    const mine = scoped.has(it.milestoneId) || !!it.alsoIn?.some((x) => scoped.has(x));
    return (mine && ok(it.nodeKey)) || (it.referencedBy ?? []).some((r) => scoped.has(r.milestoneId) && ok(r.nodeKey));
  });
}

export async function computeAdhoc(deps: WaitingDeps, k: Extract<ViewKey, { kind: "adhoc" }>): Promise<WaitingItem[] | null> {
  const repo = listRepos(deps.reposRoot).find((x) => x.name === k.repo);
  if (!repo) return null;
  return waitingForMilestone(deps, adhocMilestone(repo, k.path, k.title));
}

export const viewAdhoc = (items: WaitingItem[], nodeKey?: string, now = Date.now()) => expireSnoozes(items, now).filter((it) => !nodeKey || it.nodeKey === nodeKey || !!it.nodeKey?.startsWith(nodeKey + "/"));

export type StatusAllPayload = Awaited<ReturnType<StatusService["all"]>>;

export async function computeStatus(status: StatusService, store: Store, k: Extract<ViewKey, { kind: "status" | "status-one" }>): Promise<StatusAllPayload | StatusView | null> {
  if (k.kind === "status") return status.all({ includeSettled: k.includeSettled });
  const m = store.getMilestone(k.milestoneId);
  return m ? status.one(m) : null;
}

// ---------- optimistic edits after the owner acts (answer, snooze, supersede) ----------

/** One change the owner just made, applied to every stored view until the refresher has confirmed it from the spines. */
export type Patch =
  | { kind: "answered"; id: string }
  /** an unsnooze carries the ask as a pending item, so the status views count it again at once. */
  | { kind: "snoozed"; id: string; until: string | null; item?: PendingItem }
  | { kind: "superseded"; id: string; by?: string }
  /** the owner approved or relaunched a review row (closed: off the list), or snoozed / unsnoozed it. */
  | { kind: "review"; id: string; op: "closed" }
  | { kind: "review"; id: string; op: "snoozed"; until: string | null };

type AskPatch = Exclude<Patch, { kind: "review" }>;

/**
 * add the owner's latest change to the kept patches. A snooze or unsnooze replaces an earlier one for the same item:
 * an unsnooze otherwise left the snooze patch hiding the card from every count and list for its whole 5 min TTL.
 */
export function addPatch(patches: { at: number; p: Patch }[], p: Patch, at: number): { at: number; p: Patch }[] {
  const kept = p.kind === "snoozed" || p.kind === "review" ? patches.filter((x) => !(x.p.kind === p.kind && x.p.id === p.id)) : patches;
  return [...kept, { at, p }];
}

const openCount = (items: PendingItem[]) => items.filter((i) => i.state === "open").length;

/**
 * a monitor alert naming the ask the owner just answered or snoozed (from its own card or the alert's) follows it at
 * once: snoozed = one quiet line out of the counts, unsnoozed = counted again, answered = the Delivery Manager's.
 */
function patchAlert(i: PendingItem, p: AskPatch): PendingItem {
  const m = i.monitor;
  if (i.kind !== "monitor_alert" || !m?.asks.some((a) => a.id === p.id) || p.kind === "superseded") return i;
  const asks = m.asks.map((a): ResolvedAsk => {
    if (a.id !== p.id || a.state !== "open") return a;
    if (p.kind === "answered") {
      const { card: _c, snoozedUntil: _s, ...rest } = a;
      return { ...rest, state: "answered" };
    }
    if (p.until) return { ...a, snoozedUntil: p.until };
    const { snoozedUntil: _s, ...rest } = a;
    return rest;
  });
  const state = alertState(asks);
  const until = state === "snoozed" ? alertSnoozedUntil(asks) : undefined;
  const { snoozedUntil: _u, ...base } = i;
  return { ...base, state, ...(until ? { snoozedUntil: until } : {}), monitor: { ...m, asks, next: alertNext({ what: i.title, why: m.why, asks }) } };
}

function patchPending(items: PendingItem[], p: AskPatch, milestoneId?: string): PendingItem[] {
  if (items.some((i) => i.kind === "monitor_alert" && i.monitor?.asks.some((a) => a.id === p.id))) items = items.map((i) => patchAlert(i, p));
  // an unsnoozed ask is open again in every status view that covers its milestone, before the refresher re-reads
  // the spine (before, only the page that unsnoozed it showed it, and every pill missed it until then).
  if (p.kind === "snoozed" && p.until === null && p.item && !items.some((i) => i.id === p.id) && (!milestoneId || milestoneId === p.item.milestoneId))
    return [...items, p.item];
  if (!items.some((i) => i.id === p.id)) return items;
  if (p.kind === "answered") return items.map((i) => (i.id === p.id && i.state === "open" ? { ...i, state: "answered" as const } : i));
  if (p.kind === "snoozed" && p.until === null) return items; // unsnooze: the refresher brings it back
  return items.filter((i) => i.id !== p.id);
}

function patchStatusView<T extends { milestoneId?: string; items: PendingItem[]; needsYou: number | null }>(st: T, p: AskPatch): T {
  const items = patchPending(st.items, p, st.milestoneId ?? "");
  if (items === st.items) return st;
  return { ...st, items, needsYou: st.needsYou === null ? null : openCount(items) };
}

function patchItems(items: WaitingItem[], p: AskPatch): WaitingItem[] {
  if (!items.some((i) => i.id === p.id)) return items;
  return items.map((i) => {
    if (i.id !== p.id) return i;
    if (p.kind === "answered") return i.state === "open" ? { ...i, state: "answered" as const } : i;
    if (p.kind === "superseded") return i.state === "open" ? { ...i, state: "superseded" as const, supersededBy: p.by ?? "moot", decidable: false } : i;
    if (p.until) return { ...i, snoozedUntil: p.until };
    const { snoozedUntil: _s, ...rest } = i;
    return rest as WaitingItem;
  });
}

/** A stored view with the owner's latest changes applied (unchanged object when none applies). */
export function applyPatch(k: ViewKey, payload: unknown, p: Patch): unknown {
  if (!payload) return payload;
  if (k.kind === "review" || p.kind === "review") return k.kind === "review" && p.kind === "review" ? patchReview(payload as ReviewPayload, p) : payload;
  switch (k.kind) {
    case "waiting": {
      const w = payload as WaitingPayload;
      const items = patchItems(w.items, p);
      return items === w.items ? w : { ...w, items };
    }
    case "adhoc": {
      const items = patchItems(payload as WaitingItem[], p);
      return items;
    }
    case "status-one":
      return patchStatusView(payload as StatusView, p);
    case "status": {
      const s = payload as StatusAllPayload;
      const milestones = s.milestones.map((m) => patchStatusView(m, p));
      const items = patchPending(s.items, p);
      if (items === s.items && milestones.every((m, n) => m === s.milestones[n])) return s;
      return { ...s, milestones, items, needsYou: s.needsYou === null ? null : openCount(items) };
    }
  }
}

/** a review row the owner just acted on, until the refresher has re-read its spine. */
function patchReview(p: ReviewPayload, x: Extract<Patch, { kind: "review" }>): ReviewPayload {
  if (!p.rows.some((r) => r.id === x.id)) return p;
  if (x.op === "closed") return { ...p, rows: p.rows.filter((r) => r.id !== x.id) };
  return {
    ...p,
    rows: p.rows.map((r) => {
      if (r.id !== x.id) return r;
      const { snoozedUntil: _s, ...rest } = r;
      return x.until ? { ...rest, snoozedUntil: x.until } : rest;
    }),
  };
}
