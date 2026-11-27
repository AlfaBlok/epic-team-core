import { PageHeader } from "@/components/common";
import { useCallDock } from "./CallPanel";
import { TEAM_DESK_PARTNER } from "./whoAnswers";

/**
 * The objectives coach: one link he opens on his phone while he walks. One Call, a
 * voice that knows his objectives and key results (read only), asks what moved and what blocks, and passes his words
 * to the Team desk or, only his words about the social product, to the social desk. Nothing changes without his yes.
 */
export const COACH_BASE = "/api/voice/coach";

const STEPS = [
  { n: "1", t: "You talk", d: "Pick an objective. Say what moved and what blocks it." },
  { n: "2", t: "The partner asks", d: "Short questions until each key result is clear and measurable." },
  { n: "3", t: "Your words go on", d: "To the Team desk, or the social desk for social only. Nothing changes without your yes." },
];

export function CoachPage() {
  // the coach is the Team desk partner now (one person, one name: whoAnswers.ts), the same call as the Team desk's Partner.
  const call = useCallDock({ base: COACH_BASE, callee: `the ${TEAM_DESK_PARTNER}`, name: TEAM_DESK_PARTNER, where: TEAM_DESK_PARTNER, hint: "All your objectives, in English or Spanish. Try “What is red?”" });
  return (
    <div className="mx-auto w-full max-w-2xl" data-testid="coach-page">
      <PageHeader title={TEAM_DESK_PARTNER} description="Your senior partner over all your objectives. Call it while you walk: it asks about your objectives and passes your words to the right desk." actions={call.button} />
      {call.bar}
      {!call.onCall && (
        <ol className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="How a coach call works" data-testid="coach-steps">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-md border bg-card px-3 py-2.5">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="inline-flex size-5 items-center justify-center rounded-full border text-[11px] tabular-nums text-muted-foreground">{s.n}</span>
                {s.t}
              </p>
              <p className="mt-1 text-xs leading-snug text-muted-foreground">{s.d}</p>
            </li>
          ))}
        </ol>
      )}
      {call.live && (
        <ol className="mt-3 grid gap-3" data-testid="coach-live">
          {call.live}
        </ol>
      )}
      <p className="mt-4 text-xs text-muted-foreground">The whole call lands in your Team desk chat when it ends. It runs on the ElevenLabs grant.</p>
    </div>
  );
}
