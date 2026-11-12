import { afterEach, describe, expect, it, vi } from "vitest";
import { landed, onPress, PRESS_ASK_MISSES, type PressNote } from "./press";

/**
 * the console
 * refusing to say how a press went (403 world_scope) stops the asking and says so on the card within seconds; a console
 * that stays down is asked a few times, then the card says it too. Never a line spinning for minutes.
 */
describe("T72-S20 landed() never spins for good", () => {
  afterEach(() => vi.useRealTimers());

  it("a refused ask (403) fails at once, with what to do", async () => {
    vi.useFakeTimers();
    const notes: PressNote[] = [];
    const off = onPress((n) => notes.push(n));
    const get = vi.fn(async () => {
      throw Object.assign(new Error("this part of the console is not available in this world yet"), { status: 403 });
    });
    const caught = landed({ press: { id: "pr_1", state: "landing" } }, "/review-items/x/complete", get, (m) => new Error(m)).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(700);
    const msg = await caught;
    expect(get).toHaveBeenCalledTimes(1);
    expect(msg).toContain("could not check that it reached the project");
    expect(msg).toContain("press it again");
    expect(notes.map((n) => n.state)).toEqual(["landing", "failed"]);
    off();
  });

  it("a console that stays down: asked PRESS_ASK_MISSES times in a row, then the card says so", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => {
      throw Object.assign(new Error("Bad gateway"), { status: 502 });
    });
    const caught = landed({ press: { id: "pr_2", state: "landing" } }, "/review-items/y/complete", get, (m) => new Error(m)).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(700 * (PRESS_ASK_MISSES + 1));
    expect(await caught).toContain("could not check");
    expect(get).toHaveBeenCalledTimes(PRESS_ASK_MISSES);
  });

  it("one missed ask between good ones is not counted against the press", async () => {
    vi.useFakeTimers();
    const answers: (() => unknown)[] = [
      () => {
        throw Object.assign(new Error("down"), { status: 503 });
      },
      () => ({ id: "pr_3", state: "landing" }),
      () => {
        throw Object.assign(new Error("down"), { status: 503 });
      },
      () => {
        throw Object.assign(new Error("down"), { status: 503 });
      },
      () => ({ id: "pr_3", state: "landed", response: { ok: true } }),
    ];
    const get = vi.fn(async () => answers.shift()!() as never);
    const p = landed<{ ok: boolean }>({ press: { id: "pr_3", state: "landing" } }, "/review-items/z/complete", get, (m) => new Error(m));
    await vi.advanceTimersByTimeAsync(700 * 6);
    expect(await p).toEqual({ ok: true });
  });
});
