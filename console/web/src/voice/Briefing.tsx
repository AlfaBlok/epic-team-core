import { PageHeader } from "@/components/common";
import { useCallDock } from "./CallPanel";

/**
 * The briefing call, now his objectives review (his note: "I'm just a manager reviewing a team trying
 * to make their goals"): one link he opens on his phone, and the daily briefing invite on WhatsApp links here. One Call
 * walks his objectives in his order, those that moved or turned red since the last briefing first: each one's red key
 * results with today's numbers, what moved, what waits on him. His decisions are filed on that objective; what he wants
 * done lands on the Team desk as one request. Same call path as the coach.
 */
export const BRIEFING_BASE = "/api/voice/briefing";

const STEPS = [
  { n: "1", t: "Objective by objective", d: "In your order. What moved since your last briefing comes first." },
  { n: "2", t: "Red and exact", d: "Each red key result with its number, and what waits on you." },
  { n: "3", t: "Your decisions land", d: "Filed on that objective. To-dos go to the Team desk." },
];

export function BriefingPage() {
  const call = useCallDock({ base: BRIEFING_BASE, callee: "your Team desk manager", where: "Objectives review", hint: "Your objectives, one by one, in English or Spanish. Say “Ready” to start." });
  return (
    <div className="mx-auto w-full max-w-2xl" data-testid="briefing-page">
      <PageHeader title="Objectives review" description="Review your team objective by objective, then give your decisions." actions={call.button} />
      {call.bar}
      {!call.onCall && (
        <ol className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="How the objectives review works" data-testid="briefing-steps">
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
        <ol className="mt-3 grid gap-3" data-testid="briefing-live">
          {call.live}
        </ol>
      )}
      <p className="mt-4 text-xs text-muted-foreground">The whole call lands in your Team desk chat when it ends. It runs on the ElevenLabs grant.</p>
    </div>
  );
}
