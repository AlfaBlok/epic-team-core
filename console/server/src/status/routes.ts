import type { Hono } from "hono";
import type { DB } from "../db.js";
import type { Milestone, Store } from "../store.js";
import type { Outcome } from "../adapters/spines.js";
import type { MonitorItem } from "../adapters/monitoring.js";
import { statusWordOf, walkOwn, type Tree, type TreeNode } from "../adapters/tree.js";
import { doneMeansCount } from "../adapters/outcome.js";
import type { RefDefect, WaitingItem } from "../inbox/waiting.js";
import { byMilestonePriority, milestoneRanks } from "../inbox/priority.js";
import type { PriorityLookup } from "../inbox/jordiPriority.js";
import { answeredInSpine } from "../inbox/answered.js";
import { alertReasons, askRefs, type AskRef, type ResolvedAsk } from "./monitorAlert.js";
import { milestoneStatus, paintTree, type MilestoneStatus, type PendingItem } from "./compute.js";
import type { ReadModelHost } from "../readModel/host.js";
import { computeStatus, type ViewKey } from "../readModel/views.js";
import { sameRepo } from "../adapters/repoNames.js";

/** What the status routes read; app.ts wires them to its own helpers (withOutcome, treeFor, waitingOnJordi, cycle). */
export interface StatusDeps {
  db: DB;
  store: Store;
  /** The milestone with its derived fields (status, monitoring, outcome, doctrine Done means, DoD). */
  milestoneInfo: (m: Milestone, softMs: number) => Promise<{
    status?: string;
    monitoring?: MonitorItem[];
    outcome?: Outcome | null;
    doctrine?: { doneMeans?: { done: boolean }[] };
    dod?: { done: number; total: number; tracked?: boolean };
  }>;
  treeFor: (m: Milestone) => Promise<Tree>;
  /** with the unresolved references (defects) when the wiring has them; a bare list reads as none. */
  waiting: (f: { milestoneId?: string; includeSettled?: boolean; world?: string }) => Promise<WaitingItem[] | { items: WaitingItem[]; defects: RefDefect[] }>;
  t3State?: (runId: string) => { status: string; checkedAt: string } | undefined;
  /**
   * a milestone with no persona of its own whose spine sits in another milestone's tree (a big root such as
   * under the code repo's root) is worked by that milestone's personas: the host milestone, else undefined.
   */
  coverOf?: (m: Milestone) => Promise<Milestone | undefined>;
  /**
   * spine reads that ran out of time with nothing read yet (a cold console after a restart). `mark` is taken
   * before a request reads; `missed(m, mark)` is true when a spine `m`'s items come from (its world's repos) was such a
   * read since: that status is loading, never a number built from the bare doc parse (it read 0 where the truth was 11).
   */
  cold?: { mark: () => number; missed: (m: Milestone, mark: number) => boolean };
  /** resolve the ask codes a stopped / overdue monitor item names (any repo, any world: monitorAlert.askLookupIn). */
  askLookup?: (from: Milestone, refs: AskRef[]) => Promise<Map<string, ResolvedAsk>>;
  /** the owner's levels from the repo (the Prioritizer's docs/priorities.json): the Team list sorts by them first. */
  priorities?: () => PriorityLookup | undefined;
  now?: () => number;
}

/** a status whose spines were not read yet: no items and no number (the web draws no badge), `loading` set. */
export type StatusView = Omit<MilestoneStatus, "needsYou"> & { needsYou: number | null; loading?: true };

/**
 * the milestone (same repo and world, with personas of its own) whose tree holds `m`'s spine below its root,
 * e.g. the code repo's root for the big root; undefined when none does.
 */
