import { PageHeader } from "@/components/common";
import { useCallDock } from "./CallPanel";

/**
 * The senior marketing call: one link he opens on his phone. One Call, a senior marketing voice that knows the social
 * product's campaigns, their plans and numbers, and talks strategy with him: the number one blocker, who each campaign is
 * for, the message, the channels, the timeline. Each decision he agrees lands on the social desk (or the Team desk) as
 * one request. Same call path as the coach and the briefing call.
 */
export const MARKETING_BASE = "/api/voice/marketing";

const STEPS = [
  { n: "1", t: "The blocker first", d: "It says what holds the campaigns back, then asks your view." },
  { n: "2", t: "One campaign at a time", d: "Who it is for, the message, the channels, the timeline." },
  { n: "3", t: "Your decisions land", d: "On the social desk as one request each." },
];

export function MarketingPage() {
  const call = useCallDock({ base: MARKETING_BASE, callee: "marketing", where: "Marketing call", hint: "Strategy, in English or Spanish. Try “What is the number one blocker?”" });
  return (
    <div className="mx-auto w-full max-w-2xl" data-testid="marketing-page">
      <PageHeader title="Marketing call" description="Call your senior marketing person to set the campaign strategy." actions={call.button} />
      {call.bar}
      {!call.onCall && (
        <ol className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="How a marketing call works" data-testid="marketing-steps">
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
        <ol className="mt-3 grid gap-3" data-testid="marketing-live">
          {call.live}
        </ol>
      )}
      <p className="mt-4 text-xs text-muted-foreground">The whole call lands in your Team desk chat when it ends. It runs on the ElevenLabs grant.</p>
    </div>
  );
}
