import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/common";
import { socialProduct } from "@/lib/identity";
import { useCallDock } from "./CallPanel";

/**
 * The senior marketing call: one link he opens on his phone. One Call, a senior marketing voice that knows the social
 * product's campaigns, their plans and numbers, and talks strategy with him: the number one blocker, who each campaign is
 * for, the message, the channels, the timeline. Each decision he agrees lands on the social desk (or the Team desk) as
 * one request. Same call path as the coach and the briefing call.
 * Named for the social product (the owner, 25 Nov); the social console's menu links it; every console serves it at /marketing; the team product's own strategy call stays at /strategy.
 */
export const MARKETING_BASE = "/api/voice/marketing";

const STEPS = [
  { n: "1", t: "The blocker first", d: "It says what holds the campaigns back, then asks your view." },
  { n: "2", t: "One campaign at a time", d: "Who it is for, the message, the channels, the timeline." },
  { n: "3", t: "Your decisions land", d: "On the social desk as one request each." },
];

/** the briefer's name, as he sees it everywhere ("<product> briefer"). */
export const brieferName = () => `${socialProduct()} briefer`;

/**
 * The owner could not find its button ("I don't see the button ... You keep moving it around"): the briefer
 * is served here on every console, the team console too, so the page opens in the app he is signed in to (the old
 * forward to the social console's own site met a sign-in screen there). Its Call sits at the top, and this place stays.
 */
export function MarketingPage() {
  return <BrieferPage />;
}

function BrieferPage() {
  const name = brieferName();
  // a card's Call opens this page with ?call=1: the call starts at once, then the flag leaves the URL.
  const [params, setParams] = useSearchParams();
  const call = useCallDock({
    base: MARKETING_BASE,
    callee: `the ${name}`,
    label: `Call the ${name}`,
    where: name,
    hint: "Strategy, in English or Spanish. Try “What is the number one blocker?”",
    autoStart: params.get("call") === "1",
    onAutoStart: () =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete("call");
          return next;
        },
        { replace: true },
      ),
  });
  return (
    <div className="mx-auto w-full max-w-2xl" data-testid="marketing-page">
      <PageHeader title={name} description={`Call your ${name}: the numbers, then the campaign strategy.`} actions={call.button} />
      {call.bar}
      {!call.onCall && (
        <ol className="mt-3 grid gap-2 sm:grid-cols-3" aria-label={`How a call with the ${name} works`} data-testid="marketing-steps">
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
      <p className="mt-4 text-xs text-muted-foreground">The whole call lands in your chat when it ends. It runs on the ElevenLabs grant.</p>
    </div>
  );
}
