/**
 * The time left on a card's deadline, in plain words, updated by the clock (components/deadlineFirst.tsx).
 * "18 h 20 min left", "2 days 4 h left", under 1 hour "35 min left"; past it "Overdue by 3 h" (shown in red, still first).
 */
export interface TimeLeft {
  overdue: boolean;
  /** "18 h 20 min left" or "Overdue by 3 h 5 min". */
  text: string;
  /** under 24 hours to go (or overdue): the line reads stronger. */
  soon: boolean;
}

const span = (ms: number): string => {
  const min = Math.max(1, Math.floor(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d >= 1) return `${d} ${d === 1 ? "day" : "days"}${h ? ` ${h} h` : ""}`;
  if (h >= 1) return `${h} h${m ? ` ${m} min` : ""}`;
  return `${m} min`;
};

export function timeLeft(at: string, now: number = Date.now()): TimeLeft | undefined {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return undefined;
  const ms = t - now;
  if (ms <= 0) return { overdue: true, text: `Overdue by ${span(-ms)}`, soon: true };
  return { overdue: false, text: `${span(ms)} left`, soon: ms < 24 * 3_600_000 };
}

/** "Tue 17 Nov, 01:47 UTC": the deadline itself, beside the time left. */
export function deadlineWhen(at: string): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return at;
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

/** the cards with a deadline, soonest (or most overdue) first. */
export function byDeadline<T extends { face?: { deadline?: { at: string } } | null }>(cards: T[] | undefined): T[] {
  return (cards ?? [])
    .filter((c) => c.face?.deadline?.at && Number.isFinite(Date.parse(c.face.deadline.at)))
    .sort((a, b) => Date.parse(a.face!.deadline!.at) - Date.parse(b.face!.deadline!.at));
}
