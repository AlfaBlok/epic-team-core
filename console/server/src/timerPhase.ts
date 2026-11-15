/**
 * the console's periodic jobs each start at their own second, so they no longer fire together.
 *
 * Every job with a 5- or 10-minute clock (usage + credits 5 min, leases 5 min, book refresh, deck notify, review gate,
 * stall watch 10 min) started its setInterval at the console's start, so all of them ran in the same second every 10
 * minutes. The production journal (2026-11-12 22:06Z-01:30Z) showed an event-loop stall of 0.5-1 s at start + 10, 20,
 * 30 … min, with every one of the console speed probe's slow minutes between releases on it (22:26, 22:36, 22:46,
 * 22:56, 23:06Z: Blocked on you 1.2-2.0 s, /api/health as slow, so the whole server, not one read).
 *
 * Each job now starts after its phase (seconds after the console's start), 75 s apart over the 10-minute frame:
 *   0 usage · 75 book refresh · 150 leases · 225 deck notify · 300 usage · 375 review gate · 450 leases · 525 stall watch
 * CONSOLE_TIMER_PHASES=0 starts them all at once again (the old behaviour; tests run with phases off).
 */
export const TIMER_PHASE_S = {
  usage: 0,
  bookRefresh: 75,
  leases: 150,
  deckNotify: 225,
  reviewGate: 375,
  stallWatch: 525,
} as const;

export type TimerJob = keyof typeof TIMER_PHASE_S;

export const timerPhasesOn = (env: Record<string, string | undefined> = process.env): boolean => env.CONSOLE_TIMER_PHASES !== "0";

/** Runs `start` after the job's phase when phases are on, else at once. */
export function phased(on: boolean | undefined, job: TimerJob, start: () => void): void {
  const ms = on ? TIMER_PHASE_S[job] * 1_000 : 0;
  if (ms <= 0) return start();
  const t = setTimeout(start, ms);
  t.unref?.();
}