export const coverOfIn = (store: Store, treeFor: (m: Milestone) => Promise<Tree>) => async (m: Milestone): Promise<Milestone | undefined> => {
  const world = store.worldOfMilestone?.(m.id);
  const hosts = store
    .listMilestones({})
    .filter((h) => h.id !== m.id && sameRepo(h.repo, m.repo) && store.worldOfMilestone?.(h.id) === world && store.listAssignments({ milestoneId: h.id }).length > 0);
  const has = (n: TreeNode): boolean => n.children.some((c) => (c.kind === "spine" && c.path === m.path) || has(c));
  for (const h of hosts) {
    const t = await treeFor(h).catch(() => undefined);
    if (t && has(t.root)) return h;
  }
  return undefined;
};

/** waiting item ids the spine shows answered (inbox/answered.ts); never read from console.db. */
export const respondedIds = (items: WaitingItem[]): Set<string> => answeredInSpine(items);

/** Items of one milestone out of a list spanning milestones: its own, and the asks it references. */
const itemsOf = (all: WaitingItem[], id: string) => all.filter((w) => w.milestoneId === id || w.alsoIn?.includes(id) || w.referencedBy?.some((r) => r.milestoneId === id));

const waitingOf = async (p: ReturnType<StatusDeps["waiting"]>): Promise<{ items: WaitingItem[]; defects: RefDefect[] }> => {
  const r = await p;
  return Array.isArray(r) ? { items: r, defects: [] } : r;
};

