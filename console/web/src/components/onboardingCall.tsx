import { useEffect, useState } from "react";
import { useCallDock } from "@/voice/CallPanel";
import { setOnboardingLeads } from "@/lib/onboardingLeads";

export { useOnboardingLeads } from "@/lib/onboardingLeads";

/**
 * (his strategy call, call_910685a3, 27 Nov: "we should kind of guide the user towards a button at the beginning";
 * "Hey, I'm here to assist you on your onboarding ... if you have, like, 10 minutes or so"): a new EpicTeam workspace's Home
 * opens on one Call button, the onboarding helper. It asks for their one objective and writes it here with its first key
 * result; it shows until the workspace has an objective of its own (`due` on the state read), or while its call is on.
 */
export const onboardingBase = (world: string) => `/api/tenants/${encodeURIComponent(world)}/onboarding/voice`;

export function OnboardingCall({ world, onWritten }: { world: string; onWritten?: () => void }) {
  const base = onboardingBase(world);
  const [due, setDue] = useState<boolean | undefined>();
  const call = useCallDock({
    base,
    callee: "your onboarding helper",
    label: "Call",
    where: "Onboarding call",
    wide: true,
    hideUnavailable: true,
    state: async () => {
      try {
        const r = await fetch(`${base}/state`);
        if (!r.ok) return setDue(false), undefined;
        const s = await r.json();
        setDue(!!s.due);
        return s;
      } catch {
        setDue(false);
        return undefined;
      }
    },
    onEnded: onWritten,
  });
  const shown = call.onCall || (!!due && !!call.button);
  useEffect(() => {
    setOnboardingLeads(shown);
    return () => setOnboardingLeads(false);
  }, [shown]);
  if (!shown) return null;
  return (
    <section className="grid min-w-0 gap-3 rounded-md border px-4 py-4 sm:px-5" data-testid="onboarding-call" aria-label="Start with a call">
      <div className="grid min-w-0 gap-1">
        <h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl">Start with a call</h1>
        <p className="text-sm text-muted-foreground" data-testid="onboarding-call-answer">
          Your onboarding helper asks for your one objective and writes it here with its first key result. Ten minutes, or as long as you like.
        </p>
      </div>
      {!call.onCall && <div data-testid="onboarding-call-button">{call.button}</div>}
      {call.onCall && call.bar}
      {call.onCall && call.live && <ol className="grid gap-2">{call.live}</ol>}
    </section>
  );
}
