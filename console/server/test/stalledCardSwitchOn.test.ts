import { describe, expect, it } from "vitest";
import { stalledItem } from "../src/status/compute.js";
import type { Assignment } from "../src/store.js";

// E948-S204 (the owner, closing E948-S200 24 Nov: "a stalled-team card asks Should a team member work on it? and offers
// Switch on, not Yes and No"): the stalled item carries the goal's name and one plain line of what waits and who is off.

const a = (over: Partial<Assignment> = {}): Assignment => ({
  id: "a1", milestoneId: "m1", personaId: "p1", cadence: { type: "interval", everyMinutes: 180 }, enabled: false, writeEnabled: false, writeScope: "", createdAt: "2026-11-24T00:00:00Z", ...over,
});

describe("the stalled card names its goal and who is off (E948-S204)", () => {
  it("a switched-off persona: the goal, the ready steps and the persona's name", () => {
    const i = stalledItem("m1", "3 steps ready", [a()], () => "Delivery Manager", "Get 5 testers");
    expect(i).toMatchObject({ kind: "stalled", goal: "Get 5 testers", detail: "3 steps ready on Get 5 testers. Delivery Manager is switched off, so nobody wakes on it." });
    expect(i.switchOn).toEqual([{ assignmentId: "a1", persona: "Delivery Manager" }]);
  });

  it("nobody assigned: says so, and offers no persona to switch on", () => {
    const i = stalledItem("m1", "2 steps ready", [], undefined, "Get 5 testers");
    expect(i.detail).toBe("2 steps ready on Get 5 testers. No team member is on it yet.");
    expect(i.switchOn).toBeUndefined();
  });
});
