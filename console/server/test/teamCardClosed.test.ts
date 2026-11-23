import { describe, expect, it } from "vitest";
import { addCard, closeCard, emptyDoc, isOpen, listCards, type TeamCard } from "../src/inbox/teamCards.js";

// a goal card overtaken by his newer word can be withdrawn by the team; it leaves the inbox
// and no longer blocks a new goal conversation for its objective.
describe("a team card can be withdrawn without his answer", () => {
  const goal = { kind: "goal", by: "Delivery Manager", scorecard: "servers", title: "Set a goal", goal: { unset: "the target", options: [{ goal: "0 red", number: "0" }] } } as Omit<TeamCard, "id" | "at" | "day">;
  it("closed leaves the inbox and frees the one-open-goal limit", () => {
    const a = addCard(emptyDoc(), goal, "2026-11-18T15:00:00Z");
    if ("error" in a) throw new Error(a.error.message);
    expect(listCards(a.doc, { now: "2026-11-23T02:00:00Z" }).counts.goal).toBe(1);
    expect("error" in addCard(a.doc, goal, "2026-11-23T02:00:00Z")).toBe(true);
    const c = closeCard(a.doc, a.card.id, { at: "2026-11-23T02:00:00Z", by: "Delivery Manager", why: "his newer note set the targets" });
    if ("error" in c) throw new Error(c.error.message);
    expect(isOpen(c.card)).toBe(false);
    expect(listCards(c.doc, { now: "2026-11-23T02:00:00Z" }).open).toHaveLength(0);
    expect("error" in addCard(c.doc, goal, "2026-11-23T02:00:00Z")).toBe(false);
  });
  it("refuses a missing card, a closed one and no reason", () => {
    const a = addCard(emptyDoc(), goal, "2026-11-18T15:00:00Z");
    if ("error" in a) throw new Error(a.error.message);
    expect(closeCard(a.doc, "tc_nope", { at: "x", by: "t", why: "y" })).toHaveProperty("error.code", "not_found");
    expect(closeCard(a.doc, a.card.id, { at: "x", by: "t", why: " " })).toHaveProperty("error.code", "bad_why");
    const c = closeCard(a.doc, a.card.id, { at: "x", by: "t", why: "y" });
    if ("error" in c) throw new Error(c.error.message);
    expect(closeCard(c.doc, a.card.id, { at: "x", by: "t", why: "y" })).toHaveProperty("error.code", "not_open");
  });
});
