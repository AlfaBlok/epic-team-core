import { spinesSince, type InvalidatableRunner, type SpinesJson, type SpinesRunner } from "../adapters/spines.js";

/**
 * the read-model worker asks the main thread for spines.py output instead of running its own. Before, after a
 * start, the worker and the main thread each ran spines.py for the same repo at the same time (2 concurrent runs for
 * the code repo seen on the main server), doubling the cold wait. Now there is one cache and one run in flight per repo.
 *
 * Worker side: `since` is when the worker noticed the checkout change (its pump calls `invalidate` before each re-run);
 * the first read of a repo asks for any run started after the worker itself (a start's prewarm is shared, never repeated).
 */
export type SpinesAsk = { type: "spines"; id: number; dir: string; since: number };
export type SpinesReply = { type: "spines"; id: number; value?: SpinesJson; error?: string };

export function workerSpinesRunner(post: (m: SpinesAsk) => void, startedAt: number, now: () => number = Date.now) {
  const waiting = new Map<number, { resolve: (v: SpinesJson) => void; reject: (e: Error) => void }>();
  const changedAt = new Map<string, number>();
  const seen = new Set<string>();
  let seq = 0;
  const run = ((dir: string) =>
    new Promise<SpinesJson>((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, {
        resolve: (v) => (seen.add(dir), resolve(v)),
        reject,
      });
      post({ type: "spines", id, dir, since: Math.max(startedAt, changedAt.get(dir) ?? 0) });
    })) as InvalidatableRunner;
  /** The refresher's pump re-runs a repo it saw change: only output from a run started after now counts. */
  run.invalidate = (dir: string) => {
    if (seen.has(dir)) changedAt.set(dir, now());
  };
  /** A reply from the main thread; false when it was not one. */
  const onReply = (m: unknown): boolean => {
    const r = m as Partial<SpinesReply> | undefined;
    if (r?.type !== "spines" || typeof r.id !== "number") return false;
    const w = waiting.get(r.id);
    waiting.delete(r.id);
    if (w) {
      if (r.value) w.resolve(r.value);
      else w.reject(new Error(r.error ?? "spines.py failed"));
    }
    return true;
  };
  return { run, onReply };
}

/** Main-thread side: answer one ask from the shared (cached) runner. */
export function answerSpinesAsk(run: SpinesRunner | undefined, ask: SpinesAsk, reply: (r: SpinesReply) => void): void {
  if (!run) return reply({ type: "spines", id: ask.id, error: "no spines.py on this console" });
  spinesSince(run, ask.dir, ask.since).then(
    (value) => reply({ type: "spines", id: ask.id, value }),
    (e) => reply({ type: "spines", id: ask.id, error: (e instanceof Error ? e.message : String(e)).split("\n")[0] }),
  );
}

export const isSpinesAsk = (m: unknown): m is SpinesAsk => {
  const a = m as Partial<SpinesAsk> | undefined;
  return a?.type === "spines" && typeof a.id === "number" && typeof a.dir === "string" && typeof a.since === "number";
};