export function createStatus(d: StatusDeps) {
  const now = d.now ?? Date.now;
  const statusOf = async (m: Milestone, w: { items: WaitingItem[]; defects: RefDefect[] }, responded: Set<string>, softMs: number): Promise<MilestoneStatus & { tree?: Tree }> => {
    const waiting = w.items;
    const [info, tree] = await Promise.all([d.milestoneInfo(m, softMs), d.treeFor(m).catch(() => undefined)]);
    let assignments = d.store.listAssignments({ milestoneId: m.id });
    if (!assignments.length && d.coverOf) {
      const host = await d.coverOf(m).catch(() => undefined);
      // The host's personas count as this milestone's own (same wakes, same runs), so it reads Working / Queued, not Stalled.
      if (host) assignments = d.store.listAssignments({ milestoneId: host.id }).map((a) => ({ ...a, milestoneId: m.id }));
    }
    const runs = assignments.flatMap((a) => d.store.listRuns({ assignmentId: a.id, limit: 200 }));
    const t = now();
    const refs = (info.monitoring ?? []).filter((x) => alertReasons(x, t).why.length).flatMap(askRefs);
    const monitorAsks = refs.length && d.askLookup ? await d.askLookup(m, refs).catch(() => undefined) : undefined;
    const st = milestoneStatus({
      milestone: m,
      status: info.status,
      monitoring: info.monitoring,
      ...(monitorAsks ? { monitorAsks } : {}),
      outcome: info.outcome,
      doneMeans: doneMeansCount({ dod: info.dod, doneMeans: info.doctrine?.doneMeans }),
      tree,
      waiting: itemsOf(waiting, m.id),
      defects: w.defects.filter((x) => x.milestoneId === m.id),
      responded,
      runs,
      assignments,
      personaName: (id) => d.store.getPersona(id)?.name,
      ...(d.t3State ? { t3State: d.t3State } : {}),
      now: t,
    });
    return { ...st, ...(tree ? { tree } : {}) };
  };

  const loadingOr = (m: Milestone, mark: number, st: MilestoneStatus): StatusView =>
    d.cold?.missed(m, mark) ? { ...st, items: [], needsYou: null, loading: true } : st;

  /** One milestone's status. */
  const one = async (m: Milestone): Promise<StatusView> => {
    const mark = d.cold?.mark() ?? 0;
    const w = await waitingOf(d.waiting({ milestoneId: m.id }));
    const { tree: _t, ...st } = await statusOf(m, w, respondedIds(w.items), 4_000);
    return loadingOr(m, mark, st);
  };

  /** Every unsettled milestone (or all), one batch: one waiting read, short spines wait. `needsYou` counts unique open items. */
  const all = async (o: { includeSettled?: boolean } = {}) => {
    const ms = d.store.listMilestones({ includeSettled: !!o.includeSettled });
    const mark = d.cold?.mark() ?? 0;
    // one waiting read per world, resolved as the milestone page's own read is, so the sidebar badge, the page
    // banner and its tabs show the same number (a reference across worlds never adds an item on one side only).
    const worlds = new Map<string, ReturnType<typeof waitingOf>>();
    const worldOf = (m: Milestone) => d.store.worldOfMilestone?.(m.id) ?? "";
    const waitingIn = (w: string) => {
      if (!worlds.has(w)) worlds.set(w, waitingOf(d.waiting({ includeSettled: !!o.includeSettled, ...(w ? { world: w } : {}) })));
      return worlds.get(w)!;
    };
    const milestones = await Promise.all(
      ms.map(async (m) => {
        const w = await waitingIn(worldOf(m));
        const { tree: _t, ...st } = await statusOf(m, w, respondedIds(w.items), 1_500);
        return loadingOr(m, mark, st);
      }),
    );
    // a milestone still loading has no items yet, so the Team badge would be low: no number until it has one.
    const loading = milestones.some((st) => st.loading);
    // The Team badge counts each item once by id: an item of a spine two milestones track (the code repo's tree holds
    // its own milestone too) is on both milestones' screens and in both counts, but one thing for the owner.
    // items follow milestone priority (sidebar order); a shared item ranks with the best milestone listing it.
    const unique = new Map<string, PendingItem>();
    const alsoIn = new Map<string, string[]>();
    for (const st of milestones)
      for (const it of st.items) {
        if (!unique.has(it.id)) unique.set(it.id, it);
        alsoIn.set(it.id, [...(alsoIn.get(it.id) ?? []), st.milestoneId]);
      }
    const ranks = milestoneRanks(d.store.listMilestones({ includeSettled: true }));
    // the owner's level first; the item's row and spine come from its waiting item (same id).
    const where = new Map<string, WaitingItem>();
    for (const w of worlds.values()) for (const it of (await w).items) if (!where.has(it.id)) where.set(it.id, it);
    const locate = (it: PendingItem) => {
      const w = where.get(it.id);
      return { repo: it.repo ?? w?.repo, path: it.path ?? w?.path, row: w?.row, code: it.code ?? w?.code };
    };
    const items = byMilestonePriority(
      [...unique.values()].map((it) => ({ it, alsoIn: alsoIn.get(it.id), milestoneId: it.milestoneId, ...locate(it) })),
      ranks,
      d.priorities?.(),
    ).map(({ it, priority, ownerPriority }) => (priority ? { ...it, priority, ...(ownerPriority ? { ownerPriority } : {}) } : it));
    return { milestones, items, needsYou: loading ? null : items.filter((i) => i.state === "open").length, ...(loading ? { loading: true as const } : {}), at: new Date(now()).toISOString() };
  };

  /**
   * what the next standing wake will start: per milestone with an enabled, scheduled
   * persona and a runnable spine, the epic itself when stamped ready (not started yet) and its own ready rows / ready
   * child epics (root-only rows: a child's rows are listed under the child's own milestone). Sorted by wake time.
   */
  const nextWake = async (o: { milestoneId?: string } = {}): Promise<{ items: NextWakeItem[]; at: string }> => {
    const ms = d.store.listMilestones({}).filter((m) => !m.paused && (!o.milestoneId || m.id === o.milestoneId));
    const lists = await Promise.all(
      ms.map(async (m) => {
        const sched = d.store
          .listAssignments({ milestoneId: m.id })
          .filter((a) => a.enabled && !a.parkedAt && !!(a.nextWakeAt ?? a.nextRunAt))
          .sort((a, b) => (a.nextWakeAt ?? a.nextRunAt)!.localeCompare((b.nextWakeAt ?? b.nextRunAt)!));
        if (!sched.length) return [];
        const tree = await d.treeFor(m).catch(() => undefined);
        if (!tree || tree.source === "fallback") return [];
        const root = tree.root;
        const rs = root.runState;
        if (rs ? rs !== "ready" && rs !== "running" : !/^\W*(ready|active|blocked)\b/i.test(root.status)) return [];
        const persona = d.store.getPersona(sched[0].personaId)?.name ?? sched[0].personaId;
        const at = (sched[0].nextWakeAt ?? sched[0].nextRunAt)!;
        const base = { milestoneId: m.id, milestoneTitle: m.title, persona, at };
        const out: NextWakeItem[] = [];
        if (rs ? rs === "ready" : statusWordOf(root.status) === "ready") out.push({ ...base, kind: "epic", id: root.id, title: root.title, nodeKey: root.key, ...(root.path ? { path: root.path } : {}) });
        walkOwn(root, (n: TreeNode) => {
          if (n === root || !n.ready) return;
          out.push({ ...base, kind: n.kind === "spine" ? "epic" : "row", id: n.id, title: n.title, nodeKey: n.key, ...(n.path ? { path: n.path } : {}) });
        });
        return out;
      }),
    );
    return { items: lists.flat().sort((a, b) => a.at.localeCompare(b.at) || a.milestoneTitle.localeCompare(b.milestoneTitle)), at: new Date(now()).toISOString() };
  };

  /** The milestone's tree painted from its pending items (3b): Tree red count = open items (Ready to mark too). */
  const paintedTree = async (m: Milestone, tree: Tree) => {
    const st = await one(m);
    return paintTree(tree, st.items, st.defects);
  };

  return { one, all, paintedTree, nextWake };
}

