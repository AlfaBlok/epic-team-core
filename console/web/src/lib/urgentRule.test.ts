import { describe, expect, it } from "vitest";
import { countsRed, hisIdeaNote, isHisIdeaToday, pickUrgent, splitDecisions, stampUrgent, urgentCap, urgentWhy } from "@/lib/cardKind";
import type { OwnerPriority } from "@/api/inbox-types";

(globalThis as { __IDENTITY__?: { owner?: string } }).__IDENTITY__ = { owner: "Sam" };

// round 2 (his chat 26 Nov: "we cant have 80pct of inbox be urgent"): only what he pushed today or what is truly
// time-bound may be urgent, and Urgent holds at most 5 cards or 15 percent of the inbox, whichever is smaller.
const NOW = Date.parse("2026-11-26T15:00:00Z");
const obj = (n: number): OwnerPriority => ({ level: "normal", why: "", ref: "X", objective: { n, id: `o${n}`, name: `Objective ${n + 1}` } });
let k = 0;
const card = (o: { n?: number; source?: string; since?: string; pressed?: string; title?: string; deadline?: string; urgent?: boolean; decision?: string; options?: string[] }) => ({
  id: `c${k++}`,
  title: o.title ?? "A card",
  ownerPriority: o.n == null && !o.pressed ? undefined : { ...(o.n != null ? obj(o.n) : { level: "normal" as const, why: "", ref: "X" }), ...(o.pressed ? { pressing: { kind: "repeated" as const, why: "again", said: o.pressed } } : {}) },
  face: { source: o.source, decision: o.decision ?? "Is it right?", options: o.options, next: [], deadline: o.deadline ? { at: o.deadline } : undefined, ready: o.urgent ? { why: "urgent" } : undefined },
  inboxSince: o.since ?? "2026-11-26T10:00:00Z",
  createdAt: "2026-11-26",
});

describe("one urgent rule, capped", () => {
  it("a top objective alone is not urgent any more", () => expect(pickUrgent([card({ n: 0 })], NOW).size).toBe(0));
  it("his words dated today are; yesterday's are not", () => {
    expect(isHisIdeaToday(card({ source: 'Your voice note, 26 Nov: "the wheels"' }), NOW)).toBe(true);
    expect(isHisIdeaToday(card({ source: 'Sam, 26 Nov answer: "Yes: build the ledger"' }), NOW)).toBe(true);
    expect(isHisIdeaToday(card({ source: 'Your voice note, 25 Nov: "the total number of active ones"' }), NOW)).toBe(false);
    expect(isHisIdeaToday(card({ source: "Found by the desk audit you approved on 26 Nov" }), NOW)).toBe(false);
  });
  it("a press of today is urgent, an older press is not", () => {
    expect(pickUrgent([card({ pressed: "2026-11-26" })], NOW).size).toBe(1);
    expect(pickUrgent([card({ pressed: "2026-11-22" })], NOW).size).toBe(0);
  });
  it("time-bound: a deadline within two days, an outage, a payment, his urgent label", () => {
    expect([...pickUrgent([card({ deadline: "2026-11-27T12:00:00Z" })], NOW).values()]).toEqual(["urgent"]);
    expect(pickUrgent([card({ deadline: "2026-12-05T12:00:00Z" })], NOW).size).toBe(0);
    expect(pickUrgent([card({ deadline: "2026-11-22T00:00:00Z" })], NOW).size).toBe(0);
    expect(pickUrgent([card({ title: "The site outage is fixed" })], NOW).size).toBe(1);
    expect(pickUrgent([card({ title: "The hosting payment is due tomorrow" })], NOW).size).toBe(1);
    expect(pickUrgent([card({ title: "A price plan was made for paying per search. Nothing charged." })], NOW).size).toBe(0);
    expect(pickUrgent([card({ urgent: true })], NOW).size).toBe(1);
  });
  it("the cap: 5 or 15 percent, whichever is smaller", () => {
    expect([urgentCap(0), urgentCap(3), urgentCap(10), urgentCap(20), urgentCap(59), urgentCap(200)]).toEqual([0, 1, 1, 3, 5, 5]);
  });
  it("of 59 cards with 30 of today's ideas, 5 are urgent, time-bound and presses first", () => {
    const ideas = Array.from({ length: 30 }, (_, n) => card({ n: n % 9, source: `Your note, 26 Nov: "idea ${n}"` }));
    const late = card({ n: 8, deadline: "2026-11-26T20:00:00Z" });
    const pressed = card({ n: 7, pressed: "2026-11-26T09:00:00Z" });
    const rest = Array.from({ length: 27 }, (_, n) => card({ n: n % 9, source: `Your note, 20 Nov: "old ${n}"` }));
    const all = [...ideas, late, ...rest, pressed];
    const stamped = stampUrgent(all, NOW);
    const red = stamped.filter((c) => urgentWhy(c));
    expect(red.length).toBe(5);
    expect(red.map((c) => c.id)).toContain(late.id);
    expect(red.map((c) => c.id)).toContain(pressed.id);
    // the three ideas left are those on his first objectives
    expect(red.filter((c) => c.urgent === "his-idea").every((c) => (c.ownerPriority?.objective?.n ?? 9) === 0)).toBe(true);
    const { decisions, review } = splitDecisions(stamped);
    expect(decisions.length).toBe(5);
    expect(review.length).toBe(54);
    expect(stamped.filter(countsRed).length).toBe(5);
  });
  it("the tag says why", () => {
    const [c] = stampUrgent([card({ n: 9, source: 'Your note, 26 Nov: "x"' })], NOW);
    expect(hisIdeaNote(c)).toBe("Your idea, 26 Nov");
  });
});
