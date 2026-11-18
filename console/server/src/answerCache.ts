/**
 * A short shared cache for the console's busiest reads. Every open tab polls the same few reads (a world's campaigns,
 * the worlds list, the thread list); rebuilding each answer from files, git and the agent server on every poll made
 * them take seconds under load and kept the console busy on a small host.
 *
 * `get(key, load)`:
 * - fresh (younger than `ttlMs`): the kept answer, no work;
 * - stale but younger than `staleMs`: the kept answer at once, and one load in the background refreshes it;
 * - none or too old: wait for the load; callers asking for the same key at once share that one load.
 * A failed load keeps the last answer (served while younger than `staleMs`) and rethrows only to a caller that has none.
 * `clear()` drops every answer (a write that changes what the reads show calls it).
 */
export interface AnswerCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
}

export function answerCache<T>(o: { ttlMs: number; staleMs?: number; max?: number; now?: () => number }): AnswerCache<T> {
  const now = o.now ?? Date.now;
  const staleMs = Math.max(o.staleMs ?? o.ttlMs, o.ttlMs);
  const max = o.max ?? 200;
  const kept = new Map<string, { at: number; value: T }>();
  const loading = new Map<string, Promise<T>>();
  let generation = 0;

  const start = (key: string, load: () => Promise<T>): Promise<T> => {
    const running = loading.get(key);
    if (running) return running;
    const gen = generation;
    const p = load()
      .then((value) => {
        if (gen === generation) {
          kept.delete(key);
          kept.set(key, { at: now(), value });
          while (kept.size > max) kept.delete(kept.keys().next().value as string);
        }
        return value;
      })
      .finally(() => loading.delete(key));
    loading.set(key, p);
    return p;
  };

  return {
    get(key, load) {
      const k = kept.get(key);
      const age = k ? now() - k.at : Infinity;
      if (k && age <= o.ttlMs) return Promise.resolve(k.value);
      if (k && age <= staleMs) {
        start(key, load).catch(() => undefined);
        return Promise.resolve(k.value);
      }
      return start(key, load);
    },
    clear() {
      generation++;
      kept.clear();
      loading.clear();
    },
  };
}
