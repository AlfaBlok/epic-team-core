import { api } from "@/api";
import type { PersonaStep, StepLabel } from "@/api/totem-types";
import { ErrorBox, Loading } from "@/components/common";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";

/**
 * A wheel's Log tab. The owner, 24 Nov 05:11Z (Log/2026-11-24.md#^e-0a42dd): "I want to see a list of all
 * the things that happened that I didn't necessarily articulate, but that ... this persona, decided to carry, which
 * ultimately ... was a step in the direction of accomplishing the goal" and "we should be able to label, was this ... a
 * correct one or an incorrect one?". Answer first (the count of correct steps nobody asked for), then the steps the team
 * chose, each with one tap: Correct or Not correct. Every step of the wheel is one switch away.
 */
const PAGE = 40;
const when = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
};

export function PersonaLogTab({ wheel }: { wheel: string }) {
  const { data, error, loading } = useQuery(() => api.getPersonaLog(wheel), [wheel]);
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [mine, setMine] = useState<Record<string, StepLabel | "clear">>({});
  const [failed, setFailed] = useState<string | undefined>();
  const steps = useMemo(() => (data?.steps ?? []).map((s) => (mine[s.id] ? { ...s, label: mine[s.id] === "clear" ? undefined : (mine[s.id] as StepLabel) } : s)), [data, mine]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  const chose = steps.filter((s) => !s.asked);
  const correct = chose.filter((s) => s.label === "correct").length;
  const wrong = chose.filter((s) => s.label === "incorrect").length;
  const list = (all ? steps : chose).slice(0, shown);
  const tap = async (s: PersonaStep, label: StepLabel) => {
    const next = s.label === label ? "clear" : label;
    setMine((m) => ({ ...m, [s.id]: next }));
    setFailed(undefined);
    try {
      await api.labelStep(s.id, next);
    } catch (e) {
      setMine((m) => ({ ...m, [s.id]: s.label ?? "clear" }));
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="grid min-w-0 gap-4" data-testid="persona-log-tab" data-wheel={wheel} data-steps={steps.length}>
      <div className="grid gap-1 rounded-xl border bg-card p-4" data-testid="persona-log-answer">
        <p className="text-2xl font-semibold tabular-nums">
          {correct} correct step{correct === 1 ? "" : "s"} nobody asked for
        </p>
        <p className="text-sm text-muted-foreground">
          Last {data.days} days: {steps.length} steps on this wheel, {steps.length - chose.length} on your asks, {chose.length} the team chose. You labelled {correct} correct, {wrong} not correct,{" "}
          {chose.length - correct - wrong} wait for your tap.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm" role="tablist">
        <button type="button" role="tab" aria-selected={!all} className={cn("min-h-11 rounded-full border px-4", !all && "bg-foreground text-background")} onClick={() => (setAll(false), setShown(PAGE))}>
          The team chose ({chose.length})
        </button>
        <button type="button" role="tab" aria-selected={all} className={cn("min-h-11 rounded-full border px-4", all && "bg-foreground text-background")} onClick={() => (setAll(true), setShown(PAGE))}>
          Every step ({steps.length})
        </button>
      </div>
      {failed && <p className="text-sm text-destructive" data-testid="persona-log-failed">Not saved: {failed}</p>}
      {list.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No step logged on this wheel in the last {data.days} days.</p>
      ) : (
        <ol className="grid gap-2" data-testid="persona-log-steps">
          {list.map((s) => (
            <li key={s.id} id={s.id} className="grid min-w-0 gap-1 rounded-lg border p-3" data-testid="persona-step" data-asked={s.asked} data-label={s.label ?? ""}>
              <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                <span>{when(s.at)}</span>
                <span className="font-medium text-foreground">{s.persona}</span>
                {s.row && <span>{s.row}</span>}
                <span>{s.asked ? "on your ask" : "the team chose"}</span>
              </p>
              <p className="min-w-0 break-words text-sm">{s.did}</p>
              {(s.from || s.kr) && (
                <p className="min-w-0 break-words text-xs text-muted-foreground">
                  {s.from && <>From: {s.from}</>}
                  {s.from && s.kr && " · "}
                  {s.kr && <>Toward: {s.kr}</>}
                </p>
              )}
              {!s.asked && (
                <div className="mt-1 flex gap-2">
                  {(["correct", "incorrect"] as const).map((l) => (
                    <button
                      key={l}
                      type="button"
                      aria-pressed={s.label === l}
                      data-testid={`label-${l}`}
                      className={cn("min-h-11 rounded-md border px-4 text-sm", s.label === l && (l === "correct" ? "border-emerald-700 bg-emerald-700 text-white" : "border-foreground bg-foreground text-background"))}
                      onClick={() => void tap(s, l)}
                    >
                      {l === "correct" ? "Correct" : "Not correct"}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {(all ? steps : chose).length > shown && (
        <button type="button" className="min-h-11 rounded-md border px-4 text-sm" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, (all ? steps : chose).length - shown)} more
        </button>
      )}
    </section>
  );
}
