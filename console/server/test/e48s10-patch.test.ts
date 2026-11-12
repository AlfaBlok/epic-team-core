import { describe, expect, it } from "vitest";
import { addPatch, applyPatch, type Patch } from "../src/readModel/views.js";

// an unsnooze replaces the snooze patch for that ask (it used to keep the card hidden for the 5 min TTL).
describe("T48-S10 addPatch", () => {
  const pending = (id: string) => ({ id, kind: "ask" as const, state: "open" as const, milestoneId: "m1", title: id });
  const view = { items: [pending("a"), pending("b")], needsYou: 2 };
  const apply = (ps: { p: Patch }[]) => ps.reduce((v, x) => applyPatch({ kind: "status-one", milestoneId: "m1" } as never, v, x.p) as typeof view, view);

  it("snooze then unsnooze: only the unsnooze is kept, the stored view shows the ask again", () => {
    let ps = addPatch([], { kind: "snoozed", id: "b", until: "2026-12-01" }, 1);
    expect(apply(ps).needsYou).toBe(1);
    ps = addPatch(ps, { kind: "snoozed", id: "b", until: null }, 2);
    expect(ps.map((x) => x.p)).toEqual([{ kind: "snoozed", id: "b", until: null }]);
    expect(apply(ps).items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("other items' and other kinds' patches stay", () => {
    let ps = addPatch([], { kind: "snoozed", id: "a", until: "2026-12-01" }, 1);
    ps = addPatch(ps, { kind: "answered", id: "b" }, 2);
    ps = addPatch(ps, { kind: "snoozed", id: "b", until: "2026-12-01" }, 3);
    expect(ps.map((x) => `${x.p.kind}:${x.p.id}`)).toEqual(["snoozed:a", "answered:b", "snoozed:b"]);
  });
});
