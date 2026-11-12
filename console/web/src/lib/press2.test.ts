import { afterEach, describe, expect, it, vi } from "vitest";
import { landed, onPress, type PressNote } from "./press";

/** a press saved but not landed is never reported as done: the page waits for "landed" (or the failure). */
describe("T72-S1 landed()", () => {
  afterEach(() => vi.useRealTimers());

  it("a route answer that landed at once passes straight through", async () => {
    const get = vi.fn();
    expect(await landed({ state: "approved" }, "/review-items/x/approve", get, (m) => new Error(m))).toEqual({ state: "approved" });
    expect(get).not.toHaveBeenCalled();
  });

  it("202 landing: says 'landing', asks until landed, then returns the route's answer", async () => {
    vi.useFakeTimers();
    const notes: PressNote[] = [];
    const off = onPress((n) => notes.push(n));
    const states = [{ id: "pr_1", state: "landing" as const }, { id: "pr_1", state: "landed" as const, response: { state: "approved" } }];
    const get = vi.fn(async () => states.shift()!);
    const p = landed<{ state: string }>({ press: { id: "pr_1", state: "landing", reason: "uncommitted changes" } }, "/review-items/x/approve", get, (m) => new Error(m));
    await vi.advanceTimersByTimeAsync(700);
    expect(notes.map((n) => n.state)).toEqual(["landing"]);
    await vi.advanceTimersByTimeAsync(700);
    expect(await p).toEqual({ state: "approved" });
    expect(notes.map((n) => n.state)).toEqual(["landing", "landed"]);
    off();
  });

  it("a press that failed for good rejects with its reason", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => ({ id: "pr_2", state: "failed" as const, reason: "no row in review" }));
    const p = landed({ press: { id: "pr_2", state: "landing" } }, "/review-items/y/deny", get, (m) => new Error(m));
    const caught = p.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await caught).toBe("no row in review");
  });
});
