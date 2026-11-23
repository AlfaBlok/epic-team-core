// right after a start the console warms the inbox's first-draw reads until one whole pass is under 2 s.
import { describe, expect, it } from "vitest";
import { inboxFirstDraw, inboxWarmHealth, warmInbox } from "../src/warmInbox.js";

describe("warmInbox", () => {
  it("repeats the first-draw reads until a pass is under budget, then says warm", async () => {
    let t = 0;
    let pass = 0;
    const seen = new Set<string>();
    const fetch = (async (u: string) => {
      seen.add(u);
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    // each pass "takes" 5 s, then 3 s, then 0.4 s (the clock moves per pass)
    const costs = [5_000, 3_000, 400];
    const now = () => t;
    const logs: string[] = [];
    const s = await warmInbox({
      base: "http://h:1",
      fetch: (async (u: string, i?: RequestInit) => {
        if (u.endsWith("/api/status")) t += costs[pass++] ?? 0;
        return fetch(u, i);
      }) as unknown as typeof globalThis.fetch,
      now,
      pauseMs: 0,
      log: (m) => logs.push(m),
    });
    expect(s.state).toBe("warm");
    expect(s.passes).toBe(3);
    expect(s.lastMs).toBe(400);
    expect(inboxWarmHealth().state).toBe("warm");
    expect([...seen].map((u) => u.replace("http://h:1", "")).sort()).toEqual([...inboxFirstDraw()].sort());
    expect(logs[0]).toMatch(/inbox warm: 19 first-draw reads in 400 ms on pass 3/);
  });

  it("gives up as slow after maxMs, and a failing read is never warm", async () => {
    let t = 0;
    const s = await warmInbox({
      base: "http://h:1",
      paths: ["/api/a", "/api/b"],
      fetch: (async (u: string) => ((t += 10), new Response("x", { status: u.endsWith("/b") ? 500 : 200 }))) as unknown as typeof globalThis.fetch,
      now: () => t,
      maxMs: 100,
      pauseMs: 0,
    });
    expect(s.state).toBe("slow");
    expect(s.failed).toEqual(["/api/b 500"]);
  });
});
