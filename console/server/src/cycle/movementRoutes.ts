import type { Hono } from "hono";
import type { Seat } from "../adapters/seats.js";
import type { Tree } from "../adapters/tree.js";
import { claimsFor } from "../desk/dispatch.js";
import type { WaitingItem } from "../inbox/waiting.js";
import type { Milestone, Run, Store } from "../store.js";
import {
  epicWaits,
  epicsOf,
  isGoing,
  managerOf,
  movingEpics,
  movingLimit,
  dedupeMoving,
  sortMoving,
  spineActivity,
  stallNote,
  stallVerdict,
  STALL_WATCH_BY,
  type MovingEpic,
  type StallEval,
} from "./movement.js";

/**
 * GET /api/moving-now (the Team page strip), GET /api/stall-watch (dry evaluation: which epics would fire and
 * why the others do not) and the stall watch's tick. The tick fires real Run nows only when `enabled`
 * (CONSOLE_STALL_WATCH=on); otherwise it never runs and the dry list is the whole feature.
 */
export interface MovementDeps {
  store: Store;
  treeFor: (m: Milestone) => Promise<Tree>;
  /** Checkout dir of the milestone's repo; undefined when not cloned here. */
  repoDir: (m: Milestone) => string | undefined;
  seats: () => Seat[] | undefined;
  /** the milestone's waiting items (waitingOnJordi, with `referencedBy`): the stall watch names the open ask an idle epic waits on. */
  waiting?: (m: Milestone) => Promise<WaitingItem[]>;
  /** Run now of an assignment with a note (cycle.runNowRequest); undefined = no cycle (tests, read-only consoles). */
  runNow?: (assignmentId: string, note: string) => Promise<Run & { startGuard?: string }>;
  /** why the stall watch waits now (priority mode on); undefined = it may fire. */
  paused?: () => string | undefined;
  enabled: boolean;
  /** effort follows priority: the pursuit carrying an epic (repo, spine path); null = in no pursuit. */
  effortFor?: (repo: string, path: string) => { parked: boolean; stallHours: number; pursuitName: string } | null;
  activity?: ReturnType<typeof spineActivity>;
  /**
   * GET /moving-now answers one world's strip from a build at most this old (ms; 0 = build per request, as
   * before), and requests meanwhile share the build in flight. The strip was ~260 ms of CPU per request and every open
   * tab polls it every 30 s (8 tabs on the owner's Mac: one build every ~4 s, more after a restart). `clock` is its clock.
   */
  memoMs?: number;
  clock?: () => number;
  now?: () => number;
  log?: (msg: string) => void;
}

