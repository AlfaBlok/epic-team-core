import path from "node:path";
import type { DB } from "./db.js";
import type { Milestone, Store } from "./store.js";
import { locate } from "./adapters/milestone.js";
import { currentStateFor, doctrineFor, docTitleFor, dodFor, invalidateSpines, outcomeFor, softSpines, spinesSettled, type SpinesJson, type SpinesRunner } from "./adapters/spines.js";
import { deriveVerdict, lastCommitLookup } from "./adapters/outcome.js";
import { createTreeMemo, TREE_TTL_MS } from "./adapters/treeMemo.js";
import { buildTree, type Tree } from "./adapters/tree.js";
import { ownerOf } from "./tenancy/owner.js";
import { runStateFor } from "./cycle/runState.js";
import { deriveMilestone } from "./routes/read.js";
import { SETTLED_REASON } from "./cycle/service.js";

/**
 * The spine reads every milestone screen is built from (spines.py output, the tree, the derived Overview fields),
 * moved out of app.ts so the read-model worker builds them the same way off the request thread.
 */
export interface SpineReadsOptions {
  db: DB;
  store: Store;
  reposRoot: string;
  spines?: SpinesRunner;
  treeTtlMs?: number;
}

export function createSpineReads(o: SpineReadsOptions) {
  const { db, store } = o;
  // Derived fields are read from the milestone's spine/ticket file on each request (cached by mtime).
  const withDerived = (m: Milestone) => ({ ...m, ...deriveMilestone(o.reposRoot, m) });
  // Doctrine-2 Overview fields from spines.py --json (cached runner; omitted on any failure or miss).
  // One bounded-wait / last-good spines.py view per repo, shared by doctrine, outcome and the tree.
  const soft = o.spines ? softSpines(o.spines) : undefined;
  // a few seconds' memo per milestone tree + one shared in-flight build (see adapters/treeMemo.ts).
  const trees = createTreeMemo<Tree, SpinesJson>(o.treeTtlMs ?? (process.env.CONSOLE_TREE_TTL_MS ? Number(process.env.CONSOLE_TREE_TTL_MS) : TREE_TTL_MS));
  /**
   * A write to or pull of a checkout: drop its spines.py output and the memoized trees built from it. `stale`
   * (a pull): reads keep answering from the last output and trees while the new ones are built in the background; the
   * console's own write drops them (its writer's next read waits for the change).
   */
  const drop = (dir: string, d?: { stale?: boolean }) => {
    invalidateSpines(o.spines, dir, d);
    trees.invalidate(dir, d);
  };
  const spinesFor = async (m: Milestone, softMs = 4_000) => {
    const loc = m.path ? locate(o.reposRoot, m) : undefined;
    if (!loc || "error" in loc) return {};
    const rel = path.relative(loc.repo.path, loc.abs).split(path.sep).join("/");
    return { loc, rel, spines: soft ? await soft(loc.repo.path, softMs) : undefined };
  };
  const locateDir = (m: Milestone) => {
    const loc = m.path ? locate(o.reposRoot, m) : undefined;
    return loc && "repo" in loc ? loc.repo?.path : undefined;
  };
  /** epic tree; built from the doc parser alone when spines.py is missing, failing or slower than softMs. */
  const treeKey = (m: Milestone) => JSON.stringify([m, ownerOf(db, m.id)]); // the world's owner
  const treeFor = (m: Milestone, softMs = 4_000, pre?: SpinesJson): Promise<Tree> => {
    const owner = ownerOf(db, m.id);
    const load = async () => {
      const r = await spinesFor(m, softMs);
      return { spines: r.spines, dir: r.loc && "repo" in r.loc ? r.loc.repo.path : undefined };
    };
    return trees.get(
      JSON.stringify([m, owner]),
      pre ? () => ({ spines: pre, dir: locateDir(m) }) : load,
      (spines) => buildTree(o.reposRoot, m, spines, owner),
      !pre,
      // a stale tree (after a pull) is rebuilt from the spines.py run that pull queued, off the request.
      async () => {
        const dir = locateDir(m);
        if (dir) await spinesSettled(o.spines, dir);
        return load();
      },
    );
  };
  /**
   * after a pull of dir, rebuild its unsettled milestones' stale trees one after another once the post-pull
   * spines.py run is done (`order`: focus first), so the next read finds the new tree. One pass per dir at a time; a
   * pull during a pass queues one more.
   */
  const rewarming = new Map<string, { again: boolean }>();
  const rewarm = (dir: string, order: (ms: Milestone[]) => Milestone[] = (ms) => ms): Promise<void> => {
    const cur = rewarming.get(dir);
    if (cur) {
      cur.again = true;
      return Promise.resolve();
    }
    const st = { again: false };
    rewarming.set(dir, st);
    return (async () => {
      do {
        st.again = false;
        await spinesSettled(o.spines, dir);
        for (const m of order(store.listMilestones().filter((x) => !x.settledAt && locateDir(x) === dir))) {
          if (!trees.info(treeKey(m))?.stale) continue;
          await treeFor(m).catch(() => undefined);
          await trees.rebuilt(treeKey(m));
        }
      } while (st.again);
    })().finally(() => rewarming.delete(dir));
  };
  /** when the milestone's tree was built and whether a newer one is being built (undefined: none yet). */
  const treeInfo = (m: Milestone) => trees.info(treeKey(m));
  const docTitleOf = (spines: SpinesJson | undefined, rel: string | undefined, loc: { info: { title?: string } } | undefined) =>
    (spines && rel ? docTitleFor(spines, rel) : undefined) ?? loc?.info.title?.trim();
  const lastCommit = lastCommitLookup();
  /**
   * `outcome` (spine `## Outcome`, null when none or not shipped yet) and the derived `verdict`.
   * Also `remote` (owner/name) for GitHub links and `spineCommitAt` (last commit on the spine, for "updated … ago").
   */
  const withOutcome = async (m: Milestone, softMs = 4_000) => {
    const derived = withDerived(m);
    if (!m.path || derived.docError) return { ...derived, outcome: null, verdict: deriveVerdict(derived) };
    const { loc, rel, spines } = await spinesFor(m, softMs);
    // Milestone dod: the spines.py node's done_means, else dod; the markdown parse when spines.py has neither.
    const dod = (spines && rel && dodFor(spines, rel, derived.dod)) || derived.dod;
    const shape = derived.shape && { ...derived.shape, dod: derived.shape.dod || dod.items.length > 0 };
    // docTitle: the spine's own title (spines.py node, else the file's H1), shown instead of the stored one unless
    // Settings saved an explicit title (titleOverride); then it is only the Settings hint.
    const docTitle = docTitleOf(spines, rel, loc);
    const out = {
      ...derived,
      dod,
      ...(shape ? { shape } : {}),
      ...(docTitle && docTitle !== m.title ? { docTitle } : {}),
      ...(m.titleSetAt ? { titleOverride: true } : {}),
    };
    const doctrine = spines && rel ? doctrineFor(spines, rel) : undefined;
    const run = spines && rel ? runStateFor(spines, rel) : undefined; // Run now asks before waking a non-runnable spine
    const outcome = spines && rel ? outcomeFor(spines, rel) : null;
    // Current State: spines.py `current_state` when it emits the field, else the markdown parse (already in `out`).
    const fromSpines = spines && rel ? currentStateFor(spines, rel) : undefined;
    const state = fromSpines === undefined ? out.state : fromSpines ?? undefined;
    let tree: Tree | undefined;
    try {
      tree = await treeFor(m, softMs, spines);
    } catch {
      /* no tree → no nonGreen / red dots */
    }
    const spineCommitAt = loc && rel ? await lastCommit(loc.repo.path, rel) : undefined;
    // A settle-park is console bookkeeping and must not change the verdict.
    const parked = store.listAssignments({ milestoneId: m.id }).some((a) => !!a.parkedAt && a.parkedReason !== SETTLED_REASON);
    const verdict = deriveVerdict({ ...out, outcome, doneMeans: doctrine?.doneMeans, parked, redDots: tree?.counts.red });
    const { state: _s, ...rest } = out;
    return {
      ...rest,
      ...(state ? { state } : {}),
      ...(doctrine ? { doctrine } : {}),
      ...(run ? { runState: run.state, runnable: run.runnable } : {}),
      ...(tree ? { nonGreen: tree.nonGreen } : {}),
      outcome,
      verdict,
      ...(loc?.repo.remote ? { remote: loc.repo.remote } : {}),
      ...(spineCommitAt ? { spineCommitAt } : {}),
    };
  };
  return { soft, trees, drop, spinesFor, locateDir, treeFor, treeInfo, rewarm, docTitleOf, withDerived, withOutcome };
}

export type SpineReads = ReturnType<typeof createSpineReads>;
