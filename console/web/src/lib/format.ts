import type { Cadence, Dod, Milestone } from "@/api/types";

/** the milestone's shown name: an explicit Settings title wins, else the spine's own title, else the stored one. */
export function milestoneName(m: Pick<Milestone, "title" | "docTitle" | "titleOverride">): string {
  return m.titleOverride ? m.title : (m.docTitle ?? m.title);
}

/** Weekday numbering: 0 = Sunday … 6 = Saturday (JS Date#getDay). */
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function plural(n: number, unit: string) {
  return `${n} ${unit}`;
}

/** Human duration for an interval in minutes: 90 → "1 h 30 min", 120 → "2 h", 1440 → "1 day". */
export function formatMinutes(total: number): string {
  if (total <= 0) return "0 min";
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  const parts: string[] = [];
  if (days) parts.push(plural(days, days === 1 ? "day" : "days"));
  if (hours) parts.push(plural(hours, "h"));
  if (mins) parts.push(plural(mins, "min"));
  return parts.join(" ");
}

function formatWeekdays(days: number[]): string {
  const set = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  const key = set.join(",");
  if (set.length === 0 || set.length === 7) return "daily";
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,6") return "weekends";
  return set.map((d) => WEEKDAY_SHORT[d]).join(", ");
}

/** Cadence → short text: "every 2 h", "weekdays at 09:00", "Mon, Thu at 18:30". */
export function formatCadence(c: Cadence): string {
  if (c.type === "interval") return `every ${formatMinutes(c.everyMinutes)}`;
  return `${formatWeekdays(c.weekdays)} at ${c.timeOfDay}`;
}

/** an assignment's schedule as shown: its cadence while on, "off" while off (never the cadence it would have). */
export function scheduleLabel(a: { enabled: boolean; cadence: Cadence }): string {
  return a.enabled ? formatCadence(a.cadence) : "off";
}

/** Next wake strictly after `from`. Interval: from last run (or `from`); fixed_time: local clock. */
export function nextRunAfter(c: Cadence, from: Date, lastRunAt?: Date): Date {
  if (c.type === "interval") {
    const step = Math.max(1, c.everyMinutes) * 60_000;
    let t = (lastRunAt ?? from).getTime() + step;
    if (t <= from.getTime()) t += Math.ceil((from.getTime() - t + 1) / step) * step;
    return new Date(t);
  }
  const [hh, mm] = c.timeOfDay.split(":").map(Number);
  const days = c.weekdays.length ? c.weekdays : [0, 1, 2, 3, 4, 5, 6];
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(hh || 0, mm || 0, 0, 0);
    if (d > from && days.includes(d.getDay())) return d;
  }
  return new Date(from.getTime() + 7 * 86_400_000);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** One magnitude, never compound: 45 → "45 min", 130 → "2 h", 3 days → "3 days", 15 days → "2 weeks". */
function magnitude(absMin: number): string {
  const unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (absMin < 60) return unit(absMin, "min", "min");
  if (absMin < 1440) return unit(Math.floor(absMin / 60), "h", "h");
  const days = Math.floor(absMin / 1440);
  if (days < 7) return unit(days, "day", "days");
  if (days < 30) return unit(Math.floor(days / 7), "week", "weeks");
  if (days < 365) return unit(Math.min(11, Math.floor(days / 30)), "month", "months");
  return unit(Math.floor(days / 365), "year", "years");
}

/**
 * relative time, one number + one unit: "just now", "3 min ago", "2 h ago", "1 day ago", "in 5 min".
 * A date-only value ("2026-10-24") counts calendar days: "today", "3 days ago", "in 2 weeks".
 */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  if (DATE_ONLY.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
    if (days === 0) return "today";
    const span = magnitude(Math.abs(days) * 1440);
    return days > 0 ? `in ${span}` : `${span} ago`;
  }
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffMin = (t - now.getTime()) / 60_000;
  const abs = Math.floor(Math.abs(diffMin));
  if (abs < 1) return "just now";
  return diffMin > 0 ? `in ${magnitude(abs)}` : `${magnitude(abs)} ago`;
}

/** The exact timestamp, for a relative label's hover title: "Oct 24, 2026, 15:23 CST". Date-only values stay as is. */
export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  if (DATE_ONLY.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** DoD progress label: "3/7", or "5 criteria" when the items are untracked (plain list, no checkboxes). */
export function dodCount(dod?: Dod): string {
  if (dod?.tracked === false) return `${dod.items.length} ${dod.items.length === 1 ? "criterion" : "criteria"}`;
  return `${dod?.done ?? 0}/${dod?.total ?? 0}`;
}
