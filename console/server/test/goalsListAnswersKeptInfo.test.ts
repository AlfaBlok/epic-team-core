import { describe, expect, it } from "vitest";
import { createMilestoneInfoMemo } from "../src/milestoneList.js";
import type { Milestone } from "../src/store.js";

// the goals list answers each milestone's kept info at once and refreshes it off the request.
const ms = (over: Partial<Milestone> = {}): Milestone => ({ id: "m1", title: "Goal", repo: "r", path: "docs/spines/a.md", owner: "o", paused: false, createdAt: "2026-11-25T00:00:00Z", ...over });
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe("goals list memo", () => {
  const setup = (freshMs = 10_000) => {
    let t = 0;
    let n = 0;
    let gate: Promise<void> | undefined;
    const memo = createMilestoneInfoMemo({
      compute: async (m) => {
        n++;
        const mine = n;
        if (gate) await gate;
        return `${m.title}#${mine}`;
      },
      dirOf: () => "/repo",
      freshMs,
      now: () => t,
    });
    return { memo, calls: () => n, advance: (ms: number) => (t += ms), hold: (p?: Promise<void>) => (gate = p) };
  };

  it("waits only for the first read, then answers the kept info", async () => {
    const s = setup();
    expect(await s.memo.get(ms())).toBe("Goal#1");
    expect(await s.memo.get(ms())).toBe("Goal#1");
    expect(s.calls()).toBe(1);
  });

  it("answers the kept info at once when it is old and refreshes it in the background", async () => {
    const s = setup();
    await s.memo.get(ms());
    s.advance(11_000);
    let release!: () => void;
    s.hold(new Promise<void>((r) => (release = r)));
    expect(await s.memo.get(ms())).toBe("Goal#1"); // the refresh is held, the read is not
    await tick();
    expect(s.calls()).toBe(2);
    release();
    await tick();
    expect(await s.memo.get(ms())).toBe("Goal#2");
  });

  it("a changed row (rename, settle) is read fresh at once", async () => {
    const s = setup();
    await s.memo.get(ms());
    expect(await s.memo.get(ms({ title: "Renamed" }))).toBe("Renamed#2");
  });

  it("a spine write or pull marks the checkout for refresh, and a refresh started before it runs once more", async () => {
    const s = setup();
    await s.memo.get(ms());
    let release!: () => void;
    s.hold(new Promise<void>((r) => (release = r)));
    s.memo.drop("/repo");
    expect(await s.memo.get(ms())).toBe("Goal#1");
    await tick();
    s.memo.drop("/repo"); // a second write while the refresh is under way
    release();
    await tick();
    s.hold(undefined);
    expect(await s.memo.get(ms())).toBe("Goal#2"); // answered, but still marked
    await tick();
    expect(await s.memo.get(ms())).toBe("Goal#3");
  });

  it("is off with freshMs 0", async () => {
    const s = setup(0);
    await s.memo.get(ms());
    await s.memo.get(ms());
    expect(s.calls()).toBe(2);
  });
});
