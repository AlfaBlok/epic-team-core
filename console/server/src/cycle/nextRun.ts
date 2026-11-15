import type { Cadence } from "../schemas.js";

/** Next fire time strictly after `from` (fixed_time in the server's local time, like T3's scheduler). */
export function nextRunAfter(c: Cadence, from: Date): Date {
  if (c.type === "interval") return quietEnd(new Date(from.getTime() + c.everyMinutes * 60_000), c.quiet);
  const [h, m] = c.timeOfDay.split(":").map(Number);
  for (let d = 0; d <= 7; d++) {
    const t = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, h, m, 0, 0);
    if (t.getTime() > from.getTime() && c.weekdays.includes(t.getDay())) return t;
  }
  return new Date(from.getTime() + 7 * 86_400_000);
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes past midnight of `t` on the wall clock of `timeZone`. */
export function wallMinutes(t: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t);
  const n = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
  return n("hour") * 60 + n("minute");
}

/** Inside the quiet window (from inclusive, to exclusive; a window like 22:00-08:00 crosses midnight). */
export function inQuiet(t: Date, q: { from: string; to: string; timeZone: string }): boolean {
  const m = wallMinutes(t, q.timeZone);
  const a = mins(q.from);
  const b = mins(q.to);
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
}

/** `t`, or the first minute after the quiet window when `t` falls inside it. */
export function quietEnd(t: Date, q?: { from: string; to: string; timeZone: string }): Date {
  if (!q || !inQuiet(t, q)) return t;
  let x = new Date(Math.ceil(t.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 24 * 60 && inQuiet(x, q); i++) x = new Date(x.getTime() + 60_000);
  return x;
}
