import { describe, expect, it } from "vitest";
import { byDeadline, deadlineWhen, timeLeft } from "@/lib/deadline";
import { hasDeadline } from "@/lib/cardKind";

/** (vn_c95c40ad): the time left on a card's deadline, counting down; past it, overdue. */
const NOW = Date.parse("2026-11-16T07:27:00Z");

describe("time left", () => {
  it("counts down in plain words", () => {
    expect(timeLeft("2026-11-17T01:47:00Z", NOW)).toEqual({ overdue: false, text: "18 h 20 min left", soon: true });
    expect(timeLeft("2026-11-18T09:27:00Z", NOW)).toEqual({ overdue: false, text: "2 days 2 h left", soon: false });
    expect(timeLeft("2026-11-16T08:02:00Z", NOW)!.text).toBe("35 min left");
    expect(timeLeft("2026-11-16T08:27:00Z", NOW)!.text).toBe("1 h left");
  });
  it("says overdue past it", () => {
    expect(timeLeft("2026-11-16T04:22:00Z", NOW)).toEqual({ overdue: true, text: "Overdue by 3 h 5 min", soon: true });
    expect(timeLeft("not a time", NOW)).toBeUndefined();
  });
  it("names the deadline in UTC", () => {
    expect(deadlineWhen("2026-11-17T01:47:00Z")).toBe("Tue 17 Nov, 01:47 UTC");
  });
  it("orders cards soonest first, overdue before all, and skips cards with none", () => {
    const c = (id: string, at?: string) => ({ id, face: at ? { deadline: { at } } : {} });
    const list = [c("later", "2026-11-20T00:00Z"), c("none"), c("overdue", "2026-11-15T00:00Z"), c("soon", "2026-11-17T01:47Z")];
    expect(byDeadline(list).map((x) => x.id)).toEqual(["overdue", "soon", "later"]);
    expect(hasDeadline({ deadline: { at: "2026-11-17T01:47:00.000Z" } })).toBe(true);
    expect(hasDeadline({})).toBe(false);
  });
});
