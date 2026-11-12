import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cachedRunner,
  doctrineLookup,
  prewarmSpines,
  softSpines,
  spinesPyRunner,
  SPINES_TIMEOUT_MS,
  type SpinesJson,
  type SpinesRunner,
} from "../src/adapters/spines.js";

/** a cold spines.py slower than the request deadline must not drop Goal/Serves/Pages. */
const json = (goal: string): SpinesJson => ({
  root: "docs/spines/root.md",
  orphans: [],
  mismatches: [],
  nodes: [{ id: "PLAN-1", path: "docs/spines/root.md", title: "Root", parent: null, status: "open", rollup_status: "open", dod: [], children: [], goal }],
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake runner: each call takes `ms` and answers the next goal (or throws when the goal is an Error). */
function slowRunner(ms: number, answers: (string | Error)[]) {
  const calls: string[] = [];
  const run: SpinesRunner = async (dir) => {
    calls.push(dir);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    await sleep(ms);
    if (a instanceof Error) throw a;
    return json(a);
  };
  return { run, calls };
}

describe("T6-S2 spines.py cold cache", () => {
  it("the default spines.py timeout is long enough for a cold run on a loaded host", () => {
    expect(SPINES_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("a run slower than the fast deadline: the request answers last-good at once, the background run fills the cache", async () => {
    let t = 0;
    const fake = slowRunner(150, ["old", "new"]);
    const cached = cachedRunner(fake.run, 1_000, () => t, () => {});
    const lookup = doctrineLookup(cached, 50);
    // Cold, nothing good yet: the request gives up at the deadline, the run keeps going and fills the cache.
    expect(await lookup("/r", "docs/spines/root.md")).toBeUndefined();
    await sleep(200);
    expect((await lookup("/r", "docs/spines/root.md"))?.goal).toBe("old");
    // Expired: the request answers the stale value at once while one refresh runs.
    t = 5_000;
    const t0 = Date.now();
    expect((await lookup("/r", "docs/spines/root.md"))?.goal).toBe("old");
    expect(Date.now() - t0).toBeLessThan(100);
    await sleep(200);
    expect((await lookup("/r", "docs/spines/root.md"))?.goal).toBe("new");
    expect(fake.calls).toEqual(["/r", "/r"]);
  });

  it("a timeout keeps the previous value and logs the failure with its reason", async () => {
    let t = 0;
    const logs: string[] = [];
    const fake = slowRunner(10, ["good", new Error("spines.py: timed out after 90000 ms")]);
    const cached = cachedRunner(fake.run, 1_000, () => t, (m) => logs.push(m));
    expect((await cached("/r")).nodes[0].goal).toBe("good");
    t = 2_000;
    expect((await cached("/r")).nodes[0].goal).toBe("good"); // stale answer, refresh fails in the background
    await sleep(50);
    expect(logs).toEqual(["spines.py failed for /r: spines.py: timed out after 90000 ms (keeping last good output)"]);
    expect((await cached("/r")).nodes[0].goal).toBe("good");
    expect(fake.calls.length).toBe(2); // failure backs off one TTL, no retry storm
    const soft = softSpines(cached);
    expect((await soft("/r", 50))?.nodes[0].goal).toBe("good");
  });

  it("a failure with nothing cached is not cached as 'no spines': the next call runs again", async () => {
    const logs: string[] = [];
    const fake = slowRunner(5, [new Error("boom"), "ok"]);
    const cached = cachedRunner(fake.run, 60_000, () => 0, (m) => logs.push(m));
    await expect(cached("/r")).rejects.toThrow("boom");
    expect((await cached("/r")).nodes[0].goal).toBe("ok");
    expect(logs).toEqual(["spines.py failed for /r: boom"]);
  });

  it("concurrent cold requests share one run", async () => {
    const fake = slowRunner(30, ["x"]);
    const cached = cachedRunner(fake.run, 60_000, () => 0, () => {});
    await Promise.all([cached("/r"), cached("/r"), cached("/r")]);
    expect(fake.calls).toEqual(["/r"]);
  });

  it("prewarm calls each repo once, in sequence, and fills the cache", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const run: SpinesRunner = async (dir) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(dir);
      await sleep(20);
      active--;
      if (dir === "/bad") throw new Error("nope");
      return json(dir);
    };
    const logs: string[] = [];
    const inner = { n: 0 };
    const cached = cachedRunner((d) => (inner.n++, run(d)), 60_000, () => 0, () => {});
    await prewarmSpines(cached, ["/a", "/bad", "/b", "/a"], (m) => logs.push(m));
    expect(order).toEqual(["/a", "/bad", "/b"]);
    expect(maxActive).toBe(1);
    expect(logs).toEqual(["spines.py prewarm failed for /bad: nope"]);
    await cached("/a");
    await cached("/b");
    expect(inner.n).toBe(3); // served from the prewarmed cache
  });

  it("spinesPyRunner reports a timeout with its reason", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s2-skill-"));
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(path.join(dir, "scripts", "spines.py"), "import time\ntime.sleep(5)\n");
    try {
      await expect(spinesPyRunner(dir, { timeoutMs: 200 })(dir)).rejects.toThrow("spines.py: timed out after 200 ms");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
