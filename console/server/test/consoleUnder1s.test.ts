import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedRunner, softSpines, type SpinesJson } from "../src/adapters/spines.js";
import { phased, TIMER_PHASE_S, timerPhasesOn } from "../src/timerPhase.js";

const json = (goal: string): SpinesJson => ({ nodes: [{ path: "docs/spines/root.md", goal } as never], orphans: [], mismatches: [] }) as unknown as SpinesJson;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a read with a last good output waits on a slow spines.py run once, not on every read", () => {
  it("after the console's own write, the first read waits softMs, the next ones answer the last good output at once", async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const run = async (): Promise<SpinesJson> => {
      n++;
      if (n === 1) return json("old");
      await new Promise<void>((r) => (release = r)); // the run after the write: minutes on the main server
      return json("new");
    };
    const cached = cachedRunner(run, 60_000, () => 0, () => {});
    const soft = softSpines(cached);
    expect((await soft("/r", 50))?.nodes[0].goal).toBe("old");
    cached.invalidate("/r"); // the console's own spine write: the repo is dirty until the next run is back
    let t0 = Date.now();
    expect((await soft("/r", 60))?.nodes[0].goal).toBe("old");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55); // the first read gave the run its chance
    for (let i = 0; i < 5; i++) {
      t0 = Date.now();
      expect((await soft("/r", 60))?.nodes[0].goal).toBe("old");
      expect(Date.now() - t0).toBeLessThan(30); // before: 60 ms each, every read (1.5 s on GET /api/milestones)
    }
    release!();
    await sleep(5);
    expect((await soft("/r", 60))?.nodes[0].goal).toBe("new"); // the run is back: its output, and waits are normal again
  });

  it("a run that answers inside softMs still gives the writer its own change (no behaviour change for a fast repo)", async () => {
    let goal = "old";
    const cached = cachedRunner(async () => (await sleep(10), json(goal)), 60_000, () => 0, () => {});
    const soft = softSpines(cached);
    expect((await soft("/r", 200))?.nodes[0].goal).toBe("old");
    goal = "new";
    cached.invalidate("/r");
    expect((await soft("/r", 200))?.nodes[0].goal).toBe("new");
  });

  it("a cold repo (no output yet) still waits and reports the miss", async () => {
    const soft = softSpines(() => new Promise<SpinesJson>((r) => setTimeout(() => r(json("x")), 200)));
    const mark = soft.mark();
    expect(await soft("/c", 20)).toBeUndefined();
    expect(soft.missedSince("/c", mark)).toBe(true);
    expect(await soft("/c", 20)).toBeUndefined(); // no last good output: no shortcut
  });
});

describe("the periodic jobs start at their own second", () => {
  afterEach(() => vi.useRealTimers());

  it("no two 5- or 10-minute jobs fire in the same second of the 10-minute frame", () => {
    const fires: number[] = [];
    const every: Record<string, number> = { usage: 300, leases: 300, bookRefresh: 600, deckNotify: 600, reviewGate: 600, stallWatch: 600 };
    for (const [job, phase] of Object.entries(TIMER_PHASE_S)) for (let t = phase; t < 600 + phase; t += every[job]) fires.push(t % 600);
    expect(new Set(fires).size).toBe(fires.length);
    const sorted = [...fires].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(60);
  });

  it("phased starts after the job's phase when on, at once when off", () => {
    vi.useFakeTimers();
    const started: string[] = [];
    phased(false, "reviewGate", () => started.push("off"));
    phased(true, "usage", () => started.push("usage"));
    phased(true, "reviewGate", () => started.push("gate"));
    expect(started).toEqual(["off", "usage"]);
    vi.advanceTimersByTime(TIMER_PHASE_S.reviewGate * 1_000 - 1);
    expect(started).toEqual(["off", "usage"]);
    vi.advanceTimersByTime(1);
    expect(started).toEqual(["off", "usage", "gate"]);
  });

  it("on by default, CONSOLE_TIMER_PHASES=0 turns it off", () => {
    expect(timerPhasesOn({})).toBe(true);
    expect(timerPhasesOn({ CONSOLE_TIMER_PHASES: "0" })).toBe(false);
  });
});
