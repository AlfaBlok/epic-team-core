import { describe, expect, it } from "vitest";
import { applyPatch, type Patch } from "../src/readModel/views.js";

/**
 * every count is the length of its
 * list (web lib/inbox). An unsnoozed ask is back in the stored status views at once, so the pills and the list both count
 * it from the status, with no browser-only override that the pills did not share.
 */
describe("T72-S6 unsnooze puts the ask back in the status views", () => {
  const pending = (id: string, milestoneId = "m1") => ({ id, kind: "ask" as const, state: "open" as const, milestoneId, title: id });
  const unsnooze = (item = pending("b")): Patch => ({ kind: "snoozed", id: "b", until: null, item });

  it("one milestone's view and the world batch list it and count it", () => {
    const one = { milestoneId: "m1", items: [pending("a")], needsYou: 1 };
    const after = applyPatch({ kind: "status-one", world: "", milestoneId: "m1" }, one, unsnooze()) as typeof one;
    expect(after.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(after.needsYou).toBe(2);
    const batch = { milestones: [one, { milestoneId: "m2", items: [], needsYou: 0 }], items: [pending("a")], needsYou: 1, at: "x" };
    const b2 = applyPatch({ kind: "status", world: "", includeSettled: false }, batch, unsnooze()) as typeof batch;
    expect(b2.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(b2.needsYou).toBe(2);
    expect(b2.milestones.map((m) => m.needsYou)).toEqual([2, 0]);
  });

  it("another milestone's view is untouched, and an ask already listed is not added twice", () => {
    const other = { milestoneId: "m2", items: [], needsYou: 0 };
    expect(applyPatch({ kind: "status-one", world: "", milestoneId: "m2" }, other, unsnooze())).toBe(other);
    const has = { milestoneId: "m1", items: [pending("b")], needsYou: 1 };
    expect((applyPatch({ kind: "status-one", world: "", milestoneId: "m1" }, has, unsnooze()) as typeof has).items).toHaveLength(1);
  });

  it("an unsnooze without the item (older callers) leaves the view for the refresher, as before", () => {
    const one = { milestoneId: "m1", items: [pending("a")], needsYou: 1 };
    expect(applyPatch({ kind: "status-one", world: "", milestoneId: "m1" }, one, { kind: "snoozed", id: "b", until: null })).toBe(one);
  });
});
