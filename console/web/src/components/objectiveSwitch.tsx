import { useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "@/api";
import { OBJECTIVE_GROUPS, type ObjectiveGroup } from "@/api/pursuit-types";
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

/** one write at a time: Switch off/on (`active`) or Mark done/undo (`done`); both refresh the inbox and objectives. */
function useSwitch() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (id: string, active: boolean) => go(() => api.setPursuitActive(id, active));
  const done = async (id: string, isDone: boolean) => go(() => api.setPursuitDone(id, isDone));
  const go = async (call: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await mutate(call, "inbox");
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, run, done };
}

/**
 * "Switch off" and "Mark done" on an objective's own page (his objectives only: an id the objectives file holds).
 * Done (the owner on the same call: "this one we can mark as complete") keeps it in the file like an inactive one,
 * out of every list, and lists it under Done with an undo.
 */
export function ObjectiveOffButton({ id, openBoxes = 0 }: { id: string; openBoxes?: number }) {
  const { data } = usePursuits();
  const s = useSwitch();
  if (!data?.pursuits.some((p) => p.id === id)) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {/* Mark done only once every Done-means box of its epics is ticked: green key results alone are not done. */}
      {openBoxes === 0 && <button type="button" className={btn} disabled={s.saving} onClick={() => void s.done(id, true)} title="Reached: kept under Done, out of Goals to set, the counts, the inbox and every wake" data-testid="objective-mark-done">
        Mark done
      </button>}
      <button type="button" className={btn} disabled={s.saving} onClick={() => void s.run(id, false)} title="Kept, out of Goals to set, the counts, the inbox and every wake" data-testid="objective-switch-off">
        {s.saving ? "Saving…" : "Switch off"}
      </button>
      {s.error && (
        <span className="text-xs text-destructive" role="alert">
          {s.error}
        </span>
      )}
    </span>
  );
}

/**
 * His Daily briefing switch (the owner, 22 Nov), on every objective page: on, this objective's key results
 * (and its tester table, testers by email) go into his 06:00 and 18:00 WhatsApp briefings. Saved with the objective in
 * docs/pursuits.json (`"briefing": true`, one commit), never only in the database.
 */
export function DailyBriefingSwitch({ id }: { id: string }) {
  const { data } = usePursuits();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = data?.pursuits.find((x) => x.id === id);
  if (!p) return null;
  const on = !!p.briefing;
  const flip = async () => {
    setSaving(true);
    setError(null);
    try {
      await mutate(() => api.setPursuitBriefing(id, !on), "inbox");
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="objective-briefing">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={saving}
        onClick={() => void flip()}
        title={on ? "In your 06:00 and 18:00 briefings: its key results and tester table" : "Not in your briefings: switch on to get its key results at 06:00 and 18:00"}
        className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-2.5 text-xs text-foreground disabled:opacity-30 md:h-8"
        data-testid="objective-briefing-switch"
      >
        <span aria-hidden className={`relative inline-block h-4 w-7 rounded-full transition-colors ${on ? "bg-emerald-600" : "bg-muted-foreground/30"}`}>
          <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-background transition-all ${on ? "left-3.5" : "left-0.5"}`} />
        </span>
        Daily briefing {saving ? "…" : on ? "on" : "off"}
      </button>
      {error && (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * His group pick on every objective page (his voice note 25 Nov 14:34Z: "make groups of objectives ... personal,
 * business ... background ... central"): Central, Business, Personal or Background. Saved with the objective in
 * docs/pursuits.json (`"group"`, one commit), never only in the database; the sidebar folds his objectives by it.
 */
export function ObjectiveGroupPick({ id }: { id: string }) {
  const { data } = usePursuits();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = data?.pursuits.find((x) => x.id === id);
  if (!p) return null;
  const move = async (group: ObjectiveGroup) => {
    setSaving(true);
    setError(null);
    try {
      await mutate(() => api.setPursuitGroup(id, group), "inbox");
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <label className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-2.5 text-xs text-foreground md:h-8" data-testid="objective-group">
      <span className="text-muted-foreground">Group</span>
      <select
        className="h-full min-w-0 bg-transparent text-xs text-foreground outline-none disabled:opacity-30"
        value={p.group ?? ""}
        disabled={saving}
        onChange={(e) => void move(e.target.value as ObjectiveGroup)}
        data-testid="objective-group-pick"
      >
        {!p.group && <option value="">None yet</option>}
        {OBJECTIVE_GROUPS.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      {saving && <span>…</span>}
      {error && (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

/** one fold of objectives kept out of every list: Done (with Undo) or Inactive (with Switch on). Nothing when none. */
function KeptFold({ kind, items }: { kind: "done" | "inactive"; items: { id: string; name: string; since?: string }[] }) {
  const s = useSwitch();
  const { hash } = useLocation();
  if (!items.length) return null;
  const isDone = kind === "done";
  // a link to /pursuits#done (or #inactive) opens its fold, so a review card can point straight at it
  return (
    <details id={kind} open={hash === `#${kind}` || undefined} className="min-w-0 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-muted-foreground" data-testid={`objectives-${kind}`}>
      <summary className="cursor-pointer text-sm">
        {isDone ? "Done" : "Inactive"} ({items.length})
      </summary>
      <p className="mt-1 text-xs">{isDone ? "Reached and kept, out of Goals to set, the counts, the inbox and every wake." : "Kept, out of Goals to set, the counts, the inbox and every wake."}</p>
      {s.error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {s.error}
        </p>
      )}
      <ul className="mt-2 grid min-w-0 gap-1.5">
        {items.map((p) => (
          <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-testid={`objective-${kind}-row`} data-objective={p.id}>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <ObjectiveName name={p.name} />
            </span>
            {p.since && <span className="text-xs">{isDone ? `done ${p.since}` : `off since ${p.since}`}</span>}
            {isDone ? (
              <button type="button" className={btn} disabled={s.saving} onClick={() => void s.done(p.id, false)} title="Not done after all: live again" data-testid="objective-undo-done">
                Undo
              </button>
            ) : (
              <button type="button" className={btn} disabled={s.saving} onClick={() => void s.run(p.id, true)} data-testid="objective-switch-on">
                Switch on
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The Done and Inactive folds under his objectives: each one he marked done or switched off, greyed, with its day. */
export function InactiveObjectives() {
  const { data } = usePursuits();
  return (
    <>
      <KeptFold kind="done" items={data?.done ?? []} />
      <KeptFold kind="inactive" items={data?.inactive ?? []} />
    </>
  );
}
