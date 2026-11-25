import { PageHeader } from "@/components/common";
import { useCallDock } from "./CallPanel";

/**
 * The briefing call: one link he opens on his phone. One Call, a voice that knows the desk's news since his last
 * briefing (what shipped, what waits on him), tells it in under a minute, and takes his notes: each note lands on the
 * Team desk as one request, like a chat line of his. It tells, it does not decide. Same call path as the coach.
 */
export const BRIEFING_BASE = "/api/voice/briefing";

const STEPS = [
  { n: "1", t: "It briefs you", d: "What shipped since your last briefing, and what waits on you." },
  { n: "2", t: "You give notes", d: "Say what the team should do, know or answer." },
  { n: "3", t: "Each note lands", d: "On the Team desk as one request, like a chat line." },
];

export function BriefingPage() {
  const call = useCallDock({ base: BRIEFING_BASE, callee: "your briefing", where: "Briefing call", hint: "Your briefing, in English or Spanish. Try “What happened yesterday?”" });
  return (
    <div className="mx-auto w-full max-w-2xl" data-testid="briefing-page">
      <PageHeader title="Briefing call" description="Call it for what happened since your last briefing, then leave your notes for the team." actions={call.button} />
      {call.bar}
      {!call.onCall && (
        <ol className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="How a briefing call works" data-testid="briefing-steps">
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
