import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { siteOf, watchLoopLag } from "../src/loopLag.js";

/** a blocked event loop is logged, and a timer that blocked it is named by where it was set. */
let stop: (() => void) | undefined;
afterEach(() => stop?.());

const busy = (ms: number) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    /* block */
  }
};

describe("T6-S64 watchLoopLag", () => {
  it("names a timer that ran past the threshold, and the sampler sees the loop late", async () => {
    const logs: string[] = [];
    stop = watchLoopLag({ thresholdMs: 80, sampleMs: 20, log: (m) => logs.push(m) });
    function slowTick() {
      busy(150);
    }
    setTimeout(slowTick, 5);
    await new Promise((r) => setTimeout(r, 300));
    // (vitest wraps the timers itself, so the site is its frame here; siteOf is checked on its own below)
    expect(logs.some((l) => /^event loop: a timer ran \d+ ms without yielding \(set at .+\)$/.test(l))).toBe(true);
    expect(logs.some((l) => /^event loop: blocked \d+ ms; timers in it: \d+ ms .+/.test(l))).toBe(true);
  });

  it("leaves quick timers alone, keeps clearTimeout and the promisified setTimeout working, and restores the originals", async () => {
    const logs: string[] = [];
    const orig = globalThis.setTimeout;
    stop = watchLoopLag({ thresholdMs: 80, sampleMs: 20, log: (m) => logs.push(m) });
    let ran = false;
    const t = setTimeout(() => (ran = true), 5);
    clearTimeout(t);
    await promisify(setTimeout)(30);
    expect(ran).toBe(false);
    expect(logs).toEqual([]);
    stop();
    stop = undefined;
    expect(globalThis.setTimeout).toBe(orig);
  });

  it("siteOf names the first app frame, past this module, node internals and packages", () => {
    const e = new Error("x");
    e.stack = [
      "Error: x",
      "    at w (file:///srv/agent/team_console/app/server/dist/index.mjs:41935:22)",
      "    at node:internal/timers:594:17",
      "    at Object.setInterval (/app/server/node_modules/some/x.js:1:1)",
      "    at tick (file:///srv/agent/team_console/app/server/dist/index.mjs:1234:5)",
    ].join("\n");
    expect(siteOf(e)).toBe("tick (app/server/dist/index.mjs:1234:5)");
  });
});
