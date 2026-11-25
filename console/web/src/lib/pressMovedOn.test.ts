import { afterEach, describe, expect, it, vi } from "vitest";
import { landed, onPress, type PressNote } from "./press";

/**
 * E948-S206 round 3 (vn_e4dbcbce, 25 Nov): his "Yes: fill the forms tonight" on E995-S22 came after E995-S22 was folded into
 * E995-S2. The console now lands it there; the press line says where it went instead of "Done", never "Press again".
 */
describe("a press on a card that moved on", () => {
  afterEach(() => vi.useRealTimers());

  it("lands, and its landed note carries where it went", async () => {
    vi.useFakeTimers();
    const notes: PressNote[] = [];
    const off = onPress((n) => notes.push(n));
    const line = 'This card had been merged into "Get funding was made to track every credit application in colour" before your press. Your answer went there, and its owner has it.';
    const get = vi.fn(async () => ({ id: "pr_1", state: "landed" as const, ms: 900, response: { id: "rv_d289539e664796a767e5", movedOn: { ref: "E995-S2", line } } }));
    const p = landed<{ movedOn?: { line: string } }>({ press: { id: "pr_1", state: "landing" } }, "/review-items/rv_d289539e664796a767e5/complete", get, (m) => new Error(m));
    await vi.advanceTimersByTimeAsync(700);
    expect((await p).movedOn?.line).toBe(line);
    expect(notes.map((n) => n.state)).toEqual(["landing", "landed"]);
    expect(notes[1].movedOn).toBe(line);
    off();
  });
});
