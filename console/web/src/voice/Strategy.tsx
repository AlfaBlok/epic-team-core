import { PageHeader } from "@/components/common";
import { useCallDock } from "./CallPanel";

/**
 * The team product's strategy call: one link he opens on his phone. One Call, a senior strategist that knows
 * the launch timeline (what ready waits on, the milestones in order) and sets the launch strategy with him, one question
 * at a time: who buys first, which pitch points lead, a waitlist now or later, what we show, what number means it worked.
 * Each decision he agrees lands on the Team desk (or the social desk) as one request. Same call path as the marketing call.
 */
export const STRATEGY_BASE = "/api/voice/strategy";

const STEPS = [
  { n: "1", t: "The blocker first", d: "A stranger cannot sign up and pay yet. It asks your view." },
  { n: "2", t: "Five questions", d: "Who buys first, the message, the waitlist, what we show, the number." },
  { n: "3", t: "Your decisions land", d: "On the Team desk as one request each." },
];

export function StrategyPage() {
  const call = useCallDock({ base: STRATEGY_BASE, callee: "strategy", where: "Strategy call", hint: "EpicTeam's launch, in English or Spanish. Try “Who should buy first?”" });
  return (
    <div className="mx-auto w-full max-w-2xl" data-testid="strategy-page">
      <PageHeader title="EpicTeam strategy call" description="Set EpicTeam's launch strategy with a senior strategist." actions={call.button} />
      {call.bar}
      {!call.onCall && (
        <ol className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="How a strategy call works" data-testid="strategy-steps">
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
        <ol className="mt-3 grid gap-3" data-testid="strategy-live">
          {call.live}
        </ol>
      )}
      <p className="mt-4 text-xs text-muted-foreground">The whole call lands in your Team desk chat when it ends. It runs on the ElevenLabs grant.</p>
    </div>
  );
}
