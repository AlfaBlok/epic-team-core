import { useState } from "react";
import { api } from "@/api";
import { ObjectiveName } from "@/components/objectiveName";
import { usePursuits } from "@/components/pursuits";
import { mutate } from "@/lib/data";

/**
 * The owner, on a live call: "I don't want to do anything hacky. We need this to be a standard
 * feature that an objective can be switched off." His On/Off switch on an objective. Off keeps it in docs/pursuits.json
 * (`"active": false` and the day, one commit) and takes it out of Goals to set, the sidebar count, the inbox and every
 * wake; it shows greyed under Inactive, where Switch on brings it back.
 */

const btn = "h-9 rounded-md border bg-background px-2.5 text-xs text-foreground disabled:opacity-30 md:h-8";

function useSwitch() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (id: string, active: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await mutate(() => api.setPursuitActive(id, active), "inbox");
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, run };
}

/** "Switch off" on an objective's own page (his objectives only: an id the objectives file holds). */
export function ObjectiveOffButton({ id }: { id: string }) {
  const { data } = usePursuits();
  const s = useSwitch();
  if (!data?.pursuits.some((p) => p.id === id)) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={btn} disabled={s.saving} onClick={() => void s.run(id, false)} title="Kept, out of Goals to set, the counts, the inbox and every wake" data-testid="objective-switch-off">
        {s.saving ? "Switching off…" : "Switch off"}
      </button>
      {s.error && (
        <span className="text-xs text-destructive" role="alert">
          {s.error}
        </span>
      )}
    </span>
  );
}

/** The Inactive fold: each objective he switched off, greyed, with the day and Switch on. Nothing when none. */
export function InactiveObjectives() {
  const { data } = usePursuits();
  const s = useSwitch();
  const off = data?.inactive ?? [];
  if (!off.length) return null;
  return (
    <details className="min-w-0 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-muted-foreground" data-testid="objectives-inactive">
      <summary className="cursor-pointer text-sm">Inactive ({off.length})</summary>
      <p className="mt-1 text-xs">Kept, out of Goals to set, the counts, the inbox and every wake.</p>
      {s.error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {s.error}
        </p>
      )}
      <ul className="mt-2 grid min-w-0 gap-1.5">
        {off.map((p) => (
          <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-testid="objective-inactive-row" data-objective={p.id}>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <ObjectiveName name={p.name} />
            </span>
            {p.since && <span className="text-xs">off since {p.since}</span>}
            <button type="button" className={btn} disabled={s.saving} onClick={() => void s.run(p.id, true)} data-testid="objective-switch-on">
              Switch on
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