export function createMovement(d: MovementDeps) {
  const activity = d.activity ?? spineActivity();
  const now = d.now ?? Date.now;
  const personaName = (id: string) => d.store.getPersona(id)?.name;
  const effortOf = (repo: string, p: string) => {
    try {
      return d.effortFor?.(repo, p) ?? null;
    } catch {
      return null;
    }
  };

  async function movingOf(m: Milestone): Promise<MovingEpic[]> {
    if (!m.path) return [];
    const tree = await d.treeFor(m);
    if (tree.source === "fallback" && tree.root.status === "unknown") return [];
    const epics = epicsOf(tree);
    const dir = d.repoDir(m);
    const act: Record<string, { lastCommitAt?: string; doneToday: string[] }> = {};
    if (dir) await Promise.all(epics.map(async (e) => (act[e.path] = await activity(dir, e.path, now()))));
    return movingEpics(m, epics, claimsFor(d.store, m), act);
  }

  const milestones = () => d.store.listMilestones().filter((m) => !m.settledAt && m.path);

  /** Every spine once (dedupeMoving), workers first then most recent commit. */
  async function build(): Promise<MovingEpic[]> {
    const ms = milestones();
    const all = await Promise.all(ms.map((m) => movingOf(m).catch(() => [] as MovingEpic[])));
    return sortMoving(dedupeMoving(all.flat(), ms));
  }
  const clock = d.clock ?? Date.now;
  const built = new Map<string, { at: number; p: Promise<MovingEpic[]> }>(); // per world (the store is request-scoped)
  async function moving(): Promise<MovingEpic[]> {
    const memoMs = d.memoMs ?? 0;
    if (memoMs <= 0) return build();
    const k = d.store.tenant ?? "";
    const hit = built.get(k);
    if (hit && clock() - hit.at < memoMs) return hit.p;
    const p = build();
    built.set(k, { at: clock(), p });
    p.catch(() => built.get(k)?.p === p && built.delete(k));
    return p;
  }

  async function evaluate(): Promise<StallEval[]> {
    const seats = d.seats();
    const t = now();
    const out: StallEval[] = [];
    for (const m of milestones()) {
      const epics = await movingOf(m).catch(() => [] as MovingEpic[]);
      if (!epics.length) continue;
      const manager = managerOf(d.store.listAssignments({ milestoneId: m.id }), personaName);
      const runs = d.store.listRuns({ milestoneId: m.id, limit: 300 });
      // only an epic that cannot move needs its waits (one waiting read per milestone, skipped when every epic can)
      const stuck = epics.some((e) => !e.ready.length || !isGoing(e.status));
      const waits = stuck && d.waiting ? await Promise.all([d.treeFor(m), d.waiting(m)]).then(([tree, items]) => epicWaits(m, tree, items)).catch(() => ({}) as ReturnType<typeof epicWaits>) : ({} as ReturnType<typeof epicWaits>);
      for (const epic of epics)
        out.push(stallVerdict({ milestone: m, epic, manager, managerName: manager && personaName(manager.personaId), runs, seats, waits: waits[epic.path], effort: effortOf(m.repo, epic.path) }, t));
    }
    return out;
  }

  /** One pass: one Run now per milestone, its note naming every epic that fires. Returns what it fired. */
  async function tick(): Promise<{ fired: { assignmentId: string; runId?: string; epics: string[]; queued?: boolean; error?: string }[] }> {
    const fired: { assignmentId: string; runId?: string; epics: string[]; queued?: boolean; error?: string }[] = [];
    if (!d.enabled || !d.runNow) return { fired };
    const pause = d.paused?.();
    if (pause) {
      d.log?.(`stall watch: paused (${pause})`);
      return { fired };
    }
    const byManager = new Map<string, StallEval[]>();
    for (const e of await evaluate()) if (e.verdict === "fire" && e.assignmentId) byManager.set(e.assignmentId, [...(byManager.get(e.assignmentId) ?? []), e]);
    for (const [assignmentId, fires] of byManager) {
      try {
        const run = await d.runNow(assignmentId, stallNote(fires));
        // a wake still running gets the note queued (startGuard "queued"), never a second wake
        const queued = run.startGuard === "queued" || run.startGuard === "held" || run.startGuard === "handled";
        fired.push({ assignmentId, runId: run.id, epics: fires.map((f) => f.path), ...(queued ? { queued } : {}) });
        d.log?.(`stall watch: ${queued ? "note queued into running" : "Run now"} ${assignmentId} → ${run.id} (${fires.map((f) => f.path).join(", ")})`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        fired.push({ assignmentId, epics: fires.map((f) => f.path), error });
        d.log?.(`stall watch: Run now ${assignmentId} failed: ${error}`);
      }
    }
    return { fired };
  }

  function mount(api: Hono) {
    // `?limit=20|50|all` (no limit = all): the first n lines and the total, so the Team home's Show 20 / 50 /
    // all gets only what it shows. The git side is one batch per repo and cached per HEAD, so it is the
    // payload and the page, not the git work, that the limit cuts.
    api.get("/moving-now", async (c) => {
      const all = await moving();
      const limit = movingLimit(c.req.query("limit"));
      return c.json({ epics: limit ? all.slice(0, limit) : all, total: all.length, at: new Date(now()).toISOString() });
    });
    api.get("/stall-watch", async (c) =>
      c.json({ enabled: d.enabled, by: STALL_WATCH_BY, epics: await evaluate(), at: new Date(now()).toISOString() }),
    );
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function start(everyMs: number) {
    if (!d.enabled || !d.runNow || timer || everyMs <= 0) return;
    timer = setInterval(() => void tick().catch((e) => d.log?.(`stall watch tick: ${e instanceof Error ? e.message : e}`)), everyMs);
    timer.unref();
  }

  return { moving, evaluate, tick, mount, start, stop: () => timer && clearInterval(timer) };
}
