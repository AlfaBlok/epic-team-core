import type { Milestone } from "./store.js";
import { limiter } from "./adapters/spines.js";

/**
 * The goals list answers at once.
 *
 * GET /api/milestones built every milestone's derived info (withOutcome: spines.py view, the tree, the last spine
 * commit) on each request. Each new spines.py output (every pull of the code repo, minutes apart) made every tree a
 * rebuild the request waited for, so the sidebar's list took 1 to 10 s (41 answers over 1 s in
 * 8 min, slowest 10.3 s). Now each milestone's info is kept: a read answers the kept one at once and, when it is older
 * than `freshMs` or its checkout changed, refreshes it in the background (one refresh at a time across the console).
 *
 * A read waits only when there is nothing to answer yet, or the milestone's own row changed (a create, rename, settle,
 * pin): `key` is the stored row, so a console write to the row is seen by the next read. A spine write or pull of a
 * checkout (`drop(dir)`, many a minute on the code repo) marks that checkout's entries for refresh: the next read
 * still answers at once and the new info follows a moment later; a refresh that started before the drop leaves
 * its entry marked, so the one after it reads the change. `freshMs` 0 turns the memo off (tests).
 */
export function createMilestoneInfoMemo<T>(o: {
  compute: (m: Milestone) => Promise<T>;
  dirOf: (m: Milestone) => string | undefined;
  freshMs: number;
  now?: () => number;
}) {
  const now = o.now ?? Date.now;
  const entries = new Map<string, { key: string; at: number; dir?: string; dirty: boolean; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  const refreshing = new Set<string>();
  const slot = limiter(1);
  let gen = 0;
  const keyOf = (m: Milestone) => JSON.stringify(m);

  const compute = (m: Milestone, key: string): Promise<T> => {
    const started = gen;
    const at = now();
    return o.compute(m).then((value) => {
      // a drop during the build means this value may predate it: keep it, marked for one more refresh
      entries.set(m.id, { key, at, dir: o.dirOf(m), dirty: started !== gen, value });
      return value;
    });
  };

  const refresh = (m: Milestone, key: string) => {
    if (refreshing.has(m.id)) return;
    refreshing.add(m.id);
    void slot(() => new Promise<void>((r) => setImmediate(r)).then(() => compute(m, key)))
      .catch(() => {}) // a failed refresh keeps the last value; the next read tries again
      .finally(() => refreshing.delete(m.id));
  };

  return {
    get(m: Milestone): Promise<T> {
      if (o.freshMs <= 0) return o.compute(m);
      const key = keyOf(m);
      const hit = entries.get(m.id);
      if (hit && hit.key === key) {
        if (hit.dirty || now() - hit.at >= o.freshMs) refresh(m, key);
        return Promise.resolve(hit.value);
      }
      const k = `${m.id}\0${key}`;
      let p = inflight.get(k);
      if (!p) {
        p = compute(m, key).finally(() => inflight.delete(k));
        inflight.set(k, p);
      }
      return p;
    },
    /** a checkout changed (a spine write or a pull): its entries are refreshed on their next read. */
    drop(dir?: string) {
      gen++;
      for (const e of entries.values()) if (!dir || !e.dir || e.dir === dir) e.dirty = true;
    },
    size: () => entries.size,
  };
}
