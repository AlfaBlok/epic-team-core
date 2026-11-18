import { describe, expect, it } from "vitest";
import { answerCache } from "../src/answerCache.js";

// the console's busiest reads share one build and answer a stale one at once while it refreshes.
describe("answerCache", () => {
  const clock = () => {
    let t = 1_000;
    return { now: () => t, add: (ms: number) => (t += ms) };
  };

  it("shares one load between callers asking at once, then answers from memory while fresh", async () => {
    const k = clock();
    const c = answerCache<number>({ ttlMs: 100, now: k.now });
    let loads = 0;
    const load = async () => ++loads;
    expect(await Promise.all([c.get("a", load), c.get("a", load), c.get("a", load)])).toEqual([1, 1, 1]);
    k.add(50);
    expect(await c.get("a", load)).toBe(1);
    expect(loads).toBe(1);
  });

  it("answers a stale value at once and refreshes it behind; too old waits for the load", async () => {
    const k = clock();
    const c = answerCache<number>({ ttlMs: 100, staleMs: 1_000, now: k.now });
    let loads = 0;
    let release: () => void = () => undefined;
    const slow = () => new Promise<number>((r) => (release = () => r(++loads)));
    const first = c.get("a", slow);
    release();
    expect(await first).toBe(1);
    k.add(500); // stale: the old answer comes back without waiting
    expect(await c.get("a", slow)).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(await c.get("a", slow)).toBe(2); // refreshed behind
    k.add(5_000); // past staleMs: waits
    const late = c.get("a", slow);
    release();
    expect(await late).toBe(3);
  });

  it("keeps the last answer when a refresh fails and rethrows only with none", async () => {
    const k = clock();
    const c = answerCache<number>({ ttlMs: 10, staleMs: 1_000, now: k.now });
    await expect(c.get("x", async () => Promise.reject(new Error("T3 down")))).rejects.toThrow("T3 down");
    expect(await c.get("x", async () => 7)).toBe(7);
    k.add(100);
    expect(await c.get("x", async () => Promise.reject(new Error("T3 down")))).toBe(7);
  });

  it("clear drops every answer and a load started before it does not refill", async () => {
    const k = clock();
    const c = answerCache<number>({ ttlMs: 1_000, now: k.now });
    let n = 0;
    let release: () => void = () => undefined;
    const p = c.get("a", () => new Promise<number>((r) => (release = () => r(++n))));
    c.clear();
    release();
    expect(await p).toBe(1);
    expect(await c.get("a", async () => 99)).toBe(99);
  });
});
