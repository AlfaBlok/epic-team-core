import { describe, expect, it } from "vitest";
import { formatCadence, formatDateTime, formatMinutes, formatRelative, milestoneName, nextRunAfter } from "./format";

describe("formatCadence", () => {
  it("formats intervals", () => {
    expect(formatCadence({ type: "interval", everyMinutes: 120 })).toBe("every 2 h");
    expect(formatCadence({ type: "interval", everyMinutes: 30 })).toBe("every 30 min");
    expect(formatCadence({ type: "interval", everyMinutes: 90 })).toBe("every 1 h 30 min");
    expect(formatCadence({ type: "interval", everyMinutes: 1440 })).toBe("every 1 day");
  });

  it("formats fixed times with weekday shorthands", () => {
    expect(formatCadence({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] })).toBe("weekdays at 09:00");
    expect(formatCadence({ type: "fixed_time", timeOfDay: "07:30", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("daily at 07:30");
    expect(formatCadence({ type: "fixed_time", timeOfDay: "10:00", weekdays: [6, 0] })).toBe("weekends at 10:00");
    expect(formatCadence({ type: "fixed_time", timeOfDay: "18:30", weekdays: [4, 1] })).toBe("Mon, Thu at 18:30");
  });
});

describe("formatMinutes / formatRelative", () => {
  it("handles edge values", () => {
    expect(formatMinutes(0)).toBe("0 min");
    expect(formatMinutes(1500)).toBe("1 day 1 h");
  });

  it("is relative to now", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    expect(formatRelative("2026-10-14T11:13:00Z", now)).toBe("47 min ago");
    expect(formatRelative("2026-10-14T13:13:00Z", now)).toBe("in 1 h");
    expect(formatRelative("2026-10-14T12:00:20Z", now)).toBe("just now");
    expect(formatRelative(undefined, now)).toBe("—");
  });

  it("T13-S9: one number + one unit, never compound; singular at 1", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    const ago = (min: number) => formatRelative(new Date(now.getTime() - min * 60_000).toISOString(), now);
    const ahead = (min: number) => formatRelative(new Date(now.getTime() + min * 60_000).toISOString(), now);
    expect(ago(0.5)).toBe("just now");
    expect(ago(1)).toBe("1 min ago");
    expect(ago(3)).toBe("3 min ago");
    expect(ago(59)).toBe("59 min ago");
    expect(ago(60)).toBe("1 h ago");
    expect(ago(80)).toBe("1 h ago");
    expect(ago(150)).toBe("2 h ago");
    expect(ago(1440)).toBe("1 day ago");
    expect(ago(3 * 1440 + 300)).toBe("3 days ago");
    expect(ago(7 * 1440)).toBe("1 week ago");
    expect(ago(15 * 1440)).toBe("2 weeks ago");
    expect(ago(45 * 1440)).toBe("1 month ago");
    expect(ago(130 * 1440)).toBe("4 months ago");
    expect(ago(364 * 1440)).toBe("11 months ago");
    expect(ago(400 * 1440)).toBe("1 year ago");
    expect(ago(800 * 1440)).toBe("2 years ago");
    expect(ahead(5)).toBe("in 5 min");
    expect(ahead(125)).toBe("in 2 h");
    expect(ahead(3 * 1440)).toBe("in 3 days");
    for (const m of [1, 61, 1500, 20000, 100000, 600000]) expect(ago(m)).toMatch(/^\d+ \S+ ago$/);
  });

  it("T13-S9: date-only values count calendar days; bad input passes through", () => {
    const now = new Date(2026, 9, 24, 15, 0);
    expect(formatRelative("2026-10-24", now)).toBe("today");
    expect(formatRelative("2026-10-23", now)).toBe("1 day ago");
    expect(formatRelative("2026-10-10", now)).toBe("2 weeks ago");
    expect(formatRelative("2026-10-27", now)).toBe("in 3 days");
    expect(formatRelative("not a date", now)).toBe("not a date");
    expect(formatRelative(null, now)).toBe("—");
  });

  it("T13-S9: formatDateTime is the exact hover stamp, with year and zone", () => {
    expect(formatDateTime("2026-10-24T15:23:00Z", "UTC")).toBe("Oct 24, 2026, 15:23 UTC");
    expect(formatDateTime("2026-10-24")).toBe("2026-10-24");
    expect(formatDateTime(undefined)).toBe("—");
  });
});

describe("nextRunAfter", () => {
  it("steps intervals from the last run, skipping missed slots", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    expect(nextRunAfter({ type: "interval", everyMinutes: 120 }, now, new Date("2026-10-14T11:13:00Z")).toISOString()).toBe(
      "2026-10-14T13:13:00.000Z",
    );
    expect(nextRunAfter({ type: "interval", everyMinutes: 60 }, now, new Date("2026-10-14T08:30:00Z")).toISOString()).toBe(
      "2026-10-14T12:30:00.000Z",
    );
  });

  it("finds the next matching weekday for fixed times (local clock)", () => {
    const fri = new Date(2026, 9, 16, 10, 0); // Fri 16 Oct 2026 10:00 local
    const next = nextRunAfter({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }, fri);
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(19);
    expect(next.getHours()).toBe(9);
  });
});

describe("milestoneName (T6-S26)", () => {
  it("explicit Settings title wins, else the spine's title, else the stored one", () => {
    expect(milestoneName({ title: "Memo", docTitle: "EPIC 0", titleOverride: true })).toBe("Memo");
    expect(milestoneName({ title: "Memo", docTitle: "EPIC 0" })).toBe("EPIC 0");
    expect(milestoneName({ title: "Memo" })).toBe("Memo");
  });
});

describe("formatRelative, card ages (T48-S11)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  it("reads minutes, hours, days and years", () => {
    expect(formatRelative("2026-11-01T11:55:00Z", now)).toBe("5 min ago");
    expect(formatRelative("2026-11-01T09:00:00Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-10-29T12:00:00Z", now)).toBe("3 days ago");
    expect(formatRelative("2025-10-30T12:00:00Z", now)).toBe("1 year ago");
    expect(formatRelative("2023-10-30T12:00:00Z", now)).toBe("3 years ago");
  });
  it("a date-only value reads in days and years", () => {
    expect(formatRelative("2026-10-29", now)).toBe("3 days ago");
    expect(formatRelative("2025-10-01", now)).toBe("1 year ago");
  });
});
