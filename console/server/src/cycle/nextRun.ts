import type { Cadence } from "../schemas.js";

/** Next fire time strictly after `from` (fixed_time in the server's local time, like T3's scheduler). */
export function nextRunAfter(c: Cadence, from: Date): Date {
  if (c.type === "interval") return new Date(from.getTime() + c.everyMinutes * 60_000);
  const [h, m] = c.timeOfDay.split(":").map(Number);
  for (let d = 0; d <= 7; d++) {
    const t = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, h, m, 0, 0);
    if (t.getTime() > from.getTime() && c.weekdays.includes(t.getDay())) return t;
  }
  return new Date(from.getTime() + 7 * 86_400_000);
}
