import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountCounts, type CountsDeps } from "../src/counts.js";

// The inbox's first draw asks /counts and /counts/worlds beside its two review lists. A count shows no card
// age, so it never waits on one (each list waited up to 1.5 s for git to find the ages after a restart).
describe("counts", () => {
  it("ask the review list without card ages", async () => {
    const asked: unknown[] = [];
    const api = new Hono();
    const d = {
      store: { tenant: undefined, listMilestones: () => [{ id: "m1" }], getTenant: () => undefined },
      status: async () => ({ milestones: [], needsYou: 0 }),
      review: {
        list: async (f?: { ages?: boolean }) => {
          asked.push(f);
          return [{ milestoneId: "m1" }];
        },
      },
    } as unknown as CountsDeps;
    mountCounts(api, d);
    const counts = await (await api.request("/counts")).json();
    expect(counts.review).toBe(1);
    const worlds = await (await api.request("/counts/worlds")).json();
    expect(worlds.worlds[0].review).toBe(1);
    expect(asked).toEqual([{ ages: false }, { ages: false }]);
  });
});
