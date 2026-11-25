import { afterEach, describe, expect, it, vi } from "vitest";
import { KEPT_LINE, landed, onPress, type PressNote } from "./press";

/**
 * a press whose row could be read two ways is kept by the console until the row is repaired. The card
 * says it was kept at once (never a spinner waiting on the repair timer, never a failure).
 */
describe("a kept press", () => {
  afterEach(() => vi.useRealTimers());

  it("says 'kept' and resolves as soon as the console keeps it, without waiting for it to land", async () => {
    vi.useFakeTimers();
    const notes: PressNote[] = [];
    const off = onPress((n) => notes.push(n));
    const held = "not written: row T73-S1 has 13 cells but its header has 11";
    const get = vi.fn(async () => ({ id: "pr_9", state: "landing" as const, held }));
    const p = landed<{ press: { state: string; message: string } }>({ press: { id: "pr_9", state: "landing" } }, "/review-items/x/approve", get, (m) => new Error(m));
    await vi.advanceTimersByTimeAsync(700);
    expect(await p).toEqual({ press: { id: "pr_9", state: "kept", message: KEPT_LINE } });
    expect(notes.map((n) => n.state)).toEqual(["landing", "kept"]);
    expect(notes[1]).toMatchObject({ reason: held, id: "pr_9" });
    expect(get).toHaveBeenCalledTimes(1);
    off();
  });
});
