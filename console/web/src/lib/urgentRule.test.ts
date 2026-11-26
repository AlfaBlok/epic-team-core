import { describe, expect, it } from "vitest";
import { countsRed, hisIdeaNote, isHisIdeaThatDay, splitDecisions, urgentWhy } from "@/lib/cardKind";
import type { OwnerPriority } from "@/api/inbox-types";

(globalThis as { __IDENTITY__?: { owner?: string } }).__IDENTITY__ = { owner: "Sam" };

// (vn_9ad3d512): review cards on urgent things, on his top objectives, or on an idea he pushed that day sit in Urgent.
const obj = (n: number): OwnerPriority => ({ level: "normal", why: "", ref: "X", objective: { n, id: `o${n}`, name: `Objective ${n + 1}` } });
const card = (o: { n?: number; source?: string; since?: string; pressing?: boolean; decision?: string; options?: string[] }) => ({
  ownerPriority: o.n == null && !o.pressing ? undefined : { ...(o.n != null ? obj(o.n) : { level: "normal" as const, why: "", ref: "X" }), ...(o.pressing ? { pressing: { kind: "repeated" as const, why: "again" } } : {}) },
  face: { source: o.source, decision: o.decision ?? "Is it right?", options: o.options, next: [] },
  inboxSince: o.since ?? "2026-11-25T16:00:00Z",
  createdAt: "2026-11-25",
});

describe("one urgent rule", () => {
  it("urgent or pressed for", () => expect(urgentWhy(card({ n: 8, pressing: true }))).toBe("urgent"));
  it("his first three objectives", () => {
    expect(urgentWhy(card({ n: 0 }))).toBe("top-objective");
    expect(urgentWhy(card({ n: 2 }))).toBe("top-objective");
    expect(urgentWhy(card({ n: 3 }))).toBeUndefined();
  });
  it("his idea that day: his words of the arrival day or the day before", () => {
    expect(isHisIdeaThatDay(card({ n: 8, source: 'Your voice note, 25 Nov: "the total number of active ones"' }))).toBe(true);
    expect(isHisIdeaThatDay(card({ n: 8, source: 'Sam on 25 Nov, "each product should have a vision tab"' }))).toBe(true);
    expect(isHisIdeaThatDay(card({ source: '"was it lost????" Sam, desk chat 24 Nov 17:11Z', since: "2026-11-25T19:14:52Z" }))).toBe(true);
    expect(isHisIdeaThatDay(card({ source: "You chose \"Yes: book both calls\" on the launch timeline, 25 November." }))).toBe(true);
    expect(isHisIdeaThatDay(card({ source: "Your yes on the ElevenLabs card, 25 Nov, started captions" }))).toBe(true);
  });
  it("older words, or not his, stay where they are", () => {
    expect(isHisIdeaThatDay(card({ source: 'Your chat, 22 Nov: "You ignored it, right?"' }))).toBe(false);
    expect(isHisIdeaThatDay(card({ source: "Raised by the desk audit you started on 25 Nov: three notes landed on the wrong card." }))).toBe(false);
    expect(isHisIdeaThatDay(card({ source: "Found by the desk audit you approved on 25 Nov" }))).toBe(false);
    expect(isHisIdeaThatDay(card({ source: undefined }))).toBe(false);
  });
  it("counts: every urgent card counts red once, green is only the rest", () => {
    const cards = [card({ n: 0 }), card({ n: 9, source: 'Your note, 25 Nov: "x"' }), card({ n: 9, source: 'Your note, 20 Nov: "x"' }), card({ n: 9, pressing: true })];
    const { decisions, review } = splitDecisions(cards);
    expect(decisions.length).toBe(3);
    expect(review.length).toBe(1);
    expect(cards.filter(countsRed).length).toBe(3);
  });
  it("the tag says why", () => expect(hisIdeaNote(card({ n: 9, source: 'Your note, 25 Nov: "x"' }))).toBe("Your idea, 25 Nov"));
});