/** one line of "Next wake picks up". */
export interface NextWakeItem {
  milestoneId: string;
  milestoneTitle: string;
  kind: "epic" | "row";
  id: string;
  title: string;
  nodeKey: string;
  path?: string;
  /** The persona whose next wake starts it, and when. */
  persona: string;
  at: string;
}

export type StatusService = ReturnType<typeof createStatus>;

/**
 * with a read model, /status and /milestones/:id/status answer from the stored view (computed off the request
 * path, kept across restarts) plus `asOf`: when it was last known current. Without one, computed per request as before.
 */
/** the world's open status rows as GET /status gives them (the stored view when there is one); the Inbox search reads them. */
export async function statusRows(s: StatusService, store: Store, readModel?: ReadModelHost): Promise<{ items: unknown[] }> {
  if (!readModel) return (await s.all({ includeSettled: false })) as unknown as { items: unknown[] };
  const k: Extract<ViewKey, { kind: "status" }> = { kind: "status", world: store.tenant ?? "", includeSettled: false };
  const v = await readModel.view(k, () => computeStatus(s, store, k) as ReturnType<StatusService["all"]>);
  return (v.payload ?? { items: [] }) as unknown as { items: unknown[] };
}

export function mountStatus(api: Hono, s: StatusService, store: Store, readModel?: ReadModelHost) {
  api.get("/status", async (c) => {
    const includeSettled = ["true", "1"].includes(c.req.query("includeSettled") ?? "");
    if (!readModel) return c.json(await s.all({ includeSettled }));
    const k: Extract<ViewKey, { kind: "status" }> = { kind: "status", world: store.tenant ?? "", includeSettled };
    const v = await readModel.view(k, () => computeStatus(s, store, k) as ReturnType<StatusService["all"]>);
    return c.json({ ...v.payload, asOf: v.asOf });
  });
  api.get("/next-wake", async (c) => c.json(await s.nextWake({ milestoneId: c.req.query("milestoneId") || undefined })));
  api.get("/milestones/:id/status", async (c) => {
    const m = store.getMilestone(c.req.param("id"));
    if (!m) return c.json({ error: { code: "not_found", message: `milestone ${c.req.param("id")} not found` } }, 404);
    if (!readModel) return c.json(await s.one(m));
    const k: Extract<ViewKey, { kind: "status-one" }> = { kind: "status-one", world: store.tenant ?? "", milestoneId: m.id };
    const v = await readModel.view(k, () => s.one(m));
    return c.json({ ...v.payload, asOf: v.asOf });
  });
}
