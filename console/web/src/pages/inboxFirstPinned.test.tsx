import { describe, expect, it } from "vitest";
import { isPinnedPriority } from "../components/waiting";
import { sampleAsk } from "../components/cardInventory";
import type { WaitingItem } from "../api/inbox-types";

// an item the owner asked by name to be first leads Blocked on you, like a priority ask; plain pressing does not pin.
describe("pressing kind first pins the card", () => {
  it("pins first, not repeated, not snoozed", () => {
    const first = sampleAsk({ ownerPriority: { level: "normal", why: "x", ref: "E900-S1", pressing: { kind: "first", why: "x" } } } as unknown as Partial<WaitingItem>);
    const again = sampleAsk({ ownerPriority: { level: "normal", why: "x", ref: "E900-S1", pressing: { kind: "repeated", why: "x" } } } as unknown as Partial<WaitingItem>);
    expect(isPinnedPriority(first)).toBe(true);
    expect(isPinnedPriority(again)).toBe(false);
    expect(isPinnedPriority({ ...first, snoozedUntil: "2099-01-01T00:00:00Z" })).toBe(false);
  });
});
