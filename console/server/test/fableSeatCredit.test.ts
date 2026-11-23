import { describe, expect, it } from "vitest";
import { seatBoard } from "../src/adapters/seatBoard.js";
import { pickWith } from "../src/providers/pick.js";
import { START_FAIL_RULE } from "../src/cycle/prompts.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";

/**
 * One seat with no Fable credit blocked a Fable run while others had it. The Seats screen shows
 * each seat's Fable credit left; a Fable wake tells the broker its model; a "requires usage credits" failure is
 * relaunched once on another seat, never asked of the owner.
 */
const NOW = new Date("2026-11-22T23:30:00Z");
const fable = (pct: number) => ({ Fable: { pct, resets_at: "2026-11-27T12:00:00Z" } });
const raw = {
  updated: "2026-11-22T23:29:00Z",
  seats: {
    seat1: { logged_in: true, usage: { known: true, five_hour_pct: 6, weekly_pct: 40, status: "allowed", model_weekly: fable(7) } },
    seat5: { logged_in: true, usage: { known: true, five_hour_pct: 28, weekly_pct: 56, status: "allowed", model_weekly: fable(11) }, model_blocked: { Fable: "2026-11-23T05:00:00Z" } },
    seat16: { logged_in: true, usage: { known: true, five_hour_pct: 39, weekly_pct: 74, status: "allowed", model_weekly: {} } },
    seat2: { logged_in: false, usage: { known: false, status: "unknown" } },
  },
};

describe("Fable credit per seat", () => {
  const b = seatBoard(raw, undefined, NOW);
  const s = (id: string) => b.seats.find((x) => x.id === id)!;

  it("shows Fable left as a percent, none for a seat whose plan has no Fable, none while refused", () => {
    expect(s("seat1").fableLeft).toBe(93);
    expect(s("seat16")).toMatchObject({ fableLeft: 0, fableNote: "not in its plan" });
    expect(s("seat5")).toMatchObject({ fableLeft: 0, fableNote: "refused until 2026-11-23T05:00:00Z" });
    expect(s("seat2").fableLeft).toBeUndefined();
    expect(b.fableSeats).toBe(1);
  });

  it("a Fable wake asks the broker with its model even with the world pick off; Opus stays a plain pick", async () => {
    const calls: string[] = [];
    const d: Dispatcher = {
      pick: async () => (calls.push("pick"), { seat: "seat16", providerInstanceId: "claudeAgent_seat16" }),
      pickFor: async (a: { model?: string }) => (calls.push(`pickFor ${a.model}`), { seat: "seat1", providerInstanceId: "claudeAgent_seat1", model: a.model }),
      done: async () => {},
    } as unknown as Dispatcher;
    const r = await pickWith(d, false, { world: "home", model: "fable" }, () => "claude-fable-5-2");
    expect(r.seat).toBe("seat1");
    await pickWith(d, false, { world: "home", model: "opus" }, () => "claude-opus-5-5");
    expect(calls).toEqual(["pickFor claude-fable-5-2", "pick"]);
  });

  it("the manager relaunches a 'requires usage credits' failure once on another seat, never asking the owner", () => {
    expect(START_FAIL_RULE).toMatch(/requires usage credits[\s\S]*pick --model <same model>[\s\S]*relaunch ONCE[\s\S]*never ask the owner/);
  });
});
