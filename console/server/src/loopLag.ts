import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

/**
 * the console says when its event loop was blocked, so a stalled button press has a
 * name in the log. Two parts, both cheap:
 *  - a sampler (every `sampleMs`) logs `event loop: blocked <n> ms` when it ran that much late;
 *  - setTimeout / setInterval callbacks are timed, and one that ran `thresholdMs` or more without yielding is logged
 *    with where it was set (its function and file:line), e.g. a scheduler tick doing a long synchronous job; a blocked
 *    line also names the timers that ran inside that window (the rest was promise or I/O callbacks).
 * CONSOLE_LOOP_LAG=0 turns it off; CONSOLE_LOOP_LAG_MS sets the threshold (default 1000 ms).
 */
export interface LoopLagOptions {
  thresholdMs?: number;
  sampleMs?: number;
  log?: (msg: string) => void;
  /** Time the timers' callbacks too (default true). */
  timers?: boolean;
}

/** The first stack frame past the wrapper (the frame that made `e`), node internals and packages: where a timer was set. */
export function siteOf(e: Error): string {
  const lines = (e.stack ?? "").split("\n").slice(2).map((l) => l.trim());
  const other = lines.filter((l) => !l.includes("loopLag") && !l.includes("node:") && !l.includes("(<anonymous>)"));
  const own = other.find((l) => !l.includes("node_modules")) ?? other[0];
  return (own ?? lines[0] ?? "?").replace(/^at\s+/, "").replace(/file:\/\/\S*?\/(server\/|app\/)/, "$1");
}

let installed: (() => void) | undefined;

export function watchLoopLag(o: LoopLagOptions = {}): () => void {
  installed?.();
  const threshold = o.thresholdMs ?? 1_000;
  const sampleMs = o.sampleMs ?? 250;
  const log = o.log ?? ((m: string) => console.warn(m));
  /** Timer runs of 20 ms or more, kept a few seconds so a blocked line can name them. */
  let ran: { at: number; ms: number; born: Error }[] = [];
  const origTimeout = globalThis.setTimeout;
  const origInterval = globalThis.setInterval;
  if (o.timers !== false) {
    const wrap = <F extends typeof setTimeout | typeof setInterval>(orig: F): F => {
      const w = function (this: unknown, cb: unknown, ms?: number, ...args: unknown[]) {
        if (typeof cb !== "function") return (orig as (...a: unknown[]) => unknown).call(this, cb, ms, ...args);
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 16;
        const born = new Error();
        Error.stackTraceLimit = limit;
        const timed = function (this: unknown, ...a: unknown[]) {
          const t0 = performance.now();
          try {
            return (cb as (...x: unknown[]) => unknown).apply(this, a);
          } finally {
            const d = performance.now() - t0;
            if (d >= 20) ran.push({ at: t0, ms: d, born });
            if (d >= threshold) log(`event loop: a timer ran ${Math.round(d)} ms without yielding (set at ${siteOf(born)})`);
          }
        };
        return (orig as (...a: unknown[]) => unknown).call(this, timed, ms, ...args);
      } as unknown as F;
      const custom = (orig as unknown as Record<symbol, unknown>)[promisify.custom];
      if (custom) (w as unknown as Record<symbol, unknown>)[promisify.custom] = custom;
      return w;
    };
    globalThis.setTimeout = wrap(origTimeout);
    globalThis.setInterval = wrap(origInterval);
  }
  let last = performance.now();
  const sampler = origInterval(() => {
    const t = performance.now();
    const late = t - last - sampleMs;
    const from = last;
    last = t;
    if (late >= threshold) {
      const inside = ran.filter((r) => r.at >= from).sort((a, b) => b.ms - a.ms);
      const named = inside.slice(0, 4).map((r) => `${Math.round(r.ms)} ms ${siteOf(r.born)}`);
      log(`event loop: blocked ${Math.round(late)} ms${named.length ? `; timers in it: ${named.join(", ")}` : ""}`);
    }
    ran = ran.filter((r) => t - r.at < 5_000);
  }, sampleMs);
  sampler.unref?.();
  installed = () => {
    clearInterval(sampler);
    globalThis.setTimeout = origTimeout;
    globalThis.setInterval = origInterval;
    installed = undefined;
  };
  return installed;
}
