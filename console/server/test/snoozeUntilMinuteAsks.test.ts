import { describe, expect, it } from "vitest";
import { parseAsks, snoozedNow, snoozeMinute, SNOOZE_ON_LINE } from "../src/inbox/asks.js";
import { applySnooze } from "../src/inbox/spineWrite.js";
import { expireSnoozes, viewWaiting } from "../src/readModel/views.js";
import { pendingItems } from "../src/status/compute.js";
import type { WaitingItem } from "../src/inbox/waiting.js";

/**
 * Snooze gains 3 hours, so a snooze may end at a minute (`2026-11-02T18:30Z`), not only a
 * day; review cards get the same Snooze: a snoozed review leaves the list, /api/counts and the milestone pills until it
 * runs out, and is listed under ?state=snoozed meanwhile.
 */
const ASK = "- [ask T9-A3: decide @Sam since 2026-10-22 row T6] Pick the launch date — context: the shop opens soon — recommend: Monday — unblocks: T6";
const SPINE = `# PLAN-9: Inbox\n\n## Waiting on\n\n${ASK}\n`;
const T = Date.parse("2026-11-02T15:20:10Z");

describe("T48-S21 snooze until a minute (asks)", () => {
  it("snoozeMinute: 3 hours ahead, rounded up to the minute, in the ask-line format", () => {
    expect(snoozeMinute(3, T)).toBe("2026-11-02T18:21Z");
    expect(snoozeMinute(3, Date.parse("2026-11-02T15:20:00Z"))).toBe("2026-11-02T18:20Z");
  });
  it("snoozedNow: a minute hides until that minute; a day keeps its old meaning", () => {
    expect(snoozedNow("2026-11-02T18:20Z", T)).toBe(true);
    expect(snoozedNow("2026-11-02T15:20Z", T)).toBe(false);
    expect(snoozedNow("2026-11-03", T)).toBe(true);
    expect(snoozedNow("2026-11-02", T)).toBe(false);
    expect(snoozedNow("2026-11-04", "2026-11-01")).toBe(true); // the call with a day still works
    expect(snoozedNow(undefined, T)).toBe(false);
  });
  it("the ask line carries the minute: parsed, replaced, removed", () => {
    const t = { id: "x", source: "ask" as const, question: "Pick the launch date", code: "T9-A3", row: "T6" };
    const on = applySnooze(SPINE, t, "2026-11-02T18:20Z") as { text: string };
    expect(on.text).toContain(`${ASK} — snoozed until: 2026-11-02T18:20Z\n`);
    expect(parseAsks(on.text)[0]).toMatchObject({ snoozedUntil: "2026-11-02T18:20Z", unblocks: "T6", recommend: "Monday", state: "open" });
    const day = applySnooze(on.text, t, "2026-11-09") as { text: string };
    expect(day.text).toContain(`${ASK} — snoozed until: 2026-11-09\n`);
    expect(day.text).not.toContain("T18:20Z");
    expect((applySnooze(on.text, t, undefined) as { text: string }).text).toBe(SPINE);
    expect(`T6 — snoozed until: 2026-11-02T18:20Z`.replace(SNOOZE_ON_LINE, "")).toBe("T6");
  });
  it("a stored view shows a run-out snooze as open again at read time; the pending list counts it", () => {
    const item = { id: "wj_1", state: "open", snoozedUntil: "2026-11-02T18:20Z", milestoneId: "ms_x", source: "ask", ask: "decide", title: "t" } as unknown as WaitingItem;
    expect(viewWaiting({ items: [item], defects: [], scopedIds: ["ms_x"] }, {}, T)[0].snoozedUntil).toBe("2026-11-02T18:20Z");
    const later = T + 3 * 3_600_000;
    expect(viewWaiting({ items: [item], defects: [], scopedIds: ["ms_x"] }, {}, later)[0].snoozedUntil).toBeUndefined();
    expect(expireSnoozes([item], T)).toEqual([item]);
    expect(pendingItems([{ ...item, snoozedUntil: "2020-01-01T00:00Z" }]).map((p) => p.id)).toEqual(["wj_1"]);
    expect(pendingItems([{ ...item, snoozedUntil: "2099-01-01T00:00Z" }])).toEqual([]);
  });
});
