import { depsChangedAsync, trackDeps, type Deps } from "./fileDeps.js";
import { limiter } from "./spines.js";

/**
 * short-TTL memo of built milestone trees with in-flight coalescing.
 *
 * `buildTree` is synchronous and walks every spine/ticket file of a milestone; routes rebuilt it per request (the web
 * polls many of them every 30 s), so one slow stretch queued every other request behind it. A tree is reused for
 * `ttlMs` while its inputs are unchanged (`key`: the milestone and owner; `spines`: the spines.py output, compared by
 * identity, so a refreshed or invalidated runner output is a miss). Concurrent callers for the same key share one build.
 * `invalidate(dir)` (a write to that checkout) drops its trees and discards builds that started before it.
 *
 * the build records every file (and ticket directory) it read with its mtime+size (adapters/fileDeps.ts). Once
 * `ttlMs` has passed, a tree whose spines.py output is the same object and whose files all still have their stamps is
 * revalidated (a few stats) instead of rebuilt; so `ttlMs` is how often an outside edit is looked for, not how long a
 * tree lives. A build that read no file (nothing to check) is rebuilt after `ttlMs` as before.
 *
 * `invalidate(dir, { stale: true })` (a pull) keeps the trees of dir but marks them stale. A `get` with a
 * `fresh` loader answers a stale tree at once and rebuilds it in the background (`fresh` waits for the post-pull
 * spines.py run), one rebuild per key at a time; the new tree replaces it when done. Without `fresh`, or with no tree
 * yet, the call builds and waits as before. A plain `invalidate(dir)` (the console's own write) still drops them.
 */
export const TREE_TTL_MS = 3_000;

type Loaded<S> = { spines: S | undefined; dir?: string };
type Load<S> = () => Promise<Loaded<S>> | Loaded<S>;
/** the same build off the event loop (adapters/treeOff.ts), resolving with the tree and the files it read. */
export type MakeOff<T, S> = (spines: S | undefined) => Promise<{ value: T; deps: Deps }>;

/** one background tree rebuild at a time across the console (see `revalidate`). */
const rebuildSlot = limiter(1);

export function createTreeMemo<T, S>(ttlMs: number = TREE_TTL_MS, now: () => number = Date.now) {
  /** `tick`: the clock value when the build started; `builtAt`: when the tree was made (revalidations keep it). */
  const done = new Map<string, { at: number; builtAt: number; tick: number; spines: S | undefined; dir?: string; tree: T; deps: Deps }>();
  const inflight = new Map<string, Promise<T>>();
  const background = new Map<string, Promise<T>>();
  /** per checkout dir, the tick of its last pull; a tree whose build started before it is stale. */
  const staleSince = new Map<string, number>();
  let tick = 0;
  let gen = 0;
  const isStale = (e: { tick: number; dir?: string }) => !!e.dir && (staleSince.get(e.dir) ?? 0) > e.tick;

  const build = async (key: string, load: Load<S>, make: (spines: S | undefined) => T, makeOff?: MakeOff<T, S>): Promise<T> => {
    const started = gen;
    const startTick = ++tick;
    const { spines, dir } = await load();
    const hit = done.get(key);
    if (hit && hit.spines === spines && !isStale(hit)) {
      if (now() - hit.at < ttlMs) return hit.tree;
      // the stamps are read with async stats (the libuv pool), not one statSync per file on the event loop
      if (hit.deps.size && !(await depsChangedAsync(hit.deps))) {
        hit.at = now();
        return hit.tree;
      }
    }
    // built in the tree worker when there is one; if it fails (a dead worker, an error) the same build runs here
    // as before, so a real build error still reaches the caller unchanged.
    let built: { value: T; deps: Deps } | undefined;
    if (makeOff) built = await makeOff(spines).catch(() => undefined);
    const { value: tree, deps } = built ?? trackDeps(() => make(spines));
    if (ttlMs > 0 && started === gen) done.set(key, { at: now(), builtAt: now(), tick: startTick, spines, dir, tree, deps });
    return tree;
  };

  /**
   * rebuild key off the request, one at a time per key. Builds are synchronous (the code repo's root tree ~0.4 s on
   * the worker server, more on the main server), so the rebuilds of every memo run one after another through `rebuildSlot`, each after a
   * macrotask: requests answer between two of them instead of behind all the trees a pull made stale at once (5.8 s live).
   */
  const revalidate = (key: string, fresh: Load<S>, make: (spines: S | undefined) => T, makeOff?: MakeOff<T, S>) => {
    if (background.has(key)) return;
    const p = Promise.resolve()
      .then(fresh) // waits for the post-pull spines.py run outside the slot: another repo's trees do not queue behind it
      .then((loaded) => rebuildSlot(() => new Promise<void>((r) => setImmediate(r)).then(() => build(key, () => loaded, make, makeOff))))
      .finally(() => {
        if (background.get(key) === p) background.delete(key);
      });
    p.catch(() => {}); // a failed rebuild keeps the stale tree; the next read tries again
    background.set(key, p);
  };

  return {
    /**
     * `load` resolves the spines.py output (and the checkout dir) the tree is built from; `make` builds it.
     * With `shared` (no caller-chosen spines) concurrent calls for `key` share one run of both.
     */
    get(key: string, load: Load<S>, make: (spines: S | undefined) => T, shared = true, fresh?: Load<S>, makeOff?: MakeOff<T, S>): Promise<T> {
      if (ttlMs <= 0) return build(key, load, make, makeOff);
      const hit = done.get(key);
      if (fresh && hit && isStale(hit)) {
        revalidate(key, fresh, make, makeOff);
        return Promise.resolve(hit.tree);
      }
      if (!shared) return build(key, load, make, makeOff);
      let p = inflight.get(key);
      if (!p) {
        p = build(key, load, make, makeOff).finally(() => {
          if (inflight.get(key) === p) inflight.delete(key);
        });
        inflight.set(key, p);
      }
      return p;
    },
    /**
     * The checkout `dir` changed: forget its trees; runs already started will not be stored. With `stale` (a pull,
     *) its trees stay and are served while they rebuild (see `get`'s `fresh`).
     */
    invalidate(dir?: string, o?: { stale?: boolean }) {
      if (o?.stale && dir) {
        staleSince.set(dir, ++tick);
        return;
      }
      gen++;
      inflight.clear();
      background.clear();
      for (const [k, v] of done) if (!dir || !v.dir || v.dir === dir) done.delete(k);
    },
    /** resolves when key's background rebuild (if any) is done. */
    rebuilt(key: string): Promise<void> {
      return (background.get(key) ?? Promise.resolve()).then(() => undefined, () => undefined);
    },
    /** when key's tree was built and whether it is stale (a newer one is on its way); undefined = none. */
    info(key: string): { builtAt: number; stale: boolean } | undefined {
      const hit = done.get(key);
      return hit ? { builtAt: hit.builtAt, stale: isStale(hit) || background.has(key) } : undefined;
    },
    clear() {
      this.invalidate();
    },
  };
}
